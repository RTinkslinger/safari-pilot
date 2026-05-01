# Safari Pilot Tracker
*Single source of truth for open work. Created 2026-04-25 to consolidate `docs/AUDIT-TASKS.md` (T-numbered audit findings, 2026-04-23) + `docs/FOLLOW-UPS.md` (SD-numbered systematic-debugging follow-ups) + today's reconciliation review.*

**For new entries, use this file.** The two original ledgers stay as historical archives — their `RESOLVED` paragraphs preserve fix-context that would be lossy to copy here.

- `docs/AUDIT-TASKS.md` — original 2026-04-23 audit findings T1–T58 (with their full Findings / Root cause / Origin / Traces / Fix paragraphs).
- `docs/FOLLOW-UPS.md` — systematic-debugging follow-ups SD-01..SD-32 (with their full discriminator + entry-points + fix paragraphs).

This tracker carries one-line summaries + the IDs needed to look up full context in the archives.

---

## Method (non-negotiable)

Atomic per-item scope. For each entry below:

1. **Branch** off `main`: `fix/<id>-<slug>` or `chore/<id>-<slug>` for non-behavioural deletions.
2. **Phase 1 of `upp:systematic-debugging`** — root cause investigation: read the source, reproduce, gather evidence. Don't skip to a fix.
3. **`upp:test-driven-development`** — write the discriminating failing test FIRST. Verify it fails for the expected reason against the buggy SUT.
4. **`upp:test-reviewer` gate** — dispatch fast (≤3 tests) or full (>3 tests). PASS verdict required before GREEN. Reviewer-skip is permitted ONLY for: deletion of dead code (T24 / T31 precedent), test-infra-only refactors (SD-29 precedent), and re-use of an already-reviewed shared helper (T32 precedent).
5. **Apply the fix** (GREEN). Verify the test passes.
6. **Mutation cycle** — temporarily revert the fix, re-run the test, confirm it fails. Restore. This step is what discriminates "test verified the fix" from "test happened to pass."
7. **Commit fix → ff-merge to main → push.** One change per commit; one item per branch.
8. **Standalone docs commit** moving the entry from the Open table below to the Resolved index (with commit SHA).

**No large scopes.** If an item turns out to require multiple discriminating tests or multi-file production refactors that go beyond a single concern, split it into sub-items first.

---

## Open work — by impact

### Critical bugs (ship next)
*All shipped this sprint.* T7, SD-31, SD-32 resolved. See "Resolved this sprint" below.

### Extension-rebuild batch
Source changes to `extension/*.js` are incomplete without rebuild + sign + notarize + release per the `feedback_distribution_builds` memory. Bundle these as ONE drop, not three releases.

| ID | Surface | One-liner |
|---|---|---|
| **T21** | `extension/content-isolated.js` | content scripts don't patch `history.pushState`/`replaceState` — SPA URL changes via History API don't update the extension's tab cache |
| **T22** | `extension/background.js` pollLoop | poll loop returns on error (no infinite loop), but no real retry-on-transient — wakeSequence reactivates on alarm only |
| **T27** | `extension/background.js` findTargetTab | falls through to active tab when `tabUrl` not found; should return null when `tabUrl` was explicitly provided |
| **T44** | `extension/background.js` | stale `sp_result` not cleaned up on event-page re-wake after suspension |

Build pipeline: edit → `bash scripts/build-extension.sh` → verify entitlements via `codesign -d --entitlements -` → bump `package.json` version (per "never open app without version bump" memory) → `open "bin/Safari Pilot.app"` → verify in Safari Settings → release.

### Quality debt — P2
*All shipped this sprint.* T34/T37/T38/T39/T40 + T35 + T36 resolved. See "Resolved this sprint" below.

### Missing features / cosmetic — P3

