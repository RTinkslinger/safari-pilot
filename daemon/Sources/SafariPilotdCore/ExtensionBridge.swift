import Foundation

// MARK: - ExtensionBridge

/// Manages file-based IPC between the daemon and the Safari web extension.
///
/// The bridge uses a shared directory (`~/.safari-pilot/bridge/`) for communication:
/// - `commands/` — daemon writes command files, extension reads and deletes them
/// - `results/`  — extension writes result files, daemon reads and deletes them
///
/// Flow:
/// 1. MCP server calls `handleExecute(commandID:params:)` on the bridge.
/// 2. Bridge writes a command JSON to `commands/{id}.json`.
/// 3. Bridge polls `results/{id}.json` until the extension writes it (or timeout).
/// 4. Bridge reads the result, deletes the file, and returns the response.
///
/// Connection state is inferred by checking recency of result files.
public final class ExtensionBridge: @unchecked Sendable {

    // MARK: - Constants

    /// How frequently to poll for a result file (in seconds).
    private static let pollInterval: TimeInterval = 0.05  // 50ms

    /// Default timeout waiting for a result (in seconds).
    private static let defaultTimeout: TimeInterval = 30.0

    /// A result file newer than this threshold means the extension is active.
    private static let activityThreshold: TimeInterval = 60.0

    // MARK: - Paths

    private let bridgeBase: URL
    private let commandsDir: URL
    private let resultsDir: URL

    // MARK: - State

    /// Thread-safety lock — all mutations go through this queue.
    private let queue = DispatchQueue(label: "com.safari-pilot.extension-bridge", qos: .userInitiated)

    private var _isConnected: Bool = false

    /// Keyed by the original commandID from the MCP-side "extension_execute" command.
    /// Kept for backward compatibility with tests that use the continuation-based flow.
    private struct PendingRequest {
        let commandID: String
        let continuation: CheckedContinuation<Response, Never>
    }
    private var _pending: [String: PendingRequest] = [:]

    // MARK: - Public API

    /// Whether the Safari extension is currently connected (based on explicit signal or file activity).
    public var isExtensionConnected: Bool {
        queue.sync { _isConnected }
    }

