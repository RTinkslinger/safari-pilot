# T55a — Frame-aware storage bus (cross-origin iframe access)

**Date:** 2026-05-02
**Status:** Approved (post-brainstorm)
**Tracker:** T55a (P3)
**Predecessor:** T34/T55 (parity-test docs-only fix on 2026-04-29)

## Goal

Enable `ENGINE_CAPS.extension.framesCrossOrigin = true` honestly: the Safari Pilot extension can read DOM and run JavaScript inside cross-origin iframes via direct content-script injection, with race-free dispatch and aggregation-free targeting.

## Background

Today, every content-script entry in `extension/manifest.json` lacks `all_frames: true`. Cross-origin iframes are unreachable from the extension — `safari_eval_in_frame` falls back to `frame.contentWindow.Function(...)()` which the browser blocks with `DOMException: SecurityError` for cross-origin frames.

A naive flip of `all_frames: true` reintroduces a race: every frame's `content-isolated.js` sees the same `sp_cmd`, processes it, and writes to the single-slot `sp_result` key. Background's `resultListener` (background.js:258-268) removes itself on the **first** matching `commandId` write — fastest-frame wins, other frames' results are silently overwritten.

The parity test `test/unit/engine-selector/cap-manifest-parity.test.ts` self-coordinates: it asserts `framesCrossOrigin === manifest-has-all_frames`. Today both are `false`. After this work both flip to `true`.

## v1 scope (maximal — frameId on every reachable tool)

Nine tools gain optional `frameId` param in v1. Default `frameId` omitted = top frame (frameId=0), backwards compatible:

- `safari_list_frames` — returns `frameId` and `parentFrameId` in each entry (extension path; null on AppleScript path).
- `safari_eval_in_frame` — frameId precedence over frameSelector when both supplied.
- `safari_get_text`, `safari_get_html` (interaction.ts).
- `safari_extract_text`, `safari_extract_links`, `safari_extract_tables`, `safari_extract_metadata`, `safari_extract_images` (extraction.ts).
- `safari_query_shadow`, `safari_click_shadow` (shadow.ts).

That's **11 tools** total touched (1 returns frameId; 10 accept frameId param). EL noted maximal v1 grows the test surface; this spec commits to it explicitly with parameterized handler-routing coverage rather than per-tool drift.

## Non-goals (no version planned)

- Broadcast/fan-out tools that aggregate results across all frames.
- Nested-frame topology APIs (parent/child tree-walking helpers beyond `parentFrameId` field).
- Concurrency across same-frame in-flight commands beyond what commandId-keyed storage gives us for free.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Targeted-only dispatch.** Caller names exactly one frame per command. | Single writer ⇒ race-free. No fan-out aggregation logic needed. |
| D2 | **Numeric `frameId`** (from `webNavigation.getAllFrames`). | Stable for the page's lifetime, opaque to callers, native MV3 primitive. |
| D3 | **Top-frame default.** Tools without `frameId` param target frameId=0. | 100% backwards compatible. Existing callers never need to change. |
| D4 | **`webNavigation.getAllFrames` for discovery**, plus per-frame `sp_getFrameId` round-trip for self-identification. | webNavigation is authoritative for the topology; `sp_getFrameId` lets each content-isolated.js learn its own ID. |
| D5 | **Validate `frameId` at dispatch time.** Missing → `FRAME_NOT_FOUND` immediately. | Fast feedback; no 30s timeout for stale references. |
| D6 | **commandId-keyed storage:** `sp_cmd_<commandId>`, `sp_result_<commandId>`. | Supports concurrent commands across frames/tabs. Race-free by construction even before targeted-dispatch invariant. |
| D7 | **Maximal v1 scope:** 11 tools touched (`safari_list_frames` returns frameId; 10 tools gain optional frameId param across frames/interaction/extraction/shadow modules). | EL recommended eval-only v1 with extraction+shadow as v2/v3; user explicitly rejected the trim. Architecture is shared across all 10 frameId-accepting tools — bridge + content-isolated routing is built once, tool handlers are mechanical delegators. Test strategy uses parameterized routing tests to keep coverage cost ~constant per added tool. |
| D8 | **Per-tool guard, no dynamic-requirements mechanism.** `handleEvalInFrame` checks `params.frameId` itself; if set and `engine !== extension`, throws `FrameNotSupportedError` before dispatch. | Avoids new architectural surface for one call site. Graduate to `dynamicRequirements(params)` if v2/v3 require the same pattern at 7+ call sites. |
| D9 | **Test-side fixture server, not daemon ports.** `test/helpers/fixture-server.ts` spawns a Node `http.createServer` on 19476 + 19477 in beforeAll/afterAll. | Keeps test infra out of shipped binary. No daemon rebuild for fixture edits. |

