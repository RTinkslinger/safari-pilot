import Foundation

// MARK: - ExtensionBridge

/// Tracks Safari extension connection state and routes extension-related commands.
///
/// The Safari extension connects to the daemon via native messaging (stdin/stdout).
/// When the extension sends "extension_connected", the bridge marks itself as connected.
/// When the MCP server sends "extension_execute", the bridge stores the request as pending,
/// the daemon forwards it to the extension, and when the extension replies with
/// "extension_result" the bridge resolves the pending request.
///
/// Connection state is thread-safe via a serial DispatchQueue.
public final class ExtensionBridge: @unchecked Sendable {

    // MARK: - Types

    /// Pending execution request waiting for an extension result.
    private struct PendingRequest {
        let commandID: String
        let continuation: CheckedContinuation<Response, Never>
    }

    // MARK: - State

    /// Thread-safety lock — all mutations go through this queue.
    private let queue = DispatchQueue(label: "com.safari-pilot.extension-bridge", qos: .userInitiated)

    private var _isConnected: Bool = false

    /// Keyed by the original commandID from the MCP-side "extension_execute" command.
    private var _pending: [String: PendingRequest] = [:]

    // MARK: - Public API

    /// Whether the Safari extension is currently connected to the daemon.
    public var isExtensionConnected: Bool {
        queue.sync { _isConnected }
    }

    public init() {}

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
    /// The result carries the original requestID so we can match it to the pending entry.
    ///
    /// - Parameter commandID: ID of the "extension_result" command itself.
    /// - Parameter params: Must contain "requestId" (String) and "result" (String) keys.
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
            // No pending request — could be a late/stale response. Acknowledge but ignore.
            return Response.success(id: commandID, value: AnyCodable("extension_ack"))
        }

        // Build the success/failure response for the original caller.
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

    /// Await an extension execution result. Registers the request as pending and
    /// suspends until the extension calls back with "extension_result".
    ///
    /// - Parameter commandID: The ID of the "extension_execute" command.
    /// - Parameter params: Must contain a "script" (String) parameter.
    public func handleExecute(commandID: String, params: [String: AnyCodable]) async -> Response {
        guard _isConnected else {
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "EXTENSION_NOT_CONNECTED",
                    message: "Safari extension is not connected",
                    retryable: true
                )
            )
        }

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

        return await withCheckedContinuation { continuation in
            let req = PendingRequest(commandID: commandID, continuation: continuation)
            queue.sync { _pending[commandID] = req }
        }
    }

    /// Return connection status as a response (used by "extension_status" command).
    public func handleStatus(commandID: String) -> Response {
        let connected = isExtensionConnected
        return Response.success(
            id: commandID,
            value: AnyCodable(connected ? "connected" : "disconnected")
        )
    }
}
