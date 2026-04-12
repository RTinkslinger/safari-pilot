import Foundation
import SafariPilotdCore

// MARK: - Mock executor for recovery tests

/// A mock executor that returns a configurable sequence of responses.
/// Used to simulate Safari-not-running errors followed by eventual success.
final class SequencedMockExecutor: ScriptExecutorProtocol, @unchecked Sendable {

    /// Responses returned in order. If exhausted, the last response is repeated.
    var responses: [Response]
    private var callIndex: Int = 0

    /// Timestamps (seconds since start) when each call was made — for backoff verification.
    var callTimestamps: [Double] = []
    private let startTime: Double = {
        var ts = timespec()
        clock_gettime(CLOCK_MONOTONIC, &ts)
        return Double(ts.tv_sec) + Double(ts.tv_nsec) / 1_000_000_000
    }()

    init(responses: [Response]) {
        self.responses = responses
    }

    func execute(script: String, commandID: String) async -> Response {
        var ts = timespec()
        clock_gettime(CLOCK_MONOTONIC, &ts)
        let now = Double(ts.tv_sec) + Double(ts.tv_nsec) / 1_000_000_000
        callTimestamps.append(now - startTime)

        let idx = min(callIndex, responses.count - 1)
        callIndex += 1
        return Response(
            id: commandID,
            ok: responses[idx].ok,
            value: responses[idx].value,
            error: responses[idx].error,
            elapsedMs: 0
        )
    }
}

// MARK: - Helper to build a Safari-not-running failure response

private func safariNotRunningResponse(id: String = "test") -> Response {
    Response.failure(
        id: id,
        error: StructuredError(code: "SAFARI_NOT_RUNNING", message: "Safari not running", retryable: true)
    )
}

// MARK: - Test registration

