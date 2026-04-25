# Pending systematic-debugging follow-ups

Running list of findings surfaced by reviewers (Codex, `upp:test-reviewer`, advisors) that were NOT yet run through `upp:systematic-debugging`. Each entry is a target for a future disciplined root-cause → minimal-fix → discriminating-test cycle. Items land here so they don't disappear between sessions.

**Triage rule:** do not "just fix" entries here. Pick one, run Phase 1 (root-cause investigation) from `upp:systematic-debugging` before writing any code, and produce the entry's discriminating test. Then move the entry to the "Resolved" section with the commit SHA.

---

## Open

### SD-13 — ExtensionHTTPServer: 4 of 8 routes + disconnect timeout + onBindFailure untested
- **Severity:** P1 (the routes flagged as "added for the initialization system" are the untested ones)
- **Source:** `upp:test-reviewer` retro review #2 (2026-04-24)
- **Symptom:**
  - Untested routes: `GET /status`, `GET /session`, `GET /health`, `POST /session/register`. Covered: `/connect`, `/poll`, `/result`, `OPTIONS` (CORS), `onReady`.
  - Untested 15s disconnect-detection background task (SUT lines 85-91, 467-474) — idle-for-15s → `bridge.isExtensionConnected` must flip false.
  - Untested `onBindFailure` hook — if a second process is already bound to 19475, `onBindFailure` fires and increments `health.httpBindFailureCount`. No test exercises this.
  - 400/500-path gaps: malformed JSON on `/connect` or `/result`, missing `requestId` on `/result`, `session/register` without `sessionId`, serialization-failure fallback (`recordHttpRequestError`).
- **Current understanding (from review):** one test per untested route asserting status + response shape + SUT-side effect. One long-idle test for the disconnect timeout. One "start two servers on the same port" test for `onBindFailure`. Four 400/500-path tests, each asserting on status code and the HealthStore error counter.
- **Discriminator:** revert any route's SUT branch — corresponding test must fail.
- **Entry points / files:**
  - `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` (all listed line ranges)
  - `daemon/Tests/SafariPilotdTests/ExtensionHTTPServerTests.swift` — extend

### SD-14 — ExtensionBridge tests are UNWIRED: direct method calls bypass CommandDispatcher routing
- **Severity:** P1 (Check 6 Production Call-Site — tests exist, but not through the production boundary)
- **Source:** `upp:test-reviewer` retro review #2 (2026-04-24)
- **Symptom:** Most `ExtensionBridgeTests.swift` tests call `bridge.handleExecute()` / `handleResult()` / `handleReconcile()` / `handleConnected()` / `handleDisconnected()` directly on an in-test `ExtensionBridge()`. In production, each reaches the bridge via `CommandDispatcher.handle(command:)` NDJSON routing or `ExtensionHTTPServer` routing. Four dispatcher-level tests exist (covering `extension_connected`, `extension_status`, `extension_poll`, `extension_reconcile`, `extension_log alarm_fire`, `extension_health`). The production paths for `extension_result` and `extension_execute` via the dispatcher are NOT covered — if someone deleted the `case "extension_result":` branch in `CommandDispatcher.swift:145`, no Swift test would fail.
- **Current understanding (from review):** add one dispatcher-level test for `extension_result` and one for `extension_execute` that drive `dispatcher.dispatch(line: ...)` and assert the bridge state change.
- **Discriminator:** delete `case "extension_result":` — new dispatcher-level test must fail; restore → passes.
- **Entry points / files:**
  - `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` (line 145 and nearby cases)
  - `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` — add dispatcher-level tests

### SD-15 — Lifecycle gap (Check 9): canary distribution + bridge full-journey
- **Severity:** P2 (state-machine coverage, matches SD-05 for TypeScript e2e)
- **Source:** `upp:test-reviewer` retro review #2 (2026-04-24)
- **Symptom:** Two lifecycle gaps:
  - **Canary**: T3 covers uninstall-config-shape; T4 covers release-YAML-text. No test walks `npm pack` → sandboxed install → uninstall → verify-no-LaunchAgent-remains, nor install-tarball-and-run-binary.
  - **ExtensionBridge**: individual ops (connect, execute, poll, result, reconcile, disconnect) and pairwise wake sequences are tested. No test walks the full real-world sequence daemon-start → extension-connect → queue-N-commands → extension-disconnect (event page wake) → reconcile → redeliver → get-results → teardown.
- **Current understanding (from review):** one integration-style canary test per lifecycle (pack → extract → assert); one long-form bridge test driving all six ops in sequence with correct classification at each hop.
- **Discriminator:** for the bridge journey, break the wake-semantics code at any hop — the full-journey test must fail at THAT hop, not later; restore → full journey passes.
- **Entry points / files:**
  - `test/canary/` — new integration-style lifecycle test
  - `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` — new full-journey test

