import Foundation

// MARK: - SafariRecovery

/// Wraps `AppleScriptExecutor` with exponential-backoff retry logic for Safari
/// crash / not-running conditions.
///
/// When an AppleScript execution returns error code `SAFARI_NOT_RUNNING`
/// (OSA error -600 or -609), the Safari process has crashed or is not yet ready.
/// This type implements a retry loop with exponential backoff:
///   - Attempt 1  → wait 1 s before retry
///   - Attempt 2  → wait 2 s
///   - Attempt 3  → wait 4 s
///   - Attempt 4  → wait 8 s
///   - Attempt 5  → wait 16 s  (capped at `maxBackoffSeconds`)
///
/// After `maxRetries` failed attempts the last failure response is returned.
///
/// Example:
/// ```swift
/// let recovery = SafariRecovery()
/// let response = await recovery.executeWithRecovery(
///     executor: executor,
///     script: "tell application \"Safari\" to return name of window 1"
/// )
/// ```
public final class SafariRecovery: @unchecked Sendable {

    // MARK: Configuration

    /// Upper bound on backoff delay in seconds.
    public let maxBackoffSeconds: Double

    /// Initial backoff interval in seconds (doubles each attempt).
    public let initialBackoffSeconds: Double

    // MARK: Init

    public init(initialBackoffSeconds: Double = 1.0, maxBackoffSeconds: Double = 30.0) {
        self.initialBackoffSeconds = initialBackoffSeconds
        self.maxBackoffSeconds = maxBackoffSeconds
    }

    // MARK: Public API

    /// Execute `script` via `executor`, retrying up to `maxRetries` times on
    /// recoverable Safari-not-running errors with exponential backoff.
    ///
    /// - Parameters:
    ///   - executor: The `ScriptExecutorProtocol` implementation to use.
    ///   - script: The AppleScript source to execute.
    ///   - commandID: Identifier forwarded to the executor (defaults to a UUID).
    ///   - maxRetries: Number of retry attempts before giving up (default: 5).
    /// - Returns: A `Response` — either a success or the final failure after exhausting retries.
    public func executeWithRecovery(
        executor: ScriptExecutorProtocol,
        script: String,
        commandID: String = UUID().uuidString,
        maxRetries: Int = 5
    ) async -> Response {

        var attempt = 0

        while true {
            let response = await executor.execute(script: script, commandID: commandID)

            // Success or non-recoverable error — return immediately.
            if response.ok || !isSafariNotRunning(response) {
                if attempt > 0 {
                    Logger.info("SafariRecovery: recovered after \(attempt) retries")
                }
                return response
            }

            attempt += 1

            if attempt > maxRetries {
                Logger.warning(
                    "SafariRecovery: giving up after \(maxRetries) retries " +
                    "(last error: \(response.error?.code ?? "unknown"))"
                )
                return response
            }

            // Compute backoff delay: initialBackoffSeconds * 2^(attempt-1), capped at max.
            let delay = min(
                initialBackoffSeconds * pow(2.0, Double(attempt - 1)),
                maxBackoffSeconds
            )

            Logger.warning(
                "SafariRecovery: attempt \(attempt)/\(maxRetries) — " +
                "Safari not running (error: \(response.error?.code ?? "unknown")), " +
                "retrying in \(String(format: "%.1f", delay))s"
            )

            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }

    // MARK: Private helpers

    /// Returns `true` when the response indicates Safari is not running / crashed.
    private func isSafariNotRunning(_ response: Response) -> Bool {
        guard let code = response.error?.code else { return false }
        return code == "SAFARI_NOT_RUNNING"
    }
}
