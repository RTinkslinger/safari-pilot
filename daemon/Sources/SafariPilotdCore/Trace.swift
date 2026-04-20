import Foundation

/// Appends structured NDJSON trace events to ~/.safari-pilot/daemon-trace.ndjson.
/// Always-on, silent on failure. Never blocks or throws.
enum Trace {
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

    static func emit(
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
        fileHandle?.seekToEndOfFile()
        fileHandle?.write(lineData)
    }
}