### SD-16 — CommandDispatcher: `watch_download` + `generate_pdf` subtrees + 8 error branches untested
- **Severity:** P2 (distribution-shipped code paths with zero test coverage)
- **Source:** `upp:test-reviewer` retro review #2 (2026-04-24)
- **Symptom:** `CommandDispatcher.swift` has ~12 error branches (INVALID_PARAMS, PARSE_ERROR, UNKNOWN_METHOD, UNKNOWN_INTERNAL_METHOD, DOWNLOAD_DIR_NOT_FOUND, DOWNLOAD_INIT_ERROR, FSEVENTS_UNAVAILABLE, DOWNLOAD_TIMEOUT, DOWNLOAD_CANCELLED, DOWNLOAD_ERROR, PDF-family errors, SERIALIZATION_ERROR). Tests cover 4: PARSE_ERROR, UNKNOWN_METHOD, INVALID_PARAMS (missing script), SAFARI_NOT_RUNNING mapping. **`watch_download` and `generate_pdf` entire code paths have zero coverage.**
- **Current understanding (from review):** at minimum smoke-test `watch_download` with an obviously-missing directory (`DOWNLOAD_DIR_NOT_FOUND`) and `generate_pdf` with an invalid output path (`INVALID_OUTPUT_PATH`). Full error-parity can be progressive.
- **Discriminator:** delete either handler entirely — new smoke test must fail with a dispatcher-level routing error.
- **Entry points / files:**
  - `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift`
  - `daemon/Tests/SafariPilotdTests/CommandDispatcherTests.swift`

