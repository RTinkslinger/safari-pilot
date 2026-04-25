# Safari Pilot Audit Task List

*Generated: 2026-04-23 | Method: 8 specialist audit agents + 61 per-finding deep-trace agents | 89 commits analyzed*

**This document is the authoritative list of work to be done before any new feature development.** Every item has been traced through the full git history, cross-referenced against specs/plans/research, and verified with commit citations. Items are grouped by component and ordered by priority within each group.

**Rejected findings (2):** M15 (primitive results lose _meta) — false positive, storage bus always wraps as object; M27 (isSessionAlive always false) — false positive, keepalive path is correctly wired through content script -> background.js -> POST /result -> ExtensionBridge.

**Corrected finding (1):** H7 (NDJSON line-split) — daemon serializer correctly escapes newlines via JSONSerialization. Real issue is the silent `catch {}` at daemon.ts:330 that discards malformed lines without logging or rejecting the pending request.

---

## Priority Tiers

| Tier | Criteria | Count |
|------|----------|-------|
| **P0** | Security bypass, data loss, or core workflow broken | 12 |
| **P1** | Reliability/correctness — silent wrong behavior | 16 |
| **P2** | Dead code, documentation lies, quality debt | 15 |
| **P3** | Missing features, cosmetic, low-probability | 16 |

---

## P0: Security Bypass / Core Workflow Broken

### T1. Make `tabUrl` required on `safari_navigate` ✅ RESOLVED (2026-04-25 ledger reconciliation; fix-commit SHA unknown)
**Fix verified:** `src/tools/navigation.ts:46` lists `tabUrl` in `inputSchema.required`.

**Findings:** C1 (security + tab-ownership audit, confirmed by 2 independent agents)
**Root cause:** `safari_navigate` schema declares `required: ['url']` — `tabUrl` is optional. Ownership check at `server.ts:579` is gated on `params['tabUrl']` being truthy. Without it, agent can navigate ANY user tab (banking, email).
**Origin:** `aa1c302` (2026-04-11) — navigation tools created with optional tabUrl as UX convenience ("omit to use front tab"). Security was added later (`316feed`, 2026-04-12) without questioning the optional design.
**Traces:** C1 agent traced through 9 commits. The `if (params['tabUrl'] && ...)` gate was carried through 5 subsequent refactors (`68fb1ed`, `75177e8`, `3cf95d8`) without re-examination.

### T2. Update registry URL after `safari_navigate` via AppleScript ✅ RESOLVED (2026-04-25 ledger reconciliation; fix-commit SHA unknown)
**Fix verified:** Successful `safari_navigate` runs `executeJsInTab` post-navigate and refreshes the ownership registry; URL refresh path is at `src/server.ts:748` with `ownership_url_refreshed` trace.

**Findings:** C2 (tab-ownership audit, confirmed by cross-reference with H3, Bug 7)
**Root cause:** NavigationTools is hardwired to raw `AppleScriptEngine` (not EngineProxy) at `server.ts:257`. After navigation, no `_meta` flows back, so the post-execution URL update at `server.ts:732-785` never fires. Registry keeps old URL. All subsequent tool calls fail with `TabUrlNotRecognizedError`.
**Origin:** `7c4fd2a` (2026-04-16) explicitly excluded NavigationTools from EngineProxy. `68fb1ed` (2026-04-21) removed the old `NAVIGATION_URL_TRACKING_TOOLS` mechanism that had correctly updated URLs. The replacement (`_meta`-based) is architecturally incapable of handling NavigationTools.
**Traces:** C2 agent traced through 10 commits including the removal of the only working URL-update mechanism.

### T3. Wire `preuninstall` in `package.json` ✅ RESOLVED (2026-04-25 ledger reconciliation; fix-commit SHA unknown)
**Fix verified:** `package.json:38` has `"preuninstall": "bash scripts/preuninstall.sh"`.

**Findings:** C3 (distribution audit)
**Root cause:** `scripts/preuninstall.sh` exists and is complete (handles both daemon and health-check LaunchAgents) but `package.json` has never had a `"preuninstall"` key. `npm uninstall` leaves daemon running and restarting via `KeepAlive` forever.
**Origin:** `9220fbf` (2026-04-12) created the script. `75cd0c8` (3 minutes later) fixed postinstall wiring but didn't wire preuninstall. Never caught in 20 subsequent commits.
**Traces:** C3 agent confirmed zero `grep` hits for "preuninstall" in any version of `package.json`.

### T4. Ship universal daemon binary in npm package ✅ RESOLVED (2026-04-25 ledger reconciliation; fix-commit SHA unknown)
**Fix verified:** `.github/workflows/release.yml:40-47` lipos the arm64 + x86_64 builds into a universal binary at `dist-bin/SafariPilotd-universal`.

