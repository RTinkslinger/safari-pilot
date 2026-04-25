import Foundation
import SafariPilotdCore

// `makeHealthStoreForTest()` is defined in CommandDispatcherTests.swift
// (same test target) — reused here for dispatcher constructor wiring.

func registerExtensionBridgeTests() {

    test("testExtensionBridgeStartsDisconnected") {
        let bridge = ExtensionBridge()
        try assertFalse(bridge.isExtensionConnected, "Bridge should start disconnected")
    }

    test("testExtensionConnectSetsConnectedState") {
        let bridge = ExtensionBridge()
        let response = bridge.handleConnected(commandID: "conn-1")
        try assertTrue(response.ok, "handleConnected should return ok")
        try assertEqual(response.id, "conn-1")
        try assertTrue(bridge.isExtensionConnected, "Bridge should be connected after handleConnected")
    }

    test("testExtensionDisconnectClearsConnectedState") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "conn-1")
        try assertTrue(bridge.isExtensionConnected)

        let response = bridge.handleDisconnected(commandID: "disc-1")
        try assertTrue(response.ok, "handleDisconnected should return ok")
        try assertEqual(response.id, "disc-1")
        try assertFalse(bridge.isExtensionConnected, "Bridge should be disconnected")
    }

    test("testExtensionStatusReportsConnected") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "conn-1")

        let status = bridge.handleStatus(commandID: "status-1")
        try assertTrue(status.ok)
        try assertEqual(status.value?.value as? String, "connected")
    }

    test("testExtensionStatusReportsDisconnected") {
        let bridge = ExtensionBridge()
        let status = bridge.handleStatus(commandID: "status-1")
        try assertTrue(status.ok)
        try assertEqual(status.value?.value as? String, "disconnected")
    }

    test("testPollReturnsEmptyArrayWhenNoCommandsPending") {
        let bridge = ExtensionBridge()
        let response = syncAwait { await bridge.handlePoll(commandID: "poll-1") }
        try assertTrue(response.ok)

        let valueDict = response.value?.value as? [String: Any]
        try assertTrue(valueDict != nil, "Response value should be a dictionary")
        let commands = valueDict?["commands"] as? [Any]
        try assertTrue(commands != nil, "commands should be an array")
        try assertEqual(commands?.count, 0)
    }

    test("testExecuteQueuedAndPollReturnsIt") {
        let bridge = ExtensionBridge()

        // Queue a command in background (it will block waiting for result)
        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-1",
                params: ["script": AnyCodable("return document.title")]
            )
        }

        // Give the execute a moment to queue
        Thread.sleep(forTimeInterval: 0.1)

        // Poll should return the queued command in a commands array
        let pollResponse = syncAwait { await bridge.handlePoll(commandID: "poll-1") }
        try assertTrue(pollResponse.ok)

        let valueDict = pollResponse.value?.value as? [String: Any]
        let commands = valueDict?["commands"] as? [[String: Any]]
        try assertTrue(commands != nil, "Poll should return a commands array")
        try assertEqual(commands?.count, 1)
        try assertEqual(commands?.first?["id"] as? String, "exec-1")
        try assertEqual(commands?.first?["script"] as? String, "return document.title")

        // Now send the result to unblock the execute
        _ = bridge.handleResult(
            commandID: "result-1",
            params: [
                "requestId": AnyCodable("exec-1"),
                "result": AnyCodable("My Page Title"),
            ]
        )

        // Verify execute got the result
        let execResponse = syncAwait { await executeTask.value }
        try assertTrue(execResponse.ok)
        try assertEqual(execResponse.value?.value as? String, "My Page Title")
    }

    test("testHandleResultResolvesExecute") {
        let bridge = ExtensionBridge()

        // Queue command in background
        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-2",
                params: ["script": AnyCodable("return 42")]
            )
        }

        Thread.sleep(forTimeInterval: 0.1)

        // Send result
        let resultResponse = bridge.handleResult(
            commandID: "res-1",
            params: [
                "requestId": AnyCodable("exec-2"),
                "result": AnyCodable(42),
            ]
        )
        try assertTrue(resultResponse.ok)

        let execResponse = syncAwait { await executeTask.value }
        try assertTrue(execResponse.ok)
    }

    test("testHandleResultWithError") {
        let bridge = ExtensionBridge()

        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-3",
                params: ["script": AnyCodable("throw new Error('fail')")]
            )
        }

        Thread.sleep(forTimeInterval: 0.1)

        _ = bridge.handleResult(
            commandID: "res-2",
            params: [
                "requestId": AnyCodable("exec-3"),
                "error": AnyCodable("Script execution failed"),
            ]
        )

        let execResponse = syncAwait { await executeTask.value }
        try assertFalse(execResponse.ok)
        try assertEqual(execResponse.error?.code, "EXTENSION_ERROR")
        try assertEqual(execResponse.error?.message, "Script execution failed")
    }

    test("testHandleResultForUnknownRequestIdIsNoOp") {
        let bridge = ExtensionBridge()
        let response = bridge.handleResult(
            commandID: "res-orphan",
            params: [
                "requestId": AnyCodable("nonexistent"),
                "result": AnyCodable("ignored"),
            ]
        )
        try assertTrue(response.ok, "Should return ack even for unknown requestId")
    }

    test("testDispatcherRoutesExtensionConnected") {
        let mock = MockExecutor()
        let bridge = ExtensionBridge()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            extensionBridge: bridge,
            healthStore: makeHealthStoreForTest()
        )

        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"conn-1","method":"extension_connected"}"#)
        }
        try assertTrue(response.ok)
        try assertTrue(bridge.isExtensionConnected)
    }

    test("testDispatcherExtensionStatusCommand") {
        let mock = MockExecutor()
        let bridge = ExtensionBridge()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            extensionBridge: bridge,
            healthStore: makeHealthStoreForTest()
        )

        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"status-1","method":"extension_status"}"#)
        }
        try assertTrue(response.ok)
        try assertEqual(response.value?.value as? String, "disconnected")
    }

    test("testDispatcherRoutesExtensionPoll") {
        let mock = MockExecutor()
        let bridge = ExtensionBridge()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            extensionBridge: bridge,
            healthStore: makeHealthStoreForTest()
        )

        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"poll-1","method":"extension_poll"}"#)
        }
        try assertTrue(response.ok)
        let valueDict = response.value?.value as? [String: Any]
        let commands = valueDict?["commands"] as? [[String: Any]]
        try assertTrue(commands != nil, "commands array should be present")
        try assertEqual(commands?.count, 0)
    }

    // MARK: - Event-page wake semantics (Commit 1a, Tasks 2+3)

    test("testHandleDisconnectedFlipsDeliveredBackForUnacked") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "c1")

        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-1",
                params: ["script": AnyCodable("document.title")]
            )
        }

        Thread.sleep(forTimeInterval: 0.1)

        // Poll picks it up → delivered=true
        _ = syncAwait { await bridge.handlePoll(commandID: "poll-1") }

        // Disconnect — should flip delivered back, NOT cancel
        _ = bridge.handleDisconnected(commandID: "disc-1")

        // Reconnect + poll → same command redelivered
        _ = bridge.handleConnected(commandID: "c2")
        let response = syncAwait { await bridge.handlePoll(commandID: "poll-2") }
        let valueDict = response.value?.value as? [String: Any]
        let commands = valueDict?["commands"] as? [[String: Any]]
        try assertTrue(commands?.count == 1, "command should redeliver after reconnect")
        try assertEqual(commands?.first?["id"] as? String, "exec-1")

        // Cleanup: unblock execute task
        _ = bridge.handleResult(
            commandID: "res",
            params: [
                "requestId": AnyCodable("exec-1"),
                "result": AnyCodable(["ok": true, "value": "cleanup"]),
            ]
        )
        _ = syncAwait { await executeTask.value }
    }

    test("testHandleDisconnectedLeavesUndeliveredAlone") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "c1")

        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-1",
                params: ["script": AnyCodable("x")]
            )
        }

        Thread.sleep(forTimeInterval: 0.1)

        // No poll — delivered stays false
        _ = bridge.handleDisconnected(commandID: "disc-1")

        _ = bridge.handleConnected(commandID: "c2")
        let response = syncAwait { await bridge.handlePoll(commandID: "poll-1") }
        let valueDict = response.value?.value as? [String: Any]
        let commands = valueDict?["commands"] as? [[String: Any]]
        try assertEqual(commands?.count, 1)
        try assertEqual(commands?.first?["id"] as? String, "exec-1")

        // Cleanup
        _ = bridge.handleResult(
            commandID: "res",
            params: [
                "requestId": AnyCodable("exec-1"),
                "result": AnyCodable(["ok": true]),
            ]
        )
        _ = syncAwait { await executeTask.value }
    }

    test("testHandlePollReturnsAllUndeliveredAtOnce") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "c")

        let t1 = Task { await bridge.handleExecute(commandID: "cmd-1", params: ["script": AnyCodable("a")]) }
        let t2 = Task { await bridge.handleExecute(commandID: "cmd-2", params: ["script": AnyCodable("b")]) }
        let t3 = Task { await bridge.handleExecute(commandID: "cmd-3", params: ["script": AnyCodable("c")]) }

        Thread.sleep(forTimeInterval: 0.15)

        let response = syncAwait { await bridge.handlePoll(commandID: "poll-1") }
        let valueDict = response.value?.value as? [String: Any]
        let commands = valueDict?["commands"] as? [[String: Any]]
        try assertEqual(commands?.count, 3)
        let ids = Set(commands?.compactMap { $0["id"] as? String } ?? [])
        try assertEqual(ids, Set(["cmd-1", "cmd-2", "cmd-3"]))

        // Cleanup
        for id in ["cmd-1", "cmd-2", "cmd-3"] {
            _ = bridge.handleResult(
                commandID: "r",
                params: [
                    "requestId": AnyCodable(id),
                    "result": AnyCodable(["ok": true]),
                ]
            )
        }
        _ = syncAwait { await t1.value }
        _ = syncAwait { await t2.value }
        _ = syncAwait { await t3.value }
    }

    test("testHandlePollEmptyReturnsEmptyArray") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "c")

        let response = syncAwait { await bridge.handlePoll(commandID: "poll-1") }
        let valueDict = response.value?.value as? [String: Any]
        let commands = valueDict?["commands"] as? [[String: Any]]
        try assertTrue(commands != nil, "commands array should be present")
        try assertEqual(commands?.count, 0)
    }

    // MARK: - HealthStore wiring (Commit 1a, Tasks 4+5)

    test("testExtensionLogAlarmFireUpdatesHealthStore") {
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
        let before = health.lastAlarmFireTimestamp
        Thread.sleep(forTimeInterval: 0.05)
        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"log-1","method":"extension_log","params":{"message":"alarm_fire","timestamp":1700000000000}}"#)
        }
        try assertTrue(response.ok)
        try assertTrue(health.lastAlarmFireTimestamp > before, "alarm_fire should advance timestamp")
    }

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

    // MARK: - ExecutedLog + ipcMechanism (Commit 1b, Task 2)

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
        _ = syncAwait { await bridge.handlePoll(commandID: "poll-log-1") }

        // Send result — this should add to executedLog
        _ = bridge.handleResult(
            commandID: "res-log-1",
            params: [
                "requestId": AnyCodable("exec-log-1"),
                "result": AnyCodable("done"),
            ]
        )

        // Wait for execute to complete
        _ = syncAwait { await executeTask.value }

        // Verify it's in the executed log
        try assertTrue(bridge.isInExecutedLog("exec-log-1"),
                       "Completed command should be in executedLog")
    }

    test("testExecutedLogExpiresAfterTTL") {
        let bridge = ExtensionBridge()

        // Insert an entry with a timestamp 6 minutes in the past (beyond 5-min TTL)
        let sixMinutesAgo = Date().addingTimeInterval(-360)
        bridge.addToExecutedLogForTest(commandID: "old-cmd", at: sixMinutesAgo)

        // Should NOT be found — it's expired
        try assertFalse(bridge.isInExecutedLog("old-cmd"),
                        "Expired entry should not be found in executedLog")
    }

    test("testExecutedLogSizeReportedInHealthSnapshot") {
        let bridge = ExtensionBridge()
        let tmpPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("test-execlog-health-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tmpPath) }
        let health = HealthStore(persistPath: tmpPath)

        // Complete a command so it enters the executedLog
        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-hs-1",
                params: ["script": AnyCodable("return 1")]
            )
        }
        Thread.sleep(forTimeInterval: 0.1)
        _ = syncAwait { await bridge.handlePoll(commandID: "poll-hs-1") }
        _ = bridge.handleResult(
            commandID: "res-hs-1",
            params: [
                "requestId": AnyCodable("exec-hs-1"),
                "result": AnyCodable("ok"),
            ]
        )
        _ = syncAwait { await executeTask.value }

        let snapshot = bridge.healthSnapshot(store: health)
        try assertEqual(snapshot["executedLogSize"] as? Int, 1,
                        "healthSnapshot should report executedLogSize=1")
    }

    test("testExecutedLogDoesNotRecordUnknownRequestId") {
        let bridge = ExtensionBridge()

        // Send a result for a command that was never queued
        _ = bridge.handleResult(
            commandID: "res-orphan-log",
            params: [
                "requestId": AnyCodable("never-queued-cmd"),
                "result": AnyCodable("ignored"),
            ]
        )

        // Should NOT be in the log
        try assertFalse(bridge.isInExecutedLog("never-queued-cmd"),
                        "Unknown requestId should not be added to executedLog")
    }

    test("testIpcMechanismFieldInHealthSnapshot") {
        let bridge = ExtensionBridge()
        let tmpPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("test-ipc-mech-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tmpPath) }
        let health = HealthStore(persistPath: tmpPath)

        // Default should be "none"
        let snapshot1 = bridge.healthSnapshot(store: health)
        try assertEqual(snapshot1["ipcMechanism"] as? String, "none",
                        "Default ipcMechanism should be 'none'")

        // Set to "http"
        bridge.setIpcMechanism("http")

        let snapshot2 = bridge.healthSnapshot(store: health)
        try assertEqual(snapshot2["ipcMechanism"] as? String, "http",
                        "ipcMechanism should be 'http' after setIpcMechanism")
    }

    // MARK: - Reconcile handler (Commit 1b, Task 3)

    test("testReconcileClassifiesAckedCommands") {
        let bridge = ExtensionBridge()

        // Queue and complete a command so it enters executedLog
        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-ack-1",
                params: ["script": AnyCodable("return 1")]
            )
        }
        Thread.sleep(forTimeInterval: 0.1)
        _ = syncAwait { await bridge.handlePoll(commandID: "poll-ack") }
        _ = bridge.handleResult(
            commandID: "res-ack",
            params: [
                "requestId": AnyCodable("exec-ack-1"),
                "result": AnyCodable("done"),
            ]
        )
        _ = syncAwait { await executeTask.value }

        // Reconcile: extension reports exec-ack-1 as executed
        let response = bridge.handleReconcile(
            commandID: "recon-1",
            executedIds: ["exec-ack-1"],
            pendingIds: []
        )
        try assertTrue(response.ok)
        let dict = response.value?.value as? [String: Any]
        let acked = dict?["acked"] as? [String] ?? []
        try assertTrue(acked.contains("exec-ack-1"), "exec-ack-1 should be classified as acked")
    }

    test("testReconcileClassifiesUncertainCommands") {
        let bridge = ExtensionBridge()

        // Reconcile with an ID the daemon has never seen
        let response = bridge.handleReconcile(
            commandID: "recon-2",
            executedIds: ["unknown-cmd-99"],
            pendingIds: []
        )
        try assertTrue(response.ok)
        let dict = response.value?.value as? [String: Any]
        let uncertain = dict?["uncertain"] as? [String] ?? []
        try assertTrue(uncertain.contains("unknown-cmd-99"),
                       "unknown-cmd-99 should be classified as uncertain")
    }

    test("testReconcileClassifiesReQueuedCommands") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "c")

        // Queue a command
        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-rq-1",
                params: ["script": AnyCodable("requeue me")]
            )
        }
        Thread.sleep(forTimeInterval: 0.1)

        // Poll to deliver it (delivered=true)
        _ = syncAwait { await bridge.handlePoll(commandID: "poll-rq") }

        // Disconnect flips delivered back to false
        _ = bridge.handleDisconnected(commandID: "disc-rq")

        // Reconcile: extension reports exec-rq-1 in pendingIds
        let response = bridge.handleReconcile(
            commandID: "recon-3",
            executedIds: [],
            pendingIds: ["exec-rq-1"]
        )
        try assertTrue(response.ok)
        let dict = response.value?.value as? [String: Any]
        let reQueued = dict?["reQueued"] as? [String] ?? []
        try assertTrue(reQueued.contains("exec-rq-1"),
                       "exec-rq-1 should be classified as reQueued (delivered=false)")

        // CRITICAL: pushNew must NOT contain reQueued command IDs
        let pushNew = dict?["pushNew"] as? [[String: Any]] ?? []
        let pushNewIds = pushNew.compactMap { $0["id"] as? String }
        try assertFalse(pushNewIds.contains("exec-rq-1"),
                        "pushNew must NOT contain reQueued command exec-rq-1")

        // Cleanup
        _ = bridge.handleResult(
            commandID: "res-rq",
            params: [
                "requestId": AnyCodable("exec-rq-1"),
                "result": AnyCodable("done"),
            ]
        )
        _ = syncAwait { await executeTask.value }
    }

    test("testReconcilePushesNewCommands") {
        let bridge = ExtensionBridge()

        // Queue a command WITHOUT polling (delivered=false)
        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-push-1",
                params: ["script": AnyCodable("push me")]
            )
        }
        Thread.sleep(forTimeInterval: 0.1)

        // Reconcile: extension doesn't know about exec-push-1
        let response = bridge.handleReconcile(
            commandID: "recon-4",
            executedIds: [],
            pendingIds: []
        )
        try assertTrue(response.ok)
        let dict = response.value?.value as? [String: Any]
        let pushNew = dict?["pushNew"] as? [[String: Any]] ?? []
        try assertEqual(pushNew.count, 1, "Should push 1 new command")
        try assertEqual(pushNew.first?["id"] as? String, "exec-push-1")
        try assertEqual(pushNew.first?["script"] as? String, "push me")

        // Cleanup
        _ = bridge.handleResult(
            commandID: "res-push",
            params: [
                "requestId": AnyCodable("exec-push-1"),
                "result": AnyCodable("done"),
            ]
        )
        _ = syncAwait { await executeTask.value }
    }

    test("testReconcileClassifiesInFlightCommands") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "c")

        // Queue a command
        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-if-1",
                params: ["script": AnyCodable("in flight")]
            )
        }
        Thread.sleep(forTimeInterval: 0.1)

        // Poll to deliver (delivered=true)
        _ = syncAwait { await bridge.handlePoll(commandID: "poll-if") }

        // Reconcile: extension reports exec-if-1 in pendingIds (still running)
        let response = bridge.handleReconcile(
            commandID: "recon-5",
            executedIds: [],
            pendingIds: ["exec-if-1"]
        )
        try assertTrue(response.ok)
        let dict = response.value?.value as? [String: Any]
        let inFlight = dict?["inFlight"] as? [String] ?? []
        try assertTrue(inFlight.contains("exec-if-1"),
                       "exec-if-1 should be classified as inFlight (delivered=true)")

        // Cleanup
        _ = bridge.handleResult(
            commandID: "res-if",
            params: [
                "requestId": AnyCodable("exec-if-1"),
                "result": AnyCodable("done"),
            ]
        )
        _ = syncAwait { await executeTask.value }
    }

    test("testDispatcherRoutesReconcileAndCallsMarkReconcile") {
        let tmpPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("test-reconcile-health-\(UUID().uuidString).json")
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

        // Verify no reconcile timestamp before
        try assertTrue(health.lastReconcileTimestamp == nil,
                       "lastReconcileTimestamp should be nil before reconcile")

        let response = syncAwait {
            await dispatcher.dispatch(
                line: #"{"id":"recon-d","method":"extension_reconcile","params":{"executedIds":[],"pendingIds":[]}}"#
            )
        }
        try assertTrue(response.ok, "extension_reconcile dispatch should succeed")

        // Verify healthStore.markReconcile() was called
        try assertTrue(health.lastReconcileTimestamp != nil,
                       "lastReconcileTimestamp should be set after reconcile dispatch")
    }

    test("testHealthSnapshotIncludesHttpCounters") {
        let bridge = ExtensionBridge()
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("safari-pilot-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmpDir) }
        let health = HealthStore(persistPath: tmpDir.appendingPathComponent("health.json"))

        let snapshot = bridge.healthSnapshot(store: health)
        // Verify new HTTP counter fields exist with correct types
        try assertTrue(snapshot["httpBindFailureCount"] is Int,
                       "httpBindFailureCount should be Int, got \(type(of: snapshot["httpBindFailureCount"]))")
        try assertTrue(snapshot["httpRequestErrorCount1h"] is Int,
                       "httpRequestErrorCount1h should be Int, got \(type(of: snapshot["httpRequestErrorCount1h"]))")
        try assertEqual(snapshot["httpBindFailureCount"] as? Int, 0)
        try assertEqual(snapshot["httpRequestErrorCount1h"] as? Int, 0)
    }

    // MARK: - SD-12: handleResult sentinel coverage (__keepalive__, __trace__, _meta)

    // Helper: per-test tmp HealthStore wired into bridge keepalive store.
    func makeBridgeWithHealth() -> (ExtensionBridge, HealthStore, URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("safari-pilot-sd12-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("health.json")
        let health = HealthStore(persistPath: path)
        let bridge = ExtensionBridge()
        bridge.setHealthStore(health)
        return (bridge, health, dir)
    }

    test("testKeepaliveSentinelRecordsPingAndConnects") {
        // Discrimination targets (ExtensionBridge.swift:266-274):
        //   1. `_keepaliveStore?.recordKeepalivePing()` — removing this leaves
        //      lastKeepalivePing nil.
        //   2. `_ = handleConnected(commandID: commandID)` — removing this leaves
        //      isExtensionConnected false (the comment in source explicitly notes
        //      this is required so isConnected doesn't go stale between pings).
        let (bridge, health, dir) = makeBridgeWithHealth()
        defer { try? FileManager.default.removeItem(at: dir) }

        try assertFalse(bridge.isExtensionConnected,
                        "bridge must start disconnected")
        try assertTrue(health.lastKeepalivePing == nil,
                       "lastKeepalivePing must start nil")

        let before = Date()
        let response = bridge.handleResult(
            commandID: "kr-1",
            params: ["requestId": AnyCodable("__keepalive__")]
        )

        try assertTrue(response.ok, "keepalive sentinel must return success")
        try assertEqual(response.id, "kr-1")
        try assertEqual(response.value?.value as? String, "ok",
                        "keepalive sentinel must return value \"ok\"")
        try assertTrue(bridge.isExtensionConnected,
                       "keepalive sentinel must flip isExtensionConnected → true")

        let stamp = health.lastKeepalivePing
        try assertTrue(stamp != nil,
                       "keepalive sentinel must record ping in HealthStore")
        try assertTrue(
            stamp!.timeIntervalSince1970 >= before.timeIntervalSince1970 - 0.5,
            "lastKeepalivePing must be ~now"
        )
    }

    test("testKeepaliveSentinelShortCircuitsBeforePendingLookup") {
        // Discrimination target: the early `return Response.success(...)` at the end
        // of the keepalive branch (ExtensionBridge.swift:273). If that return is
        // removed, control falls through to the requestId validation + pendingCommands
        // lookup, which would (a) remove a pending command with the same id and
        // resume its continuation, (b) append "__keepalive__" to executedLog at the
        // bottom of handleResult.
        //
        // We exercise the contrived collision: a command literally named
        // "__keepalive__" sits in pendingCommands. The keepalive sentinel must NOT
        // pollute executedLog with that id.
        let (bridge, _, dir) = makeBridgeWithHealth()
        defer { try? FileManager.default.removeItem(at: dir) }

        // Queue a pendingCommand with the literal sentinel id. The Task is not
        // awaited here: handleExecute auto-completes via its 90s internal
        // timeoutTask (ExtensionBridge.swift:132-152) which fires
        // EXTENSION_TIMEOUT and resumes the continuation. The bridge is a
        // local instance held alive by the Task closure and released once
        // the timeout resolves — no cross-test state leakage.
        let leaked = Task {
            await bridge.handleExecute(
                commandID: "__keepalive__",
                params: ["script": AnyCodable("collision")]
            )
        }
        Thread.sleep(forTimeInterval: 0.1)

        _ = bridge.handleResult(
            commandID: "kr-collision",
            params: ["requestId": AnyCodable("__keepalive__")]
        )

        try assertFalse(
            bridge.isInExecutedLog("__keepalive__"),
            "keepalive sentinel must short-circuit BEFORE the pendingCommands lookup; "
                + "if the early return is missing, executedLog gets polluted with "
                + "\"__keepalive__\""
        )
        _ = leaked  // suppress unused warning; Task is intentionally not awaited
    }

    test("testTraceSentinelAlarmFireAdvancesHealthStoreTimestamp") {
        // Discrimination target: ExtensionBridge.swift:287-289
        //   if event == "alarm_fire" {
        //       _keepaliveStore?.recordAlarmFire()
        //   }
        // Removing the recordAlarmFire call (or removing the alarm_fire guard so
        // every event fires it — covered by the negative-form test below) breaks
        // the alarm-fire path that mirrors the extension_log/alarm_fire route.
        let (bridge, health, dir) = makeBridgeWithHealth()
        defer { try? FileManager.default.removeItem(at: dir) }

        let before = health.lastAlarmFireTimestamp
        Thread.sleep(forTimeInterval: 0.05)  // ensure Date() in recordAlarmFire is later

        let traceResult: [String: Any] = [
            "type": "trace",
            "id": "tr-alarm-1",
            "layer": "extension-bg",
            "event": "alarm_fire",
            "data": [:],
        ]
        let response = bridge.handleResult(
            commandID: "tr-1",
            params: [
                "requestId": AnyCodable("__trace__"),
                "result": AnyCodable(traceResult),
            ]
        )

        try assertTrue(response.ok, "trace sentinel must return success")
        try assertEqual(response.value?.value as? String, "ok")
        try assertTrue(
            health.lastAlarmFireTimestamp > before,
            "alarm_fire trace event must advance lastAlarmFireTimestamp"
        )
    }

    test("testTraceSentinelNonAlarmEventDoesNotAdvanceAlarmTimestamp") {
        // Discrimination target: the `event == "alarm_fire"` guard at line 287.
        // If the guard is removed (every trace event fires recordAlarmFire), this
        // test fails — a normal `bridge_result` trace would advance the alarm
        // timestamp. This is the negative form of the previous test.
        let (bridge, health, dir) = makeBridgeWithHealth()
        defer { try? FileManager.default.removeItem(at: dir) }

        let before = health.lastAlarmFireTimestamp
        Thread.sleep(forTimeInterval: 0.05)  // separate Date() readings

        let traceResult: [String: Any] = [
            "type": "trace",
            "id": "tr-non-alarm-1",
            "layer": "extension-bg",
            "event": "bridge_result",  // not alarm_fire
            "data": ["foo": "bar"],
        ]
        _ = bridge.handleResult(
            commandID: "tr-2",
            params: [
                "requestId": AnyCodable("__trace__"),
                "result": AnyCodable(traceResult),
            ]
        )

        // Equality check tolerates the no-op explicitly: lastAlarmFireTimestamp
        // is the *only* path that calls recordAlarmFire on this bridge, and
        // we've made no other calls.
        try assertEqual(
            health.lastAlarmFireTimestamp.timeIntervalSince1970,
            before.timeIntervalSince1970,
            "non-alarm trace event must NOT advance lastAlarmFireTimestamp"
        )
    }

    test("testMetaWrappingPreservesValueAndMeta") {
        // Discrimination target: ExtensionBridge.swift:358-364
        //   if let meta = resultDict["_meta"] as? [String: Any] {
        //       callerResponse = Response.success(
        //           id: cmd.id,
        //           value: AnyCodable(["value": innerValue, "_meta": meta])
        //       )
        //   } else { ... unwrap to innerValue directly ... }
        //
        // ExtensionEngine relies on this {value, _meta} wrapper to extract tab
        // identity from Safari (positional tab adoption, frame info, etc.). If the
        // _meta branch is removed and only the else branch remains, callers see
        // the inner value directly and lose all tab-identity metadata.
        let bridge = ExtensionBridge()

        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-meta-1",
                params: ["script": AnyCodable("return ok")]
            )
        }
        Thread.sleep(forTimeInterval: 0.1)

        let result: [String: Any] = [
            "ok": true,
            "value": 42,
            "_meta": [
                "tabId": 99,
                "frameId": "main",
            ],
        ]
        _ = bridge.handleResult(
            commandID: "res-meta-1",
            params: [
                "requestId": AnyCodable("exec-meta-1"),
                "result": AnyCodable(result),
            ]
        )

        let execResponse = syncAwait { await executeTask.value }
        try assertTrue(execResponse.ok, "execute must succeed when result.ok=true")

        let wrapper = execResponse.value?.value as? [String: Any]
        try assertTrue(
            wrapper != nil,
            "with _meta present, response value must be a dict; got \(type(of: execResponse.value?.value))"
        )
        try assertEqual(wrapper?["value"] as? Int, 42,
                        "wrapper.value must be the inner value (42)")

        let meta = wrapper?["_meta"] as? [String: Any]
        try assertTrue(meta != nil, "wrapper._meta must be the meta dict, not nil")
        try assertEqual(meta?["tabId"] as? Int, 99,
                        "wrapper._meta.tabId must round-trip from result._meta.tabId")
        try assertEqual(meta?["frameId"] as? String, "main",
                        "wrapper._meta.frameId must round-trip from result._meta.frameId")
    }

    test("testMetaAbsentReturnsInnerValueDirectlyForBackwardCompat") {
        // Discrimination target: the else branch at ExtensionBridge.swift:365-367
        //   } else {
        //       callerResponse = Response.success(id: cmd.id, value: AnyCodable(innerValue))
        //   }
        //
        // This is the backward-compat path for old extensions that don't send _meta.
        // If the bridge always wrapped (the else branch is removed), every caller
        // would suddenly receive `{value: ..., _meta: nil}` instead of the bare
        // inner value, breaking ExtensionEngine's plain-result handling.
        let bridge = ExtensionBridge()

        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-no-meta-1",
                params: ["script": AnyCodable("return ok")]
            )
        }
        Thread.sleep(forTimeInterval: 0.1)

        let result: [String: Any] = [
            "ok": true,
            "value": 42,
            // no _meta key
        ]
        _ = bridge.handleResult(
            commandID: "res-no-meta-1",
            params: [
                "requestId": AnyCodable("exec-no-meta-1"),
                "result": AnyCodable(result),
            ]
        )

        let execResponse = syncAwait { await executeTask.value }
        try assertTrue(execResponse.ok)

        // Response value must be the bare Int 42, NOT a [String: Any] wrapper.
        try assertEqual(execResponse.value?.value as? Int, 42,
                        "without _meta, response.value must be the inner value directly")
        try assertTrue(
            execResponse.value?.value as? [String: Any] == nil,
            "without _meta, response.value must NOT be wrapped in a dict"
        )
    }

    // MARK: - SD-12 reviewer follow-ups (malformed __trace__ + null-fallback)

    test("testTraceSentinelMalformedPayloadDoesNotAdvanceAlarmTimestamp") {
        // Reviewer MAJOR (SD-12): the trace branch at ExtensionBridge.swift:277-291
        // is gated by a chain of `if let` extractions. If a regression strips
        // those guards and hardcodes `event = "alarm_fire"` (or otherwise
        // unconditionally calls recordAlarmFire), a __trace__ with an empty
        // body would spuriously advance lastAlarmFireTimestamp. This test locks
        // the gating contract: a __trace__ with requestId only must NOT touch
        // any HealthStore counter.
        let (bridge, health, dir) = makeBridgeWithHealth()
        defer { try? FileManager.default.removeItem(at: dir) }

        let before = health.lastAlarmFireTimestamp
        Thread.sleep(forTimeInterval: 0.05)

        let response = bridge.handleResult(
            commandID: "tr-malformed",
            params: ["requestId": AnyCodable("__trace__")]
            // no "result" field — the if-let chain at line 277 must short-circuit
        )

        try assertTrue(response.ok,
                       "malformed __trace__ must still return ack (silent no-op)")
        try assertEqual(
            health.lastAlarmFireTimestamp.timeIntervalSince1970,
            before.timeIntervalSince1970,
            "__trace__ without a result field must NOT advance lastAlarmFireTimestamp"
        )
    }

    test("testTraceSentinelWrongResultTypeIgnoredCleanly") {
        // Reviewer MAJOR follow-up: locks the type-guard at line 280
        //     let traceType = result["type"] as? String, traceType == "trace"
        // If that guard is dropped (any type triggers the body), an
        // alarm_fire-event payload mis-tagged with type="something-else"
        // would erroneously advance the alarm timestamp.
        let (bridge, health, dir) = makeBridgeWithHealth()
        defer { try? FileManager.default.removeItem(at: dir) }

        let before = health.lastAlarmFireTimestamp
        Thread.sleep(forTimeInterval: 0.05)

        let traceResult: [String: Any] = [
            "type": "not-a-trace",  // wrong type — guard at line 280 must reject
            "id": "tr-bad-1",
            "layer": "extension-bg",
            "event": "alarm_fire",  // looks like alarm but type guard rejects
            "data": [:],
        ]
        _ = bridge.handleResult(
            commandID: "tr-bad",
            params: [
                "requestId": AnyCodable("__trace__"),
                "result": AnyCodable(traceResult),
            ]
        )

        try assertEqual(
            health.lastAlarmFireTimestamp.timeIntervalSince1970,
            before.timeIntervalSince1970,
            "__trace__ with result.type != \"trace\" must be ignored — "
                + "alarm timestamp must NOT advance"
        )
    }

    test("testSuccessWithMissingValueDefaultsToNSNull") {
        // Reviewer ADVISORY (SD-12): ExtensionBridge.swift:357
        //   let innerValue = resultDict["value"] as Any? ?? NSNull()
        // defends against {ok:true} without a value key — extensions sending
        // a void result. If a regression replaces `?? NSNull()` with `?? ""`
        // or removes the coalesce entirely, callers stop seeing NSNull and
        // start seeing either an empty string or a Swift Optional<Any>, both
        // of which break round-trip equality for void scripts.
        let bridge = ExtensionBridge()

        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-void-1",
                params: ["script": AnyCodable("doSomethingVoid()")]
            )
        }
        Thread.sleep(forTimeInterval: 0.1)

        // No "value" key, no "_meta" — exercises the else branch (line 365)
        // with the null-coalesced innerValue.
        let result: [String: Any] = ["ok": true]
        _ = bridge.handleResult(
            commandID: "res-void-1",
            params: [
                "requestId": AnyCodable("exec-void-1"),
                "result": AnyCodable(result),
            ]
        )

        let execResponse = syncAwait { await executeTask.value }
        try assertTrue(execResponse.ok,
                       "execute must succeed even when result.value is absent")
        try assertTrue(
            execResponse.value?.value is NSNull,
            "innerValue must default to NSNull when result.value key is absent; "
                + "got \(String(describing: execResponse.value?.value))"
        )
    }

    // MARK: - SD-14: dispatcher-level routing for extension_result/_execute/_disconnected

    test("testDispatcherRoutesExtensionResultResolvesPendingCommand") {
        // Discrimination target: CommandDispatcher.swift:145-146
        //     case "extension_result":
        //         return extensionBridge.handleResult(commandID: command.id, params: command.params)
        // Pre-SD-14: ExtensionBridge tests called handleResult directly. Production
        // sends `extension_result` over NDJSON; if that case branch is deleted,
        // the dispatcher returns UNKNOWN_METHOD, the bridge never sees the result,
        // and the queued execute hangs on the 90s default timeout.
        let mock = MockExecutor()
        let bridge = ExtensionBridge()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            extensionBridge: bridge,
            healthStore: makeHealthStoreForTest()
        )

        // Queue a command directly via the bridge (the execute happens via stdin
        // in production; we're testing the result path specifically here).
        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-disp-result-1",
                params: ["script": AnyCodable("return 42")]
            )
        }
        Thread.sleep(forTimeInterval: 0.1)

        // Drive the result through the dispatcher's NDJSON path.
        let line = #"{"id":"res-disp-1","method":"extension_result","params":{"requestId":"exec-disp-result-1","result":42}}"#
        let dispatchResp = syncAwait { await dispatcher.dispatch(line: line) }
        try assertTrue(dispatchResp.ok,
                       "extension_result NDJSON dispatch must succeed (ok=true)")
        try assertEqual(dispatchResp.id, "res-disp-1",
                        "dispatch response id must match the inbound NDJSON id, "
                            + "not the bridge command id")

        // Verify the pending command's continuation was resumed with the result.
        let execResponse = syncAwait { await executeTask.value }
        try assertTrue(execResponse.ok,
                       "queued execute must resolve when extension_result is dispatched")
        try assertEqual(execResponse.value?.value as? Int, 42,
                        "resumed execute must surface the inner result value")
    }

    test("testDispatcherRoutesExtensionExecuteQueuesCommand") {
        // Discrimination target: CommandDispatcher.swift:148-149
        //     case "extension_execute":
        //         return await extensionBridge.handleExecute(commandID: command.id, params: command.params)
        // Pre-SD-14: ExtensionBridge tests called handleExecute directly. Production
        // queue-from-MCP arrives as an `extension_execute` NDJSON command; if the
        // case is deleted, the dispatcher returns UNKNOWN_METHOD and no command
        // ever lands in the bridge's pendingCommands array.
        let mock = MockExecutor()
        let bridge = ExtensionBridge()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            extensionBridge: bridge,
            healthStore: makeHealthStoreForTest()
        )

        // Drive extension_execute through dispatcher in a Task — handleExecute
        // suspends until a result arrives, so the dispatch call will not return
        // until we send the result below.
        let dispatchTask = Task {
            await dispatcher.dispatch(
                line: #"{"id":"exec-disp-1","method":"extension_execute","params":{"script":"document.title","tabUrl":"https://example.com"}}"#
            )
        }
        Thread.sleep(forTimeInterval: 0.15)

        // Verify the command landed in the bridge: a poll must return it.
        let pollResp = syncAwait { await bridge.handlePoll(commandID: "p-disp") }
        let pollDict = pollResp.value?.value as? [String: Any]
        let cmds = pollDict?["commands"] as? [[String: Any]] ?? []
        try assertEqual(cmds.count, 1,
                        "extension_execute via dispatcher must land in bridge.pendingCommands")
        try assertEqual(cmds.first?["id"] as? String, "exec-disp-1",
                        "polled command id must match the dispatched NDJSON id")
        try assertEqual(cmds.first?["script"] as? String, "document.title",
                        "polled command script param must round-trip from NDJSON params")
        // Reviewer ADVISORY (SD-14): make the params-dict round-trip explicit.
        // tabUrl is sent in production NDJSON for ownership routing and must
        // survive the dispatcher → bridge → poll path unchanged.
        try assertEqual(cmds.first?["tabUrl"] as? String, "https://example.com",
                        "polled command tabUrl param must round-trip from NDJSON params "
                            + "(locks general params-dict round-trip beyond just `script`)")

        // Cleanup: feed the result so the dispatch suspension resolves.
        _ = bridge.handleResult(
            commandID: "cleanup-disp-exec",
            params: [
                "requestId": AnyCodable("exec-disp-1"),
                "result": AnyCodable(["ok": true, "value": "Test"]),
            ]
        )
        let dispatchResp = syncAwait { await dispatchTask.value }
        try assertTrue(dispatchResp.ok,
                       "dispatch of extension_execute must succeed after result arrives")
    }

    test("testDispatcherRoutesExtensionDisconnectedFlipsConnectedState") {
        // Symmetric gap with the existing testDispatcherRoutesExtensionConnected
        // — discovered while running SD-14. Discrimination target:
        // CommandDispatcher.swift:142-143
        //     case "extension_disconnected":
        //         return extensionBridge.handleDisconnected(commandID: command.id)
        // If the case is deleted, the dispatcher returns UNKNOWN_METHOD and the
        // bridge stays in `_isConnected=true` after the extension event page
        // unloads — wake-from-disconnect semantics break silently.
        let mock = MockExecutor()
        let bridge = ExtensionBridge()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            extensionBridge: bridge,
            healthStore: makeHealthStoreForTest()
        )

        // Pre-state: connect via dispatcher (separate code path than the
        // disconnect branch — locks the round-trip cleanly).
        let connectResp = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"conn-disp","method":"extension_connected"}"#)
        }
        try assertTrue(connectResp.ok)
        try assertTrue(bridge.isExtensionConnected,
                       "bridge must be connected before disconnect dispatch")

        let disconnectResp = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"disc-disp","method":"extension_disconnected"}"#)
        }
        try assertTrue(disconnectResp.ok,
                       "extension_disconnected NDJSON dispatch must succeed")
        try assertEqual(disconnectResp.id, "disc-disp")
        try assertFalse(
            bridge.isExtensionConnected,
            "extension_disconnected via dispatcher must flip isExtensionConnected → false"
        )
    }

    // MARK: - SD-15: bridge full-journey lifecycle (Check 9)

    test("testBridgeFullJourneyConnectExecutePollDisconnectReconcileResultTeardown") {
        // SD-15 (lifecycle): the individual ops (connect, execute, poll, result,
        // reconcile, disconnect) and pairwise wake sequences are tested by other
        // cases. This test walks the full real-world sequence with intermediate
        // assertions at EACH HOP. Per the SD-15 discriminator: breaking
        // wake-semantics at any hop must fail at THAT hop, not later. The hops:
        //
        //   1. daemon-start (bridge in initial state)
        //   2. extension-connect (handleConnected → isConnected=true)
        //   3. queue 3 commands (handleExecute × 3)
        //   4. poll (all 3 marked delivered=true)
        //   5. extension-disconnect — event page wake (handleDisconnected
        //      MUST flip delivered=true → false on unacked commands)
        //   6. reconnect
        //   7. reconcile — extension knows cmd1+cmd2 as pending; doesn't know
        //      cmd3 → reQueued=[cmd1, cmd2], pushNew=[cmd3]
        //   8. handleResult for all 3 (out of order to test independence)
        //   9. teardown — executedLog contains all 3 ids
        //
        // Each hop has its own assertion(s) so a regression at any single hop
        // surfaces at that hop with a precise error message.

        let bridge = ExtensionBridge()

        // Hop 1: daemon-start — bridge in initial state. Covered tighter by
        // testExtensionBridgeStartsDisconnected; kept here for the lifecycle
        // narrative + Hop-N indexing.
        try assertFalse(bridge.isExtensionConnected,
                        "Hop 1 (daemon-start): bridge must start disconnected")
        try assertFalse(bridge.isInExecutedLog("any-id"),
                        "Hop 1 (daemon-start): executedLog must start empty")

        // Hop 2: extension connects
        let connectResp = bridge.handleConnected(commandID: "j-conn-1")
        try assertTrue(connectResp.ok, "Hop 2 (connect): handleConnected must succeed")
        try assertTrue(bridge.isExtensionConnected,
                       "Hop 2 (connect): isExtensionConnected must flip true")

        // Hop 3: queue 3 commands (Tasks suspend awaiting results)
        let task1 = Task {
            await bridge.handleExecute(
                commandID: "j-cmd-1",
                params: ["script": AnyCodable("script-a")]
            )
        }
        let task2 = Task {
            await bridge.handleExecute(
                commandID: "j-cmd-2",
                params: ["script": AnyCodable("script-b")]
            )
        }
        let task3 = Task {
            await bridge.handleExecute(
                commandID: "j-cmd-3",
                params: ["script": AnyCodable("script-c")]
            )
        }
        Thread.sleep(forTimeInterval: 0.2)

        // Hop 4: extension polls — all 3 marked delivered=true
        let pollResp1 = syncAwait { await bridge.handlePoll(commandID: "j-poll-1") }
        let polled1 = (pollResp1.value?.value as? [String: Any])?["commands"] as? [[String: Any]] ?? []
        try assertEqual(polled1.count, 3,
                        "Hop 4 (first poll): must return all 3 queued commands")
        let polledIds1 = Set(polled1.compactMap { $0["id"] as? String })
        try assertEqual(polledIds1, Set(["j-cmd-1", "j-cmd-2", "j-cmd-3"]),
                        "Hop 4 (first poll): ids must match queued")

        // Hop 5: extension-disconnect (event page wake). The bridge MUST flip
        // delivered=true → false for the 3 polled-but-unacked commands so the
        // next poll can redeliver them. THIS IS THE WAKE-SEMANTICS HOP.
        //
        // Reviewer (SD-15) suggested an intermediate poll here to observe the
        // delivered-flip directly. Tracing handlePoll (lines 203-261) shows the
        // poll itself flips delivered=true → which would corrupt Hop 7's
        // `reQueued` classification (cmds would be classified inFlight, not
        // reQueued). Production never polls between disconnect and reconcile —
        // the daemon waits for the extension to call /connect. The dedicated
        // test `testHandleDisconnectedFlipsDeliveredBackForUnacked` (above) locks
        // the wake-semantics in isolation; this lifecycle test verifies it
        // transitively at Hop 7 with a back-pointing error message that names
        // Hop 5 explicitly.
        let disconnectResp = bridge.handleDisconnected(commandID: "j-disc-1")
        try assertTrue(disconnectResp.ok, "Hop 5 (disconnect): handleDisconnected must succeed")
        try assertFalse(bridge.isExtensionConnected,
                        "Hop 5 (disconnect): isExtensionConnected must flip false")

        // Hop 6: reconnect (event page came back)
        _ = bridge.handleConnected(commandID: "j-conn-2")
        try assertTrue(bridge.isExtensionConnected,
                       "Hop 6 (reconnect): isExtensionConnected must be true again")

        // Hop 7: reconcile. Extension reports cmd1 + cmd2 as pending (still
        // queued in service worker), and is unaware of cmd3 (it was queued
        // AFTER the extension's last sync). Expected classification:
        //   - reQueued = [j-cmd-1, j-cmd-2] (delivered=false from Hop 5 flip,
        //     present in extension's pendingIds)
        //   - pushNew  = [j-cmd-3]            (delivered=false, NOT in
        //     extension's pendingIds AND NOT in reQueued)
        //   - acked, uncertain, inFlight = empty
        //
        // Discrimination: if Hop 5's wake-semantics is broken (delivered stays
        // true), reQueued is empty AND inFlight = [cmd1, cmd2] instead. Hop 7
        // assertions fail.
        let reconResp = bridge.handleReconcile(
            commandID: "j-rec-1",
            executedIds: [],
            pendingIds: ["j-cmd-1", "j-cmd-2"]
        )
        try assertTrue(reconResp.ok, "Hop 7 (reconcile): handleReconcile must succeed")
        let reconDict = reconResp.value?.value as? [String: Any]
        let acked = reconDict?["acked"] as? [String] ?? []
        let uncertain = reconDict?["uncertain"] as? [String] ?? []
        let reQueued = reconDict?["reQueued"] as? [String] ?? []
        let inFlight = reconDict?["inFlight"] as? [String] ?? []
        let pushNew = reconDict?["pushNew"] as? [[String: Any]] ?? []

        try assertEqual(acked, [], "Hop 7: acked must be empty (no executedIds)")
        try assertEqual(uncertain, [], "Hop 7: uncertain must be empty")
        try assertEqual(Set(reQueued), Set(["j-cmd-1", "j-cmd-2"]),
                        "Hop 7: reQueued must contain cmd1 + cmd2 (delivered=false post-disconnect, "
                            + "in extension's pendingIds). If empty → Hop 5 wake-semantics broken.")
        try assertEqual(inFlight, [],
                        "Hop 7: inFlight must be empty (delivered was flipped to false at Hop 5). "
                            + "If non-empty → handleDisconnected didn't flip delivered.")
        try assertEqual(pushNew.count, 1,
                        "Hop 7: pushNew must contain exactly cmd3 (the one extension doesn't know)")
        try assertEqual(pushNew.first?["id"] as? String, "j-cmd-3",
                        "Hop 7: pushNew id must be j-cmd-3")
        try assertEqual(pushNew.first?["script"] as? String, "script-c",
                        "Hop 7: pushNew param round-trip — script must be preserved")

        // Hop 8: send results for all 3 in non-queue order (cmd2, cmd3, cmd1)
        // — proves out-of-order independence of the continuation resumption.
        _ = bridge.handleResult(
            commandID: "j-res-2",
            params: [
                "requestId": AnyCodable("j-cmd-2"),
                "result": AnyCodable(["ok": true, "value": "result-b"]),
            ]
        )
        _ = bridge.handleResult(
            commandID: "j-res-3",
            params: [
                "requestId": AnyCodable("j-cmd-3"),
                "result": AnyCodable(["ok": true, "value": "result-c"]),
            ]
        )
        _ = bridge.handleResult(
            commandID: "j-res-1",
            params: [
                "requestId": AnyCodable("j-cmd-1"),
                "result": AnyCodable(["ok": true, "value": "result-a"]),
            ]
        )

        let r1 = syncAwait { await task1.value }
        let r2 = syncAwait { await task2.value }
        let r3 = syncAwait { await task3.value }
        try assertTrue(r1.ok, "Hop 8: cmd1 must resolve ok=true")
        try assertEqual(r1.value?.value as? String, "result-a",
                        "Hop 8: cmd1 must resolve with the matching result-a value")
        try assertTrue(r2.ok)
        try assertEqual(r2.value?.value as? String, "result-b",
                        "Hop 8: cmd2 must resolve with result-b")
        try assertTrue(r3.ok)
        try assertEqual(r3.value?.value as? String, "result-c",
                        "Hop 8: cmd3 must resolve with result-c")

        // Hop 9: teardown — all 3 ids must be in executedLog (handleResult
        // appends on success). Verifies the executedLog mutation path runs
        // for each completed command, which feeds the next reconcile's
        // acked-classification.
        try assertTrue(bridge.isInExecutedLog("j-cmd-1"),
                       "Hop 9 (teardown): cmd1 must be in executedLog post-result")
        try assertTrue(bridge.isInExecutedLog("j-cmd-2"),
                       "Hop 9 (teardown): cmd2 must be in executedLog post-result")
        try assertTrue(bridge.isInExecutedLog("j-cmd-3"),
                       "Hop 9 (teardown): cmd3 must be in executedLog post-result")

        // Hop 10 (reviewer SD-15 strengthening): the next reconcile from the
        // extension reports the same 3 ids as executed. The bridge must
        // classify all 3 as `acked` because handleResult appended them to
        // executedLog at Hop 8. Locks the executedLog READ path from BOTH
        // isInExecutedLog (Hop 9) AND handleReconcile (this hop) — a
        // regression that broke executedLog-write would still surface here
        // even if isInExecutedLog were faked.
        let reconResp2 = bridge.handleReconcile(
            commandID: "j-rec-2",
            executedIds: ["j-cmd-1", "j-cmd-2", "j-cmd-3"],
            pendingIds: []
        )
        try assertTrue(reconResp2.ok)
        let reconDict2 = reconResp2.value?.value as? [String: Any]
        let acked2 = reconDict2?["acked"] as? [String] ?? []
        try assertEqual(Set(acked2), Set(["j-cmd-1", "j-cmd-2", "j-cmd-3"]),
                        "Hop 10 (post-teardown reconcile): all 3 ids must classify as acked "
                            + "via executedLog lookup (locks the read path complementing Hop 9)")
        let uncertain2 = reconDict2?["uncertain"] as? [String] ?? []
        try assertEqual(uncertain2, [],
                        "Hop 10: uncertain must be empty — all 3 are in executedLog")
    }
}
