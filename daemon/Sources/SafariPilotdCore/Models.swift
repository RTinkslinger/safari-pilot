import Foundation

// MARK: - AnyCodable

/// Type-erased Codable wrapper supporting String, Int, Double, Bool, and nested Dict/Array.
public struct AnyCodable: Codable, Sendable {
    public let value: Any

    public init(_ value: Any) {
        self.value = value
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else if container.decodeNil() {
            value = NSNull()
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "AnyCodable: unsupported type"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let array as [Any]:
            let wrapped = array.map { AnyCodable($0) }
            try container.encode(wrapped)
        case let dict as [String: Any]:
            let wrapped = dict.mapValues { AnyCodable($0) }
            try container.encode(wrapped)
        default:
            try container.encodeNil()
        }
    }
}

// MARK: - Command

/// Inbound command sent from the TypeScript host over NDJSON stdin.
public struct Command: Decodable, Sendable {
    public let id: String
    public let method: String
    public let params: [String: AnyCodable]

    public init(id: String, method: String, params: [String: AnyCodable] = [:]) {
        self.id = id
        self.method = method
        self.params = params
    }
}

// MARK: - StructuredError

/// Structured error payload embedded in a failed Response.
public struct StructuredError: Encodable, Sendable {
    public let code: String
    public let message: String
    public let retryable: Bool

    public init(code: String, message: String, retryable: Bool = false) {
        self.code = code
        self.message = message
        self.retryable = retryable
    }
}

// MARK: - Response

/// Outbound response emitted to the TypeScript host over NDJSON stdout.
public struct Response: Encodable, Sendable {
    public let id: String
    public let ok: Bool
    public let value: AnyCodable?
    public let error: StructuredError?
    public let elapsedMs: Double

    public init(
        id: String,
        ok: Bool,
        value: AnyCodable? = nil,
        error: StructuredError? = nil,
        elapsedMs: Double = 0
    ) {
        self.id = id
        self.ok = ok
        self.value = value
        self.error = error
        self.elapsedMs = elapsedMs
    }

    /// Convenience: successful response with an optional value.
    public static func success(id: String, value: AnyCodable? = nil, elapsedMs: Double = 0) -> Response {
        Response(id: id, ok: true, value: value, elapsedMs: elapsedMs)
    }

    /// Convenience: failure response with a structured error.
    public static func failure(id: String, error: StructuredError, elapsedMs: Double = 0) -> Response {
        Response(id: id, ok: false, error: error, elapsedMs: elapsedMs)
    }
}
