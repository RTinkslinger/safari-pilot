import Foundation
import SafariPilotdCore

func registerExtensionHTTPServerTests() {
    print("")
    print("ExtensionHTTPServer Tests")

    guard #available(macOS 14.0, *) else {
        print("  SKIP  ExtensionHTTPServer tests require macOS 14.0+")
        return
    }

    test("testHTTPPollReturns204WhenEmpty") {
        let (server, _, _) = startTestHTTPServer()
        defer { server.stop() }

        // Wait for server to start
        Thread.sleep(forTimeInterval: 0.5)

        let (data, response) = syncHTTPGet(port: server.testPort, path: "/poll")
        try assertEqual(response?.statusCode, 204,
                        "GET /poll with no commands should return 204, got \(response?.statusCode ?? -1)")
        // 204 should have no body (or empty)
        try assertTrue(data == nil || data!.isEmpty,
                       "204 response should have empty body")
    }

    test("testHTTPPollReturnsCommandWhenAvailable") {
        let (server, bridge, _) = startTestHTTPServer()
        defer { server.stop() }

        Thread.sleep(forTimeInterval: 0.5)

        // Queue a command via the bridge (simulating MCP sending an extension_execute)
        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "ext-cmd-1",
                params: ["script": AnyCodable("document.title"), "tabUrl": AnyCodable("https://example.com")]
            )
        }
        Thread.sleep(forTimeInterval: 0.15)

        let (data, response) = syncHTTPGet(port: server.testPort, path: "/poll")
        try assertEqual(response?.statusCode, 200,
                        "GET /poll with pending command should return 200")
        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let commands = json["commands"] as? [[String: Any]] else {
            throw TestFailure("Failed to parse poll response JSON or missing commands array")
        }
        try assertEqual(commands.count, 1, "Should return 1 command")
        try assertEqual(commands[0]["id"] as? String, "ext-cmd-1")
        try assertEqual(commands[0]["script"] as? String, "document.title")

        // Cleanup: send result to unblock execute
        _ = bridge.handleResult(
            commandID: "cleanup",
            params: ["requestId": AnyCodable("ext-cmd-1"), "result": AnyCodable("Test Page")]
        )
        _ = syncAwait { await executeTask.value }
    }

    test("testHTTPResultResumesContinuation") {
        let (server, bridge, _) = startTestHTTPServer()
        defer { server.stop() }

        Thread.sleep(forTimeInterval: 0.5)

        // Queue a command
        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "ext-cmd-2",
                params: ["script": AnyCodable("return 42")]
            )
        }
        Thread.sleep(forTimeInterval: 0.15)

        // Poll to pick it up
        let (pollData, pollResp) = syncHTTPGet(port: server.testPort, path: "/poll")
        try assertEqual(pollResp?.statusCode, 200)
        guard let pollData = pollData,
              let pollJson = try? JSONSerialization.jsonObject(with: pollData) as? [String: Any],
              let pollCommands = pollJson["commands"] as? [[String: Any]] else {
            throw TestFailure("Failed to parse poll response or missing commands array")
        }
        try assertEqual(pollCommands[0]["id"] as? String, "ext-cmd-2")

        // Post the result back
        let resultBody: [String: Any] = [
            "requestId": "ext-cmd-2",
            "result": 42,
        ]
        let (resultData, resultResp) = syncHTTPPost(
            port: server.testPort, path: "/result", json: resultBody
        )
        try assertEqual(resultResp?.statusCode, 200)
        guard let resultData = resultData,
              let resultJson = try? JSONSerialization.jsonObject(with: resultData) as? [String: Any] else {
            throw TestFailure("Failed to parse result response")
        }
        try assertEqual(resultJson["ok"] as? Bool, true)

        // Verify the execute task got the result
        let execResponse = syncAwait { await executeTask.value }
        try assertTrue(execResponse.ok, "Execute should resolve with ok=true")
    }

    test("testHTTPConnectCallsReconcile") {
        let (server, bridge, health) = startTestHTTPServer()
        defer { server.stop() }

        Thread.sleep(forTimeInterval: 0.5)

        // Verify bridge starts disconnected
        try assertFalse(bridge.isExtensionConnected)
        try assertTrue(health.lastReconcileTimestamp == nil)

        let connectBody: [String: Any] = [
            "executedIds": [] as [String],
            "pendingIds": [] as [String],
        ]
        let (data, response) = syncHTTPPost(
            port: server.testPort, path: "/connect", json: connectBody
        )
        try assertEqual(response?.statusCode, 200,
                        "POST /connect should return 200")
        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TestFailure("Failed to parse connect response")
        }

        // Verify reconcile response shape
        try assertTrue(json["acked"] != nil, "Response should contain 'acked'")
        try assertTrue(json["uncertain"] != nil, "Response should contain 'uncertain'")
        try assertTrue(json["reQueued"] != nil, "Response should contain 'reQueued'")
        try assertTrue(json["inFlight"] != nil, "Response should contain 'inFlight'")
        try assertTrue(json["pushNew"] != nil, "Response should contain 'pushNew'")

        // Verify side effects
        try assertTrue(bridge.isExtensionConnected,
                       "Bridge should be connected after /connect")
        try assertTrue(health.lastReconcileTimestamp != nil,
                       "HealthStore.lastReconcileTimestamp should be set")
    }

    test("testHTTPPollReturnsAllCommandsWhenMultipleAvailable") {
        let (server, bridge, _) = startTestHTTPServer()
        defer { server.stop() }

        Thread.sleep(forTimeInterval: 0.5)

        // Queue two commands concurrently (simulating parallel MCP tool calls)
        let execTask1 = Task {
            await bridge.handleExecute(
                commandID: "multi-cmd-1",
                params: ["script": AnyCodable("document.title")]
            )
        }
        let execTask2 = Task {
            await bridge.handleExecute(
                commandID: "multi-cmd-2",
                params: ["script": AnyCodable("document.URL")]
            )
        }
        Thread.sleep(forTimeInterval: 0.15)

        let (data, response) = syncHTTPGet(port: server.testPort, path: "/poll")
        try assertEqual(response?.statusCode, 200)
        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let commands = json["commands"] as? [[String: Any]] else {
            throw TestFailure("Failed to parse multi-command poll response")
        }
        // CRITICAL: both commands must be returned, not just the first
        try assertEqual(commands.count, 2, "Poll must return ALL queued commands, not just the first")

        let ids = Set(commands.compactMap { $0["id"] as? String })
        try assertTrue(ids.contains("multi-cmd-1"), "Must contain multi-cmd-1")
        try assertTrue(ids.contains("multi-cmd-2"), "Must contain multi-cmd-2")

        // Cleanup: send results to unblock execute tasks
        _ = bridge.handleResult(commandID: "c1", params: ["requestId": AnyCodable("multi-cmd-1"), "result": AnyCodable("t1")])
        _ = bridge.handleResult(commandID: "c2", params: ["requestId": AnyCodable("multi-cmd-2"), "result": AnyCodable("t2")])
        _ = syncAwait { await execTask1.value }
        _ = syncAwait { await execTask2.value }
    }

    test("testHTTPCORSPreflight") {
        let (server, _, _) = startTestHTTPServer()
        defer { server.stop() }

        Thread.sleep(forTimeInterval: 0.5)

        let (_, response) = syncHTTPOptions(port: server.testPort, path: "/poll")
        try assertEqual(response?.statusCode, 204,
                        "OPTIONS /poll should return 204")

        // Check CORS headers
        let allowOrigin = response?.value(forHTTPHeaderField: "Access-Control-Allow-Origin")
        try assertEqual(allowOrigin, "*",
                        "Access-Control-Allow-Origin should be *")

        let allowMethods = response?.value(forHTTPHeaderField: "Access-Control-Allow-Methods")
        try assertTrue(allowMethods != nil, "Access-Control-Allow-Methods should be present")
        try assertTrue(allowMethods!.contains("GET"), "Allow-Methods should include GET")
        try assertTrue(allowMethods!.contains("POST"), "Allow-Methods should include POST")
    }
}

