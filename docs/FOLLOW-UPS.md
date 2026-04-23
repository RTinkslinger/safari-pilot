# Pending systematic-debugging follow-ups

Running list of findings surfaced by reviewers (Codex, `upp:test-reviewer`, advisors) that were NOT yet run through `upp:systematic-debugging`. Each entry is a target for a future disciplined root-cause → minimal-fix → discriminating-test cycle. Items land here so they don't disappear between sessions.

**Triage rule:** do not "just fix" entries here. Pick one, run Phase 1 (root-cause investigation) from `upp:systematic-debugging` before writing any code, and produce the entry's discriminating test. Then move the entry to the "Resolved" section with the commit SHA.

---

## Open

### SD-01 — `safari_evaluate` regresses on non-extension engines after the async-wrapper change
- **Severity:** P1 (real regression in shipped behavior)
- **Source:** Codex branch review (2026-04-24, job `bk54t3qu6`)
- **Symptom:** After commit `99fec1f` switched `handleEvaluate` to an async IIFE that returns a Promise to `executeJsInTab`, the daemon and AppleScript engines' JS wrappers don't await the returned Promise. On any path that doesn't route to the extension engine (extension disabled / disconnected / engine breaker tripped), even synchronous `safari_evaluate` calls now serialize the Promise object instead of resolving it. Promise-returning scripts fail on every non-extension path.
- **Current understanding (from review, not verified):**
  - The async wrapper was paired with `content-main.js`'s `await fn()` (T6), which only runs on the extension engine.
  - Daemon + AppleScript paths use their own JS wrappers that serialize synchronously.
  - Fix pattern is already established: T6 added `requiresAsyncJs: true` to the IDB tools in `src/types.ts` + `src/engine-selector.ts` + the tool definitions. Apply the same pattern to `safari_evaluate`.
- **Discriminator for the fix:** an e2e test that forces the extension engine OFF (kill-switch config, or stub engineAvailability in a dedicated test harness) and calls `safari_evaluate` with a sync script — must either succeed via async-capable engine or throw `EngineUnavailableError`. The current behavior (silent wrong return) must be impossible.
- **Entry points / files:**
  - `src/tools/extraction.ts:143-160` — `safari_evaluate` tool definition + `handleEvaluate`
  - `src/types.ts` — `ToolRequirements.requiresAsyncJs`
  - `src/engine-selector.ts` — `requiresAsyncJs` check
  - `src/tools/storage.ts` — existing `requiresAsyncJs: true` precedent from T6
  - `test/e2e/evaluate-async.test.ts` — test to extend

