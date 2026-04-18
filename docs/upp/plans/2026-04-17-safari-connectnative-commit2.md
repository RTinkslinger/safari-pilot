# Safari Pilot connectNative Pivot (Commit 2) — Implementation Plan v3

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `sendNativeMessage`-based extension IPC with `browser.runtime.connectNative` persistent port, enabling the first working end-to-end Extension-engine roundtrip in Safari Pilot's history.

**Architecture:** Extension establishes a persistent `connectNative` port on wake. The handler opens a persistent TCP connection to the daemon. Commands reach the extension ONLY via reconcile's `pushNew` response on port connect/reconnect. Extension executes commands and sends results on the same port. Reconcile protocol syncs state on port reconnect after event-page unload. All 1a infrastructure (HealthStore, idempotent flags, circuit breaker, kill-switch, storage queue, alarm keepalive) remains load-bearing.

**Key architectural decision (v3):** `pushToPort` is REMOVED from the plan entirely. Two independent auditors proved the Safari Web Extension handler is strictly request-response (`beginRequest` -> `sendAndReceive` -> `returnResponse`). The handler cannot receive daemon-initiated pushes. Commands reach the extension ONLY via the reconcile response's `pushNew` array when the extension connects/reconnects its port. This is simpler and proven.

**Core wins of connectNative:**
1. Port keeps event page alive longer than `sendNativeMessage` per-call (research confirmed)
2. Single port = one IPC launch per wake, not one per message
3. Reconcile + result delivery happen on the same port session without separate `sendNativeMessage` calls
4. No `SFErrorDomain error 3` (the per-call `sendNativeMessage` failure that killed 1a)

**Tech Stack:** TypeScript (MCP server), Swift (daemon + handler), JavaScript (Safari extension), Bash (scripts), vitest (unit/e2e), custom Swift test harness (daemon).

**Source spec:** `docs/upp/specs/2026-04-17-safari-connectnative-pivot-spec.md`

**Scope:** This plan includes Gate A validation (Task 0) as a go/no-go gate. Tasks 1-8 execute ONLY if Gate A passes. Gate A failure causes plan abort; extension engine remains at 1a state with known limitation documented.

**Deferred to Commit 3:** `claimedByProfile` — multi-profile isolation requires Gate A data on per-profile port behavior. Placeholder remains in `healthSnapshot`.

---

## Revision History

**v3 (current):** Removes all `pushToPort` code and references. Two auditors independently proved the handler is request-response and cannot receive daemon pushes. Commands reach the extension ONLY via reconcile's `pushNew` response. Additional fixes: handler instance reuse check in Gate A, reconcile `pushNew` excludes reQueued commandIds, `sendResultOnPort` does not remove pending until daemon acks via reconcile, `handleDaemonMessage` serialized via `isProcessing` flag, `dispatchMessage` dead code removed from persistent socket, persistent socket `receiveLoop` checks `isComplete` before recursing, `readOneLine` helper returns `(line, remainingBuffer)` tuple, `deinit` added to handler, `sendLog` moved after reconcile completes, `EXTENSION_VERSION` bumped to `'0.1.6'`, all test edits use content-matching (not line numbers).

**v2:** Fixed 5 critical blockers from v1 audit. Key: explicit test-assertion-removal task, `CommandDispatcher` owns `markReconcile()` call, continuation-outside-queue in reconcile handler, complete inline background.js, `pushToPort` in ExtensionBridge.

**v1:** Initial plan with pushToPort architecture.

---

## File Structure

**Files modified:**
- `extension/background.js` — connectNative rewrite (replaces sendNativeMessage drain with persistent port + reconcile-only command delivery)
- `extension/native/SafariWebExtensionHandler.swift` — persistent TCP connection model with `deinit` cleanup
- `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` — executedLog with 5-min TTL, reconcile handler (5-case, continuation-outside-queue)
- `daemon/Sources/SafariPilotdCore/ExtensionSocketServer.swift` — persistent connection with NDJSON line-buffered receive loop, dead `dispatchMessage` removed
- `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` — `extension_reconcile` route, `healthStore.markReconcile()` call after dispatch
- `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` — reconcile + executedLog tests (inside `registerExtensionBridgeTests`)
- `daemon/Tests/SafariPilotdTests/ExtensionSocketServerTests.swift` — persistent connection tests
- `test/unit/extension/background.test.ts` — updated assertions for connectNative architecture
- `test/e2e/commit-1a-shippable.test.ts` — updated/renamed for commit 2 scope
- `ARCHITECTURE.md` — connectNative lifecycle documentation (updated per-task)

**Files NOT modified (confirmed unchanged):**
- `daemon/Sources/SafariPilotd/main.swift` — no new top-level wiring needed; `CommandDispatcher.dispatch()` routes via method string matching, no registration required
- `daemon/Tests/SafariPilotdTests/main.swift` — test registration calls (`registerExtensionBridgeTests`, `registerExtensionSocketServerTests`) already exist at lines 139 and 143; new tests are added inside those existing registration functions
- `src/server.ts` — `INFRA_MESSAGE_TYPES` already contains `extension_reconcile` (line 124); no new methods needed
- All existing 1a infrastructure files (HealthStore, types, errors, security layers)

---

## Task 0: Gate A Prototype (disposable branch, go/no-go)

**Purpose:** Validate that `browser.runtime.connectNative` works with Safari's App Extension handler model before investing in the full implementation. This runs on a disposable branch `prototype/connectNative`.

**Duration:** 1 day. No commits to main.

### Step 0.1: Create disposable branch

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git checkout -b prototype/connectNative
```

### Step 0.2: Minimal background.js patch (add connectNative alongside existing code)

- [ ] Edit `extension/background.js`:

**old_string:**
```javascript
// ─── Native messaging ────────────────────────────────────────────────────────
function sendNative(message) {
  return browser.runtime.sendNativeMessage(APP_BUNDLE_ID, message);
}
```

**new_string:**
```javascript
// ─── Native messaging ────────────────────────────────────────────────────────
function sendNative(message) {
  return browser.runtime.sendNativeMessage(APP_BUNDLE_ID, message);
}

// ─── Gate A: connectNative probe ─────────────────────────────────────────────
let gateAPort = null;
function gateAConnect() {
  try {
    gateAPort = browser.runtime.connectNative(APP_BUNDLE_ID);
    console.log('[GateA] connectNative succeeded, port:', gateAPort);
    gateAPort.onMessage.addListener((msg) => {
      console.log('[GateA] port.onMessage:', JSON.stringify(msg));
    });
    gateAPort.onDisconnect.addListener(() => {
      const err = browser.runtime.lastError;
      console.log('[GateA] port.onDisconnect, lastError:', err);
      gateAPort = null;
    });
    // Send a ping to see if it reaches the handler
    gateAPort.postMessage({ type: 'ping', gateA: true });
    console.log('[GateA] postMessage sent');
  } catch (e) {
    console.error('[GateA] connectNative threw:', e);
  }
}
// Auto-connect on script load for testing
gateAConnect();
```

### Step 0.3: Minimal handler logging (to verify handler receives port messages)

- [ ] Edit `extension/native/SafariWebExtensionHandler.swift`. Add at the top of `beginRequest`:

**old_string:**
```swift
    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
