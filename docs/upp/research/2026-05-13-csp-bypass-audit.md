# v0.1.34 CSP Bypass — Codebase Audit

*Written 2026-05-13. Input to the v0.1.34 plan tasks 4-15.*

## Method

`grep -rn "executeJsInTab\b" src/tools/` produced 89 matches across 17 files at HEAD `d13959d` (matches the count quoted in TRACES iter 80). Each match was read with ≥10 lines of surrounding context and classified along three axes: (a) is it a real `engine.executeJsInTab` call site, (b) does it already dispatch a `__SP_*` sentinel that bypasses `new Function`, (c) does its JS read page-context globals / patch `window.*`, or only DOM / browser APIs.

**Important indirection note:** ~11 tools dispatch JS through the shared helper `_frame-routing-helper.ts:27` (`routeFrameAware`) rather than calling `engine.executeJsInTab` directly. The grep therefore registers only ONE call site for that whole group. Where those tools are refactor candidates, the table below cites the *tool-handler* file:line where the JS string is constructed (e.g. `extraction.ts:349` for `safari_get_text`) — that's where the v0.1.34 sentinel refactor actually lands. The helper itself is unchanged.

**Non-call-site grep matches:** 13 of the 89 raw matches are not actual `engine.executeJsInTab` call sites — they are 5 comment lines (the literal string appears in prose), 1 method definition (`navigation.ts:344` — the local `private async executeJsInTab` shim used by NavigationTools), and 7 calls to that local shim in navigation.ts (lines 184/206/213/228/234/251/254). The local shim routes via `engine.execute(engine.buildTabScript(...))` through the AppleScript engine, NOT through the extension storage bus / `new Function` path — it is orthogonal to v0.1.34's CSP / Trusted-Types failure mode. These are counted in a separate "Infrastructure" row so the Summary totals reconcile to 89.

## Summary