### SD-02 — `test/canary/` inherits e2e `globalSetup` probes (hidden dependency + latency cost)
- **Severity:** P2 (degraded, not broken; worth a cheap split)
- **Source:** Codex branch review (2026-04-24, job `bk54t3qu6`); **severity corrected by upp:test-reviewer retro #2**
- **Symptom:** `test/canary/preuninstall.test.ts` and `test/canary/release-universal-binary.test.ts` are static file / config assertions. `npm run test:canary` uses the default `vitest.config.ts`, which runs `test/e2e/setup-production.ts` via `globalSetup`. **Correction** (Codex overstated this; test-reviewer #2 caught it): `setup-production.ts` returns early when `isE2eRun` is false, so the canary run does NOT abort on machines without Safari/daemon. It DOES still execute the precondition probes (`createConnection` on 19474 with 3s timeout, extension_health NDJSON round-trip with 5s timeout, `osascript` shell-out, `existsSync` on `dist/index.js`). That's ~8s of hidden-dependency latency per canary run and an invisible coupling to Safari being installed on the host.
- **Current understanding (from review #2, not verified):**
  - Fix shape: add `vitest.config.canary.ts` mirroring `vitest.config.unit.ts`, no globalSetup, include `test/canary/**/*.test.ts`. Point `package.json scripts["test:canary"]` at the new config.
  - Second-order: should `test:all` include canary? Probably yes after the split (canary is now genuinely cheap).
- **Discriminator for the fix:** `npm run test:canary` must complete in <500ms on a machine with no Safari installed at all (no osascript, no daemon binary). Current behavior: ~8s even on that machine because probes run.
- **Entry points / files:**
  - `vitest.config.ts` / new `vitest.config.canary.ts`
  - `vitest.config.unit.ts` — split-config precedent
  - `test/e2e/setup-production.ts` — the probes being inherited
  - `package.json` — scripts to update

### SD-03 — Three CRITICAL weak oracles on core happy-path tools
- **Severity:** P0 (trivial stub impls pass these tests)
- **Source:** `upp:test-reviewer` retro review #1 (2026-04-24)
- **Symptom:** Three e2e tests on the most-used tools each accept an implementation that never does the work:
  1. `test/e2e/initialization.test.ts:82-87` — "pre-call gate detects and reports system status" asserts only `typeof result === 'object'`. `null` passes. An impl with the health gate deleted and returning `{}` passes.
  2. `test/e2e/phase1-core-navigation.test.ts:72-76` — `safari_take_screenshot` accepts `hasImage || hasText`. A stub returning `{content: [{type:'text', text:'error'}]}` passes.
  3. `test/e2e/phase3-interaction.test.ts:62-72` — `safari_click` asserts `text.toContain('clicked')`. Any JSON containing the word "clicked" passes (including a stub that never touches the DOM). `httpbin.org/forms/post` submits on click — the natural discriminator (URL → `/post`) is right there and unused.
- **Current understanding (from review, not verified):** same class of bug in three places — asserting on shape/stringified-result instead of observables. Each has a one-line fix.
- **Discriminator for each fix:**
  1. Pre-call gate: assert on the `health_check` payload field or a `pre_call_gate` trace event in `~/.safari-pilot/trace.ndjson`, OR deliberately break daemon/extension and assert `SessionRecoveryError`.
  2. Screenshot: `expect(hasImage).toBe(true)` + `expect(content[0].data.length).toBeGreaterThan(1000)` (PNG byte-floor).
  3. Click: after click, call `safari_evaluate` to read `document.location.pathname` and assert `/post`.
- **Entry points / files:**
  - `test/e2e/initialization.test.ts:82-87`
  - `test/e2e/phase1-core-navigation.test.ts:72-76`
  - `test/e2e/phase3-interaction.test.ts:62-72`
  - The upstream tools: `src/tools/navigation.ts` (screenshot routing), `src/tools/interaction.ts` (click handler)

### SD-04 — 7 of 9 security layers have zero e2e coverage
- **Severity:** P1 (the product's core value is the 9-layer pipeline; 7 layers can be deleted without any test failing)
- **Source:** `upp:test-reviewer` retro review #1 (2026-04-24)
- **Symptom:** `security-ownership.test.ts` covers TabOwnership (layers 2/post-8); the other 7 production layers are uncovered. The CLAUDE.md litmus "delete a critical component — does any test fail?" **fails** for:
  1. **KillSwitch** — no test triggers it and asserts `KILL_SWITCH_ACTIVE` fail-closed
  2. **DomainPolicy** — no denylist + `DOMAIN_NOT_ALLOWED` assertion
  3. **HumanApproval** — no untrusted-domain sensitive-action flag test
  4. **RateLimiter** — no 121st-call-to-one-domain test asserting `RATE_LIMITED`
  5. **Per-domain CircuitBreaker** (distinct from T12's engine breaker) — no 5-failures-open-break-120s e2e
  6. **IdpiScanner** — no prompt-injection payload → trace/result annotation test
  7. **ScreenshotRedaction** — no banking/cross-origin blur-CSS attachment test
  8. **AuditLog** — no assertion that a tool call left an audit record
- **Current understanding (from review, not verified):** each layer lives in `src/security/` and is wired into `server.ts executeToolWithSecurity`. Each test can be short: one adversarial call + one trace-event or error-envelope assertion.
- **Discriminator per layer:** trace-event scan against `~/.safari-pilot/trace.ndjson` after the adversarial call, OR `rejects.toThrow(/<specific error code>/)`. Same pattern already working in T7/T8.
- **Entry points / files:**
  - `src/security/{kill-switch,domain-policy,human-approval,rate-limiter,circuit-breaker,idpi-scanner,screenshot-redaction,audit-log}.ts`
  - `src/server.ts` — `executeToolWithSecurity` layer wiring
  - `test/e2e/security-ownership.test.ts` — the pattern to mimic

### SD-05 — No end-to-end lifecycle workflow test
- **Severity:** P1 (the exact bug class CLAUDE.md history warns against — URL-as-identity cascade)
- **Source:** `upp:test-reviewer` retro review #1 (Check 9 LIFECYCLE GAP)
- **Symptom:** Each phase file exercises atomic ops in its own tab and closes it. No single test walks open → navigate → interact → extract → navigate-back → navigate-forward → close as one journey, asserting the tab-ownership registry stays coherent at each transition. Phase 1 has these ops but each in its own `it()` with mid-suite `tabUrl` mutations — a mid-test failure cascades without discriminating which transition broke.
- **Current understanding (from review, not verified):** one `it()` block doing the full sequence, with assertions between each step. Can reuse the existing tools through the shared client. The failure mode this catches: a commit that updates the registry wrong on one transition causes the next transition to misbehave.
- **Discriminator for the fix:** inject a known bad registry-update at one transition (e.g., revert T2's post-navigation URL refresh) → test fails on the very next step. Restoring passes the full journey.
- **Entry points / files:**
  - `src/security/tab-ownership.ts` — dual-key registry invariants
  - `src/server.ts` — step 8.post0/post1/post2 registry mutations
  - New test: `test/e2e/lifecycle-workflow.test.ts`

### SD-06 — 18 of 21 error classes untested
- **Severity:** P2 (error paths regress most often; prioritize security-consequence ones first)
- **Source:** `upp:test-reviewer` retro review #1
- **Symptom:** `src/errors.ts` defines 21 `SafariPilotError` subclasses. Only 3 have coverage:
  - `TabUrlNotRecognizedError` (T8 e2e), `SessionWindowInitError` (T11 unit), `DaemonTimeoutError` (T9 unit).
  Untested: `ELEMENT_NOT_FOUND`, `ELEMENT_NOT_VISIBLE`, `ELEMENT_NOT_INTERACTABLE`, `TIMEOUT`, `NAVIGATION_FAILED`, `CSP_BLOCKED`, `SHADOW_DOM_CLOSED`, `CROSS_ORIGIN_FRAME`, `SAFARI_NOT_RUNNING`, `SAFARI_CRASHED`, `PERMISSION_DENIED`, `TAB_NOT_FOUND`, `DOMAIN_NOT_ALLOWED`, `RATE_LIMITED`, `EXTENSION_REQUIRED`, `KILL_SWITCH_ACTIVE`, `HUMAN_APPROVAL_REQUIRED`, `DIALOG_UNEXPECTED`, `FRAME_NOT_FOUND`, `CIRCUIT_BREAKER_OPEN`, `EXTENSION_UNCERTAIN`, `SESSION_RECOVERY_FAILED`.
- **Current understanding (from review, not verified):** prioritize by security consequence — the four security-layer codes (SD-04) cover 4 of these already. The DOM-level ones (`ELEMENT_*`) can wait until a regression surfaces.
- **Discriminator per error class:** test that the error code + message prefix matches (same pattern as T8's `rejects.toThrow(/TAB_NOT_OWNED|Tab URL not recognized/)`).
- **Entry points / files:**
  - `src/errors.ts` — the 21-class hierarchy
  - Each error's throw site across `src/tools/`, `src/engines/`, `src/security/`

### SD-07 — Quick-win batch: 4 tautological/shape-only oracles
- **Severity:** P2 (each is a one-line fix; ~1-2 hours total)
- **Source:** `upp:test-reviewer` retro review #1 (MAJOR oracle findings)
- **Symptom:** Four tests currently assert in ways that admit trivial-stub passes:
  1. `test/e2e/phase1-core-navigation.test.ts:115-118` close_tab — `expect(text).toBeDefined()` where `text = JSON.stringify(result)`. Should be `expect(result.closed).toBe(true)` (T7 already uses this oracle on the same tool).
  2. `test/e2e/phase3-interaction.test.ts:92-94` wait_for — same tautology. Handler returns `{found: true}` or similar; assert on the specific field.
  3. `test/e2e/evaluate-async.test.ts:74` sync-regression test — `expect(payloadStr).toContain('3')` matches any JSON containing the character `3` (timestamps, latency, etc). Parse the value and assert `expect(parsed.value).toBe(3)`.
  4. `test/e2e/phase2-page-understanding.test.ts:46-48` snapshot — `text.toContain('ref=')` has a narrow false-positive window (error envelope containing `ref=`); add `expect(text.length).toBeGreaterThan(200)` as a second guard.
- **Current understanding (from review):** same class of bug in four places. Batch fix as one commit.
- **Discriminator:** for each test, pre-fix a stub of the SUT handler that returns a tautology-satisfying envelope → tests must fail against it. Post-fix with correct oracles → tests pass against real impl.

### SD-08 — BRITTLE spy tests in `record-tool-failure.test.ts`
- **Severity:** P3 (test 3 already carries the file via observable-state assertion; spy tests are cosmetic)
- **Source:** `upp:test-reviewer` retro review #1
- **Symptom:** Tests 1 and 2 use `vi.spyOn(cb, 'recordFailure')` / `vi.spyOn(cb, 'recordEngineFailure')` to assert the server calls these methods with specific args. This is a spy-not-mock (no `mockImplementation` — real CB still runs), so MOCK-IN-E2E / self-fulfilling doesn't fire. But it asserts on HOW the server wires things, not WHAT the system does. Test 3 (5-failure trip → `isEngineTripped === true`) is the real oracle.
- **Current understanding (from review):** merge tests 1+2 into a single observable-state assertion (e.g., fire one failure → assert `cb.getDomainState('example.com') !== 'closed'` on the real CB). Keep test 3 unchanged.
- **Discriminator:** the merged test still fails if `recordToolFailure` is reverted to only call the per-domain side (i.e., SD-08's fix preserves the T12 discrimination guarantee).
- **Entry points / files:** `test/unit/server/record-tool-failure.test.ts:37-48`

### SD-10 — Canary T3/T4 are UNVERIFIED CLAIM: shape-only, not behavior
- **Severity:** P1 (distribution-gate tests admit trivial stubs that wouldn't uninstall anything or ship any binary)
- **Source:** `upp:test-reviewer` retro review #2 (2026-04-24)
- **Symptom:**
  - `test/canary/preuninstall.test.ts` (T3) header claims "verifies the shipped npm package cleans up after itself." Actual assertions: `package.json` has a `preuninstall` key; `scripts/preuninstall.sh` exists, is owner-executable, contains substrings `launchctl bootout|unload` and `com.safari-pilot.daemon`. A preuninstall.sh containing `echo "launchctl bootout com.safari-pilot.daemon"` (echoed as comment, no-op) passes all four tests. The LaunchAgent is never actually unloaded.
  - `test/canary/release-universal-binary.test.ts` (T4) header claims "verifies release.yml wires the universal binary into the npm tarball." Actual assertions: literal text of `release.yml` contains substrings with correct character-index ordering. A release.yml with the `cp` command wrapped in `|| true` (silently fails), or `if: false` gating, or copying the wrong file passes every test because the YAML is never executed or semantically parsed.
- **Current understanding (from review #2, not verified):**
  - Weak fix: `bash -n scripts/preuninstall.sh` to verify it parses; for release.yml, parse via `yaml` devDep and walk `steps[]` asserting a step whose `run` contains `cp dist-bin/SafariPilotd bin/SafariPilotd` appears BEFORE any step whose `run` matches `/npm publish(\s|$)/`. AST ordering, not character ordering.
  - Strong fix: sandboxed `npm pack` → extract → dry-run preuninstall in a tmp `$HOME` with `launchctl` stubbed via `$PATH` override; in CI, consume the `file bin/SafariPilotd` output as an artifact and assert on it.
  - Also: file-header comments on both tests oversell what's covered. Reword to "static-config canary — guards file shape / YAML text from accidental regression; does not verify runtime behavior."
- **Discriminator for the fix:** inject a lobotomized `preuninstall.sh` that prints `launchctl bootout com.safari-pilot.daemon` as a comment (prefixed with `#`) and does nothing else — current tests pass, behavioral tests must fail. Same for release.yml: wrap the cp in `|| true` — current tests pass, AST-walking test must fail.
- **Entry points / files:**
  - `test/canary/preuninstall.test.ts`, `test/canary/release-universal-binary.test.ts`
  - `scripts/preuninstall.sh`, `.github/workflows/release.yml`

### SD-11 — HealthStore recent-iteration API (session/MCP/keepalive) has zero tests
- **Severity:** P1 (exactly the "critical recent-iteration code" the reviewer was asked to scrutinize)
- **Source:** `upp:test-reviewer` retro review #2 (2026-04-24)
- **Symptom:** `HealthStoreTests.swift` covers older alarm-fire / HTTP bind-failure / roundtrip counters. Untested: `registerSession`, `touchSession`, `activeSessionCount`, 60s session prune, `recordKeepalivePing`, `lastKeepalivePing`, `isSessionAlive`, `recordTcpCommand`, `checkMcpConnection`, `mcpConnected`, `markExecutedResult`, `lastExecutedResultTimestamp`, `recordSessionServed`, `sessionTabActive`. These are the T-series initialization-system additions.
- **Current understanding (from review, not verified):** one test per public getter/setter pair plus behavior tests for: (a) 60s session prune transition (register, advance time, prune, assert removed), (b) `checkMcpConnection` 30s-stale transition (record, advance time, assert `mcpConnected` clears), (c) `isSessionAlive` under stale vs fresh pings.
- **Discriminator:** break `pruneStaleSessionsLocked` (raise cutoff to 600s) — session-prune test must fail; restore → passes.
- **Entry points / files:**
  - `daemon/Sources/SafariPilotdCore/HealthStore.swift` — SUT
  - `daemon/Tests/SafariPilotdTests/HealthStoreTests.swift` — extend

### SD-12 — ExtensionBridge `__keepalive__`, `__trace__`, `_meta` sentinels untested
- **Severity:** P1 (three production-critical sentinels, each a documented contract; deletion of any is invisible to the test suite)
- **Source:** `upp:test-reviewer` retro review #2 (2026-04-24)
- **Symptom:** Inside `ExtensionBridge.handleResult()`:
  - `__keepalive__` (SUT lines 266-274): updates `HealthStore.lastKeepalivePing`, marks extension connected. No test queues `{"requestId": "__keepalive__", ...}` and asserts the HealthStore state change.
  - `__trace__` (SUT lines 277-292): routes extension trace events to `daemon-trace.ndjson`; nested `alarm_fire` event updates `HealthStore.lastAlarmFireTimestamp`. No test exercises this path.
  - `_meta` wrapper (SUT lines 358-365): success results carrying `_meta` get rewrapped as `{"value": innerValue, "_meta": meta}` — the T4/tab-identity contract. No test queues a result with `_meta` and asserts wrapper shape.
- **Current understanding (from review):** one test per sentinel. Each drives the sentinel through `handleResult` and asserts the specific observable side effect.
- **Discriminator:** delete the `__keepalive__` branch — new test must fail; restore → passes. Same for `__trace__` and `_meta` branches.
- **Entry points / files:**
  - `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` (lines 266-274, 277-292, 358-365)
  - `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` — extend

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

### SD-09 — Private-state peek pattern in unit tests
- **Severity:** P3 (cosmetic naming coupling; low-priority tidy)
- **Source:** `upp:test-reviewer` retro review #1 architectural nitpick
- **Symptom:** Three unit tests use `(instance as unknown as { _field })._field` to read private state: `_sessionWindowId`, `useTcp`, `circuitBreaker`. Any rename or relocation of these fields breaks every test for purely cosmetic reasons.
- **Current understanding (from review):** expose read-only getters on the SUT (`getSessionWindowId()`, `isTcpMode()`, `getCircuitBreaker()`), have tests read through them. The SUT owns the contract; refactors don't break the tests. This is a skill-factory-grade pattern worth seeding.
- **Discriminator:** refactor `_sessionWindowId` to a sub-object on server — existing tests would all break; post-fix tests via `getSessionWindowId()` keep passing because the getter's contract is preserved.
- **Entry points / files:**
  - `src/server.ts` — add `getSessionWindowId()`, `getCircuitBreaker()`
  - `src/engines/daemon.ts` — add `isTcpMode()`
  - `test/unit/server/ensure-session-window.test.ts`, `test/unit/server/record-tool-failure.test.ts`, `test/unit/engines/daemon.test.ts` — swap peeks for getter calls

---

## Resolved

_(none yet)_

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