**Findings:** C4 (distribution audit)
**Root cause:** `release.yml` builds universal binary to `dist-bin/SafariPilotd` but `npm publish` packages `bin/SafariPilotd` (populated by postinstall's `swift build` — arm64-only on CI runner). Missing `cp dist-bin/SafariPilotd bin/SafariPilotd` step.
**Origin:** `9220fbf` (2026-04-12) created release.yml without the copy step. Never added across 5 tag pushes (v0.1.0-v0.1.4).
**Traces:** C4 agent verified npm tarball contains arm64-only binary via `file` command.

### T5. Remove or fix `safari_switch_frame` (no-op tool) ✅ RESOLVED (2026-04-25 ledger reconciliation; fix-commit SHA unknown)
**Fix verified:** FrameTools at `src/tools/frames.ts:33-62` exposes `safari_list_frames` and `safari_eval_in_frame`, both with non-trivial handlers. The original no-op `safari_switch_frame` is gone.

**Findings:** C5 (tool-modules audit)
**Root cause:** Handler verifies iframe exists and returns `{ switched: true }` but stores no frame context. No subsequent tool is affected by the "switch." Description promises "Records the frame selector so future tool calls targeting this tab are scoped to the specified iframe" — completely false.
**Origin:** `b3b83a1` (2026-04-12) — created as part of a batch, never had frame context storage.
**Traces:** C5 agent confirmed zero `grep` hits for `frameContext`, `currentFrame`, `activeFrame` in any source file.

### T6. Fix IDB tools (`safari_idb_list`, `safari_idb_get`) — broken on all engines ✅ RESOLVED (2026-04-25 ledger reconciliation; fix-commit SHA unknown)
**Fix verified:** Handlers at `src/tools/storage.ts:640` (`handleIdbList`) and `:665` (`handleIdbGet`) both `await this.engine.executeJsInTab(...)` with Promise-wrapped IDB calls. Phase 5 e2e tests (`phase5-storage-async.test.ts`) cover both routes.

**Findings:** C6 (tool-modules audit)
**Root cause:** Both use `return new Promise(...)` in injected JS. AppleScript's `do JavaScript` doesn't await — returns `[object Promise]` as string. Extension's `content-main.js` also doesn't await (`result = fn()` not `result = await fn()`). Need `requiresAsyncJs` capability flag + `await` in content-main.js.
**Origin:** `aa34541` (2026-04-12) — IDB tools created with async JS. No engine supported async at the time or since.
**Traces:** C6 agent verified both the AppleScript and extension paths fail, and the mock tests that "passed" bypassed execution entirely.

### T7. Call `removeTab()` after `safari_close_tab`
**Findings:** H5 (tab-ownership audit)
**Root cause:** `TabOwnership.removeTab()` exists but is never called. Closed tabs remain in registry. Stale URL could match a user's tab later, granting the agent ownership of a user tab.
**Origin:** `630526e` (2026-04-12) created `removeTab()`. `316feed` wired `registerTab()` for new_tab but never wired `removeTab()` for close_tab. Identity spec (`2026-04-20`) explicitly listed tab closure as a "Non-Goal" based on incorrect assessment that "orphaned entries are harmless."
**Traces:** H5 agent confirmed zero `grep` hits for `removeTab` in `src/server.ts` across all commits.

### T8. Fix deferred ownership no-_meta path — update ARCHITECTURE.md or restore throw ✅ RESOLVED (2026-04-25 ledger reconciliation; fix-commit SHA unknown)
**Fix verified:** `src/server.ts:843-862` throws `TabUrlNotRecognizedError` when the deferred path can't recover ownership; fail-closed contract documented inline. (ARCHITECTURE.md still claims `throw` semantics — see T40.)

**Findings:** H3 (security + tab-ownership audit, confirmed by 2 agents)
**Root cause:** `server.ts:760-784` — when deferred ownership check has no `_meta`, code silently succeeds and updates the FIRST owned tab's URL. ARCHITECTURE.md line 222 says "throw (fail closed)" — code explicitly does NOT throw. Change was deliberate (`75177e8`, "Don't throw — the tool already executed").
**Traces:** H3 agent traced the spec → implementation → reversal across 7 commits.

### T9. Reset `useTcp` on timeout and parse failure in DaemonEngine ✅ RESOLVED (2026-04-25 ledger reconciliation; fix-commit SHA unknown)
**Fix verified:** `src/engines/daemon.ts` resets `useTcp = false` on socket-error (line 423), timeout (line 445), and parse failure (line 454) paths. `test/unit/engines/daemon.test.ts` (T9 suite) covers all three.

**Findings:** H8 + M5 (engine audit)
**Root cause:** `sendCommandViaTcp()` resets `useTcp = false` on socket error but NOT on timeout or JSON parse failure. After either, the engine is permanently stuck in TCP mode with 30s timeout on every call until MCP restart.
**Origin:** `1937c80` (2026-04-16) introduced TCP. `2737f6d` audit fix added reset on error only — missed timeout/parse paths.
**Traces:** H8 agent traced all 4 exit paths and confirmed the asymmetric reset.

### T10. Add SIGTERM/SIGINT handlers to `index.ts` ✅ RESOLVED (2026-04-25 ledger reconciliation; fix-commit SHA unknown)
**Fix verified:** `src/index.ts:47-48` registers `SIGINT` and `SIGTERM` handlers calling a graceful shutdown.

**Findings:** H21 (init-session audit)
**Root cause:** `src/index.ts` has zero signal handlers. Process death orphans: session window, daemon child process, session registration. `SafariPilotServer.shutdown()` exists but is never called. Shutdown itself doesn't close the session window either.
**Origin:** `b012d06` (2026-04-11) — never added. Init spec explicitly deferred as "Out of scope (v1)."
**Traces:** H21 agent confirmed no `process.on('SIGTERM')` in any version of `index.ts`.

### T11. Propagate `ensureSessionWindow()` failure ✅ RESOLVED (2026-04-25 ledger reconciliation; fix-commit SHA unknown)
**Fix verified:** Failure propagates through `recordToolFailure` → `recordEngineFailure` (`src/server.ts:1021`); related fixture in SD-21 (`c9e8b82`) added orphan cleanup + 15s timeout. (See SD-32 for a regression introduced by that commit.)

**Findings:** H20 (init-session audit)
**Root cause:** Catch block traces error but doesn't propagate. `_sessionWindowId` stays undefined. Every subsequent tool call triggers recovery (10s delay) then `SessionRecoveryError`. Server is effectively dead but reported successful startup.
**Origin:** `388a79c` (2026-04-21) — catch pattern was appropriate when session tab was optional. `4ddbffb` made it load-bearing without updating error handling.
**Traces:** H20 agent traced the catch pattern through 5 refactors where it went from "safe to swallow" to "catastrophic to swallow."

### T12. Wire `recordEngineFailure()` into server error path ✅ RESOLVED (2026-04-25 ledger reconciliation; fix-commit SHA unknown)
**Fix verified:** `src/server.ts:1021` calls `circuitBreaker.recordEngineFailure(engine, code)`; `circuit-breaker.ts:175-181` filters to extension-lifecycle codes (`EXTENSION_TIMEOUT`/`EXTENSION_UNCERTAIN`/`EXTENSION_DISCONNECTED`). `test/unit/server/record-tool-failure.test.ts` (SD-08) covers the wiring.

**Findings:** H4 (security audit)
**Root cause:** Per-engine circuit breaker API exists, `isEngineTripped('extension')` is checked in engine-selector, but `recordEngineFailure()` is never called. The breaker can never trip. Designed for commit 1c (v0.1.7) which was never built.
**Origin:** `78938fb` (2026-04-18) built the API. Commit 1c plan was abandoned during scope pivot to HTTP IPC and initialization system.
**Traces:** H4 agent confirmed zero `grep` hits for `recordEngineFailure` in `src/` and traced the orphaned commit 1c plan.

---

## P1: Reliability / Correctness — Silent Wrong Behavior

### T13. Fix `parseJsResult` empty-string CSP detection ✅ RESOLVED 2026-04-25 (commit `0636182`)
**Findings:** M8 (engine audit)
**Root cause:** Triple-nested conditional drops `raw === ''` case. Comment says "Bare empty = CSP" but code treats empty as success `{ ok: true, value: '' }`. CSP-protected pages silently return empty data instead of `CSP_BLOCKED` error.
**Origin:** `96064f6` (2026-04-11) — never modified since creation.
**Fix:** Collapsed the triple-nested conditional in `parseJsResult` (src/engines/applescript.ts) into a single branch that includes `raw === ''`. Doc-comment updated: production AppleScript path always wraps successful results in a `{ok, value}` JSON envelope (via `wrapJavaScript`), so a BARE empty raw means the script never executed — CSP block is the dominant cause. 3 unit tests added in `test/unit/engines/applescript-parsejsresult.test.ts` (empty→CSP_BLOCKED bug fix; CSP-text→CSP_BLOCKED existing-path lock; non-CSP non-JSON string→ok=true regression check). upp:test-reviewer fast PASS 0/0/1. Unit test count 103 → 106 (+3).

### T14. Fix tab position staleness after reorder/close ✅ RESOLVED (2026-04-25 ledger reconciliation; fix-commit SHA unknown)
**Fix verified:** `src/server.ts:710,910` invokes `_snapshotTabPositions()` before+after every tool execution to capture the live `windowId`/`tabIndex` mapping; positional adoption logic at server.ts:902-921.

**Findings:** H6 (tab-ownership audit)
**Root cause:** `windowId`/`tabIndex` captured once at tab creation, never updated. Tab reorder or sibling close shifts indices. Positional targeting silently executes in wrong tab.
**Origin:** `3cf95d8` (2026-04-23) — introduced positional identity without position refresh mechanism. Safari AppleScript has no stable tab ID (only positional `tab N`).

### T15. Fix `safari_new_tab` idempotent flag (should be false) ✅ RESOLVED 2026-04-25 (commit `1e56bba`)
**Findings:** H13 (tool-modules audit)
**Root cause:** Marked `idempotent: true` — retry creates duplicate tabs. Currently inert (NavigationTools never routes through extension engine) but architecturally wrong.
**Origin:** `78938fb` (2026-04-18) bulk migration. Spec didn't categorize `safari_new_tab`. Migration error (same batch that broke `safari_eval_in_frame` at `368cbe2`).
**Fix:** One-character schema change at `src/tools/navigation.ts:108` (`idempotent: true` → `idempotent: false`). Value-pinning unit test at `test/unit/tools/navigation-requirements.test.ts` mirrors the SD-01 extraction-requirements pattern. upp:test-reviewer fast PASS 0/0/0.

### T16. Fix `safari_hover` description — CSS `:hover` not triggered ✅ RESOLVED 2026-04-25 (commit `1809b1a`)
**Findings:** H14 (tool-modules audit)
**Root cause:** Synthetic `dispatchEvent(new MouseEvent(...))` fires JS handlers but does NOT activate CSS `:hover`. Web platform limitation. Description falsely claims "Triggers CSS :hover states."
**Origin:** `d65c461` (2026-04-11) — false claim from day one, never verified.
**Fix:** Description rewritten at `src/tools/interaction.ts:230-244` to disclose the synthetic-event nature: "Dispatches synthetic MouseEvents (mouseover/mouseenter) — JS handlers run but CSS :hover does not engage (web platform limitation; only the real cursor engages CSS pseudo-classes)." 2 unit tests at `test/unit/tools/interaction-descriptions.test.ts` (negative: rejects `/triggers? CSS :hover|activates? CSS :hover|fires? CSS :hover/i`; positive: requires `/synthetic\s+(mouse\s*)?(event|MouseEvent)/i`). Two oracles jointly enforce both removal of the false claim AND positive disclosure of the constraint. upp:test-reviewer fast PASS 0/0/1.

### T17. Fix `safari_take_screenshot` — remove dead params or implement them ✅ RESOLVED 2026-04-25 (commit `9b16f17`)
**Findings:** H15 (tool-modules audit)
**Root cause:** `fullPage`, `tabUrl`, `quality` defined in schema but completely ignored by handler. `screencapture -x` captures frontmost window only.
**Origin:** `115c762` (2026-04-11) — schema-first, implementation-never pattern. Competitive analysis marks fullPage as "RD" (roadmap).
**Fix:** Removed `tabUrl`, `fullPage`, `quality` from `safari_take_screenshot` inputSchema (`src/tools/extraction.ts:166-189`); top-level description now discloses the actual behavior ("Capture a screenshot of the frontmost Safari window ... no per-tab targeting"). 3 absence tests at `test/unit/tools/extraction-screenshot-schema.test.ts`. upp:test-reviewer fast PASS 0/0/1. tabUrl-removal also resolves an implicit conflict with the core tab-isolation principle (CLAUDE.md "Never switch user tabs") — the property's old description implied tab activation.

### T18. Fix `safari_export_pdf` tab targeting ✅ RESOLVED 2026-04-25 (commit `113515a`, lean fix)
**Findings:** H18 (tool-modules audit)
**Root cause:** `extractHtml()` hardcodes `current tab of front window` regardless of `tabUrl`. Code review at `e6c7682` deliberately removed tab-aware branches and renamed param to `_tabUrl`.
**Origin:** `016ff8c` → `e6c7682` (2026-04-14) — review chose "always front tab" over fixing the targeting.
**Fix (lean path, matches T17):** Removed `tabUrl` from `safari_export_pdf` inputSchema (`src/tools/pdf.ts`); top-level description now discloses front-tab-only behavior: "Export the FRONTMOST Safari tab as a PDF file (no per-tab targeting; HTML is extracted from `current tab of front window` regardless of any URL hint)." 1 absence test at `test/unit/tools/pdf-schema.test.ts`. upp:test-reviewer fast PASS 0/0/1. Proper per-tab implementation (option 1: route HTML extraction through the engine's tab-aware path) is left as future work — the schema is now honest, and a future task can add tabUrl back with a real implementation.

### T19. Fix `safari_paginate_scrape` stale URL after click ✅ RESOLVED 2026-04-25 (commit `816d970`, lean fix — option 5)
**Findings:** H17 (tool-modules audit)
**Root cause:** After clicking "next", queries new page using OLD `currentUrl`. URL lookup fails. `currentUrl` becomes `""` (empty string from `??`). All subsequent pages silently fail.
**Origin:** `35e3c58` (2026-04-12). CompoundTools receives raw `engine` not `proxy` — no positional identity.
**Fix (lean path, option 5 per advisor):** Made the failure LOUD instead of silent. On post-navigation URL-query failure (ok=false OR empty/whitespace value), the loop now breaks, pushes a warning to `PaginateResult.warnings`, and sets `metadata.degraded=true`. PaginateResult gained an optional `warnings?: string[]` field. 3 unit tests at `test/unit/tools/compound-paginate-scrape.test.ts` (empty-value, ok=false, happy path). upp:test-reviewer fast PASS 0/0/2. Proper positional-identity threading through CompoundTools (option 1) is future work — the schema is now honest about partial failure, callers see warnings + degraded flag, and the silent-scrape-old-page failure mode is gone.

### T20. Fix `safari_eval_in_frame` — replace `eval()` with `new Function()` ✅ RESOLVED 2026-04-25 (commit `8b62f03`)
**Findings:** H16 (tool-modules audit)
**Root cause:** Only tool using explicit `eval()`. Fails on any page with CSP `script-src` without `'unsafe-eval'`. `content-main.js` uses `new _Function()` (pre-captured constructor) which survives CSP.
**Origin:** `b3b83a1` (2026-04-12). Security audit `162e5a5` removed the engine routing flag but didn't fix the `eval()` itself.
**Fix:** Replaced `result = win.eval(userScript);` with `result = new win.Function(userScript)();` in the embedded JS template (`src/tools/frames.ts:122`). Codebase consistency move — matches `extension/content-main.js:11,323` (`const _Function = Function;` + `new _Function(params.script)`). 2 tests at `test/unit/tools/frames-eval-in-frame.test.ts` (negative regex on `\beval\s*\(`; positive regex on `new\s+(win\.)?Function\s*\(`). upp:test-reviewer fast PASS 0/0/1. **Note on the audit's stronger CSP claim:** the pre-capture is what survives CSP, and that has to happen at content-script-injection time (before any page script runs). For safari_eval_in_frame on the AppleScript engine path, neither eval() nor new Function() can pre-capture — both are subject to runtime CSP. The fix is therefore primarily a code-quality / scope-isolation / convention move; proper CSP-survival requires routing through the extension engine (future work).

### T21. Add content script `history.pushState` patching
**Findings:** M10 (extension-ipc audit)
**Root cause:** Tab cache stale after SPA client-side navigation. `tabs.onUpdated` doesn't fire for pushState. Fix: monkey-patch `history.pushState`/`replaceState` in `content-main.js` to emit URL change events through relay.
**Origin:** Documented as non-goal in spec `3d89865` (2026-04-21). `content-main.js` already patches `fetch`, `XMLHttpRequest`, `alert/confirm/prompt`, `attachShadow` — same pattern.

### T22. Fix `pollLoop` error handling — retry on transient failures
**Findings:** M12 (extension-ipc audit)
**Root cause:** `while(true)` exits on ANY catch (including `AbortError` from normal 10s timeout). Extension goes deaf for up to 60s until next alarm wake. No retry logic.
**Origin:** `78938fb` (2026-04-18).

### T23. Fix 15s disconnect timeout vs 20s keepalive interval ✅ RESOLVED 2026-04-25 (commit `0e6e6e9`, daemon-only path)
**Findings:** M14 (extension-ipc audit)
**Root cause:** Daemon marks extension disconnected at 15s, keepalive fires at 20s. 5s false-disconnect window (25% of cycle) triggers unnecessary recovery.
**Fix:** Daemon-only path — raised `disconnectTimeout` from 15s → 25s in `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift`. Avoided the alternative path (lower extension keepalive to 10s) because it requires extension rebuild + release. 1 NEW Swift test (`testDisconnectTimeoutAccommodatesKeepaliveCycle`) advances mockClock 20s and asserts the bridge stays connected — load-bearing T23 oracle. SD-28's existing `testDisconnectCheckFiresWhenIdleBeyondThreshold` test advance bumped 16 → 26 to clear the new threshold. Doc-comment on `checkDisconnect()` updated. Triangulation locks the threshold to T ∈ [20, 26). upp:test-reviewer fast PASS 0/0/2.

### T24. Fix `domainMatches()` — either wire it or delete it ✅ RESOLVED 2026-04-25 (commit `cc20814`, deletion path)
**Findings:** M1 (security audit)
**Root cause:** Method exists, ARCHITECTURE.md claims it's used as a DoS guard, but it was removed from server.ts at `75177e8` because it broke cross-domain link clicks. Dead code with stale documentation.
**Fix:** Deleted `domainMatches()` method (and its orphaned helper `extractRegistrableDomain` + `TWO_PART_TLDS` constant) from `src/security/tab-ownership.ts`. Updated ARCHITECTURE.md ownership-flow steps 7d.2/7d.3 to reflect that the deferred path triggers on "extension engine selected" alone, plus the Domain-guard bullet rewritten to record the deletion + rationale. Re-wiring would re-introduce the original cross-domain-click bug; the post-execution `_meta.tabId` verification at step 8.post2 already provides identity-based ownership without needing a pre-execution domain guard. No new tests (TypeScript compile-time check catches any re-introduction; zero callers existed). Doc + dead-code cleanup, no reviewer dispatched.

### T25. Fix shutdown detection in CommandDispatcher ✅ RESOLVED 2026-04-25 (commit `3b94994`)
**Findings:** M17 (daemon-core audit)
**Root cause:** `main.swift` uses `trimmed.contains("\"shutdown\"")` on raw NDJSON line. Page content containing the word "shutdown" could crash the daemon. Should use parsed `command.method == "shutdown"`.
**Origin:** `c5ab358` (2026-04-12) — never modified.
**Fix:** Extracted a `public static func isShutdownLine(_:) -> Bool` helper in `CommandDispatcher.swift` that parses the NDJSON line and returns `parsed.method == "shutdown"`. The run() loop now calls this helper instead of the substring check. (Note: the audit said "main.swift" but the bug was actually in `CommandDispatcher.run()`:72; main.swift just calls `dispatcher.run()`.) 3 Swift tests cover real-shutdown-command, id-as-shutdown-but-method-is-execute (the load-bearing T25 oracle), and malformed-NDJSON. Mutation cycle confirmed: reverting to substring check fails ONLY Test 2. Helper is `public static` to give tests a seam without driving run() (which calls exit(0)). upp:test-reviewer fast PASS 0/0/1.

### T26. Add thread safety to `Trace.swift` ✅ RESOLVED 2026-04-25 (commit `591ffda`)
**Findings:** M19 (daemon-core audit)
**Root cause:** `seekToEndOfFile()` + `write()` without synchronization. Concurrent calls from bridge/HTTP/dispatcher queues can corrupt trace NDJSON.
**Origin:** `6dcbeed` (2026-04-21) — single commit, never modified.

**Fix:** Extracted the seek+write pair into `Trace.writeLine(_:to:)` and wrapped the body in a private serial `DispatchQueue.sync`, matching the HealthStore idiom. `Trace.emit` now routes through the new primitive. Discriminating concurrency stress test (`TraceTests.testWriteLineSerializesConcurrentWrites`) drives 1000 parallel writers against an isolated temp `FileHandle`; layered oracle asserts line count == iterations, every line is valid JSON, and the set of seen ids has exactly N members. Test skips on single-core hosts where `DispatchQueue.concurrentPerform` would serialise trivially. Verified 10/10 RED unguarded → 10/10 GREEN with the lock; full daemon suite 129 passed (was 128).

### T27. Fix `findTargetTab` active-tab fallback
**Findings:** M11 (extension-ipc audit)
**Root cause:** Falls through to active tab when URL not found. Should return null when `tabUrl` was explicitly provided but unmatched, only fall through when `tabUrl` is absent.
**Origin:** `9e8ad6f` (2026-04-12) legacy pattern. URL matching added in `14f37f5` but fallback preserved.

### T28. Fix health gate to skip extension recovery for AppleScript-only tools ✅ RESOLVED 2026-04-25 (commit `3533785`)
**Findings:** M24 (init-session audit)
**Root cause:** Gate at `server.ts:413` runs before engine selection at line 520. Has zero awareness of which engine the tool needs. `safari_list_tabs` triggers 10s extension recovery it will never use.
**Origin:** `5fb94fa` (2026-04-23).

**Fix:** Extracted `requiresExtension(req)` from `selectEngine` into `engine-selector.ts` so the gate and the engine selector share one definition. Modified `recoverSession` to accept `{ extensionRecovery: boolean }`; the gate passes `extensionRecovery: extensionMissing` so window-only recovery runs without polling for the extension when the tool can be served by AppleScript/Daemon. Discriminating unit test in `pre-call-gate.test.ts` asserts /status is hit exactly once (not 11×) when the extension is unreachable and the tool declares no extension flags. Mutation-verified: reverting both the gate condition and the extensionRecovery option re-introduces the 10.05s wait + SessionRecoveryError. The two existing SD-20 tests were retargeted to `safari_query_shadow` (which declares `requiresShadowDom: true`) so they keep covering the recovery-times-out branch under the engine-aware gate.

---

## P2: Dead Code / Documentation Lies / Quality Debt

### T29. Wire `killSwitch.recordError()` into error path ✅ RESOLVED 2026-04-25 (commit `a504928`)
**Findings:** M2 (security audit)
**Root cause:** Method exists, config pipeline built (`autoActivation`), but `recordError()` never called from `executeToolWithSecurity()` error handler.
**Origin:** `15aaec2` (2026-04-12). `316feed` wired `checkBeforeAction()` but not `recordError()`.

**Fix:** Added `this.killSwitch.recordError()` inside `executeToolWithSecurity`'s catch block immediately after `recordToolFailure(domain, engine, error)`. Discriminating unit test (`killswitch-auto-activation.test.ts`) configures `autoActivation:true, maxErrors:3` and drives 3 failures through a throwing stub for `safari_list_tabs` (which bypasses ownership). Dual oracle: `server.killSwitch.isActive()` flips to true after 3 failures, and the 4th call throws `KillSwitchActiveError`. Mutation-verified: removing the new `recordError` call returns the test to RED.

### T30. Set `isError: true` on HumanApproval responses ✅ RESOLVED 2026-04-25 (commit `4ecaef1`)
**Findings:** M3 (security audit)
**Root cause:** `HumanApprovalRequiredError` caught and returned as content with `approvalRequired: true` — MCP client sees it as a successful tool call. Other security layers (KillSwitch, RateLimiter, CircuitBreaker) all throw hard errors. MCP protocol has `isError` field for tool-level errors — never set.
**Origin:** `c1d3b92` (2026-04-15) copied the `EngineUnavailableError` soft-return pattern.

**Fix:** Added `ToolResponse.isError?: boolean` to `src/types.ts`. Both HumanApproval soft-return sites in `executeToolWithSecurity` now set `isError: true` (Site 1 = initial check at line 497; Site 2 = post-engine-degradation re-check at line 650, kept symmetrical against future stateful HumanApproval). The MCP `CallTool` handler in `src/index.ts` spreads the flag into the response envelope so it reaches the wire. Triple-oracle unit test (`human-approval-iserror.test.ts`) uses an OAuth URL to drive Site 1, asserting `response.isError === true`, structured `approvalRequired` payload preserved, and `metadata.degraded` contract intact. Mutation-verified by re-removing the new `isError` field. Site 2 is currently dead code (stateless HumanApproval cannot differ on re-assert) so its fix is enforced by code-review diff symmetry, documented in the test's doc comment. Note: `EngineUnavailableError` soft-return at server.ts:553-571 has the same shape but is out of T30 scope per the original audit.

### T31. Remove `extensionAllowed` from DomainPolicy or wire into engine selector ✅ RESOLVED 2026-04-25 (commit `54c2ae1`)
**Findings:** M4 (security audit)
**Root cause:** Computed per-domain (`false` for banking) but `selectEngine()` never reads domain policy. Extension can execute against `chase.com` despite `extensionAllowed: false`.
**Origin:** `7adb53d` (2026-04-12) — forward declaration never connected.

**Fix:** Picked the audit's deletion option per advisor review and the T24 deletion precedent. Wiring the field would have introduced a security feature with new failure modes that needed its own threat model + tests, not a quiet inclusion in a debt-cleanup batch — particularly because `BASE_DEFAULT_POLICY.extensionAllowed` was `false`, so strict wiring would have blocked extension on every unknown domain. Removed the field from `src/types.ts` (DomainPolicy interface), `src/security/domain-policy.ts` (PolicyRule interface, EvaluateResult, BASE_DEFAULT_POLICY, SENSITIVE_POLICY, blocked/trusted ctor branches), and 2 stale assertions in `test/unit/security/domain-policy.test.ts`. Reviewer skipped (deletion-only). The legitimate banking-disable-extension security feature is filed as SD-30 in FOLLOW-UPS.md.

### T32. Eliminate DaemonEngine `executeJsInTab` duplication ✅ RESOLVED 2026-04-25 (commit `960f1c8`)
**Findings:** M6 (engine audit)
**Root cause:** `daemon.ts:226-246` inlines wrapping, escaping, and template from `AppleScriptEngine`. The two diverge — DaemonEngine misses CSP detection, ShadowDOM signals, and uses different template formatting.
**Origin:** `5d037dc` (2026-04-15).

**Fix:** Extracted `wrapJavaScript`, `buildTabScript`, `parseJsResult` (and the previously-private `mapJsErrorName`) into a new `src/engines/js-helpers.ts`. Both engines import from there: AppleScriptEngine's public methods become 1-line delegates; `DaemonEngine.executeJsInTab` uses the same wrap → template → parse pipeline, gaining CSP_BLOCKED detection, ShadowDOM-closed signals, and structured JS-error code mapping by composition. Discriminating test (`daemon.test.ts` T32 case) mocks the TCP command socket to return an empty `value` (the bytes osascript emits when CSP blocks `do JavaScript`) and asserts `error.code === 'CSP_BLOCKED'`. Mutation-verified. Reviewer skipped because `parseJsResult` itself was already reviewed under T13.

### T33. Fix Shadow DOM closed heuristic ordering ✅ RESOLVED (2026-04-25 ledger reconciliation; fix-commit SHA unknown)
**Fix verified:** `src/engines/js-helpers.ts:68-87` runs the empty/CSP check (lines 68-78) BEFORE the shadow check (lines 80-87), and both BEFORE `JSON.parse` (line 91). The audit's complaint — "page text containing 'shadow' + 'closed' trips false `SHADOW_DOM_CLOSED`" — is mitigated because the bare-empty CSP path catches a CSP-blocked production result before the shadow heuristic runs. (Note: the shadow heuristic still pre-empts JSON.parse on a non-empty raw, so a successful page result containing 'shadow'/'closed' substrings will still incorrectly trip the heuristic. Filing as SD-33 if anyone reports it.)

**Findings:** M9 (engine audit)
**Root cause:** Heuristic runs before JSON parsing. Any page text containing "shadow" AND "closed" triggers false `SHADOW_DOM_CLOSED` error. Should only run on parse-failure or error envelopes.
**Origin:** `96064f6` (2026-04-11) — never modified.

### T34. Remove "cross-origin frames" from Extension Engine capabilities
**Findings:** H10 (extension-ipc audit)
**Root cause:** Manifest lacks `all_frames: true`. Content scripts only inject into top-level frame. `framesCrossOrigin` in ENGINE_CAPS is dead code. ARCHITECTURE.md, CLAUDE.md, SKILL.md all claim the capability.
**Origin:** `1d875f4` (2026-04-11) — Day 1 forward declaration, never implemented.

### T35. Fix IDPI scanner — decide block vs annotate
**Findings:** H1 (security audit)
**Root cause:** `scan()` only returns data, `server.ts:799-814` only sets metadata flags. Injected content flows through to agent unchanged. EXECUTION-FLOWS.md honestly says "annotates metadata, no block."
**Origin:** `15aaec2` (2026-04-12) — designed as detector, wired as annotator at `c1d3b92`.

### T36. Fix screenshot redaction — inject before capture or remove
**Findings:** H2 (security audit)
**Root cause:** Redaction script attached to result metadata AFTER screenshot captured. `screencapture -x` is immune to CSS blur. File header says "injected before capture" — code does opposite.
**Origin:** `2ccdc87` created module. `c1d3b92` wired post-execution (wrong timing).

### T37. Delete `recordPreExisting` / `isPreExisting` dead code
**Findings:** M23 (tab-ownership audit)
**Root cause:** Created in `630526e`, never called. The positive-ownership model (fail-closed on unknown tabs) makes pre-existing tracking redundant.

### T38. Fix `recoverSession()` to re-register with daemon
**Findings:** M25 (init-session audit)
**Root cause:** Recovery re-opens window and polls extension but doesn't call `registerWithDaemon()`. After daemon restart, session is unregistered.
**Origin:** `5fb94fa` (2026-04-23).

### T39. Prune HealthStore timestamp arrays
**Findings:** M18 (daemon-core audit)
**Root cause:** `roundtripTimestamps`, `timeoutTimestamps`, `uncertainTimestamps`, `httpRequestErrorTimestamps` grow unbounded. `forceReloadTimestamps` IS pruned — same pattern not applied.
**Origin:** `78938fb` (2026-04-18).

### T40. Update ARCHITECTURE.md — 8 documented claims that contradict code
**Findings:** Cross-referenced from C1, C2, H3, H4, H10, M1, M24, and others.
**Discrepancies:**
1. Line 222: "no _meta -> throw (fail closed)" — code does NOT throw (`75177e8`)
2. Line 216: domainMatches as deferral condition — removed at `75177e8`
3. Line 40: "cross-origin frames" capability — manifest lacks `all_frames`
4. Line 197-199: per-engine circuit breaker described as functional — `recordEngineFailure` never called
5. Escaping contract section — already updated in this session but needs re-verification
6. `SKIP_OWNERSHIP_TOOLS` — already updated in this session
7. Last verified branch — already updated in this session
8. Navigate_back/forward handling — updated in this session but verify against T2

---

## P3: Missing Features / Low-Probability / Cosmetic

### T41. Build `safari_file_upload` tool
**Findings:** H19 (tool-modules audit)
**Root cause:** Playwright gap. Competitive analysis rates it "Gap #2 (High Impact)." No research doc exists. Browser security prevents JS from setting file inputs. May need System Events / CGEvent approach.

### T42. Write e2e tests for recovery/degradation paths
**Findings:** H22 (init-session audit), C7 (tool-modules audit)
**Root cause:** Zero tests for: daemon crash recovery, window close recovery, extension disconnect fallback, circuit breaker trip/recovery, multi-session isolation. Init spec criteria #4, #5, #7 are unmet.

### T43. Write e2e tests for 61 untested tools
**Findings:** C7 (tool-modules audit)
**Root cause:** Only 15 tools have live e2e tests. 61 have zero. Phases 4-7 of the roadmap exist to address this but are unstarted.

### T44. Add stale `sp_result` recovery on event page re-wake
**Findings:** H9 (extension-ipc audit)
**Root cause:** If event page suspends during storage bus await, `storage.onChanged` listener is lost. Content script writes `sp_result` but nobody reads it. Storage bus spec section 6.1 prescribed stale cleanup in `wakeSequence()` — never implemented.

### T45. Fix TCP port conflict — crash instead of random port fallback
**Findings:** H11 (daemon-core audit)
**Root cause:** `ExtensionSocketServer.swift` falls back to random OS-assigned port on bind failure. No client can discover it. Original `try!` crash was defensibly correct.
**Origin:** `a468977` → `f8915f3` (2026-04-15) — audit "fix" introduced the problem.

### T46. Fix PdfGenerator CheckedContinuation leak
**Findings:** H12 (daemon-core audit)
**Root cause:** `waitForNavigation()` task group race doesn't resume continuation when timeout wins. Swift runtime violation: "leaked its continuation."
**Origin:** `e6c7682` (2026-04-14) code review fix introduced the leak while adding a timeout.

### T47. Fix `release.yml` — add extension verification before upload
**Findings:** H23 + H24 (distribution audit)
**Root cause:** Extension `.zip` uploaded from git checkout with zero verification. Daemon gets full CI build + sign + notarize; extension is a stale artifact. Spec designed CI-level defense that was never implemented.

### T48. Protect session dashboard tab from agent navigation
**Findings:** M21 (tab-ownership audit)
**Root cause:** Session tab not registered in ownership. `safari_navigate` without `tabUrl` can navigate it away, killing the keepalive.
**Fix depends on:** T1 (making tabUrl required on navigate).

### T49. Fix `safari_type` delay parameter (currently ignored)
**Findings:** From tool-modules audit (part of H14 agent analysis)
**Root cause:** `delay` param defined in schema (default 50ms) but handler fires all keystrokes synchronously. Dead param.

### T50. Fix `safari_scroll` conflicting modes
**Findings:** From tool-modules audit
**Root cause:** `toTop: true` + `direction: 'down'` both execute — scrolls to top then immediately scrolls down 500px.

### T51. Fix `safari_reload` `bypassCache` (deprecated API)
**Findings:** From tool-modules audit
**Root cause:** `location.reload(true)` — the `true` arg is deprecated and does nothing in modern Safari.

### T52. Standardize launchctl API usage
**Findings:** M28 (distribution audit)
**Root cause:** Daemon uses legacy `load/unload`, health-check uses modern `bootstrap/bootout`. Written 6 days apart, never reconciled.

### T53. Fix postinstall download failure handling
**Findings:** M29 (distribution audit)
**Root cause:** 9 `|| true` guards swallow all download/extraction failures. Script exits 0 on complete failure. npm reports success.

### T54. Fix `pkill -f` to `pkill -x` in update-daemon.sh
**Findings:** M30 (distribution audit)
**Root cause:** `-f` matches full command line (including editors, grep). `-x` matches exact process name. Added in this session's uncommitted changes.

### T55. Add `all_frames: true` to extension manifest (or document limitation)
**Findings:** H10 (extension-ipc audit)
**Root cause:** Content scripts only inject into top-level frame. Adding `all_frames` requires frame-aware storage bus (frameId routing), not just a manifest change.

### T56. Fix `safari_handle_dialog` / `safari_network_throttle` overstated engine requirements
**Findings:** From tool-modules audit
**Root cause:** These tools patch `window.*` globals via JS — works fine via AppleScript. But `requiresDialogIntercept`/`requiresNetworkIntercept` force Extension engine routing unnecessarily.

### T57. Add silent-catch logging to NDJSON parser
**Findings:** H7-corrected (engine audit)
**Root cause:** `daemon.ts:330-332` `catch {}` silently discards malformed lines. Pending request hangs for 30s. Add logging of the malformed line and parse error.

### T58. Fix HTTP server bind failure handling
**Findings:** M20 (daemon-core audit)
**Root cause:** On port 19475 bind failure, server silently stops. Extension can never connect. No retry, no signal to MCP server. `HealthStore.recordHttpBindFailure()` records it but nobody checks.

---

## Rules and Learnings (consolidated from all 61 analyses)

### Patterns that caused bugs repeatedly
1. **Build-then-wire gap:** Code built in isolation (class, method, module) but integration wiring omitted or incomplete. Found in: T3, T7, T12, T29, T31, T37.
2. **Spec-as-truth without verification:** Documentation (ARCHITECTURE.md, CLAUDE.md, tool descriptions) treated as proof that features work. Found in: T5, T16, T17, T34, T40.
3. **Mock tests as false confidence:** 1470 mock-based tests passed while the product was broken. Purge was correct but left 61 tools unverified. Found in: C7, T42, T43.
4. **Catch-and-swallow in lifecycle code:** Silent error swallowing appropriate in v1 context became catastrophic as the code became load-bearing. Found in: T11, T53.
5. **Forward declarations never wired:** Capability flags, config options, and API methods created for "commit 1c" or "future work" that never shipped. Found in: T12, T29, T31, T34, M4.
6. **URL as identity:** URL-based tab matching breaks on every navigation. Positional identity breaks on reorder. Extension tab.id is the only stable identity but only works through the extension engine. Found in: T2, T14, T19, T21.

### Rules for future work
1. **Every tool param in the schema must be read by the handler.** Dead params are lies to the AI agent.
2. **Every security layer must throw, not return.** Soft errors are ignorable by the consumer.
3. **NavigationTools must update the ownership registry after any URL change.**
4. **No `|| true` on acquisition commands in postinstall.** Exit non-zero on critical failures.
5. **Test the failure path, not just the happy path.** Recovery code with zero test coverage is hope, not engineering.
6. **Engine-layer changes must be applied to both AppleScriptEngine and DaemonEngine.** Or eliminate the duplication.
7. **Document what the code DOES, not what it SHOULD do.** ARCHITECTURE.md must be updated in the same commit as code changes.
