import Foundation
import SafariPilotdCore

// MARK: - ExtensionBridge Tests

func registerExtensionBridgeTests() {

    // 16. testExtensionBridgeStartsDisconnected
    test("testExtensionBridgeStartsDisconnected") {
        let bridge = ExtensionBridge()
        try assertFalse(bridge.isExtensionConnected, "Bridge should start disconnected")
    }

    // 17. testExtensionConnectSetsConnectedState
    test("testExtensionConnectSetsConnectedState") {
        let bridge = ExtensionBridge()
        let response = bridge.handleConnected(commandID: "conn-1")
        try assertTrue(response.ok, "handleConnected should return ok")
        try assertEqual(response.id, "conn-1")
        try assertTrue(bridge.isExtensionConnected, "Bridge should be connected after handleConnected")
    }

    // 18. testExtensionDisconnectClearsConnectedState
    test("testExtensionDisconnectClearsConnectedState") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "conn-1")
        try assertTrue(bridge.isExtensionConnected)

        let response = bridge.handleDisconnected(commandID: "disc-1")
        try assertTrue(response.ok, "handleDisconnected should return ok")
        try assertEqual(response.id, "disc-1")
        try assertFalse(bridge.isExtensionConnected, "Bridge should be disconnected after handleDisconnected")
    }

    // 19. testExtensionStatusReportsConnected
    test("testExtensionStatusReportsConnected") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "conn-1")

        let status = bridge.handleStatus(commandID: "status-1")
        try assertTrue(status.ok)
        try assertEqual(status.value?.value as? String, "connected")
    }

    // 20. testExtensionStatusReportsDisconnected
    test("testExtensionStatusReportsDisconnected") {
        let bridge = ExtensionBridge()
        let status = bridge.handleStatus(commandID: "status-1")
        try assertTrue(status.ok)
        try assertEqual(status.value?.value as? String, "disconnected")
    }

    // 21. testExtensionExecuteFailsWhenDisconnected
    test("testExtensionExecuteFailsWhenDisconnected") {
        let bridge = ExtensionBridge()
        let response = syncAwait {
            await bridge.handleExecute(
                commandID: "exec-1",
                params: ["script": AnyCodable("return 1")]
            )
        }
        try assertFalse(response.ok)
        try assertEqual(response.error?.code, "EXTENSION_NOT_CONNECTED")
    }

    // 22. testExtensionResultRoutesBackToPendingCaller
    test("testExtensionResultRoutesBackToPendingCaller") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "conn-1")

        // Start an execute — it suspends waiting for a result
        nonisolated(unsafe) var execResponse: Response?
        let sem = DispatchSemaphore(value: 0)

        Task {
            let r = await bridge.handleExecute(
                commandID: "exec-abc",
                params: ["script": AnyCodable("return document.title")]
            )
            execResponse = r
            sem.signal()
        }

        // Give the Task a moment to register the pending request
        Thread.sleep(forTimeInterval: 0.05)

        // Extension sends back a result
        let resultResponse = bridge.handleResult(
            commandID: "result-1",
            params: [
                "requestId": AnyCodable("exec-abc"),
                "result": AnyCodable("My Page Title"),
            ]
        )
        try assertTrue(resultResponse.ok, "handleResult should ack ok")

        // Wait for the execute to resolve
        sem.wait()

        try assertTrue(execResponse?.ok == true, "execute should resolve ok after result arrives")
        try assertEqual(execResponse?.value?.value as? String, "My Page Title")
    }

    // 23. testExtensionDisconnectCancelsPendingRequests
    test("testExtensionDisconnectCancelsPendingRequests") {
        let bridge = ExtensionBridge()
        _ = bridge.handleConnected(commandID: "conn-1")

        nonisolated(unsafe) var execResponse: Response?
        let sem = DispatchSemaphore(value: 0)

        Task {
            let r = await bridge.handleExecute(
                commandID: "exec-pending",
                params: ["script": AnyCodable("return 1")]
            )
            execResponse = r
            sem.signal()
        }

        Thread.sleep(forTimeInterval: 0.05)

        // Extension disconnects before returning a result
        _ = bridge.handleDisconnected(commandID: "disc-1")

        sem.wait()

        try assertFalse(execResponse?.ok == true, "pending execute should fail on disconnect")
        try assertEqual(execResponse?.error?.code, "EXTENSION_DISCONNECTED")
    }

    // 24. testDispatcherRoutesExtensionConnected
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

    // 25. testDispatcherExtensionStatusCommand
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
}
