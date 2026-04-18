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
}
