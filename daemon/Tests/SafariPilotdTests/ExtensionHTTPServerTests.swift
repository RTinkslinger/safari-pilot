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

    test("testHTTPServerCallsOnReadyAfterStart") {
        let bridge = ExtensionBridge()
        let tmpPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("test-http-health-\(UUID().uuidString).json")
        let health = HealthStore(persistPath: tmpPath)
        let port = nextTestPort
        nextTestPort += 1

        let readyExpectation = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var readyCalled = false

        let server = ExtensionHTTPServer(
            port: port,
            bridge: bridge,
            healthStore: health,
            onReady: {
                readyCalled = true
                readyExpectation.signal()
            }
        )
        server.start()
        defer { server.stop() }

        let result = readyExpectation.wait(timeout: .now() + 5)
        try assertTrue(result == .success, "onReady should fire within 5s")
        try assertTrue(readyCalled, "onReady callback should have been called")
    }

    // MARK: - SD-13: route coverage (status / session / health / session/register)

    test("testHTTPStatusReturnsCurrentBridgeAndHealthState") {
        // Discrimination targets in handleStatus() (ExtensionHTTPServer.swift:256-280):
        // every field is read from the SUT's bridge / healthStore. Hardcoding any
        // of `ext`, `mcp`, `sessionTab`, `lastPingAge`, `activeSessions` would
        // surface here.
        let (server, bridge, health) = startTestHTTPServer()
        defer { server.stop() }
        Thread.sleep(forTimeInterval: 0.5)

        // Pre-state: connect bridge + flip mcp + flip sessionTab + ping ext + register a session.
        _ = bridge.handleConnected(commandID: "pre-status")
        health.setMcpConnected(true)
        health.recordSessionServed()
        health.recordKeepalivePing()
        health.registerSession("pre-status-sess")

        let (data, response) = syncHTTPGet(port: server.testPort, path: "/status")
        try assertEqual(response?.statusCode, 200, "GET /status must return 200")
        try assertTrue(
            response?.value(forHTTPHeaderField: "Content-Type")?.contains("application/json") == true,
            "GET /status content-type must be application/json"
        )
        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TestFailure("Failed to parse /status JSON")
        }

        try assertEqual(json["ext"] as? Bool, true,
                        "ext field must reflect bridge.isExtensionConnected (true after handleConnected)")
        try assertEqual(json["mcp"] as? Bool, true,
                        "mcp field must reflect health.mcpConnected (true after setMcpConnected)")
        try assertEqual(json["sessionTab"] as? Bool, true,
                        "sessionTab must reflect health.sessionTabActive (true after recordSessionServed)")
        try assertTrue(json["lastPingAge"] != nil,
                       "lastPingAge must be present after recordKeepalivePing (Int, NOT NSNull)")
        // Reviewer ADVISORY A1: lock the `Int(timeIntervalSince(last) * 1000)`
        // semantics, not just the `?? NSNull()` branch selection. recordKeepalivePing
        // happened immediately above; observed elapsed across a synchronous URLSession
        // round-trip is well under 500ms. A regression that hardcoded a constant
        // (e.g. `lastPingAge = 0`) would still satisfy `is Int` but fail this range.
        guard let pingAge = json["lastPingAge"] as? Int else {
            throw TestFailure("lastPingAge must be Int(ms) when a ping has been recorded")
        }
        try assertTrue(
            pingAge >= 0 && pingAge < 500,
            "lastPingAge must reflect Int(timeIntervalSince(last) * 1000) for a fresh ping; got \(pingAge)"
        )
        try assertEqual(json["activeSessions"] as? Int, 1,
                        "activeSessions must reflect health.activeSessionCount")
    }

    test("testHTTPStatusReturnsNullPingAgeBeforeAnyPing") {
        // Reviewer ADVISORY A2 (SD-13): mirror T5's negative form for /health on
        // /status. handleStatus() lines 261-265 has the same `?? NSNull()` shape
        // as handleHealth(); a regression replacing NSNull() with 0 would
        // silently make the dashboard render "0ms ago" for never-pinged
        // sessions. Lock the null-selection branch.
        let (server, _, _) = startTestHTTPServer()
        defer { server.stop() }
        Thread.sleep(forTimeInterval: 0.5)

        let (data, response) = syncHTTPGet(port: server.testPort, path: "/status")
        try assertEqual(response?.statusCode, 200)
        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TestFailure("Failed to parse /status JSON")
        }
        try assertTrue(
            json["lastPingAge"] is NSNull,
            "lastPingAge must be JSON null (NSNull) before any recordKeepalivePing; "
                + "got \(String(describing: json["lastPingAge"]))"
        )
    }

    test("testHTTPStatusTouchesSessionWithSessionIdQueryParam") {
        // Discrimination target: ExtensionHTTPServer.swift:134-136
        //     if let sessionId = request.uri.queryParameters.get("sessionId") {
        //         self.healthStore.touchSession(sessionId)
        //     }
        // Removing the touchSession call would leave lastSeen stale despite the
        // implicit-heartbeat contract (every /status call from a registered
        // session advances lastSeen).
        let (server, _, health) = startTestHTTPServer()
        defer { server.stop() }
        Thread.sleep(forTimeInterval: 0.5)

        health.registerSession("sess-touch-1")
        guard let firstSeen = health.lastSeenForSession("sess-touch-1") else {
            throw TestFailure("registerSession must establish a lastSeen")
        }

        Thread.sleep(forTimeInterval: 0.05)  // ensure Date() differs

        let (_, response) = syncHTTPGet(port: server.testPort, path: "/status?sessionId=sess-touch-1")
        try assertEqual(response?.statusCode, 200)

        guard let secondSeen = health.lastSeenForSession("sess-touch-1") else {
            throw TestFailure("touchSession must keep the session live, not delete it")
        }
        try assertTrue(
            secondSeen > firstSeen,
            "GET /status?sessionId=... must advance lastSeen via touchSession; "
                + "got firstSeen=\(firstSeen), secondSeen=\(secondSeen)"
        )
    }

    test("testHTTPSessionServesHTMLAndRecordsServed") {
        // Discrimination targets (handleSession at ExtensionHTTPServer.swift:301-319):
        //   1. recordSessionServed() — without it, sessionTabActive stays false.
        //   2. text/html content-type — JSON callers would otherwise treat the body wrong.
        //   3. The actual HTML body — gating against an empty 200.
        let (server, _, health) = startTestHTTPServer()
        defer { server.stop() }
        Thread.sleep(forTimeInterval: 0.5)

        try assertFalse(health.sessionTabActive,
                        "sessionTabActive must start false")

        let (data, response) = syncHTTPGet(port: server.testPort, path: "/session")
        try assertEqual(response?.statusCode, 200, "GET /session must return 200")
        let contentType = response?.value(forHTTPHeaderField: "Content-Type") ?? ""
        try assertTrue(contentType.contains("text/html"),
                       "GET /session content-type must be text/html, got \(contentType)")

        guard let body = data, let html = String(data: body, encoding: .utf8) else {
            throw TestFailure("/session body must decode as UTF-8")
        }
        // The page title is the most stable piece of identity in the HTML —
        // matching it locks the dashboard contract without coupling to layout.
        // Reviewer ADVISORY A3 (SD-13): this assertion is intentionally
        // brittle — a rename here is a deliberate UX change and SHOULD force
        // a test update rather than slipping through silently. The em-dash
        // (U+2014) is the most-likely cosmetic rewrite target.
        try assertTrue(
            html.contains("Safari Pilot — Active Session"),
            "/session HTML must include the page title literal"
        )

        try assertTrue(
            health.sessionTabActive,
            "GET /session must flip health.sessionTabActive via recordSessionServed"
        )
    }

    test("testHTTPHealthReturnsCurrentExtensionAndMcpState") {
        // Discrimination target: handleHealth (ExtensionHTTPServer.swift:284-297).
        // The dashboard JS polls this every 5s — its three fields are the only
        // signal the user sees for connectivity. Hardcoding any of them surfaces
        // immediately.
        let (server, bridge, health) = startTestHTTPServer()
        defer { server.stop() }
        Thread.sleep(forTimeInterval: 0.5)

        // Pre-state: flip everything the way it would look on a live system.
        _ = bridge.handleConnected(commandID: "pre-health")
        health.setMcpConnected(true)
        health.markExecutedResult()

        let (data, response) = syncHTTPGet(port: server.testPort, path: "/health")
        try assertEqual(response?.statusCode, 200)
        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TestFailure("Failed to parse /health JSON")
        }

        try assertEqual(json["isConnected"] as? Bool, true,
                        "isConnected must reflect bridge.isExtensionConnected")
        try assertEqual(json["mcpConnected"] as? Bool, true,
                        "mcpConnected must reflect health.mcpConnected")
        // lastExecutedResultTimestamp is in ms; markExecutedResult stamps to now,
        // so the value must be > 0 and within ~5s of now.
        let nowMs = Date().timeIntervalSince1970 * 1000
        guard let stampMs = json["lastExecutedResultTimestamp"] as? Double else {
            throw TestFailure("lastExecutedResultTimestamp must be a Double (ms), got \(String(describing: json["lastExecutedResultTimestamp"]))")
        }
        try assertTrue(stampMs > 0,
                       "lastExecutedResultTimestamp must be > 0 after markExecutedResult")
        try assertTrue(
            abs(nowMs - stampMs) < 5000,
            "lastExecutedResultTimestamp must be within ~5s of now; got delta=\(nowMs - stampMs)ms"
        )
    }

    test("testHTTPHealthReturnsNullTimestampBeforeAnyExecutedResult") {
        // Negative form for the timestamp branch — locks the
        //     ts.timeIntervalSince1970 * 1000 ?? NSNull()
        // path. If the SUT replaced NSNull with 0, dashboards would show
        // "1970-01-01" instead of "—".
        let (server, _, _) = startTestHTTPServer()
        defer { server.stop() }
        Thread.sleep(forTimeInterval: 0.5)

        let (data, response) = syncHTTPGet(port: server.testPort, path: "/health")
        try assertEqual(response?.statusCode, 200)
        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TestFailure("Failed to parse /health JSON")
        }
        // JSONSerialization decodes NSNull as NSNull (which JSONSerialization writes as `null`),
        // and on the wire decodes back as NSNull. Either way, the field key MUST be present
        // and must NOT be a numeric value.
        try assertTrue(
            json["lastExecutedResultTimestamp"] is NSNull,
            "lastExecutedResultTimestamp must be JSON null (NSNull) before any markExecutedResult; "
                + "got \(String(describing: json["lastExecutedResultTimestamp"]))"
        )
    }

    test("testHTTPSessionRegisterAddsSessionAndReturnsCount") {
        // Discrimination target: the inline /session/register handler
        // (ExtensionHTTPServer.swift:148-162). Removing registerSession() would
        // leave activeSessionCount at 0; removing the response.activeSessions
        // field would break the client expectation of the count.
        let (server, _, health) = startTestHTTPServer()
        defer { server.stop() }
        Thread.sleep(forTimeInterval: 0.5)

        try assertEqual(health.activeSessionCount, 0,
                        "activeSessionCount must start 0")

        let body: [String: Any] = ["sessionId": "sd13-sess-1"]
        let (data, response) = syncHTTPPost(
            port: server.testPort, path: "/session/register", json: body
        )
        try assertEqual(response?.statusCode, 200, "POST /session/register must return 200 on valid body")
        guard let data = data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw TestFailure("Failed to parse /session/register JSON")
        }
        try assertEqual(json["ok"] as? Bool, true,
                        "Response.ok must be true on successful register")
        try assertEqual(json["activeSessions"] as? Int, 1,
                        "Response.activeSessions must reflect post-register count")

        try assertEqual(health.activeSessionCount, 1,
                        "health.activeSessionCount must reflect the new session")
        try assertTrue(
            health.lastSeenForSession("sd13-sess-1") != nil,
            "registerSession must establish lastSeen for the new id"
        )
    }

    // MARK: - SD-13: error-path coverage (400 on bad bodies)

    test("testHTTPSessionRegisterMissingSessionIdReturns400") {
        // Discrimination target: the guard chain at ExtensionHTTPServer.swift:151-156
        // — specifically the `let sessionId = json["sessionId"] as? String` clause.
        // If that clause is removed, the SUT would proceed with sessionId="" or crash.
        let (server, _, health) = startTestHTTPServer()
        defer { server.stop() }
        Thread.sleep(forTimeInterval: 0.5)

        let body: [String: Any] = ["wrong_key": "no-session-id-here"]
        let (_, response) = syncHTTPPost(
            port: server.testPort, path: "/session/register", json: body
        )
        try assertEqual(response?.statusCode, 400,
                        "POST /session/register without sessionId must return 400; got \(response?.statusCode ?? -1)")

        try assertEqual(health.activeSessionCount, 0,
                        "Failed register must NOT touch activeSessionCount")
    }

    test("testHTTPSessionRegisterEmptyBodyReturns400") {
        // Discrimination target: the `buffer.readableBytes > 0` check at line 151.
        // An empty body must short-circuit with 400 — without that guard, the
        // following `JSONSerialization.jsonObject` would throw and surface as 500.
        let (server, _, health) = startTestHTTPServer()
        defer { server.stop() }
        Thread.sleep(forTimeInterval: 0.5)

        let url = URL(string: "http://127.0.0.1:\(server.testPort)/session/register")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("http://localhost", forHTTPHeaderField: "Origin")
        // Deliberately no body
        request.timeoutInterval = 10
        let (_, response) = performSyncRequest(request)
        try assertEqual(response?.statusCode, 400,
                        "POST /session/register with empty body must return 400")
        try assertEqual(health.activeSessionCount, 0,
                        "Empty-body POST must NOT register a session")
    }

    test("testHTTPResultMissingRequestIdReturns400") {
        // Discrimination target: handleResult guard at ExtensionHTTPServer.swift:229-234
        // — if `requestId` is missing, the route MUST throw HTTPError(.badRequest)
        // BEFORE forwarding to bridge.handleResult, which would otherwise emit
        // a no-op ack with no diagnostic.
        let (server, bridge, _) = startTestHTTPServer()
        defer { server.stop() }
        Thread.sleep(forTimeInterval: 0.5)

        // Queue a real command so we can later verify it's NOT prematurely acked.
        let executeTask = Task {
            await bridge.handleExecute(
                commandID: "result-guard-real",
                params: ["script": AnyCodable("return 1")]
            )
        }
        Thread.sleep(forTimeInterval: 0.1)

        // POST /result with no requestId
        let body: [String: Any] = ["result": ["ok": true, "value": "stray"]]
        let (_, response) = syncHTTPPost(
            port: server.testPort, path: "/result", json: body
        )
        try assertEqual(response?.statusCode, 400,
                        "POST /result without requestId must return 400")

        // Cleanup: send a real result so executeTask completes
        _ = bridge.handleResult(
            commandID: "cleanup-result-guard",
            params: [
                "requestId": AnyCodable("result-guard-real"),
                "result": AnyCodable(["ok": true, "value": "ok"]),
            ]
        )
        _ = syncAwait { await executeTask.value }
    }

    // MARK: - SD-13: 15s disconnect timeout

    test("testDisconnectCheckFiresWhenIdleBeyondThreshold") {
        // Discrimination target: ExtensionHTTPServer.swift:467-475, specifically
        //     if elapsed > Self.disconnectTimeout && bridge.isExtensionConnected
        //     bridge.handleDisconnected(commandID: "http-disconnect-timeout")
        // Removing either the elapsed comparison or the handleDisconnected call
        // breaks the wake-from-stale-extension contract.
        let (server, bridge, _) = startTestHTTPServer()
        defer { server.stop() }
        Thread.sleep(forTimeInterval: 0.5)

        _ = bridge.handleConnected(commandID: "pre-disconnect")
        try assertTrue(bridge.isExtensionConnected,
                       "bridge must be connected before staleness check")

        // 16s elapsed > 15s threshold → must disconnect.
        server.runDisconnectCheckForTest(elapsedSeconds: 16)

        try assertFalse(
            bridge.isExtensionConnected,
            "checkDisconnect with elapsed > 15s must call bridge.handleDisconnected"
        )
    }

    test("testDisconnectCheckPreservesConnectionWhenFresh") {
        // Negative form: fresh `_lastRequestTime` (5s ago) must NOT trigger
        // disconnect. Locks against a regression that drops the elapsed
        // comparison entirely.
        let (server, bridge, _) = startTestHTTPServer()
        defer { server.stop() }
        Thread.sleep(forTimeInterval: 0.5)

        _ = bridge.handleConnected(commandID: "pre-fresh")
        try assertTrue(bridge.isExtensionConnected)

        server.runDisconnectCheckForTest(elapsedSeconds: 5)

        try assertTrue(
            bridge.isExtensionConnected,
            "checkDisconnect with elapsed < 15s must NOT call handleDisconnected"
        )
    }

    // MARK: - SD-13: onBindFailure

    test("testOnBindFailureFiresWhenPortAlreadyBound") {
        // Discrimination target: the catch block at ExtensionHTTPServer.swift:79-82
        //     } catch {
        //         Logger.error(...)
        //         self.onBindFailure?(error)
        //     }
        // If the catch is removed (Swift would force-throw), the second start
        // would crash. If onBindFailure?() is removed, the binding error is
        // silently swallowed — the wiring (production: increments
        // health.httpBindFailureCount) never fires.
        let bridge1 = ExtensionBridge()
        let bridge2 = ExtensionBridge()
        let tmp1 = FileManager.default.temporaryDirectory
            .appendingPathComponent("test-bind-1-\(UUID().uuidString).json")
        let tmp2 = FileManager.default.temporaryDirectory
            .appendingPathComponent("test-bind-2-\(UUID().uuidString).json")
        let h1 = HealthStore(persistPath: tmp1)
        let h2 = HealthStore(persistPath: tmp2)
        // Pick a port outside the auto-incremented sequence (19500+) and outside
        // the production port (19475) to avoid collisions with concurrent runs.
        let conflictPort: UInt16 = 19999

        let server1 = ExtensionHTTPServer(port: conflictPort, bridge: bridge1, healthStore: h1)
        server1.start()
        defer { server1.stop() }
        Thread.sleep(forTimeInterval: 0.5)  // give server1 time to bind

        let bindFailExpectation = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var capturedError: Error?

        let server2 = ExtensionHTTPServer(
            port: conflictPort,
            bridge: bridge2,
            healthStore: h2,
            onBindFailure: { error in
                capturedError = error
                bindFailExpectation.signal()
            }
        )
        server2.start()
        defer { server2.stop() }

        let result = bindFailExpectation.wait(timeout: .now() + 5)
        try assertTrue(
            result == .success,
            "onBindFailure must fire within 5s when binding to an already-bound port"
        )
        try assertTrue(
            capturedError != nil,
            "onBindFailure must receive a non-nil error"
        )
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

// MARK: - testPort
// SD-17 cleanup: the prior Mirror-based accessor silently returned 0 if anyone
// renamed the private `port` field (e.g. to `_port`), causing tests to connect
// to http://127.0.0.1:0 with confusing failures. The SUT now exposes `port`
// as a `public let` so tests use the real getter and a rename surfaces as a
// compile error instead of a runtime flake.
@available(macOS 14.0, *)
extension ExtensionHTTPServer {
    var testPort: UInt16 { port }
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