| ID | Surface | One-liner |
|---|---|---|
| **T41** | new tool | build `safari_file_upload` (currently absent from tool registry) |
| **T42** | `test/e2e/` | write e2e tests for recovery / degradation paths |
| **T43** | `test/e2e/` | write e2e tests for 61 untested tools (multi-week sub-sprint) |
| **T45** | `daemon` TCP listener | crash on port-19474 bind conflict instead of random-port fallback (silent split-brain) |
| **T46** | `daemon/Sources/SafariPilotdCore/PdfGenerator.swift` | possible `CheckedContinuation` leak on error path |
| **T47** | `.github/workflows/release.yml` | verify extension entitlements + code-sign before uploading to GitHub Release |
| ~~T48~~ | RESOLVED 2026-05-01 | See "Resolved this sprint" below. |
| ~~T49~~ | RESOLVED 2026-04-30 | See "Resolved this sprint" below. |
| ~~T50~~ | RESOLVED 2026-04-30 | See "Resolved this sprint" below. |
| ~~T51~~ | RESOLVED 2026-04-30 | See "Resolved this sprint" below. |
| **T52** | `scripts/postinstall.sh` + `update-daemon.sh` | mix of legacy `launchctl unload/load` and modern `launchctl kickstart`/`bootstrap` — pick one |
| **T53** | `scripts/postinstall.sh` | download/extraction failures swallowed by `\|\| true` guards |
| ~~T54~~ | RESOLVED 2026-05-01 | See "Resolved this sprint" below. |
| **T55a** | `extension/background.js` + `extension/content-isolated.js` + `extension/manifest.json` | frame-aware storage-bus routing (`frameId` discrimination on `sp_cmd`/`sp_result`) — true prereq for cross-origin frames. Once shipped, manifest gains `all_frames: true` and `ENGINE_CAPS.extension.framesCrossOrigin` flips to `true` in the same commit; the cap-manifest parity test enforces atomicity. |
| ~~T56~~ | RESOLVED 2026-05-01 | See "Resolved this sprint" below. |
| ~~T57~~ | RESOLVED 2026-05-01 | See "Resolved this sprint" below. |
| **T58** | `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` | bind failure on port 19475 logs and continues; should be fatal |
| **T59** ✓ RESOLVED | `src/tools/extraction.ts` (`safari_take_screenshot`) + `src/security/` | domain-allowlist screenshot policy — `ScreenshotPolicy` + `ScreenshotBlockedError` shipped 2026-04-26. 10 unit tests (policy-logic) + 5 unit tests (handler-wiring) + 1 e2e litmus (stripe.com → SCREENSHOT_BLOCKED). Commits: `796cc83`, `64385aa`, `43dc2d6`. |

### Deferred features (intentional, filed for later)

*SD-30 permanently closed 2026-04-26 (moved to Resolved). SD-33 split into 4 sub-items below (moved to Resolved).*

### HealthStore wiring sub-items (SD-33 split, P3)

| ID | Surface | One-liner |
|---|---|---|
| **SD-33a** ✓ RESOLVED | `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` | Wire `incrementRoundtrip()` — after `cmd.continuation.resume()` in `handleResult()`. Keepalive/trace early-returns short-circuit before it. 3 unit tests (direct, negative-keepalive, dispatcher-mediated). Commit: `b058b0f`. |
| **SD-33b** ✓ RESOLVED | `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` | Wire `incrementTimeout()` — inside `if removed { }` in the handleExecute timeout Task. Added `commandTimeout` injection (default 90s) for testability. 3 unit tests (direct, negative, dispatcher-mediated). Commit: `1addfe1`. |
| **SD-33c** ✓ RESOLVED | `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` | Wire `incrementUncertain()` outside `queue.sync` in `handleReconcile()`, once per uncertain ID. Investigation confirmed path IS reachable (tracker phrasing was wrong). 3 unit tests (direct, negative two-phase, dispatcher-mediated). Commit: `bd829b6`. |
| **SD-33d** ⚠ DEFERRED | `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` | `forceReloadExtension()` does NOT exist anywhere in the daemon codebase — no production call site found. Deferring until a force-reload recovery mechanism is implemented. Do NOT create a no-op stub. |

### ROADMAP backlog (not from audit, but tracked)

