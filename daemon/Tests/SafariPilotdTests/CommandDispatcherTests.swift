import Foundation
import SafariPilotdCore

// MARK: - Mock Executor
// Declarations only — no top-level expressions allowed in non-entry-point Swift files.

/// Synchronous mock that returns a pre-canned Response without touching NSAppleScript.
final class MockExecutor: ScriptExecutorProtocol, @unchecked Sendable {
    var lastScript: String?
    var responseToReturn: Response = Response.success(id: "mock", value: AnyCodable("mock_result"))

    func execute(script: String, commandID: String) async -> Response {
        lastScript = script
        return Response(
            id: commandID,
            ok: responseToReturn.ok,
            value: responseToReturn.value,
            error: responseToReturn.error,
            elapsedMs: 0
        )
    }
}

// MARK: - Async bridge for synchronous test harness

/// Run an async function synchronously via a semaphore.
/// The test runner has no event loop, so we bridge with DispatchSemaphore.
func syncAwait<T>(_ body: @escaping () async -> T) -> T {
    let semaphore = DispatchSemaphore(value: 0)
    // T is not Sendable in general, but we only use this in tests with value types.
    nonisolated(unsafe) var result: T!
    Task {
        result = await body()
        semaphore.signal()
    }
    semaphore.wait()
    return result
}

// MARK: - Test registration
// Called from NDJSONProtocolTests.swift (the executable entry point) to register
// all CommandDispatcher tests into the shared test runner.

func registerCommandDispatcherTests() {

    // 7. testPingCommand — dispatcher returns "pong"
    test("testPingCommand") {
        let mock = MockExecutor()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock
        )
        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"ping-test","method":"ping"}"#)
        }
        try assertEqual(response.id, "ping-test")
        try assertTrue(response.ok)
        try assertEqual(response.value?.value as? String, "pong")
    }

    // 8. testUnknownMethod — returns error with UNKNOWN_METHOD code
    test("testUnknownMethod") {
        let mock = MockExecutor()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock
        )
        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"cmd-x","method":"doesNotExist"}"#)
        }
        try assertFalse(response.ok)
        try assertEqual(response.error?.code, "UNKNOWN_METHOD")
        try assertEqual(response.id, "cmd-x")
    }

    // 9. testExecuteRouting — dispatcher forwards script to executor
    test("testExecuteRouting") {
        let mock = MockExecutor()
        mock.responseToReturn = Response.success(id: "placeholder", value: AnyCodable("script_result"))
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock
        )
        let script = "tell application \"Safari\" to return name of current tab of window 1"
        let encoded = script.replacingOccurrences(of: "\"", with: "\\\"")
        let line = "{\"id\":\"exec-1\",\"method\":\"execute\",\"params\":{\"script\":\"\(encoded)\"}}"
        let response = syncAwait {
            await dispatcher.dispatch(line: line)
        }
        try assertTrue(response.ok)
        try assertEqual(mock.lastScript, script)
        try assertEqual(response.value?.value as? String, "script_result")
    }

    // 10. testExecuteMissingScript — missing script param returns INVALID_PARAMS
    test("testExecuteMissingScript") {
        let mock = MockExecutor()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock
        )
        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"exec-bad","method":"execute","params":{}}"#)
        }
        try assertFalse(response.ok)
        try assertEqual(response.error?.code, "INVALID_PARAMS")
    }

    // 11. testLRUCacheEviction — cache evicts beyond maxCapacity entries
    test("testLRUCacheEviction") {
        let cache = LRUScriptCache(maxCapacity: 3)
        for i in 0..<3 {
            let src = "return \(i)"
            guard let script = NSAppleScript(source: src) else {
                throw TestFailure("NSAppleScript(source:) returned nil for: \(src)")
            }
            cache.insert(key: src, script: script)
        }
        try assertEqual(cache.count, 3)

        // Access "return 0" to make it recently used — "return 1" becomes LRU
        _ = cache.get(key: "return 0")

        let newSrc = "return 99"
        guard let newScript = NSAppleScript(source: newSrc) else {
            throw TestFailure("NSAppleScript(source:) returned nil for: \(newSrc)")
        }
        cache.insert(key: newSrc, script: newScript)

        try assertEqual(cache.count, 3, "Cache should remain at maxCapacity after eviction")
        try assertTrue(cache.get(key: "return 1") == nil, "LRU entry 'return 1' should have been evicted")
        try assertTrue(cache.get(key: "return 0") != nil, "Recently accessed 'return 0' should remain")
        try assertTrue(cache.get(key: "return 99") != nil, "Newly inserted 'return 99' should be present")
    }

    // 12. testExecutorErrorMapping — maps AppleScript error numbers to StructuredError codes
    test("testExecutorErrorMapping") {
        try assertEqual(appleScriptErrorCode(for: -600),  "SAFARI_NOT_RUNNING")
        try assertEqual(appleScriptErrorCode(for: -609),  "SAFARI_NOT_RUNNING")
        try assertEqual(appleScriptErrorCode(for: -1743), "PERMISSION_DENIED")
        try assertEqual(appleScriptErrorCode(for: -1728), "OBJECT_NOT_FOUND")
        try assertEqual(appleScriptErrorCode(for: -9999), "APPLESCRIPT_ERROR")
    }

    // 13. testShutdownResponse — shutdown returns ok with shutting_down value
    test("testShutdownResponse") {
        let mock = MockExecutor()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock
        )
        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"stop-1","method":"shutdown"}"#)
        }
        try assertTrue(response.ok)
        try assertEqual(response.value?.value as? String, "shutting_down")
    }

    // 14. testParseErrorReturnsUnknownID — malformed JSON gets PARSE_ERROR
    test("testParseErrorReturnsUnknownID") {
        let mock = MockExecutor()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock
        )
        let response = syncAwait {
            await dispatcher.dispatch(line: "{ not valid json !!! }")
        }
        try assertFalse(response.ok)
        try assertEqual(response.error?.code, "PARSE_ERROR")
    }

    // 15. testOutputSerializationRoundTrip — serialized ping response is valid NDJSON
    test("testOutputSerializationRoundTrip") {
        let mock = MockExecutor()
        var captured: [String] = []
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { captured.append($0) },
            executor: mock
        )
        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"out-1","method":"ping"}"#)
        }
        let serialized = try NDJSONSerializer.serialize(response: response)
        try assertFalse(serialized.contains("\n"), "Serialized line must not contain newlines")
        try assertTrue(serialized.contains("\"pong\""), "Serialized response should contain pong value")
    }
}