// MARK: - Test Helpers

/// Port counter to avoid collisions between tests.
private var nextTestPort: UInt16 = 19500

@available(macOS 14.0, *)
private func startTestHTTPServer() -> (ExtensionHTTPServer, ExtensionBridge, HealthStore) {
    let bridge = ExtensionBridge()
    let tmpPath = FileManager.default.temporaryDirectory
        .appendingPathComponent("test-http-health-\(UUID().uuidString).json")
    let health = HealthStore(persistPath: tmpPath)
    let port = nextTestPort
    nextTestPort += 1

    let server = ExtensionHTTPServer(port: port, bridge: bridge, healthStore: health)
    server.start()
    return (server, bridge, health)
}

@available(macOS 14.0, *)
extension ExtensionHTTPServer {
    /// Expose the port for test access. Uses the fact that tests increment a counter.
    var testPort: UInt16 {
        // Access the stored port property via mirror since it's private.
        let mirror = Mirror(reflecting: self)
        for child in mirror.children where child.label == "port" {
            return child.value as! UInt16
        }
        return 0
    }
}

// MARK: - Synchronous HTTP helpers using URLSession

private func syncHTTPGet(port: UInt16, path: String) -> (Data?, HTTPURLResponse?) {
    let url = URL(string: "http://127.0.0.1:\(port)\(path)")!
    var request = URLRequest(url: url)
    request.httpMethod = "GET"
    request.timeoutInterval = 10
    return performSyncRequest(request)
}

private func syncHTTPPost(port: UInt16, path: String, json: [String: Any]) -> (Data?, HTTPURLResponse?) {
    let url = URL(string: "http://127.0.0.1:\(port)\(path)")!
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("http://localhost", forHTTPHeaderField: "Origin")
    request.httpBody = try? JSONSerialization.data(withJSONObject: json)
    request.timeoutInterval = 10
    return performSyncRequest(request)
}

private func syncHTTPOptions(port: UInt16, path: String) -> (Data?, HTTPURLResponse?) {
    let url = URL(string: "http://127.0.0.1:\(port)\(path)")!
    var request = URLRequest(url: url)
    request.httpMethod = "OPTIONS"
    request.setValue("http://localhost", forHTTPHeaderField: "Origin")
    request.setValue("GET, POST", forHTTPHeaderField: "Access-Control-Request-Method")
    request.timeoutInterval = 10
    return performSyncRequest(request)
}

private func performSyncRequest(_ request: URLRequest) -> (Data?, HTTPURLResponse?) {
    let semaphore = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var responseData: Data?
    nonisolated(unsafe) var httpResponse: HTTPURLResponse?

    let task = URLSession.shared.dataTask(with: request) { data, response, error in
        responseData = data
        httpResponse = response as? HTTPURLResponse
        semaphore.signal()
    }
    task.resume()
    _ = semaphore.wait(timeout: .now() + 15)
    return (responseData, httpResponse)
}
