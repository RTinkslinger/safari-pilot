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

        // Short timeout (200ms) so the test completes promptly. SD-26 fixed
        // the Int-vs-Double coercion bug — integer JSON literals like
        // `"timeout":200` now correctly map to a 200ms timeout instead of
        // silently falling back to the 30s default.
        // Default download dir is ~/Downloads on macOS, resolved via
        // `defaults read com.apple.Safari DownloadsPath` with ~/Downloads
        // fallback (DownloadWatcher.swift:167-193). On any standard macOS
        // box ~/Downloads exists, so init succeeds and we reach watch() timeout.
        let response = syncAwait {
            await dispatcher.dispatch(
                line: #"{"id":"wd-1","method":"watch_download","params":{"timeout":200}}"#
            )
        }
        try assertFalse(response.ok,
                        "watch_download with no actual download must fail with a timeout")
        try assertEqual(response.error?.code, "DOWNLOAD_TIMEOUT",
                        "expected DOWNLOAD_TIMEOUT, got \(response.error?.code ?? "<nil>")")
        try assertEqual(response.error?.retryable, true,
                        "DOWNLOAD_TIMEOUT must be marked retryable per the SUT contract")
        // Reviewer ADVISORY (SD-16): elapsedMs band catches a regression that
        // early-returns DOWNLOAD_TIMEOUT before actually waiting. SD-26
        // strengthens this further: a regression that drops the SD-26
        // numericToDouble helper would let the Int 200 cast to nil → fallback
        // to 30000ms, putting elapsedMs around 30000ms — well outside the
        // [150, 5000) band → fails the assertion. So this oracle now also
        // discriminates the SD-26 fix.
        try assertTrue(
            response.elapsedMs >= 150 && response.elapsedMs < 5000,
            "elapsedMs must be roughly proportional to the 200ms timeout; "
                + "got \(response.elapsedMs)ms — if ~30000ms, the SD-26 "
                + "Int-vs-Double fix has regressed."
        )
    }

    // SD-16 generate_pdf coverage. Originally deferred to SD-25 due to test
    // deadlock. SD-25(a) — pre-load WebKit — empirically rejected. SD-25(d) —
    // refactor PdfGenerator.init to a static factory pattern (`create(params:)`
    // does validation BEFORE any instance exists; private non-throwing init
    // calls super.init() AFTER all stored properties are assigned) — this is
    // the fix that should unblock the tests if the partial-deinit hypothesis
    // is right. Restored T2/T3/T4 here. If they pass, SD-25 is closed.

    // SD-16/T2 (restored by SD-25): dispatcher routes generate_pdf →
    // PdfGenerator.create throws invalidOutputPath when neither html nor
    // url is provided.
    test("testDispatcherGeneratePdfMissingHtmlAndUrlReturnsInvalidOutputPath") {
        let mock = MockExecutor()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            healthStore: makeHealthStoreForTest()
        )

        let response = syncAwait {
            await dispatcher.dispatch(
                line: #"{"id":"pdf-1","method":"generate_pdf","params":{"outputPath":"/tmp/safari-pilot-pdf-test.pdf"}}"#
            )
        }
        try assertFalse(response.ok)
        try assertEqual(response.error?.code, "INVALID_OUTPUT_PATH",
                        "missing html+url must return INVALID_OUTPUT_PATH")
        try assertTrue(
            (response.error?.message ?? "").contains("html") || (response.error?.message ?? "").contains("url"),
            "error message must reference the missing html/url guard; got \"\(response.error?.message ?? "")\""
        )
    }

    test("testDispatcherGeneratePdfMissingOutputPathReturnsInvalidOutputPath") {
        let mock = MockExecutor()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            healthStore: makeHealthStoreForTest()
        )

        let response = syncAwait {
            await dispatcher.dispatch(
                line: #"{"id":"pdf-2","method":"generate_pdf","params":{"html":"<html><body>x</body></html>"}}"#
            )
        }
        try assertFalse(response.ok)
        try assertEqual(response.error?.code, "INVALID_OUTPUT_PATH",
                        "missing outputPath must return INVALID_OUTPUT_PATH")
        try assertTrue(
            (response.error?.message ?? "").contains("outputPath"),
            "error message must reference the outputPath guard; got \"\(response.error?.message ?? "")\""
        )
    }

    test("testDispatcherGeneratePdfNonexistentParentDirReturnsInvalidOutputPath") {
        let mock = MockExecutor()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            healthStore: makeHealthStoreForTest()
        )

        let nonexistent = "/tmp/sd25-nonexistent-\(UUID().uuidString)"
        let outputPath = "\(nonexistent)/output.pdf"

        let line = """
        {"id":"pdf-3","method":"generate_pdf","params":{"html":"<html><body>x</body></html>","outputPath":"\(outputPath)"}}
        """
        let response = syncAwait { await dispatcher.dispatch(line: line) }

        try assertFalse(response.ok)
        try assertEqual(response.error?.code, "INVALID_OUTPUT_PATH",
                        "non-existent parent dir must return INVALID_OUTPUT_PATH")
        try assertTrue(
            (response.error?.message ?? "").contains("Parent directory"),
            "error message must reference the parent-directory guard; got \"\(response.error?.message ?? "")\""
        )
    }

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

    // MARK: - SD-27: handleInternalCommand happy-path coverage
    //
    // The OUTER dispatcher cases (extension_status / extension_execute /
    // extension_health at CommandDispatcher.swift:170/161/195) ARE tested
    // (testDispatcherExtensionStatusCommand, testDispatcherRoutesExtensionExecuteQueuesCommand,
    // testExtensionHealthReturnsComposite — all in ExtensionBridgeTests.swift).
    //
    // The INNER routes via `__SAFARI_PILOT_INTERNAL__ <method>` script
    // (CommandDispatcher.swift:224-254, used in production by ExtensionEngine)
    // are NOT tested. SD-16's T5 covers the `default → UNKNOWN_INTERNAL_METHOD`
    // branch, but the three happy paths are uncovered. A copy-paste regression
    // in any of the three case branches (e.g. wiring `extension_status` to
    // `handleExecute`) would not fail any existing test.
    //
    // Discriminator (verified by mutation testing during SD-27 development):
    // swapping any one of the three case branches in handleInternalCommand to
    // call a different handler causes ONLY the matching test below to fail —
    // each test uniquely identifies its target branch.

    // SD-27 / Test 1: extension_status route through `__SAFARI_PILOT_INTERNAL__`
    // exercises CommandDispatcher.swift:238-239. Two phases discriminate against
    // a hardcoded `"disconnected"` regression (per advisor): default state must
    // surface "disconnected"; after `bridge.handleConnected`, the same route
    // must surface "connected". A regression returning a literal "disconnected"
    // would pass phase 1 but fail phase 2.
    test("testDispatcherInternalCommandRoutesExtensionStatus") {
        let mock = MockExecutor()
        let bridge = ExtensionBridge()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            extensionBridge: bridge,
            healthStore: makeHealthStoreForTest()
        )

        // Phase 1: default state → handleStatus returns "disconnected"
        let line1 = #"{"id":"int-status-1","method":"execute","params":{"script":"__SAFARI_PILOT_INTERNAL__ extension_status"}}"#
        let resp1 = syncAwait { await dispatcher.dispatch(line: line1) }
        try assertTrue(resp1.ok,
                       "internal extension_status must succeed; got error: \(resp1.error?.message ?? "<nil>")")
        try assertEqual(resp1.id, "int-status-1",
                        "dispatch response id must echo the inbound NDJSON id")
        try assertEqual(resp1.value?.value as? String, "disconnected",
                        "internal extension_status when bridge is fresh must return \"disconnected\"")

        // Phase 2: flip bridge to connected → handleStatus must now return "connected".
        // This rules out a regression that hardcodes "disconnected" (e.g. the
        // case branch was deleted and dispatcher fell through to a literal).
        _ = bridge.handleConnected(commandID: "ext-conn-1")
        let line2 = #"{"id":"int-status-2","method":"execute","params":{"script":"__SAFARI_PILOT_INTERNAL__ extension_status"}}"#
        let resp2 = syncAwait { await dispatcher.dispatch(line: line2) }
        try assertTrue(resp2.ok)
        try assertEqual(resp2.value?.value as? String, "connected",
                        "internal extension_status after handleConnected must return \"connected\" "
                            + "(rules out hardcoded-string regression)")
    }

    // SD-27 / Test 2: extension_execute route through `__SAFARI_PILOT_INTERNAL__`
    // exercises CommandDispatcher.swift:240-241. Asserts not just that the
    // command lands in pendingCommands, but that the JSON-parsed inner params
    // round-trip from the script remainder — locks the JSON-parse path
    // (CommandDispatcher.swift:232-235) too, not just the case-branch
    // dispatch. tabUrl is a non-script param chosen for parity with SD-14's
    // testDispatcherRoutesExtensionExecuteQueuesCommand.
    test("testDispatcherInternalCommandRoutesExtensionExecute") {
        let mock = MockExecutor()
        let bridge = ExtensionBridge()
        let dispatcher = CommandDispatcher(
            lineSource: { nil },
            outputSink: { _ in },
            executor: mock,
            extensionBridge: bridge,
            healthStore: makeHealthStoreForTest()
        )

        // Drive __SAFARI_PILOT_INTERNAL__ extension_execute in a Task — handleExecute
        // suspends until a result arrives. The inner JSON has no spaces, so the
        // dispatcher's split-on-first-space + JSONSerialization.jsonObject path
        // can recover the params dict cleanly.
        let dispatchTask = Task {
            await dispatcher.dispatch(
                line: #"{"id":"int-exec-1","method":"execute","params":{"script":"__SAFARI_PILOT_INTERNAL__ extension_execute {\"script\":\"document.title\",\"tabUrl\":\"https://example.com\"}"}}"#
            )
        }
        Thread.sleep(forTimeInterval: 0.15)

        // Verify the command landed in the bridge by polling.
        let pollResp = syncAwait { await bridge.handlePoll(commandID: "p-int") }
        let pollDict = pollResp.value?.value as? [String: Any]
        let cmds = pollDict?["commands"] as? [[String: Any]] ?? []
        try assertEqual(cmds.count, 1,
                        "extension_execute via __SAFARI_PILOT_INTERNAL__ must land in bridge.pendingCommands; "
                            + "got \(cmds.count) command(s)")
        try assertEqual(cmds.first?["id"] as? String, "int-exec-1",
                        "polled command id must match the dispatched NDJSON id, not the bridge sentinel")
        try assertEqual(cmds.first?["script"] as? String, "document.title",
                        "polled command script param must round-trip from inner JSON")
        try assertEqual(cmds.first?["tabUrl"] as? String, "https://example.com",
                        "polled command tabUrl param must round-trip from inner JSON "
                            + "(locks general params-dict round-trip beyond \"script\")")

        // Cleanup: feed the result so the suspended dispatch resolves.
        _ = bridge.handleResult(
            commandID: "cleanup-int-exec",
            params: [
                "requestId": AnyCodable("int-exec-1"),
                "result": AnyCodable(["ok": true, "value": "Test"]),
            ]
        )
        let dispatchResp = syncAwait { await dispatchTask.value }
        try assertTrue(dispatchResp.ok,
                       "dispatch of __SAFARI_PILOT_INTERNAL__ extension_execute must succeed after result arrives")
    }

    // SD-27 / Test 3: extension_health route through `__SAFARI_PILOT_INTERNAL__`
    // exercises CommandDispatcher.swift:242-244. Mirrors testExtensionHealthReturnsComposite
    // (ExtensionBridgeTests.swift:365) but via the INTERNAL route. Counters are
    // pre-incremented so the assertions discriminate against a regression that
    // returns a hardcoded skeleton dict — only a real call to healthSnapshot
    // can surface the post-increment values.
    test("testDispatcherInternalCommandRoutesExtensionHealth") {
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

        // Pre-increment so the assertions can't pass against a hardcoded
        // skeleton — only a live healthSnapshot call surfaces these values.
        health.incrementRoundtrip()
        health.incrementTimeout()

        let line = #"{"id":"int-health-1","method":"execute","params":{"script":"__SAFARI_PILOT_INTERNAL__ extension_health"}}"#
        let response = syncAwait { await dispatcher.dispatch(line: line) }

        try assertTrue(response.ok,
                       "internal extension_health must succeed; got error: \(response.error?.message ?? "<nil>")")
        try assertEqual(response.id, "int-health-1",
                        "dispatch response id must echo the inbound NDJSON id")
        let dict = response.value?.value as? [String: Any]
        try assertTrue(dict != nil,
                       "internal extension_health value must be a dict (snapshot); "
                           + "got \(String(describing: response.value?.value))")
        try assertEqual(dict?["roundtripCount1h"] as? Int, 1,
                        "snapshot must reflect the pre-incremented roundtrip counter "
                            + "(rules out hardcoded-skeleton regression)")
        try assertEqual(dict?["timeoutCount1h"] as? Int, 1,
                        "snapshot must reflect the pre-incremented timeout counter")
        try assertEqual(dict?["isConnected"] as? Bool, false,
                        "snapshot must include bridge state — fresh bridge is disconnected")
        try assertEqual(dict?["pendingCommandsCount"] as? Int, 0,
                        "snapshot must include bridge pendingCommandsCount")
    }

    // MARK: - T25: shutdown detection (substring trap fix)
    //
    // Pre-T25 the run loop used `trimmed.contains("\"shutdown\"")` on the
    // raw NDJSON line. Page content, execute-script bodies, or any other
    // NDJSON payload containing the literal string `"shutdown"` would
    // trigger `exit(0)` even if the command's actual method was something
    // else. The fix: parse the line and compare `command.method` against
    // the literal string "shutdown".
    //
    // We can't test the run loop directly (it calls exit(0) which kills
    // the test process), so the discrimination is encoded on the static
    // helper `CommandDispatcher.isShutdownLine(_:)` that the run loop
    // delegates to.

    test("testIsShutdownLineReturnsTrueForRealShutdownCommand") {
        let line = #"{"id":"sd-1","method":"shutdown"}"#
        try assertTrue(
            CommandDispatcher.isShutdownLine(line),
            "isShutdownLine must return true for a real shutdown NDJSON command"
        )
    }

    test("testIsShutdownLineReturnsFalseWhenShutdownStringAppearsInJsonValue") {
        // Discrimination target: src/CommandDispatcher.swift:72 (pre-T25,
        // `trimmed.contains("\"shutdown\"")`). The execute command below
        // uses the literal string `"shutdown"` as the command id (a
        // realistic attack/bug surface — any user-controlled JSON value
        // could legitimately be the word "shutdown" in quotes). Pre-T25
        // the raw-line substring check would fire and exit the daemon.
        // Post-T25 the parser sees `method == "execute"` and returns false.
        let line = #"{"id":"shutdown","method":"execute","params":{"script":"return 1;"}}"#
        try assertFalse(
            CommandDispatcher.isShutdownLine(line),
            "isShutdownLine must NOT return true when the literal substring \"shutdown\" "
                + "appears as a JSON VALUE elsewhere in the line (id, params, etc.); "
                + "production run loop would otherwise exit on benign user input"
        )
    }

    test("testIsShutdownLineReturnsFalseForMalformedNDJSON") {
        // Defensive: malformed JSON must not crash; parse failure returns
        // false (the run loop's safe default — keep running).
        let line = "this is not JSON at all"
        try assertFalse(
            CommandDispatcher.isShutdownLine(line),
            "isShutdownLine must return false for unparseable lines (no exit on garbage)"
        )
    }
}
