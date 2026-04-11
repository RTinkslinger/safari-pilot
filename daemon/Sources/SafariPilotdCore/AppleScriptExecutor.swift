import Foundation

#if canImport(Carbon)
import Carbon
#endif

// MARK: - AppleScript Error Codes

/// Raw AppleScript / OSA error numbers mapped from `NSAppleScript` execution failures.
/// These match the TypeScript engine's error code conventions.
private enum AppleScriptErrorCode: Int {
    case safariNotRunning = -600        // Application isn't running
    case processKilled    = -609        // No process is in front
    case permissionDenied = -1743       // Not authorized to send AppleEvents
    case objectNotFound   = -1728       // Object not found / can't get
}

// MARK: - LRU Cache

/// Thread-safe LRU cache for compiled `NSAppleScript` instances.
/// Max capacity: 100 entries. Entries older than 1 hour are reaped every 100 executions.
public final class LRUScriptCache: @unchecked Sendable {

    public struct Entry {
        public let script: NSAppleScript
        public var lastUsed: Date
    }

    private let maxCapacity: Int
    private let maxAge: TimeInterval
    private var store: [String: Entry] = [:]
    /// Insertion-order key list — most-recently-used is at the end.
    private var order: [String] = []
    /// Total lifetime executions, used to trigger periodic cleanup.
    public private(set) var executionCount: Int = 0

    public init(maxCapacity: Int = 100, maxAge: TimeInterval = 3600) {
        self.maxCapacity = maxCapacity
        self.maxAge = maxAge
    }

    // MARK: Public API

    public func get(key: String) -> NSAppleScript? {
        guard var entry = store[key] else { return nil }
        entry.lastUsed = Date()
        store[key] = entry
        touch(key: key)
        return entry.script
    }

    public func insert(key: String, script: NSAppleScript) {
        if store[key] != nil {
            touch(key: key)
        } else {
            order.append(key)
        }
        store[key] = Entry(script: script, lastUsed: Date())
        evictIfNeeded()
    }

    public func recordExecution() {
        executionCount += 1
        if executionCount % 100 == 0 {
            removeExpiredEntries()
        }
    }

    /// Number of entries currently in the cache (for testing).
    public var count: Int { store.count }

    // MARK: Private helpers

    private func touch(key: String) {
        order.removeAll { $0 == key }
        order.append(key)
    }

    private func evictIfNeeded() {
        while store.count > maxCapacity {
            guard let oldest = order.first else { break }
            order.removeFirst()
            store.removeValue(forKey: oldest)
        }
    }

    private func removeExpiredEntries() {
        let cutoff = Date().addingTimeInterval(-maxAge)
        let expired = store.filter { $0.value.lastUsed < cutoff }.map { $0.key }
        for key in expired {
            store.removeValue(forKey: key)
            order.removeAll { $0 == key }
        }
    }
}

// MARK: - ScriptExecutorProtocol

/// Protocol enabling dependency injection and test mocking of the executor.
public protocol ScriptExecutorProtocol: Sendable {
    func execute(script: String, commandID: String) async -> Response
}

// MARK: - AppleScriptExecutor

/// Executes AppleScript strings via `NSAppleScript`.
///
/// - All NSAppleScript operations must run on the main thread (Cocoa requirement).
/// - Compiled scripts are cached in an LRU cache (max 100 entries).
/// - AppleScript error numbers are mapped to structured `StructuredError` codes.
public final class AppleScriptExecutor: ScriptExecutorProtocol, @unchecked Sendable {

    // Shared LRU cache — accessed only from main thread via @MainActor dispatch.
    private let cache = LRUScriptCache()

    public init() {}

    // MARK: Public API

    public func execute(script: String, commandID: String) async -> Response {
        let start = Date()
        return await withCheckedContinuation { continuation in
            DispatchQueue.main.async {
                let response = self.executeOnMain(script: script, commandID: commandID, start: start)
                continuation.resume(returning: response)
            }
        }
    }

    // MARK: Private — must only be called on main thread

    private func executeOnMain(script: String, commandID: String, start: Date) -> Response {
        dispatchPrecondition(condition: .onQueue(.main))

        cache.recordExecution()

        // Retrieve cached compiled script or compile fresh
        let appleScript: NSAppleScript
        if let cached = cache.get(key: script) {
            appleScript = cached
        } else {
            guard let compiled = NSAppleScript(source: script) else {
                return Response.failure(
                    id: commandID,
                    error: StructuredError(
                        code: "SCRIPT_COMPILE_FAILED",
                        message: "NSAppleScript could not be initialised with the given source",
                        retryable: false
                    ),
                    elapsedMs: elapsed(since: start)
                )
            }
            cache.insert(key: script, script: compiled)
            appleScript = compiled
        }

        // Execute
        var errorDict: NSDictionary?
        let descriptor: NSAppleEventDescriptor = appleScript.executeAndReturnError(&errorDict)

        let elapsedMs = elapsed(since: start)

        if let errorInfo = errorDict {
            return Response.failure(
                id: commandID,
                error: mapAppleScriptError(errorInfo),
                elapsedMs: elapsedMs
            )
        }

        // Extract result string (best-effort). stringValue is nil when the
        // descriptor has no string coercion (e.g. void return) — treat as empty.
        let resultValue = AnyCodable(descriptor.stringValue ?? "")

        return Response.success(id: commandID, value: resultValue, elapsedMs: elapsedMs)
    }

    // MARK: Error mapping

    private func mapAppleScriptError(_ info: NSDictionary) -> StructuredError {
        let message = (info[NSAppleScript.errorMessage] as? String)
            ?? (info["NSAppleScriptErrorMessage"] as? String)
            ?? "Unknown AppleScript error"
        let number = (info[NSAppleScript.errorNumber] as? Int)
            ?? (info["NSAppleScriptErrorNumber"] as? Int)
            ?? 0

        let (code, retryable) = errorCodeAndRetryable(for: number)
        return StructuredError(code: code, message: message, retryable: retryable)
    }

    private func errorCodeAndRetryable(for number: Int) -> (String, Bool) {
        switch number {
        case AppleScriptErrorCode.safariNotRunning.rawValue:
            return ("SAFARI_NOT_RUNNING", true)
        case AppleScriptErrorCode.processKilled.rawValue:
            return ("SAFARI_NOT_RUNNING", true)
        case AppleScriptErrorCode.permissionDenied.rawValue:
            return ("PERMISSION_DENIED", false)
        case AppleScriptErrorCode.objectNotFound.rawValue:
            return ("OBJECT_NOT_FOUND", false)
        default:
            return ("APPLESCRIPT_ERROR", false)
        }
    }

    // MARK: Helpers

    private func elapsed(since start: Date) -> Double {
        Date().timeIntervalSince(start) * 1000
    }
}

// MARK: - Error Code Mapping (Public for Tests)

/// Maps a raw AppleScript error number to the corresponding StructuredError code string.
/// Extracted as a free function so tests can verify mapping without needing a real executor.
public func appleScriptErrorCode(for number: Int) -> String {
    switch number {
    case -600, -609:
        return "SAFARI_NOT_RUNNING"
    case -1743:
        return "PERMISSION_DENIED"
    case -1728:
        return "OBJECT_NOT_FOUND"
    default:
        return "APPLESCRIPT_ERROR"
    }
}
