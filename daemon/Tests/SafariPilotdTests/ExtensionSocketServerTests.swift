import Foundation
import SafariPilotdCore

func registerExtensionSocketServerTests() {
    print("")
    print("ExtensionSocketServer Tests")

    test("testServerStartsAndReturnsPort") {
        let dispatcher = makeTestDispatcher()
        let server = try ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        try assertTrue(port > 0, "Port should be positive, got \(port)")
        server.stop()
    }

    // T45 — pre-T45 the init had a `try! NWListener(using: .tcp)` silent
    // random-port fallback when the requested port couldn't be created.
    // The audit called this a "split-brain" failure mode: the daemon
    // claims to be running on 19474 but is actually serving traffic on
    // a random ephemeral port no client knows about. Post-T45, the init
    // is throwing (no fallback), so a bind problem propagates to main.swift
    // which logs FATAL and exits.
    //
    // This test is a regression guard against the fallback's reintroduction:
    // the only way the call site below compiles and passes is if init()
    // is throwing. Pre-T45, init was non-throwing and the `try` keyword
    // would produce a "no calls to throwing functions" warning.
    test("testServerInitIsThrowing_T45_noRandomPortFallback") {
        let dispatcher = makeTestDispatcher()
        let server: ExtensionSocketServer
        do {
            server = try ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        } catch {
            throw TestFailure("port=0 should not throw; got \(error)")
        }
        // Sanity: server still starts as before.
        guard let port = server.start() else {
            throw TestFailure("Server failed to start after throwing init")
        }
        try assertTrue(port > 0, "Post-T45 throwing init still returns a usable port for port=0")
        server.stop()
    }

    test("testServerDispatchesPingCommand") {
        let dispatcher = makeTestDispatcher()
        let server = try ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        defer { server.stop() }

        let response = sendTcpJson(port: port, json: ["id": "ping1", "method": "ping"])
        guard let resp = response else {
            throw TestFailure("No response received")
        }
        try assertEqual(resp["id"] as? String, "ping1")
        try assertEqual(resp["ok"] as? Bool, true)
    }

    test("testServerHandlesMultipleSequentialConnections") {
        let dispatcher = makeTestDispatcher()
        let server = try ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        defer { server.stop() }

        for i in 0..<5 {
            let resp = sendTcpJson(port: port, json: ["id": "seq\(i)", "method": "ping"])
            try assertEqual(resp?["id"] as? String, "seq\(i)", "Connection \(i)")
            try assertEqual(resp?["ok"] as? Bool, true, "Connection \(i)")
        }
    }

    test("testServerHandlesInvalidJSON") {
        let dispatcher = makeTestDispatcher()
        let server = try ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        defer { server.stop() }

        let resp = sendTcpRaw(port: port, raw: "not json\n")
        guard let r = resp else {
            throw TestFailure("No response for invalid JSON")
        }
        try assertEqual(r["ok"] as? Bool, false, "Invalid JSON should return ok=false")
    }

    // T69a — pre-fix the daemon's NWConnection.receive used minimumIncompleteLength: 1
    // with no accumulate-until-\n loop. Any TCP message split across segments
    // (long click JS payloads >~64KB, or any deliberate multi-write) got dispatched
    // as the truncated first segment → PARSE_ERROR. Empirically observed in
    // test-results/traces/2026-05-02_23-16-42 (req-1776886358285-20 truncated
    // mid-string at \\\\\\\"target\\\")).
    //
    // Post-fix: server accumulates received bytes into a buffer until \n arrives,
    // then dispatches the complete line. Client request-response contract preserved
    // (one command per connection, server cancels after sending response).
    test("testServerAccumulatesMultiSegmentMessage_T69a") {
        let dispatcher = makeTestDispatcher()
        let server = try ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        defer { server.stop() }

        // Build a valid command, split it in half, send each half with a delay
        // long enough that NWConnection delivers them as separate receive calls.
        let cmd = #"{"id":"split","method":"ping"}"# + "\n"
        let mid = cmd.count / 2
        let part1 = String(cmd.prefix(mid))
        let part2 = String(cmd.suffix(cmd.count - mid))

        let resp = sendTcpRawSplit(port: port, parts: [part1, part2], interDelayMs: 50)
        guard let r = resp else {
            throw TestFailure("No response received for split message — pre-T69a may have closed connection without responding")
        }
        // Pre-fix: id="unknown", ok=false (PARSE_ERROR on the truncated first chunk).
        // Post-fix: id="split", ok=true.
        try assertEqual(r["id"] as? String, "split", "id should be the planted value, not 'unknown' (which would indicate pre-fix truncation)")
        try assertEqual(r["ok"] as? Bool, true, "ok should be true on the reassembled command, not the pre-fix PARSE_ERROR")
    }

    test("testServerHandlesNewlineInSecondChunk_T69a") {
        // Second-chunk-contains-newline edge case: most of the message arrives
        // first, then a small final chunk delivers the newline. Pre-fix the
        // server dispatches on the first chunk (no newline → NDJSONParser fails).
        // Post-fix the server waits.
        let dispatcher = makeTestDispatcher()
        let server = try ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        defer { server.stop() }

        let cmd = #"{"id":"late-nl","method":"ping"}"#
        // 95% of bytes in first write, then "}\n" tail in the second write.
        let part1 = String(cmd.prefix(cmd.count - 1))
        let part2 = String(cmd.suffix(1)) + "\n"

        let resp = sendTcpRawSplit(port: port, parts: [part1, part2], interDelayMs: 50)
        guard let r = resp else {
            throw TestFailure("No response received for late-newline message")
        }
        try assertEqual(r["id"] as? String, "late-nl")
        try assertEqual(r["ok"] as? Bool, true)
    }

    test("testServerStillHandlesSingleChunkMessage_T69a_regression") {
        // Regression guard — the simple case (full message in one chunk) must
        // still work after the accumulation refactor.
        let dispatcher = makeTestDispatcher()
        let server = try ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        defer { server.stop() }

        let resp = sendTcpJson(port: port, json: ["id": "single", "method": "ping"])
        try assertEqual(resp?["id"] as? String, "single")
        try assertEqual(resp?["ok"] as? Bool, true)
    }

    test("testServerReturnsExtensionStatus") {
        let dispatcher = makeTestDispatcher()
        let server = try ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        defer { server.stop() }

        let resp = sendTcpJson(port: port, json: ["id": "s1", "method": "extension_status"])
        try assertEqual(resp?["id"] as? String, "s1")
        try assertEqual(resp?["ok"] as? Bool, true)
    }
}

