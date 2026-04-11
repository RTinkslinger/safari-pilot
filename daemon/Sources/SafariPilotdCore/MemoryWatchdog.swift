import Foundation
import MachO

#if canImport(Darwin)
import Darwin.Mach
#endif

// MARK: - MemoryWatchdog

/// Monitors the daemon's own RSS (resident set size) using `mach_task_basic_info`.
///
/// Call `checkMemory()` periodically — on a timer or every N commands — to detect
/// excessive memory growth. When the RSS exceeds the configured threshold the watchdog
/// logs a warning and invokes the optional `onThresholdExceeded` handler so the caller
/// can take remediation steps (e.g. clearing caches).
///
/// Example:
/// ```swift
/// let watchdog = MemoryWatchdog(thresholdMB: 100) {
///     executor.cache.clear()
/// }
/// // Check every 200 commands
/// if commandCount % 200 == 0 {
///     _ = watchdog.checkMemory()
/// }
/// ```
public final class MemoryWatchdog: @unchecked Sendable {

    // MARK: Configuration

    /// RSS threshold in megabytes. Crossing this triggers logging + callback.
    public let thresholdMB: Double

    /// Optional callback invoked (on the calling thread) when RSS exceeds the threshold.
    public var onThresholdExceeded: (() -> Void)?

    // MARK: Init

    public init(thresholdMB: Double = 100, onThresholdExceeded: (() -> Void)? = nil) {
        self.thresholdMB = thresholdMB
        self.onThresholdExceeded = onThresholdExceeded
    }

    // MARK: Public API

    /// Read the current RSS of this process and compare it against the threshold.
    ///
    /// - Returns: A tuple with the current RSS in megabytes and a flag indicating
    ///   whether the threshold was exceeded.  On failure to read task info the
    ///   function returns `(0, false)` and logs an error.
    @discardableResult
    public func checkMemory() -> (currentMB: Double, overThreshold: Bool) {
        guard let rssBytes = currentRSSBytes() else {
            Logger.error("MemoryWatchdog: failed to read task basic info")
            return (0, false)
        }

        let currentMB = Double(rssBytes) / 1_048_576  // bytes → MB

        if currentMB > thresholdMB {
            Logger.warning(
                "MemoryWatchdog: RSS \(String(format: "%.1f", currentMB)) MB " +
                "exceeds threshold \(String(format: "%.0f", thresholdMB)) MB — " +
                "triggering cache eviction"
            )
            onThresholdExceeded?()
            return (currentMB, true)
        }

        Logger.debug(
            "MemoryWatchdog: RSS \(String(format: "%.1f", currentMB)) MB " +
            "(threshold \(String(format: "%.0f", thresholdMB)) MB)"
        )
        return (currentMB, false)
    }

    // MARK: Private — mach task info

    private func currentRSSBytes() -> mach_vm_size_t? {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(
            MemoryLayout<mach_task_basic_info>.size / MemoryLayout<integer_t>.size
        )

        let result: kern_return_t = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { ptr in
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), ptr, &count)
            }
        }

        guard result == KERN_SUCCESS else { return nil }
        return info.resident_size
    }
}