func registerSleepWakeMemoryRecoveryTests() {

    // 16. testMemoryWatchdogReadsRSS — checkMemory returns a positive value
    test("testMemoryWatchdogReadsRSS") {
        let watchdog = MemoryWatchdog(thresholdMB: 10_000)  // threshold way above real usage
        let (currentMB, overThreshold) = watchdog.checkMemory()
        try assertTrue(currentMB > 0, "RSS should be > 0 (got \(currentMB) MB)")
        try assertFalse(overThreshold, "Should not be over an absurdly high threshold")
    }

    // 17. testMemoryWatchdogThreshold — detects when over threshold
    test("testMemoryWatchdogThreshold") {
        var callbackFired = false
        // Set threshold to 0.001 MB (1 KB) — virtually guaranteed to be exceeded.
        let watchdog = MemoryWatchdog(thresholdMB: 0.001) {
            callbackFired = true
        }
        let (currentMB, overThreshold) = watchdog.checkMemory()
        try assertTrue(currentMB > 0, "RSS should be > 0")
        try assertTrue(overThreshold,  "Should be over a 1 KB threshold (got \(currentMB) MB)")
        try assertTrue(callbackFired,  "onThresholdExceeded should have been called")
    }

    // 18. testSafariRecoveryMaxRetries — stops after max retries
    test("testSafariRecoveryMaxRetries") {
        // All responses are Safari-not-running failures
        let allFail = Array(repeating: safariNotRunningResponse(), count: 10)
        let mockExec = SequencedMockExecutor(responses: allFail)

        // Use very short backoff so the test runs fast
        let recovery = SafariRecovery(initialBackoffSeconds: 0.001, maxBackoffSeconds: 0.01)

        let response = syncAwait {
            await recovery.executeWithRecovery(
                executor: mockExec,
                script: "test script",
                commandID: "retry-test",
                maxRetries: 3
            )
        }

        // Should have stopped: 1 initial + 3 retries = 4 total calls
        try assertFalse(response.ok, "Final response after max retries should be failure")
        try assertEqual(response.error?.code, "SAFARI_NOT_RUNNING")
        try assertEqual(mockExec.callTimestamps.count, 4,
            "Expected 1 initial + 3 retries = 4 total calls, got \(mockExec.callTimestamps.count)")
    }

    // 19. testSafariRecoveryBackoff — backoff delays increase exponentially
    test("testSafariRecoveryBackoff") {
        // 5 failures followed by success
        var responses: [Response] = Array(repeating: safariNotRunningResponse(), count: 4)
        responses.append(Response.success(id: "done", value: AnyCodable("ok")))

        let mockExec = SequencedMockExecutor(responses: responses)

        // Use 0.1 s initial backoff so intervals are large enough to measure above CI jitter
        let recovery = SafariRecovery(initialBackoffSeconds: 0.1, maxBackoffSeconds: 10.0)

        let response = syncAwait {
            await recovery.executeWithRecovery(
                executor: mockExec,
                script: "test script",
                commandID: "backoff-test",
                maxRetries: 5
            )
        }

        try assertTrue(response.ok, "Should succeed on final attempt after 4 failures")

        // Verify we made 5 calls total (4 failures + 1 success)
        let timestamps = mockExec.callTimestamps
        try assertEqual(timestamps.count, 5,
            "Expected 5 calls (4 failures + 1 success), got \(timestamps.count)")

        // Verify backoff is increasing: each gap should be larger than the previous.
        // Gap[0] = time between call 0 and call 1 (after 1st failure, wait ~0.05s)
        // Gap[1] = time between call 1 and call 2 (after 2nd failure, wait ~0.10s)
        // Gap[2] = time between call 2 and call 3 (after 3rd failure, wait ~0.20s)
        // Gap[3] = time between call 3 and call 4 (after 4th failure, wait ~0.40s)
        guard timestamps.count >= 3 else {
            throw TestFailure("Not enough timestamps to verify backoff pattern")
        }

        let gap0 = timestamps[1] - timestamps[0]
        let gap1 = timestamps[2] - timestamps[1]
        let gap2 = timestamps[3] - timestamps[2]

        // Each gap should be larger than the previous (loose tolerance for CI timing jitter).
        // With 0.1s initial and 2x exponential: gap0 ~0.1s, gap1 ~0.2s, gap2 ~0.4s.
        // Use 1.0x check (strictly increasing) to avoid flakiness from OS scheduling noise.
        try assertTrue(gap1 > gap0,
            "Gap1 (\(String(format:"%.3f",gap1))s) should be > Gap0 (\(String(format:"%.3f",gap0))s) — backoff not increasing")
        try assertTrue(gap2 > gap1,
            "Gap2 (\(String(format:"%.3f",gap2))s) should be > Gap1 (\(String(format:"%.3f",gap1))s) — backoff not increasing")
    }

    // 20. testSleepWakeMonitorStartStop — starts and stops cleanly
    test("testSleepWakeMonitorStartStop") {
        let monitor = SleepWakeMonitor()
        try assertFalse(monitor.isRunning, "Should not be running before start()")
        monitor.start()
        try assertTrue(monitor.isRunning, "Should be running after start()")
        monitor.stop()
        try assertFalse(monitor.isRunning, "Should not be running after stop()")
    }

    // 21. testSleepWakeMonitorIdempotentStart — double start is safe
    test("testSleepWakeMonitorIdempotentStart") {
        let monitor = SleepWakeMonitor()
        monitor.start()
        monitor.start()  // second call should be no-op
        try assertTrue(monitor.isRunning)
        monitor.stop()
    }

    // 22. testSafariRecoveryImmediateSuccess — no retries when first call succeeds
    test("testSafariRecoveryImmediateSuccess") {
        let mockExec = SequencedMockExecutor(
            responses: [Response.success(id: "ok", value: AnyCodable("result"))]
        )
        let recovery = SafariRecovery(initialBackoffSeconds: 0.001, maxBackoffSeconds: 0.01)

        let response = syncAwait {
            await recovery.executeWithRecovery(
                executor: mockExec,
                script: "test",
                commandID: "immediate",
                maxRetries: 5
            )
        }

        try assertTrue(response.ok, "Should succeed immediately")
        try assertEqual(mockExec.callTimestamps.count, 1, "Should make exactly 1 call")
    }
}
