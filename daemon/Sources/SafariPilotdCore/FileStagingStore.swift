import Foundation

public struct StagedFile: Sendable {
    public let bytes: Data
    public let mimeType: String
    public let expiresAt: Date

    public init(bytes: Data, mimeType: String, expiresAt: Date) {
        self.bytes = bytes
        self.mimeType = mimeType
        self.expiresAt = expiresAt
    }
}

/// Phase 5A · 5A.1 — actor-protected token-keyed bytes-in-memory store
/// for the file_upload feature.
///
/// GET /file-bytes/<token> → peek (does NOT remove)
/// DELETE /file-bytes/<token> → release (extension signals successful read)
/// 30s timer in SafariPilotd.start() → evictExpired (removes age > 60s)
public actor FileStagingStore {
    private var entries: [String: StagedFile] = [:]

    public init() {}

    public func stage(token: String, file: StagedFile) {
        entries[token] = file
    }

    public func peek(token: String) -> StagedFile? {
        return entries[token]
    }

    public func release(token: String) {
        entries.removeValue(forKey: token)
    }

    public func evictExpired(now: Date) -> Int {
        let beforeCount = entries.count
        entries = entries.filter { $0.value.expiresAt > now }
        return beforeCount - entries.count
    }
}