| ID | Surface | One-liner |
|---|---|---|
| ROADMAP-flake | NDJSON parser | line-split flake under parallel test runs (long click JS payloads with embedded newlines break the daemon's line-based JSON parser) |
| **T60** | `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` (Hummingbird, port 19475) | HTTP server deadlocks under `extension-reload-during-active-connection` — accepts TCP but never sends responses. TCP daemon-engine path (port 19474) unaffected. `launchctl bootout`/`bootstrap` does NOT clear the bug; needs full Safari quit + relaunch (or system reboot). Reproduced 2026-04-29 during T22 e2e attempts via `launchctl kickstart -k`. Pivoted T22 to bridge-injection so the test no longer triggers it, but the underlying daemon bug remains. |
| ~~T63~~ | RESOLVED 2026-04-30 | See "Resolved this sprint" below. |

---

## Resolved this sprint (2026-04-25)
Lookup-only index; full fix-context paragraphs are in `docs/AUDIT-TASKS.md` / `docs/FOLLOW-UPS.md` Resolved sections.

| ID | Code | Docs | One-line |
|---|---|---|---|
| T61 + T62 + ROADMAP-#3 | `cee676b` | (this commit) | `buildNavigateScript` now `return "<url>"` so osascript stdout is non-empty — empty stdout from pure-OSA setter was misclassified as CSP_BLOCKED by `parseJsResult`. Single root cause; T62 (post-navigate ownership) and ROADMAP-#3 (back/forward stale URL) both resolved as cascades. phase1-core-navigation: 4 failed → 6/6 GREEN. |
| T63 | (this branch) | (this commit) | New `requiresApplescript` capability flag on `ToolRequirements`. `selectEngine()` honours it and short-circuits to `'applescript'` AFTER the `requiresExtension` check (correctness > telemetry). Tagged 7 NavigationTools, 4 CompoundTools, and `safari_health_check` — all the tools whose handlers run raw AppleScript independent of engine availability (constructed with `AppleScriptEngine` directly, bypassing `EngineProxy`). Result: `__engine` metadata stamped at server.ts:982,997 now reflects what actually ran. Telemetry-only fix; no correctness impact. New tests: 18 unit (`test/unit/engine-selector/applescript-only.test.ts`) + 5 e2e (`test/e2e/t63-engine-telemetry.test.ts`) covering the primary regression case + capability-collision priority + deferred-ownership branch. |
| T57 | (this branch) | (this commit) | `daemon/Sources/SafariPilotdCore/NDJSONProtocol.swift` — replaced silent `try? JSONSerialization.jsonObject(...)` with explicit `do/catch` wrapping that captures the underlying parse error and includes it in `NDJSONError.invalidJSON`'s message. Added `Logger.warning` calls at each parse-failure point so daemon stderr now records WHAT made each line invalid (UTF-8 encoding, JSONSerialization failure with reason, top-level-not-object, decoding failure with reason). Pre-T57 every malformed input collapsed to "Line is not a valid JSON object" — useless for diagnosing protocol failures. New test: `testRejectsInvalidJSON_includesUnderlyingReason_T57` in main.swift asserts the error message now contains "JSONSerialization" or "failed:" tokens that don't appear in the pre-T57 template. Daemon test suite: 140/140 PASS. Daemon binary rebuilt and reloaded. |
| T48 | (this branch) | (this commit) | New `SessionTabProtectedError` (errors.ts) + `SESSION_TAB_PROTECTED` code. Guard at server.ts step 7d throws when `tabUrl === sessionTabUrl`, BEFORE the ownership check, so the session tab is refused regardless of which engine the tool is routed to. Pre-T48 the session URL was implicitly protected — by `TabUrlNotRecognizedError` on the AppleScript path and by deferred-fail-closed on the extension path. The latter only fires AFTER the navigation/click side effect ran in Safari. Now the guard runs pre-execution so the side effect never happens. New tests: 3 e2e (`test/e2e/t48-session-tab-guard.test.ts`) — discovers session URL via `safari_list_tabs`, asserts dedicated error tokens ("dashboard" + "refused") that don't appear in `TabUrlNotRecognizedError`'s URL-echoing template + triangulation guard with non-session unrecognized URL. |
| T54 + T56 | (this branch) | (this commit) | **T54**: `scripts/update-daemon.sh` swapped `pgrep -f`/`pkill -f SafariPilotd` for `-x` so the orphan-cleanup pass doesn't kill unrelated commands whose argv merely contains the string (e.g. `grep SafariPilotd ...`, `node test/run-SafariPilotd-test.js`). **T56**: `safari_handle_dialog` previously declared `requiresDialogIntercept: true`, forcing extension-only routing via `selectEngine`'s `requiresExtension` branch. The handler is a pure JS override (`window.alert/confirm/prompt` monkey-patch) that runs on any engine that executes JS, including AppleScript's `do JavaScript`. Flag dropped — tool now falls back to AppleScript when extension is unavailable, matching reality. New tests: 4 unit (`test/unit/tools/handle-dialog-requirement.test.ts`) — flag absence + selectEngine routing observable consequence. |
| T49 + T50 + T51 | (this branch) | (this commit) | Three small honesty fixes batched. **T49**: `safari_type` schema declared `delay: { default: 50 }` but handler had no per-keystroke pacing (sync for-loop). Zero callers pass it. Dropped from schema. **T50**: `safari_scroll` accepted `toTop`, `toBottom`, `toElement` independently — handler emitted each as a separate JS statement, so multi-mode silently ran all branches with last-write-wins. Added validation throw at handler entry: `\`toTop\`, \`toBottom\`, and \`toElement\` are mutually exclusive — pass only one`. **T51**: `safari_reload` schema declared `bypassCache` and handler emitted non-standard `location.reload(true)` (boolean arg never in WHATWG spec; zero callers). Dropped from schema; handler emits spec-compliant `location.reload()` only. New tests: 10 unit (`test/unit/tools/schema-cleanup-t49-t50-t51.test.ts`) — schema-removal + handler-parity (proves handlers don't read dropped params) + mutex multi-mode coverage + single-mode regression guards. |
| T13 | `0636182` | `dede5fb` | parseJsResult bare-empty CSP — collapsed triple-nested conditional |
| T15 | `1e56bba` | `f7ed832` | safari_new_tab.idempotent flipped true→false |
| T16 | `1809b1a` | `9ad595a` | safari_hover description: dropped false "CSS :hover" claim |
| T17 | `9b16f17` | `d5cd1ee` | safari_take_screenshot: removed dead schema params |
| T18 | `113515a` | `9702335` | safari_export_pdf: removed dead tabUrl from schema |
| T19 | `816d970` | `6695b6c` | safari_paginate_scrape: surface stale-URL bail loudly |
| T20 | `8b62f03` | `b9b096d` | safari_eval_in_frame: replace win.eval() with new win.Function() |
| T23 | `0e6e6e9` | `996c0d7` | disconnectTimeout 15s→25s |
| T24 | `cc20814` | `6ca4105` | Deleted unused domainMatches + helper |
| T25 | `3b94994` | `1037ee9` | Shutdown detection: parsed method, not substring |
| T26 | `591ffda` | `0ac1650` | Trace serial DispatchQueue.sync |
| T28 | `3533785` | `c475ea3` | Engine-aware health gate |
| T29 | `a504928` | `f055ebb` | killSwitch.recordError wired (introduced SD-31 — fix queued) |
| T30 | `4ecaef1` | `068e16c` | MCP isError on HumanApproval soft-returns |
| T31 | `54c2ae1` | `a64be40` | Deleted unused extensionAllowed; banking-extension filed as SD-30 |
| T32 | `960f1c8` | `ffc1f7e` | Shared js-helpers.ts (DaemonEngine gains CSP / shadow / JS-error semantics) |
| SD-29 | `a173e95` | `f3ead67` | vitest cross-file mock pollution — vi.resetModules + vi.doMock + dynamic import |
| Reconciliation | — | `da37e52` | 13 stale-open audit items marked RESOLVED + SD-31, SD-32 filed |
| Tracker | — | `4bec8e3` | Consolidated AUDIT-TASKS + FOLLOW-UPS into this file |
| SD-31 | `63d4e59` | `ecb32d6` | killSwitch.recordError filters security-pipeline errors (no more TabUrlNotRecognizedError-burst self-DoS) |
| T7 | `71218d9` | `317527a` | Regression guard for existing safari_close_tab tab-ownership cleanup (server.ts:833-852); audit-flagged leak prevented from silently re-emerging |
| SD-32 | `6b55ff9` | `170592e` | orphan-cleanup skips when other live sessions exist; multi-session contract restored |
| T37 | `d82c534` | `b4687de` | Deleted unused `recordPreExisting` + `isPreExisting` from `TabOwnership` (zero callers; positive-ownership model makes them redundant) |
| T39 | `cae41d8` | `1c7e310` | `recordHttpRequestError` now prunes entries older than 1h on append (re-scoped from 4 arrays to 1; the other three were unwired and filed as SD-33) |
| T34 | `b7d57b7` | `65c2297` | `ENGINE_CAPS.extension.framesCrossOrigin` flipped `true → false` to match manifest reality (no `all_frames` in content_scripts); cap-vs-manifest parity test guards future drift, will require flip-back when T55 lands |
| T38 | `1479e63` | `6effb86` | `recoverSession` now re-calls `registerWithDaemon()` after both success branches (window-only + extension-recovery), keeping the daemon session registry consistent across daemon restarts and preserving the SD-32 multi-session contract |
| T40 | `09d2bf7` | `09d2bf7` | `ARCHITECTURE.md` brought current — verified date refresh, cross-origin frames claim removed (T34), 12-of-17-modules drift, recoverSession T38 step, T39 + SD-33 caveat on the unwired `roundtrip`/`timeout`/`uncertain` counts. Of the audit's original 8 claims, 4 had been resolved by intervening commits (T8/T12/T24); 4 needed actual edits this commit; +1 found via parallel verification (12-vs-13 inconsistency). |
| T35 | `1626ca9` | `b1aa987` | Renamed `IdpiScanner` → `IdpiAnnotator` (file, class, method `scan()` → `annotate()`, type `ScanResult` → `AnnotationResult`); dropped "scanner" framing across ARCHITECTURE.md / CLAUDE.md / EXECUTION-FLOWS.md / e2e test header. No behavioural change — pure rename. Class header documents the well-defined route from annotator → scanner if a future threat-model review wants real blocking. |
| T36 | `74e4847` | (this commit) | Deleted `ScreenshotRedaction` no-op layer (164 LOC + 7 unit tests + 1 e2e test + wiring at server.ts:945-952). The module returned a CSS-blur script in `_meta.redactionScript` but the script was never injected before `screencapture -x`, and the OS-level capture is immune to CSS blur regardless. Domain-block screenshot policy (the actually-useful primitive) filed as T59 for separate scheduling. |
| SD-30 | — | `5800d8f` | Permanently deferred. Extension has 4 unique capabilities applescript lacks (httpOnly cookies, network intercept, CSP bypass, shadow DOM) — accepted risks. Complexity of per-domain engine restriction not justified by defense-in-depth marginal gain. Decision recorded in `docs/upp/specs/2026-04-26-threat-model-decisions.md`. |
| SD-33 | — | `5800d8f` | Wire decision: wire SD-33a/b/d; investigate SD-33c first. Split into 4 sub-items filed under "HealthStore wiring sub-items" in open table. Decision recorded in `docs/upp/specs/2026-04-26-threat-model-decisions.md`. |
| T55 | — | (this commit) | RESOLVED-as-documented (2026-04-29). Original wording "add `all_frames: true` to content_scripts (or document the limitation)" allowed two paths. Audit re-read against the runtime (`extension/content-isolated.js:30-79` filters only by `tabId`, not `frameId`; `sp_result` is single-slot, last-writer-wins) established that a manifest-only flip would race across frames — strictly worse than today's documented limitation. The actual prereq — frame-aware storage-bus routing — is now tracked as **T55a** in the open P3 table. `src/engine-selector.ts`, `test/unit/engine-selector/cap-manifest-parity.test.ts`, and `ARCHITECTURE.md` all updated to point at T55a. Cap stays `false`; parity invariant preserved. No shipped tool currently declares `requiresFramesCrossOrigin: true`, so no functional regression. |

Pre-2026-04-25 sprint resolved entries (SD-01..SD-28, T13..T25 originals): see archives.

---

## Tally

- **14** audit items (T-numbered) open — 0 P0, 4 in extension batch, 0 P2 quality debt (all shipped), 10 P3 missing-feature/cosmetic (T48/T49/T50/T51/T54/T56/T57 RESOLVED 2026-04-30→2026-05-01; T55 → RESOLVED-as-documented 2026-04-29 with T55a added in its place).
- **4** SD open — SD-33a/b/c/d (HealthStore wiring sub-items, split from SD-33 parent 2026-04-26). SD-30 and SD-33 parent resolved.
- **2** ROADMAP backlog items — NDJSON line-split flake, T60 (daemon Hummingbird HTTP deadlock). T61/T62/ROADMAP-#3 RESOLVED 2026-04-30 by `cee676b`; T63 RESOLVED 2026-04-30 via new `requiresApplescript` capability flag honoured by `selectEngine()`.

Total open: **27**. T59 RESOLVED — `ScreenshotPolicy` wired end-to-end; 15 unit tests + 1 e2e litmus; merged to main 2026-04-26. P2 quality debt remains empty. T55 reduced to docs-only 2026-04-29 (replaced in P3 by T55a).

Open follow-up flagged by SD-32 reviewer: an e2e companion test that spawns two concurrent MCP sessions and asserts Session A's keepalive survives Session B's startup would close the unit-test wiring gap (server.ts:1422 stores the otherSessions count into a private field; the unit tests poke the field directly; only an e2e exercises the full registerWithDaemon → field-write → cleanup-skip flow). Worth filing as SD-33 if anyone reports concurrent-session breakage.
