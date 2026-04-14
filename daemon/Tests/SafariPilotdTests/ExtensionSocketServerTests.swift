import Foundation
import SafariPilotdCore

func registerExtensionSocketServerTests() {
    print("")
    print("ExtensionSocketServer Tests")

    test("testServerStartsAndReturnsPort") {
        let dispatcher = makeTestDispatcher()
        let server = ExtensionSocketServer(port: 0, dispatcher: dispatcher)
        guard let port = server.start() else {
            throw TestFailure("Server failed to start")
        }
        try assertTrue(port > 0, "Port should be positive, got \(port)")
        server.stop()
    }

    test("testServerDispatchesPingCommand") {
        let dispatcher = makeTestDispatcher()
        let server = ExtensionSocketServer(port: 0, dispatcher: dispatcher)
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
        let server = ExtensionSocketServer(port: 0, dispatcher: dispatcher)
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
        let server = ExtensionSocketServer(port: 0, dispatcher: dispatcher)
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

    test("testServerReturnsExtensionStatus") {
        let dispatcher = makeTestDispatcher()
        let server = ExtensionSocketServer(port: 0, dispatcher: dispatcher)
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
        executor: StubExecutor()
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