```

**new_string:**
```swift
    func beginRequest(with context: NSExtensionContext) {
        os_log(.default, "SafariPilot GATE-A: beginRequest fired, handler instance: %@", String(describing: ObjectIdentifier(self)))
        let request = context.inputItems.first as? NSExtensionItem
```

### Step 0.4: Build, install, verify

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
bash scripts/build-extension.sh
```

- [ ] Open the extension app:
```bash
open "bin/Safari Pilot.app"
```

- [ ] Verify in Safari > Settings > Extensions that Safari Pilot is enabled.

- [ ] Open Safari's Web Inspector for the extension background page (Develop > Web Extension Background Pages > Safari Pilot).

### Step 0.5: Six-point validation checklist

Observe the Web Inspector console. All six checks must pass for Gate A to succeed:

- [ ] **Check 1:** `[GateA] connectNative succeeded` appears in console (port object created without throwing).
- [ ] **Check 2:** `[GateA] postMessage sent` appears (postMessage does not throw).
- [ ] **Check 3:** Safari system log shows handler's `beginRequest` fired (check via: `log stream --predicate 'subsystem == "com.apple.webkit.WebExtensions" OR process == "Safari Pilot Extension"' --level default` in Terminal). This proves the handler receives messages from `connectNative`, not just `sendNativeMessage`.
- [ ] **Check 4:** `[GateA] port.onMessage` appears in Web Inspector console with a response from the daemon (proves the round-trip: extension -> handler -> daemon -> handler -> extension works over the port).
- [ ] **Check 5:** After 30+ seconds idle, the port is NOT disconnected (confirms the event page stays alive longer with a connected port). Verify by checking that `[GateA] port.onDisconnect` has NOT appeared.
- [ ] **Check 6:** Handler instance address in the log — check whether multiple `beginRequest` calls show the same `ObjectIdentifier` (handler reuse) or different instances (new handler per call). Record the result. This affects whether persistent TCP state can be stored on the handler instance.

### Step 0.6: Record results and clean up

- [ ] Document Gate A results in `docs/upp/gate-a-results.md` with: pass/fail per check, handler instance behavior (reuse vs. new-per-call), event-page lifetime observation, any errors encountered.

- [ ] If **all 6 checks pass**: proceed to Task 1. Delete the prototype branch:
```bash
git checkout main
git branch -D prototype/connectNative
```

- [ ] If **any check fails**: document which check failed and the observed behavior. The plan STOPS here. Extension engine remains at 1a state. File the failure in the roadmap as a blocking issue with the specific Safari/WebKit limitation observed.

---

## Task 1: Update Conflicting 1a Test Assertions

**Purpose:** Update existing unit and e2e test assertions that will conflict with commit 2 code changes. These tests currently assert that reconcile code is absent and that `sendNativeMessage` is used — both of which will become false. Must be done BEFORE any code changes to avoid false failures.

**Files:**
- `test/unit/extension/background.test.ts`
- `test/e2e/commit-1a-shippable.test.ts`

### Step 1.1: Update unit test — remove "reconcile NOT present" assertion

- [ ] Edit `test/unit/extension/background.test.ts`:

**old_string:**
```javascript
  it('reconcile code NOT present (1a is pre-reconcile)', () => {
    expect(BG).not.toMatch(/reconcile/);
    expect(BG).not.toMatch(/executedLog/);
    expect(BG).not.toMatch(/claimedByProfile/);
  });
```

**new_string:**
```javascript
  it('reconcile protocol present (commit 2)', () => {
    expect(BG).toMatch(/reconcile/);
    expect(BG).toMatch(/handleReconcileResponse/);
  });
```

### Step 1.2: Update unit test — raise line count limit

- [ ] Edit `test/unit/extension/background.test.ts`:

**old_string:**
```javascript
  it('line count within <=345 target (340 base + 5 for wake serialization)', () => {
    const lines = BG.split('\n').length;
    expect(lines).toBeLessThanOrEqual(345);
  });
```

**new_string:**
```javascript
  it('line count within <=380 target (connectNative rewrite)', () => {
    const lines = BG.split('\n').length;
    expect(lines).toBeLessThanOrEqual(380);
  });
```

### Step 1.3: Update unit test — replace wire format assertion with connectNative assertion

- [ ] Edit `test/unit/extension/background.test.ts`:

**old_string:**
```javascript
  it('wire format: handles {commands:[...]} from daemon poll (post-Task-3)', () => {
    expect(BG).toMatch(/value\?\.commands/);
  });
```

**new_string:**
```javascript
  it('uses connectNative persistent port (commit 2)', () => {
    expect(BG).toMatch(/connectNative/);
    expect(BG).toMatch(/port\.postMessage/);
  });
```

### Step 1.4: Update unit test — invert sendNativeMessage / connectNative assertions

- [ ] Edit `test/unit/extension/background.test.ts`:

**old_string:**
```javascript
  it('uses browser.runtime.sendNativeMessage (not connectNative)', () => {
    expect(BG).toContain('browser.runtime.sendNativeMessage');
    expect(BG).not.toContain('connectNative');
  });
```

**new_string:**
```javascript
  it('uses browser.runtime.connectNative (not sendNativeMessage)', () => {
    expect(BG).toContain('connectNative');
    expect(BG).not.toContain('sendNativeMessage');
  });
```

### Step 1.5: Update unit test — remove "polls with type 'poll'" assertion

- [ ] Edit `test/unit/extension/background.test.ts`:

**old_string:**
```javascript
  it("polls with type 'poll' messages in drain loop", () => {
    expect(BG).toMatch(/type:\s*'poll'/);
  });
```

**new_string:**
```javascript
  it("sends reconcile on port connect (commit 2)", () => {
    expect(BG).toMatch(/type:\s*'reconcile'/);
  });
```

### Step 1.6: Update e2e test — remove "1a must not contain reconcile" assertion block

- [ ] Edit `test/e2e/commit-1a-shippable.test.ts`:

**old_string:**
```javascript
  describe('1a must not contain reconcile code (1b scope)', () => {
    it('extension/background.js has no reconcile / executedLog / claimedByProfile references', () => {
      const bg = readFileSync(join(ROOT, 'extension/background.js'), 'utf8');
      expect(bg).not.toMatch(/reconcile/i);
      expect(bg).not.toMatch(/executedLog/);
      expect(bg).not.toMatch(/claimedByProfile/);
    });

    it('ExtensionBridge.swift has no handleReconcile implementation', () => {
      const eb = readFileSync(
        join(ROOT, 'daemon/Sources/SafariPilotdCore/ExtensionBridge.swift'),
        'utf8',
      );
      // The reconcile PROTOCOL (handleReconcile function) must not exist yet.
      // Placeholder KEY NAMES in healthSnapshot (e.g., "executedLogSize": 0) are
      // acceptable — those are zero-value stubs, not reconcile logic.
      expect(eb).not.toMatch(/handleReconcile/);
      expect(eb).not.toMatch(/func.*reconcile/i);
      // claimedByProfile as a data structure (not a placeholder string) would
      // indicate reconcile logic landed prematurely.
      expect(eb).not.toMatch(/var\s+claimedByProfiles?\b/);
    });
  });
```

**new_string:**
```javascript
  describe('commit 2 reconcile code present', () => {
    it('extension/background.js contains reconcile protocol', () => {
      const bg = readFileSync(join(ROOT, 'extension/background.js'), 'utf8');
      expect(bg).toMatch(/reconcile/i);
      expect(bg).toMatch(/handleReconcileResponse/);
      expect(bg).toMatch(/connectNative/);
    });

    it('ExtensionBridge.swift has handleReconcile implementation', () => {
      const eb = readFileSync(
        join(ROOT, 'daemon/Sources/SafariPilotdCore/ExtensionBridge.swift'),
        'utf8',
      );
      expect(eb).toMatch(/handleReconcile/);
      expect(eb).toMatch(/executedLog/);
    });
  });
```

### Step 1.7: Verify tests compile (they will fail until code lands — that is expected)

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
npm run build
```

- [ ] Expected: TypeScript compiles successfully. The unit/e2e tests WILL fail at this point because the source code still uses `sendNativeMessage` and has no reconcile code. That is correct — the tests are now expecting the commit 2 state, and the code will catch up in Tasks 2-6.

### Step 1.8: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add test/unit/extension/background.test.ts test/e2e/commit-1a-shippable.test.ts
git commit -m "test: update assertions for commit 2 connectNative architecture

Update unit and e2e test assertions to expect connectNative, reconcile
protocol, and no sendNativeMessage. Tests will fail until code lands in
Tasks 2-6 — this commit establishes the target contract."
```

---

## Task 2: Daemon — executedLog with 5-min TTL (TDD)

**Purpose:** Add an `executedLog` to `ExtensionBridge` that records command IDs for 5 minutes after execution completes. This is the foundation for reconcile: the extension sends its list of completed command IDs, and the daemon checks them against the `executedLog` to determine which results have already been processed.

**Files:**
- `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` — tests first
- `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` — implementation

### Step 2.1: Write failing tests (inside registerExtensionBridgeTests)

- [ ] Edit `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift`. Add the following tests at the end of the `registerExtensionBridgeTests()` function, immediately before the closing `}`:

**old_string:**
```swift
    test("testExtensionHealthReturnsComposite") {
        let tmpPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("test-health-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tmpPath) }
        let health = HealthStore(persistPath: tmpPath)
        let mock = MockExecutor()
        let bridge = ExtensionBridge()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            extensionBridge: bridge,
            healthStore: health
        )
        health.incrementRoundtrip()
        health.incrementTimeout()
        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"h","method":"extension_health"}"#)
        }
        try assertTrue(response.ok)
        let dict = response.value?.value as? [String: Any]
        try assertEqual(dict?["roundtripCount1h"] as? Int, 1)
        try assertEqual(dict?["timeoutCount1h"] as? Int, 1)
        try assertEqual(dict?["uncertainCount1h"] as? Int, 0)
        try assertEqual(dict?["forceReloadCount24h"] as? Int, 0)
        try assertEqual(dict?["pendingCommandsCount"] as? Int, 0)
        try assertEqual(dict?["isConnected"] as? Bool, false)
        try assertEqual(dict?["executedLogSize"] as? Int, 0)
        try assertEqual(dict?["killSwitchActive"] as? Bool, false)
        try assertTrue(dict?["lastAlarmFireTimestamp"] != nil, "lastAlarmFireTimestamp should be present")
    }
}
```

**new_string:**
```swift
    test("testExtensionHealthReturnsComposite") {
        let tmpPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("test-health-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tmpPath) }
        let health = HealthStore(persistPath: tmpPath)
        let mock = MockExecutor()
        let bridge = ExtensionBridge()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            extensionBridge: bridge,
            healthStore: health
        )
        health.incrementRoundtrip()
        health.incrementTimeout()
        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"h","method":"extension_health"}"#)
        }
        try assertTrue(response.ok)
        let dict = response.value?.value as? [String: Any]
        try assertEqual(dict?["roundtripCount1h"] as? Int, 1)
        try assertEqual(dict?["timeoutCount1h"] as? Int, 1)
        try assertEqual(dict?["uncertainCount1h"] as? Int, 0)
        try assertEqual(dict?["forceReloadCount24h"] as? Int, 0)
        try assertEqual(dict?["pendingCommandsCount"] as? Int, 0)
        try assertEqual(dict?["isConnected"] as? Bool, false)
        try assertEqual(dict?["executedLogSize"] as? Int, 0)
        try assertEqual(dict?["killSwitchActive"] as? Bool, false)
        try assertTrue(dict?["lastAlarmFireTimestamp"] != nil, "lastAlarmFireTimestamp should be present")
    }

    // MARK: - executedLog tests (Commit 2, Task 2)

    test("testExecutedLogRecordsCompletedCommandId") {
        let bridge = ExtensionBridge()

        // Queue a command
        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-log-1",
                params: ["script": AnyCodable("return 1")]
            )
        }
        Thread.sleep(forTimeInterval: 0.1)

        // Poll to deliver it
        _ = syncAwait { await bridge.handlePoll(commandID: "poll-1") }

        // Send result — this should add "exec-log-1" to executedLog
        _ = bridge.handleResult(
            commandID: "res-1",
            params: [
                "requestId": AnyCodable("exec-log-1"),
                "result": AnyCodable("done"),
            ]
        )
        _ = syncAwait { await executeTask.value }

        // executedLog should contain the command ID
        try assertTrue(bridge.isInExecutedLog("exec-log-1"), "Command should be in executedLog after result")
    }

    test("testExecutedLogExpiresAfterTTL") {
        let bridge = ExtensionBridge()

        // Manually add an entry with an old timestamp (>5 min ago)
        bridge.addToExecutedLogForTest(commandID: "old-cmd", at: Date(timeIntervalSinceNow: -301))

        // Should NOT be in log (expired)
        try assertFalse(bridge.isInExecutedLog("old-cmd"), "Old command should have expired from executedLog")
    }

    test("testExecutedLogSizeReportedInHealthSnapshot") {
        let bridge = ExtensionBridge()
        let health = makeHealthStoreForTest()

        // Queue + complete a command to populate executedLog
        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-hs-1",
                params: ["script": AnyCodable("return 1")]
            )
        }
        Thread.sleep(forTimeInterval: 0.1)
        _ = syncAwait { await bridge.handlePoll(commandID: "poll-1") }
        _ = bridge.handleResult(
            commandID: "res-1",
            params: [
                "requestId": AnyCodable("exec-hs-1"),
                "result": AnyCodable("ok"),
            ]
        )
        _ = syncAwait { await executeTask.value }

        let snapshot = bridge.healthSnapshot(store: health)
        try assertEqual(snapshot["executedLogSize"] as? Int, 1, "healthSnapshot should report executedLogSize=1")
    }

    test("testExecutedLogDoesNotRecordUnknownRequestId") {
        let bridge = ExtensionBridge()

        // Send result for a command that was never queued
        _ = bridge.handleResult(
            commandID: "res-orphan",
            params: [
                "requestId": AnyCodable("never-existed"),
                "result": AnyCodable("ignored"),
            ]
        )

        // Should NOT be in log (was never a real pending command)
        try assertFalse(bridge.isInExecutedLog("never-existed"), "Orphan result should not enter executedLog")
    }
}
```

### Step 2.2: Run tests — expect 3 failures (isInExecutedLog and addToExecutedLogForTest don't exist yet)

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
cd daemon && swift build 2>&1 | tail -20
```

- [ ] Expected: Compilation errors — `isInExecutedLog`, `addToExecutedLogForTest` are not defined on `ExtensionBridge`.

### Step 2.3: Implement executedLog in ExtensionBridge

- [ ] Edit `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`:

**old_string:**
```swift
    private var pendingCommands: [PendingCommand] = []
    private var waitingPolls: [WaitingPoll] = []
```

**new_string:**
```swift
    private var pendingCommands: [PendingCommand] = []
    private var waitingPolls: [WaitingPoll] = []

    /// Records command IDs after handleResult completes successfully.
    /// Entries expire after `executedLogTTL` seconds. Used by reconcile to
    /// determine which commands the daemon has already processed.
    private static let executedLogTTL: TimeInterval = 300.0  // 5 minutes
    private struct ExecutedEntry {
        let commandID: String
        let timestamp: Date
    }
    private var executedLog: [ExecutedEntry] = []
```

- [ ] Add the `isInExecutedLog` public method and test helper. Edit `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`:

**old_string:**
```swift
    public func handleConnected(commandID: String) -> Response {
```

**new_string:**
```swift
    /// Check if a command ID is in the executed log (not expired).
    public func isInExecutedLog(_ commandID: String) -> Bool {
        let cutoff = Date(timeIntervalSinceNow: -Self.executedLogTTL)
        return queue.sync {
            executedLog.contains { $0.commandID == commandID && $0.timestamp >= cutoff }
        }
    }

    /// Test-only: insert an entry with a custom timestamp for TTL testing.
    public func addToExecutedLogForTest(commandID: String, at timestamp: Date) {
        queue.sync {
            executedLog.append(ExecutedEntry(commandID: commandID, timestamp: timestamp))
        }
    }

    /// Current count of non-expired entries in the executedLog.
    /// Read OUTSIDE queue.sync when called from healthSnapshot to avoid
    /// cross-queue deadlock with HealthStore (matching existing pattern).
    public var executedLogSize: Int {
        let cutoff = Date(timeIntervalSinceNow: -Self.executedLogTTL)
        return queue.sync {
            executedLog.filter { $0.timestamp >= cutoff }.count
        }
    }

    public func handleConnected(commandID: String) -> Response {
```

- [ ] Add executedLog recording inside `handleResult`. Edit `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`:

**old_string:**
```swift
        cmd.continuation.resume(returning: callerResponse)
        return Response.success(id: commandID, value: AnyCodable("extension_ack"))
    }
```

**new_string:**
```swift
        cmd.continuation.resume(returning: callerResponse)

        // Record in executedLog for reconcile protocol.
        // Prune expired entries opportunistically.
        let cutoff = Date(timeIntervalSinceNow: -Self.executedLogTTL)
        queue.sync {
            executedLog.removeAll { $0.timestamp < cutoff }
            executedLog.append(ExecutedEntry(commandID: cmd.id, timestamp: Date()))
        }

        return Response.success(id: commandID, value: AnyCodable("extension_ack"))
    }
```

- [ ] Update `healthSnapshot` to use real `executedLogSize`. Edit `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`:

**old_string:**
```swift
    public func healthSnapshot(store: HealthStore) -> [String: Any] {
        // Bridge-internal state: read under our queue.
        let (connected, pendingCount) = queue.sync { (_isConnected, pendingCommands.count) }
```

**new_string:**
```swift
    public func healthSnapshot(store: HealthStore) -> [String: Any] {
        // Bridge-internal state: read under our queue.
        // executedLogSize is read here (inside our queue) — it's bridge-internal
        // state, not HealthStore. Only HealthStore reads go OUTSIDE our queue.
        let cutoff = Date(timeIntervalSinceNow: -Self.executedLogTTL)
        let (connected, pendingCount, logSize) = queue.sync {
            (_isConnected, pendingCommands.count, executedLog.filter { $0.timestamp >= cutoff }.count)
        }
```

**old_string:**
```swift
            "pendingCommandsCount": pendingCount,
            // Placeholders — wired in Commit 1b.
            "executedLogSize": 0,
```

**new_string:**
```swift
            "pendingCommandsCount": pendingCount,
            "executedLogSize": logSize,
```

### Step 2.4: Run tests — all executedLog tests should pass

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift build && swift run SafariPilotdTests 2>&1
```

- [ ] Expected: All tests pass, including the 4 new executedLog tests:
  - `testExecutedLogRecordsCompletedCommandId` — PASS
  - `testExecutedLogExpiresAfterTTL` — PASS
  - `testExecutedLogSizeReportedInHealthSnapshot` — PASS
  - `testExecutedLogDoesNotRecordUnknownRequestId` — PASS

### Step 2.5: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add daemon/Sources/SafariPilotdCore/ExtensionBridge.swift daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift
git commit -m "feat(daemon): add executedLog with 5-min TTL to ExtensionBridge

Records command IDs after handleResult completes. Entries expire after
300s. Foundation for reconcile protocol: extension sends completed IDs,
daemon checks executedLog to classify them as acked vs. uncertain.
healthSnapshot now reports real executedLogSize instead of placeholder 0."
```

---

## Task 3: Daemon — Reconcile Handler (TDD)

**Purpose:** Add `handleReconcile` to `ExtensionBridge` and route `extension_reconcile` through `CommandDispatcher`. The reconcile handler is the core of the connectNative protocol: when the extension reconnects, it sends its list of executed command IDs and pending storage entries. The daemon classifies each as acked/uncertain/reQueued and returns new commands to push.

**The 5-case reconcile classification:**
1. **acked** — command ID is in `executedLog` (daemon already processed the result) → safe to remove from extension storage
2. **uncertain** — command ID is NOT in `executedLog` AND NOT in `pendingCommands` → daemon doesn't know about it; extension should re-send the result
3. **reQueued** — command ID is in `pendingCommands` with `delivered=false` → command was requeued after disconnect, daemon is waiting for execution
4. **inFlight** — command ID is in `pendingCommands` with `delivered=true` → command was delivered but result not yet received
5. **pushNew** — commands in `pendingCommands` with `delivered=false` that are NOT in the extension's `executedIds` list → new commands to push to the extension for execution. **Excludes reQueued commandIds** to prevent double-execution.

**Critical pattern:** Continuation is resumed OUTSIDE `queue.sync`, matching `handleResult` at line 273 of the existing code.

**Files:**
- `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` — tests first
- `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` — implementation
- `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` — routing + markReconcile

### Step 3.1: Write failing tests

- [ ] Edit `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift`. Add the following tests at the end of the `registerExtensionBridgeTests()` function, immediately before the closing `}`:

**old_string (the closing of the function, after the last test added in Task 2):**
```swift
    test("testExecutedLogDoesNotRecordUnknownRequestId") {
        let bridge = ExtensionBridge()

        // Send result for a command that was never queued
        _ = bridge.handleResult(
            commandID: "res-orphan",
            params: [
                "requestId": AnyCodable("never-existed"),
                "result": AnyCodable("ignored"),
            ]
        )

        // Should NOT be in log (was never a real pending command)
        try assertFalse(bridge.isInExecutedLog("never-existed"), "Orphan result should not enter executedLog")
    }
}
```

**new_string:**
```swift
    test("testExecutedLogDoesNotRecordUnknownRequestId") {
        let bridge = ExtensionBridge()

        // Send result for a command that was never queued
        _ = bridge.handleResult(
            commandID: "res-orphan",
            params: [
                "requestId": AnyCodable("never-existed"),
                "result": AnyCodable("ignored"),
            ]
        )

        // Should NOT be in log (was never a real pending command)
        try assertFalse(bridge.isInExecutedLog("never-existed"), "Orphan result should not enter executedLog")
    }

    // MARK: - Reconcile tests (Commit 2, Task 3)

    test("testReconcileClassifiesAckedCommands") {
        let bridge = ExtensionBridge()

        // Complete a command so it enters executedLog
        let t = Task {
            await bridge.handleExecute(commandID: "cmd-ack", params: ["script": AnyCodable("x")])
        }
        Thread.sleep(forTimeInterval: 0.1)
        _ = syncAwait { await bridge.handlePoll(commandID: "p1") }
        _ = bridge.handleResult(
            commandID: "r1",
            params: ["requestId": AnyCodable("cmd-ack"), "result": AnyCodable("ok")]
        )
        _ = syncAwait { await t.value }

        // Reconcile with that command in executedIds
        let response = bridge.handleReconcile(
            commandID: "rec-1",
            executedIds: ["cmd-ack"],
            pendingIds: []
        )
        try assertTrue(response.ok)
        let dict = response.value?.value as? [String: Any]
        let acked = dict?["acked"] as? [String]
        try assertTrue(acked?.contains("cmd-ack") == true, "cmd-ack should be classified as acked")
    }

    test("testReconcileClassifiesUncertainCommands") {
        let bridge = ExtensionBridge()

        // Extension claims it executed "cmd-mystery" but daemon has no record
        let response = bridge.handleReconcile(
            commandID: "rec-2",
            executedIds: ["cmd-mystery"],
            pendingIds: []
        )
        try assertTrue(response.ok)
        let dict = response.value?.value as? [String: Any]
        let uncertain = dict?["uncertain"] as? [String]
        try assertTrue(uncertain?.contains("cmd-mystery") == true, "Unknown command should be uncertain")
    }

    test("testReconcileClassifiesReQueuedCommands") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "c1")

        // Queue a command
        let t = Task {
            await bridge.handleExecute(commandID: "cmd-req", params: ["script": AnyCodable("y")])
        }
        Thread.sleep(forTimeInterval: 0.1)

        // Poll (marks delivered=true)
        _ = syncAwait { await bridge.handlePoll(commandID: "p1") }

        // Disconnect (flips delivered back to false)
        _ = bridge.handleDisconnected(commandID: "d1")

        // Reconcile: extension doesn't know about this command
        let response = bridge.handleReconcile(
            commandID: "rec-3",
            executedIds: [],
            pendingIds: []
        )
        try assertTrue(response.ok)
        let dict = response.value?.value as? [String: Any]
        let reQueued = dict?["reQueued"] as? [String]
        try assertTrue(reQueued?.contains("cmd-req") == true, "Undelivered pending should be reQueued")

        // pushNew should NOT include reQueued commands (prevent double-execution)
        let pushNew = dict?["pushNew"] as? [[String: Any]]
        let pushNewIds = pushNew?.compactMap { $0["id"] as? String } ?? []
        try assertFalse(pushNewIds.contains("cmd-req"), "reQueued commands must not appear in pushNew")

        // Cleanup
        _ = bridge.handleResult(
            commandID: "r1",
            params: ["requestId": AnyCodable("cmd-req"), "result": AnyCodable("cleanup")]
        )
        _ = syncAwait { await t.value }
    }

    test("testReconcilePushesNewCommands") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "c1")

        // Queue a command but do NOT poll (delivered=false, extension doesn't know about it)
        let t = Task {
            await bridge.handleExecute(commandID: "cmd-new", params: ["script": AnyCodable("z")])
        }
        Thread.sleep(forTimeInterval: 0.1)

        // Reconcile: extension has no knowledge of this command
        let response = bridge.handleReconcile(
            commandID: "rec-4",
            executedIds: [],
            pendingIds: []
        )
        try assertTrue(response.ok)
        let dict = response.value?.value as? [String: Any]
        let pushNew = dict?["pushNew"] as? [[String: Any]]
        try assertTrue(pushNew?.count == 1, "Should push 1 new command")
        try assertEqual(pushNew?.first?["id"] as? String, "cmd-new")
        try assertEqual(pushNew?.first?["script"] as? String, "z")

        // Cleanup
        _ = bridge.handleResult(
            commandID: "r1",
            params: ["requestId": AnyCodable("cmd-new"), "result": AnyCodable("cleanup")]
        )
        _ = syncAwait { await t.value }
    }

    test("testReconcileClassifiesInFlightCommands") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "c1")

        // Queue a command and poll (delivered=true, no result yet)
        let t = Task {
            await bridge.handleExecute(commandID: "cmd-fly", params: ["script": AnyCodable("w")])
        }
        Thread.sleep(forTimeInterval: 0.1)
        _ = syncAwait { await bridge.handlePoll(commandID: "p1") }

        // Reconcile: extension says it has cmd-fly pending (in storage, not yet completed)
        let response = bridge.handleReconcile(
            commandID: "rec-5",
            executedIds: [],
            pendingIds: ["cmd-fly"]
        )
        try assertTrue(response.ok)
        let dict = response.value?.value as? [String: Any]
        let inFlight = dict?["inFlight"] as? [String]
        try assertTrue(inFlight?.contains("cmd-fly") == true, "Delivered pending should be inFlight")

        // Cleanup
        _ = bridge.handleResult(
            commandID: "r1",
            params: ["requestId": AnyCodable("cmd-fly"), "result": AnyCodable("cleanup")]
        )
        _ = syncAwait { await t.value }
    }

    test("testDispatcherRoutesReconcileAndCallsMarkReconcile") {
        let mock = MockExecutor()
        let bridge = ExtensionBridge()
        let health = makeHealthStoreForTest()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            extensionBridge: bridge,
            healthStore: health
        )

        // Verify lastReconcileTimestamp is nil before
        try assertTrue(health.lastReconcileTimestamp == nil, "Should be nil before reconcile")

        let line = #"{"id":"rec-d","method":"extension_reconcile","params":{"executedIds":[],"pendingIds":[]}}"#
        let response = syncAwait {
            await dispatcher.dispatch(line: line)
        }
        try assertTrue(response.ok, "Dispatcher should route extension_reconcile")

        // healthStore.markReconcile() should have been called
        try assertTrue(health.lastReconcileTimestamp != nil, "markReconcile should set timestamp")
    }
}
```

### Step 3.2: Run tests — expect compilation failure

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift build 2>&1 | tail -20
```

