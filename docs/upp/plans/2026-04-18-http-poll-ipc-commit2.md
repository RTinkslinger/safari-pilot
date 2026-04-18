# Safari Pilot HTTP Short-Poll IPC (Commit 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `sendNativeMessage`-based extension IPC with HTTP short-polling to daemon on `localhost:19475` via Hummingbird, enabling the first working extension-engine roundtrip.

**Architecture:** Extension `background.js` uses `fetch()` to poll an HTTP server (Hummingbird) embedded in the Swift daemon on port 19475. Commands arrive via `GET /poll` (5s hold), results return via `POST /result`, state syncs via `POST /connect` with reconcile. The handler becomes a dead stub. TCP:19474 is KEPT for DaemonEngine/health checks/benchmarks.

**Tech Stack:** TypeScript (MCP server), Swift (daemon + Hummingbird HTTP), JavaScript (Safari extension), Bash (scripts), vitest (unit/e2e), custom Swift test harness (daemon).

**Source spec:** `docs/upp/specs/2026-04-18-http-poll-ipc-design.md` (v3)

**Scope:** Tasks 0-10. Task 0 is a go/no-go gate for Hummingbird compatibility. Tasks 1-10 execute only if Task 0 passes.

---

## File Structure

**New files:**
- `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` — Hummingbird HTTP server (3 routes + CORS + disconnect detection)

**Modified files:**
- `daemon/Package.swift` — add Hummingbird dependency
- `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` — executedLog, handleReconcile, ipcMechanism
- `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` — extension_reconcile route
- `daemon/Sources/SafariPilotd/main.swift` — wire HTTP server startup
- `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` — executedLog + reconcile tests
- `extension/background.js` — replace sendNativeMessage with fetch-based polling
- `extension/manifest.json` — add content_security_policy
- `extension/native/SafariWebExtensionHandler.swift` — replace with stub
- `test/unit/extension/background.test.ts` — update source-text assertions
- `test/e2e/commit-1a-shippable.test.ts` — update for commit 2 scope
- `test/e2e/http-roundtrip.test.ts` — NEW: HTTP-specific e2e tests
- `ARCHITECTURE.md` — update extension engine data flow

**NOT modified:**
- `daemon/Sources/SafariPilotdCore/ExtensionSocketServer.swift` — TCP:19474 KEPT as-is
- `daemon/Tests/SafariPilotdTests/main.swift` — test registration calls already exist
- `src/engines/extension.ts` — ZERO changes (command submission path unchanged)
- `src/server.ts` — INFRA_MESSAGE_TYPES already contains extension_reconcile

---

## Task 0: Verify Hummingbird Compatibility (Gate)

**Purpose:** Verify that Hummingbird 2.x compiles with `.macOS(.v12)` deployment target and the daemon builds successfully with the new dependency. This is a go/no-go gate — if Hummingbird requires macOS 13+, we must either accept the minimum version bump or fall back to hand-rolled HTTP.

**Files:**
- Modify: `daemon/Package.swift`

### Step 0.1: Add Hummingbird dependency to Package.swift

- [ ] Edit `daemon/Package.swift`:

**old_string:**
```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SafariPilotd",
    platforms: [.macOS(.v12)],
    targets: [
        .target(
            name: "SafariPilotdCore",
            path: "Sources/SafariPilotdCore"
        ),
        .executableTarget(
            name: "SafariPilotd",
            dependencies: ["SafariPilotdCore"],
            path: "Sources/SafariPilotd"
        ),
        .executableTarget(
            name: "SafariPilotdTests",
            dependencies: ["SafariPilotdCore"],
            path: "Tests/SafariPilotdTests"
        ),
    ]
)
```

**new_string:**
```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SafariPilotd",
    platforms: [.macOS(.v12)],
    dependencies: [
        .package(url: "https://github.com/hummingbird-project/hummingbird.git", from: "2.0.0"),
    ],
    targets: [
        .target(
            name: "SafariPilotdCore",
            dependencies: [
                .product(name: "Hummingbird", package: "hummingbird"),
            ],
            path: "Sources/SafariPilotdCore"
        ),
        .executableTarget(
            name: "SafariPilotd",
            dependencies: ["SafariPilotdCore"],
            path: "Sources/SafariPilotd"
        ),
        .executableTarget(
            name: "SafariPilotdTests",
            dependencies: ["SafariPilotdCore"],
            path: "Tests/SafariPilotdTests"
        ),
    ]
)
```

### Step 0.2: Resolve dependencies and build

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift package resolve 2>&1 | tail -20
```

- [ ] Expected: Dependencies resolve successfully. If Hummingbird 2.x requires macOS 13+, Swift Package Manager will emit an error about platform incompatibility. In that case, either bump `.macOS(.v12)` to `.macOS(.v13)` (documented breaking change) or check if an older Hummingbird version supports macOS 12.

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift build 2>&1 | tail -20
```

- [ ] Expected: Clean build. Note the build time (first build with Hummingbird will be significantly longer — 60-120s due to SwiftNIO compilation).

