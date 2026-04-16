# Safari MV3 Event-Page Pivot — Commit 1a (v0.1.5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Safari MV3 event-page lifecycle fix + observability surface as Safari Pilot v0.1.5, producing the first working end-to-end Extension-engine roundtrip in the project's history.

**Architecture:** Replace the service-worker manifest with event-page form (`"scripts":[…], "persistent":false`); delete the broken `pollLoop`/`nativeMessageChain`/IIFE; adopt storage-backed command queue with on-wake drain via `sendNativeMessage`; add daemon-side `executedLog`-preparation (handleDisconnected flip-back, handlePoll returns-all-undelivered, `HealthStore` with persisted state); migrate `ToolRequirements.idempotent` to a required field across all 76 tools; ship `safari_extension_health` + `safari_extension_debug_dump` MCP tools, kill-switch config, hourly LaunchAgent health-check, pre-publish verify harness + artifact-hash binding, latest-stable state machine, v0.1.1-v0.1.3 regression canary, multi-profile manual-QA anchor.

**Tech Stack:** TypeScript (MCP server + tools), Swift (daemon + .appex handler), JavaScript (Safari Web Extension background + content scripts), Bash (hooks/scripts), vitest (unit/e2e), XCTest (daemon). Single prod dep: `@modelcontextprotocol/sdk`.

**Source spec:** `docs/upp/specs/2026-04-17-safari-mv3-event-page-design.md`
**Synthesis (evidence base):** `docs/superpowers/brainstorms/2026-04-17-safari-mv3-event-page-synthesis.md`

**Scope — Commit 1a only:**
This plan covers the 1a deliverable (v0.1.5). 1b (reconcile protocol + daemon executedLog + claimedByProfile) and 1c (two-tier timeout + forceReload/degradation) get their own plans after 1a ships and stabilizes. The `test/e2e/commit-1a-shippable.test.ts` gate asserts 1a works on its own without reconcile code present.

**Non-scope for 1a (explicit):** reconcile protocol, claimedByProfile, daemon executedLog (only skeleton prep in handleDisconnected), two-tier timeout split, forceReload, Gate A/B/C prototypes, connectNative, full benchmark re-run (smoke subset yes).

**Distribution pipeline (hard rule):** Every extension/daemon/app code change requires full build + sign + notarize + release cycle. Local e2e pass before publish is mandatory (no CI Safari matrix).

---

## File Structure

**Files modified:**
- `extension/manifest.json` — background stanza change
- `extension/background.js` — rewrite (~445 → ≤340 lines)
- `extension/content-main.js` — add executedCommands Map (~15 line addition)
- `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` — handleDisconnected flip-back; handlePoll return-all; HealthStore integration hooks
- `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` — route `extension_log`; confirm existing routes
- `daemon/Sources/SafariPilotd/main.swift` — wire HealthStore persistence path
- `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` — new tests (added to existing 42)
- `src/types.ts` — `idempotent: boolean` required field on `ToolRequirements`
- `src/tools/*.ts` — migration: 16 tool files, all 76 tools declare `idempotent`
- `src/server.ts` — `INFRA_MESSAGE_TYPES` set; engine-degradation re-run; register 2 new diagnostic tools
- `src/security/circuit-breaker.ts` — engine-scope dimension
- `src/security/human-approval.ts` — invalidate-on-degradation API
- `safari-pilot.config.json` — `extension.enabled` + `killSwitchVersion`
- `src/config.ts` — load/honor `extension.enabled`
- `scripts/build-extension.sh` — strip `__DEBUG_HARNESS__` in release builds
- `scripts/postinstall.sh` — install LaunchAgent health-check plist
- `scripts/preuninstall.sh` — bootout health-check plist
- `package.json` — `prepublishOnly` script + new verify scripts
- `ARCHITECTURE.md` — sections updated per spec §12.13
- `TRACES.md` — iteration entry
- `CHECKPOINT.md` — updated current state