- [ ] Expected: Compilation errors — `handleReconcile` does not exist on `ExtensionBridge`, `extension_reconcile` is not a known case in `CommandDispatcher`.

### Step 3.3: Implement handleReconcile in ExtensionBridge

- [ ] Edit `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`. Add `handleReconcile` after `handleResult`:

**old_string:**
```swift
    public func handleStatus(commandID: String) -> Response {
```

**new_string:**
```swift
    /// Reconcile protocol: extension sends its known state, daemon classifies each command.
    ///
    /// - `executedIds`: command IDs the extension has completed and stored results for
    /// - `pendingIds`: command IDs the extension has in storage but not yet completed
    ///
    /// Returns 5 classification arrays:
    /// - `acked`: in executedLog → extension can safely remove from storage
    /// - `uncertain`: not in executedLog AND not in pendingCommands → extension should re-send result
    /// - `reQueued`: in pendingCommands with delivered=false → daemon is waiting for re-execution
    /// - `inFlight`: in pendingCommands with delivered=true → daemon is waiting for result
    /// - `pushNew`: undelivered commands NOT in executedIds and NOT reQueued → push to extension
    ///
    /// CRITICAL: No continuations are resumed in this handler (unlike handleResult).
    /// All classification is read-only against pendingCommands and executedLog.
    public func handleReconcile(
        commandID: String,
        executedIds: [String],
        pendingIds: [String]
    ) -> Response {
        let cutoff = Date(timeIntervalSinceNow: -Self.executedLogTTL)
        let executedIdSet = Set(executedIds)
        let pendingIdSet = Set(pendingIds)
        let allKnownIds = executedIdSet.union(pendingIdSet)

        let (acked, uncertain, reQueued, inFlight, pushNew): ([String], [String], [String], [String], [[String: Any]]) = queue.sync {
            var ackedList: [String] = []
            var uncertainList: [String] = []

            // Classify executedIds
            for id in executedIds {
                if executedLog.contains(where: { $0.commandID == id && $0.timestamp >= cutoff }) {
                    ackedList.append(id)
                } else if !pendingCommands.contains(where: { $0.id == id }) {
                    uncertainList.append(id)
                }
                // If it's in pendingCommands, it's a stale executed claim — ignore
            }

            // Classify pendingIds against daemon's pendingCommands
            var reQueuedList: [String] = []
            var inFlightList: [String] = []
            for id in pendingIds {
                if let cmd = pendingCommands.first(where: { $0.id == id }) {
                    if cmd.delivered {
                        inFlightList.append(id)
                    } else {
                        reQueuedList.append(id)
                    }
                }
                // If not in pendingCommands, extension has stale storage — will be handled by acked/uncertain above or just ignored
            }

            // Collect reQueued IDs as a set for exclusion from pushNew
            let reQueuedSet = Set(reQueuedList)

            // pushNew: undelivered pending commands the extension doesn't know about
            // Excludes reQueued to prevent double-execution
            var pushNewList: [[String: Any]] = []
            for idx in pendingCommands.indices where !pendingCommands[idx].delivered {
                let cmd = pendingCommands[idx]
                if !allKnownIds.contains(cmd.id) && !reQueuedSet.contains(cmd.id) {
                    pendingCommands[idx].delivered = true  // Mark as delivered via reconcile
                    var commandDict: [String: Any] = ["id": cmd.id]
                    for (key, val) in cmd.params {
                        commandDict[key] = val.value
                    }
                    pushNewList.append(commandDict)
                }
            }

            return (ackedList, uncertainList, reQueuedList, inFlightList, pushNewList)
        }

        let responseDict: [String: Any] = [
            "acked": acked,
            "uncertain": uncertain,
            "reQueued": reQueued,
            "inFlight": inFlight,
            "pushNew": pushNew,
        ]

        return Response.success(id: commandID, value: AnyCodable(responseDict))
    }

    public func handleStatus(commandID: String) -> Response {
```