### SD-17 — Swift test infrastructure brittleness
- **Severity:** P3 (cosmetic / foot-guns, low-impact until they aren't)
- **Source:** `upp:test-reviewer` retro review #2 (2026-04-24)
- **Symptom:** Three patterns:
  - `ExtensionHTTPServerTests.swift:258-268` uses `Mirror(reflecting:)` to read private `port`. Rename to `_port` or `serverPort` → Mirror silently returns 0 → test connects to `http://127.0.0.1:0` → confusing network failures.
  - `ExtensionBridge.swift:60-64` exposes `addToExecutedLogForTest(commandID:at:)` as a production-surface method for back-dated timestamp insertion. Test knowledge bleeds into prod; production code could call this.
  - `ExtensionBridgeTests.swift` + `ExtensionHTTPServerTests.swift` have ~20 `Thread.sleep(0.1) + poll` patterns. Under slow CI these will flake.
- **Current understanding (from review):**
  - Expose `ExtensionHTTPServer.port` publicly (or a `boundPort` getter); drop the Mirror hack.
  - Introduce a `Clock` protocol (default `SystemClock`), inject into `ExtensionBridge`; delete `addToExecutedLogForTest`. Alternative: `@testable import SafariPilotdCore` + `internal` visibility on `executedLog`.
  - Replace sleep-polls with a `waitUntil(predicate:timeout:)` helper.
- **Discriminator:** rename the private `port` field to `_port` — current Mirror-based tests silently pass with port 0 (flaky network failures); getter-based tests fail compilation cleanly.
- **Entry points / files:**
  - `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift`
  - `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`
  - `daemon/Tests/SafariPilotdTests/*.swift` — sleep-poll replacement

### SD-18 — Doc correction: "Swift tests are real, not mocked" is literally false
- **Severity:** P3 (doc/reality mismatch; tests are fine — docs overclaim)
- **Source:** `upp:test-reviewer` retro review #2 (2026-04-24)
- **Symptom:** `CLAUDE.md` and `ARCHITECTURE.md` claim "Daemon Tests (daemon/Tests/) — 51 tests, real Swift tests, not mocked — kept from before the purge." Reality: `MockExecutor`, `StubExecutor`, `SequencedMockExecutor` all exist in the test files. These are LEGITIMATE I/O-isolation mocks at the NSAppleScript → Safari boundary (they substitute external dependencies, not the SUT), so per the skill rubric they're acceptable. But the wording is wrong and gives a false sense of "pure behavioral coverage."
- **Current understanding (from review):** amend docs to "real Swift tests against real types, with I/O-isolation mocks at the NSAppleScript boundary."
- **Discriminator:** N/A (documentation change).
- **Entry points / files:**
  - `CLAUDE.md` (§E2E means E2E and related)
  - `ARCHITECTURE.md` (§Test Architecture, Daemon Tests section)

### SD-19 — Shape-only / self-fulfilling assertions in Swift tests (batch)
- **Severity:** P2 (three identified; each is a one-line strengthening)
- **Source:** `upp:test-reviewer` retro review #2 (2026-04-24)
- **Symptom:** Three weak assertions:
  - `CommandDispatcherTests.swift:91-109` (`testExecuteRouting`): mock configured with `.success(value: "script_result")`, test asserts the same value came back. Self-fulfilling. The `mock.lastScript == script` check is real, keep that; drop the return-value check or replace with a transformation assertion (`response.elapsedMs != nil` or NDJSON round-trip).
  - `ExtensionHTTPServerTests.swift:108-144` (`testHTTPConnectCallsReconcile`): asserts 5 reconcile keys are `!= nil` — any empty-array response passes. Pre-queue a command + pre-populate executed log, then assert `json["acked"] == ["known"]`, `json["reQueued"].contains("queued")`.
  - `ExtensionHTTPServerTests.swift:209-235` (`testHTTPServerCallsOnReadyAfterStart`): asserts `onReady` fired; doesn't assert the paired `onBindFailure` hook. Covered by SD-13's onBindFailure test.
- **Current understanding (from review):** same class of bug as SD-07 for TypeScript — batch fix as one commit.
- **Discriminator:** for each test, wire a stub SUT that satisfies the current weak assertion → test passes today, must fail post-strengthening.
- **Entry points / files:**
  - `daemon/Tests/SafariPilotdTests/CommandDispatcherTests.swift`
  - `daemon/Tests/SafariPilotdTests/ExtensionHTTPServerTests.swift`

### SD-23 — HealthStore needs an injectable clock for prune-cutoff testing
- **Severity:** P3 (test infra brittleness; doesn't affect production behaviour)
- **Source:** Filed during SD-11 work (2026-04-25). `upp:test-reviewer` confirmed the gap.
- **Symptom:** `HealthStore.pruneStaleSessionsLocked()` uses a hardcoded `Date(timeIntervalSinceNow: -60)` cutoff with no parameter. To test the cutoff transition cleanly (e.g. SD-11's discriminator: "raise cutoff to -600s → session-prune test must fail") requires either sleeping >60s in the test (too slow) or injecting a clock. The current SD-11 suite covers structural deduplication and `lastSeen` advancement but does NOT directly catch a regression that CHANGES the prune-cutoff value.
- **Current understanding (not verified):** introduce an injectable `now: () -> Date` closure (or a `Clock` protocol with `SystemClock` default) into `HealthStore`. Production passes `Date.init`; tests pass a controllable mock that returns whatever the test wants. Then a test can register a session, advance the mock clock by 90s, call `activeSessionCount`, and assert the session was pruned.
- **Discriminator for the fix:** with the clock injection in place, write a test that registers, advances the mock clock by 90s, and asserts `activeSessionCount === 0`. Mutating the cutoff to `-600` makes the test fail (session not yet stale at 90s of mock time when cutoff is -600); reverting to `-60` passes. SD-11's `pruneStaleSessionsLocked` test gap is closed.
- **Entry points / files:**
  - `daemon/Sources/SafariPilotdCore/HealthStore.swift` (lines 164-167 prune; constructor + Date sites)
  - `daemon/Tests/SafariPilotdTests/HealthStoreTests.swift` — add prune-transition test

### SD-22 — 4 ERROR_CODES values declared but unused (no concrete class, no throw sites)
- **Severity:** P3 (dead declaration; cosmetic but asymmetric with the other 17 codes)
- **Source:** Filed during SD-06 work (2026-04-25). grep-zero verified across `src/`, `daemon/Sources/`, `extension/`.
- **Symptom:** `src/errors.ts` ERROR_CODES object declares `ELEMENT_NOT_INTERACTABLE`, `CROSS_ORIGIN_FRAME`, `DIALOG_UNEXPECTED`, `FRAME_NOT_FOUND` as members of the const object — but no concrete `SafariPilotError` subclass uses them, and no code anywhere references the strings. They are pure dead declarations that implicitly promise error-class semantics the codebase does not actually offer.
- **Current understanding (not verified):** two viable paths:
  - **(a) Delete them.** Simplest; removes the dead declaration.
  - **(b) Add concrete classes** for each (ElementNotInteractableError, CrossOriginFrameError, DialogUnexpectedError, FrameNotFoundError) and wire up the throw sites that SHOULD be using them — e.g. `safari_click` actionability checks for ELEMENT_NOT_INTERACTABLE, `safari_eval_in_frame` / `safari_list_frames` for FRAME_NOT_FOUND, dialog-unexpected for safari_handle_dialog race conditions.
- **Discriminator for the fix:**
  - Path (a): grep shows zero references to any of the 4 codes after deletion; tool handlers that would have thrown a specific code throw a plain Error or a different existing code instead.
  - Path (b): a new unit test per new class + at least one integration/e2e test that asserts the throw-site uses the new class (e.g. safari_eval_in_frame with a non-matching frameSelector throws FrameNotFoundError).
- **Entry points / files:**
  - `src/errors.ts` (ERROR_CODES + no-class codes)
  - `src/tools/interaction.ts` (safari_click's actionability check — likely home for ElementNotInteractableError)
  - `src/tools/frames.ts` (FrameNotFoundError throw sites)
  - `src/tools/interaction.ts` (DialogUnexpectedError — safari_handle_dialog)

### SD-21 — `ensureSessionWindow` 5s execSync timeout fragile under Safari load
- **Severity:** P2 (intermittent flake; not blocking but actively pollutes the e2e feedback loop and forces manual leaked-window cleanup + retry)
- **Source:** Filed 2026-04-25 during SD-03 sprint. Repeated occurrences: T11/T12 e2e runs (CHECKPOINT.md), this session's SD-03 first phase3 run (10/14 timeouts), this session's first `npm run test:all` (9/36 phase2 timeouts). Previously deferred in CHECKPOINT.md ("file as SD-NN if it keeps flaring") — repeat now confirmed.
- **Symptom:** `SafariPilotServer.ensureSessionWindow` (`src/server.ts:1166-1196`) runs `osascript -e 'tell application "Safari" to make new document …'` via `execSync` with `timeout: 5000`. When Safari is under load (multiple windows open, leaked "Safari Pilot — Active Session" windows from prior crashes, recent extension activity), `make new document` exceeds 5s. Result: `SessionWindowInitError(reason: 'execFailed')` propagates → tool calls fail → all subsequent tests in the run cascade-fail with response timeouts. Manual recovery: `osascript` close-by-name on leaked session windows, wait, retry. `checkWindowExists` (`src/server.ts:1090-1102`) shares the same 2s timeout pattern and is also affected.
- **Current understanding (not verified):** The 5s budget is tight for AppleScript's actual cold-path latency on a moderately-loaded Safari instance. Three options:
  - **(a) Raise the timeout.** Bump to 15-20s. Trivial; legitimate hangs surface 3-4× slower.
  - **(b) Auto-cleanup at init.** Before calling `make new document`, scan and close any orphaned "Safari Pilot — Active Session" windows that aren't `_sessionWindowId`. T10's SIGTERM handler already does this for clean exits — repeat the logic at startup for crash-recovery.
  - **(c) Replace `execSync` + AppleScript** with a daemon-side or extension-side new-window primitive. Larger surgery.
- **Discriminator for the fix:**
  - For (a): parametrize the timeout, write a unit test injecting a slow `execSync` mock (returns at, e.g., 4900ms) and assert success within the raised budget; revert default to 5s → test fails.
  - For (b): write an e2e test that pre-creates two "Safari Pilot — Active Session" windows via osascript, then spawns `dist/index.js`, asserts `ensureSessionWindow` succeeds AND that the orphans were closed. Revert auto-cleanup → orphans remain → init either succeeds with 3 windows or times out.
- **Entry points / files:**
  - `src/server.ts:1166-1196` (ensureSessionWindow), `src/server.ts:1090-1102` (checkWindowExists), `src/server.ts:1287-1310` (close on shutdown — T10 reference for option (b))
  - `test/unit/server/ensure-session-window.test.ts` — extend with timeout scenario for option (a)
  - New e2e test for option (b)

### SD-20 — Pre-call gate negative-path test (split off from SD-03 Phase 1)
- **Severity:** P2 (not blocking — the gate's healthy path is implicitly tested by every successful tool call; only the failure-mode + recovery branches lack direct coverage)
- **Source:** SD-03 Phase 1 systematic-debugging investigation (2026-04-25). Filed when Phase 1 concluded the SD-03-Test-1 oracle could not be made discriminating from happy-path e2e without manufactured SUT changes.
- **Symptom:** The pre-call gate at `server.ts:413-432` runs `checkExtensionStatus()` + `checkWindowExists()` before every tool call and either invokes `recoverSession` (10s budget, emits `recovery_start/success/failed` trace events) or throws `SessionRecoveryError`. Its healthy path emits no observable signal, and its failure modes cannot be triggered cleanly from an e2e harness:
  - `checkWindowExists` uses `exists window id N`, which Safari leaves permanently `true` after `close window id N` (ghost-window quirk per CHECKPOINT.md / TRACES Iter 22). Closing a session window from the test does not flip the gate.
  - Killing the daemon process would tear down `getSharedClient()`'s MCP server, breaking every other test in the run.
  - Disabling extension connectivity from Safari requires user-visible interaction and violates the "never switch user tabs" rule.
- **Consequence:** the previously-named "pre-call gate detects and reports system status" test at `initialization.test.ts:82-87` was deleted in SD-03 (its oracle was tautological and unrepairable from this side of the boundary). Coverage for the gate's recovery and `SessionRecoveryError` branches is currently zero.
- **Current understanding (from review, not verified):** two viable paths, pick one:
  - (a) **Unit-level**: spec out a unit test against `SafariPilotServer.executeToolWithSecurity` with `checkExtensionStatus` / `checkWindowExists` substituted via the boundary-mock pattern (see `test/unit/server/ensure-session-window.test.ts` for `vi.mock('node:child_process', importOriginal)` precedent). Assert that a returning-false probe triggers `recoverSession`, and that exhausted recovery throws `SessionRecoveryError` with the right code.
  - (b) **Own-spawn e2e**: a test in `initialization.test.ts` that owns its own `initClient('dist/index.js')` (precedent at lines 15-28), then *changes the gate's window-check to use `visible of window id`* (one-line SUT change, useful regardless), closes its own session window, calls a tool, and asserts the recovery trace events fire OR `SessionRecoveryError` propagates.
- **Discriminator for the fix:** revert `recoverSession` to a no-op or comment out the gate's `if (!preStatus.ext || !windowOk)` branch — the new test must fail because either no recovery runs or no `SessionRecoveryError` is thrown when the system is broken. Restoring the gate must pass.
- **Entry points / files:**
  - `src/server.ts:413-432` (gate body), `1077-1085` (checkExtensionStatus), `1090-1102` (checkWindowExists), `1108-1136` (recoverSession)
  - `test/unit/server/` (new file for option a) OR `test/e2e/initialization.test.ts` (new own-spawn test for option b)

---

## Resolved

### SD-12 — ExtensionBridge `__keepalive__` / `__trace__` / `_meta` sentinels untested (2026-04-25, commit `79ee209`)

Resolved by adding 9 tests in `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` covering all three handleResult sentinels:

- `__keepalive__` (lines 266-274): two tests — both side effects in one test (recordKeepalivePing + handleConnected); one early-return safety test using a contrived `"__keepalive__"` pendingCommand collision (asserts `isInExecutedLog` is false post-keepalive, locking the early `return Response.success(...)` at line 273).
- `__trace__` (lines 277-292): four tests — happy path (alarm_fire advances `lastAlarmFireTimestamp`); negative form for the `event == "alarm_fire"` guard (non-alarm event leaves the timestamp untouched); reviewer MAJOR follow-up for malformed payload with no `result` field; locked the `type=="trace"` field guard (wrong-type event is ignored).
- `_meta` wrapper (lines 353-367): three tests — wrapped form preserves both inner value and `_meta` dict; backward-compat path returns the bare inner value when `_meta` is absent; reviewer ADVISORY follow-up locking the `?? NSNull()` fallback at line 357 for void script results (`{ok:true}` with no `value` key).

Each test names its discrimination target inline as a comment: removing the targeted SUT branch fails the test loudly. T2 documents the leaked-Task contract: handleExecute's internal 90s timeoutTask resumes the continuation; the bridge is local to the test, no cross-test state leakage.

`upp:test-reviewer` (full mode, 9 checks) verdict: **PASS** (CRITICAL: 0, MAJOR: 1 — malformed `__trace__` payload uncovered, addressed in same commit; ADVISORY: 3 — comment-wording on T2 tightened per reviewer; null-fallback test added per reviewer's optional follow-up; NSNumber-vs-Int round-trip explicitly noted as out-of-scope for bridge tests, belongs at the dispatcher boundary).

Total tests: 97 unit (TS) + 20 canary + 41 e2e + 97 Swift = 255 (Swift was 88 pre-SD-12; +9).

### SD-11 — HealthStore recent-iteration API (session/MCP/keepalive) has zero tests (2026-04-25, commit `aff0705`)

Resolved by adding 14 tests in `daemon/Tests/SafariPilotdTests/HealthStoreTests.swift` covering all 14 untested methods/properties (registerSession, touchSession, activeSessionCount, recordKeepalivePing, lastKeepalivePing, isSessionAlive, recordTcpCommand, checkMcpConnection, mcpConnected, setMcpConnected, markExecutedResult, lastExecutedResultTimestamp, recordSessionServed, sessionTabActive). Used the negative-timeout trick for `isSessionAlive(timeout:)` and `checkMcpConnection(timeout:)` to test stale-vs-fresh transitions without time injection.

Added `HealthStore.lastSeenForSession(_:)` read-only accessor (per `upp:test-reviewer`'s exact recommendation) so tests can verify the deduplication-AND-update contract on duplicate `registerSession` and the existing-session lastSeen update via `touchSession`.

`upp:test-reviewer` (full mode, 9 checks) initial verdict was **REVISE** flagging the deduplication test as non-discriminating (count-only). Addressed in this commit per reviewer's exact fix recipe (add accessor + assert lastSeen advances). Plus 2 ADVISORY-level strengthenings: explicit `setMcpConnected(true)` precondition in the fresh-mcp test; timestamp slack bumped 0.01 → 0.5 for CI thermal robustness.

Documented limitation: `pruneStaleSessionsLocked` uses a hardcoded -60s cutoff — testing the prune-transition cleanly requires clock injection (out of scope here). Filed as **SD-23** above.

Total tests: 97 unit (TS) + 20 canary + 41 e2e + 88 Swift = 246 (Swift was 74 pre-SD-11; +14).

### SD-10 — Canary T3/T4 are UNVERIFIED CLAIM: shape-only, not behavior (2026-04-25, commit `33a348f`)

Resolved by strengthening both canaries with structural negative-form regexes catching specific lobotomization patterns. `preuninstall.test.ts` now has 7 tests (was 4) including bash -n parse, all-non-comment-launchctl assertion (filter-not-find for partial-lobotomy resilience), rm -f LaunchAgents assertion, and `set -e` preservation. `release-universal-binary.test.ts` now has 5 tests (was 3) including stub-pattern rejection (`|| true`, `if: false`, `if: ${{ false }}`, `echo "..."`) and same-job assertion for cp + npm publish steps.

Headers reworded per reviewer to honestly declare scope ("static-config canary — does NOT verify runtime behavior") with explicit pointer to SD-15 as the strong-form behavioral test.

`upp:test-reviewer` (full mode, 9 checks) verdict: **PASS** (CRITICAL: 0, MAJOR: 1 same-line regex coupling — accepted with deferral comment to SD-15; ADVISORY: 4 — 3 of 4 addressed: filter-not-find, rm-f assertion, ${{ false }} form caught; 4th (naming) is cosmetic).

Total tests: 97 unit + 20 canary + 41 e2e = 158.

### SD-09 — Private-state peek pattern in unit tests (2026-04-25, commit `fdba5f0`)

Resolved by adding read-only getters to the SUTs (`SafariPilotServer.getSessionWindowId()` for `_sessionWindowId`; `DaemonEngine.isTcpMode()` for `useTcp`) and refactoring the 3 affected unit test files to call them instead of reaching into private state via `as unknown as` casts. `circuitBreaker` was already `readonly` public on SafariPilotServer — just dropped the cast.

Per SD-09's stated scope (READ private state via cast), kept:
- Method-call casts for private test-entry-point methods (`ensureSessionWindow`, `recordToolFailure`)
- One write-cast in ensure-session-window.test.ts:97 for test-setup mutation

`upp:test-reviewer` (fast mode) verdict: **PASS** (0 CRITICAL, 0 MAJOR, 2 ADVISORY non-gating). Reviewer endorsed the scope, doc framing, and method-vs-getter choice (method form matches codebase convention).

### SD-08 — BRITTLE spy tests in `record-tool-failure.test.ts` (2026-04-25, commit `5060b8f`)

Resolved by replacing the 2 spy-on-method tests with 3 observable-state tests. Test 1 covers both breaker paths (per-domain opens + engine trips) via a single 5-failure stream on one domain. Test 2 preserves the original scope-independence proof (5 failures across 5 domains trip engine but not per-domain). Test 3 replaces the "UNKNOWN default" spy with a negative-invariance observable (non-triggering codes don't trip the engine). All T12 discrimination guarantees preserved — reverting either branch or dropping the code filter fails at least one assertion.

`upp:test-reviewer` (fast mode, Checks 6/7/8) verdict: **PASS** (0 CRITICAL, 0 MAJOR, 1 ADVISORY non-gating). Reviewer confirmed complementarity of all 3 tests (different mutants kill different tests) and deferred SD-09's private-state cast cleanup to its own scope.

### SD-07 — Quick-win batch: 4 tautological/shape-only oracles (2026-04-25, commit `60118eb`)

Resolved by strengthening 4 oracles across 4 e2e files: close_tab (`result.closed === true`), wait_for (fixed latent param-name bug where test used `selector`+`state` instead of the handler's `condition`+`value` — test had been silently hitting the timeout path; now asserts `met: true, timedOut: false`), evaluate-async sync-regression (parse `payload.value === 3` + `type === 'number'`), snapshot (triangulation: `ref=` + `length > 200` + `toLowerCase().toContain('example')` — three independent guards per reviewer).

`upp:test-reviewer` (full mode, 9 checks) verdict: **PASS** (0 CRITICAL, 0 MAJOR, 1 ADVISORY non-gating). Wait_for bug-fix was the highest-value change — test had been proving nothing about the happy path since inception.

### SD-06 — 18 of 21 error classes untested (2026-04-25, commit `e4a8ef3`)

Resolved by adding `test/unit/errors.test.ts` with 15 tests covering 13 previously-untested concrete `SafariPilotError` subclasses (the other 6 were already covered: TabUrlNotRecognizedError/T8, SessionWindowInitError/T11, DaemonTimeoutError/T9, plus Rate/Kill/Human/Breaker from SD-04). Each per-class test asserts class inheritance, code constant match, retryable, and constructor arg round-trip into message/selector/url. Plus a dedicated `formatToolError` test covering the `ExtensionUncertainError` branch (unverified before this commit).

`upp:test-reviewer` (full mode, 9 checks) verdict: **PASS** (CRITICAL: 0, MAJOR: 1 — tautological `ERROR_CODES constant` test replaced with the formatToolError branch fix, per reviewer's alternate recommendation; ADVISORY: 2 non-gating).

Discovery: 4 ERROR_CODES values (ELEMENT_NOT_INTERACTABLE, CROSS_ORIGIN_FRAME, DIALOG_UNEXPECTED, FRAME_NOT_FOUND) have no concrete class and are grep-zero across the codebase. Filed as **SD-22** above.

Total tests: 97 unit + 14 canary + 41 e2e = 152.

### SD-05 — No end-to-end lifecycle workflow test (2026-04-25, commit `b1c4eb5`)

Resolved by adding one `it()` in `test/e2e/lifecycle-workflow.test.ts` that drives the full 7-hop journey (open → navigate → interact → extract → back → forward → close) in a single block, with tabUrl cascading forward at each hop. Three explicit trace-event oracles filter by precise URL pairs / tabUrl to pin attribution: T2's `ownership_url_refreshed` (hop 2), T7's `ownership_tab_removed` (hop 7), and cascade discrimination at hops 3-6 (if any preceding hop breaks the registry, the next ownership pre-check throws `TabUrlNotRecognizedError`). Discrimination empirically verified by disabling T2 — test fails at hop 2's trace-event assertion; restored → passes.

`upp:test-reviewer` (fast mode, 3 checks) verdict: **PASS** (CRITICAL: 0, MAJOR: 1 — addressed; ADVISORY: 2 — style confirmations). Total tests: 82 unit + 14 canary + 41 e2e = 137.

### SD-04 — 7 of 9 security layers have zero coverage (2026-04-25, commit `29eb006`)

Resolved by adding 60 tests across 9 files:
- 56 unit tests (8 files in `test/unit/security/`): KillSwitch (5), RateLimiter (5), per-domain CircuitBreaker (7), AuditLog (6), DomainPolicy (7), HumanApproval (10), IdpiScanner (9), ScreenshotRedaction (7).
- 4 e2e tests (`test/e2e/security-layers.test.ts`): DomainPolicy trace event, HumanApproval degraded envelope + tab-didn't-open, IdpiScanner metadata annotation, ScreenshotRedaction redactionScript metadata.

Boundary split: pure-logic layers (KillSwitch/RateLimiter/per-domain CircuitBreaker/AuditLog) at unit scope because triggering via MCP would disrupt the shared client or has no read surface. The other 4 at e2e scope to prove `executeToolWithSecurity` wiring, not just the layer in isolation.

`upp:test-reviewer` (full mode, 9 checks) verdict: **PASS** (CRITICAL: 0, MAJOR: 1 — addressed; ADVISORY: 6 — 5 of 6 addressed with 4 additional unit files covering missing edge cases, 1 style nit declined). Discrimination: each test has an inline-documented mutation recipe that makes it fail.

CLAUDE.md litmus now passes for all 8 newly-covered layers. Total tests: 82 unit + 14 canary + 40 e2e = 136 (was 68).

### SD-02 — `test/canary/` inherits e2e `globalSetup` probes (2026-04-25, commit `84abc17`)

Resolved by adding a dedicated `vitest.config.canary.ts` (no `globalSetup`, scoped `include: ['test/canary/**/*.test.ts']`) and rewiring `package.json scripts.test:canary` to invoke vitest with that config. `scripts.test:all` now runs unit → canary → e2e in that order so a packaging regression surfaces in seconds rather than after the ~30+ min e2e suite.

Coverage: 7-test regression guard at `test/canary/config-isolation.test.ts` — file existence, no `globalSetup:` config key, no `setup-production` reference (defense-in-depth against `setupFiles:` regressions), include scoped to canary not e2e, package.json wiring (script + ordering in test:all), plus a behavioural test that invokes vitest with the canary config and asserts the e2e setup log lines are absent. Discrimination: pre-fix tests 1-6 fail (file missing, package.json unchanged); test 7 would catch a future `setupFiles` injection. Post-fix all 7 pass.

`upp:test-reviewer` (full mode, 9 checks) verdict: **PASS** (CRITICAL: 0, MAJOR: 1 — addressed in this commit; ADVISORY: 3 — addressed: switched to negative-form regex, added defense-in-depth, added behavioural guard).

Total test count: 25 unit + 14 canary (was 7) + 36 e2e = 75.

### SD-01 — `safari_evaluate` regresses on non-extension engines after the async-wrapper change (2026-04-25, commit `687f877`)

Resolved by adding `requiresAsyncJs: true` to `safari_evaluate`'s tool requirements in `src/tools/extraction.ts` (one-line change + comment). The engine selector reads this flag as a hard gate (`src/engine-selector.ts:54-68`); when extension is unavailable (config-killed, breaker-tripped, or not yet connected), `selectEngine` throws `EngineUnavailableError` (`server.ts` returns a degraded `EXTENSION_REQUIRED` envelope) instead of silently falling through to daemon/applescript with the IIFE's unresolved Promise. Same pattern as `safari_idb_list`/`safari_idb_get` from T6.

Coverage: 5-test unit suite at `test/unit/tools/extraction-requirements.test.ts` asserting both the contract (`requirements.requiresAsyncJs === true`) and the behavioural consequence (`selectEngine` throws when extension is down). Discrimination via the RED→GREEN transition: pre-fix tests 2 and 4 fail; post-fix all 5 pass.

`upp:test-reviewer` (full mode, 9 checks) verdict: **PASS** (CRITICAL: 0, MAJOR: 0, ADVISORY: 2). ADVISORY items: tests 1 and 5 are non-discriminating side-guards (the discriminator pair is tests 2 + 4) — not gating, kept for context.

`ARCHITECTURE.md` updated with the engine-routing constraint paragraph following the existing async-wrapper paragraph.

### SD-03 — Three CRITICAL weak oracles on core happy-path tools (2026-04-25, branch `fix/sd-03-weak-oracles`)

Resolved on `fix/sd-03-weak-oracles` (commit subject: `fix(test): SD-03 strengthen screenshot + click oracles, delete unfixable pre-call-gate test`). Three changes:

1. **Pre-call gate test → DELETED** (was `test/e2e/initialization.test.ts:82-87`). Phase 1 of `upp:systematic-debugging` concluded the test was structurally unfixable from happy-path e2e: gate emits no trace event when healthy (only `recovery_*` events on broken paths) and its negative path is unreachable from the harness — `checkWindowExists` uses `exists window id` which Safari leaves permanently true after close (ghost-window quirk), and breaking the daemon would tear down the shared client used by every other test. Adding a `pre_call_gate` trace emit purely for testability would have been a manufactured discriminator. The substantive systems-status oracle is the rich `safari_health_check` test at `initialization.test.ts:30-41` which already covers all 3 systems being green. The proper negative-path test is tracked separately as **SD-20** (above) — needs either a unit-level boundary mock or a one-line SUT change so `checkWindowExists` can be triggered cleanly.

2. **Screenshot oracle → STRENGTHENED** (`test/e2e/phase1-core-navigation.test.ts:64-83`). Old: `hasImage || hasText` (text-only stub passes). New: image content block exists, `mimeType === 'image/png'`, base64 data length > 1000. Discrimination empirically verified — text-only stub of `handleTakeScreenshot` fails with "Expected an image content block, got: [{type:'text',...}]: expected undefined to be defined".

3. **Click oracle → STRENGTHENED** (`test/e2e/phase3-interaction.test.ts:62-99`). Old: `JSON.stringify(result).toContain('clicked')` (any JSON containing "clicked" passes). New: parsed `clicked === true`, `element.tagName` matches `/^(BUTTON|INPUT)$/`, post-click `document.location.pathname === '/post'` (httpbin form submits via WebKit native default action on synthetic click; empirically confirmed). Plus trailing `tabUrl = 'https://httpbin.org/post'` to handle the registry refresh from the verify `safari_evaluate` (`server.ts:802-805`). Discrimination empirically verified — commenting out the three `el.dispatchEvent(...)` calls in `handleClick` actionJs fails with "expected '/forms/post' to be '/post'".

`upp:test-reviewer` (fast mode, Checks 6/7/8) verdict: **PASS** (CRITICAL: 0, MAJOR: 0, ADVISORY: 2). ADVISORY items: (a) Test 3's `clicked`/`tagName` asserts are decorative (URL discriminator is the load-bearing one); (b) Test 3's `tabUrl` reassignment is a workaround for `server.ts:802-805` and silently rots if that contract changes — track if observed. Both filed as awareness, not fix-now.

`npm run test:all` final state: 56/56 passing (20 unit + 36 e2e).

---

## Protocol when working an entry

1. Create a git branch `fix/sd-NN-<slug>`.
2. Run `upp:systematic-debugging` Phase 1 — read the entry + source files, reproduce the failure, verify the stated root-cause hypothesis. Do NOT skip.
3. Write the discriminating test FIRST. Verify it fails against current code.
4. Implement the fix.
5. Verify the test now passes AND that the discrimination holds (revert the fix → test fails; restore → passes).
6. Update ARCHITECTURE.md if shipped behavior changed.
7. Commit. Move the entry to the "Resolved" section with the commit SHA.
8. Run the full test suite (`npm run test:all`) before claiming done.
