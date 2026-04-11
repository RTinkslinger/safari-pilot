import Foundation

// MARK: - CommandDispatcher

/// Reads NDJSON commands from a line source, dispatches to the appropriate handler,
/// and writes NDJSON responses to an output sink.
///
/// This type is designed to be testable: the `lineSource`, `outputSink`, and
/// `executor` are injected so tests can substitute mocks without touching stdin/stdout.
public final class CommandDispatcher: @unchecked Sendable {

    // MARK: Dependencies

    /// Produces lines one at a time. Returns `nil` when the source is exhausted.
    public typealias LineSource = () -> String?

    /// Consumes a serialized response line (already appended with "\n").
    public typealias OutputSink = (String) -> Void

    private let lineSource: LineSource
    private let outputSink: OutputSink
    private let executor: ScriptExecutorProtocol

    /// Manages Safari extension connection state and pending requests.
    public let extensionBridge: ExtensionBridge

    // MARK: Init

    public init(
        lineSource: @escaping LineSource,
        outputSink: @escaping OutputSink,
        executor: ScriptExecutorProtocol,
        extensionBridge: ExtensionBridge = ExtensionBridge()
    ) {
        self.lineSource = lineSource
        self.outputSink = outputSink
        self.executor = executor
        self.extensionBridge = extensionBridge
    }

    /// Convenience initialiser for production use: reads from stdin, writes to stdout.
    public convenience init(executor: ScriptExecutorProtocol = AppleScriptExecutor()) {
        self.init(
            lineSource: {
                // `readLine(strippingNewline:)` blocks until a line arrives or EOF.
                readLine(strippingNewline: true)
            },
            outputSink: { line in
                print(line, terminator: "")
                // Flush stdout immediately so the TypeScript host receives responses
                // without buffering delay.
                fflush(stdout)
            },
            executor: executor
        )
    }

    // MARK: - Run Loop

    /// Runs the dispatch loop until the line source is exhausted or a "shutdown" command
    /// is received. This method never returns under normal IPC operation.
    public func run() async {
        while let line = lineSource() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }

            let response = await dispatch(line: trimmed)

            // Determine whether to exit before writing the final response
            let isShutdown = trimmed.contains("\"shutdown\"")

            write(response)

            if isShutdown {
                Logger.info("Shutdown command received — exiting.")
                exit(0)
            }
        }
    }

    // MARK: - Dispatch

    /// Parse one NDJSON line and route to the appropriate handler.
    /// Returns a Response in all cases — never throws.
    public func dispatch(line: String) async -> Response {
        let command: Command
        do {
            command = try NDJSONParser.parseCommand(line: line)
        } catch {
            // We can't recover a proper id here, so use a sentinel.
            return Response.failure(
                id: "unknown",
                error: StructuredError(
                    code: "PARSE_ERROR",
                    message: "Failed to parse command: \(error)",
                    retryable: false
                )
            )
        }

        return await handle(command: command)
    }

    // MARK: - Routing

    private func handle(command: Command) async -> Response {
        switch command.method {

        case "ping":
            return Response.success(id: command.id, value: AnyCodable("pong"))

        case "execute":
            guard let scriptParam = command.params["script"],
                  let scriptString = scriptParam.value as? String,
                  !scriptString.isEmpty else {
                return Response.failure(
                    id: command.id,
                    error: StructuredError(
                        code: "INVALID_PARAMS",
                        message: "\"execute\" requires a non-empty \"script\" string parameter",
                        retryable: false
                    )
                )
            }

            // Internal extension bridge sentinel: "__SAFARI_PILOT_INTERNAL__ <method> [jsonParams]"
            // This allows the TypeScript ExtensionEngine to route extension commands through
            // the DaemonEngine's standard execute() path without requiring a separate protocol.
            let internalPrefix = "__SAFARI_PILOT_INTERNAL__ "
            if scriptString.hasPrefix(internalPrefix) {
                let remainder = String(scriptString.dropFirst(internalPrefix.count))
                return await handleInternalCommand(commandID: command.id, raw: remainder)
            }

            return await executor.execute(script: scriptString, commandID: command.id)

        case "shutdown":
            // Return ack first — the run loop will call exit() after writing it.
            return Response.success(id: command.id, value: AnyCodable("shutting_down"))

        // MARK: Extension bridge commands

        case "extension_connected":
            return extensionBridge.handleConnected(commandID: command.id)

        case "extension_disconnected":
            return extensionBridge.handleDisconnected(commandID: command.id)

        case "extension_result":
            return extensionBridge.handleResult(commandID: command.id, params: command.params)

        case "extension_execute":
            return await extensionBridge.handleExecute(commandID: command.id, params: command.params)

        case "extension_status":
            return extensionBridge.handleStatus(commandID: command.id)

        default:
            return Response.failure(
                id: command.id,
                error: StructuredError(
                    code: "UNKNOWN_METHOD",
                    message: "Unknown method: \"\(command.method)\"",
                    retryable: false
                )
            )
        }
    }

    // MARK: - Internal command routing (for ExtensionEngine sentinel protocol)

    /// Parse and route a "__SAFARI_PILOT_INTERNAL__ <method> [jsonParams]" string.
    /// Supported methods: extension_status, extension_execute.
    private func handleInternalCommand(commandID: String, raw: String) async -> Response {
        // Split on first space: "<method>" or "<method> <jsonParams>"
        let parts = raw.split(separator: " ", maxSplits: 1).map(String.init)
        let method = parts.first ?? ""
        let jsonString = parts.count > 1 ? parts[1] : "{}"

        // Parse optional JSON params
        var params: [String: AnyCodable] = [:]
        if let data = jsonString.data(using: .utf8),
           let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
            params = dict.mapValues { AnyCodable($0) }
        }

        switch method {
        case "extension_status":
            return extensionBridge.handleStatus(commandID: commandID)
        case "extension_execute":
            return await extensionBridge.handleExecute(commandID: commandID, params: params)
        default:
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "UNKNOWN_INTERNAL_METHOD",
                    message: "Unknown internal method: \"\(method)\"",
                    retryable: false
                )
            )
        }
    }

    // MARK: - Output

    private func write(_ response: Response) {
        do {
            let line = try NDJSONSerializer.serialize(response: response)
            outputSink(line + "\n")
        } catch {
            // Last-resort: write a minimal JSON error so the host can detect the failure.
            let fallback = #"{"id":"unknown","ok":false,"elapsedMs":0,"error":{"code":"SERIALIZATION_ERROR","message":"Response serialization failed","retryable":false}}"# + "\n"
            outputSink(fallback)
        }
    }
}