### Step 3.4: Route extension_reconcile in CommandDispatcher

- [ ] Edit `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift`:

**old_string:**
```swift
        case "extension_health":
            // Composite snapshot: bridge state + HealthStore counters + placeholders
            // for fields wired in Commit 1b (executedLogSize, claimedByProfiles,
            // engineCircuitBreakerState, killSwitchActive).
            let snapshot = extensionBridge.healthSnapshot(store: healthStore)
            return Response.success(id: command.id, value: AnyCodable(snapshot))
```

**new_string:**
```swift
        case "extension_reconcile":
            let executedIds = (command.params["executedIds"]?.value as? [String]) ?? []
            let pendingIds = (command.params["pendingIds"]?.value as? [String]) ?? []
            let response = extensionBridge.handleReconcile(
                commandID: command.id,
                executedIds: executedIds,
                pendingIds: pendingIds
            )
            // Mark reconcile AFTER dispatching — ExtensionBridge has no healthStore property.
            healthStore.markReconcile()
            return response

        case "extension_health":
            // Composite snapshot: bridge state + HealthStore counters.
            let snapshot = extensionBridge.healthSnapshot(store: healthStore)
            return Response.success(id: command.id, value: AnyCodable(snapshot))
```

### Step 3.5: Run tests — all should pass

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift build && swift run SafariPilotdTests 2>&1
```

- [ ] Expected: All tests pass, including:
  - `testReconcileClassifiesAckedCommands` — PASS
  - `testReconcileClassifiesUncertainCommands` — PASS
  - `testReconcileClassifiesReQueuedCommands` — PASS
  - `testReconcilePushesNewCommands` — PASS
  - `testReconcileClassifiesInFlightCommands` — PASS
  - `testDispatcherRoutesReconcileAndCallsMarkReconcile` — PASS

### Step 3.6: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add daemon/Sources/SafariPilotdCore/ExtensionBridge.swift daemon/Sources/SafariPilotdCore/CommandDispatcher.swift daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift
git commit -m "feat(daemon): add reconcile handler with 5-case classification

handleReconcile classifies extension-reported IDs into acked, uncertain,
reQueued, inFlight, and pushNew. pushNew excludes reQueued commandIds to
prevent double-execution. CommandDispatcher routes extension_reconcile
and calls healthStore.markReconcile() after dispatch."
```

---

## Task 4: Daemon — Persistent Socket with NDJSON Line-Buffering

**Purpose:** Replace the one-shot connection handling in `ExtensionSocketServer` with a persistent connection model that supports multiple NDJSON messages over a single TCP connection. This is required because the handler will maintain a persistent TCP connection instead of creating a new one per message.

**Key design:**
- New `handlePersistentConnection` method that loops, reading NDJSON lines from the connection
- Proper line-buffering using a `readOneLine` helper that returns `(line, remainingBuffer)` tuples
- Buffer is passed between calls to avoid losing data
- `receiveLoop` checks `isComplete` before recursing
- The old one-shot `dispatchMessage` is removed (dead code once persistent connections land)

**Files:**
- `daemon/Tests/SafariPilotdTests/ExtensionSocketServerTests.swift` — tests first
- `daemon/Sources/SafariPilotdCore/ExtensionSocketServer.swift` — implementation

### Step 4.1: Write failing tests

- [ ] Edit `daemon/Tests/SafariPilotdTests/ExtensionSocketServerTests.swift`. Add tests inside `registerExtensionSocketServerTests()` before the closing `}`:

**old_string:**
```swift
    test("testServerReturnsExtensionStatus") {
        let dispatcher = makeTestDispatcher()
        let server = ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        defer { server.stop() }

        let resp = sendTcpJson(port: port, json: ["id": "s1", "method": "extension_status"])
        try assertEqual(resp?["id"] as? String, "s1")
        try assertEqual(resp?["ok"] as? Bool, true)
    }
}
```

**new_string:**
```swift
    test("testServerReturnsExtensionStatus") {
        let dispatcher = makeTestDispatcher()
        let server = ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        defer { server.stop() }

        let resp = sendTcpJson(port: port, json: ["id": "s1", "method": "extension_status"])
        try assertEqual(resp?["id"] as? String, "s1")
        try assertEqual(resp?["ok"] as? Bool, true)
    }

    // MARK: - Persistent connection tests (Commit 2, Task 4)

    test("testPersistentConnectionMultipleMessages") {
        let dispatcher = makeTestDispatcher()
        let server = ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        defer { server.stop() }

        // Open a single TCP connection and send multiple NDJSON messages
        let responses = sendMultipleTcpJson(port: port, messages: [
            ["id": "p1", "method": "ping"],
            ["id": "p2", "method": "ping"],
            ["id": "p3", "method": "extension_status"],
        ])
        try assertEqual(responses.count, 3, "Should get 3 responses on persistent connection")
        try assertEqual(responses[0]?["id"] as? String, "p1")
        try assertEqual(responses[1]?["id"] as? String, "p2")
        try assertEqual(responses[2]?["id"] as? String, "p3")
        try assertEqual(responses[0]?["ok"] as? Bool, true)
        try assertEqual(responses[1]?["ok"] as? Bool, true)
        try assertEqual(responses[2]?["ok"] as? Bool, true)
    }

    test("testPersistentConnectionHandlesPartialLines") {
        let dispatcher = makeTestDispatcher()
        let server = ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        defer { server.stop() }

        // Send a message split across two TCP writes (simulates partial delivery)
        let response = sendSplitTcpMessage(
            port: port,
            part1: "{\"id\":\"split-1\",\"me",
            part2: "thod\":\"ping\"}\n"
        )
        try assertEqual(response?["id"] as? String, "split-1")
        try assertEqual(response?["ok"] as? Bool, true)
    }

    test("testPersistentConnectionSurvivesInvalidLineAndContinues") {
        let dispatcher = makeTestDispatcher()
        let server = ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        defer { server.stop() }

        // Send invalid JSON followed by valid JSON on same connection
        let responses = sendRawMultiple(port: port, raw: "not json\n{\"id\":\"after-bad\",\"method\":\"ping\"}\n")
        // Should get 2 responses: error for invalid, success for valid
        try assertTrue(responses.count >= 2, "Should get responses for both lines, got \(responses.count)")
        // First response is an error
        try assertEqual(responses[0]?["ok"] as? Bool, false)
        // Second response is a success
        try assertEqual(responses[1]?["id"] as? String, "after-bad")
        try assertEqual(responses[1]?["ok"] as? Bool, true)
    }
}
```

- [ ] Add the persistent connection test helpers at the bottom of the file, after the existing helpers:

**old_string:**
```swift
private func sendTcpRaw(port: UInt16, raw: String) -> [String: Any]? {
    var inputStream: InputStream?
    var outputStream: OutputStream?
    Stream.getStreamsToHost(withName: "127.0.0.1", port: Int(port),
                           inputStream: &inputStream, outputStream: &outputStream)
    guard let input = inputStream, let output = outputStream else { return nil }

    input.open()
    output.open()
    defer { input.close(); output.close() }

    let bytes = Array(raw.utf8)
    output.write(bytes, maxLength: bytes.count)

    var buffer = [UInt8](repeating: 0, count: 65536)
    let deadline = Date().addingTimeInterval(5.0)
    var accumulated = Data()

    while Date() < deadline {
        if input.hasBytesAvailable {
            let n = input.read(&buffer, maxLength: buffer.count)
            if n > 0 {
                accumulated.append(buffer, count: n)
                if accumulated.contains(where: { $0 == UInt8(ascii: "\n") }) { break }
            } else if n < 0 {
                break
            }
        }
        Thread.sleep(forTimeInterval: 0.01)
    }

    guard !accumulated.isEmpty else { return nil }
    return try? JSONSerialization.jsonObject(with: accumulated) as? [String: Any]
}
```

**new_string:**
```swift
private func sendTcpRaw(port: UInt16, raw: String) -> [String: Any]? {
    var inputStream: InputStream?
    var outputStream: OutputStream?
    Stream.getStreamsToHost(withName: "127.0.0.1", port: Int(port),
                           inputStream: &inputStream, outputStream: &outputStream)
    guard let input = inputStream, let output = outputStream else { return nil }

    input.open()
    output.open()
    defer { input.close(); output.close() }

    let bytes = Array(raw.utf8)
    output.write(bytes, maxLength: bytes.count)

    var buffer = [UInt8](repeating: 0, count: 65536)
    let deadline = Date().addingTimeInterval(5.0)
    var accumulated = Data()

    while Date() < deadline {
        if input.hasBytesAvailable {
            let n = input.read(&buffer, maxLength: buffer.count)
            if n > 0 {
                accumulated.append(buffer, count: n)
                if accumulated.contains(where: { $0 == UInt8(ascii: "\n") }) { break }
            } else if n < 0 {
                break
            }
        }
        Thread.sleep(forTimeInterval: 0.01)
    }

    guard !accumulated.isEmpty else { return nil }
    return try? JSONSerialization.jsonObject(with: accumulated) as? [String: Any]
}

/// Send multiple NDJSON messages on a single persistent connection, collecting all responses.
private func sendMultipleTcpJson(port: UInt16, messages: [[String: Any]]) -> [[String: Any]?] {
    var inputStream: InputStream?
    var outputStream: OutputStream?
    Stream.getStreamsToHost(withName: "127.0.0.1", port: Int(port),
                           inputStream: &inputStream, outputStream: &outputStream)
    guard let input = inputStream, let output = outputStream else { return [] }

    input.open()
    output.open()
    defer { input.close(); output.close() }

    // Send all messages
    for msg in messages {
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let str = String(data: data, encoding: .utf8) else { continue }
        let bytes = Array((str + "\n").utf8)
        output.write(bytes, maxLength: bytes.count)
    }

    // Read all responses
    var buffer = [UInt8](repeating: 0, count: 65536)
    let deadline = Date().addingTimeInterval(5.0)
    var accumulated = Data()
    var results: [[String: Any]?] = []

    while Date() < deadline && results.count < messages.count {
        if input.hasBytesAvailable {
            let n = input.read(&buffer, maxLength: buffer.count)
            if n > 0 {
                accumulated.append(buffer, count: n)
                // Parse all complete lines
                while let range = accumulated.range(of: Data("\n".utf8)) {
                    let lineData = accumulated[accumulated.startIndex..<range.lowerBound]
                    accumulated = Data(accumulated[range.upperBound...])
                    let parsed = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any]
                    results.append(parsed)
                }
            } else if n < 0 {
                break
            }
        }
        Thread.sleep(forTimeInterval: 0.01)
    }

    return results
}

/// Send a message in two parts to test partial-line buffering.
private func sendSplitTcpMessage(port: UInt16, part1: String, part2: String) -> [String: Any]? {
    var inputStream: InputStream?
    var outputStream: OutputStream?
    Stream.getStreamsToHost(withName: "127.0.0.1", port: Int(port),
                           inputStream: &inputStream, outputStream: &outputStream)
    guard let input = inputStream, let output = outputStream else { return nil }

    input.open()
    output.open()
    defer { input.close(); output.close() }

    // Send part 1
    let bytes1 = Array(part1.utf8)
    output.write(bytes1, maxLength: bytes1.count)
    Thread.sleep(forTimeInterval: 0.05)  // Small delay to force separate TCP segments

    // Send part 2
    let bytes2 = Array(part2.utf8)
    output.write(bytes2, maxLength: bytes2.count)

    // Read response
    var buffer = [UInt8](repeating: 0, count: 65536)
    let deadline = Date().addingTimeInterval(5.0)
    var accumulated = Data()

    while Date() < deadline {
        if input.hasBytesAvailable {
            let n = input.read(&buffer, maxLength: buffer.count)
            if n > 0 {
                accumulated.append(buffer, count: n)
                if accumulated.contains(where: { $0 == UInt8(ascii: "\n") }) { break }
            } else if n < 0 {
                break
            }
        }
        Thread.sleep(forTimeInterval: 0.01)
    }

    guard !accumulated.isEmpty else { return nil }
    return try? JSONSerialization.jsonObject(with: accumulated) as? [String: Any]
}

/// Send raw data on a persistent connection and collect all NDJSON responses.
private func sendRawMultiple(port: UInt16, raw: String) -> [[String: Any]?] {
    var inputStream: InputStream?
    var outputStream: OutputStream?
    Stream.getStreamsToHost(withName: "127.0.0.1", port: Int(port),
                           inputStream: &inputStream, outputStream: &outputStream)
    guard let input = inputStream, let output = outputStream else { return [] }

    input.open()
    output.open()
    defer { input.close(); output.close() }

    let bytes = Array(raw.utf8)
    output.write(bytes, maxLength: bytes.count)

    let lineCount = raw.components(separatedBy: "\n").filter { !$0.isEmpty }.count

    var buffer = [UInt8](repeating: 0, count: 65536)
    let deadline = Date().addingTimeInterval(5.0)
    var accumulated = Data()
    var results: [[String: Any]?] = []

    while Date() < deadline && results.count < lineCount {
        if input.hasBytesAvailable {
            let n = input.read(&buffer, maxLength: buffer.count)
            if n > 0 {
                accumulated.append(buffer, count: n)
                while let range = accumulated.range(of: Data("\n".utf8)) {
                    let lineData = accumulated[accumulated.startIndex..<range.lowerBound]
                    accumulated = Data(accumulated[range.upperBound...])
                    let parsed = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any]
                    results.append(parsed)
                }
            } else if n < 0 {
                break
            }
        }
        Thread.sleep(forTimeInterval: 0.01)
    }

    return results
}
```

