import Foundation

/// Appends structured NDJSON trace events to ~/.safari-pilot/daemon-trace.ndjson.
/// Always-on, silent on failure. Never blocks or throws.
public enum Trace {
    private static let filePath: String = {
        let dir = NSHomeDirectory() + "/.safari-pilot"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: nil)
        return dir + "/daemon-trace.ndjson"
    }()

    private static let fileHandle: FileHandle? = {
        if !FileManager.default.fileExists(atPath: filePath) {
            FileManager.default.createFile(atPath: filePath, contents: nil)
        }
        return FileHandle(forWritingAtPath: filePath)
    }()

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Serialises file I/O across `daemon-dispatcher`, `daemon-bridge`, and
    /// `daemon-http` queue contexts that all funnel into `Trace.emit`.
    /// Without this, racing `seekToEndOfFile()` + `write()` pairs would
    /// produce lost or interleaved bytes in the NDJSON output.
    private static let queue = DispatchQueue(label: "com.safari-pilot.trace")

    public static func emit(
        _ id: String,
        layer: String,
        event: String,
        data: [String: Any] = [:],
        level: String = "event"
    ) {
        let obj: [String: Any] = [
            "ts": iso8601.string(from: Date()),
            "id": id,
            "layer": layer,
            "level": level,
            "event": event,
            "data": data
        ]
        guard let json = try? JSONSerialization.data(withJSONObject: obj),
              var line = String(data: json, encoding: .utf8) else { return }
        line += "\n"
        guard let lineData = line.data(using: .utf8) else { return }
        writeLine(lineData, to: fileHandle)
    }

    /// Append-write a complete NDJSON line. The seek-to-end and write are
    /// paired inside a serial dispatch queue so that concurrent callers from
    /// `daemon-dispatcher`, `daemon-bridge`, and `daemon-http` cannot
    /// interleave bytes within a line on the shared FileHandle.
    public static func writeLine(_ data: Data, to handle: FileHandle?) {
        queue.sync {
            handle?.seekToEndOfFile()
            handle?.write(data)
        }
    }
}