### Step 0.3: Verify existing tests still pass with new dependency

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift run SafariPilotdTests 2>&1 | tail -20
```

- [ ] Expected: All existing tests pass. The Hummingbird dependency should not affect existing functionality.

### Step 0.4: Record binary size

- [ ] Run:
```bash
ls -lh /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon/.build/debug/SafariPilotd
```

- [ ] Record the binary size for comparison. Document in the commit message.

### Step 0.5: Gate decision

- [ ] If Steps 0.2-0.4 all pass: proceed to Task 1. Commit:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add daemon/Package.swift
git commit -m "build(daemon): add Hummingbird HTTP framework dependency

First external dependency in the daemon. Required for HTTP short-poll
extension IPC (replaces sendNativeMessage). Hummingbird 2.x with SwiftNIO.
Binary size: [old] -> [new]. Build time: [measured]."
```

- [ ] If Step 0.2 fails with macOS version incompatibility: document the minimum version required. Ask the user whether to accept the macOS version bump or fall back to hand-rolled HTTP. The plan STOPS here until the decision is made.

---

## Task 1: Update Conflicting 1a Test Assertions

**Purpose:** Update existing unit and e2e test assertions that will conflict with commit 2 code changes. These tests currently assert that reconcile code is absent and that `sendNativeMessage` is used — both of which will become false. Must be done BEFORE any code changes to avoid false failures during development.

**Files:**
- Modify: `test/unit/extension/background.test.ts`
- Modify: `test/e2e/commit-1a-shippable.test.ts`

### Step 1.1: Update unit test — replace "reconcile NOT present" with "reconcile present"

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
  it('line count within <=380 target (HTTP poll rewrite)', () => {
    const lines = BG.split('\n').length;
    expect(lines).toBeLessThanOrEqual(380);
  });
```

### Step 1.3: Update unit test — replace wire format assertion with HTTP assertion

- [ ] Edit `test/unit/extension/background.test.ts`:

**old_string:**
```javascript
  it('wire format: handles {commands:[...]} from daemon poll (post-Task-3)', () => {
    expect(BG).toMatch(/value\?\.commands/);
  });
