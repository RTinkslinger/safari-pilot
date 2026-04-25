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

// MARK: - Test HealthStore helper

/// Fresh HealthStore pointing at a unique tmp path — avoids persisted state
/// leaking between tests and keeps each dispatcher instance isolated.
func makeHealthStoreForTest() -> HealthStore {
    let path = FileManager.default.temporaryDirectory
        .appendingPathComponent("test-health-\(UUID().uuidString).json")
    return HealthStore(persistPath: path)
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
            executor: mock,
            healthStore: makeHealthStoreForTest()
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
            executor: mock,
            healthStore: makeHealthStoreForTest()
        )
        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"cmd-x","method":"doesNotExist"}"#)
        }
        try assertFalse(response.ok)
        try assertEqual(response.error?.code, "UNKNOWN_METHOD")
        try assertEqual(response.id, "cmd-x")
    }

    // 9. testExecuteRouting — dispatcher forwards script to executor.
    //
    // SD-19 strengthening: the prior assertion `response.value == "script_result"`
    // was self-fulfilling — the mock was pre-configured to return that exact
    // value, so the assertion proved only that the test plumbing worked, not
    // that the dispatcher actually forwarded anything. Two real behavioural
    // claims remain:
    //   (1) `mock.lastScript == script` — the dispatcher must have CALLED
    //       executor.execute with the unescaped script string. The dispatcher
    //       is responsible for the JSON-string → Swift-string decoding;
    //       the mock just records what arrived. Load-bearing.
    //   (2) `response.id == "exec-1"` — the dispatcher must have forwarded
    //       `command.id` (the inbound NDJSON id) as the executor's commandID,
    //       which the mock reflects back via its own `Response(id: commandID, ...)`
    //       constructor (CommandDispatcherTests.swift:14). A regression that
    //       passed a hardcoded literal or empty string instead of `command.id`
    //       to executor.execute would fail this.
    //
    // Initial SD-19 attempt added `response.elapsedMs >= 0` as a third oracle.
    // Reviewer flagged as CRITICAL tautology: Response.elapsedMs is non-optional
    // Double (defaults to 0); the mock explicitly sets elapsedMs:0; the
    // dispatcher's execute route returns `await executor.execute(...)` directly
    // and does NOT populate elapsedMs at this layer (AppleScriptExecutor does,
    // but it's mocked out here). Removed.
    test("testExecuteRouting") {
        let mock = MockExecutor()
        mock.responseToReturn = Response.success(id: "placeholder", value: AnyCodable("script_result"))
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            healthStore: makeHealthStoreForTest()
        )
        let script = "tell application \"Safari\" to return name of current tab of window 1"
        let encoded = script.replacingOccurrences(of: "\"", with: "\\\"")
        let line = "{\"id\":\"exec-1\",\"method\":\"execute\",\"params\":{\"script\":\"\(encoded)\"}}"
        let response = syncAwait {
            await dispatcher.dispatch(line: line)
        }
        try assertTrue(response.ok)
        try assertEqual(mock.lastScript, script,
                        "dispatcher must forward the unescaped script string to executor.execute "
                            + "(this is the actual behavioural claim)")
        try assertEqual(response.id, "exec-1",
                        "dispatcher must forward command.id as executor.execute(commandID:); "
                            + "the mock reflects this back via Response(id: commandID, ...). "
                            + "A regression passing a hardcoded literal or empty string would fail.")
    }

    // 10. testExecuteMissingScript — missing script param returns INVALID_PARAMS
    test("testExecuteMissingScript") {
        let mock = MockExecutor()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            healthStore: makeHealthStoreForTest()
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
            executor: mock,
            healthStore: makeHealthStoreForTest()
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
            executor: mock,
            healthStore: makeHealthStoreForTest()
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
            executor: mock,
            healthStore: makeHealthStoreForTest()
        )
        let response = syncAwait {
            await dispatcher.dispatch(line: #"{"id":"out-1","method":"ping"}"#)
        }
        let serialized = try NDJSONSerializer.serialize(response: response)
        try assertFalse(serialized.contains("\n"), "Serialized line must not contain newlines")
        try assertTrue(serialized.contains("\"pong\""), "Serialized response should contain pong value")
    }

    // MARK: - SD-16: watch_download / generate_pdf / internal-method coverage

    // SD-16/T1: dispatcher routes `watch_download` → executes through DownloadWatcher
    // → returns DOWNLOAD_TIMEOUT when no download arrives within the timeout window.
    // Discrimination: deleting `case "watch_download":` makes the dispatcher hit
    // default → UNKNOWN_METHOD. Deleting the `DownloadError.timeout` catch arm
    // makes the test fall through to DOWNLOAD_ERROR (catch-all). Both surface here.
    test("testDispatcherRoutesWatchDownloadAndReturnsTimeoutOnNoDownload") {
        let mock = MockExecutor()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            healthStore: makeHealthStoreForTest()
        )

        // Short timeout (200.5ms) so the test completes promptly. NOTE the
        // fractional value: `AnyCodable` decodes integral JSON literals as Int
        // first, then Double. The SUT casts via `as? Double` which fails on
        // Int and falls back to 30000ms. Using 200.5 forces Double decoding
        // and a real 200.5ms timeout. (This is a mild SUT smell — out of scope
        // for SD-16; tracked implicitly by the fact that test author had to
        // discover the AnyCodable Int-first decoder behaviour.)
        // Default download dir is ~/Downloads on macOS, resolved via
        // `defaults read com.apple.Safari DownloadsPath` with ~/Downloads
        // fallback (DownloadWatcher.swift:167-193). On any standard macOS
        // box ~/Downloads exists, so init succeeds and we reach watch() timeout.
        let response = syncAwait {
            await dispatcher.dispatch(
                line: #"{"id":"wd-1","method":"watch_download","params":{"timeout":200.5}}"#
            )
        }
        try assertFalse(response.ok,
                        "watch_download with no actual download must fail with a timeout")
        try assertEqual(response.error?.code, "DOWNLOAD_TIMEOUT",
                        "expected DOWNLOAD_TIMEOUT, got \(response.error?.code ?? "<nil>")")
        try assertEqual(response.error?.retryable, true,
                        "DOWNLOAD_TIMEOUT must be marked retryable per the SUT contract")
        // Reviewer ADVISORY (SD-16): assert elapsedMs is in a plausible band
        // for the configured 200.5ms timeout. Catches a regression that
        // early-returns DOWNLOAD_TIMEOUT before actually waiting.
        try assertTrue(
            response.elapsedMs >= 150 && response.elapsedMs < 5000,
            "elapsedMs must be roughly proportional to the 200.5ms timeout; "
                + "got \(response.elapsedMs)ms"
        )
    }

    // SD-16: generate_pdf coverage was originally planned here (T2-T4 covering
    // the three INVALID_OUTPUT_PATH guards in PdfGenerator.init), but exercising
    // PdfGenerator from `syncAwait { await dispatcher.dispatch(...) }` deadlocks
    // the test process. SD-25 attempted option (a) — pre-load WebKit at main.swift
    // startup via `_ = WKWebView.self`. Empirically confirmed (2026-04-25): does
    // NOT fix the deadlock. Hypothesis revised: the deadlock is more likely
    // partial-init NSObject deallocation (PdfGenerator's `throw` at lines
    // 88/103/110 fires BEFORE `super.init()` at line 149) than WebKit framework
    // lazy-load. SD-25 remains open with refined remediation paths captured in
    // FOLLOW-UPS. T1 (watch_download) and T5 (internal-method routing) remain
    // in this batch.

    // SD-16/T5: dispatcher's internal command sentinel
    // (`__SAFARI_PILOT_INTERNAL__ <method>`) routes through handleInternalCommand
    // → unknown internal method must return UNKNOWN_INTERNAL_METHOD. Discrimination:
    // deleting handleInternalCommand's default branch (line 230-238) makes any
    // unknown method silently succeed or hang.
    test("testDispatcherInternalCommandUnknownMethodReturnsUnknownInternalMethod") {
        let mock = MockExecutor()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            healthStore: makeHealthStoreForTest()
        )

        // execute → __SAFARI_PILOT_INTERNAL__ <unknown> route flow:
        //   1. dispatch → handle(command:) → case "execute"
        //   2. script starts with `__SAFARI_PILOT_INTERNAL__ ` → handleInternalCommand
        //   3. method == "absolute_garbage_method" → default → UNKNOWN_INTERNAL_METHOD
        let line = #"{"id":"int-1","method":"execute","params":{"script":"__SAFARI_PILOT_INTERNAL__ absolute_garbage_method"}}"#
        let response = syncAwait { await dispatcher.dispatch(line: line) }

        try assertFalse(response.ok,
                        "unknown internal method must fail")
        try assertEqual(response.error?.code, "UNKNOWN_INTERNAL_METHOD",
                        "internal sentinel with unknown method must return "
                            + "UNKNOWN_INTERNAL_METHOD; got \(response.error?.code ?? "<nil>")")
        try assertEqual(response.error?.retryable, false,
                        "UNKNOWN_INTERNAL_METHOD must be non-retryable")
    }
}
