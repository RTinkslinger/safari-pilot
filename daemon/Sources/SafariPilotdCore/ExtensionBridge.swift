import Foundation

public final class ExtensionBridge: @unchecked Sendable {

    private static let defaultTimeout: TimeInterval = 30.0

    private let queue = DispatchQueue(label: "com.safari-pilot.extension-bridge", qos: .userInitiated)

    private var _isConnected: Bool = false

    private struct PendingCommand {
        let id: String
        let params: [String: AnyCodable]
        let continuation: CheckedContinuation<Response, Never>
        let timeoutTask: Task<Void, Never>
    }

    private var pendingCommands: [PendingCommand] = []

    public var isExtensionConnected: Bool {
        queue.sync { _isConnected }
    }

    public init() {}

    public func handleConnected(commandID: String) -> Response {
        queue.sync { _isConnected = true }
        Logger.info("Extension connected.")
        return Response.success(id: commandID, value: AnyCodable("extension_ack"))
    }

    public func handleDisconnected(commandID: String) -> Response {
        let pending: [PendingCommand] = queue.sync {
            _isConnected = false
            let p = pendingCommands
            pendingCommands.removeAll()
            return p
        }
        Logger.info("Extension disconnected. Cancelling \(pending.count) pending request(s).")
        for cmd in pending {
            cmd.timeoutTask.cancel()
            cmd.continuation.resume(returning: Response.failure(
                id: cmd.id,
                error: StructuredError(
                    code: "EXTENSION_DISCONNECTED",
                    message: "Safari extension disconnected while request was pending",
                    retryable: true
                )
            ))
        }
        return Response.success(id: commandID, value: AnyCodable("extension_ack"))
    }

    public func handleExecute(commandID: String, params: [String: AnyCodable]) async -> Response {
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
            let timeoutTask = Task {
                try? await Task.sleep(nanoseconds: UInt64(Self.defaultTimeout * 1_000_000_000))
                guard !Task.isCancelled else { return }
                let removed: Bool = self.queue.sync {
                    if let idx = self.pendingCommands.firstIndex(where: { $0.id == commandID }) {
                        self.pendingCommands.remove(at: idx)
                        return true
                    }
                    return false
                }
                if removed {
                    continuation.resume(returning: Response.failure(
                        id: commandID,
                        error: StructuredError(
                            code: "EXTENSION_TIMEOUT",
                            message: "Extension did not respond within \(Int(Self.defaultTimeout))s",
                            retryable: true
                        )
                    ))
                }
            }

            queue.sync {
                pendingCommands.append(PendingCommand(
                    id: commandID,
                    params: params,
                    continuation: continuation,
                    timeoutTask: timeoutTask
                ))
            }
        }
    }

    public func handlePoll(commandID: String) -> Response {
        let nextCommand: (id: String, params: [String: AnyCodable])? = queue.sync {
            guard let first = pendingCommands.first else { return nil }
            return (id: first.id, params: first.params)
        }

        if let cmd = nextCommand {
            var commandDict: [String: Any] = ["id": cmd.id]
            for (key, val) in cmd.params {
                commandDict[key] = val.value
            }
            return Response.success(id: commandID, value: AnyCodable(["command": commandDict]))
        } else {
            return Response.success(id: commandID, value: AnyCodable(["command": NSNull()]))
        }
    }

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

        let removed: PendingCommand? = queue.sync {
            if let idx = pendingCommands.firstIndex(where: { $0.id == reqID }) {
                return pendingCommands.remove(at: idx)
            }
            return nil
        }

        guard let cmd = removed else {
            return Response.success(id: commandID, value: AnyCodable("extension_ack"))
        }

        cmd.timeoutTask.cancel()

        let callerResponse: Response
        if let errorParam = params["error"],
           let errorMsg = errorParam.value as? String {
            callerResponse = Response.failure(
                id: cmd.id,
                error: StructuredError(
                    code: "EXTENSION_ERROR",
                    message: errorMsg,
                    retryable: true
                )
            )
        } else {
            let resultValue: AnyCodable
            if let resultParam = params["result"] {
                resultValue = resultParam
            } else {
                resultValue = AnyCodable("")
            }
            callerResponse = Response.success(id: cmd.id, value: resultValue)
        }

        cmd.continuation.resume(returning: callerResponse)
        return Response.success(id: commandID, value: AnyCodable("extension_ack"))
    }

    public func handleStatus(commandID: String) -> Response {
        let connected = isExtensionConnected
        return Response.success(
            id: commandID,
            value: AnyCodable(connected ? "connected" : "disconnected")
        )
    }
}