## Architecture

### Storage-key invariants (load-bearing)

- `sp_cmd_<commandId>`: written by background; read+filtered by every frame; pruned by idle-cleanup. Includes optional `frameId` field. Filter rule: `cmd.tabId === myTabId && (cmd.frameId ?? 0) === myFrameId`.
- `sp_result_<commandId>`: written by exactly one frame (the one passing both filters); read by background's filtered listener; pruned by idle-cleanup.
- `sp_getFrameId`: action message (not a storage key). Each content-isolated.js sends it lazily on first `sp_cmd_*` arrival; background reads `sender.frameId`; round-trips back. Frames that never receive a command pay zero registration cost (mitigates 50-iframe registration storm on heavy pages).

### Component layout

```
manifest.json                   permissions += "webNavigation"
                                content_scripts[*].all_frames: true

content-isolated.js             myTabId   ← sp_getTabId (existing)
(per-frame instance)            myFrameId ← sp_getFrameId (NEW, lazy on first sp_cmd_*)
                                storage.onChanged: scan sp_cmd_* keys
                                filter: tabId match AND (cmd.frameId ?? 0) === myFrameId
                                write to sp_result_<commandId>

background.js                   sp_getFrameId handler → returns sender.frameId
                                handleExecute: if cmd.frameId set →
                                  webNavigation.getAllFrames({tabId})
                                    .find(f => f.frameId === cmd.frameId)
                                    || throw FRAME_NOT_FOUND
                                writes sp_cmd_<commandId>
                                listens for sp_result_<commandId> change
                                10s timeout for frame-targeted (vs 30s top-frame)
                                cleanup: remove([sp_cmd_<id>, sp_result_<id>])
                                idle-sweep: storage.local.get(null) → prefix-scan stale

src/engines/engine.ts           IEngine.executeJsInFrame(tabUrl, frameId, js): EngineResult
src/engines/extension.ts        Implements; payload includes frameId field
src/engines/applescript.ts      Throws FrameNotSupportedError
src/engines/daemon.ts           Throws FrameNotSupportedError

ExtensionBridge.swift           handleExecute decodes optional frameId,
                                threads through storage-bus payload Codable

src/types.ts                    requiresFramesCrossOrigin: already present
src/engine-selector.ts          ENGINE_CAPS.extension.framesCrossOrigin: true
                                (parity test self-coordinates)

src/errors.ts                   FRAME_NOT_FOUND, FRAME_NOT_SUPPORTED,
                                FRAME_NAVIGATED_AWAY (best-effort), FRAME_UNREACHABLE

src/tools/frames.ts             safari_list_frames merges webNavigation
                                  topology into result (frameId,
                                  parentFrameId)
                                safari_eval_in_frame:
                                  optional frameId param;
                                  precedence: frameId wins over frameSelector
                                  pre-dispatch guard: if frameId set
                                    AND engine !== extension
                                    → throw FrameNotSupportedError
                                  routes via engine.executeJsInFrame
                                  static requirements:
                                    requiresFramesCrossOrigin: true
                                  (selector-only callers: omit frameId,
                                   stays on existing same-origin path)

src/tools/interaction.ts        safari_get_text, safari_get_html:
                                  optional frameId param;
                                  same pre-dispatch guard;
                                  same routing pattern (executeJsInFrame
                                    when frameId set, executeJsInTab
                                    otherwise);
                                  requiresFramesCrossOrigin: true on the
                                    static requirements (selector
                                    schema unchanged otherwise).

src/tools/extraction.ts         safari_extract_text, _links, _tables,
                                  _metadata, _images:
                                  optional frameId param;
                                  same pre-dispatch guard + routing.

src/tools/shadow.ts             safari_query_shadow, safari_click_shadow:
                                  optional frameId param;
                                  same pre-dispatch guard + routing.

src/tools/_frame-routing-helper.ts (NEW)
                                Shared helper invoked by every
                                  frame-aware handler: given (engine,
                                  params, fallbackFn), returns
                                  executeJsInFrame call when frameId
                                  set, or fallbackFn() otherwise.
                                Throws FrameNotSupportedError for
                                  non-extension engines when frameId set.
                                Single source of truth for the routing
                                  rule across all 10 handlers — prevents
                                  drift and keeps per-handler diffs to
                                  ~2 lines (schema entry + helper call).
```

### Dispatch sequence (cross-origin iframe call)