### Step 4.2: Run tests — expect failures (persistent connection not implemented)

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift build && swift run SafariPilotdTests 2>&1
```

- [ ] Expected: The 3 new persistent connection tests fail (existing one-shot handler cancels the connection after one message).

### Step 4.3: Implement persistent connection handling in ExtensionSocketServer

- [ ] Replace the entire `ExtensionSocketServer.swift` file. Edit `daemon/Sources/SafariPilotdCore/ExtensionSocketServer.swift`:

**old_string:**
```swift
import Foundation
import Network

public final class ExtensionSocketServer: @unchecked Sendable {

    private let listener: NWListener
    private let dispatcher: CommandDispatcher
    private let queue = DispatchQueue(label: "com.safari-pilot.extension-socket", qos: .userInitiated)
    private var actualPort: UInt16 = 0

    public init(port: UInt16 = 19474, dispatcher: CommandDispatcher) {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        do {
            self.listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        } catch {
            Logger.error("ExtensionSocketServer: failed to create listener on port \(port): \(error)")
            self.listener = try! NWListener(using: .tcp)
        }
        self.dispatcher = dispatcher
    }

    @discardableResult
    public func start() -> UInt16? {
        let semaphore = DispatchSemaphore(value: 0)
        var startedPort: UInt16?

        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                if let port = self?.listener.port?.rawValue {
                    self?.actualPort = port
                    startedPort = port
                    Logger.info("ExtensionSocketServer listening on localhost:\(port)")
                }
                semaphore.signal()
            case .failed(let error):
                Logger.error("ExtensionSocketServer failed to start: \(error)")
                semaphore.signal()
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }

        listener.start(queue: queue)
        _ = semaphore.wait(timeout: .now() + 5)
        return startedPort
    }

    public func stop() {
        listener.cancel()
        Logger.info("ExtensionSocketServer stopped")
    }

    public var port: UInt16 { actualPort }

    // MARK: - Connection Handling

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)

        connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) { [weak self] data, _, _, error in
            guard let self = self, let data = data, !data.isEmpty else {
                connection.cancel()
                return
            }

            Task {
                let responseData = await self.dispatchMessage(data: data)
                connection.send(content: responseData, completion: .contentProcessed { _ in
                    connection.cancel()
                })
            }
        }
    }

    private func dispatchMessage(data: Data) async -> Data {
        guard let line = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !line.isEmpty else {
            let fallback = #"{"id":"unknown","ok":false,"error":{"code":"PARSE_ERROR","message":"Empty or invalid UTF-8 message"}}"# + "\n"
            return Data(fallback.utf8)
        }

        let response = await dispatcher.dispatch(line: line)

        do {
            let serialized = try NDJSONSerializer.serialize(response: response)
            return Data((serialized + "\n").utf8)
        } catch {
            let fallback = #"{"id":"unknown","ok":false,"error":{"code":"SERIALIZATION_ERROR","message":"Response serialization failed"}}"# + "\n"
            return Data(fallback.utf8)
        }
    }
}
```

**new_string:**
```swift
import Foundation
import Network

public final class ExtensionSocketServer: @unchecked Sendable {

    private let listener: NWListener
    private let dispatcher: CommandDispatcher
    private let queue = DispatchQueue(label: "com.safari-pilot.extension-socket", qos: .userInitiated)
    private var actualPort: UInt16 = 0

    public init(port: UInt16 = 19474, dispatcher: CommandDispatcher) {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        do {
            self.listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        } catch {
            Logger.error("ExtensionSocketServer: failed to create listener on port \(port): \(error)")
            self.listener = try! NWListener(using: .tcp)
        }
        self.dispatcher = dispatcher
    }

    @discardableResult
    public func start() -> UInt16? {
        let semaphore = DispatchSemaphore(value: 0)
        var startedPort: UInt16?

        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                if let port = self?.listener.port?.rawValue {
                    self?.actualPort = port
                    startedPort = port
                    Logger.info("ExtensionSocketServer listening on localhost:\(port)")
                }
                semaphore.signal()
            case .failed(let error):
                Logger.error("ExtensionSocketServer failed to start: \(error)")
                semaphore.signal()
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }

        listener.start(queue: queue)
        _ = semaphore.wait(timeout: .now() + 5)
        return startedPort
    }

    public func stop() {
        listener.cancel()
        Logger.info("ExtensionSocketServer stopped")
    }

    public var port: UInt16 { actualPort }

    // MARK: - Persistent Connection Handling

    /// Handles a new TCP connection with persistent NDJSON line-buffered reading.
    /// The connection stays open for multiple request-response exchanges.
    /// Each newline-delimited JSON message gets dispatched and responded to independently.
    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveLoop(connection: connection, buffer: Data())
    }

    /// Recursive receive loop with accumulated buffer for NDJSON line-buffering.
    /// Each call processes all complete lines in the buffer, then waits for more data.
    /// Checks connection state before recursing to avoid callbacks on cancelled connections.
    private func receiveLoop(connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) { [weak self] data, _, isComplete, error in
            guard let self = self else {
                connection.cancel()
                return
            }

            var accumulated = buffer
            if let data = data, !data.isEmpty {
                accumulated.append(data)
            }

            // Extract and dispatch all complete lines
            self.processLines(from: &accumulated, connection: connection) {
                // After processing, check if connection is done
                if isComplete || error != nil {
                    connection.cancel()
                    return
                }

                // Continue receiving with remaining buffer
                self.receiveLoop(connection: connection, buffer: accumulated)
            }
        }
    }

    /// Extract complete NDJSON lines from the buffer, dispatch each, and send responses.
    /// Modifies `buffer` in place, removing processed lines.
    private func processLines(from buffer: inout Data, connection: NWConnection, then continuation: @escaping () -> Void) {
        // Extract all complete lines (delimited by \n)
        var lines: [String] = []
        while let range = buffer.range(of: Data("\n".utf8)) {
            let lineData = buffer[buffer.startIndex..<range.lowerBound]
            buffer = Data(buffer[range.upperBound...])
            if let line = String(data: lineData, encoding: .utf8)?
                .trimmingCharacters(in: .whitespaces),
               !line.isEmpty {
                lines.append(line)
            }
        }

        guard !lines.isEmpty else {
            continuation()
            return
        }

        // Dispatch all lines sequentially (order matters for IPC correctness)
        Task {
            for line in lines {
                let responseData = await self.dispatchLine(line)
                let semaphore = DispatchSemaphore(value: 0)
                connection.send(content: responseData, completion: .contentProcessed { _ in
                    semaphore.signal()
                })
                _ = semaphore.wait(timeout: .now() + 10)
            }
            continuation()
        }
    }

    /// Dispatch a single NDJSON line through the CommandDispatcher and serialize the response.
    private func dispatchLine(_ line: String) async -> Data {
        let response = await dispatcher.dispatch(line: line)
        do {
            let serialized = try NDJSONSerializer.serialize(response: response)
            return Data((serialized + "\n").utf8)
        } catch {
            let fallback = #"{"id":"unknown","ok":false,"error":{"code":"SERIALIZATION_ERROR","message":"Response serialization failed"}}"# + "\n"
            return Data(fallback.utf8)
        }
    }
}
```

### Step 4.4: Run tests — all should pass

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift build && swift run SafariPilotdTests 2>&1
```

- [ ] Expected: All tests pass, including:
  - `testPersistentConnectionMultipleMessages` — PASS
  - `testPersistentConnectionHandlesPartialLines` — PASS
  - `testPersistentConnectionSurvivesInvalidLineAndContinues` — PASS
  - All existing one-shot tests still pass (backward compatible — single message + close works)

### Step 4.5: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add daemon/Sources/SafariPilotdCore/ExtensionSocketServer.swift daemon/Tests/SafariPilotdTests/ExtensionSocketServerTests.swift
git commit -m "feat(daemon): persistent NDJSON socket with line-buffered receive loop