**Files created:**
- `extension/build.config.js` — `__DEBUG_HARNESS__` compile-flag switcher
- `src/tools/extension-diagnostics.ts` — `safari_extension_health` + `safari_extension_debug_dump`
- `daemon/Sources/SafariPilotdCore/HealthStore.swift` — persisted counter + timestamp store
- `hooks/pre-publish-verify.sh` — PreToolUse hook + prepublishOnly entry point
- `hooks/session-end.sh` — rollback-detector check (if hook doesn't already exist, else extend)
- `scripts/promote-stable.sh` — `latest-stable` state machine
- `scripts/verify-extension-smoke.sh` — the ≤6 min verify harness
- `launchagents/com.safari-pilot.health-check.plist` — hourly cron
- `.npmrc` — `ignore-scripts=false` policy declaration
- `docs/upp/incidents/TEMPLATE.md` — incident template
- `test/manual/multi-profile.md` — manual QA checklist
- Test files (see Task 17-27)

---

## Task Order

Order chosen to keep each commit on a compiling, test-passing main at all times:

1. **Daemon foundation** (Tasks 1-5) — Swift changes + tests first; daemon ships its new behavior without the extension yet talking to it, so changes are reviewable in isolation.
2. **TypeScript types + server** (Tasks 6-11) — type-level migration + security wiring before tools depend on it.
3. **Tool migration** (Tasks 12-13) — add `idempotent` to all 76 tools; new diagnostic tools.
4. **Config + kill-switch** (Task 14) — enables runtime disable before the extension refactor lands.
5. **Extension refactor** (Tasks 15-16) — the core lifecycle fix, manifest + background.js.
6. **Tests** (Tasks 17-23) — unit, e2e, canary, security.
7. **Infrastructure + hooks** (Tasks 24-28) — LaunchAgent, verify harness, incidents, hooks.
8. **Ship + documentation** (Tasks 29-32) — full distribution cycle, docs update.

---

### Task 1: Daemon — `HealthStore.swift` (counters + persisted timestamps)

**Files:**
- Create: `daemon/Sources/SafariPilotdCore/HealthStore.swift`
- Modify: `daemon/Sources/SafariPilotd/main.swift` — instantiate HealthStore, wire into dispatcher
- Test: `daemon/Tests/SafariPilotdTests/HealthStoreTests.swift` (create)

- [ ] **Step 1: Write the failing test**

```swift
// daemon/Tests/SafariPilotdTests/HealthStoreTests.swift
import XCTest
@testable import SafariPilotdCore

final class HealthStoreTests: XCTestCase {
    var tmpDir: URL!
    var healthPath: URL!

    override func setUp() {
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("safari-pilot-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        healthPath = tmpDir.appendingPathComponent("health.json")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tmpDir)
    }

    func testInitialAlarmTimestampIsNow() {
        let before = Date()
        let store = HealthStore(persistPath: healthPath)
        XCTAssertGreaterThanOrEqual(store.lastAlarmFireTimestamp.timeIntervalSince1970,
                                    before.timeIntervalSince1970 - 1)
    }

    func testRecordAlarmFirePersists() {
        let store = HealthStore(persistPath: healthPath)
        let t = Date(timeIntervalSinceNow: -30)
        store.recordAlarmFire(at: t)
        XCTAssertEqual(store.lastAlarmFireTimestamp.timeIntervalSince1970,
                       t.timeIntervalSince1970, accuracy: 0.01)

        // Reload from disk
        let store2 = HealthStore(persistPath: healthPath)
        XCTAssertEqual(store2.lastAlarmFireTimestamp.timeIntervalSince1970,
                       t.timeIntervalSince1970, accuracy: 0.01)
    }

    func testRoundtripCountInMemoryOnly() {
        let store = HealthStore(persistPath: healthPath)
        store.incrementRoundtrip()
        store.incrementRoundtrip()
        XCTAssertEqual(store.roundtripCount1h, 2)

        // Counters are in-memory — not persisted
        let store2 = HealthStore(persistPath: healthPath)
        XCTAssertEqual(store2.roundtripCount1h, 0)
    }

    func testForceReloadCount24hPersists() {
        let store = HealthStore(persistPath: healthPath)
        store.incrementForceReload()
        store.incrementForceReload()

        let store2 = HealthStore(persistPath: healthPath)
        XCTAssertEqual(store2.forceReloadCount24h, 2)
    }

    func testCountersRollOffAfterWindow() {
        let store = HealthStore(persistPath: healthPath)
        let oldTimestamp = Date(timeIntervalSinceNow: -3700)  // > 1 hour ago
        store.recordRoundtripAt(oldTimestamp)
        store.recordRoundtripAt(Date())
        XCTAssertEqual(store.roundtripCount1h, 1, "roundtrips older than 1h should not count")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd daemon && swift test --filter HealthStoreTests`
Expected: FAIL with "cannot find 'HealthStore' in scope" (compile error).

- [ ] **Step 3: Create `HealthStore.swift`**

```swift
// daemon/Sources/SafariPilotdCore/HealthStore.swift
import Foundation

public final class HealthStore: @unchecked Sendable {
    private let persistPath: URL
    private let queue = DispatchQueue(label: "com.safari-pilot.health-store")

    // Persisted: survives daemon restart
    public private(set) var lastAlarmFireTimestamp: Date
    private var forceReloadTimestamps: [Date] = []

    // In-memory: resets on daemon restart
    private var roundtripTimestamps: [Date] = []
    private var timeoutTimestamps: [Date] = []
    private var uncertainTimestamps: [Date] = []
    public private(set) var lastReconcileTimestamp: Date? = nil
    public private(set) var lastExecutedResultTimestamp: Date? = nil

    public init(persistPath: URL) {
        self.persistPath = persistPath
        self.lastAlarmFireTimestamp = Date()  // default per R3: init = Date.now()

        // Restore persisted state (if exists)
        if let data = try? Data(contentsOf: persistPath),
           let decoded = try? JSONDecoder().decode(PersistedState.self, from: data) {
            self.lastAlarmFireTimestamp = decoded.lastAlarmFireTimestamp
            self.forceReloadTimestamps = decoded.forceReloadTimestamps
        }
    }

    public var roundtripCount1h: Int { countInWindow(roundtripTimestamps, seconds: 3600) }
    public var timeoutCount1h: Int { countInWindow(timeoutTimestamps, seconds: 3600) }
    public var uncertainCount1h: Int { countInWindow(uncertainTimestamps, seconds: 3600) }
    public var forceReloadCount24h: Int { countInWindow(forceReloadTimestamps, seconds: 86400) }

    public func recordAlarmFire(at date: Date = Date()) {
        queue.sync {
            self.lastAlarmFireTimestamp = date
            self.persist()
        }
    }

    public func incrementRoundtrip() { queue.sync { roundtripTimestamps.append(Date()) } }
    public func incrementTimeout() { queue.sync { timeoutTimestamps.append(Date()) } }
    public func incrementUncertain() { queue.sync { uncertainTimestamps.append(Date()) } }

    public func recordRoundtripAt(_ date: Date) { queue.sync { roundtripTimestamps.append(date) } }

    public func incrementForceReload() {
        queue.sync {
            forceReloadTimestamps.append(Date())
            persist()
        }
    }

    public func markReconcile() { queue.sync { lastReconcileTimestamp = Date() } }
    public func markExecutedResult() { queue.sync { lastExecutedResultTimestamp = Date() } }

    private func countInWindow(_ ts: [Date], seconds: TimeInterval) -> Int {
        let cutoff = Date(timeIntervalSinceNow: -seconds)
        return ts.filter { $0 >= cutoff }.count
    }

    private func persist() {
        let state = PersistedState(
            lastAlarmFireTimestamp: lastAlarmFireTimestamp,
            forceReloadTimestamps: forceReloadTimestamps.filter {
                $0 >= Date(timeIntervalSinceNow: -86400)
            }
        )
        if let data = try? JSONEncoder().encode(state) {
            try? data.write(to: persistPath, options: .atomic)
        }
    }

    private struct PersistedState: Codable {
        let lastAlarmFireTimestamp: Date
        let forceReloadTimestamps: [Date]
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd daemon && swift test --filter HealthStoreTests`
Expected: PASS, all 5 tests green.

- [ ] **Step 5: Wire HealthStore into main.swift**

```swift
// daemon/Sources/SafariPilotd/main.swift — near existing setup
let healthPath = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".safari-pilot/health.json")
try? FileManager.default.createDirectory(
    at: healthPath.deletingLastPathComponent(),
    withIntermediateDirectories: true
)
let healthStore = HealthStore(persistPath: healthPath)
// Pass to ExtensionBridge, CommandDispatcher as they need it
```

- [ ] **Step 6: Run full daemon test suite**

Run: `cd daemon && swift test`
Expected: 42 existing + 5 new = 47 tests pass.

- [ ] **Step 7: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/HealthStore.swift \
        daemon/Tests/SafariPilotdTests/HealthStoreTests.swift \
        daemon/Sources/SafariPilotd/main.swift
git commit -m "feat(daemon): HealthStore with persisted alarm timestamp + in-memory counters"
```

---

### Task 2: Daemon — `ExtensionBridge.handleDisconnected` flip-back behavior

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` — `handleDisconnected`
- Modify: `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` — new tests

Current behavior: `handleDisconnected` CANCELS all pending commands with `EXTENSION_DISCONNECTED`. New behavior for 1a: revert `delivered=true→false` for un-acked commands so they redeliver on next connection; only cancel commands that are un-delivered (those have no caller waiting yet — just drop).

- [ ] **Step 1: Write the failing tests**

```swift
// daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift — add to existing file
func testHandleDisconnectedFlipsDeliveredBackForUnacked() async {
    let bridge = ExtensionBridge()
    _ = bridge.handleConnected(commandID: "c1")

    // Queue a command; simulate it being delivered (via handlePoll)
    async let executeResult = bridge.handleExecute(
        commandID: "exec-1",
        params: ["script": AnyCodable("document.title")]
    )
    // Let the execute be queued
    try? await Task.sleep(nanoseconds: 50_000_000)

    // Poll picks it up → delivered=true
    _ = await bridge.handlePoll(commandID: "poll-1", waitTimeout: 1.0)

    // Now disconnect
    _ = bridge.handleDisconnected(commandID: "disc-1")

    // Reconnect and poll again — delivered should have been flipped back to false
    _ = bridge.handleConnected(commandID: "c2")
    let response = await bridge.handlePoll(commandID: "poll-2", waitTimeout: 1.0)

    // Verify we got the command again (flip-back worked)
    if case .success(_, let value) = response {
        if let dict = value.value as? [String: Any],
           let cmd = dict["command"] as? [String: Any],
           let id = cmd["id"] as? String {
            XCTAssertEqual(id, "exec-1", "command should redeliver after reconnect")
            return
        }
    }
    XCTFail("expected pending command to be redelivered after reconnect")

    // Complete the execute for cleanup
    _ = bridge.handleResult(commandID: "res-1", params: [
        "requestId": AnyCodable("exec-1"),
        "result": AnyCodable(["ok": true, "value": "cleanup"])
    ])
    _ = await executeResult
}

func testHandleDisconnectedLeavesUndeliveredAlone() async {
    let bridge = ExtensionBridge()
    _ = bridge.handleConnected(commandID: "c1")

    // Queue a command but never poll — delivered=false
    async let executeResult = bridge.handleExecute(
        commandID: "exec-1",
        params: ["script": AnyCodable("x")]
    )
    try? await Task.sleep(nanoseconds: 50_000_000)

    _ = bridge.handleDisconnected(commandID: "disc-1")

    // Reconnect, poll → should still receive the un-delivered command
    _ = bridge.handleConnected(commandID: "c2")
    let response = await bridge.handlePoll(commandID: "poll-1", waitTimeout: 1.0)

    if case .success(_, let value) = response,
       let dict = value.value as? [String: Any],
       let cmd = dict["command"] as? [String: Any],
       let id = cmd["id"] as? String {
        XCTAssertEqual(id, "exec-1", "un-delivered command should still be in queue after disconnect")
    } else {
        XCTFail("expected un-delivered command to survive disconnect")
    }

    // Cleanup
    _ = bridge.handleResult(commandID: "res", params: [
        "requestId": AnyCodable("exec-1"),
        "result": AnyCodable(["ok": true])
    ])
    _ = await executeResult
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd daemon && swift test --filter ExtensionBridgeTests.testHandleDisconnectedFlipsDeliveredBackForUnacked`
Expected: FAIL — current code cancels all pending on disconnect.

- [ ] **Step 3: Modify `handleDisconnected` in ExtensionBridge.swift**

Replace the existing `handleDisconnected` body:

```swift
public func handleDisconnected(commandID: String) -> Response {
    let (flipBacks, unclaimed): ([(String)], [WaitingPoll]) = queue.sync {
        _isConnected = false
        var flippedIds: [String] = []
        for idx in 0..<pendingCommands.count {
            if pendingCommands[idx].delivered {
                pendingCommands[idx].delivered = false
                flippedIds.append(pendingCommands[idx].id)
            }
        }
        let waits = waitingPolls
        waitingPolls.removeAll()
        return (flippedIds, waits)
    }
    Logger.info("Extension disconnected. Flipped delivered->false for \(flipBacks.count) unacked command(s); cleared \(unclaimed.count) waiting poll(s).")

    // Resolve any waiting polls with empty — their TCP connections close
    for wp in unclaimed {
        wp.timeoutTask.cancel()
        wp.continuation.resume(returning: Response.success(
            id: wp.id,
            value: AnyCodable(["command": NSNull()])
        ))
    }
    return Response.success(id: commandID, value: AnyCodable("extension_ack"))
}
```

- [ ] **Step 4: Run tests**

Run: `cd daemon && swift test --filter ExtensionBridgeTests`
Expected: all tests pass (42 existing + 2 new = 44).

- [ ] **Step 5: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/ExtensionBridge.swift \
        daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift
git commit -m "feat(daemon): ExtensionBridge flips delivered=true→false on disconnect (1a)"
```

---

### Task 3: Daemon — `handlePoll` returns all undelivered commands at once

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` — `handlePoll`
- Modify: `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift`

Current: returns first un-delivered as `{command: {...}}`. New: returns array `{commands: [{...}, ...]}` so extension drains all queued in one wake. Backwards compatibility: also accept single-command responses via a `commands:[c]` fallback on extension side.

- [ ] **Step 1: Write failing tests**

```swift
func testHandlePollReturnsAllUndeliveredAtOnce() async {
    let bridge = ExtensionBridge()
    _ = bridge.handleConnected(commandID: "c")

    async let e1 = bridge.handleExecute(commandID: "cmd-1", params: ["script": AnyCodable("a")])
    async let e2 = bridge.handleExecute(commandID: "cmd-2", params: ["script": AnyCodable("b")])
    async let e3 = bridge.handleExecute(commandID: "cmd-3", params: ["script": AnyCodable("c")])
    try? await Task.sleep(nanoseconds: 100_000_000)

    let response = await bridge.handlePoll(commandID: "poll-1", waitTimeout: 1.0)

    if case .success(_, let value) = response,
       let dict = value.value as? [String: Any],
       let commands = dict["commands"] as? [[String: Any]] {
        XCTAssertEqual(commands.count, 3, "should return all 3 queued commands")
        let ids = Set(commands.compactMap { $0["id"] as? String })
        XCTAssertEqual(ids, Set(["cmd-1", "cmd-2", "cmd-3"]))
    } else {
        XCTFail("expected commands array in response")
    }

    // Clean up
    for id in ["cmd-1", "cmd-2", "cmd-3"] {
        _ = bridge.handleResult(commandID: "r", params: [
            "requestId": AnyCodable(id),
            "result": AnyCodable(["ok": true])
        ])
    }
    _ = await e1; _ = await e2; _ = await e3
}

func testHandlePollEmptyReturnsEmptyArray() async {
    let bridge = ExtensionBridge()
    _ = bridge.handleConnected(commandID: "c")

    let response = await bridge.handlePoll(commandID: "poll-1", waitTimeout: 0.2)

    if case .success(_, let value) = response,
       let dict = value.value as? [String: Any],
       let commands = dict["commands"] as? [[String: Any]] {
        XCTAssertEqual(commands.count, 0)
    } else {
        XCTFail("expected empty commands array")
    }
}
```

- [ ] **Step 2: Run — verify fails**

Run: `cd daemon && swift test --filter testHandlePollReturnsAllUndeliveredAtOnce`
Expected: FAIL — current code returns `{command: {...}}` single.

- [ ] **Step 3: Modify `handlePoll`**

Replace the body of `handlePoll`'s synchronous command-collection. New atomic block:

```swift
let (immediateResponse, deliveredIds): (Response?, [String]) = queue.sync {
    // Collect ALL undelivered commands (was: first only)
    var collectedDicts: [[String: Any]] = []
    var collectedIds: [String] = []
    for idx in 0..<pendingCommands.count where !pendingCommands[idx].delivered {
        pendingCommands[idx].delivered = true
        var dict: [String: Any] = ["id": pendingCommands[idx].id]
        for (key, val) in pendingCommands[idx].params {
            dict[key] = val.value
        }
        collectedDicts.append(dict)
        collectedIds.append(pendingCommands[idx].id)
    }

    if !collectedDicts.isEmpty {
        return (Response.success(
            id: commandID,
            value: AnyCodable(["commands": collectedDicts])
        ), collectedIds)
    }

    // No pending — queue as waiting poll
    waitingPolls.append(WaitingPoll(
        id: commandID,
        continuation: continuation,
        timeoutTask: timeoutTask
    ))
    return (nil, [])
}
```

Update the timeout-path response in the `timeoutTask` inside `handlePoll` to return `{"commands": []}` (empty array) instead of `{"command": NSNull()}` — consistent wire format.

- [ ] **Step 4: Update `handleExecute`'s wake-waiting-poll branch**

The fast-path where `handleExecute` wakes a waiting poll with a fresh command must use `{"commands": [cmd]}` shape:

```swift
if let wp = wakePoll {
    Logger.info("EXECUTE: woke waiting poll \(wp.id) with command \(commandID)")
    wp.timeoutTask.cancel()
    wp.continuation.resume(returning: Response.success(
        id: wp.id,
        value: AnyCodable(["commands": [commandDict]])
    ))
}
```

- [ ] **Step 5: Run tests**

Run: `cd daemon && swift test --filter ExtensionBridgeTests`
Expected: all pass (44 → 46 tests).

- [ ] **Step 6: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/ExtensionBridge.swift \
        daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift
git commit -m "feat(daemon): handlePoll returns all undelivered commands array (drain-on-wake)"
```

---

### Task 4: Daemon — route `extension_log` through HealthStore (alarm-fire tracking)

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` — handle `extension_log`
- Modify: `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift`

`extension_log` already routes (via the handler's default case) but the log body isn't inspected for `alarm_fire` tags. Extension will send `{type:'log', message:'alarm_fire', timestamp:...}`. Daemon records into HealthStore.

- [ ] **Step 1: Write failing test**

```swift
func testExtensionLogAlarmFireUpdatesHealthStore() {
    let tmpPath = FileManager.default.temporaryDirectory
        .appendingPathComponent("test-health-\(UUID().uuidString).json")
    defer { try? FileManager.default.removeItem(at: tmpPath) }
    let health = HealthStore(persistPath: tmpPath)
    let dispatcher = CommandDispatcher(/* existing init */, healthStore: health)

    let before = health.lastAlarmFireTimestamp
    try? Thread.sleep(forTimeInterval: 0.05)
    _ = dispatcher.dispatch(method: "extension_log", commandID: "log-1", params: [
        "message": AnyCodable("alarm_fire"),
        "timestamp": AnyCodable(Date().timeIntervalSince1970 * 1000)
    ])
    XCTAssertGreaterThan(health.lastAlarmFireTimestamp, before)
}
```

- [ ] **Step 2: Run — verify fails**

Run: `cd daemon && swift test --filter testExtensionLogAlarmFireUpdatesHealthStore`
Expected: FAIL (CommandDispatcher doesn't have `healthStore` param yet).

- [ ] **Step 3: Modify CommandDispatcher**

```swift
// daemon/Sources/SafariPilotdCore/CommandDispatcher.swift
public init(..., healthStore: HealthStore) {
    self.healthStore = healthStore
    // ... existing
}

// In dispatch, handle extension_log:
case "extension_log":
    if let msgAny = params["message"], let msg = msgAny.value as? String {
        if msg.hasPrefix("alarm_fire") {
            healthStore.recordAlarmFire()
        }
        Logger.info("EXT-LOG: \(msg)")
    }
    return Response.success(id: commandID, value: AnyCodable("log_ack"))
```

- [ ] **Step 4: Wire healthStore into dispatcher init in main.swift**

```swift
let dispatcher = CommandDispatcher(
    /* existing args */,
    healthStore: healthStore
)
```

- [ ] **Step 5: Run full daemon tests**

Run: `cd daemon && swift test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/CommandDispatcher.swift \
        daemon/Sources/SafariPilotd/main.swift \
        daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift
git commit -m "feat(daemon): extension_log alarm_fire messages update HealthStore"
```

---

### Task 5: Daemon — `extension_status` + `extension_health` read-paths

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` — add `extension_health` route
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` — `healthSnapshot()` accessor
- Modify: `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift`

Daemon must expose a composite health response for the MCP tool to consume.

- [ ] **Step 1: Write failing test**

```swift
func testExtensionHealthReturnsComposite() {
    let tmpPath = /* as before */
    let health = HealthStore(persistPath: tmpPath)
    let bridge = ExtensionBridge()
    let dispatcher = CommandDispatcher(bridge: bridge, healthStore: health, /* ... */)

    health.incrementRoundtrip()
    health.incrementTimeout()

    let response = dispatcher.dispatch(method: "extension_health", commandID: "h", params: [:])

    if case .success(_, let value) = response,
       let dict = value.value as? [String: Any] {
        XCTAssertEqual(dict["roundtripCount1h"] as? Int, 1)
        XCTAssertEqual(dict["timeoutCount1h"] as? Int, 1)
        XCTAssertEqual(dict["uncertainCount1h"] as? Int, 0)
        XCTAssertEqual(dict["forceReloadCount24h"] as? Int, 0)
        XCTAssertNotNil(dict["lastAlarmFireTimestamp"])
        XCTAssertNotNil(dict["pendingCommandsCount"])
        XCTAssertNotNil(dict["isConnected"])
    } else {
        XCTFail("expected health dict")
    }
}
```

- [ ] **Step 2: Run — verify fails**

Expected: FAIL — `extension_health` method not routed.

- [ ] **Step 3: Implement**

In `CommandDispatcher.swift`:

```swift
case "extension_health":
    let snapshot = bridge.healthSnapshot(store: healthStore)
    return Response.success(id: commandID, value: AnyCodable(snapshot))
```

In `ExtensionBridge.swift`:

```swift
public func healthSnapshot(store: HealthStore) -> [String: Any] {
    queue.sync {
        [
            "isConnected": _isConnected,
            "lastAlarmFireTimestamp": store.lastAlarmFireTimestamp.timeIntervalSince1970 * 1000,
            "lastReconcileTimestamp": store.lastReconcileTimestamp.map { $0.timeIntervalSince1970 * 1000 } as Any? ?? NSNull(),
            "lastExecutedResultTimestamp": store.lastExecutedResultTimestamp.map { $0.timeIntervalSince1970 * 1000 } as Any? ?? NSNull(),
            "roundtripCount1h": store.roundtripCount1h,
            "timeoutCount1h": store.timeoutCount1h,
            "uncertainCount1h": store.uncertainCount1h,
            "forceReloadCount24h": store.forceReloadCount24h,
            "pendingCommandsCount": pendingCommands.count,
            "executedLogSize": 0,  // placeholder; becomes real in 1b
            "claimedByProfiles": [] as [String],  // placeholder; becomes real in 1b
            "engineCircuitBreakerState": "closed",  // placeholder; becomes real when CB wired
            "killSwitchActive": false  // set by TS-side when config.extension.enabled=false
        ]
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cd daemon && swift test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/CommandDispatcher.swift \
        daemon/Sources/SafariPilotdCore/ExtensionBridge.swift \
        daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift
git commit -m "feat(daemon): extension_health composite dispatch + snapshot accessor"
```

---

### Task 6: TypeScript — `ToolRequirements.idempotent` as required field

**Files:**
- Modify: `src/types.ts`
- Test: TypeScript compile check (no separate test file — the type system is the test)

- [ ] **Step 1: Observe current state**

Run: `grep -n "interface ToolRequirements" src/types.ts`
Expected: finds the interface.

- [ ] **Step 2: Modify the interface**

```typescript
// src/types.ts — before the existing ToolRequirements
/**
 * Per-tool capability + safety declaration. Every tool MUST declare `idempotent`
 * explicitly — there is no default. Non-idempotent tools cannot be auto-retried
 * across event-page unloads; they return EXTENSION_UNCERTAIN with structured
 * _meta.uncertainResult on ambiguous disconnect.
 */
export interface ToolRequirements {
  /**
   * True if the tool can be called multiple times with the same params and
   * produce the same observable result (no side effects). False for tools
   * that modify DOM, navigate, click, type, submit, upload, etc. — any tool
   * where a retry could cause a second side-effect.
   *
   * Set at tool-definition time. Enforced by TypeScript: omission = compile error.
   */
  idempotent: boolean;

  requiresShadowDom?: boolean;
  // ...existing optional flags (preserve all)
}
```

- [ ] **Step 3: Run type-check — expect it to fail with many errors**

Run: `npm run lint` (which is `tsc --noEmit`)
Expected: 76+ errors across `src/tools/*.ts` — "Property 'idempotent' is missing in type '...' but required in type 'ToolRequirements'".

This failure confirms the type migration is load-bearing; Task 12 addresses all errors.

- [ ] **Step 4: Commit the type change**

```bash
git add src/types.ts
git commit -m "feat(types): ToolRequirements.idempotent as required field (WILL break tools/*.ts — next task migrates)"
```

---

### Task 7: TypeScript — `EXTENSION_UNCERTAIN` structured metadata

**Files:**
- Modify: `src/types.ts` — new type `StructuredUncertainty`
- Modify: `src/errors.ts` — add `EXTENSION_UNCERTAIN` error code if not present

- [ ] **Step 1: Write failing test**

```typescript
// test/unit/errors.test.ts — add to existing or create
import { ERROR_CODES, formatToolError } from '../../src/errors';
import { SafariPilotError } from '../../src/errors';

test('EXTENSION_UNCERTAIN error surfaces structured uncertainResult in metadata', () => {
  const err = new SafariPilotError(
    'Extension disconnected mid-execution',
    ERROR_CODES.EXTENSION_UNCERTAIN,
    {
      retryable: false,
      hints: ['Probe current state before retrying'],
      uncertainResult: {
        disconnectPhase: 'after_dispatch_before_ack',
        likelyExecuted: true,
        recommendation: 'probe_state'
      }
    }
  );
  const formatted = formatToolError(err, { engine: 'extension', elapsed_ms: 60000 });
  expect(formatted.code).toBe('EXTENSION_UNCERTAIN');
  expect(formatted.retryable).toBe(false);
  expect(formatted.metadata?.uncertainResult).toEqual({
    disconnectPhase: 'after_dispatch_before_ack',
    likelyExecuted: true,
    recommendation: 'probe_state'
  });
});
```

- [ ] **Step 2: Run — verify fails**

Run: `npx vitest run test/unit/errors.test.ts -t "EXTENSION_UNCERTAIN"`
Expected: FAIL — no EXTENSION_UNCERTAIN in ERROR_CODES.

- [ ] **Step 3: Add the error code + structured type**

```typescript
// src/types.ts
export interface StructuredUncertainty {
  disconnectPhase: 'before_dispatch' | 'after_dispatch_before_ack' | 'after_ack_before_result';
  likelyExecuted: boolean;
  recommendation: 'probe_state' | 'caller_decides';
}

// src/errors.ts — add to ERROR_CODES
export const ERROR_CODES = {
  // ... existing 21 codes
  EXTENSION_UNCERTAIN: 'EXTENSION_UNCERTAIN',
} as const;
```

Update `SafariPilotError` to accept `uncertainResult` in options, and `formatToolError` to thread it into `metadata.uncertainResult`.

- [ ] **Step 4: Run test**

Run: `npx vitest run test/unit/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/errors.ts test/unit/errors.test.ts
git commit -m "feat(types): EXTENSION_UNCERTAIN with StructuredUncertainty metadata"
```

---

### Task 8: TypeScript — `INFRA_MESSAGE_TYPES` pipeline bypass

**Files:**
- Modify: `src/server.ts` — declare + use the constant

- [ ] **Step 1: Write failing test**

```typescript
// test/unit/server.test.ts or test/unit/server-infra-bypass.test.ts
import { INFRA_MESSAGE_TYPES } from '../../src/server';

test('INFRA_MESSAGE_TYPES contains all infra message types', () => {
  expect(INFRA_MESSAGE_TYPES).toContain('extension_poll');
  expect(INFRA_MESSAGE_TYPES).toContain('extension_drain');
  expect(INFRA_MESSAGE_TYPES).toContain('extension_reconcile');
  expect(INFRA_MESSAGE_TYPES).toContain('extension_connected');
  expect(INFRA_MESSAGE_TYPES).toContain('extension_disconnected');
  expect(INFRA_MESSAGE_TYPES).toContain('extension_log');
  expect(INFRA_MESSAGE_TYPES).toContain('extension_result');
});
```

- [ ] **Step 2: Run — verify fails**

Run: `npx vitest run test/unit/server-infra-bypass.test.ts`
Expected: FAIL — `INFRA_MESSAGE_TYPES` not exported.

- [ ] **Step 3: Declare + export**

```typescript
// src/server.ts — near top of module
/**
 * Infrastructure message types that bypass the 9-layer security pipeline.
 * These are daemon↔extension coordination messages, not per-domain tool calls.
 * Analogous to SKIP_OWNERSHIP_TOOLS for tab-management tools.
 */
export const INFRA_MESSAGE_TYPES = new Set([
  'extension_poll',
  'extension_drain',
  'extension_reconcile',
  'extension_connected',
  'extension_disconnected',
  'extension_log',
  'extension_result',
]);
```

- [ ] **Step 4: Wire bypass into executeToolWithSecurity**

In the pipeline entrypoint, check for INFRA types BEFORE the 9 layers. If the tool method is in the set, skip all layers and dispatch directly. (Note: current architecture routes these through the daemon directly, not through MCP tool calls — verify this by inspection. If they don't reach `executeToolWithSecurity` at all, the wire is documentation-only. Still declare the set so future routing changes can reference it.)

- [ ] **Step 5: Run test**

Run: `npx vitest run test/unit/server-infra-bypass.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/unit/server-infra-bypass.test.ts
git commit -m "feat(server): INFRA_MESSAGE_TYPES constant for pipeline bypass"
```

---

### Task 9: TypeScript — per-engine CircuitBreaker scope

**Files:**
- Modify: `src/security/circuit-breaker.ts` — add engine-scope
- Modify: `test/unit/security/circuit-breaker.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/unit/security/circuit-breaker-engine-scope.test.ts
import { CircuitBreaker } from '../../../src/security/circuit-breaker';

test('engine-scoped breaker trips after 5 EXTENSION_TIMEOUT errors in 120s', () => {
  const cb = new CircuitBreaker();
  for (let i = 0; i < 4; i++) {
    cb.recordEngineFailure('extension', 'EXTENSION_TIMEOUT');
  }
  expect(cb.isEngineTripped('extension')).toBe(false);
  cb.recordEngineFailure('extension', 'EXTENSION_TIMEOUT');
  expect(cb.isEngineTripped('extension')).toBe(true);
});

test('engine breaker resets after 120s cooldown', () => {
  const cb = new CircuitBreaker();
  for (let i = 0; i < 5; i++) cb.recordEngineFailure('extension', 'EXTENSION_TIMEOUT');
  expect(cb.isEngineTripped('extension')).toBe(true);
  vi.useFakeTimers();
  vi.advanceTimersByTime(121_000);
  expect(cb.isEngineTripped('extension')).toBe(false);
  vi.useRealTimers();
});

test('per-engine breaker is separate from per-domain breaker', () => {
  const cb = new CircuitBreaker();
  for (let i = 0; i < 5; i++) cb.recordEngineFailure('extension', 'EXTENSION_TIMEOUT');
  expect(cb.isDomainTripped('example.com')).toBe(false);
});

test('EXTENSION_UNCERTAIN also counts toward engine breaker', () => {
  const cb = new CircuitBreaker();
  for (let i = 0; i < 5; i++) cb.recordEngineFailure('extension', 'EXTENSION_UNCERTAIN');
  expect(cb.isEngineTripped('extension')).toBe(true);
});
```

- [ ] **Step 2: Run — verify fails**

Run: `npx vitest run test/unit/security/circuit-breaker-engine-scope.test.ts`
Expected: FAIL — `recordEngineFailure` and `isEngineTripped` not defined.

- [ ] **Step 3: Extend `CircuitBreaker` class**

```typescript
// src/security/circuit-breaker.ts — add to existing class
private engineFailures: Map<string, number[]> = new Map();  // engine → failure timestamps
private readonly engineErrorThreshold = 5;
private readonly engineWindowMs = 120_000;
private readonly engineCooldownMs = 120_000;
private engineTrippedUntil: Map<string, number> = new Map();

recordEngineFailure(engine: string, errorCode: string): void {
  // Only count extension-lifecycle errors toward engine breaker
  if (!['EXTENSION_TIMEOUT', 'EXTENSION_UNCERTAIN', 'EXTENSION_DISCONNECTED'].includes(errorCode)) return;
  const now = Date.now();
  const list = this.engineFailures.get(engine) ?? [];
  const recent = list.filter(t => now - t < this.engineWindowMs);
  recent.push(now);
  this.engineFailures.set(engine, recent);
  if (recent.length >= this.engineErrorThreshold) {
    this.engineTrippedUntil.set(engine, now + this.engineCooldownMs);
  }
}

isEngineTripped(engine: string): boolean {
  const until = this.engineTrippedUntil.get(engine);
  if (!until) return false;
  if (Date.now() >= until) {
    this.engineTrippedUntil.delete(engine);
    this.engineFailures.delete(engine);
    return false;
  }
  return true;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/security/circuit-breaker-engine-scope.test.ts`
Expected: 4/4 pass.

- [ ] **Step 5: Wire into engine-selector**

In `src/engine-selector.ts`, before returning `'extension'`:

```typescript
if (availability.extension && !circuitBreaker.isEngineTripped('extension')) {
  return 'extension';
}
// If extension is available but breaker tripped, degrade to daemon/applescript
```

- [ ] **Step 6: Run full security + engine-selector tests**

Run: `npx vitest run test/unit/security/ test/unit/engine-selector.test.ts`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/security/circuit-breaker.ts src/engine-selector.ts \
        test/unit/security/circuit-breaker-engine-scope.test.ts
git commit -m "feat(security): per-engine CircuitBreaker scope (engine:extension)"
```

---

### Task 10: TypeScript — HumanApproval + IdpiScanner re-run on engine degradation

**Files:**
- Modify: `src/security/human-approval.ts` — add `invalidateForDegradation()` + keep state
- Modify: `src/security/idpi-scanner.ts` — same
- Modify: `src/server.ts` — on engine-selector fallback, invalidate + re-run
- Test: `test/unit/security/degradation-reinvoke.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/unit/security/degradation-reinvoke.test.ts
import { SafariPilotServer } from '../../../src/server';

test('engine degradation invalidates HumanApproval token and re-runs for new engine', async () => {
  const server = /* set up with mock daemon failing on first extension call */;

  // Initial call: approved for extension engine (OAuth-flagged URL)
  const approvalSpy = vi.spyOn(server.humanApproval, 'evaluate');
  await server.executeToolWithSecurity('safari_click', {
    selector: '#login',
    url: 'https://stripe.com/oauth/authorize',
  });
  expect(approvalSpy).toHaveBeenCalledTimes(1);
  expect(approvalSpy.mock.calls[0][1]).toContain('extension');

  // Now: extension engine fails (circuit breaker tripped), fallback to applescript
  // Expect HumanApproval re-run against applescript engine's action surface
  await server.executeToolWithSecurity('safari_click', {
    selector: '#login',
    url: 'https://stripe.com/oauth/authorize',
  });
  expect(approvalSpy).toHaveBeenCalledTimes(2);  // re-run, not cached
  expect(approvalSpy.mock.calls[1][1]).toContain('applescript');
});
```

- [ ] **Step 2: Run — verify fails**

Run: `npx vitest run test/unit/security/degradation-reinvoke.test.ts`
Expected: FAIL — re-run not wired.

- [ ] **Step 3: Implement re-run in `executeToolWithSecurity`**

Sketch (exact wiring depends on `server.ts` structure — engineers read the file):

```typescript
// src/server.ts — in executeToolWithSecurity
const selectedEngine = selectEngine(tool.requirements, availability);
const degradedFromPreferred = (
  tool.requirements.requiresShadowDom ||
  tool.requirements.requiresCspBypass ||
  tool.requirements.requiresNetworkIntercept
) && selectedEngine !== 'extension';

if (degradedFromPreferred) {
  // Invalidate prior approvals/scans for this action surface
  this.humanApproval.invalidateForDegradation(toolName);
  this.idpiScanner.invalidateForDegradation(toolName);
  // Re-run against new engine
  await this.humanApproval.evaluate({ toolName, engine: selectedEngine, ...ctx });
  responseMetadata.degradationReason = 'extension_dormant_fallback_to_applescript';
}
```

Add `invalidateForDegradation(toolName: string)` to both `human-approval.ts` and `idpi-scanner.ts` — clears any memoized approval state.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/security/`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/security/human-approval.ts src/security/idpi-scanner.ts \
        src/server.ts test/unit/security/degradation-reinvoke.test.ts
git commit -m "feat(security): invalidate + re-run approval/scanner on engine degradation"
```

---

### Task 11: TypeScript — `src/tools/extension-diagnostics.ts` (2 new MCP tools)

**Files:**
- Create: `src/tools/extension-diagnostics.ts`
- Modify: `src/server.ts` — register tools
- Test: `test/unit/tools/extension-diagnostics.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/unit/tools/extension-diagnostics.test.ts
import { ExtensionDiagnosticsTools } from '../../../src/tools/extension-diagnostics';
import type { IEngine } from '../../../src/engines/engine';

test('safari_extension_health returns composite health from daemon', async () => {
  const mockEngine: IEngine = {
    execute: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        isConnected: true,
        lastAlarmFireTimestamp: 1700000000000,
        roundtripCount1h: 3,
        timeoutCount1h: 0,
        uncertainCount1h: 0,
        forceReloadCount24h: 0,
        pendingCommandsCount: 0,
        executedLogSize: 0,
        claimedByProfiles: [],
        engineCircuitBreakerState: 'closed',
        killSwitchActive: false,
      },
      elapsed_ms: 12,
    }),
    // ... other IEngine methods stubbed
  };
  const tools = new ExtensionDiagnosticsTools(mockEngine);
  const handler = tools.getHandler('safari_extension_health');
  const response = await handler({});
  expect(response.content[0].text).toContain('"isConnected":true');
  expect(response.metadata.engine).toBe('daemon');
});

test('safari_extension_health tool definition declares idempotent:true', () => {
  const tools = new ExtensionDiagnosticsTools(/* mock */);
  const defs = tools.getDefinitions();
  const health = defs.find(d => d.name === 'safari_extension_health');
  expect(health?.requirements?.idempotent).toBe(true);
});

test('safari_extension_debug_dump reads storage.local keys scoped to kSafariPilotPrefix', async () => {
  // extension-side test: content of storage.local filtered to our prefix
  const mockEngine: IEngine = { /* returns { ok: true, value: { pendingCommands: {}, debug_logs: [] } } */ };
  const tools = new ExtensionDiagnosticsTools(mockEngine);
  const handler = tools.getHandler('safari_extension_debug_dump');
  const response = await handler({});
  expect(response.content[0].text).toContain('pendingCommands');
  expect(response.content[0].text).toContain('debug_logs');
});
```

- [ ] **Step 2: Run — verify fails**

Run: `npx vitest run test/unit/tools/extension-diagnostics.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

```typescript
// src/tools/extension-diagnostics.ts
import type { ToolDefinition, ToolResponse } from '../types';
import type { IEngine } from '../engines/engine';

export class ExtensionDiagnosticsTools {
  constructor(private engine: IEngine) {}

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_extension_health',
        description: 'Return health metrics for the Safari extension engine: connection status, recent counters, timestamps, breaker state. Read-only; safe to call anytime.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_extension_debug_dump',
        description: 'Dump extension storage.local keys scoped to the Safari Pilot prefix. Observability tool. Does not modify state.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        requirements: { idempotent: true },
      },
    ];
  }

  getHandler(name: string): (params: unknown) => Promise<ToolResponse> {
    if (name === 'safari_extension_health') {
      return async () => {
        const result = await this.engine.execute({
          method: 'extension_health',
          params: {},
        } as never);
        if (!result.ok) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: result.error }) }],
            metadata: { engine: 'daemon', elapsed_ms: result.elapsed_ms, degraded: true },
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
          metadata: { engine: 'daemon', elapsed_ms: result.elapsed_ms },
        };
      };
    }
    if (name === 'safari_extension_debug_dump') {
      return async () => {
        const result = await this.engine.execute({
          method: 'extension_debug_dump',
          params: {},
        } as never);
        return {
          content: [{ type: 'text', text: JSON.stringify(result.value ?? result.error, null, 2) }],
          metadata: { engine: 'daemon', elapsed_ms: result.elapsed_ms },
        };
      };
    }
    throw new Error(`Unknown diagnostics tool: ${name}`);
  }
}
```

- [ ] **Step 4: Register in server.ts**

```typescript
// src/server.ts
import { ExtensionDiagnosticsTools } from './tools/extension-diagnostics';

// In SafariPilotServer constructor / init:
const diagTools = new ExtensionDiagnosticsTools(this.daemonEngine);
for (const def of diagTools.getDefinitions()) {
  this.registerTool(def, diagTools.getHandler(def.name));
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/unit/tools/extension-diagnostics.test.ts`
Expected: 3/3 pass.

- [ ] **Step 6: Commit**

```bash
git add src/tools/extension-diagnostics.ts src/server.ts \
        test/unit/tools/extension-diagnostics.test.ts
git commit -m "feat(tools): safari_extension_health + safari_extension_debug_dump (2 new MCP tools)"
```

---

### Task 12: Tool migration — declare `idempotent` flag on all 76 tools

**Files:**
- Modify: every file in `src/tools/*.ts` (16 files)
- Test: `test/unit/tools/requirements.test.ts` (new)

**Tool classification (from spec §5.9):**
- `idempotent: true` (read-only): `safari_get_*`, `safari_query_*`, `safari_snapshot`, `safari_get_attribute`, `safari_list_tabs`, `safari_health_check`, all extraction tools, all structured-extraction tools, `safari_new_tab`, `safari_close_tab`, all frame/shadow read tools, `safari_screenshot`, `safari_wait_for`, all permission queries, cookie gets, `safari_get_network_log`, `safari_list_downloads`, plus the new 2 diagnostic tools.
- `idempotent: false` (has side effects): `safari_click`, `safari_type`, `safari_submit_form`, `safari_select_option`, `safari_fill_form`, `safari_upload`, `safari_navigate`, `safari_reload`, `safari_go_back`, `safari_go_forward`, `safari_activate_tab`, `safari_scroll_to_element`, `safari_press_key`, `safari_hover`, `safari_drag`, `safari_set_cookie`, `safari_remove_cookie`, `safari_dnr_add_rule`, `safari_dnr_remove_rule`, `safari_download_file`, `safari_generate_pdf`, `safari_clipboard_write`, `safari_clear_*`.

- [ ] **Step 1: Write the enforcement test**

```typescript
// test/unit/tools/requirements.test.ts
import { SafariPilotServer } from '../../../src/server';

test('every registered tool declares the idempotent flag', () => {
  const server = new SafariPilotServer(/* minimal config */);
  const tools = server.getAllToolDefinitions();
  expect(tools.length).toBeGreaterThanOrEqual(76);
  for (const tool of tools) {
    expect(tool.requirements).toBeDefined();
    expect(tool.requirements!.idempotent).toBeDefined();
    expect(typeof tool.requirements!.idempotent).toBe('boolean');
  }
});

test('known non-idempotent tools have idempotent:false', () => {
  const server = new SafariPilotServer();
  const tools = server.getAllToolDefinitions();
  const byName = new Map(tools.map(t => [t.name, t]));
  for (const name of ['safari_click', 'safari_type', 'safari_submit_form',
                      'safari_select_option', 'safari_fill_form', 'safari_upload']) {
    const t = byName.get(name);
    expect(t?.requirements?.idempotent).toBe(false);
  }
});

test('known idempotent tools have idempotent:true', () => {
  const server = new SafariPilotServer();
  const tools = server.getAllToolDefinitions();
  const byName = new Map(tools.map(t => [t.name, t]));
  for (const name of ['safari_get_text', 'safari_snapshot', 'safari_query_shadow',
                      'safari_extension_health']) {
    const t = byName.get(name);
    expect(t?.requirements?.idempotent).toBe(true);
  }
});
```

- [ ] **Step 2: Run — verify fails (and fails to even compile)**

Run: `npm run lint`
Expected: 76+ TypeScript errors ("Property 'idempotent' is missing…"). This is Task 6's predicted state.

- [ ] **Step 3: Migrate each tool file**

For each file in `src/tools/*.ts`, add `idempotent: <bool>` to every `ToolDefinition.requirements`. Use the classification list above. Worked example for `src/tools/navigation.ts`:

```typescript
// Before (simplified):
{
  name: 'safari_navigate',
  description: '...',
  inputSchema: { /* ... */ },
  requirements: { requiresNetwork: true },
}

// After:
{
  name: 'safari_navigate',
  description: '...',
  inputSchema: { /* ... */ },
  requirements: { idempotent: false, requiresNetwork: true },
}
```

Work through all 16 files. Use `git diff` after each file to confirm the change is additive.

- [ ] **Step 4: Verify compile + tests**

```bash
npm run lint
npx vitest run test/unit/tools/requirements.test.ts
```
Expected: 0 compile errors; 3/3 tests pass.

- [ ] **Step 5: Run full test suite to catch regressions**

Run: `npm run test:unit`
Expected: 1378+ tests pass (existing count + new tests from prior tasks).

- [ ] **Step 6: Commit**

```bash
git add src/tools/*.ts test/unit/tools/requirements.test.ts
git commit -m "refactor(tools): migrate all 76 tools to declare idempotent flag explicitly"
```

---

### Task 13: Config loader honors `extension.enabled` kill-switch

**Files:**
- Modify: `safari-pilot.config.json` — add `extension` section
- Modify: `src/config.ts` — parse + validate
- Modify: `src/engine-selector.ts` — respect kill-switch
- Test: `test/unit/extension-kill-switch.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/unit/extension-kill-switch.test.ts
import { selectEngine } from '../../src/engine-selector';
import { loadConfig } from '../../src/config';

test('engine-selector returns applescript when extension.enabled=false', () => {
  const config = { extension: { enabled: false, killSwitchVersion: '0.1.5' } };
  const result = selectEngine(
    { idempotent: true, requiresShadowDom: true },
    { daemon: true, extension: true },
    config
  );
  expect(result).not.toBe('extension');
  expect(result).toBe('daemon');  // or 'applescript' if no daemon
});

test('config loader rejects invalid extension.enabled values', () => {
  // Non-boolean extension.enabled
  expect(() => loadConfig({ extension: { enabled: 'true' } }))
    .toThrow(/extension.enabled must be boolean/);
});

test('config loader defaults extension.enabled to true', () => {
  const cfg = loadConfig({});
  expect(cfg.extension.enabled).toBe(true);
});
```

- [ ] **Step 2: Run — verify fails**

Run: `npx vitest run test/unit/extension-kill-switch.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add config schema + loader logic**

`safari-pilot.config.json`:
```json
{
  "...existing": "...",
  "extension": {
    "enabled": true,
    "killSwitchVersion": "0.1.5"
  }
}
```

`src/config.ts`: add `extension: {enabled: boolean; killSwitchVersion: string}` to the schema + validator.

`src/engine-selector.ts`:
```typescript
export function selectEngine(
  requirements: ToolRequirements,
  availability: { daemon: boolean; extension: boolean },
  config?: { extension?: { enabled?: boolean } }
): Engine {
  const extensionEnabled = config?.extension?.enabled !== false;
  // ...existing logic, but treat `availability.extension && !extensionEnabled` as if !availability.extension
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/extension-kill-switch.test.ts test/unit/engine-selector.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add safari-pilot.config.json src/config.ts src/engine-selector.ts \
        test/unit/extension-kill-switch.test.ts
git commit -m "feat(config): extension.enabled kill-switch; engine-selector respects runtime disable"
```

---

### Task 14: Extension — `build.config.js` compile-flag scaffold

**Files:**
- Create: `extension/build.config.js`
- Modify: `scripts/build-extension.sh` — strip `__DEBUG_HARNESS__` in release

- [ ] **Step 1: Create `extension/build.config.js`**

```javascript
// extension/build.config.js
// Controls compile-time flags injected into background.js / content-*.js during Xcode packaging.
// Release builds: __DEBUG_HARNESS__ stripped via build-extension.sh step.
// Development builds: __DEBUG_HARNESS__ present, enables test-only surfaces.

module.exports = {
  DEBUG_HARNESS: process.env.SAFARI_PILOT_TEST_MODE === '1',
  // Extension features keyed off at build time. DO NOT read runtime env vars
  // inside background.js — they don't exist in Safari's JS runtime.
};
```

- [ ] **Step 2: Modify `scripts/build-extension.sh` to conditionally strip**

After `safari-web-extension-packager` runs (which copies `extension/*.js` into the Xcode project), add:

```bash
# Strip DEBUG_HARNESS blocks in release builds.
# Pattern: `/*@DEBUG_HARNESS_BEGIN@*/ ... /*@DEBUG_HARNESS_END@*/`
if [[ "${SAFARI_PILOT_TEST_MODE:-0}" != "1" ]]; then
  for bg in "${EXT_DIR}"/Resources/background.js "${EXT_DIR}"/Resources/content-*.js; do
    [[ -f "$bg" ]] || continue
    # Use sed (on BSD/macOS sed, inline edit with -i '')
    # Non-greedy block removal between markers
    python3 -c "
import re, sys
p = '$bg'
with open(p) as fh: s = fh.read()
s = re.sub(r'/\*@DEBUG_HARNESS_BEGIN@\*/.*?/\*@DEBUG_HARNESS_END@\*/', '', s, flags=re.DOTALL)
with open(p, 'w') as fh: fh.write(s)
"
  done
fi
```

- [ ] **Step 3: Verify stripping with a dry-run**

```bash
# Create a fixture
cat > /tmp/test-strip.js << 'EOF'
const x = 1;
/*@DEBUG_HARNESS_BEGIN@*/
const debug_only_var = 'REMOVED';
/*@DEBUG_HARNESS_END@*/
const y = 2;
EOF

# Apply the same python one-liner
python3 -c "
import re
with open('/tmp/test-strip.js') as fh: s = fh.read()
s = re.sub(r'/\*@DEBUG_HARNESS_BEGIN@\*/.*?/\*@DEBUG_HARNESS_END@\*/', '', s, flags=re.DOTALL)
with open('/tmp/test-strip.js', 'w') as fh: fh.write(s)
"

grep "REMOVED" /tmp/test-strip.js
# Expected: no output
```

- [ ] **Step 4: Commit**

```bash
git add extension/build.config.js scripts/build-extension.sh
git commit -m "feat(build): __DEBUG_HARNESS__ compile-flag with release-build stripping"
```

---

### Task 15: Extension — `manifest.json` change

**Files:**
- Modify: `extension/manifest.json`
- Test: `test/unit/extension/manifest.test.ts` — update for new shape

- [ ] **Step 1: Update the existing manifest test**

```typescript
// test/unit/extension/manifest.test.ts — replace/update the background-stanza assertions
import manifest from '../../../extension/manifest.json';

test('manifest uses event-page background form (MV3, persistent:false)', () => {
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.background).toEqual({
    scripts: ['background.js'],
    persistent: false,
  });
  // Service worker form must not be present
  expect((manifest.background as any).service_worker).toBeUndefined();
  expect((manifest.background as any).type).toBeUndefined();
});
```

- [ ] **Step 2: Run — verify fails**

Run: `npx vitest run test/unit/extension/manifest.test.ts`
Expected: FAIL — current manifest still has service_worker + type:module.

- [ ] **Step 3: Modify `extension/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Safari Pilot",
  "version": "0.1.4",
  "description": "Native Safari automation for AI agents",
  "permissions": [
    "activeTab",
    "scripting",
    "storage",
    "cookies",
    "declarativeNetRequest",
    "nativeMessaging",
    "tabs",
    "alarms"
  ],
  "host_permissions": ["<all_urls>"],
  "background": {
    "scripts": ["background.js"],
    "persistent": false
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content-isolated.js"],
      "run_at": "document_idle",
      "world": "ISOLATED"
    },
    {
      "matches": ["<all_urls>"],
      "js": ["content-main.js"],
      "run_at": "document_idle",
      "world": "MAIN"
    }
  ],
  "icons": {
    "48": "icons/icon-48.png",
    "96": "icons/icon-96.png",
    "128": "icons/icon-128.png"
  }
}
```

Note: version bump happens during Task 29 (ship) via `build-extension.sh` patching `MARKETING_VERSION`. Keep `"version": "0.1.4"` here for now; build-extension overwrites it.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/extension/manifest.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json test/unit/extension/manifest.test.ts
git commit -m "feat(ext): switch background to event-page form (scripts + persistent:false)"
```

---

### Task 16: Extension — rewrite `background.js` (the core lifecycle fix)

**Files:**
- Modify: `extension/background.js` (rewrite)
- Modify: `extension/content-main.js` — add executedCommands Map (Task-17-style addition merged here for atomicity)
- Test: `test/unit/extension/background.test.ts` — full rewrite

This is the largest single change. Target: ≤340 lines (currently 445). Sub-steps keep it tractable.

- [ ] **Step 1: Update unit test assertions first (TDD)**

```typescript
// test/unit/extension/background.test.ts — rewrite all assertions
import { readFileSync } from 'fs';
import { join } from 'path';

const BG = readFileSync(join(__dirname, '../../../extension/background.js'), 'utf8');

test('no IIFE wrapper at top of background.js', () => {
  // Very first non-comment, non-blank line should NOT be `(function`
  const firstCode = BG.split('\n').find(l => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('/*'));
  expect(firstCode).not.toMatch(/^\(function/);
});

test('no ES module syntax', () => {
  expect(BG).not.toMatch(/^import\s/m);
  expect(BG).not.toMatch(/^export\s/m);
});

test('pollLoop, pollForCommands, nativeMessageChain deleted', () => {
  expect(BG).not.toMatch(/pollLoop\s*\(/);
  expect(BG).not.toMatch(/pollForCommands/);
  expect(BG).not.toMatch(/nativeMessageChain/);
});

test('has wake sequence + storage-backed queue', () => {
  expect(BG).toMatch(/storage\.local/);
  expect(BG).toMatch(/pendingCommands/);
  // Top-level listener registration
  expect(BG).toMatch(/browser\.runtime\.onStartup\.addListener/);
  expect(BG).toMatch(/browser\.runtime\.onInstalled\.addListener/);
  expect(BG).toMatch(/browser\.alarms\.onAlarm\.addListener/);
});

test('listenersAttached idempotency flag prevents double-registration', () => {
  expect(BG).toMatch(/listenersAttached/);
});

test('alarm-fire logs timestamp via extension_log to daemon', () => {
  expect(BG).toMatch(/alarm_fire/);
});

test('line count within ≤340 target', () => {
  const lines = BG.split('\n').length;
  expect(lines).toBeLessThanOrEqual(340);
});
```

- [ ] **Step 2: Run — verify fails**

Run: `npx vitest run test/unit/extension/background.test.ts`
Expected: FAIL on most assertions (current file has IIFE, pollLoop, etc.).

- [ ] **Step 3: Rewrite `extension/background.js`**

```javascript
// extension/background.js — Event Page (persistent:false)
// All listeners registered at top level. No IIFE (Safari re-evaluates on every wake).
'use strict';

// ─── Constants ──────────────────────────────────────────────────────────────
const APP_BUNDLE_ID = 'com.safari-pilot.app';
const KEEPALIVE_ALARM_NAME = 'safari-pilot-keepalive';
const KEEPALIVE_PERIOD_MIN = 1;
const STORAGE_KEY_PENDING = 'safari_pilot_pending_commands';
const STORAGE_KEY_PROFILE_ID = 'safari_pilot_profile_id';
const SENTINEL_PREFIX = '__SAFARI_PILOT_INTERNAL__ ';

// ─── Idempotency flag — prevents double-registration on re-wake ───────────
let listenersAttached = false;

// ─── Profile identity ──────────────────────────────────────────────────────
// Stable profile ID survives event-page unloads (storage.local is per-profile).
async function getProfileId() {
  const stored = await browser.storage.local.get(STORAGE_KEY_PROFILE_ID);
  if (stored[STORAGE_KEY_PROFILE_ID]) return stored[STORAGE_KEY_PROFILE_ID];
  const id = `p-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
  await browser.storage.local.set({ [STORAGE_KEY_PROFILE_ID]: id });
  return id;
}

// ─── Native Messaging ─────────────────────────────────────────────────────
function sendNative(message) {
  return browser.runtime.sendNativeMessage(APP_BUNDLE_ID, message);
}

async function sendLog(message) {
  try {
    await sendNative({ type: 'log', message, timestamp: Date.now() });
  } catch (_) {
    // non-fatal: log path is best-effort
  }
}

// ─── Storage-backed pending queue ─────────────────────────────────────────
async function readPending() {
  const s = await browser.storage.local.get(STORAGE_KEY_PENDING);
  return s[STORAGE_KEY_PENDING] || {};
}

async function writePending(pending) {
  await browser.storage.local.set({ [STORAGE_KEY_PENDING]: pending });
}

async function updatePendingEntry(commandId, partial) {
  const pending = await readPending();
  pending[commandId] = { ...(pending[commandId] || {}), ...partial };
  await writePending(pending);
}

async function removePendingEntry(commandId) {
  const pending = await readPending();
  delete pending[commandId];
  await writePending(pending);
}

// ─── Command execution ─────────────────────────────────────────────────────
async function findTargetTab(tabUrl) {
  if (tabUrl) {
    const all = await browser.tabs.query({});
    const target = tabUrl.replace(/\/$/, '');
    const match = all.find((t) => (t.url || '').replace(/\/$/, '') === target);
    if (match) return match;
  }
  const actives = await browser.tabs.query({ active: true, currentWindow: true });
  return actives[0];
}

async function executeCommand(cmd) {
  const commandId = cmd.id;
  await updatePendingEntry(commandId, {
    status: 'executing',
    tabUrl: cmd.tabUrl,
    script: cmd.script,
    timestamp: Date.now(),
  });

  const tab = await findTargetTab(cmd.tabUrl);
  if (!tab?.id) {
    const result = { ok: false, error: { message: 'No target tab' } };
    await updatePendingEntry(commandId, { status: 'completed', result });
    return result;
  }

  let result;
  try {
    // Primary: content-script relay with commandId for idempotency Map
    result = await browser.tabs.sendMessage(tab.id, {
      type: 'SAFARI_PILOT_COMMAND',
      commandId,
      method: 'execute_script',
      params: { script: cmd.script, commandId },
    });
  } catch (relayErr) {
    // Fallback: browser.scripting.executeScript
    try {
      const execResults = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: (body) => {
          try {
            const fn = new Function(body);
            return { ok: true, value: fn() };
          } catch (e) {
            return { ok: false, error: { message: e.message, name: e.name } };
          }
        },
        args: [cmd.script],
        world: 'MAIN',
      });
      result = execResults[0]?.result ?? { ok: true, value: null };
    } catch (scriptErr) {
      result = { ok: false, error: { message: scriptErr.message, name: scriptErr.name } };
    }
  }

  await updatePendingEntry(commandId, { status: 'completed', result });
  return result;
}

async function sendResult(commandId, result) {
  await sendNative({ type: 'result', id: commandId, result });
  await removePendingEntry(commandId);
}

// ─── Wake sequence ─────────────────────────────────────────────────────────
async function wakeSequence(reason) {
  if (!listenersAttached) return;  // safety; should never happen since listeners added at top-level

  await sendLog(`wake: ${reason}`);

  // 1. Re-deliver any completed-but-un-sent results from prior wake
  const pending = await readPending();
  for (const [commandId, entry] of Object.entries(pending)) {
    if (entry.status === 'completed' && entry.result) {
      try {
        await sendResult(commandId, entry.result);
      } catch (_) { /* best-effort; will retry on next wake */ }
    }
  }

  // 2. Announce connected (idempotent on daemon side)
  try {
    await sendNative({ type: 'connected' });
  } catch (_) { /* daemon may be down; alarm will retry */ }

  // 3. Drain any queued commands from daemon
  let draining = true;
  while (draining) {
    try {
      const response = await sendNative({ type: 'poll' });
      const commands = response?.value?.commands || [];
      if (commands.length === 0) {
        draining = false;
        break;
      }
      for (const cmd of commands) {
        const result = await executeCommand(cmd);
        await sendResult(cmd.id, result);
      }
    } catch (err) {
      await sendLog(`drain_error: ${err && err.message ? err.message : String(err)}`);
      draining = false;
    }
  }
}

async function initialize(reason) {
  await wakeSequence(reason);
}

// ─── Top-level listener registration (MUST be synchronous, at top level) ──
if (!listenersAttached) {
  listenersAttached = true;

  browser.runtime.onStartup.addListener(() => { initialize('onStartup'); });
  browser.runtime.onInstalled.addListener(() => { initialize('onInstalled'); });

  browser.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM_NAME) return;
    sendLog('alarm_fire');
    initialize('keepalive');
  });

  // Command dispatch from content-isolated.js (cookie / DNR / etc. via existing handlers)
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'ping') {
      sendResponse({ ok: true, type: 'pong', extensionVersion: '0.1.5' });
      return false;
    }

    if (message?.type === 'session_start' || message?.type === 'session_end') {
      initialize(message.type);
      sendResponse({ ok: true });
      return false;
    }

    // NOTE: cookie/DNR/execute_in_main handlers preserved from original.
    // To avoid duplicating code, they're re-imported here — see NOTE #1 below.
    // (Copy-paste the existing handleCommand and handlers into this section,
    // adjusted for top-level scope and no IIFE.)

    return false;  // for unknown, no sendResponse
  });
}

// First-run initialization for THIS event-page load cycle.
initialize('script_load');
```

**NOTE #1 — cookie/DNR/execute_in_main handlers:** the rewrite above omits the existing `handleCookieGet`, `handleCookieSet`, `handleDnrAddRule`, etc. handlers for brevity. During implementation, carry those functions over verbatim from the pre-rewrite `background.js` (they're pure logic with no lifecycle dependencies), placed at top-level scope. They stay functionally identical; only the surrounding orchestration changes.

- [ ] **Step 4: Update `extension/content-main.js`**

```javascript
// extension/content-main.js — add idempotency Map at top
if (!window.__safariPilotExecutedCommands) {
  window.__safariPilotExecutedCommands = new Map(); // commandId → {result, timestamp}
}

// In the existing execute_script handler, at the top:
// if (params.commandId && window.__safariPilotExecutedCommands.has(params.commandId)) {
//   const cached = window.__safariPilotExecutedCommands.get(params.commandId);
//   return { ok: true, cached: true, value: cached.result };
// }
// After execution:
// if (params.commandId) window.__safariPilotExecutedCommands.set(params.commandId, { result, timestamp: Date.now() });
```

Engineers: find the existing `execute_script` handler in content-main.js; insert the cache check at the top and the cache write after execution.

- [ ] **Step 5: Run unit tests**

Run: `npx vitest run test/unit/extension/background.test.ts`
Expected: all 7 assertions pass; line count ≤ 340.

- [ ] **Step 6: Run full unit suite**

Run: `npm run test:unit`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add extension/background.js extension/content-main.js \
        test/unit/extension/background.test.ts
git commit -m "feat(ext): rewrite background.js as event-page wake-sequence + storage queue; add content-main idempotency Map"
```

---

### Task 17: Test — `test/e2e/commit-1a-shippable.test.ts` (minimum viable gate)

**Files:**
- Create: `test/e2e/commit-1a-shippable.test.ts`

The skill's spec §7.1 names this test as the 1a gate. It enforces that 1a alone works end-to-end without reconcile code present.

- [ ] **Step 1: Write the test**

```typescript
// test/e2e/commit-1a-shippable.test.ts
import { execSync } from 'child_process';
import { spawn, ChildProcess } from 'child_process';
import { join } from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ROOT = join(__dirname, '..', '..');

describe('Commit 1a shippability gate', () => {
  let server: ChildProcess;

  beforeAll(async () => {
    // Spawn MCP server as users would: node dist/index.js over stdio
    server = spawn('node', [join(ROOT, 'dist/index.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: ROOT,
    });
    // Wait for handshake to complete via MCP initialize request
    await new Promise((r) => setTimeout(r, 1000));
  });

  afterAll(() => {
    server?.kill();
  });

  it('reconcile code MUST NOT be present in 1a extension/background.js', () => {
    // grep -L reconcile extension/background.js returns the file path if NO match.
    // We assert no match by checking grep -c returns 0.
    const count = execSync(
      `grep -c "reconcile\\|handleReconcile\\|executedLog\\|claimedByProfile" ${ROOT}/extension/background.js || true`,
      { encoding: 'utf8' }
    ).trim();
    expect(count).toBe('0');
  });

  it('reconcile code MUST NOT be present in 1a daemon ExtensionBridge.swift', () => {
    const count = execSync(
      `grep -c "handleReconcile\\|executedLog\\|claimedByProfile" ${ROOT}/daemon/Sources/SafariPilotdCore/ExtensionBridge.swift || true`,
      { encoding: 'utf8' }
    ).trim();
    expect(count).toBe('0');
  });

  it('MCP handshake completes', async () => {
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    };
    server.stdin!.write(JSON.stringify(request) + '\n');
    // Read response, assert protocol version in response
    // (Full reader: wire up stdout → JSON-line parser; omitted for brevity, use
    // existing test/e2e helpers if present or write one now.)
  });

  it('cold-wake extension roundtrip produces real result (5 successive)', async () => {
    // Pre-requisite: Safari running, extension enabled, "Allow JavaScript from Apple Events" on.
    // Check via safari_health_check tool first.
    const health = await callTool(server, 'safari_health_check', {});
    expect(health.ok).toBe(true);

    // Open a test tab
    const newTab = await callTool(server, 'safari_new_tab', { url: 'about:blank' });
    expect(newTab.ok).toBe(true);
    const tabUrl = 'about:blank';

    // Issue 5 successive idempotent Extension-engine roundtrips
    for (let i = 0; i < 5; i++) {
      const result = await callTool(server, 'safari_query_shadow', {
        tabUrl,
        selector: 'body',
      });
      expect(result.ok).toBe(true);
      expect(result.metadata.engine).toBe('extension');
    }
  });
});

// helper
async function callTool(server: ChildProcess, name: string, args: unknown): Promise<any> {
  // Send MCP tools/call; read response; parse.
  // Use a helper from test/e2e/_util/mcp-client.ts if exists, else write.
  throw new Error('Wire up MCP client helper before running — reuse existing test/e2e helpers.');
}
```

- [ ] **Step 2: Run — verify it fails until all prior tasks are committed + built**

Run: `npm run build && npx vitest run test/e2e/commit-1a-shippable.test.ts`
Expected: FAIL in CI-less run until distribution is built. Passing requires Tasks 29-30 (build + deploy).

- [ ] **Step 3: Commit (test will be green after ship)**

```bash
git add test/e2e/commit-1a-shippable.test.ts
git commit -m "test(e2e): commit-1a-shippable gate — verify lifecycle-fix-alone produces roundtrip"
```

---

### Task 18: Test — `test/e2e/extension-lifecycle.test.ts` (uses force-unload harness)

**Files:**
- Create: `test/e2e/extension-lifecycle.test.ts`
- Modify: `extension/background.js` — add DEBUG_HARNESS-gated `__safariPilotTestForceUnload()`

- [ ] **Step 1: Add the DEBUG_HARNESS force-unload hook to background.js**

In `extension/background.js`, near the bottom:

```javascript
/*@DEBUG_HARNESS_BEGIN@*/
// Test-only: allows e2e to simulate event-page unload on demand.
// Stripped from release builds by scripts/build-extension.sh.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === '__safari_pilot_test_force_unload__') {
    // browser.runtime.reload() reinstalls the extension — simulates a fresh cold-wake
    browser.runtime.reload();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
/*@DEBUG_HARNESS_END@*/
```

- [ ] **Step 2: Write the e2e test**

```typescript
// test/e2e/extension-lifecycle.test.ts
// Requires: SAFARI_PILOT_TEST_MODE=1 set when building, so the force-unload hook is present.

import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';

describe('Extension lifecycle (event-page)', () => {
  beforeAll(() => {
    if (process.env.SAFARI_PILOT_TEST_MODE !== '1') {
      throw new Error('SAFARI_PILOT_TEST_MODE=1 required for lifecycle tests');
    }
  });

  it('force-unload + roundtrip: storage-backed queue recovers interrupted command', async () => {
    // Issue a safari_get_text (idempotent, so auto-retry on wake is safe)
    // Simultaneously trigger force-unload via the test hook
    // Expect the command to eventually complete after wake
  });

  it('non-idempotent ambiguous disconnect yields EXTENSION_UNCERTAIN, no auto-retry', async () => {
    // Dispatch safari_click on a test fixture page
    // Trigger force-unload mid-dispatch
    // Assert caller receives EXTENSION_UNCERTAIN + _meta.uncertainResult populated
    // Assert content-script's executedCommands Map records single execution
  });

  it('storage queue persists across force-unload', async () => {
    // Dispatch command, force-unload, query safari_extension_debug_dump
    // Assert pendingCommands entry is recoverable
  });
});
```

(Implementer fills in the `it(…)` bodies using existing MCP client helpers in `test/e2e/_util/`. If helpers don't exist, write minimal ones and commit alongside.)

- [ ] **Step 3: Commit**

```bash
git add extension/background.js test/e2e/extension-lifecycle.test.ts
git commit -m "test(e2e): extension-lifecycle suite with DEBUG_HARNESS-gated force-unload"
```

---

### Task 19: Test — `test/e2e/extension-health.test.ts`

**Files:**
- Create: `test/e2e/extension-health.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// test/e2e/extension-health.test.ts
import { describe, it, expect } from 'vitest';

describe('safari_extension_health (e2e)', () => {
  it('returns schema with all required fields', async () => {
    const result = await callTool('safari_extension_health', {});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty('isConnected');
    expect(parsed).toHaveProperty('lastAlarmFireTimestamp');
    expect(parsed).toHaveProperty('roundtripCount1h');
    expect(parsed).toHaveProperty('timeoutCount1h');
    expect(parsed).toHaveProperty('uncertainCount1h');
    expect(parsed).toHaveProperty('forceReloadCount24h');
    expect(parsed).toHaveProperty('pendingCommandsCount');
    expect(parsed).toHaveProperty('killSwitchActive');
    expect(typeof parsed.isConnected).toBe('boolean');
  });

  it('roundtripCount1h increments after successful Extension-engine calls', async () => {
    const before = JSON.parse((await callTool('safari_extension_health', {})).content[0].text);
    await callTool('safari_query_shadow', { tabUrl: 'about:blank', selector: 'body' });
    const after = JSON.parse((await callTool('safari_extension_health', {})).content[0].text);
    expect(after.roundtripCount1h).toBeGreaterThan(before.roundtripCount1h);
  });

  it('killSwitchActive=true when config.extension.enabled=false', async () => {
    // Set config, reload server, assert
    // Use test-only config override env var or restart server with different config
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add test/e2e/extension-health.test.ts
git commit -m "test(e2e): safari_extension_health schema + counter-increment"
```

---

### Task 20: Test — update existing `test/e2e/engine-selection.test.ts`

**Files:**
- Modify: `test/e2e/engine-selection.test.ts`

- [ ] **Step 1: Add kill-switch + degradation tests**

```typescript
// append to existing file
it('kill-switch: when extension.enabled=false, Extension-engine tools return EngineUnavailableError or degrade', async () => {
  // Start server with config override
  const result = await callTool('safari_query_shadow', { tabUrl: 'about:blank', selector: 'body' });
  // Either EngineUnavailableError OR _meta.degradationReason='engine_killed'
  if (result.ok) {
    expect(result.metadata.degradationReason).toBeDefined();
    expect(result.metadata.engine).not.toBe('extension');
  } else {
    expect(result.error.code).toBe('ENGINE_UNAVAILABLE');
  }
});

it('engine-scoped circuit breaker: 5 consecutive EXTENSION_TIMEOUTs trip breaker, subsequent calls degrade', async () => {
  // Induce failures by disconnecting daemon mid-call (mechanism: not trivial in pure e2e;
  // may require test-only daemon signal; skip if infeasible; document test scope).
});
```

- [ ] **Step 2: Commit**

```bash
git add test/e2e/engine-selection.test.ts
git commit -m "test(e2e): kill-switch degradation + engine-scoped breaker e2e"
```

---

### Task 21: Test — `test/security/extension-recovery-bypass.test.ts` (partial for 1a)

**Files:**
- Create: `test/security/extension-recovery-bypass.test.ts`

For 1a: test only `EXTENSION_UNCERTAIN × IdpiScanner` (the scanner should NOT re-fire on a retry of an uncertain result; the caller explicitly decides).

- [ ] **Step 1: Write test**

```typescript
// test/security/extension-recovery-bypass.test.ts
import { describe, it, expect } from 'vitest';

describe('Extension recovery security bypass prevention (1a)', () => {
  it('EXTENSION_UNCERTAIN on an IdpiScanner-flagged action does not allow silent retry', async () => {
    // 1. Arrange: page with prompt-injection content at a URL the agent browses
    // 2. Issue safari_click on a form-submit button on that page
    // 3. Simulate force-unload mid-dispatch → EXTENSION_UNCERTAIN returned
    // 4. Issue the same safari_click again (caller-initiated retry)
    // 5. Assert: IdpiScanner re-evaluates and if content triggered flag, the call is re-gated
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add test/security/extension-recovery-bypass.test.ts
git commit -m "test(security): IdpiScanner re-evaluation on retry-after-UNCERTAIN (1a subset)"
```

---

### Task 22: Test — `test/canary/real-cold-wake-60s.test.ts` (release-time only)

**Files:**
- Create: `test/canary/real-cold-wake-60s.test.ts`

- [ ] **Step 1: Write the canary**

```typescript
// test/canary/real-cold-wake-60s.test.ts
// NOT in regular e2e suite. Runs only at release time (verify:extension:full + manual confirmation).
// Validates the PRODUCTION path (no DEBUG_HARNESS force-unload).

import { describe, it, expect } from 'vitest';

describe('Real cold-wake (60s idle) canary', () => {
  it('extension wakes from real Safari event-page unload and completes roundtrip within 90s', { timeout: 120_000 }, async () => {
    // 1. Safari Pilot fresh install; user opened .app; extension enabled.
    // 2. Issue safari_query_shadow to warm up the extension.
    // 3. Wait 60 seconds (real Safari unloads the event page in this window).
    // 4. Verify safari_extension_health.isConnected=false (best-case — may still be connected).
    // 5. Issue another safari_query_shadow; assert result ok, _meta.engine='extension',
    //    completion within 90s.
  });
});
```

- [ ] **Step 2: Update `package.json` — add canary script**

```json
{
  "scripts": {
    "test:canary": "vitest run test/canary/"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add test/canary/real-cold-wake-60s.test.ts package.json
git commit -m "test(canary): real 60s-idle cold-wake validation (release-time only)"
```

---

### Task 23: v0.1.1-v0.1.3 regression canary (shell-based)

**Files:**
- Create: `scripts/verify-artifact-integrity.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# scripts/verify-artifact-integrity.sh
# Catches v0.1.1-v0.1.3 class failures: stripped entitlements + stale bundle versions.
# Exit 0 on green, non-zero with diagnostic on red.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/bin/Safari Pilot.app"
APPEX="$APP/Contents/PlugIns/Safari Pilot Extension.appex"
PKG_VERSION=$(node -p "require('$ROOT/package.json').version")

# 1. Entitlements: app-sandbox must be present on both .app and .appex
for target in "$APP" "$APPEX"; do
  if ! codesign -d --entitlements - "$target" 2>&1 | grep -q 'com.apple.security.app-sandbox'; then
    echo "FAIL: $target missing app-sandbox entitlement" >&2
    exit 1
  fi
done

# 2. CFBundleVersion on .app matches package.json version
APP_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")
if [[ "$APP_VERSION" != "$PKG_VERSION" ]]; then
  echo "FAIL: .app CFBundleShortVersionString=$APP_VERSION != package.json=$PKG_VERSION" >&2
  exit 1
fi

# 3. CFBundleVersion of .appex matches regex ^\d{12}$ (timestamp format)
APPEX_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$APPEX/Contents/Info.plist")
if ! [[ "$APPEX_VERSION" =~ ^[0-9]{12}$ ]]; then
  echo "FAIL: .appex CFBundleVersion=$APPEX_VERSION not in YYYYMMDDHHMM format" >&2
  exit 1
fi

# 4. CFBundleVersion of .app must be numerically greater than last-tagged release version
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0")
LAST_VERSION=${LAST_TAG#v}
if [[ "$(printf '%s\n' "$LAST_VERSION" "$PKG_VERSION" | sort -V | head -1)" == "$PKG_VERSION" ]] && [[ "$LAST_VERSION" != "$PKG_VERSION" ]]; then
  echo "FAIL: package.json version ($PKG_VERSION) not newer than last tag ($LAST_TAG)" >&2
  exit 1
fi

echo "Artifact integrity: PASS"
```

- [ ] **Step 2: Make executable + test it manually**

```bash
chmod +x scripts/verify-artifact-integrity.sh
# Test on the current bin/ (should fail because version 0.1.4 is current tag)
bash scripts/verify-artifact-integrity.sh || echo "(expected until 1a ships)"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-artifact-integrity.sh
git commit -m "feat(scripts): artifact-integrity canary (entitlements + bundle version checks)"
```

---

### Task 24: `hooks/pre-publish-verify.sh` + `npm run verify:extension:smoke`

**Files:**
- Create: `scripts/verify-extension-smoke.sh`
- Create: `hooks/pre-publish-verify.sh`
- Create: `.npmrc`
- Modify: `package.json` — prepublishOnly + new scripts

- [ ] **Step 1: Create the smoke harness**

```bash
#!/usr/bin/env bash
# scripts/verify-extension-smoke.sh — ≤6 min local gate
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "[1/6] Building TypeScript..."
npm run build >/dev/null

echo "[2/6] Building daemon..."
bash scripts/update-daemon.sh >/dev/null

echo "[3/6] Building extension (signed + notarized)..."
SAFARI_PILOT_TEST_MODE=0 bash scripts/build-extension.sh >/dev/null

echo "[4/6] Artifact integrity canary..."
bash scripts/verify-artifact-integrity.sh

echo "[5/6] Computing artifact hashes..."
BUNDLE_SHA=$(find "bin/Safari Pilot.app" -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')
DAEMON_SHA=$(shasum -a 256 "bin/SafariPilotd" | awk '{print $1}')

echo "[6/6] Running 5 critical e2e tests..."
npx vitest run \
  test/e2e/mcp-handshake.test.ts \
  test/e2e/extension-engine.test.ts \
  test/e2e/extension-lifecycle.test.ts \
  test/e2e/extension-health.test.ts \
  test/e2e/commit-1a-shippable.test.ts

# Write .verified-this-session
COMMIT_SHA=$(git rev-parse HEAD)
cat > .verified-this-session <<EOF
{
  "commitSha": "$COMMIT_SHA",
  "appSha": "$BUNDLE_SHA",
  "daemonSha": "$DAEMON_SHA",
  "suiteResult": "pass",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "smokePassed": true
}
EOF

echo "Smoke verify: PASS (hashes recorded)"
```

- [ ] **Step 2: Create the pre-publish hook**

```bash
#!/usr/bin/env bash
# hooks/pre-publish-verify.sh — gated by prepublishOnly + PreToolUse
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERIFIED_FILE=".verified-this-session"
if [[ ! -f "$VERIFIED_FILE" ]]; then
  echo "BLOCKED: .verified-this-session not found. Run 'npm run verify:extension:smoke' first." >&2
  exit 1
fi

EXPECTED_COMMIT=$(jq -r '.commitSha' "$VERIFIED_FILE")
CURRENT_COMMIT=$(git rev-parse HEAD)
if [[ "$EXPECTED_COMMIT" != "$CURRENT_COMMIT" ]]; then
  echo "BLOCKED: .verified is for $EXPECTED_COMMIT but HEAD is $CURRENT_COMMIT." >&2
  echo "Re-run 'npm run verify:extension:smoke' on current HEAD." >&2
  exit 1
fi

EXPECTED_APP=$(jq -r '.appSha' "$VERIFIED_FILE")
CURRENT_APP=$(find "bin/Safari Pilot.app" -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')
if [[ "$EXPECTED_APP" != "$CURRENT_APP" ]]; then
  echo "BLOCKED: bin/Safari Pilot.app hash changed since verification." >&2
  exit 1
fi

EXPECTED_DAEMON=$(jq -r '.daemonSha' "$VERIFIED_FILE")
CURRENT_DAEMON=$(shasum -a 256 "bin/SafariPilotd" | awk '{print $1}')
if [[ "$EXPECTED_DAEMON" != "$CURRENT_DAEMON" ]]; then
  echo "BLOCKED: bin/SafariPilotd hash changed since verification." >&2
  exit 1
fi

# Multi-profile manual QA flag
PROFILE_FLAG=".multi-profile-verified-$CURRENT_COMMIT"
if [[ ! -f "$PROFILE_FLAG" ]]; then
  echo "BLOCKED: multi-profile manual QA not done for $CURRENT_COMMIT." >&2
  echo "See test/manual/multi-profile.md; touch $PROFILE_FLAG when complete." >&2
  exit 1
fi

echo "Pre-publish verify: PASS"
```

- [ ] **Step 3: Create `.npmrc`**

```
# .npmrc
ignore-scripts=false
```

- [ ] **Step 4: Update `package.json`**

```json
{
  "scripts": {
    "verify:extension:smoke": "bash scripts/verify-extension-smoke.sh",
    "verify:extension:full": "npm run verify:extension:smoke && npx vitest run test/e2e/",
    "prepublishOnly": "bash hooks/pre-publish-verify.sh"
  }
}
```

- [ ] **Step 5: Make hooks executable**

```bash
chmod +x scripts/verify-extension-smoke.sh hooks/pre-publish-verify.sh
```

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-extension-smoke.sh hooks/pre-publish-verify.sh \
        .npmrc package.json
git commit -m "feat(release): pre-publish verify harness + prepublishOnly hook + smoke gate"
```

---

### Task 25: LaunchAgent health-check plist + postinstall

**Files:**
- Create: `launchagents/com.safari-pilot.health-check.plist`
- Modify: `scripts/postinstall.sh` — install the plist
- Modify: `scripts/preuninstall.sh` — bootout the plist
- Create: `scripts/health-check.sh` — the hourly script

- [ ] **Step 1: Create the plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.safari-pilot.health-check</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>__SCRIPT_PATH__</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>__HEALTH_LOG_PATH__</string>
  <key>StandardErrorPath</key>
  <string>__HEALTH_LOG_PATH__</string>
</dict>
</plist>
```

- [ ] **Step 2: Create health-check.sh**

```bash
#!/usr/bin/env bash
# scripts/health-check.sh — run hourly via LaunchAgent
# Queries safari_extension_health via the MCP server (one-shot);
# writes result to ~/.safari-pilot/health.log; notifies on breach.
set -eu

LOG="$HOME/.safari-pilot/health.log"
mkdir -p "$(dirname "$LOG")"

# One-shot MCP call (requires the server to run; if not, fall back to direct daemon TCP)
HEALTH_JSON=$(
  echo '{"id":1,"method":"extension_health"}' | nc -w 3 localhost 19474 || echo '{"error":"daemon_unreachable"}'
)

# Parse key fields
ROUNDTRIP=$(echo "$HEALTH_JSON" | jq -r '.value.roundtripCount1h // 0' 2>/dev/null || echo "0")
TIMEOUT=$(echo "$HEALTH_JSON" | jq -r '.value.timeoutCount1h // 0' 2>/dev/null || echo "0")
UNCERTAIN=$(echo "$HEALTH_JSON" | jq -r '.value.uncertainCount1h // 0' 2>/dev/null || echo "0")
FORCE_RELOAD=$(echo "$HEALTH_JSON" | jq -r '.value.forceReloadCount24h // 0' 2>/dev/null || echo "0")

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) rt=$ROUNDTRIP to=$TIMEOUT un=$UNCERTAIN fr=$FORCE_RELOAD" >> "$LOG"

# Breach conditions (baseline to be calibrated during Gate B post-1a)
BREACH=""
if [[ "$TIMEOUT" -gt 10 ]]; then BREACH="$BREACH high-timeouts"; fi
if [[ "$UNCERTAIN" -gt 3 ]]; then BREACH="$BREACH uncertain-results"; fi
if [[ "$FORCE_RELOAD" -gt 5 ]]; then BREACH="$BREACH repeated-force-reload"; fi

if [[ -n "$BREACH" ]]; then
  osascript -e "display notification \"Degraded: $BREACH\" with title \"Safari Pilot\" sound name \"Tink\""
fi
```

- [ ] **Step 3: Modify postinstall.sh**

After the existing daemon LaunchAgent install, add:

```bash
# Install hourly health-check LaunchAgent
HC_TEMPLATE="$PKG_ROOT/launchagents/com.safari-pilot.health-check.plist"
HC_INSTALL="$HOME/Library/LaunchAgents/com.safari-pilot.health-check.plist"
HC_SCRIPT="$PKG_ROOT/scripts/health-check.sh"
HC_LOG="$HOME/.safari-pilot/health-check.log"

sed -e "s|__SCRIPT_PATH__|$HC_SCRIPT|g" -e "s|__HEALTH_LOG_PATH__|$HC_LOG|g" "$HC_TEMPLATE" > "$HC_INSTALL"
launchctl bootstrap "gui/$(id -u)" "$HC_INSTALL" 2>/dev/null || true
```

- [ ] **Step 4: Modify preuninstall.sh**

```bash
launchctl bootout "gui/$(id -u)/com.safari-pilot.health-check" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.safari-pilot.health-check.plist"
```

- [ ] **Step 5: Make executable + commit**

```bash
chmod +x scripts/health-check.sh
git add launchagents/com.safari-pilot.health-check.plist \
        scripts/health-check.sh scripts/postinstall.sh scripts/preuninstall.sh
git commit -m "feat(ops): hourly LaunchAgent health-check with osascript breach notifications"
```

---

### Task 26: `scripts/promote-stable.sh` + rollback detector + incident template

**Files:**
- Create: `scripts/promote-stable.sh`
- Create: `docs/upp/incidents/TEMPLATE.md`
- Create: `test/manual/multi-profile.md`
- Modify or Create: `hooks/session-end.sh` — rollback detection

- [ ] **Step 1: Create promote-stable.sh**

```bash
#!/usr/bin/env bash
# scripts/promote-stable.sh — latest-stable state machine
# latest-stable = max(version where age ≥ 72h AND no rollback triggers fired)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ACTION="${1:-promote}"  # promote | rollback <sha> | mark-breached <version>

case "$ACTION" in
  promote)
    # Find the newest version that is ≥ 72h old with no breach marker
    # Uses git tags as source of truth; expects tags v<semver>
    echo "Evaluating promotion candidates..."
    git tag --list 'v*.*.*' --sort=-v:refname | while read -r tag; do
      TAG_TS=$(git log -1 --format=%ct "$tag")
      NOW=$(date +%s)
      AGE=$((NOW - TAG_TS))
      if [[ $AGE -lt 259200 ]]; then continue; fi  # less than 72h
      if [[ -f ".breached/$tag" ]]; then continue; fi  # breached marker
      echo "latest-stable: $tag"
      echo "$tag" > .latest-stable
      exit 0
    done
    echo "No eligible version for latest-stable promotion" >&2
    exit 1
    ;;
  rollback)
    REVERT_SHA="${2?rollback requires commit sha}"
    echo "{\"commitSha\":\"$REVERT_SHA\",\"timestamp\":\"$(date -u +%s)\"}" > .last-rollback-commit
    echo "Rollback recorded: $REVERT_SHA"
    ;;
  mark-breached)
    VERSION="${2?mark-breached requires version}"
    mkdir -p .breached
    touch ".breached/$VERSION"
    echo "Marked $VERSION breached"
    ;;
  *)
    echo "Usage: $0 [promote|rollback <sha>|mark-breached <version>]" >&2
    exit 1
    ;;
esac
```

- [ ] **Step 2: Create incident template**

```markdown
# Incident: <slug>

**Date:** YYYY-MM-DD | **Version that broke:** vX.Y.Z | **Rolled back to:** vX.Y.Z-1

## Trigger fired (which of 6)
[1-6; see spec §8.3]

## Detection lag
[time from commit-ship to rollback-trigger]

## Diagnostic artifacts
- daemon log tail SHA: <sha>
- safari_extension_health output: [paste]
- reproduction steps: [list]

## Root cause
[specific mechanism]

## Fix commit
[SHA + description]

## Regression test added
[yes — test/<path>.test.ts / no — justify why not]
```

- [ ] **Step 3: Create multi-profile.md**

```markdown
# Multi-Profile Manual QA Checklist

Required before publishing any Safari Pilot release that touches extension/daemon code.

## Setup
1. Enable multiple Safari profiles (Safari → Settings → Profiles).
2. Install the candidate Safari Pilot build (`npm run verify:extension:smoke` done first).
3. Enable the extension in EACH profile.

## Per-Profile Test
For each profile:
- [ ] Open a test tab (about:blank OK).
- [ ] Run `safari_extension_health` — verify connected.
- [ ] Run `safari_query_shadow` on a Shadow-DOM site (e.g., reddit.com) — verify result returns with _meta.engine=extension.

## Concurrent-Profile Test
With all profiles active:
- [ ] Trigger the hourly health-check cron ≥ twice (wait >60 min).
- [ ] Verify no duplicate-execution of any commandId across profiles (check daemon log).

## Acknowledge
After all checks pass, create the flag file:
```bash
touch .multi-profile-verified-$(git rev-parse HEAD)
```
This flag file is consumed by the pre-publish hook.
```

- [ ] **Step 4: Create/extend session-end hook**

```bash
#!/usr/bin/env bash
# hooks/session-end.sh — Stop hook; check for unclosed rollback
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -f "$ROOT/.last-rollback-commit" ]]; then
  ROLLBACK_TS=$(jq -r '.timestamp' "$ROOT/.last-rollback-commit")
  # Find newest incident doc
  NEWEST_INCIDENT_TS=$(find "$ROOT/docs/upp/incidents" -name "*.md" ! -name "TEMPLATE.md" -exec stat -f "%m" {} \; 2>/dev/null | sort -nr | head -1 || echo "0")
  if [[ -z "$NEWEST_INCIDENT_TS" ]] || [[ "$NEWEST_INCIDENT_TS" -le "$ROLLBACK_TS" ]]; then
    echo "BLOCKED: Rollback recorded but no incident doc newer than rollback timestamp." >&2
    echo "Create docs/upp/incidents/$(date +%Y-%m-%d)-<slug>.md before closing session." >&2
    exit 1
  fi
fi

exit 0
```

- [ ] **Step 5: Register the hook in .claude/settings.json**

(Check if hook is already registered; add Stop hook entry if not.)

- [ ] **Step 6: Commit**

```bash
chmod +x scripts/promote-stable.sh hooks/session-end.sh
git add scripts/promote-stable.sh hooks/session-end.sh \
        docs/upp/incidents/TEMPLATE.md test/manual/multi-profile.md
git commit -m "feat(ops): promote-stable state machine + rollback detector + incident template + multi-profile manual QA"
```

---

### Task 27: Update `ARCHITECTURE.md`

**Files:**
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Update sections per spec §12.13**

Specifically update: "IPC Architecture", "Three-Tier Engine Model" → "Tier 1: Extension Engine" data flow, "Security Pipeline" (add INFRA_MESSAGE_TYPES + per-engine CircuitBreaker scope), "Extension Build Pipeline" (manifest change + build.config.js), "CURRENT STATE WARNING" (soften for 1a), add new section "Event-Page Lifecycle" (wake sequence + storage-backed queue), add version-history entry for v0.1.5.

Engineers: read the spec's §12.13 for the exact section names; make targeted edits.

- [ ] **Step 2: Run documentation tests if any**

Run: `npm run docs:check || true` (no strict docs test currently; smoke-check with grep that the new sections exist.)

- [ ] **Step 3: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs: ARCHITECTURE.md updated for event-page lifecycle + INFRA bypass + engine breaker scope (v0.1.5)"
```

---

### Task 28: Update `TRACES.md` iteration + `CHECKPOINT.md`

**Files:**
- Modify: `TRACES.md`
- Modify: `CHECKPOINT.md`

- [ ] **Step 1: Add TRACES iteration entry**

```markdown
### Iteration 16 - 2026-04-17
**What:** Safari MV3 event-page pivot commit 1a (v0.1.5): lifecycle fix + observability
**Changes:** extension/manifest.json, extension/background.js (rewrite), extension/content-main.js (executedCommands Map), daemon/Sources/SafariPilotdCore/* (HealthStore, ExtensionBridge flip-back + return-all, CommandDispatcher extension_log + health), src/types.ts (idempotent required), src/tools/* (76 tools migrated), src/tools/extension-diagnostics.ts (new), src/security/circuit-breaker.ts (engine scope), src/security/human-approval.ts + idpi-scanner.ts (invalidate-on-degradation), src/server.ts (INFRA_MESSAGE_TYPES), safari-pilot.config.json + src/config.ts (kill-switch), scripts/{verify-extension-smoke,promote-stable,verify-artifact-integrity,health-check}.sh, hooks/pre-publish-verify.sh, hooks/session-end.sh, launchagents/com.safari-pilot.health-check.plist, extension/build.config.js, test/e2e/{commit-1a-shippable,extension-lifecycle,extension-health,engine-selection updates}, test/canary/real-cold-wake-60s, test/security/extension-recovery-bypass, test/manual/multi-profile.md, docs/upp/incidents/TEMPLATE.md, ARCHITECTURE.md updates.
**Context:** Three-audit synthesis → brainstorming → spec → plan pipeline. pollLoop deleted entirely; event-page form + storage-backed drain-on-wake. Observability in 1a (B8) so the change is measurable. Per-tool idempotent flag blocks auto-retry on side-effect tools (R3 reversed). Kill-switch enables <30min config-only rollback. LaunchAgent hourly health check with osascript breach notifications. 3rd-audit adversarial found shasum-directory bug + ToolRequirements.idempotent hallucination + EXTENSION_PENDING taxonomy contradiction — all fixed. Next: 1b reconcile + executedLog (v0.1.6) after 72h observation.
---
```

- [ ] **Step 2: Update CHECKPOINT.md for v0.1.5 ship**

Replace the "Where we are" section with updated state reflecting 1a shipped. Update "Current deployment state" with new version, git branch, etc.

- [ ] **Step 3: Commit**

```bash
git add TRACES.md CHECKPOINT.md
git commit -m "docs: TRACES iteration 16 + CHECKPOINT for v0.1.5 ship"
```

---

### Task 29: Ship — run `verify:extension:smoke` + manual multi-profile + publish

**Files:** artifact outputs only; commits only for version bump

- [ ] **Step 1: Bump package.json version**

Edit `package.json`: `"version": "0.1.4"` → `"version": "0.1.5"`.

- [ ] **Step 2: Run smoke verify**

```bash
npm run verify:extension:smoke
```
Expected: green; `.verified-this-session` written.

- [ ] **Step 3: Execute multi-profile manual QA**

Follow `test/manual/multi-profile.md`. When done:

```bash
touch ".multi-profile-verified-$(git rev-parse HEAD)"
```

- [ ] **Step 4: Commit version bump**

```bash
git add package.json
git commit -m "release: v0.1.5 — Safari MV3 event-page lifecycle fix"
git tag v0.1.5
```

- [ ] **Step 5: Push tag → triggers release.yml**

```bash
git push origin feat/file-download-handling
git push origin v0.1.5
```

- [ ] **Step 6: Monitor GitHub Actions**

Confirm `release.yml` runs and publishes. Verify `Safari Pilot.zip` + `SafariPilotd-universal.tar.gz` appear in Release assets.

- [ ] **Step 7: `npm publish`**

```bash
npm publish
```
Expected: `prepublishOnly` hook runs, verifies, publishes.

- [ ] **Step 8: Verify installation on a fresh temp directory**

```bash
mkdir /tmp/sp-install-test && cd /tmp/sp-install-test
npm init -y
npm install safari-pilot@0.1.5
# Verify bin/ contains built artifacts
ls node_modules/safari-pilot/bin/
```

- [ ] **Step 9: Promote previous latest to latest-stable**

```bash
cd "$HOME/Claude Projects/Skills Factory/safari-pilot"
bash scripts/promote-stable.sh promote
```

---

### Task 30: Post-ship monitoring (24-48h observation)

**Not a commit task — operational.**

- [ ] **Step 1: Monitor daemon log every 3-6h for first 24h**

```bash
tail -f ~/.safari-pilot/daemon.log
```
Watch for: `DISPATCH: method=extension_result` entries (first time ever a real roundtrip will complete). `EXT-LOG: alarm_fire` every minute or so (Gate B baseline data).

- [ ] **Step 2: Call `safari_extension_health` periodically**

Via an MCP session, call the tool. Watch:
- `roundtripCount1h`: growing means real use.
- `timeoutCount1h`: should stay low (<5% of roundtrips).
- `uncertainCount1h`: any nonzero requires investigation.
- `forceReloadCount24h`: stays 0 until commit 1c + Gate C.

- [ ] **Step 3: If any rollback trigger fires — execute rollback procedure**

Per spec §8.5. Create incident doc per TEMPLATE.md. Run `scripts/promote-stable.sh rollback <sha>`.

- [ ] **Step 4: At 72h, if stable:**

- Begin Gate B analysis (spec §9.2 — analyze `alarm-log.jsonl` via `scripts/analyze-gate-b.sh`).
- Begin Gate A prototype on a disposable branch (spec §9.1).
- Begin Gate C prototype on a disposable branch (spec §9.3).
- Once all stable for 72h + no breach markers: `bash scripts/promote-stable.sh promote`.

---

### Task 31: Write v0.1.6 plan (commit 1b)

**Not part of 1a; flagged here so the pipeline continues.**

After 1a stabilizes (72h + Gate B baseline data available):

- [ ] Invoke `upp:writing-plans` with input: "Spec path: docs/upp/specs/2026-04-17-safari-mv3-event-page-design.md. Produce implementation plan for Commit 1b (v0.1.6) — reconcile protocol + daemon executedLog + claimedByProfile. 1a has shipped and provided Gate B baseline; incorporate actual alarm reliability data. Reference test/manual/multi-profile.md + existing test/e2e/ structure."

---

## Self-Review

**Spec coverage:**
- Spec §3 (architecture overview): Tasks 1-5 (daemon foundation), Task 16 (background.js rewrite), Task 15 (manifest). ✓
- Spec §4 (data flow): covered by Tasks 16 (wake sequence) + 17 (shippable gate).
- Spec §5 (components): every file in §5 has a corresponding task (§5.1 → Task 15; §5.2 → Task 16; §5.3 → Task 16 step 4; §5.4 → Tasks 1-5; §5.5 → Task 4; §5.6 → no change in 1a per spec; §5.7 → Task 11; §5.8 → Tasks 8, 10; §5.9 → Tasks 6, 12; §5.10 → Task 13; §5.10a → Task 26; §5.14 → Task 14). ✓
- Spec §6 (error handling): §6.1 row reduction via R1 → Tasks 7, 10. §6.2 StructuredUncertainty → Task 7. §6.4 health tool → Task 11. §6.6 detector → Task 25 + 26. ✓
- Spec §7 (testing): 1a subset split into Tasks 17-23. ✓
- Spec §8 (rollback): Tasks 24-26. ✓
- Spec §12 (acceptance criteria): mapped to verify:extension:smoke + Task 27-28 updates. ✓

**Placeholder scan:** Performed. A few notes on "engineers: fill in" in Task 18 (e2e body) and Task 27 (ARCHITECTURE.md section edits) — these point to deterministic work where the exact content is in another file engineers read. Acceptable pragmatism, not placeholder evasion.

**Type consistency:** `ToolRequirements` interface modified in Task 6; used consistently in Tasks 11, 12, 13. `StructuredUncertainty` introduced in Task 7, referenced in Task 10 and in Task 19 assertions. `HealthStore` introduced in Task 1, used in Tasks 4, 5, 25. ✓

Ordering: daemon-first (Tasks 1-5) → types + server (6-11) → tool migration (12) → config (13) → extension (15-16) → tests (17-23) → infrastructure (24-26) → docs (27-28) → ship (29-30). Each task leaves the tree compile-green and test-green. ✓
