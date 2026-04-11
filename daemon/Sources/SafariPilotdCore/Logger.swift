import Foundation

// MARK: - Log Level

public enum LogLevel: String, Sendable {
    case debug = "DEBUG"
    case info = "INFO"
    case warning = "WARNING"
    case error = "ERROR"
}

// MARK: - Logger

/// Structured logger that writes to stderr (stdout is reserved for the NDJSON protocol).
/// All messages are prefixed with an ISO 8601 timestamp and log level.
public enum Logger {

    // ISO 8601 formatter — created once, reused (DateFormatter is expensive to init).
    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    // MARK: Public API

    public static func debug(_ message: String, file: String = #file, function: String = #function, line: Int = #line) {
        log(level: .debug, message: message)
    }

    public static func info(_ message: String) {
        log(level: .info, message: message)
    }

    public static func warning(_ message: String) {
        log(level: .warning, message: message)
    }

    public static func error(_ message: String) {
        log(level: .error, message: message)
    }

    // MARK: Private

    private static func log(level: LogLevel, message: String) {
        let timestamp = iso8601.string(from: Date())
        let line = "[\(timestamp)] [\(level.rawValue)] \(message)\n"
        // Write directly to stderr — never stdout (which carries the NDJSON stream).
        let standardError = FileHandle.standardError
        standardError.write(Data(line.utf8))
    }
}