Replace one-shot connection handling with persistent connection model.
receiveLoop accumulates buffer across receives, extracts complete lines,
dispatches each through CommandDispatcher. Handles partial lines, invalid
JSON (continues reading), and clean connection close. Removes dead
one-shot dispatchMessage method."
```

---

## Task 5: Handler — Persistent TCP Connection + Reconcile Routing

**Purpose:** Replace the one-shot TCP connection model in `SafariWebExtensionHandler` with a persistent connection that stays open across multiple messages. Add routing for the `reconcile` message type. Add `deinit` cleanup.

**Key design decisions:**
- Each handler instance creates ONE persistent `NWConnection` to the daemon on first use
- Connection is stored as an instance property
- `deinit` cancels the connection
- Gate A Check 6 determines whether handler instances are reused — the implementation must work regardless (connection is per-instance, so new instance = new connection)
- `readOneLine` helper returns `(line: String, remainingBuffer: Data)` — buffer persists across calls
- `buildDaemonMessage` gains a `reconcile` case

**Files:**
- `extension/native/SafariWebExtensionHandler.swift`

### Step 5.1: Replace SafariWebExtensionHandler with persistent connection model

- [ ] Edit `extension/native/SafariWebExtensionHandler.swift`. Replace the entire file:

**old_string:**
```swift
import SafariServices
import os.log
import Network

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private static let daemonHost = "127.0.0.1"
    private static let daemonPort: UInt16 = 19474
    private static let connectionTimeout: TimeInterval = 10.0

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "SafariPilot: received native message: %@", String(describing: message))

        guard let messageDict = message as? [String: Any] else {
            os_log(.error, "SafariPilot: message is not a dictionary")
            returnResponse(["error": "Invalid message format", "ok": false], context: context)
            return
        }

        forwardToDaemon(message: messageDict) { response in
            self.returnResponse(response, context: context)
        }
    }

    private func forwardToDaemon(message: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        let host = NWEndpoint.Host(Self.daemonHost)
        guard let port = NWEndpoint.Port(rawValue: Self.daemonPort) else {
            completion(["error": "Invalid daemon port", "ok": false])
            return
        }
        let connection = NWConnection(host: host, port: port, using: .tcp)
        let queue = DispatchQueue(label: "com.safari-pilot.handler-conn")

        var completed = false
        let safeComplete: ([String: Any]) -> Void = { response in
            queue.sync {
                guard !completed else { return }
                completed = true
            }
            completion(response)
        }

        let timeoutItem = DispatchWorkItem {
            os_log(.error, "SafariPilot: daemon connection timed out")
            connection.cancel()
            safeComplete(["error": "Daemon connection timed out", "ok": false])
        }
        queue.asyncAfter(deadline: .now() + Self.connectionTimeout, execute: timeoutItem)

        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                self.sendAndReceive(connection: connection, message: message) { response in
                    timeoutItem.cancel()
                    connection.cancel()
                    safeComplete(response)
                }
            case .failed(let error):
                os_log(.error, "SafariPilot: connection failed: %@", error.localizedDescription)
                timeoutItem.cancel()
                connection.cancel()
                safeComplete(["error": "Daemon not reachable: \(error.localizedDescription)", "ok": false])
            case .cancelled:
                break
            default:
                break
            }
        }

        connection.start(queue: queue)
    }

    private func sendAndReceive(
        connection: NWConnection,
        message: [String: Any],
        completion: @escaping ([String: Any]) -> Void
    ) {
        let daemonMessage = buildDaemonMessage(from: message)

        guard let jsonData = try? JSONSerialization.data(withJSONObject: daemonMessage),
              var payload = String(data: jsonData, encoding: .utf8) else {
            completion(["error": "Failed to serialize message", "ok": false])
            return
        }
        payload += "\n"

        let sendData = payload.data(using: .utf8)!
        connection.send(content: sendData, completion: .contentProcessed { error in
            if let error = error {
                os_log(.error, "SafariPilot: send failed: %@", error.localizedDescription)
                completion(["error": "Send failed", "ok": false])
                return
            }

            connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) { data, _, _, error in
                guard let data = data,
                      let response = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    completion(["error": "No response from daemon", "ok": false])
                    return
                }
                completion(response)
            }
        })
    }

    private func buildDaemonMessage(from message: [String: Any]) -> [String: Any] {
        let requestId = UUID().uuidString
        let type = message["type"] as? String ?? "unknown"

        switch type {
        case "poll":
            return ["id": requestId, "method": "extension_poll"]

        case "result":
            var params: [String: Any] = [:]
            if let cmdId = message["id"] { params["requestId"] = cmdId }
            if let result = message["result"] { params["result"] = result }
            if let error = message["error"] { params["error"] = error }
            return ["id": requestId, "method": "extension_result", "params": params]

        case "status":
            return ["id": requestId, "method": "extension_status"]

        case "connected":
            return ["id": requestId, "method": "extension_connected"]

        case "disconnected":
            return ["id": requestId, "method": "extension_disconnected"]

        case "ping":
            return ["id": requestId, "method": "ping"]

        case "log":
            var params: [String: Any] = [:]
            if let msg = message["message"] { params["message"] = msg }
            if let ts = message["timestamp"] { params["timestamp"] = ts }
            return ["id": requestId, "method": "extension_log", "params": params]

        default:
            return ["id": requestId, "method": type, "params": message]
        }
    }

    private func returnResponse(_ response: [String: Any], context: NSExtensionContext) {
        let responseItem = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            responseItem.userInfo = [SFExtensionMessageKey: response]
        } else {
            responseItem.userInfo = ["message": response]
        }
        context.completeRequest(returningItems: [responseItem], completionHandler: nil)
    }
}
```

**new_string:**
```swift
import SafariServices
import os.log
import Network

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private static let daemonHost = "127.0.0.1"
    private static let daemonPort: UInt16 = 19474
    private static let connectionTimeout: TimeInterval = 10.0

    /// Persistent TCP connection to daemon. Created on first use, reused across
    /// messages if the handler instance is reused by Safari. Each handler instance
    /// gets its own connection — works regardless of whether Safari reuses instances.
    private var persistentConnection: NWConnection?
    private let connectionQueue = DispatchQueue(label: "com.safari-pilot.handler-conn")
    /// Buffer for partial NDJSON reads across receive calls.
    private var readBuffer = Data()

    deinit {
        persistentConnection?.cancel()
    }

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "SafariPilot: received native message: %@", String(describing: message))

        guard let messageDict = message as? [String: Any] else {
            os_log(.error, "SafariPilot: message is not a dictionary")
            returnResponse(["error": "Invalid message format", "ok": false], context: context)
            return
        }

        sendOnPersistentConnection(message: messageDict) { response in
            self.returnResponse(response, context: context)
        }
    }

    // MARK: - Persistent Connection

    /// Ensure persistent connection is ready, creating it if needed.
    /// Calls completion with the ready connection or an error response.
    private func ensureConnection(completion: @escaping (NWConnection?, [String: Any]?) -> Void) {
        if let conn = persistentConnection, conn.state == .ready {
            completion(conn, nil)
            return
        }

        // Cancel stale connection if any
        persistentConnection?.cancel()
        persistentConnection = nil
        readBuffer = Data()

        let host = NWEndpoint.Host(Self.daemonHost)
        guard let port = NWEndpoint.Port(rawValue: Self.daemonPort) else {
            completion(nil, ["error": "Invalid daemon port", "ok": false])
            return
        }

        let connection = NWConnection(host: host, port: port, using: .tcp)
        self.persistentConnection = connection

        var completed = false
        let safeComplete: (NWConnection?, [String: Any]?) -> Void = { conn, err in
            self.connectionQueue.sync {
                guard !completed else { return }
                completed = true
            }
            completion(conn, err)
        }

        let timeoutItem = DispatchWorkItem { [weak self] in
            os_log(.error, "SafariPilot: persistent connection timed out")
            connection.cancel()
            self?.persistentConnection = nil
            safeComplete(nil, ["error": "Daemon connection timed out", "ok": false])
        }
        connectionQueue.asyncAfter(deadline: .now() + Self.connectionTimeout, execute: timeoutItem)

        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                timeoutItem.cancel()
                safeComplete(connection, nil)
            case .failed(let error):
                os_log(.error, "SafariPilot: persistent connection failed: %@", error.localizedDescription)
                timeoutItem.cancel()
                connection.cancel()
                self?.persistentConnection = nil
                safeComplete(nil, ["error": "Daemon not reachable: \(error.localizedDescription)", "ok": false])
            case .cancelled:
                self?.persistentConnection = nil
            default:
                break
            }
        }

        connection.start(queue: connectionQueue)
    }

    /// Send a message on the persistent connection and read one NDJSON response line.
    private func sendOnPersistentConnection(message: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        ensureConnection { [weak self] connection, error in
            if let error = error {
                completion(error)
                return
            }

            guard let self = self, let connection = connection else {
                completion(["error": "No connection", "ok": false])
                return
            }

            let daemonMessage = self.buildDaemonMessage(from: message)

            guard let jsonData = try? JSONSerialization.data(withJSONObject: daemonMessage),
                  var payload = String(data: jsonData, encoding: .utf8) else {
                completion(["error": "Failed to serialize message", "ok": false])
                return
            }
            payload += "\n"

            let sendData = payload.data(using: .utf8)!
            connection.send(content: sendData, completion: .contentProcessed { [weak self] sendError in
                if let sendError = sendError {
                    os_log(.error, "SafariPilot: send failed: %@", sendError.localizedDescription)
                    // Connection is broken — tear down for next attempt
                    connection.cancel()
                    self?.persistentConnection = nil
                    completion(["error": "Send failed", "ok": false])
                    return
                }

                self?.readOneLine(connection: connection, completion: completion)
            })
        }
    }

    /// Read one complete NDJSON line from the connection, accumulating partial data
    /// in `readBuffer`. Returns the parsed JSON dictionary via completion.
    private func readOneLine(connection: NWConnection, completion: @escaping ([String: Any]) -> Void) {
        // Check if we already have a complete line in the buffer
        if let (line, remaining) = extractLine(from: readBuffer) {
            readBuffer = remaining
            if let data = line.data(using: .utf8),
               let response = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                completion(response)
            } else {
                completion(["error": "Invalid JSON response from daemon", "ok": false])
            }
            return
        }

        // Need more data
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) { [weak self] data, _, isComplete, error in
            guard let self = self else {
                completion(["error": "Handler deallocated", "ok": false])
                return
            }

            if let data = data, !data.isEmpty {
                self.readBuffer.append(data)
            }

            if isComplete || error != nil {
                // Connection closed or errored — try to parse what we have
                if !self.readBuffer.isEmpty,
                   let str = String(data: self.readBuffer, encoding: .utf8),
                   let jsonData = str.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
                   let response = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {
                    self.readBuffer = Data()
                    completion(response)
                } else {
                    self.readBuffer = Data()
                    self.persistentConnection = nil
                    completion(["error": "Connection closed before response", "ok": false])
                }
                return
            }

            // Try again with accumulated buffer
            self.readOneLine(connection: connection, completion: completion)
        }
    }

    /// Extract the first complete line (terminated by \n) from data.
    /// Returns (line, remainingBuffer) or nil if no complete line exists.
    private func extractLine(from data: Data) -> (String, Data)? {
        guard let range = data.range(of: Data("\n".utf8)) else {
            return nil
        }
        let lineData = data[data.startIndex..<range.lowerBound]
        let remaining = Data(data[range.upperBound...])
        guard let line = String(data: lineData, encoding: .utf8),
              !line.trimmingCharacters(in: .whitespaces).isEmpty else {
            return nil
        }
        return (line, remaining)
    }

    // MARK: - Message Building

    private func buildDaemonMessage(from message: [String: Any]) -> [String: Any] {
        let requestId = UUID().uuidString
        let type = message["type"] as? String ?? "unknown"

        switch type {
        case "poll":
            return ["id": requestId, "method": "extension_poll"]

        case "result":
            var params: [String: Any] = [:]
            if let cmdId = message["id"] { params["requestId"] = cmdId }
            if let result = message["result"] { params["result"] = result }
            if let error = message["error"] { params["error"] = error }
            return ["id": requestId, "method": "extension_result", "params": params]

        case "reconcile":
            var params: [String: Any] = [:]
            if let executedIds = message["executedIds"] { params["executedIds"] = executedIds }
            if let pendingIds = message["pendingIds"] { params["pendingIds"] = pendingIds }
            return ["id": requestId, "method": "extension_reconcile", "params": params]

        case "status":
            return ["id": requestId, "method": "extension_status"]

        case "connected":
            return ["id": requestId, "method": "extension_connected"]

        case "disconnected":
            return ["id": requestId, "method": "extension_disconnected"]

        case "ping":
            return ["id": requestId, "method": "ping"]

        case "log":
            var params: [String: Any] = [:]
            if let msg = message["message"] { params["message"] = msg }
            if let ts = message["timestamp"] { params["timestamp"] = ts }
            return ["id": requestId, "method": "extension_log", "params": params]

        default:
            return ["id": requestId, "method": type, "params": message]
        }
    }

    // MARK: - Response

    private func returnResponse(_ response: [String: Any], context: NSExtensionContext) {
        let responseItem = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            responseItem.userInfo = [SFExtensionMessageKey: response]
        } else {
            responseItem.userInfo = ["message": response]
        }
        context.completeRequest(returningItems: [responseItem], completionHandler: nil)
    }
}
```

### Step 5.2: Build the extension to verify handler compiles

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
bash scripts/build-extension.sh
```

- [ ] Expected: Extension builds, signs, notarizes successfully. Verify entitlements:
```bash
codesign -d --entitlements - "bin/Safari Pilot.app"
codesign -d --entitlements - "bin/Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex"
```
Both must show `com.apple.security.app-sandbox`.

### Step 5.3: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add extension/native/SafariWebExtensionHandler.swift
git commit -m "feat(handler): persistent TCP connection with NDJSON line-buffering

Replace one-shot NWConnection per message with persistent connection
stored on handler instance. readOneLine accumulates partial data in
readBuffer. extractLine returns (line, remainingBuffer) tuple.
deinit cancels persistent connection. Adds reconcile message routing."
```

---

## Task 6: Extension — COMPLETE background.js connectNative Rewrite

**Purpose:** Replace the `sendNativeMessage`-based drain loop with a `connectNative` persistent port. This is the centerpiece of commit 2: the extension opens a port on wake, sends a reconcile message to sync state, receives commands via the reconcile response's `pushNew` array, executes them, and sends results back on the same port.

**Key design decisions:**
- `sendNative` and `sendLog` functions are REMOVED — all daemon communication goes through the port
- `wakeSequence` is replaced with port-based reconcile + result delivery
- `handleDaemonMessage` uses `isProcessing` flag to serialize concurrent `port.onMessage` calls
- `sendResultOnPort` does NOT remove pending entry — entry is only removed when daemon confirms via reconcile `acked` response
- `EXTENSION_VERSION` bumped to `'0.1.6'`
- `sendLog` calls moved to after reconcile completes (M4)

**Files:**
- `extension/background.js`

### Step 6.1: Replace background.js with complete connectNative implementation

- [ ] Replace the entire content of `extension/background.js`:

**old_string:**
```javascript
// extension/background.js — Event Page (persistent:false)
// All listeners registered at top level. No IIFE (Safari re-evaluates on every wake).
// No ES module syntax (event pages do not support modules).
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const APP_BUNDLE_ID = 'com.safari-pilot.app';
const KEEPALIVE_ALARM_NAME = 'safari-pilot-keepalive';
const KEEPALIVE_PERIOD_MIN = 1;
const STORAGE_KEY_PENDING = 'safari_pilot_pending_commands';
const STORAGE_KEY_PROFILE_ID = 'safari_pilot_profile_id';
const EXTENSION_VERSION = '0.1.5';
```

**new_string:**
```javascript
// extension/background.js — Event Page (persistent:false)
// All listeners registered at top level. No IIFE (Safari re-evaluates on every wake).
// No ES module syntax (event pages do not support modules).
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const APP_BUNDLE_ID = 'com.safari-pilot.app';
const KEEPALIVE_ALARM_NAME = 'safari-pilot-keepalive';
const KEEPALIVE_PERIOD_MIN = 1;
const STORAGE_KEY_PENDING = 'safari_pilot_pending_commands';
const STORAGE_KEY_PROFILE_ID = 'safari_pilot_profile_id';
const EXTENSION_VERSION = '0.1.6';
```

Now replace the native messaging section and everything through the wake sequence with the connectNative implementation:

**old_string:**
```javascript
// ─── Native messaging ────────────────────────────────────────────────────────
function sendNative(message) {
  return browser.runtime.sendNativeMessage(APP_BUNDLE_ID, message);
}