1. **Caller** → `safari_list_frames({tabUrl})`. Background runs DOM enumeration JS in top frame, also calls `webNavigation.getAllFrames({tabId})`, merges by index/src match. Returns `[{index, frameId, parentFrameId, src, ...}]`.
2. **Caller picks frameId**, calls `safari_eval_in_frame({tabUrl, frameId, script})`.
3. **Handler** checks `params.frameId` set + `engine === extension` → ok. Calls `engine.executeJsInFrame(tabUrl, frameId, js)`.
4. **ExtensionBridge** sends payload over storage bus. **background.handleExecute** validates frameId via `webNavigation.getAllFrames`. Missing → `FRAME_NOT_FOUND`. Present → write `sp_cmd_<commandId>` with frameId field.
5. **Every content-isolated.js** sees `storage.onChanged` for `sp_cmd_<commandId>`. Each filters: tabId match AND `(cmd.frameId ?? 0) === myFrameId`. Exactly one passes (the targeted frame). All others return.
6. **Targeted frame** posts to MAIN, runs script, gets response, writes `sp_result_<commandId>`.
7. **background's filtered listener** fires for that key, resolves promise, removes both keys, returns to bridge.

### Lazy `sp_getFrameId` handshake

A frame's content-isolated.js does NOT call `sp_getFrameId` on script load. State machine:

```
IDLE
  on first sp_cmd_*  →  send sp_getFrameId, queue cmd, transition AWAITING_FRAME_ID
  
AWAITING_FRAME_ID
  on sp_getFrameId response  →  myFrameId = resp.frameId, drain queue, transition READY
  on additional sp_cmd_*     →  enqueue
  on handshake error/timeout →  transition IDLE (reset; next cmd retries)

READY
  on sp_cmd_*  →  filter immediately, no handshake needed
```

This is implemented as a pure reducer `frameIdHandshakeReducer(state, event)` in `extension/lib/handshake-machine.js`, unit-tested without browser APIs.

## Error model

| Code | When | Hint | Retryable |
|---|---|---|---|
| `FRAME_NOT_FOUND` | webNavigation.getAllFrames returns no entry matching the frameId at dispatch time. | Run `safari_list_frames` again — frame may have navigated or unloaded. | no |
| `FRAME_NAVIGATED_AWAY` | Frame's `pagehide` listener fired `runtime.sendMessage({action: sp_frame_unloading})` between dispatch and result. **Best-effort:** unload-time message delivery is not guaranteed; if it misses, the next call's webNavigation revalidation surfaces FRAME_NOT_FOUND as the safety net. Do not try to harden this race. | Frame navigated mid-command. List frames again. | yes |
| `FRAME_UNREACHABLE` | 10s frame-targeted timeout fires AND no `sp_getFrameId` handshake was ever received from that frameId. Heuristic catches: sandbox-without-`allow-scripts`, page CSP blocking content scripts, silent injection failures. | Frame may be sandboxed (no `allow-scripts`), CSP-blocked, or content-script injection failed. | no |
| `FRAME_NOT_SUPPORTED` | Tool called with `frameId` set but selected engine is not Extension. | Cross-origin frame access requires the Safari Pilot extension to be installed and connected. | no |

The 10s frame-targeted timeout is sufficient for v1 eval-only. Re-evaluate before v2 (extraction tools may have legitimately longer-running scripts).

## Testing strategy

### Unit (`test/unit/`)

| File | Asserts | Litmus |
|---|---|---|
| `engine-selector/cap-manifest-parity.test.ts` (existing) | `framesCrossOrigin === every-content_scripts-entry-has-all_frames`. | Remove `all_frames` OR fail to flip cap → fails. |
| `engine-selector/frames-cross-origin-cap.test.ts` (NEW) | selectEngine for `safari_eval_in_frame` with `frameId` set: returns 'extension' if available, throws `EngineUnavailableError` if not. | Remove static `requiresFramesCrossOrigin: true` → fails. |
| `tools/frame-routing-helper.test.ts` (NEW) | Pure helper from `_frame-routing-helper.ts`: routes to `engine.executeJsInFrame` when frameId set, calls fallbackFn otherwise. Throws `FrameNotSupportedError` when frameId set + non-extension engine. Recording-fake engine asserts the right method called with the right args. | Remove frameId branch OR remove guard → fails. |
| `tools/frame-aware-tools-routing.test.ts` (NEW, parameterized) | Parameterized over all 10 frame-aware tools (eval, get_text, get_html, extract_text/_links/_tables/_metadata/_images, query_shadow, click_shadow). For each: (a) frameId omitted → handler calls executeJsInTab; (b) frameId set → handler calls executeJsInFrame; (c) frameId set + non-extension engine → throws FrameNotSupportedError. Recording-fake engine captures method+args. | Adding a new frame-aware tool that bypasses the helper → that tool's parameterized case fails. |
| `extension/route-command.test.ts` (NEW) | Pure helper `shouldProcess(cmd, myTabId, myFrameId)`. Cases: tabId mismatch; omitted frameId + myFrameId=0/3; frameId=3 + myFrameId=3/0. | Remove the filter rule → multiple cases fail. |
| `extension/handshake-machine.test.ts` (NEW) | Pure reducer `frameIdHandshakeReducer`. All transitions: IDLE→AWAITING_FRAME_ID, queue-during-awaiting, response-drains-queue, error-resets-to-idle. | Remove queue branch → "second-cmd-during-handshake" case fails. |
| `extension/storage-keys.test.ts` (NEW) | `pickSpCmdKeys(storageObject)` finds `sp_cmd_*` via prefix scan. | Hardcode `sp_cmd` → fails. |
| `errors/frame-error-codes.test.ts` (NEW) | New error classes: codes, retryable flags, hints. | Remove a class → fails. |

