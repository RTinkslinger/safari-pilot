import Foundation

// MARK: - Protocol Errors

public enum NDJSONError: Error, Sendable {
    case emptyLine
    case invalidJSON(String)
    case missingField(String)
    case emptyID
    case serializationFailed(String)
}

// MARK: - NDJSONParser

/// Parses a single NDJSON line into a Command.
/// One line = one JSON object = one command. No embedded newlines allowed.
public enum NDJSONParser {

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        return d
    }()

    /// Parse one NDJSON line into a Command.
    /// Throws NDJSONError on malformed input or constraint violations.
    public static func parseCommand(line: String) throws -> Command {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            throw NDJSONError.emptyLine
        }

        guard let data = trimmed.data(using: .utf8) else {
            throw NDJSONError.invalidJSON("Cannot encode line as UTF-8")
        }

        // First pass: verify it is valid JSON object
        guard let _ = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw NDJSONError.invalidJSON("Line is not a valid JSON object: \(trimmed)")
        }

        // Decode into raw dict to validate required fields before full decode
        let raw: [String: AnyCodable]
        do {
            raw = try decoder.decode([String: AnyCodable].self, from: data)
        } catch {
            throw NDJSONError.invalidJSON("JSON decoding failed: \(error.localizedDescription)")
        }

        // Validate `id` field presence and non-empty
        guard let idValue = raw["id"],
              let idString = idValue.value as? String else {
            throw NDJSONError.missingField("id")
        }
        guard !idString.isEmpty else {
            throw NDJSONError.emptyID
        }

        // Validate `method` field presence
        guard let methodValue = raw["method"],
              let methodString = methodValue.value as? String else {
            throw NDJSONError.missingField("method")
        }

        // Extract optional params
        let params: [String: AnyCodable]
        if let paramsValue = raw["params"],
           let paramsDict = paramsValue.value as? [String: Any] {
            params = paramsDict.mapValues { AnyCodable($0) }
        } else {
            params = [:]
        }

        return Command(id: idString, method: methodString, params: params)
    }
}

// MARK: - NDJSONSerializer

/// Serializes a Response into a single NDJSON line (no embedded newlines).
public enum NDJSONSerializer {

    /// Serialize a Response to a single JSON line with no embedded newlines.
    /// Returns the line WITHOUT a trailing newline — callers add "\n" when writing to stdout.
    public static func serialize(response: Response) throws -> String {
        // Build the dict manually to control exactly what gets serialized
        var dict: [String: Any] = [
            "id": response.id,
            "ok": response.ok,
            "elapsedMs": response.elapsedMs,
        ]

        if let value = response.value {
            dict["value"] = jsonCompatible(value.value)
        }

        if let error = response.error {
            dict["error"] = [
                "code": error.code,
                "message": error.message,
                "retryable": error.retryable,
            ] as [String: Any]
        }

        guard JSONSerialization.isValidJSONObject(dict) else {
            throw NDJSONError.serializationFailed("Response dict is not valid JSON")
        }

        let data = try JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys])
        guard var line = String(data: data, encoding: .utf8) else {
            throw NDJSONError.serializationFailed("Cannot decode serialized JSON as UTF-8")
        }

        // Hard guarantee: strip any embedded newlines produced by unusual string values
        line = line.replacingOccurrences(of: "\n", with: "\\n")
        line = line.replacingOccurrences(of: "\r", with: "\\r")

        return line
    }

    // MARK: Private helpers

    /// Recursively convert an `Any` value to a JSONSerialization-compatible type.
    private static func jsonCompatible(_ value: Any) -> Any {
        switch value {
        case let bool as Bool:
            return bool
        case let int as Int:
            return int
        case let double as Double:
            return double
        case let string as String:
            return string
        case let array as [Any]:
            return array.map { jsonCompatible($0) }
        case let dict as [String: Any]:
            return dict.mapValues { jsonCompatible($0) }
        default:
            return NSNull()
        }
    }
}