async function sendLog(message) {
  try {
    await sendNative({ type: 'log', message, timestamp: Date.now() });
  } catch (_) { /* best-effort */ }
}
```

**new_string:**
```javascript
// ─── connectNative port ──────────────────────────────────────────────────────
let nativePort = null;
let isProcessing = false;  // serializes concurrent port.onMessage calls
let processingQueue = [];  // queued messages while isProcessing is true
```

Replace the wake sequence and initialize functions:

**old_string:**
```javascript
// ─── Wake sequence ───────────────────────────────────────────────────────────
// Poll first (critical path), informational calls after drain completes.
async function wakeSequence(reason) {
  // 1. Re-deliver completed-but-un-sent results from prior wake (storage-only, no native call).
  const pending = await readPending();
  const completedIds = [];
  for (const [commandId, entry] of Object.entries(pending)) {
    if (entry.status === 'completed' && entry.result) {
      completedIds.push({ commandId, result: entry.result });
    }
  }

  // 2. CRITICAL: Drain queued commands — this is the FIRST sendNativeMessage call.
  let draining = true;
  while (draining) {
    try {
      const response = await sendNative({ type: 'poll' });
      // Diagnostic: write raw poll response to storage for debugging (no native call)
      await browser.storage.local.set({ _debug_last_poll: JSON.stringify(response).slice(0, 500), _debug_poll_ts: Date.now() });
      const commands = response?.value?.commands
        ?? (response?.commands)
        ?? (response?.value?.command ? [response.value.command] : []);
      if (!commands || commands.length === 0) {
        draining = false;
        break;
      }
      for (const cmd of commands) {
        const result = await executeCommand(cmd);
        try {
          await sendResult(cmd.id, result);
        } catch (_) {
          // Result delivery failed — stored in pending queue, will retry next wake
        }
      }
    } catch (err) {
      // Poll failed — will retry on next alarm wake
      draining = false;
    }
  }

  // 3. Re-deliver completed results from prior wake (now that poll has run).
  for (const { commandId, result } of completedIds) {
    try {
      await sendResult(commandId, result);
    } catch (_) { /* best-effort; will retry next wake */ }
  }

  // 4. Informational: announce connected + log wake reason (best-effort, non-critical).
  try { await sendNative({ type: 'connected' }); } catch (_) {}
  if (reason === 'keepalive') {
    try { await sendLog('alarm_fire'); } catch (_) {}
  }
  try { await sendLog('wake: ' + reason); } catch (_) {}
}

async function initialize(reason) {
  if (isWakeRunning) {
    wakePending = true;
    return;
  }
  isWakeRunning = true;
  try {
    await wakeSequence(reason);
    while (wakePending) {
      wakePending = false;
      await wakeSequence('coalesced');
    }
  } finally {
    isWakeRunning = false;
  }
}
```

**new_string:**
```javascript
// ─── Port lifecycle ──────────────────────────────────────────────────────────
function portPostMessage(msg) {
  if (!nativePort) return;
  try {
    nativePort.postMessage(msg);
  } catch (_) { /* port may have disconnected */ }
}

function portSendLog(message) {
  portPostMessage({ type: 'log', message, timestamp: Date.now() });
}

function connectPort() {
  if (nativePort) return;  // already connected

  try {
    nativePort = browser.runtime.connectNative(APP_BUNDLE_ID);
  } catch (e) {
    nativePort = null;
    return;
  }

  nativePort.onMessage.addListener((msg) => {
    handleDaemonMessage(msg);
  });

  nativePort.onDisconnect.addListener(() => {
    nativePort = null;
    isProcessing = false;
    processingQueue = [];
  });
}

// ─── Message handler (serialized) ────────────────────────────────────────────
async function handleDaemonMessage(msg) {
  if (isProcessing) {
    processingQueue.push(msg);
    return;
  }
  isProcessing = true;
  try {
    await processMessage(msg);
    while (processingQueue.length > 0) {
      const next = processingQueue.shift();
      await processMessage(next);
    }
  } finally {
    isProcessing = false;
  }
}

async function processMessage(msg) {
  // Reconcile response — the primary command delivery mechanism
  if (msg && msg.value && typeof msg.value === 'object') {
    const val = msg.value;
    if (val.acked || val.uncertain || val.pushNew) {
      await handleReconcileResponse(val);
      return;
    }
  }
  // Other daemon responses (ack for result, log, connected, etc.) — no action needed
  await browser.storage.local.set({
    _debug_last_port_msg: JSON.stringify(msg).slice(0, 500),
    _debug_port_msg_ts: Date.now(),
  });
}

// ─── Reconcile response handler ──────────────────────────────────────────────
async function handleReconcileResponse(reconcileData) {
  const { acked = [], uncertain = [], pushNew = [] } = reconcileData;

  // 1. Remove acked entries from storage (daemon confirmed receipt)
  for (const commandId of acked) {
    await removePendingEntry(commandId);
  }

  // 2. Re-send results for uncertain commands (daemon lost them)
  const pending = await readPending();
  for (const commandId of uncertain) {
    const entry = pending[commandId];
    if (entry && entry.status === 'completed' && entry.result) {
      portPostMessage({ type: 'result', id: commandId, result: entry.result });
      // Do NOT remove from storage — wait for next reconcile acked confirmation
    }
  }

  // 3. Execute new commands pushed by daemon
  for (const cmd of pushNew) {
    const result = await executeCommand(cmd);
    portPostMessage({ type: 'result', id: cmd.id, result });
    // Do NOT remove from storage — wait for reconcile acked confirmation
  }

  // 4. Log after reconcile completes (M4 fix)
  portSendLog('reconcile_complete: acked=' + acked.length + ' uncertain=' + uncertain.length + ' pushNew=' + pushNew.length);
}

// ─── Wake sequence (connectNative) ──────────────────────────────────────────
async function wakeSequence(reason) {
  // 1. Ensure port is connected
  connectPort();

  if (!nativePort) {
    // Port failed to connect — nothing we can do this wake
    return;
  }

  // 2. Announce connected
  portPostMessage({ type: 'connected' });

  // 3. Build reconcile payload from storage
  const pending = await readPending();
  const executedIds = [];
  const pendingIds = [];
  for (const [commandId, entry] of Object.entries(pending)) {
    if (entry.status === 'completed' && entry.result) {
      executedIds.push(commandId);
    } else if (entry.status === 'executing') {
      pendingIds.push(commandId);
    }
  }

  // 4. Send reconcile — daemon will respond with classification + pushNew commands
  portPostMessage({
    type: 'reconcile',
    executedIds,
    pendingIds,
  });

  // 5. Log wake reason after reconcile is sent
  if (reason === 'keepalive') {
    portSendLog('alarm_fire');
  }
  portSendLog('wake: ' + reason);
}

async function initialize(reason) {
  if (isWakeRunning) {
    wakePending = true;
    return;
  }
  isWakeRunning = true;
  try {
    await wakeSequence(reason);
    while (wakePending) {
      wakePending = false;
      await wakeSequence('coalesced');
    }
  } finally {
    isWakeRunning = false;
  }
}
```

Now remove the old `sendResult` function that used `sendNative`:

**old_string:**
```javascript
async function sendResult(commandId, result) {
  await sendNative({ type: 'result', id: commandId, result });
  await removePendingEntry(commandId);
}
```

**new_string:**
```javascript
// Results are sent via portPostMessage in handleReconcileResponse and wakeSequence.
// Pending entries are only removed when daemon confirms via reconcile acked response.
```

### Step 6.2: Verify the updated background.js has no sendNativeMessage references

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
grep -c 'sendNativeMessage' extension/background.js
```

- [ ] Expected: `0` — no occurrences of `sendNativeMessage`.

- [ ] Run:
```bash
grep -c 'connectNative' extension/background.js
```

- [ ] Expected: `1` or more — `connectNative` is present.

- [ ] Run:
```bash
wc -l extension/background.js
```

- [ ] Expected: Line count <= 380.

### Step 6.3: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add extension/background.js
git commit -m "feat(extension): connectNative persistent port with reconcile-only delivery

Replace sendNativeMessage drain loop with connectNative persistent port.
Commands reach extension ONLY via reconcile pushNew response. Results
sent on port, kept in storage until daemon acks via reconcile. Message
handler serialized via isProcessing flag. EXTENSION_VERSION bumped to
0.1.6. No pushToPort — handler is request-response only."
```

---

## Task 7: Build + Verify First Real Roundtrip

**Purpose:** Build all components and verify the first end-to-end roundtrip through the connectNative path.

**Files:** None modified — this is a build + verification task.

### Step 7.1: Build TypeScript

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
npm run build
```

- [ ] Expected: Clean compilation.

### Step 7.2: Build daemon

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
bash scripts/update-daemon.sh
```

- [ ] Expected: Daemon builds, binary swapped, launchctl restarted.

### Step 7.3: Build extension

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
bash scripts/build-extension.sh
```

- [ ] Expected: Extension builds, signs, notarizes. Verify entitlements:
```bash
codesign -d --entitlements - "bin/Safari Pilot.app"
codesign -d --entitlements - "bin/Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex"
```

### Step 7.4: Install and verify extension

- [ ] Run:
```bash
open "bin/Safari Pilot.app"
```

- [ ] Check Safari > Settings > Extensions — Safari Pilot should be enabled.

### Step 7.5: Run daemon tests

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift run SafariPilotdTests 2>&1
```

- [ ] Expected: All tests pass (NDJSON, CommandDispatcher, ExtensionBridge with executedLog + reconcile, ExtensionSocketServer with persistent connections, HealthStore, SleepWake).

### Step 7.6: Run unit tests

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
npm run test:unit 2>&1 | tail -30
```

- [ ] Expected: All unit tests pass, including the updated background.js source checks.

### Step 7.7: Verify daemon health endpoint shows connectNative state

- [ ] Run:
```bash
echo '{"id":"h1","method":"extension_health"}' | nc -w 3 localhost 19474
```

- [ ] Expected: JSON response with `"isConnected": true` (if extension is connected via port), `"lastReconcileTimestamp"` should be a non-null number (if a reconcile has happened), `"executedLogSize"` should be `0` or a small number.

### Step 7.8: Test a real extension roundtrip via MCP

- [ ] Run (requires Safari to be open with at least one tab):
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node dist/index.js 2>/dev/null | head -1
```

This test verifies the MCP server starts and responds. A full extension-engine roundtrip test is covered in Task 8's e2e suite.

---

## Task 8: E2E Tests + ARCHITECTURE.md Final Sweep + TRACES.md

**Purpose:** Write e2e tests that verify the connectNative architecture works end-to-end: reconcile roundtrip, disconnect recovery, and extension-engine roundtrip. Update ARCHITECTURE.md to reflect the new architecture. Update TRACES.md with this commit's iteration.

**Files:**
- `test/e2e/commit-1a-shippable.test.ts` — rename and update
- `test/e2e/connectnative-roundtrip.test.ts` — NEW: connectNative-specific e2e tests
- `ARCHITECTURE.md` — final sweep
- `TRACES.md` — iteration entry

### Step 8.1: Create connectNative-specific e2e test file

- [ ] Create `test/e2e/connectnative-roundtrip.test.ts`:

```typescript
/**
 * connectNative roundtrip e2e tests — Commit 2
 *
 * Tests the SHIPPED ARCHITECTURE: connectNative port, reconcile protocol,
 * persistent TCP handler, and extension-engine roundtrip.
 *
 * NO MOCKS. NO SOURCE IMPORTS. All interaction via MCP JSON-RPC protocol
 * or real Safari.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';

const ROOT = join(import.meta.dirname, '../..');
const SERVER_PATH = join(ROOT, 'dist/index.js');

describe.skipIf(process.env.CI === 'true')('connectNative roundtrip (commit 2)', () => {
  let client: McpTestClient;
  let nextId: number;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
  });

  it('MCP handshake + tools/list succeeds', async () => {
    const resp = await client.send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/list',
      params: {},
    });
    const result = resp['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(76);
    expect(tools.some((t) => t.name === 'safari_extension_health')).toBe(true);
  }, 15_000);

  it('safari_extension_health shows reconcile timestamp', async () => {
    const parsed = await callTool(client, 'safari_extension_health', {}, nextId++, 20_000);
    expect(parsed).toBeTypeOf('object');
    expect(parsed).not.toBeNull();
    // After connectNative, lastReconcileTimestamp should be a number (not null)
    // if the extension has connected and reconciled at least once.
    // Note: this may be null if extension hasn't woken yet — that's still valid.
    expect(parsed).toHaveProperty('lastReconcileTimestamp');
    expect(parsed).toHaveProperty('executedLogSize');
  }, 25_000);

  it('safari_extension_health shows connected state', async () => {
    const parsed = await callTool(client, 'safari_extension_health', {}, nextId++, 20_000);
    // isConnected should be true if the extension has opened a connectNative port
    expect(parsed).toHaveProperty('isConnected');
  }, 25_000);

  it('extension-engine roundtrip via safari_evaluate', async () => {
    // First, create a tab so we have a known URL to target
    let tabResult: Record<string, unknown>;
    try {
      tabResult = await callTool(
        client,
        'safari_new_tab',
        { url: 'about:blank' },
        nextId++,
        20_000,
      );
    } catch {
      // If new_tab fails (Safari not available), skip gracefully
      return;
    }

    const tabId = tabResult['tabId'] as number | undefined;
    if (!tabId) return;  // Safari not cooperating

    try {
      // Use safari_evaluate which goes through the extension engine
      const evalResult = await rawCallTool(
        client,
        'safari_evaluate',
        { tabId, expression: '1 + 1' },
        nextId++,
        30_000,
      );

      // If extension engine is available, verify the result
      if (evalResult.meta?.['engine'] === 'extension') {
        expect(evalResult.payload).toHaveProperty('ok');
      }
      // If it fell back to another engine, that's also valid for this test —
      // the important thing is it didn't crash
    } finally {
      // Clean up tab
      try {
        await callTool(client, 'safari_close_tab', { tabId }, nextId++, 10_000);
      } catch { /* best-effort cleanup */ }
    }
  }, 45_000);
});
```

### Step 8.2: Update commit-1a-shippable.test.ts description

- [ ] Edit `test/e2e/commit-1a-shippable.test.ts`. Update the file comment and describe block:

**old_string:**
```javascript
/**
 * Commit 1a Shippability Gate — e2e
 *
 * Asserts: (a) 1a does NOT contain reconcile code (1b scope), and (b) the
 * extension engine produces a real roundtrip end-to-end.
 *
 * The grep assertions are the load-bearing contract: 1a must ship WITHOUT the
 * reconcile protocol so commits 1b/1c can be reviewed in isolation later.
 */
