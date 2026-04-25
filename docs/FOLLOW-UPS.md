# Pending systematic-debugging follow-ups

Running list of findings surfaced by reviewers (Codex, `upp:test-reviewer`, advisors) that were NOT yet run through `upp:systematic-debugging`. Each entry is a target for a future disciplined root-cause → minimal-fix → discriminating-test cycle. Items land here so they don't disappear between sessions.

**Triage rule:** do not "just fix" entries here. Pick one, run Phase 1 (root-cause investigation) from `upp:systematic-debugging` before writing any code, and produce the entry's discriminating test. Then move the entry to the "Resolved" section with the commit SHA.

---

## Open

  - `ARCHITECTURE.md` (§Test Architecture, Daemon Tests section)






### SD-28 — Clock-protocol injection on ExtensionBridge + ExtensionHTTPServer (delete `*ForTest` test-only public methods)
- **Severity:** P3 (cosmetic; the `*ForTest` methods work and the test discipline note is in code comments — but they're a test-leak into the production surface)
- **Source:** Filed during SD-17 work (2026-04-25). Originally part of SD-17 but deferred because the refactor scope is materially larger than the other two SD-17 patterns.
- **Symptom:** Two production classes carry test-only public methods that cannot be removed without exposing internal state to tests via another channel:
  - `ExtensionBridge.addToExecutedLogForTest(commandID:at:)` (ExtensionBridge.swift:60-64): inserts a back-dated executedLog entry so tests can exercise the TTL prune path.
  - `ExtensionHTTPServer.runDisconnectCheckForTest(elapsedSeconds:)` (ExtensionHTTPServer.swift:484-487, added by SD-13): rewinds `_lastRequestTime` and invokes private `checkDisconnect()` synchronously so disconnect tests don't need to sleep past the production 10s/15s schedule.
  Both bypass the test/production separation. A production caller could invoke them and corrupt state.
- **Current understanding (not verified):** introduce a `Clock` protocol with a default `SystemClock` (returns `Date()`), and inject it into `ExtensionBridge` + `ExtensionHTTPServer` constructors:
  ```swift
  protocol Clock { func now() -> Date }
  struct SystemClock: Clock { func now() -> Date { Date() } }
  // production
  let bridge = ExtensionBridge(clock: SystemClock())
  // tests
  let mockClock = MockClock()  // returns whatever the test sets
  let bridge = ExtensionBridge(clock: mockClock)
  mockClock.now = Date(timeIntervalSinceNow: -360)
  bridge.recordExecutedResult(commandID: "old-cmd")  // back-dated naturally
  ```
  Then delete `addToExecutedLogForTest` and `runDisconnectCheckForTest` — tests use the mock clock to control time directly. The custom CLT test harness rules out `@testable import` (per HealthStoreTests comment).
- **Discriminator:** with the refactor in place, the production `ExtensionBridge` has no `*ForTest` methods. Adding a new test-only API path requires either (a) the Clock injection, or (b) a new public method (which would be reviewed). Test files in `daemon/Tests/` instantiate with `MockClock` to control time. Reverting the Clock injection (back to `Date()` everywhere) fails the existing executedLog-TTL and disconnect-timeout tests because they can no longer control time.
- **Entry points / files:**
  - `daemon/Sources/SafariPilotdCore/Clock.swift` (new — protocol + SystemClock)
  - `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` (line 60-64 to delete; constructor + Date() sites to inject)
  - `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` (line 484-487 to delete; constructor + lastRequestTime to inject)
  - `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` (testExecutedLogExpiresAfterTTL)
  - `daemon/Tests/SafariPilotdTests/ExtensionHTTPServerTests.swift` (testDisconnectCheckFiresWhenIdleBeyondThreshold + testDisconnectCheckPreservesConnectionWhenFresh)

### SD-25 — PdfGenerator + syncAwait WebKit lazy-load deadlock blocks generate_pdf testing
- **Severity:** P3 (test-infra; the production daemon's PdfGenerator usage runs from a long-lived async context with a live runloop, so this affects ONLY the test harness)
- **Source:** Filed during SD-16 work (2026-04-25). Reproduced deterministically.
- **Symptom:** Calling `dispatcher.dispatch(line: <generate_pdf-NDJSON>)` from inside `syncAwait { ... }` deadlocks the test process. Diagnosis: PdfGenerator inherits `NSObject + WKNavigationDelegate`. First reference triggers WebKit framework lazy-load. WebKit's `+initialize` requires main-thread runloop coordination. The main thread is blocked in `syncAwait`'s `semaphore.wait()` while a coop-pool task drives the dispatch — classic main-thread deadlock with framework lazy loading. Verified by isolation: a `test("smoke") { try assertTrue(true) }` placed right after a passing `watch_download` test PASSes; the next `dispatcher.dispatch` call into `generate_pdf` hangs the process indefinitely.
- **Reproduction:** any test of the form
  ```swift
  test("anyPdfTest") {
      let dispatcher = CommandDispatcher(...)
      let response = syncAwait { await dispatcher.dispatch(line: <any generate_pdf NDJSON>) }
      ...
  }
  ```
  hangs after the previous test prints PASS. Killing the process is required.
- **Current understanding (not verified):** three viable fixes:
  - **(a)** Pre-load WebKit on the main thread BEFORE `register*Tests()` in `daemon/Tests/SafariPilotdTests/main.swift` — e.g. `_ = WKWebView()` once. Forces +initialize to run while the main thread is unblocked.
  - **(b)** Replace `syncAwait`'s blocking `semaphore.wait()` with a runloop-pumping wait (`RunLoop.current.run(until:)` style) so main-thread tasks can run during the test's await.
  - **(c)** Move PdfGenerator tests to a fully async harness that doesn't block the main thread (a separate XCTest target — but the project deliberately avoids XCTest per HealthStoreTests comment, so this is a bigger refactor).
- **Discriminator for the fix:** with the workaround in place, restore the three deferred `generate_pdf` tests from SD-16's design — covering `INVALID_OUTPUT_PATH` for missing-html-and-url, missing-outputPath, and non-existent parent dir guards in `PdfGenerator.init` (PdfGenerator.swift:88, 103, 110). Each must complete in <1s.
- **Entry points / files:**
  - `daemon/Sources/SafariPilotdCore/PdfGenerator.swift` (NSObject + WKNavigationDelegate)
  - `daemon/Tests/SafariPilotdTests/main.swift` (potential pre-load of WebKit)
  - `daemon/Tests/SafariPilotdTests/CommandDispatcherTests.swift` (potential restored T2/T3/T4)

### SD-26 — `watch_download` timeout param: AnyCodable Int decode bypassed; integer JSON literals fall back to 30s default
- **Severity:** P2 (production bug — silently changes the user-visible timeout from "the value I passed" to 30 seconds)
- **Source:** Filed during SD-16 work (2026-04-25). Test author had to discover the AnyCodable Int-first decoder behaviour by writing fractional `200.5` to make the test work.
- **Symptom:** `CommandDispatcher.handleWatchDownload` (line 247) reads `(params["timeout"]?.value as? Double) ?? 30000.0`. AnyCodable's decoder (Models.swift:13-35) tries `Int.self` BEFORE `Double.self`, so any integer JSON literal (e.g. `"timeout":200`) parses as Int. `Int as? Double` returns nil in Swift — the cast fails and the SUT falls back to the 30-second default. Real production callers writing `{"timeout": 5000}` get a 30-second wait, not a 5-second wait.
- **Current understanding (not verified):** two viable fixes:
  - **(a)** Widen the cast in `handleWatchDownload` (and similar sites — `extension_poll`'s `waitTimeout`, `pageRangeFirst`/`pageRangeLast` in PdfGenerator) to accept either type:
    ```swift
    let timeoutMs = (params["timeout"]?.value as? Double)
        ?? Double(params["timeout"]?.value as? Int ?? 0)
        ?? 30000.0
    ```
  - **(b)** Fix AnyCodable's decoder to ALWAYS prefer Double over Int (Int values would silently widen). Riskier — affects other call sites that depend on Int-typed params (e.g. session counts, status codes).
- **Discriminator for the fix:** add a unit test that sends `{"timeout": 200}` (no fractional component) and asserts the timeout fires within ~250ms (currently fires at 30000ms).
- **Entry points / files:**
  - `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift:247` (and similar sites: `:152` for waitTimeout, PdfGenerator.swift:115-128 for paper dimensions)
  - `daemon/Sources/SafariPilotdCore/Models.swift:13-35` (AnyCodable decoder, if option b)
  - `daemon/Tests/SafariPilotdTests/CommandDispatcherTests.swift` (test for option a)

### SD-27 — `handleInternalCommand` happy-path coverage missing for extension_status / _execute / _health
- **Severity:** P2 (the production route used by `ExtensionEngine`'s sentinel protocol — a copy-paste regression here goes silently)
- **Source:** Filed during SD-16 review (2026-04-25). Test reviewer flagged the gap.
- **Symptom:** `CommandDispatcher.handleInternalCommand` (CommandDispatcher.swift:209-240) routes the `__SAFARI_PILOT_INTERNAL__ <method>` sentinel to one of three happy paths or the `UNKNOWN_INTERNAL_METHOD` default. SD-16's T5 covers the default branch. The three happy paths (`extension_status`, `extension_execute`, `extension_health`) are NOT tested — the existing `testDispatcherExtensionStatusCommand` etc. exercise the OUTER dispatcher cases (`case "extension_status":` at line 156), not the INNER sentinel routes through `__SAFARI_PILOT_INTERNAL__`. A copy-paste regression that broke the inner branch (e.g. wired `extension_status` to the wrong handler) would not fail any test.
- **Current understanding (from review):** add three dispatcher-level tests, each driving an `execute` NDJSON command with `script: "__SAFARI_PILOT_INTERNAL__ <method> [json]"` and asserting the corresponding SUT side effect:
  - `extension_status` → `value == "disconnected"` (or "connected" if pre-connected)
  - `extension_execute` → command lands in bridge.pendingCommands (parallel to SD-14's testDispatcherRoutesExtensionExecuteQueuesCommand but via the INTERNAL route)
  - `extension_health` → snapshot keys present (mirrors testExtensionHealthReturnsComposite but via the INTERNAL route)
- **Discriminator:** swap any one of the three case branches in handleInternalCommand to call the wrong handler — the corresponding new test must fail.
- **Entry points / files:**
  - `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift:209-240`
  - `daemon/Tests/SafariPilotdTests/CommandDispatcherTests.swift` — extend with 3 happy-path tests


---

## Resolved

### SD-24 — Synchronous graceful shutdown for ExtensionHTTPServer (2026-04-25, commit `ba4e5c1`)

Resolved via path (a) variant — synchronous wait inside `stop()` using a `DispatchSemaphore` bridge instead of changing the API to async (which would have broken `defer { server.stop() }` patterns across all HTTP tests). Both server task and disconnect task are awaited up to a 2s deadline; production callers (graceful daemon shutdown) absorb the wait fine.

Verified runtime signal: pre-SD-24, every Swift suite run logged `HTTP_BIND_FAILED port=19999 (Address already in use)` between SD-13's disconnect tests and the onBindFailure test (the previous server hadn't released the port). Post-SD-24, that log line is gone — `stop()` actually waits for NIO to release sockets before the next test bind. All 118 tests pass.

No new tests added (the existing `testOnBindFailureFiresWhenPortAlreadyBound` continues to lock the collision-detection path, AND the absence of the inter-test "already in use" warning is a runtime sign that the FD leak is fixed). No reviewer dispatched per the user defaults.

### SD-23 — HealthStore Clock injection for prune-cutoff testing (2026-04-25, commit `32aebfb`)

Resolved by introducing a `TimeSource` protocol (named to avoid collision with Swift's built-in `Clock` from macOS 13+) and injecting it into HealthStore. The production default `SystemTimeSource` returns `Date()`, so behavior is unchanged — only the test surface gains controllability.

`HealthStore.pruneStaleSessionsLocked()` now uses `clock.now().addingTimeInterval(-60)` for the cutoff, and `registerSession`/`touchSession` use `clock.now()` for the lastSeen stamp. A `MockClock` in HealthStoreTests.swift exposes `advance(by: TimeInterval)` so tests can move time forward without sleeping.

2 new tests:
- `testPruneStaleSessionsLockedAt60sCutoff` — register at mock-T0, advance 30s (count=1), advance another 60s (total 90s, count=0). Discriminator: bumping the -60 cutoff to -600 fails the 90s assertion.
- `testPruneStaleSessionsLockedTouchSessionResetsLastSeen` — register, advance 50s, touch (resets lastSeen to mock-T0+50), advance 50s (count=1, only 50s post-touch), advance another 11s (count=0, 61s post-touch). Discriminator: removing the touchSession lastSeen update fails.

SD-28 will reuse the same TimeSource protocol for ExtensionBridge's executedLog TTL and ExtensionHTTPServer's disconnect-detection threshold, allowing deletion of `addToExecutedLogForTest` and `runDisconnectCheckForTest`.

No reviewer dispatched (SUT refactor + 2 unit tests following established patterns; discrimination claims are mechanically verifiable from per-test setup → output mapping). Total tests: 103 unit (TS) + 28 canary + 41 e2e + 118 Swift = 290 (Swift was 116 pre-SD-23; +2).

### SD-22 — Delete 4 dead ERROR_CODES (path a) (2026-04-25, commit `2779832`)

Resolved via path (a) — simplest, removes the dead declaration. The 4 codes (`ELEMENT_NOT_INTERACTABLE`, `CROSS_ORIGIN_FRAME`, `DIALOG_UNEXPECTED`, `FRAME_NOT_FOUND`) had zero references anywhere in src/, daemon/Sources/, extension/, or tests — they implicitly promised error-class semantics the codebase did not offer.

`src/errors.ts` ERROR_CODES now has 21 codes (was 25). All 21 have concrete `SafariPilotError` subclasses + throw sites locked by SD-06's per-class tests.

`test/unit/errors.test.ts` header comment updated to mark SD-22 resolved (the test previously documented these 4 codes as "unused, filed as SD-22").

Path (b) (adding concrete classes + wiring throw sites in `safari_click`, `safari_eval_in_frame`, `safari_handle_dialog`) would be feature-work, not coverage-work, and is out of SD-22's stated scope.

Doc-only / pure-deletion fix; no reviewer dispatched per the user defaults. Result: 103 unit tests still pass, build clean.

### SD-21 — ensureSessionWindow flake (orphan cleanup + 15s timeout) (2026-04-25, commit `c9e8b82`)

Resolved with options (a) AND (b) per the FOLLOW-UPS spec. Option (c) (replace execSync + AppleScript with daemon-side primitive) is the larger surgery and remains deferred.

**(a) Timeout bump**: `make new document` execSync timeout raised 5_000ms → 15_000ms. Empirically `make new document` exceeds 5s on a moderately-loaded Safari (multiple windows open, recent extension activity); 15s gives 3× headroom while still surfacing genuine hangs on a reasonable timeline.

**(b) Orphan cleanup**: new private `closeOrphanedSessionWindows(traceId)` invoked at the start of `ensureSessionWindow` BEFORE creating a new window. Runs an AppleScript:

```
tell application "Safari"
  set targetWindows to (every window whose name is "Safari Pilot — Active Session")
  repeat with w in targetWindows
    close w
  end repeat
end tell
```

Best-effort: cleanup failure (timeout, AppleScript error, etc.) does NOT block new-window creation — emits `session_window_orphan_cleanup_failed` trace and proceeds. T10's SIGTERM handler closes the session window on clean exit; SIGKILL/process crash leaves it orphaned. Without this cleanup, orphans accumulate across crashes and contribute to the timeout flake on subsequent starts.

3 unit tests in `test/unit/server/ensure-session-window.test.ts`:
- locks cleanup script content + ordering vs make-new-document
- locks the exact 15_000 timeout value
- locks the cleanup-failure best-effort path (mockImplementationOnce throw → second mock returns valid id → getSessionWindowId set, 2 calls made)

`upp:test-reviewer` (fast mode, Checks 6/7/8) verdict: **PASS** (0 CRITICAL, 0 MAJOR, 2 ADVISORY non-gating). Both ADVISORY about SUT design choices (Swift/TS title-string coupling at `ExtensionHTTPServer.swift:327` ↔ `server.ts:1240`; timeout single-field oracle by SD-21(a) scope).

Total tests: 103 unit (TS) + 28 canary + 41 e2e + 116 Swift = 288 (TS unit was 100; +3).

### SD-20 — Pre-call gate negative-path test (path A: unit-level, mocked boundaries) (2026-04-25, commit `eea79bb`)

Resolved via path (a) per the FOLLOW-UPS spec: new `test/unit/server/pre-call-gate.test.ts` mocking the two probe boundaries (`node:child_process.execSync` for `checkWindowExists`, global `fetch` for `checkExtensionStatus`) — matches the precedent set by `test/unit/server/ensure-session-window.test.ts`.

Three tests:
1. **SessionRecoveryError when extension unreachable + recovery times out** — the load-bearing discriminator. execSync returns 'true' (window OK), fetch returns ext=false on every call, vi fake timers skip the 10× × 1s polling wall wait. Multi-field oracle: instance + msg contains 'extension not connected' + retryable=true + hints contain repair string + fetch URL hits production /status.
2. **SessionRecoveryError with `session window closed` in message** — sequenced execSync mock (`'false'` once for gate's checkWindowExists, then `'true'` for recoverSession's subsequent checks) so the recovery loop actually runs and SessionRecoveryError surfaces with `window=initial=false` triggering the `'session window closed'` push in the constructor.
3. **Gate does NOT trigger recovery when probes are healthy** — negative form with a `fetchMock.calls.length === 1` assertion that catches a regression replacing the gate predicate with `if (true)` (would fire 11 fetch calls instead of 1).

`upp:test-reviewer` (fast mode, Checks 6/7/8) verdict: **PASS** (1 MAJOR + 3 ADVISORY, all addressed). MAJOR — Test 2's OR-alternation oracle didn't actually exercise the SessionRecoveryError window-down branch — fixed via sequenced mock. ADVISORY — Test 3 description-behavior gap + missing count assertion — both fixed. Test idiom: `expect(promise).rejects.toBeInstanceOf(...)` registered BEFORE `vi.advanceTimersByTimeAsync` to avoid unhandled-rejection windows.

Total tests: 100 unit (TS) + 28 canary + 41 e2e + 116 Swift = 285 (TS unit was 97 pre-SD-20; +3).

Reviewer-calibration data point: another correct call (caught my Test 2 not exercising the stated branch). Cumulative: SD-13 ADVISORY (correct), SD-15 MAJOR (state-machine miss — rejected), SD-19 CRITICAL (correct — caught my tautology), SD-20 MAJOR (correct). 3 of 4 reviewer flags landed; the gate is doing useful work.

### SD-19 — Shape-only / self-fulfilling Swift assertions strengthened (batch; 1 REVISE cycle) (2026-04-25, commit `b5a7b43`)

Three weak assertions identified by reviewer retro #2 strengthened:

**testExecuteRouting** (CommandDispatcherTests.swift): pre-SD-19 asserted `response.value == "script_result"` — purely self-fulfilling (mock returns "script_result", test asserts "script_result"). Strengthened to two real behavioural claims: `mock.lastScript == script` (dispatcher must forward unescaped script string) AND `response.id == "exec-1"` (dispatcher must forward command.id as executor.execute(commandID:); the mock reflects this back via `Response(id: commandID, ...)`).

**REVISE cycle**: my initial strengthening added `response.elapsedMs >= 0` as a third oracle. Reviewer flagged CRITICAL tautology — Response.elapsedMs is non-optional Double (defaults 0); mock explicitly sets elapsedMs:0; dispatcher's execute route returns `await executor.execute(...)` directly and doesn't populate elapsedMs at this layer (AppleScriptExecutor does, but it's mocked out). The REVISE catch was the gate working as intended — the EXACT pattern SD-19 was filed to fix. Removed. Plus comment narrative on `response.id` corrected (mock at line 14-21 ignores `responseToReturn.id` and reflects commandID directly; "placeholder" is dead data).

**testHTTPConnectCallsReconcile** (ExtensionHTTPServerTests.swift): pre-SD-19 asserted only that 5 reconcile keys were `!= nil` — empty-array response would pass. Strengthened: pre-populate bridge state (queue cmd-pre-pending → reQueued, queue+complete cmd-pre-acked → acked), `handleDisconnected` to flip delivered=false (mirrors production wake), then /connect with `executedIds=[cmd-pre-acked], pendingIds=[cmd-pre-pending]`. Asserts `acked.contains("cmd-pre-acked")`, `reQueued.contains("cmd-pre-pending")`, `pushNew.count == 0` (negative form). Locks reconcile semantics, not just shape.

**testHTTPServerCallsOnReadyAfterStart**: comment-only update pointing to `testOnBindFailureFiresWhenPortAlreadyBound` (added by SD-13). Both halves of the lifecycle hook contract now locked.

`upp:test-reviewer` (fast mode, Checks 6/7/8): first verdict **REVISE** (1 CRITICAL tautology, 1 ADVISORY comment misframe); after fix, **PASS** (0 CRITICAL, 0 MAJOR, 0 ADVISORY). Reviewer-calibration note: this is the gate firing correctly on my own self-fulfilling pattern. Worth noting alongside the SD-13 (correct call) and SD-15 (state-machine miss) calibration data points.

Total tests: 97 unit (TS) + 28 canary + 41 e2e + 116 Swift = 282 (no test count change; just strengthening).

### SD-18 — Doc correction: "Swift tests are real, not mocked" (2026-04-25, commit `55b3500`)

Resolved by amending `ARCHITECTURE.md:446-449` to "Real Swift tests against real types, with I/O-isolation mocks at the NSAppleScript boundary." Bumped daemon test count 51 → 116 to reflect SD-11 / SD-12 / SD-13 / SD-14 / SD-15 / SD-16 additions. The MockExecutor / StubExecutor / SequencedMockExecutor types substitute the external NSAppleScript → Safari boundary so tests run without a live Safari, but the SUT (CommandDispatcher, ExtensionBridge, HealthStore, ExtensionHTTPServer) is the real production code — per the test rubric this is acceptable. Doc-only fix; no reviewer.

### SD-17 — Swift test infrastructure brittleness (port public + waitUntil helper; Clock injection deferred to SD-28) (2026-04-25, commit `6b1b043`)

Resolved with two of three patterns addressed in-place; the third (Clock injection) deferred to SD-28 due to the refactor scope being materially larger than the SD-17 P3 estimate.

**Pattern 1 (Mirror reflection on private `port`)** — `ExtensionHTTPServer.port` is now a `public let` instead of `private let`. The Mirror-based `testPort` accessor (which silently returned 0 on rename, causing tests to connect to `http://127.0.0.1:0`) is now a 1-line `var testPort: UInt16 { port }` that uses the real getter. A rename now surfaces as a compile error (the SD-17 stated discriminator).

**Pattern 3 (sleep-poll patterns)** — new `waitUntil(timeout:pollInterval:_:)` helper added to `daemon/Tests/SafariPilotdTests/main.swift`. Replaces fixed `Thread.sleep(0.1) + single observation` with a predicate-based wait. Helper is in place; opportunistic adoption of the ~20 existing sleep-poll sites left as a follow-up since converting each site requires adding a non-mutating public observation point on `ExtensionBridge` (e.g. `pendingCommandsCount`) — best done alongside the SD-28 Clock-injection refactor.

**Pattern 2 (`*ForTest` test-only methods on production classes)** — deferred to SD-28. The Clock-protocol injection refactor on `ExtensionBridge` + `ExtensionHTTPServer` is the right fix but touches the constructor surfaces of both classes plus several test sites. Filed with concrete protocol design + before/after sketch.

No new tests added (this is a SUT signature refactor + unused helper). All 116 Swift tests still pass. Reviewer skipped per the doc-only / pure-refactor convention.

### SD-16 — CommandDispatcher: watch_download + UNKNOWN_INTERNAL_METHOD coverage (partial; PDF deferred to SD-25) (2026-04-25, commit `c98bcac`)

Resolved with 2 of 5 originally-planned tests in `daemon/Tests/SafariPilotdTests/CommandDispatcherTests.swift`:

- `testDispatcherRoutesWatchDownloadAndReturnsTimeoutOnNoDownload` — drives `watch_download` via `dispatcher.dispatch(line:)` with a fractional 200.5ms timeout (forces Double decoding; see SD-26 for the underlying SUT smell). Triple oracle: `ok=false`, `code=DOWNLOAD_TIMEOUT`, `retryable=true`, plus a reviewer-driven `elapsedMs` band `[150, 5000)` to catch an early-return regression that emits TIMEOUT without actually waiting.
- `testDispatcherInternalCommandUnknownMethodReturnsUnknownInternalMethod` — drives the production `__SAFARI_PILOT_INTERNAL__ <unknown>` sentinel through the `execute` route. Triple oracle: `ok=false`, `code=UNKNOWN_INTERNAL_METHOD`, `retryable=false`.

**Deferred 3 tests to SD-25** (`generate_pdf` INVALID_OUTPUT_PATH coverage for missing-html-and-url, missing-outputPath, non-existent parent dir): exercising PdfGenerator from `syncAwait { await dispatcher.dispatch(...) }` deadlocks the test process. Diagnosis: PdfGenerator inherits `NSObject + WKNavigationDelegate`; first reference triggers WebKit framework lazy-load whose `+initialize` requires main-thread runloop coordination. The main thread is blocked in `syncAwait`'s `semaphore.wait()` while a coop-pool task drives dispatch — textbook framework lazy-load deadlock. Verified by isolation. SD-25 captures three remediation paths.

`upp:test-reviewer` (fast mode, Checks 6/7/8) verdict: **PASS** (CRITICAL: 0, MAJOR: 0, ADVISORY: 3). One ADVISORY addressed in commit (elapsedMs band on T1); the other two flagged as new SDs:
- **SD-26** filed: `watch_download` timeout param accepts only Double; integer JSON literals fall back to 30s default (production bug — actual user-facing impact).
- **SD-27** filed: `handleInternalCommand` happy-path coverage missing for the three INNER sentinel routes (extension_status / _execute / _health). Outer-dispatcher tests don't exercise this path.

Reviewer endorsed the T2-T4 deferral as grounded in a real test-infra deadlock and within the FOLLOW-UPS preamble's "progressive error-parity" allowance. SD-25 captures the recipe + 3 remediation paths so the next implementer doesn't have to rediscover them.

Total tests: 97 unit (TS) + 28 canary + 41 e2e + 116 Swift = 282 (Swift was 114 pre-SD-16; +2).

### SD-15 — Lifecycle gap (Check 9): canary tarball-shape + bridge full-journey (2026-04-25, commit `7dbc16f`)

Two parallel coverage gaps closed:

**Canary half** — `test/canary/release-tarball-shape.test.ts` adds 8 tests exercising real `npm pack --dry-run --json` (no on-disk tarball, no install). Each test asserts a persona-critical path in the tarball: bin/SafariPilotd present + size > 1MB, postinstall+preuninstall scripts, LaunchAgent plist, dist/index.js+server.js, .mcp.json + plugin metadata, bin/Safari Pilot.app/* tree, NEGATIVE-form (test/+src/+daemon/Sources/+daemon/Tests/ NOT shipped), name+version+filename round-trip vs package.json. Per reviewer ADVISORY, refactored to one shared `beforeAll` `npm pack` invocation: 17.7s → 2.3s (8× speedup).

**Bridge half** — `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` adds `testBridgeFullJourneyConnectExecutePollDisconnectReconcileResultTeardown`, walking 10 hops with assertions at each: daemon-start → connect → queue 3 → poll → disconnect (wake-semantics) → reconnect → reconcile (asserts reQueued={cmd1,cmd2}, pushNew=[cmd3], inFlight=[]) → results in non-queue order → teardown executedLog → post-teardown reconcile classifies all 3 as acked. Per-hop assertions + back-pointing error messages surface a regression at the broken hop.

`upp:test-reviewer` (full mode, 9 checks) verdict: **PASS** (CRITICAL: 0, MAJOR: 1, ADVISORY: 5).

The MAJOR ("add Hop 5.5 poll for direct delivered-flip observation") was REJECTED after state-machine trace + advisor reconciliation. handlePoll mutates delivered=true, breaking Hop 7's reQueued classification (commands would classify as inFlight). Production never polls between disconnect and reconcile — daemon waits passively for /connect. The dedicated test `testHandleDisconnectedFlipsDeliveredBackForUnacked` already locks the wake-semantics in isolation; the lifecycle test verifies it transitively at Hop 7 with a back-pointing error message. Accepting one-hop-late discrimination preserves production fidelity (Chicago-school TDD).

5 ADVISORIES all addressed: A1 Hop 1 tautology comment, A2 beforeAll canary refactor, A3 readFileSync over `cat` execSync, A4 200ms sleep deferred to SD-17, A5 size threshold confirmed. Plus optional Hop 10 added (post-teardown reconcile locks executedLog read path).

Reviewer-calibration note: this is the second time the test-reviewer has produced a recommendation that didn't survive a careful state trace. Worth tracking; not yet enough to change the gating policy.

Total tests: 97 unit (TS) + 28 canary + 41 e2e + 114 Swift = 280 (canary was 20 pre-SD-15; +8. Swift was 113; +1).

### SD-14 — ExtensionBridge tests UNWIRED: dispatcher-level routing for extension_result/_execute/_disconnected (2026-04-25, commit `e6dde0c`)

Resolved by adding 3 dispatcher-level tests at the end of `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift`. Each drives the production NDJSON path via `dispatcher.dispatch(line:)` rather than calling the bridge methods directly:

- `testDispatcherRoutesExtensionResultResolvesPendingCommand` — locks `case "extension_result":` (CommandDispatcher.swift:145-146). Asserts both dispatch ack with id round-trip AND the queued execute resolves with the inner `Int 42`.
- `testDispatcherRoutesExtensionExecuteQueuesCommand` — locks `case "extension_execute":` (lines 148-149). Polls bridge to verify command landed with id+script+tabUrl all round-tripped (tabUrl assertion added per reviewer ADVISORY to make params-dict round-trip explicit, beyond just `script`).
- `testDispatcherRoutesExtensionDisconnectedFlipsConnectedState` — locks `case "extension_disconnected":` (lines 142-143). This was a symmetric gap with the existing `testDispatcherRoutesExtensionConnected`, discovered during SD-14 work and folded into the same commit. Connect+disconnect both round-trip via `dispatcher.dispatch(line:)`.

Removing any of the three case branches makes the dispatcher fall through to `UNKNOWN_METHOD` — the test fails immediately on dispatch ack OR on the side-effect oracle.

`upp:test-reviewer` (fast mode, Checks 6/7/8) verdict: **PASS** (CRITICAL: 0, MAJOR: 0, ADVISORY: 2 — one addressed in commit (tabUrl round-trip explicit); the other (Test 3 connect-via-dispatcher pre-state being a double-cover) the reviewer endorsed as the correct stylistic choice; kept as-is).

Discovery during SD-14 work: the Swift HTTP test suite intermittently leaks file descriptors / sockets between tests under rapid back-to-back runs (`EMFILE` from socket exhaustion on the 19th-or-so `startTestHTTPServer()`). Filed as **SD-24** above. Retry-with-pause works; not blocking, but worth a proper fix.

Total tests: 97 unit (TS) + 20 canary + 41 e2e + 113 Swift = 271 (Swift was 110 pre-SD-14; +3).

### SD-13 — ExtensionHTTPServer: 4 untested routes + disconnect timeout + onBindFailure (2026-04-25, commit `3e46c2d`)

Resolved by adding 13 tests in `daemon/Tests/SafariPilotdTests/ExtensionHTTPServerTests.swift` covering all four flagged routes plus the disconnect-detection branch, the bind-failure callback, and the three 400-path guards.

Route coverage (6 tests): `GET /status` happy path with all five fields asserted; `GET /status?sessionId=...` implicit-heartbeat; `GET /session` content-type + page-title literal + sessionTabActive flip; `GET /health` happy path with `>0` and `~now` bounds on `lastExecutedResultTimestamp`; `GET /health` negative form (NSNull before any markExecutedResult); `POST /session/register` happy path with three independent oracles.

Error paths (3 tests): `/session/register` missing-key (400, `activeSessionCount` stays 0); `/session/register` empty-body via raw URLRequest (different guard branch, both yield 400); `/result` missing-`requestId` 400 (without the route-level guard, `bridge.handleResult` returns INVALID_PARAMS but the HTTP layer would still emit 200 — 400 is the only protocol-level signal).

Disconnect timeout (2 tests, brackets the 15s threshold): exercise the private `checkDisconnect()` via a new test-only public method `runDisconnectCheckForTest(elapsedSeconds:)` that rewinds `_lastRequestTime` and invokes the check synchronously. SUT addition pattern-aligned with `ExtensionBridge.addToExecutedLogForTest`; @testable import isn't available because the test target is a custom CLT harness (per HealthStoreTests comment); SD-17 tracks the broader cleanup.

onBindFailure (1 test): two servers binding port 19999; the second's `onBindFailure` callback must fire within 5s with a non-nil error.

`upp:test-reviewer` (full mode, 8 checks) verdict: **PASS** (CRITICAL: 0, MAJOR: 0, ADVISORY: 4 — all addressed: A1 tightened `lastPingAge` from `is Int` to range `0...500`; A2 added `testHTTPStatusReturnsNullPingAgeBeforeAnyPing` to symmetrically lock the `?? NSNull()` selection on `/status`; A3 documented intentional brittleness of the page-title literal; A4 confirmed test-only public method acceptable per existing pattern + SD-17 cleanup).

Total tests: 97 unit (TS) + 20 canary + 41 e2e + 110 Swift = 268 (Swift was 97 pre-SD-13; +13).

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