    public init() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        self.bridgeBase = home.appendingPathComponent(".safari-pilot/bridge")
        self.commandsDir = bridgeBase.appendingPathComponent("commands")
        self.resultsDir = bridgeBase.appendingPathComponent("results")
        ensureDirectoriesExist()
    }

    /// Test-only initializer that accepts a custom bridge directory.
    public init(bridgeDirectory: URL) {
        self.bridgeBase = bridgeDirectory
        self.commandsDir = bridgeDirectory.appendingPathComponent("commands")
        self.resultsDir = bridgeDirectory.appendingPathComponent("results")
        ensureDirectoriesExist()
    }

    // MARK: - Command Handlers

    /// Mark the extension as connected. Returns an acknowledgement response.
    public func handleConnected(commandID: String) -> Response {
        queue.sync { _isConnected = true }
        Logger.info("Extension connected.")
        return Response.success(id: commandID, value: AnyCodable("extension_ack"))
    }

    /// Mark the extension as disconnected. Rejects any pending requests. Returns an acknowledgement.
    public func handleDisconnected(commandID: String) -> Response {
        let pending: [PendingRequest] = queue.sync {
            _isConnected = false
            let p = Array(_pending.values)
            _pending.removeAll()
            return p
        }
        Logger.info("Extension disconnected. Cancelling \(pending.count) pending request(s).")
        for req in pending {
            let err = Response.failure(
                id: req.commandID,
                error: StructuredError(
                    code: "EXTENSION_DISCONNECTED",
                    message: "Safari extension disconnected while request was pending",
                    retryable: true
                )
            )
            req.continuation.resume(returning: err)
        }
        return Response.success(id: commandID, value: AnyCodable("extension_ack"))
    }

    /// Route an extension result back to a waiting "extension_execute" caller.
    /// Supports both file-based results and continuation-based pending requests.
    public func handleResult(commandID: String, params: [String: AnyCodable]) -> Response {
        guard let reqIDValue = params["requestId"],
              let reqID = reqIDValue.value as? String else {
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "INVALID_PARAMS",
                    message: "extension_result requires a \"requestId\" string parameter",
                    retryable: false
                )
            )
        }

        let pending: PendingRequest? = queue.sync { _pending.removeValue(forKey: reqID) }
        guard let req = pending else {
            return Response.success(id: commandID, value: AnyCodable("extension_ack"))
        }

        let resultValue: AnyCodable
        if let resultParam = params["result"] {
            resultValue = resultParam
        } else {
            resultValue = AnyCodable("")
        }

        let callerResponse: Response
        if let errorParam = params["error"],
           let errorMsg = errorParam.value as? String {
            callerResponse = Response.failure(
                id: req.commandID,
                error: StructuredError(
                    code: "EXTENSION_ERROR",
                    message: errorMsg,
                    retryable: true
                )
            )
        } else {
            callerResponse = Response.success(id: req.commandID, value: resultValue)
        }

        req.continuation.resume(returning: callerResponse)
        return Response.success(id: commandID, value: AnyCodable("extension_ack"))
    }

    /// Execute a command via file-based IPC.
    ///
    /// Writes the command to `commands/{commandID}.json`, then polls `results/{commandID}.json`
    /// until the extension processes it or the timeout elapses.
    ///
    /// Falls back to continuation-based flow when extension is connected via the legacy path.
    public func handleExecute(commandID: String, params: [String: AnyCodable]) async -> Response {
        // Validate params
        guard let scriptParam = params["script"],
              let _ = scriptParam.value as? String else {
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "INVALID_PARAMS",
                    message: "extension_execute requires a \"script\" string parameter",
                    retryable: false
                )
            )
        }

        // Write command file for the extension to pick up
        let writeResult = writeCommandFile(commandID: commandID, params: params)
        guard writeResult else {
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "BRIDGE_WRITE_FAILED",
                    message: "Failed to write command file to bridge directory",
                    retryable: true
                )
            )
        }

        // Poll for the result file
        let timeout = Self.defaultTimeout
        let start = Date()

        while Date().timeIntervalSince(start) < timeout {
            if let response = readResultFile(commandID: commandID) {
                return response
            }
            // Sleep briefly before next poll
            try? await Task.sleep(nanoseconds: UInt64(Self.pollInterval * 1_000_000_000))
        }

        // Clean up the command file if it's still there (extension never picked it up)
        cleanupCommandFile(commandID: commandID)

        return Response.failure(
            id: commandID,
            error: StructuredError(
                code: "EXTENSION_TIMEOUT",
                message: "Extension did not respond within \(Int(timeout))s",
                retryable: true
            )
        )
    }

    /// Return connection status. Checks file activity if no explicit connection signal.
    public func handleStatus(commandID: String) -> Response {
        let connected = isExtensionConnected || isExtensionRecentlyActive()
        return Response.success(
            id: commandID,
            value: AnyCodable(connected ? "connected" : "disconnected")
        )
    }

    // MARK: - File-Based IPC

    /// Write a command JSON file to the commands directory.
    public func writeCommandFile(commandID: String, params: [String: AnyCodable]) -> Bool {
        ensureDirectoriesExist()
        let fileURL = commandsDir.appendingPathComponent("\(commandID).json")

        // Build a plain dictionary for serialization
        var payload: [String: Any] = ["id": commandID]
        for (key, val) in params {
            payload[key] = val.value
        }

        do {
            let data = try JSONSerialization.data(withJSONObject: payload, options: [])
            try data.write(to: fileURL, options: .atomic)
            return true
        } catch {
            Logger.error("Failed to write command file \(commandID): \(error)")
            return false
        }
    }

    /// Try to read and parse a result file. Returns nil if the file doesn't exist yet.
    /// Deletes the file after successful read.
    public func readResultFile(commandID: String) -> Response? {
        let fileURL = resultsDir.appendingPathComponent("\(commandID).json")
        let fm = FileManager.default

        guard fm.fileExists(atPath: fileURL.path) else { return nil }

        do {
            let data = try Data(contentsOf: fileURL)
            try fm.removeItem(at: fileURL)

            guard let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return Response.failure(
                    id: commandID,
                    error: StructuredError(
                        code: "INVALID_RESULT",
                        message: "Result file contained invalid JSON",
                        retryable: false
                    )
                )
            }

            // Check for error in the result
            if let errorMsg = parsed["error"] as? String {
                return Response.failure(
                    id: commandID,
                    error: StructuredError(
                        code: "EXTENSION_ERROR",
                        message: errorMsg,
                        retryable: true
                    )
                )
            }

            // Extract the result value
            let resultValue: AnyCodable
            if let result = parsed["result"] {
                resultValue = AnyCodable(result)
            } else {
                resultValue = AnyCodable("")
            }

            return Response.success(id: commandID, value: resultValue)
        } catch {
            Logger.error("Failed to read result file \(commandID): \(error)")
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "BRIDGE_READ_FAILED",
                    message: "Failed to read result file: \(error.localizedDescription)",
                    retryable: true
                )
            )
        }
    }

    /// Remove a stale command file (e.g., after timeout).
    public func cleanupCommandFile(commandID: String) {
        let fileURL = commandsDir.appendingPathComponent("\(commandID).json")
        try? FileManager.default.removeItem(at: fileURL)
    }

    /// Check if any result file was recently written (extension is alive).
    public func isExtensionRecentlyActive() -> Bool {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(
            at: resultsDir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return false }

        let cutoff = Date().addingTimeInterval(-Self.activityThreshold)
        return files.contains { url in
            guard let attrs = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
                  let modified = attrs.contentModificationDate else { return false }
            return modified > cutoff
        }
    }

    // MARK: - Private Helpers

    private func ensureDirectoriesExist() {
        let fm = FileManager.default
        for dir in [commandsDir, resultsDir] {
            if !fm.fileExists(atPath: dir.path) {
                try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
            }
        }
    }
}