### E2E (`test/e2e/`)

All five tests use `test/helpers/fixture-server.ts` — a Node http.createServer bound on 19476 + 19477 in beforeAll/afterAll, serving `test/fixtures/cross-frame/{host,inner}.html`. Two ports = two origins per same-origin policy.

| Test | Scenario | Litmus |
|---|---|---|
| `t55a-list-frames-cross-origin.test.ts` | New tab → `19476/host.html` (embeds iframe `19477/inner.html`) → `safari_list_frames`. Asserts result includes a frame with `frameId !== 0`, `parentFrameId === 0`, src matching 19477. | Remove `webNavigation` permission OR fail to merge getAllFrames into result → fails. |
| `t55a-eval-in-frame-cross-origin.test.ts` | Same setup → `safari_eval_in_frame({frameId, script: "return document.title"})`. Asserts title matches inner.html (NOT host.html). | Remove `all_frames: true` (no content script in iframe) → fails. Remove routing filter (top frame answers with host title) → fails. Remove `executeJsInFrame` bridge method → fails. |
| `t55a-frame-not-found.test.ts` | Same setup → `safari_eval_in_frame({frameId: 9999, script: ...})`. Asserts `FRAME_NOT_FOUND` error code. | Remove webNavigation validation → hangs 10s, returns timeout, wrong code. |
| `t55a-frame-targeted-respects-security-pipeline.test.ts` | Frame-targeted call against an UNOWNED tab URL. Asserts `TabUrlNotRecognizedError`, NOT FRAME_NOT_FOUND. | Move frame validation ahead of step 7d in security pipeline → fails. |
| `t55a-extension-down-frame-call.test.ts` | Extension reachability disabled → frame-targeted call. Asserts `FrameNotSupportedError` (or EngineUnavailableError). | Remove handler's `if engine !== extension` guard → silently routes to AppleScript → fails (returns SecurityError DOMException instead of typed error). |
| `t55a-extract-text-cross-origin.test.ts` | Same fixture (host on 19476, inner on 19477). Call `safari_extract_text({frameId})`. Assert returned text matches inner.html's body, NOT host.html. Proves extraction routing works through the shared `_frame-routing-helper`. | Bypass the helper in extraction.ts → top frame answers, returned text is host's body, fails. |
| `t55a-query-shadow-cross-origin.test.ts` | Inner.html serves a page with a shadow-DOM element. Call `safari_query_shadow({frameId, ...})`. Assert query lands in the iframe's shadow tree. Proves shadow tools route through frameId. | Bypass the helper in shadow.ts → top frame searched, query returns null, fails. |

### Daemon (`daemon/Tests/`)

`ExtensionBridgeTests.swift` — new test asserting `frameId` field round-trips through storage-bus payload `Codable` encoding. Litmus: drop frameId from struct → fails.

### Explicitly NOT tested at v1

- Per-tool e2e for every extraction/shadow tool (5 + 2 = 7 tools). The parameterized unit test plus one representative e2e per category (extract_text + query_shadow) covers the routing rule. Other tools' e2e is mechanical to add post-v1 if a regression appears.
- Lazy `sp_getFrameId` registration timing under heavy iframe load (50+ iframes) — performance, not correctness.
- Sandbox-without-allow-scripts → FRAME_UNREACHABLE timeout path — costs 10s per run; defer to follow-on or `slow` tag.
- Concurrent commands across multiple tabs simultaneously — commandId-keyed design supports it; explicit test deferred until a real caller exercises it.

