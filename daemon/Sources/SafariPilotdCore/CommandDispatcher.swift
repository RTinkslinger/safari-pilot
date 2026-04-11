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

    // MARK: Init

    public init(
        lineSource: @escaping LineSource,
        outputSink: @escaping OutputSink,
        executor: ScriptExecutorProtocol
    ) {
        self.lineSource = lineSource
        self.outputSink = outputSink
        self.executor = executor
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
            return await executor.execute(script: scriptString, commandID: command.id)

        case "shutdown":
            // Return ack first — the run loop will call exit() after writing it.
            return Response.success(id: command.id, value: AnyCodable("shutting_down"))

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
