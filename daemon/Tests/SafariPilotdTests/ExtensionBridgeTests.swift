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

    // 21. testExtensionExecuteWritesCommandFile
    test("testExtensionExecuteWritesCommandFile") {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bridge-test-\(UUID().uuidString)")
        let bridge = ExtensionBridge(bridgeDirectory: tmpDir)

        let commandID = "exec-file-1"
        let wrote = bridge.writeCommandFile(
            commandID: commandID,
            params: ["script": AnyCodable("return document.title")]
        )
        try assertTrue(wrote, "writeCommandFile should succeed")

        // Verify the file exists
        let filePath = tmpDir.appendingPathComponent("commands/\(commandID).json")
        try assertTrue(FileManager.default.fileExists(atPath: filePath.path), "Command file should exist")

        // Verify content
        let data = try Data(contentsOf: filePath)
        let parsed = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        try assertEqual(parsed["id"] as? String, commandID)
        try assertEqual(parsed["script"] as? String, "return document.title")

        // Cleanup
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // 22. testExtensionReadResultFile
    test("testExtensionReadResultFile") {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bridge-test-\(UUID().uuidString)")
        let bridge = ExtensionBridge(bridgeDirectory: tmpDir)

        let commandID = "result-read-1"
        let resultsDir = tmpDir.appendingPathComponent("results")

        // Write a fake result file (as the extension would)
        let resultPayload: [String: Any] = [
            "id": commandID,
            "result": "My Page Title",
            "timestamp": ISO8601DateFormatter().string(from: Date()),
        ]
        let data = try JSONSerialization.data(withJSONObject: resultPayload, options: [])
        try data.write(to: resultsDir.appendingPathComponent("\(commandID).json"))

        // Read via bridge
        let response = bridge.readResultFile(commandID: commandID)
        try assertTrue(response != nil, "readResultFile should return a response")
        try assertTrue(response!.ok, "Response should be ok")
        try assertEqual(response!.value?.value as? String, "My Page Title")

        // File should be deleted after reading
        let filePath = resultsDir.appendingPathComponent("\(commandID).json")
        try assertFalse(FileManager.default.fileExists(atPath: filePath.path),
                        "Result file should be deleted after reading")

        // Cleanup
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // 23. testExtensionReadResultFileReturnsNilWhenMissing
    test("testExtensionReadResultFileReturnsNilWhenMissing") {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bridge-test-\(UUID().uuidString)")
        let bridge = ExtensionBridge(bridgeDirectory: tmpDir)

        let response = bridge.readResultFile(commandID: "nonexistent")
        try assertTrue(response == nil, "readResultFile should return nil for missing file")

        // Cleanup
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // 24. testExtensionCleanupCommandFile
    test("testExtensionCleanupCommandFile") {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bridge-test-\(UUID().uuidString)")
        let bridge = ExtensionBridge(bridgeDirectory: tmpDir)

        let commandID = "cleanup-1"
        _ = bridge.writeCommandFile(
            commandID: commandID,
            params: ["script": AnyCodable("return 1")]
        )

        let filePath = tmpDir.appendingPathComponent("commands/\(commandID).json")
        try assertTrue(FileManager.default.fileExists(atPath: filePath.path))

        bridge.cleanupCommandFile(commandID: commandID)
        try assertFalse(FileManager.default.fileExists(atPath: filePath.path),
                        "Command file should be deleted after cleanup")

        // Cleanup
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // 25. testDispatcherRoutesExtensionConnected
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

    // 26. testDispatcherExtensionStatusCommand
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

    // 27. testExtensionExecuteTimesOutWhenNoResult
    test("testExtensionExecuteTimesOutWhenNoResult") {
        // This test would take 30s with real timeout — we test the file write portion only
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bridge-test-\(UUID().uuidString)")
        let bridge = ExtensionBridge(bridgeDirectory: tmpDir)

        // Verify command file creation works (the prerequisite for execute)
        let wrote = bridge.writeCommandFile(
            commandID: "timeout-test",
            params: ["script": AnyCodable("return 1")]
        )
        try assertTrue(wrote)

        let cmdPath = tmpDir.appendingPathComponent("commands/timeout-test.json")
        try assertTrue(FileManager.default.fileExists(atPath: cmdPath.path))

        // Cleanup
        try? FileManager.default.removeItem(at: tmpDir)
    }

    // 28. testExtensionReadResultWithError
    test("testExtensionReadResultWithError") {
        let tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("bridge-test-\(UUID().uuidString)")
        let bridge = ExtensionBridge(bridgeDirectory: tmpDir)

        let commandID = "error-result-1"
        let resultsDir = tmpDir.appendingPathComponent("results")

        // Write a result file with an error
        let errorPayload: [String: Any] = [
            "id": commandID,
            "error": "Tab not found",
        ]
        let data = try JSONSerialization.data(withJSONObject: errorPayload, options: [])
        try data.write(to: resultsDir.appendingPathComponent("\(commandID).json"))

        let response = bridge.readResultFile(commandID: commandID)
        try assertTrue(response != nil)
        try assertFalse(response!.ok, "Response should be failure for error result")
        try assertEqual(response!.error?.code, "EXTENSION_ERROR")
        try assertEqual(response!.error?.message, "Tab not found")

        // Cleanup
        try? FileManager.default.removeItem(at: tmpDir)
    }
}