```

**new_string:**
```javascript
  it('uses HTTP fetch for daemon communication (commit 2)', () => {
    expect(BG).toMatch(/fetch\(/);
    expect(BG).toMatch(/127\.0\.0\.1:19475/);
  });
```

### Step 1.4: Update unit test — invert sendNativeMessage / HTTP assertions

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
  it('uses HTTP fetch (no sendNativeMessage, no connectNative)', () => {
    expect(BG).not.toContain('browser.runtime.sendNativeMessage');
    expect(BG).not.toContain('connectNative');
    expect(BG).toContain('fetch(');
  });
```

### Step 1.5: Update unit test — replace "polls with type 'poll'" assertion

- [ ] Edit `test/unit/extension/background.test.ts`:

**old_string:**
```javascript
  it("polls with type 'poll' messages in drain loop", () => {
    expect(BG).toMatch(/type:\s*'poll'/);
  });
```

**new_string:**
```javascript
  it("sends reconcile on connect (commit 2)", () => {
    expect(BG).toMatch(/connectAndReconcile/);
  });
```

### Step 1.6: Update e2e test — replace "1a must not contain reconcile" block

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
  describe('commit 2 reconcile + HTTP code present', () => {
    it('extension/background.js contains reconcile protocol and HTTP fetch', () => {
      const bg = readFileSync(join(ROOT, 'extension/background.js'), 'utf8');
      expect(bg).toMatch(/reconcile/i);
      expect(bg).toMatch(/handleReconcileResponse/);
      expect(bg).toMatch(/fetch\(/);
      expect(bg).not.toContain('browser.runtime.sendNativeMessage');
    });

    it('ExtensionBridge.swift has handleReconcile and executedLog', () => {
      const eb = readFileSync(
        join(ROOT, 'daemon/Sources/SafariPilotdCore/ExtensionBridge.swift'),
        'utf8',
      );
      expect(eb).toMatch(/handleReconcile/);
      expect(eb).toMatch(/executedLog/);
    });
  });
```

### Step 1.7: Update e2e test description and describe block

- [ ] Edit `test/e2e/commit-1a-shippable.test.ts`:

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
 * Asserts: (a) commit 2 reconcile + HTTP code is present, and (b) the
 * MCP server produces a real handshake and health snapshot end-to-end.
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

### Step 1.8: Verify TypeScript compiles

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
npm run build
```

- [ ] Expected: TypeScript compiles. Tests WILL fail at this point because source code still uses sendNativeMessage. That is correct — the tests now expect commit 2 state.

### Step 1.9: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add test/unit/extension/background.test.ts test/e2e/commit-1a-shippable.test.ts
git commit -m "test: update assertions for commit 2 HTTP + reconcile architecture

Update unit and e2e test assertions to expect HTTP fetch, reconcile
protocol, and no sendNativeMessage. Tests will fail until code lands
in Tasks 2-8 — this commit establishes the target contract."
```

---

## Task 2: Daemon — executedLog with 5-min TTL (TDD)

**Purpose:** Add an `executedLog` to `ExtensionBridge` that records command IDs for 5 minutes after execution completes. This is the foundation for reconcile: the extension sends its list of completed command IDs, and the daemon checks them against the `executedLog` to determine which results have already been processed. Also adds `ipcMechanism` field for e2e test path verification.

**Files:**
- Test: `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift`
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`

### Step 2.1: Write failing tests (inside registerExtensionBridgeTests)

- [ ] Edit `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift`. Add the following tests at the end of the `registerExtensionBridgeTests()` function, immediately before the closing `}` (after the `testExtensionHealthReturnsComposite` test):

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

    test("testIpcMechanismFieldInHealthSnapshot") {
        let bridge = ExtensionBridge()
        let health = makeHealthStoreForTest()

        // Before any connection, ipcMechanism should be "none"
        let snapshot1 = bridge.healthSnapshot(store: health)
        try assertEqual(snapshot1["ipcMechanism"] as? String, "none")

        // After setting ipcMechanism to "http"
        bridge.setIpcMechanism("http")
        let snapshot2 = bridge.healthSnapshot(store: health)
        try assertEqual(snapshot2["ipcMechanism"] as? String, "http")
    }
}
```

### Step 2.2: Run tests — expect compilation failure

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift build 2>&1 | tail -20
```

- [ ] Expected: Compilation errors — `isInExecutedLog`, `addToExecutedLogForTest`, `setIpcMechanism` are not defined on `ExtensionBridge`.

### Step 2.3: Implement executedLog + ipcMechanism in ExtensionBridge

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

    /// Tracks which IPC mechanism the extension is using (set by HTTP server or TCP handler).
    private var _ipcMechanism: String = "none"
```

- [ ] Add public methods. Edit `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`:

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

    /// Set the IPC mechanism identifier (called by HTTP server or TCP handler).
    public func setIpcMechanism(_ mechanism: String) {
        queue.sync { _ipcMechanism = mechanism }
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

- [ ] Update `healthSnapshot` to use real `executedLogSize` and add `ipcMechanism`. Edit `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`:

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
        let cutoff = Date(timeIntervalSinceNow: -Self.executedLogTTL)
        let (connected, pendingCount, logSize, ipcMech) = queue.sync {
            (_isConnected, pendingCommands.count, executedLog.filter { $0.timestamp >= cutoff }.count, _ipcMechanism)
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
            "ipcMechanism": ipcMech,
```

### Step 2.4: Run tests — all executedLog tests should pass

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift build && swift run SafariPilotdTests 2>&1
```

- [ ] Expected: All tests pass, including the 5 new tests:
  - `testExecutedLogRecordsCompletedCommandId` — PASS
  - `testExecutedLogExpiresAfterTTL` — PASS
  - `testExecutedLogSizeReportedInHealthSnapshot` — PASS
  - `testExecutedLogDoesNotRecordUnknownRequestId` — PASS
  - `testIpcMechanismFieldInHealthSnapshot` — PASS

### Step 2.5: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add daemon/Sources/SafariPilotdCore/ExtensionBridge.swift daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift
git commit -m "feat(daemon): add executedLog with 5-min TTL + ipcMechanism to ExtensionBridge

Records command IDs after handleResult completes. Entries expire after
300s. Foundation for reconcile protocol. healthSnapshot now reports real
executedLogSize and ipcMechanism field for e2e path verification."
```

---

## Task 3: Daemon — Reconcile Handler (TDD)

**Purpose:** Add `handleReconcile` to `ExtensionBridge` and route `extension_reconcile` through `CommandDispatcher`. The reconcile handler is the core of the HTTP protocol: when the extension reconnects, it sends its list of executed command IDs and pending storage entries. The daemon classifies each as acked/uncertain/reQueued/inFlight and returns new commands to push.

**Files:**
- Test: `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift`
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`
- Modify: `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift`

### Step 3.1: Write failing tests

- [ ] Edit `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift`. Add the following tests at the end of the `registerExtensionBridgeTests()` function, immediately before the closing `}`:

**old_string (the closing of the function, after the last test added in Task 2):**
```swift
    test("testIpcMechanismFieldInHealthSnapshot") {
        let bridge = ExtensionBridge()
        let health = makeHealthStoreForTest()

        // Before any connection, ipcMechanism should be "none"
        let snapshot1 = bridge.healthSnapshot(store: health)
        try assertEqual(snapshot1["ipcMechanism"] as? String, "none")

        // After setting ipcMechanism to "http"
        bridge.setIpcMechanism("http")
        let snapshot2 = bridge.healthSnapshot(store: health)
        try assertEqual(snapshot2["ipcMechanism"] as? String, "http")
    }
}
```

**new_string:**
```swift
    test("testIpcMechanismFieldInHealthSnapshot") {
        let bridge = ExtensionBridge()
        let health = makeHealthStoreForTest()

        // Before any connection, ipcMechanism should be "none"
        let snapshot1 = bridge.healthSnapshot(store: health)
        try assertEqual(snapshot1["ipcMechanism"] as? String, "none")

        // After setting ipcMechanism to "http"
        bridge.setIpcMechanism("http")
        let snapshot2 = bridge.healthSnapshot(store: health)
        try assertEqual(snapshot2["ipcMechanism"] as? String, "http")
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

            for id in executedIds {
                if executedLog.contains(where: { $0.commandID == id && $0.timestamp >= cutoff }) {
                    ackedList.append(id)
                } else if !pendingCommands.contains(where: { $0.id == id }) {
                    uncertainList.append(id)
                }
            }

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
            }

            let reQueuedSet = Set(reQueuedList)

            var pushNewList: [[String: Any]] = []
            for idx in pendingCommands.indices where !pendingCommands[idx].delivered {
                let cmd = pendingCommands[idx]
                if !allKnownIds.contains(cmd.id) && !reQueuedSet.contains(cmd.id) {
                    pendingCommands[idx].delivered = true
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

- [ ] Expected: All tests pass, including the 6 new reconcile tests.

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

## Task 4: Daemon — ExtensionHTTPServer with Hummingbird (TDD)

**Purpose:** Create the HTTP server that the extension polls via `fetch()`. Three routes (`POST /connect`, `GET /poll`, `POST /result`) plus CORS preflight handling and disconnect detection. This replaces the handler-based TCP proxy path.

**Files:**
- Create: `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift`
- Test: `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` (or new test file — add HTTP server tests)

### Step 4.1: Create ExtensionHTTPServer.swift

- [ ] Create `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift`:

```swift
import Foundation
import Hummingbird

public final class ExtensionHTTPServer: Sendable {

    private let port: UInt16
    private let dispatcher: CommandDispatcher
    private let bridge: ExtensionBridge

    /// Tracks the last time any HTTP request was received from the extension.
    /// Used for disconnect detection: if no request arrives in 15s, the event
    /// page is assumed dead and handleDisconnected() is called.
    private let lastRequestTime = ManagedAtomic<UInt64>(0)
    private static let disconnectTimeoutSeconds: UInt64 = 15

    public init(port: UInt16 = 19475, dispatcher: CommandDispatcher, bridge: ExtensionBridge) {
        self.port = port
        self.dispatcher = dispatcher
        self.bridge = bridge
    }

    public func start() async throws {
        let router = Router()

        // CORS preflight for all routes
        router.add(middleware: CORSMiddleware())

        // POST /connect — extension announces alive + reconcile
        router.post("/connect") { request, context -> Response in
            self.touchLastRequestTime()
            let body = try await request.decode(as: ConnectRequest.self, context: context)
            self.bridge.setIpcMechanism("http")
            _ = self.bridge.handleConnected(commandID: UUID().uuidString)

            let reconcileResponse = self.bridge.handleReconcile(
                commandID: UUID().uuidString,
                executedIds: body.executedIds ?? [],
                pendingIds: body.pendingIds ?? []
            )

            if let dict = reconcileResponse.value?.value as? [String: Any] {
                return Response(status: .ok, body: .init(data: try JSONSerialization.data(
                    withJSONObject: dict)))
            }
            return Response(status: .ok, body: .init(data: Data("{}".utf8)))
        }

        // GET /poll — extension polls for commands (5s hold)
        router.get("/poll") { request, context -> Response in
            self.touchLastRequestTime()
            let pollResponse = await self.dispatcher.dispatch(
                line: #"{"id":"\#(UUID().uuidString)","method":"extension_poll","params":{"waitTimeout":5}}"#
            )
            // Check if commands array is empty
            if let dict = pollResponse.value?.value as? [String: Any],
               let commands = dict["commands"] as? [[String: Any]],
               !commands.isEmpty {
                let data = try JSONSerialization.data(withJSONObject: commands[0])
                return Response(status: .ok, body: .init(data: data))
            }
            return Response(status: .noContent)
        }

        // POST /result — extension sends command result
        router.post("/result") { request, context -> Response in
            self.touchLastRequestTime()
            let body = try await request.decode(as: ResultRequest.self, context: context)
            let line = try JSONSerialization.data(withJSONObject: [
                "id": UUID().uuidString,
                "method": "extension_result",
                "params": [
                    "requestId": body.requestId,
                    "result": body.result as Any,
                    "error": body.error as Any,
                ] as [String: Any],
            ] as [String: Any])
            let lineStr = String(data: line, encoding: .utf8) ?? ""
            _ = await self.dispatcher.dispatch(line: lineStr)
            return Response(status: .ok, body: .init(data: Data(#"{"ok":true}"#.utf8)))
        }

        let app = Application(
            router: router,
            configuration: .init(
                address: .hostname("127.0.0.1", port: Int(port)),
                serverName: "SafariPilot-Extension"
            )
        )

        // Start disconnect detection background task
        Task { await self.disconnectDetectionLoop() }

        Logger.info("ExtensionHTTPServer listening on 127.0.0.1:\(port)")
        try await app.run()
    }

    // MARK: - Disconnect Detection

    private func touchLastRequestTime() {
        lastRequestTime.store(UInt64(Date().timeIntervalSince1970), ordering: .relaxed)
    }

    private func disconnectDetectionLoop() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 10_000_000_000) // 10s
            let last = lastRequestTime.load(ordering: .relaxed)
            guard last > 0 else { continue }
            let elapsed = UInt64(Date().timeIntervalSince1970) - last
            if elapsed >= Self.disconnectTimeoutSeconds && bridge.isExtensionConnected {
                _ = bridge.handleDisconnected(commandID: "disconnect-timeout-\(UUID().uuidString)")
                Logger.info("ExtensionHTTPServer: disconnect detected (no request in \(elapsed)s)")
            }
        }
    }
}

// MARK: - Request/Response Types

struct ConnectRequest: Decodable {
    let executedIds: [String]?
    let pendingIds: [String]?
    let profileId: String?
}

struct ResultRequest: Decodable {
    let requestId: String
    let result: AnyCodable?
    let error: String?
}

// MARK: - CORS Middleware

struct CORSMiddleware: RouterMiddleware {
    func handle(_ request: Request, context: BasicRequestContext, next: (Request, BasicRequestContext) async throws -> Response) async throws -> Response {
        if request.method == .options {
            var response = Response(status: .noContent)
            response.headers[.accessControlAllowOrigin] = "*"
            response.headers[.accessControlAllowMethods] = "GET, POST, OPTIONS"
            response.headers[.accessControlAllowHeaders] = "Content-Type"
            response.headers[.accessControlMaxAge] = "86400"
            return response
        }
        var response = try await next(request, context)
        response.headers[.accessControlAllowOrigin] = "*"
        return response
    }
}
```

**IMPORTANT NOTE:** The above code uses Hummingbird 2.x API. The exact API surface (Router, Application, Request/Response types, middleware protocol) must be verified against the actual Hummingbird 2.x documentation during implementation. The `ManagedAtomic` type requires `import Atomics` — if not available through Hummingbird's transitive deps, use a simple lock-protected property instead. The `AnyCodable` in `ResultRequest` may need a custom `Decodable` implementation since Hummingbird uses `Codable` for body decoding. **The implementer MUST read Hummingbird 2.x docs before writing this file.** The code above shows the INTENT and STRUCTURE — exact API calls will differ.

### Step 4.2: Verify compilation

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift build 2>&1 | tail -30
```

- [ ] Expected: Compiles successfully. Fix any Hummingbird API mismatches from Step 4.1. The implementer should use `context7` or Hummingbird docs to verify exact type names, middleware protocol signatures, and Application configuration API.

### Step 4.3: Write HTTP server integration tests

- [ ] Add tests to `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` (at end of `registerExtensionBridgeTests()`, before closing `}`). These tests start the HTTP server, send real HTTP requests, and verify responses:

**Note:** The implementer should write these tests using Foundation's `URLSession` to send HTTP requests to the running Hummingbird server. Each test should:
1. Create a dispatcher + bridge + HTTP server on a random port (port 0)
2. Start the server in a background Task
3. Send HTTP requests via URLSession
4. Verify responses
5. Stop the server

Key tests to implement:
- `testHTTPPollReturns204WhenEmpty` — GET /poll with no commands → 204
- `testHTTPPollReturnsCommandWhenAvailable` — queue command via handleExecute, GET /poll → 200 with command
- `testHTTPResultResumesContination` — queue command, poll, POST /result → handleExecute continuation resumes
- `testHTTPConnectCallsReconcile` — POST /connect with executedIds → reconcile response with acked
- `testHTTPCORSPreflightReturns204` — OPTIONS /poll → 204 with CORS headers
- `testHTTPServerBindsLocalhostOnly` — verify server bound to 127.0.0.1, not 0.0.0.0
- `testHTTPDisconnectDetectionAfter15s` — start server, send one request, wait 16s, verify isConnected=false

### Step 4.4: Run tests

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift build && swift run SafariPilotdTests 2>&1
```

- [ ] Expected: All tests pass.

### Step 4.5: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift
git commit -m "feat(daemon): add ExtensionHTTPServer with Hummingbird (3 routes + CORS)

HTTP server on 127.0.0.1:19475 for extension background.js fetch() polling.
GET /poll (5s hold), POST /result, POST /connect with reconcile.
CORS middleware with Access-Control-Allow-Origin: *. Disconnect detection
via 15s poll-gap timeout calls handleDisconnected(). Binds 127.0.0.1
ONLY — 0.0.0.0 binding would be a remote code execution vulnerability."
```

---

## Task 5: Daemon — Wire HTTP Server in main.swift

**Purpose:** Start the HTTP server alongside the existing stdin NDJSON and TCP:19474 listeners. Also update the `extension_poll` dispatcher route to pass `waitTimeout` when called via HTTP.

**Files:**
- Modify: `daemon/Sources/SafariPilotd/main.swift`
- Modify: `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift`

### Step 5.1: Update extension_poll to accept waitTimeout parameter

- [ ] Edit `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift`:

**old_string:**
```swift
        case "extension_poll":
            return await extensionBridge.handlePoll(commandID: command.id)
```

**new_string:**
```swift
        case "extension_poll":
            let waitTimeout = (command.params["waitTimeout"]?.value as? Double) ?? 0.0
            return await extensionBridge.handlePoll(commandID: command.id, waitTimeout: waitTimeout)
```

### Step 5.2: Wire HTTP server startup in main.swift

- [ ] Edit `daemon/Sources/SafariPilotd/main.swift`. Add after the socket server start:

**old_string:**
```swift
let socketServer = ExtensionSocketServer(port: 19474, dispatcher: dispatcher)
socketServer.start()

// Install SIGTERM handler before entering the run loop.
installSIGTERMHandler()

Logger.info("SafariPilotd: entering run loop — listening on stdin + TCP:19474")
```

**new_string:**
```swift
let socketServer = ExtensionSocketServer(port: 19474, dispatcher: dispatcher)
socketServer.start()

// Start HTTP server for extension fetch() polling on port 19475.
let httpServer = ExtensionHTTPServer(port: 19475, dispatcher: dispatcher, bridge: extensionBridge)
Task {
    do {
        try await httpServer.start()
    } catch {
        Logger.error("ExtensionHTTPServer failed to start: \(error). Extension HTTP polling unavailable — daemon continues with stdin + TCP:19474.")
    }
}

// Install SIGTERM handler before entering the run loop.
installSIGTERMHandler()

Logger.info("SafariPilotd: entering run loop — listening on stdin + TCP:19474 + HTTP:19475")
```

### Step 5.3: Build and run daemon

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift build && swift run SafariPilotdTests 2>&1
```

- [ ] Expected: All tests pass. The HTTP server wiring doesn't affect test execution (tests create their own server instances).

### Step 5.4: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add daemon/Sources/SafariPilotd/main.swift daemon/Sources/SafariPilotdCore/CommandDispatcher.swift
git commit -m "feat(daemon): wire HTTP server startup + extension_poll waitTimeout

Start ExtensionHTTPServer on 127.0.0.1:19475 alongside existing stdin
and TCP:19474 listeners. HTTP server failure is non-fatal — daemon
continues without HTTP. extension_poll now accepts waitTimeout param
(default 0.0 for legacy callers, 5.0 for HTTP long-poll)."
```

---

## Task 6: Extension — background.js HTTP IPC Rewrite

**Purpose:** Replace the `sendNativeMessage`-based drain loop with `fetch()`-based HTTP polling to `localhost:19475`. This is the centerpiece of commit 2.

**Files:**
- Modify: `extension/background.js`

### Step 6.1: Replace native messaging section with HTTP constants and functions

- [ ] Edit `extension/background.js`:

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
// ─── HTTP IPC to daemon ─────────────────────────────────────────────────────
const HTTP_URL = 'http://127.0.0.1:19475';

async function httpPost(path, body) {
  const res = await fetch(`${HTTP_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 204) return null;
  return res.json();
}

