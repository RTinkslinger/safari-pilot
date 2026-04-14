import Foundation
import SafariPilotdCore

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

    test("testPollReturnsNullWhenNoCommandsPending") {
        let bridge = ExtensionBridge()
        let response = bridge.handlePoll(commandID: "poll-1")
        try assertTrue(response.ok)

        let valueDict = response.value?.value as? [String: Any]
        try assertTrue(valueDict != nil, "Response value should be a dictionary")
        try assertTrue(valueDict?["command"] is NSNull, "Command should be null when no commands pending")
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

        // Poll should return the queued command
        let pollResponse = bridge.handlePoll(commandID: "poll-1")
        try assertTrue(pollResponse.ok)

        let valueDict = pollResponse.value?.value as? [String: Any]
        let command = valueDict?["command"] as? [String: Any]
        try assertTrue(command != nil, "Poll should return the queued command")
        try assertEqual(command?["id"] as? String, "exec-1")
        try assertEqual(command?["script"] as? String, "return document.title")

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
            extensionBridge: bridge
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
            extensionBridge: bridge
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
            extensionBridge: bridge
        )

        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"poll-1","method":"extension_poll"}"#)
        }
        try assertTrue(response.ok)
        let valueDict = response.value?.value as? [String: Any]
        try assertTrue(valueDict?["command"] is NSNull, "No commands should be pending")
    }

    test("testDisconnectCancelsPendingCommands") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "conn-1")

        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "exec-cancel",
                params: ["script": AnyCodable("return 1")]
            )
        }

        Thread.sleep(forTimeInterval: 0.1)

        _ = bridge.handleDisconnected(commandID: "disc-1")

        let response = syncAwait { await executeTask.value }
        try assertFalse(response.ok)
        try assertEqual(response.error?.code, "EXTENSION_DISCONNECTED")
    }
}