## Spec-worthy notes (pulled forward from EL review)

1. **`requiresFramesCrossOrigin` precise definition:** "tool needs content-script execution inside a non-top frame" — not "tool interacts with frames generally."
2. **`safari_list_frames` engine asymmetry:** when extension unavailable, returns frames via DOM enumeration in top frame BUT `frameId` field is `null`. Document explicitly. Cross-origin frame interaction requires extension regardless.
3. **`FRAME_NAVIGATED_AWAY` is best-effort.** `pagehide`-time message delivery races teardown. Not guaranteed. The webNavigation revalidation on the next call is the safety net via `FRAME_NOT_FOUND`. Do not try to harden the race.
4. **Sandboxed iframes** (`<iframe sandbox>` without `allow-scripts`) are inherently unreachable; documented as known limitation.
5. **commandId-keying upgrades multiple call sites in `background.js`:**
   - writer (line 271) → `set({['sp_cmd_'+commandId]: storageCmd})`
   - resultListener (line 258-268) → filter on `changes['sp_result_'+commandId]`
   - cleanup (line 287) → `remove(['sp_cmd_'+commandId, 'sp_result_'+commandId])`
   - idle-sweep (line 430-446) → `storage.local.get(null)` + prefix-scan
   - `safari_extension_debug_dump` tool (verify no hardcoded `sp_cmd`/`sp_result` literal in dump path)
   - test-harness poison-write paths (background.js:700-723) — must update to write keyed slots
   - reconcile flow in ExtensionBridge.swift (T59/SD-33c) — verify no hardcoded key names

## Migration / rollout

Single feature branch (`fix/T55a-frame-aware-storage-bus`). All changes ship together; `framesCrossOrigin` flag flip is in the same commit as the manifest+content-script changes. Parity test self-coordinates the gate. No staged rollout — extension changes require version bump + rebuild + re-sign + re-notarize per CLAUDE.md hard rules; users update by downloading new release.

Per CLAUDE.md feedback memory `feedback-extension-version-both-fields`: bump `package.json` version (Safari caches by `CFBundleShortVersionString`); per `feedback-never-open-app-without-version-bump`: batch all extension fixes and bump once per batch. T55a is its own batch.

## Risk register

| Risk | Mitigation |
|---|---|
| `webNavigation` permission triggers Safari user re-prompt on extension update | Document in release notes; permission is in the standard MV3 permission list, not optional or warn-level on Safari. |
| 50-iframe page load triggers sp_getFrameId storm | Lazy registration: only frames receiving a sp_cmd_* register. Frames without commands pay zero cost. |
| `pagehide` unload race leaves command hanging | webNavigation revalidation on next call surfaces FRAME_NOT_FOUND (designed-in safety net). |
| commandId-keyed storage breaks debug-dump or reconcile | Spec note #5 enumerates every site to verify before merge. |
| Test fixture server port conflicts on dev machines | Configurable via `SAFARI_PILOT_FIXTURE_PORT_HOST` / `_INNER` env vars; defaults 19476/19477. |
| v1 maximal scope (10 frame-aware tools) drift over time | `_frame-routing-helper.ts` is the single source of truth for the routing rule. Parameterized unit test covers all 10 tools with constant code-cost-per-tool. New tools added later inherit the helper or fail the parameterized test. |

## Definition of done

- [ ] `npm run lint && npm run build` clean.
- [ ] All 7 new unit tests + existing parity test pass: `npx vitest run test/unit/`.
- [ ] All 7 e2e tests pass against full production stack: `npx vitest run test/e2e/t55a-*.test.ts`.
- [ ] Daemon Swift tests pass: `swift test` from `daemon/`.
- [ ] Extension rebuilt + re-signed + re-notarized via `bash scripts/build-extension.sh`.
- [ ] `package.json` version bumped to next patch.
- [ ] `bin/Safari Pilot.app` opened, extension re-enabled in Safari.
- [ ] `ARCHITECTURE.md` updated with frame-aware storage bus section.
- [ ] `TRACES.md` iteration entry written.
- [ ] `docs/TRACKER.md` T55a moved from Open → Resolved.

## References

- Predecessor: `docs/upp/specs/2026-04-20-storage-bus-extension-ipc-design.md` (the original storage bus design — frames not addressed).
- Existing parity test: `test/unit/engine-selector/cap-manifest-parity.test.ts`.
- CLAUDE.md hard rules: extension build (no manual codesign, version sync, verify entitlements), E2E means architecture (litmus: delete a layer, must fail a test).
- Memory: `feedback-distribution-builds`, `feedback-e2e-means-architecture`, `feedback-extension-version-both-fields`.