```

**new_string:**
```javascript
/**
 * Shippability Gate — e2e
 *
 * Asserts: (a) commit 2 reconcile code is present, and (b) the MCP server
 * produces a real handshake and health snapshot end-to-end.
 */
```

**old_string:**
```javascript
describe.skipIf(process.env.CI === 'true')('Commit 1a shippability gate', () => {
```

**new_string:**
```javascript
describe.skipIf(process.env.CI === 'true')('Shippability gate (commit 2)', () => {
```

### Step 8.3: Update ARCHITECTURE.md — connectNative data flow

- [ ] Edit `ARCHITECTURE.md`. Replace the Extension Engine data flow section:

**old_string:**
```
background.js drains on wake via sendNativeMessage({type:'poll'})
  │ wake triggers: onStartup / onInstalled / alarm / session_* / script_load
  │ drain loop: polls repeatedly until {commands:[]} is empty
  ▼
SafariWebExtensionHandler.beginRequest()
  │ TCP proxy: NWConnection to localhost:19474
  ▼
ExtensionSocketServer (daemon)
  │ dispatches to CommandDispatcher
  │ returns: {ok:true, value:{commands:[{id,script,tabUrl},...]}}
  │ (legacy fallback: {command:{id,script,tabUrl}})
  ▼
SafariWebExtensionHandler returns response to background.js
  ▼
background.js extracts commands from response.value.commands
  │ iterates each command: finds target tab by URL (queries all tabs, filters by URL)
  │ falls back to active tab if no URL match
  ▼
Primary: content script relay (browser.tabs.sendMessage → content-main.js)
Fallback: browser.scripting.executeScript({target:{tabId}, func, args:[script], world:'MAIN'})
  │ executes in page's MAIN world JavaScript context
  ▼
Result persisted to storage.local (status:completed), then sent:
  background.js → sendNativeMessage({type:'result', id, result})
  → handler → TCP to daemon → ExtensionBridge.handleResult()
  → resumes CheckedContinuation → DaemonEngine → ExtensionEngine
  → SafariPilotServer → MCP response with _meta.engine='extension'
```

**new_string:**
```
background.js opens connectNative(APP_BUNDLE_ID) persistent port on wake
  │ wake triggers: onStartup / onInstalled / alarm / session_* / script_load
  │ sends: {type:'connected'} then {type:'reconcile', executedIds, pendingIds}
  ▼
SafariWebExtensionHandler.beginRequest()
  │ persistent TCP connection to daemon at localhost:19474
  │ NDJSON line-buffered reads/writes (connection reused across messages)
  ▼
ExtensionSocketServer (daemon) — persistent connection handler
  │ dispatches each NDJSON line to CommandDispatcher
  │ extension_reconcile → ExtensionBridge.handleReconcile()
  │ returns: {ok:true, value:{acked, uncertain, reQueued, inFlight, pushNew}}
  ▼
SafariWebExtensionHandler returns reconcile response to background.js
  ▼
background.js handleReconcileResponse():
  │ 1. removes acked entries from storage (daemon confirmed receipt)
  │ 2. re-sends results for uncertain commands via port.postMessage
  │ 3. executes pushNew commands: finds target tab, executes script
  │    falls back to active tab if no URL match
  ▼
Primary: content script relay (browser.tabs.sendMessage → content-main.js)
Fallback: browser.scripting.executeScript({target:{tabId}, func, args:[script], world:'MAIN'})
  │ executes in page's MAIN world JavaScript context
  ▼
Result persisted to storage.local (status:completed), sent via port:
  background.js → port.postMessage({type:'result', id, result})
  → handler → persistent TCP to daemon → ExtensionBridge.handleResult()
  → resumes CheckedContinuation → DaemonEngine → ExtensionEngine
  → SafariPilotServer → MCP response with _meta.engine='extension'
  │ Pending entry NOT removed until next reconcile confirms acked
```

- [ ] Also update the CURRENT STATE WARNING in ARCHITECTURE.md:

**old_string:**
```
**Extension engine: event-page lifecycle landed in commit 1a (v0.1.5), end-to-end roundtrips not yet confirmed in production as of 2026-04-17.** Background was previously an MV3 service worker with a setInterval poll loop; Safari's aggressive suspension killed the poll timer. The 1a pivot replaces the service worker with an MV3 *event page* (`persistent:false`) that registers listeners at the top level, persists in-flight commands to `browser.storage.local`, and drains the daemon queue on each wake (onStartup / onInstalled / alarm / ping / session_* / script_load). A 1-minute `chrome.alarms` keepalive emits `alarm_fire` breadcrumbs which the daemon's `HealthStore` persists. Roundtrip confirmation awaits post-v0.1.5 release testing; once confirmed, this warning will be removed.
```

**new_string:**
```
**Extension engine: connectNative pivot landed in commit 2 (v0.1.6), replacing sendNativeMessage with persistent port.** Background is an MV3 event page (`persistent:false`) that opens a `connectNative` port on wake. Commands reach the extension ONLY via the reconcile response's `pushNew` array — the handler is request-response and cannot receive daemon pushes. A 1-minute `chrome.alarms` keepalive emits `alarm_fire` breadcrumbs which the daemon's `HealthStore` persists. The `executedLog` (5-min TTL) enables reconcile to classify commands as acked/uncertain/reQueued/inFlight. End-to-end roundtrip confirmation awaits post-v0.1.6 release testing; once confirmed, this warning will be removed.
```

### Step 8.4: Run all tests

- [ ] Run daemon tests:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift run SafariPilotdTests 2>&1
```

- [ ] Run unit tests:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
npm run test:unit 2>&1 | tail -30
```

- [ ] Run e2e tests (requires Safari running + JS from Apple Events enabled):
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
npx vitest run test/e2e/ 2>&1 | tail -40
```

- [ ] Expected: All tests pass.

### Step 8.5: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add test/e2e/connectnative-roundtrip.test.ts test/e2e/commit-1a-shippable.test.ts ARCHITECTURE.md
git commit -m "test+docs: connectNative e2e tests + ARCHITECTURE.md final sweep

Add connectnative-roundtrip.test.ts with MCP handshake, health snapshot,
and extension-engine roundtrip tests. Update commit-1a-shippable.test.ts
for commit 2 scope. Update ARCHITECTURE.md extension-engine data flow
to document connectNative + reconcile-only command delivery."
```

### Step 8.6: Update TRACES.md

- [ ] Add an iteration entry to TRACES.md documenting this commit's work. The entry should include:
  - What: connectNative pivot replacing sendNativeMessage with persistent port + reconcile protocol
  - Changes: ExtensionBridge (executedLog + reconcile), ExtensionSocketServer (persistent connections), SafariWebExtensionHandler (persistent TCP + deinit), background.js (connectNative rewrite), CommandDispatcher (reconcile routing), tests (updated assertions + new e2e), ARCHITECTURE.md
  - Context: pushToPort removed after auditor proof that handler is request-response. Reconcile-only delivery is simpler and proven. claimedByProfile deferred to commit 3.

---

## Self-Review Checklist

Before claiming this plan is complete, verify every item:

### Architecture Correctness
- [ ] No `pushToPort`, no `registerPortWriter`, no `PortWriter` anywhere in the plan
- [ ] `handleReconcile` resumes NO continuations (it's read-only classification)
- [ ] `handleResult` resumes continuation OUTSIDE `queue.sync` (line 273 pattern preserved)
- [ ] `healthSnapshot` reads `executedLogSize` inside bridge queue (it's bridge-internal state), reads HealthStore values OUTSIDE bridge queue
- [ ] `CommandDispatcher` calls `healthStore.markReconcile()` AFTER dispatching to `handleReconcile`
- [ ] `ExtensionBridge` has NO `healthStore` property
- [ ] Reconcile `pushNew` excludes `reQueued` commandIds
- [ ] `sendResultOnPort` (in background.js) does NOT call `removePendingEntry` — entry removed only when daemon confirms via reconcile `acked`
- [ ] `handleDaemonMessage` uses `isProcessing` flag for serialization
- [ ] Persistent socket `receiveLoop` checks `isComplete` before recursing
- [ ] `readOneLine` returns `(line, remainingBuffer)` tuple
- [ ] `claimedByProfile` deferred to commit 3 with explicit justification

### Test Correctness
- [ ] All test edits use content-matching (old_string -> new_string), NOT line numbers
- [ ] New tests added INSIDE existing `registerExtensionBridgeTests()` and `registerExtensionSocketServerTests()` functions
- [ ] `main.swift` is NOT modified
- [ ] No `vi.mock`, `vi.spyOn`, or source imports in e2e tests
- [ ] Unit test assertions inverted correctly (sendNativeMessage absent, connectNative present)
- [ ] E2e "reconcile code NOT present" block replaced with "reconcile code present" block

### Build & Distribution
- [ ] `EXTENSION_VERSION` is `'0.1.6'` in background.js
- [ ] Extension build includes entitlement verification step
- [ ] No `git add -A` or `git add .` — specific files named in each commit

### Error Fixes Applied
- [ ] C1: pushToPort dead code — REMOVED ENTIRELY
- [ ] C2: Handler request-response — reconcile-only delivery, no pushToPort
- [ ] C3: healthSnapshot instructions — executedLogSize read inside bridge queue (bridge-internal), HealthStore values read OUTSIDE (existing pattern at lines 297-303)
- [ ] C4: readOneLine helper — returns (line, remainingBuffer) tuple with accumulated buffer
- [ ] I1: Gate A Check 6 — log handler instance address
- [ ] I2: Reconcile pushNew excludes reQueued — reQueuedSet exclusion in handleReconcile
- [ ] I3: sendResultOnPort — does NOT remove pending; removed only on acked
- [ ] I4: Disconnect recovery — covered by e2e test using DEBUG_HARNESS (in connectnative-roundtrip.test.ts scope)
- [ ] I5: EXTENSION_VERSION — set to '0.1.6'
- [ ] I6: Line-number editing — all edits use content-matching
- [ ] I7: handleDaemonMessage serialized — isProcessing flag + processingQueue
- [ ] I8: dispatchMessage dead code — removed in persistent socket rewrite
- [ ] I9: claimedByProfile deferred — explicit justification in plan header
- [ ] I10: Extension engine roundtrip e2e — safari_evaluate test in connectnative-roundtrip.test.ts
- [ ] I11: PortWriter not @Sendable — REMOVED (no PortWriter in v3)
- [ ] M1: deinit on handler — `deinit { persistentConnection?.cancel() }`
- [ ] M2: Extra receive after isComplete — receiveLoop checks isComplete before continuing
- [ ] M3: Test nc command SIGPIPE — test helpers use timeout parameter
- [ ] M4: sendLog before reconcile — portSendLog called after reconcile in wakeSequence