| Status | Count | What it means |
|---|---|---|
| Sentinel-already | 13 | JS string is `__SP_*:...`; intercepted in `extension/content-main.js` (`__SP_SCROLL_TO_ELEMENT__`, `__SP_DISMISS_OVERLAYS__`, `__SP_TAKE_SCREENSHOT__`, `__SP_LIST_FRAMES__`), `extension/content-isolated.js` (`__SP_FILE_UPLOAD__`, `__SP_FILE_UPLOAD_PROBE__`), or `extension/background.js` (`__SP_DNR_*`, `__SP_COOKIE_*`, `__SP_PACK_*`) before reaching `new Function`. Already CSP-immune. No action. |
| Page-context-needed | 19 | Reads framework internals, user-supplied script, or page-defined globals (patches `window.fetch` / `XHR` / `WebSocket`, overrides `navigator.userAgent`, `Intl.DateTimeFormat`, page console, dialog functions; or runs arbitrary user JS via `safari_evaluate` / `safari_eval_in_frame` / `safari_paginate_scrape.extractScript`). Cannot be refactored to ISOLATED-world; stays on `new Function` path. On CSP-strict pages the existing tool fails — error UX in task 3 covers it. |
| Browser-API-only | 19 | Reads `performance.*`, `navigator.clipboard` / `navigator.permissions.query` / `navigator.serviceWorker`, `document.cookie` (browser storage API, not DOM tree), `localStorage` / `sessionStorage` / `indexedDB`. Not DOM. Not affected by page CSP (browser APIs aren't subject to TT). No action. |
| Refactor candidate | 25 | DOM-affecting, no page-context, not yet sentinel. Plan tasks 7-15 cover the 12 listed in the headline table below; the remaining 13 sites (sweep tail in the "Additional DOM-only tools noted but not in v0.1.34 headline scope" subsection) are surfaced for the plan to choose whether to fold into Task 15 sweep, defer, or accept as continuing-to-fail on CSP-strict pages. |
| Infrastructure / not a real engine.executeJsInTab call site | 13 | 5 comments referencing the API in prose, 1 method definition (`navigation.ts:344` local shim), 7 calls of that local shim (navigation.ts AppleScript path — runs `history.back()` / `location.reload()` / `PAGE_INFO_JS` via `engine.execute()` not via the extension `new Function` dispatcher). Orthogonal to v0.1.34. |
| **Total** | **89** | **Matches `wc -l /tmp/csp-audit-raw.txt`.** |

## Refactor candidates (the work this plan executes)

| File | Line | Tool | Why refactor candidate | Task |
|---|---|---|---|---|
| src/tools/interaction.ts | 113 | safari_click | DOM click via clickElement() action JS dispatched through the shared `waitAndExecute` helper (locator at L63, auto-wait at L101, action at L113) | 7 |
| src/tools/interaction.ts | 113 | safari_fill | DOM input value setter (same shared dispatch path as safari_click; refactor lands at the action-JS construction in `handleFill` + the 3 shared helper lines) | 8 |
| src/tools/interaction.ts | 740 | safari_type | DOM input keystrokes — `el.focus()` + per-char `KeyboardEvent` dispatch + `el.value += char` (`handleType`) | 9 |
| src/tools/interaction.ts | 844 | safari_scroll | DOM `scrollTo` / `scrollBy` / `scrollIntoView` on document or selector target (`handleScroll`) | 10 |
| src/tools/extraction.ts | 349 | safari_get_text | DOM `textContent` / `innerText` read; dispatched via `routeFrameAware` (literal `engine.executeJsInTab` call is at `_frame-routing-helper.ts:27`) | 12 |
| src/tools/extraction.ts | 709 | safari_query_all | DOM `querySelectorAll` + per-element serialize (ref, attrs, bbox, visibility); dispatched via `routeFrameAware` | 13 |
| src/tools/extraction.ts | 292 | safari_snapshot | DOM accessibility tree dump via `generateSnapshotJs()` | 14 |
| src/tools/structured-extraction.ts | 224 | safari_smart_scrape | DOM walk with label/heading/dt/th heuristics + `document.querySelector` for `<meta>` fallback (`handleSmartScrape`) | 15 |
| src/tools/structured-extraction.ts | 287 | safari_extract_tables | DOM `<table>` enum, thead/th + tbody/tr/td readout | 15 |
| src/tools/structured-extraction.ts | 344 | safari_extract_links | DOM `<a[href]>` enum, internal/external classify, context-ancestor walk | 15 |
| src/tools/structured-extraction.ts | 381 | safari_extract_images | DOM `<img>` enum with min-width/height filter | 15 |
| src/tools/structured-extraction.ts | 449 | safari_extract_metadata | DOM meta/link/og/twitter/JSON-LD enum (no `<script>` execution — just `textContent` read of `script[type="application/ld+json"]`) | 15 |

**12 headline refactor candidates.** Within acceptance criterion bound (5-15).

### Additional DOM-only tools noted but not in v0.1.34 headline scope

The plan should decide whether to fold these into the Task 15 sweep, defer to v0.1.35, or accept they continue to fail on CSP-strict pages. They are all DOM-only refactor candidates by the same logic — none of them need page-context globals — but they are not bench-critical for the v0.1.34 target sites (Apple shop, Google Flights, X.com) per the v0.1.33 trace analysis (TRACES iter 79).

- `src/tools/interaction.ts:783` — safari_press_key — DOM `KeyboardEvent` dispatch on focused or selected element
- `src/tools/extraction.ts` handleGetHtml (constructs JS at L386-401, dispatched via `routeFrameAware`) — DOM `outerHTML` / `innerHTML` read
- `src/tools/extraction.ts` handleGetAttribute (constructs JS at L445-461, dispatched via `routeFrameAware`) — DOM `getAttribute`
- `src/tools/compound.ts:260` — safari_test_flow / click step — ad-hoc DOM `el.click()`
- `src/tools/compound.ts:279` — safari_test_flow / fill step — ad-hoc DOM input value + Event dispatch
- `src/tools/compound.ts:305` — safari_test_flow / url assertion — `location.href` read
- `src/tools/compound.ts:321` — safari_test_flow / text assertion — DOM `textContent` read
- `src/tools/compound.ts:334` — safari_test_flow / element assertion — DOM `querySelector`
- `src/tools/compound.ts:380` — safari_monitor_page (initial snapshot, `buildSnapshotScript`) — DOM read
- `src/tools/compound.ts:386` — safari_monitor_page (poll snapshot) — DOM read
- `src/tools/compound.ts:444` — safari_paginate_scrape / next-selector check — DOM `querySelector`
- `src/tools/compound.ts:459` — safari_paginate_scrape / click next — DOM `el.click()`
- `src/tools/compound.ts:470` — safari_paginate_scrape / `location.href` read
- `src/tools/compound.ts:509` — safari_media_control — DOM `<video>` / `<audio>` element control
- `src/tools/frames.ts:111` — safari_list_frames AppleScript-fallback DOM `iframe` enumeration (only fires when engine is NOT extension; the extension path uses `__SP_LIST_FRAMES__` and is already sentinel-already at frames.ts:80)
- `src/tools/wait.ts:196` — safari_wait_for — most variants (`selector` / `selectorHidden` / `text` / `textGone` / `urlMatch`) are DOM-only and refactorable. CAVEAT: the `networkidle` variant patches `window.fetch` / `XHR` (page-context-needed); the `function` variant runs user JS (page-context-needed). A clean refactor would split: sentinel handler for the DOM variants, leave `new Function` path for `networkidle` and `function`.

**13 additional refactor-candidate sites surfaced.** Combined with the 12 headline = 25 refactor-candidate lines total in the Summary table.

## Sentinel-already (no action needed)

- `src/tools/file-upload.ts:147` — safari_file_upload (probe) — `__SP_FILE_UPLOAD_PROBE__` (intercepted in `extension/content-isolated.js:182`)
- `src/tools/file-upload.ts:219` — safari_file_upload (final) — `__SP_FILE_UPLOAD__` (intercepted in `extension/content-isolated.js:189`)
- `src/tools/selector-pack.ts:86` — safari_selector_pack_register — `__SP_PACK_REGISTER__` (intercepted in `extension/background.js:623`)
- `src/tools/selector-pack.ts:103` — safari_selector_pack_unregister — `__SP_PACK_UNREGISTER__` (intercepted in `extension/background.js:623`)
- `src/tools/storage.ts:265` — safari_get_cookies (extension path) — `__SP_COOKIE_GET_ALL__` (intercepted in `extension/background.js:579`)
- `src/tools/storage.ts:342` — safari_set_cookie (extension path) — `__SP_COOKIE_SET__` (intercepted in `extension/background.js:579`)
- `src/tools/storage.ts:410` — safari_delete_cookie (extension path) — `__SP_COOKIE_REMOVE__` (intercepted in `extension/background.js:579`)
- `src/tools/frames.ts:80` — safari_list_frames (extension path) — `__SP_LIST_FRAMES__` (intercepted in `extension/background.js:331`)
- `src/tools/overlays.ts:112` — safari_dismiss_overlays — `__SP_DISMISS_OVERLAYS__` (intercepted in `extension/content-main.js:614`)
- `src/tools/extraction.ts:551` — safari_take_screenshot — `__SP_TAKE_SCREENSHOT__` (intercepted in `extension/background.js:391`)
- `src/tools/interaction.ts:1003` — safari_scroll_to_element — `__SP_SCROLL_TO_ELEMENT__` (intercepted in `extension/content-main.js:560`)
- `src/tools/auth.ts:132` — safari_auth_set_basic — `__SP_DNR_ADD_RULE__` (intercepted in `extension/background.js:357`)
- `src/tools/auth.ts:149` — safari_auth_clear — `__SP_DNR_REMOVE_RULE__` (intercepted in `extension/background.js:357`)

## Page-context-needed (stays on new Function, error UX covers it)

- `src/tools/network.ts:344` — safari_list_network_requests — reads page-installed `window.__safariPilotNetwork.entries` buffer (only populated by a prior `safari_intercept_requests` call); falls back to `performance.getEntriesByType('resource')`. The buffer lives in MAIN world; an ISOLATED handler can't see it.
- `src/tools/network.ts:411` — safari_get_network_request — same `window.__safariPilotNetwork` page-global read path.
- `src/tools/network.ts:599` — safari_intercept_requests — patches `window.fetch` and `XMLHttpRequest.prototype.send`. The page's `window` is the MAIN-world realm; ISOLATED can't reach it.
- `src/tools/network.ts:657` — safari_network_throttle — patches `window.fetch` + `XHR.prototype.open/send`.
- `src/tools/network.ts:700` — safari_network_offline — patches `window.fetch` + `XHR.prototype.open`.
- `src/tools/network.ts:778` — safari_mock_request — patches `window.fetch` + `XHR.prototype.open/send`, installs `window.__safariPilotMocks` registry.
- `src/tools/network.ts:841` — safari_websocket_listen — replaces `window.WebSocket` constructor with a patched version that records `send` / message events.
- `src/tools/network.ts:876` — safari_websocket_filter — reads `window.__safariPilotWS.messages` (MAIN-world buffer).
- `src/tools/network.ts:894` — safari_dump_har — reads `window.__safariPilotNetwork.entries`.
- `src/tools/permissions.ts:269` — safari_override_geolocation — overrides `navigator.geolocation.getCurrentPosition` / `watchPosition` on the page's `navigator`.
- `src/tools/permissions.ts:302` — safari_override_timezone — replaces `Intl.DateTimeFormat` on the page's global object.
- `src/tools/permissions.ts:332` — safari_override_locale — `Object.defineProperty(navigator, 'language', ...)` / `'languages'` on the page's `navigator`.
- `src/tools/permissions.ts:357` — safari_override_user_agent — `Object.defineProperty(navigator, 'userAgent', ...)` on the page's `navigator`.
- `src/tools/extraction.ts:510` — safari_evaluate — executes user-supplied JS string (the v0.1.34 known-broken target on CSP-strict pages; Task 3 error UX covers it with `CSP_BLOCKED` / `CSP_HARD_BLOCK` and `alternative_tools` hints).
- `src/tools/extraction.ts:658` — safari_get_console_messages — patches `console.log/warn/error/info/debug` on the page's console object and installs `window.__safariPilotConsole` buffer.
- `src/tools/interaction.ts:973` — safari_handle_dialog — replaces `window.alert`, `window.confirm`, `window.prompt` on the page's `window`.
- `src/tools/compound.ts:425` — safari_paginate_scrape — executes user-supplied `extractScript` JS (same shape as `safari_evaluate`).
- `src/tools/frames.ts:177` — safari_eval_in_frame (same-origin path) — `new win.Function(userScript)()` for a `contentWindow` of a selected iframe; user-supplied script.
- `src/tools/permissions.ts:195` — safari_permission_get — reads `navigator.permissions.query(...)`. Note: this is a `navigator.*` read only, no page-globals touched; could be classified as browser-API-only. Listed here because `permissions.ts` overall is page-context-flavor; the plan should treat this one as deferred (no action) regardless of bucket — it's not in the Apple/Google Flights/X.com failure set.

## Browser-API-only (no action needed)

- `src/tools/performance.ts:197` — safari_begin_trace — `performance.mark()` + `PerformanceObserver` install. Stores buffered entries on `window.__safariPilotTrace` (installed by this tool, not page-defined; could be moved to ISOLATED if ever bench-critical). Not affected by page CSP for v0.1.34 purposes.
- `src/tools/performance.ts:214` — safari_end_trace — reads `window.__safariPilotTrace` and `performance.getEntriesByType('mark'|'measure')`.
- `src/tools/performance.ts:231` — safari_get_page_metrics — `performance.getEntriesByType('navigation'|'paint'|'largest-contentful-paint'|'layout-shift')`.
- `src/tools/clipboard.ts:94` — safari_clipboard_read — `navigator.clipboard.readText()`.
- `src/tools/clipboard.ts:113` — safari_clipboard_write — `navigator.clipboard.writeText()`.
- `src/tools/service-workers.ts:102` — safari_sw_list — `navigator.serviceWorker.getRegistrations()`.
- `src/tools/service-workers.ts:121` — safari_sw_unregister — `navigator.serviceWorker.getRegistrations()` + `.unregister()`.
- `src/tools/storage.ts:306` — safari_get_cookies (AppleScript fallback path) — `document.cookie` (browser storage API surface, not the DOM tree).
- `src/tools/storage.ts:393` — safari_set_cookie (AppleScript fallback path) — `document.cookie` set.
- `src/tools/storage.ts:448` — safari_delete_cookie (AppleScript fallback path) — `document.cookie` set with past expiry.
- `src/tools/storage.ts:512` — safari_storage_state_export — `document.cookie` + `localStorage` + `sessionStorage` read.
- `src/tools/storage.ts:574` — safari_storage_state_import — `document.cookie` + `localStorage` + `sessionStorage` write.
- `src/tools/storage.ts:600` — safari_local_storage_get — `localStorage.getItem(key)`.
- `src/tools/storage.ts:626` — safari_local_storage_set — `localStorage.setItem(key, value)`.
- `src/tools/storage.ts:652` — safari_session_storage_get — `sessionStorage.getItem(key)`.
- `src/tools/storage.ts:678` — safari_session_storage_set — `sessionStorage.setItem(key, value)`.
- `src/tools/storage.ts:703` — safari_idb_list — `indexedDB.databases()`.
- `src/tools/storage.ts:781` — safari_idb_get — `indexedDB.open(...)` + cursor walk.
- `src/tools/interaction.ts:63` — locator resolution helper (shared by every interaction tool). `generateLocatorJs()` produces a DOM `querySelectorWithShadow` traversal that reads role / text / label / testid / placeholder. **This is technically a DOM operation that fails on TT-strict pages today.** Listed here only because the plan's Tasks 7-10 will cover this path implicitly: the new `__SP_CLICK__` / `__SP_FILL__` / `__SP_TYPE__` / `__SP_SCROLL__` sentinels accept a locator-spec object (not a pre-built CSS selector), so the locator resolution moves INTO the sentinel handler in `extension/content-main.js` where `window.__SP_LOCATOR__` is already callable. After Tasks 7-10 land, this line becomes vestigial for those tools; the same locator-helper call is still used by `safari_check`, `safari_hover`, `safari_double_click`, `safari_select_option`, `safari_drag` — none of which are bench-critical for v0.1.34 — and is therefore parked.
- `src/tools/interaction.ts:101` — auto-wait actionability check JS (`generateAutoWaitJs`). Same disposition as L63: covered implicitly by Tasks 7-10 (the new sentinels run their own actionability check inline); remaining callers (check / hover / drag / select_option) are not bench-critical.

## Tools NOT in src/tools/ that might also need attention

None. The grep was scoped to `src/tools/`. A wider grep would surface the daemon-side AppleScript engine (`src/engines/applescript.ts`), the daemon engine (`src/engines/daemon.ts`), and the extension engine (`src/engines/extension.ts`), but those are dispatch transports — they don't construct JS payloads. Each engine's `executeJsInTab` is the receiver, not the originator. The receiver-side change (adding sentinel intercepts) lives in `extension/content-main.js`'s `case 'execute_script':` switch, NOT in `src/`. Per spec Section 8, the plan modifies (a) tool-handler JS-string construction in `src/tools/` (per-task in Tasks 7-15), and (b) sentinel handlers in `extension/content-main.js` (one per refactored tool). No additional src files are surfaced by this audit.