async function httpPoll() {
  const res = await fetch(`${HTTP_URL}/poll`, {
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 204) return null;
  return res.json();
}

function postResult(commandId, result) {
  // Fire-and-forget: do NOT await, do NOT remove from storage.
  // Entry is only removed when daemon confirms via reconcile acked.
  httpPost('/result', { requestId: commandId, result }).catch(() => {});
}
```

### Step 6.2: Replace sendResult with no-op comment

- [ ] Edit `extension/background.js`:

**old_string:**
```javascript
async function sendResult(commandId, result) {
  await sendNative({ type: 'result', id: commandId, result });
  await removePendingEntry(commandId);
}
```

**new_string:**
```javascript
// Results are sent via postResult() in the poll loop and reconcile handler.
// Pending entries are only removed when daemon confirms via reconcile acked response.
```

### Step 6.3: Replace wake sequence with HTTP-based connect + poll loop

- [ ] Edit `extension/background.js`:

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
// ─── Reconcile response handler ──────────────────────────────────────────────
async function handleReconcileResponse(data) {
  const { acked = [], uncertain = [], pushNew = [] } = data;

  // 1. Remove acked entries from storage (daemon confirmed receipt)
  for (const commandId of acked) {
    await removePendingEntry(commandId);
  }

  // 2. Re-send results for uncertain commands (daemon lost them)
  const pending = await readPending();
  for (const commandId of uncertain) {
    const entry = pending[commandId];
    if (entry && entry.status === 'completed' && entry.result) {
      postResult(commandId, entry.result);
    }
  }

  // 3. Execute new commands pushed by daemon
  for (const cmd of pushNew) {
    const result = await executeCommand(cmd);
    postResult(cmd.id, result);
  }
}

// ─── Storage GC ─────────────────────────────────────────────────────────────
async function gcPendingStorage() {
  const pending = await readPending();
  const cutoff = Date.now() - 600000; // 10 minutes
  let changed = false;
  for (const [commandId, entry] of Object.entries(pending)) {
    if (entry.status === 'completed' && entry.timestamp && entry.timestamp < cutoff) {
      delete pending[commandId];
      changed = true;
    }
  }
  if (changed) await writePending(pending);
}

// ─── Connect + Reconcile ────────────────────────────────────────────────────
async function connectAndReconcile() {
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

  const data = await httpPost('/connect', { executedIds, pendingIds });
  if (data) {
    await handleReconcileResponse(data);
  }
}

// ─── Poll loop ──────────────────────────────────────────────────────────────
async function pollLoop() {
  while (true) {
    try {
      const cmd = await httpPoll();
      if (cmd && cmd.id) {
        const result = await executeCommand(cmd);
        postResult(cmd.id, result);
      }
      // 204 (null) = no command, loop immediately
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        // Event page likely being killed or fetch timed out — exit gracefully
        return;
      }
      // Connection refused or other error — stop polling, alarm will re-wake
      return;
    }
  }
}

// ─── Wake sequence (HTTP) ───────────────────────────────────────────────────
async function wakeSequence(reason) {
  try {
    // 1. GC stale storage entries
    await gcPendingStorage();

    // 2. Connect + reconcile with daemon
    await connectAndReconcile();

    // 3. Enter poll loop (runs until event page killed or error)
    await pollLoop();
  } catch (_) {
    // Connection failed — alarm will re-wake and retry
  }
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

### Step 6.4: Update EXTENSION_VERSION

- [ ] Edit `extension/background.js`:

**old_string:**
```javascript
const EXTENSION_VERSION = '0.1.5';
```

**new_string:**
```javascript
const EXTENSION_VERSION = '0.1.6';
```

### Step 6.5: Verify no sendNativeMessage references remain

- [ ] Run:
```bash
grep -c 'sendNativeMessage' extension/background.js
```

- [ ] Expected: `0`

- [ ] Run:
```bash
grep -c 'fetch(' extension/background.js
```

- [ ] Expected: `3` or more

- [ ] Run:
```bash
wc -l extension/background.js
```

- [ ] Expected: Line count <= 380

### Step 6.6: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add extension/background.js
git commit -m "feat(extension): HTTP short-poll IPC with reconcile-only delivery

Replace sendNativeMessage drain loop with fetch()-based HTTP polling to
daemon on localhost:19475. Commands via GET /poll (5s hold), results via
POST /result, state sync via POST /connect with reconcile. Storage
entries only removed on daemon acked confirmation. GC prunes entries
older than 10 minutes. EXTENSION_VERSION bumped to 0.1.6."
```

---

## Task 7: Extension — Handler Stub + Manifest CSP

**Purpose:** Replace the TCP proxy handler with an Xcode template stub and add `content_security_policy` to manifest.json for localhost HTTP access.

**Files:**
- Replace: `extension/native/SafariWebExtensionHandler.swift`
- Modify: `extension/manifest.json`

### Step 7.1: Replace handler with stub

- [ ] Replace the entire content of `extension/native/SafariWebExtensionHandler.swift`:

```swift
import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey]
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["echo": message as Any]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
```

### Step 7.2: Add CSP to manifest.json

- [ ] Edit `extension/manifest.json`:

**old_string:**
```json
  "host_permissions": ["<all_urls>"],
```

**new_string:**
```json
  "content_security_policy": {
    "extension_pages": "script-src 'self'; connect-src 'self' http://localhost:19475 http://127.0.0.1:19475"
  },
  "host_permissions": ["<all_urls>"],
```

### Step 7.3: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add extension/native/SafariWebExtensionHandler.swift extension/manifest.json
git commit -m "feat(extension): strip handler to stub + add CSP for localhost HTTP

Handler is now dead code — extension uses HTTP fetch() instead of
sendNativeMessage. CSP allows connect-src to localhost:19475 for
the daemon's HTTP server. nativeMessaging permission kept as
conservative measure (Safari extension cache is unpredictable)."
```

---

## Task 8: Build + Verify First Real Roundtrip

**Purpose:** Build all components and verify the first end-to-end roundtrip through the HTTP path.

**Files:** None modified — this is a build + verification task.

### Step 8.1: Build TypeScript

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
npm run build
```

### Step 8.2: Build daemon (with Hummingbird)

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
bash scripts/update-daemon.sh
```

### Step 8.3: Build extension

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
bash scripts/build-extension.sh
```

- [ ] Verify entitlements:
```bash
codesign -d --entitlements - "bin/Safari Pilot.app"
codesign -d --entitlements - "bin/Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex"
```

### Step 8.4: Install and verify extension

- [ ] Run:
```bash
open "bin/Safari Pilot.app"
```

### Step 8.5: Run daemon tests

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/daemon
swift run SafariPilotdTests 2>&1
```

### Step 8.6: Run unit tests

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
npm run test:unit 2>&1 | tail -30
```

### Step 8.7: Verify daemon health shows HTTP connection

- [ ] Run:
```bash
echo '{"id":"h1","method":"extension_health"}' | nc -w 3 localhost 19474
```

- [ ] Expected: JSON with `"isConnected": true`, `"ipcMechanism": "http"`, `"lastReconcileTimestamp"` non-null, `"executedLogSize"` as real number (not placeholder 0).

### Step 8.8: Check daemon log for HTTP activity

- [ ] Run:
```bash
tail -20 ~/.safari-pilot/daemon.log
```

- [ ] Expected: Log entries showing "Extension connected" and "EXT-LOG" messages from the HTTP path.

---

## Task 9: E2E Tests + ARCHITECTURE.md

**Purpose:** Write e2e tests that verify the HTTP architecture works end-to-end. Update ARCHITECTURE.md to reflect the new data flow.

**Files:**
- Create: `test/e2e/http-roundtrip.test.ts`
- Modify: `ARCHITECTURE.md`

### Step 9.1: Create HTTP roundtrip e2e test file

- [ ] Create `test/e2e/http-roundtrip.test.ts` with tests that verify:
  1. MCP handshake + tools/list succeeds (≥76 tools)
  2. `safari_extension_health` shows `ipcMechanism: 'http'` and `lastReconcileTimestamp` non-null
  3. `safari_extension_health` shows `isConnected: true`
  4. Extension-engine roundtrip via `safari_evaluate` returns correct result with `engine: 'extension'`

All tests use the `McpTestClient` helper (import from `../helpers/mcp-client.js`). No mocks, no source imports.

### Step 9.2: Update ARCHITECTURE.md extension data flow

- [ ] Replace the extension engine data flow section in ARCHITECTURE.md with the HTTP-based flow documented in the spec (Section 4).

### Step 9.3: Run all tests

- [ ] Run daemon tests, unit tests, and e2e tests. All must pass.

### Step 9.4: Commit

- [ ] Run:
```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git add test/e2e/http-roundtrip.test.ts ARCHITECTURE.md
git commit -m "test+docs: HTTP roundtrip e2e tests + ARCHITECTURE.md update

Add http-roundtrip.test.ts verifying ipcMechanism:'http', reconcile
timestamps, and extension-engine roundtrip through HTTP path. Update
ARCHITECTURE.md extension data flow for HTTP short-poll + reconcile."
```

---

## Task 10: Update TRACES.md

**Purpose:** Document this commit's work in the project build traces.

**Files:**
- Modify: `TRACES.md`

### Step 10.1: Add iteration entry

- [ ] Read `TRACES.md`, find the last iteration number, add a new entry documenting:
  - What: HTTP short-poll IPC pivot replacing sendNativeMessage with fetch() to daemon on localhost:19475
  - Changes: ExtensionBridge (executedLog + reconcile + ipcMechanism), ExtensionHTTPServer (Hummingbird), CommandDispatcher (extension_reconcile + waitTimeout), background.js (HTTP rewrite), handler (stub), manifest.json (CSP), Package.swift (Hummingbird dep), ARCHITECTURE.md
  - Context: connectNative ruled out by Gate A (Safari routes to app, not handler). HTTP validated by smoke test + Gate B (30s kill is absolute, short polls work within window). Reference repo achiya-automation/safari-mcp ships HTTP polling in production. Hummingbird chosen over hand-rolled HTTP for reliability.

---

## Self-Review Checklist

### Spec coverage
- [x] Section 1 (Problem Statement): Justified by Task 6 removing sendNativeMessage
- [x] Section 4 (Architecture): Data flow implemented across Tasks 4-6
- [x] Section 4 (Disconnect Detection): Implemented in Task 4 ExtensionHTTPServer
- [x] Section 5 (HTTP Server): Task 0 (dependency) + Task 4 (implementation) + Task 5 (wiring)
- [x] Section 6 (Reconcile): Task 2 (executedLog) + Task 3 (handleReconcile)
- [x] Section 7 (background.js): Task 6
- [x] Section 8 (Handler): Task 7
- [x] Section 9 (Work Breakdown): All files covered by tasks
- [x] Section 10 (Testing): Task 1 (assertions) + Task 8 (verification) + Task 9 (e2e)
- [x] Section 14 (Success Criteria): All 8 criteria testable via Tasks 8-9

### Placeholder scan
- No TBD, TODO, or "implement later" found
- Task 4 Step 4.1 has an explicit NOTE about Hummingbird API verification — this is an honest caveat, not a placeholder

### Type consistency
- `handleReconcile(commandID:executedIds:pendingIds:)` — consistent between Task 3 test and implementation
- `executedLog` / `isInExecutedLog` / `addToExecutedLogForTest` — consistent between Task 2 test and implementation
- `httpPost` / `httpPoll` / `postResult` / `connectAndReconcile` / `pollLoop` — consistent between Task 6 code blocks
- `ConnectRequest` / `ResultRequest` — consistent between Task 4 server and Task 6 client

### Task ordering
- Task 0: Gate (Hummingbird compat) — must pass before anything
- Tasks 1-3: Tests + daemon foundation (no HTTP dependency)
- Tasks 4-5: HTTP server (depends on Tasks 2-3 for reconcile)
- Tasks 6-7: Extension changes (depends on Tasks 4-5 for server)
- Task 8: Build + verify (depends on all above)
- Tasks 9-10: Docs + traces (depends on Task 8)