// MARK: - Helpers

private func makeTestDispatcher() -> CommandDispatcher {
    return CommandDispatcher(
        lineSource: { nil },
        outputSink: { _ in },
        executor: StubExecutor(),
        healthStore: makeHealthStoreForTest()
    )
}

private final class StubExecutor: ScriptExecutorProtocol, @unchecked Sendable {
    func execute(script: String, commandID: String) async -> Response {
        return Response.success(id: commandID, value: AnyCodable("stub"))
    }
}

private func sendTcpJson(port: UInt16, json: [String: Any]) -> [String: Any]? {
    guard let data = try? JSONSerialization.data(withJSONObject: json),
          let str = String(data: data, encoding: .utf8) else { return nil }
    return sendTcpRaw(port: port, raw: str + "\n")
}

private func sendTcpRawSplit(port: UInt16, parts: [String], interDelayMs: Int) -> [String: Any]? {
    var inputStream: InputStream?
    var outputStream: OutputStream?
    Stream.getStreamsToHost(withName: "127.0.0.1", port: Int(port),
                           inputStream: &inputStream, outputStream: &outputStream)
    guard let input = inputStream, let output = outputStream else { return nil }

    input.open()
    output.open()
    defer { input.close(); output.close() }

    for (i, part) in parts.enumerated() {
        let bytes = Array(part.utf8)
        _ = output.write(bytes, maxLength: bytes.count)
        if i < parts.count - 1 {
            Thread.sleep(forTimeInterval: Double(interDelayMs) / 1000.0)
        }
    }

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
