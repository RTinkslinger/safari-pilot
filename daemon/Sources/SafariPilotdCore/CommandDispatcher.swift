import Foundation

// MARK: - SD-26 helper: AnyCodable numeric coercion

/// AnyCodable's decoder tries `Int.self` before `Double.self`, so integer
/// JSON literals (e.g. `"timeout":5000`) end up as `Int` in `value: Any`.
/// Plain `as? Double` returns nil on Int (Swift cast-rule), so call sites
/// reading "this could be Int or Double" via `as? Double` silently fall
/// back to defaults. This helper accepts either and widens to Double.
internal func numericToDouble(_ value: Any?) -> Double? {
    if let d = value as? Double { return d }
    if let i = value as? Int { return Double(i) }
    return nil
}

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

    /// Observability + persisted alarm-fire timestamp. Shared across the process —
    /// never construct a second instance pointing at the same persistPath.
    public let healthStore: HealthStore

    // MARK: Init

    public init(
        lineSource: @escaping LineSource,
        outputSink: @escaping OutputSink,
        executor: ScriptExecutorProtocol,
        extensionBridge: ExtensionBridge = ExtensionBridge(),
        healthStore: HealthStore
    ) {
        self.lineSource = lineSource
        self.outputSink = outputSink
        self.executor = executor
        self.extensionBridge = extensionBridge
        self.healthStore = healthStore
    }

    // MARK: - Run Loop

    /// Runs the dispatch loop until the line source is exhausted or a "shutdown" command
    /// is received. This method never returns under normal IPC operation.
    public func run() async {
        while let line = lineSource() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else { continue }

            let response = await dispatch(line: trimmed)

            // T25: parse-based shutdown detection. The previous
            // `trimmed.contains("\"shutdown\"")` substring check fired on
            // any NDJSON line whose content (e.g. an execute script body)
            // contained the literal string `"shutdown"` — page content
            // could crash the daemon.
            let isShutdown = Self.isShutdownLine(trimmed)

            write(response)

            if isShutdown {
                Logger.info("Shutdown command received — exiting.")
                exit(0)
            }
        }
    }

    /// Returns true iff the given NDJSON line parses as a command with
    /// `method == "shutdown"`. Used by the run loop to decide when to
    /// exit. Public + static so that tests can verify the discriminator
    /// without driving the run loop (which calls `exit(0)`).
    ///
    /// T25: replaces the previous `trimmed.contains("\"shutdown\"")`
    /// substring check that was vulnerable to user content (execute
    /// scripts, page text) containing the literal `"shutdown"`.
    public static func isShutdownLine(_ line: String) -> Bool {
        return (try? NDJSONParser.parseCommand(line: line))?.method == "shutdown"
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
        // Record every inbound TCP command as a heartbeat for MCP connection tracking.
        healthStore.recordTcpCommand()

        Trace.emit(command.id, layer: "daemon-dispatcher", event: "command_received", data: [
            "method": command.method,
        ])

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

        case "extension_poll":
            // SD-26: accept Int or Double for waitTimeout (same coercion bug
            // class as watch_download.timeout).
            let waitTimeout = numericToDouble(command.params["waitTimeout"]?.value) ?? 0.0
            return await extensionBridge.handlePoll(commandID: command.id, waitTimeout: waitTimeout)

        case "extension_status":
            return extensionBridge.handleStatus(commandID: command.id)

        case "extension_log":
            // Telemetry / breadcrumb messages from background.js.
            // Recognised prefix: "alarm_fire" — updates HealthStore.lastAlarmFireTimestamp
            // so /health can surface persisted wake-tick progress across daemon restarts.
            let msg = (command.params["message"]?.value as? String) ?? ""
            if msg.hasPrefix("alarm_fire") {
                healthStore.recordAlarmFire()
            }
            Logger.info("EXT-LOG: \(msg)")
            return Response.success(id: command.id, value: AnyCodable("log_ack"))

        case "extension_reconcile":
            let executedIds = (command.params["executedIds"]?.value as? [Any])?.compactMap { $0 as? String } ?? []
            let pendingIds = (command.params["pendingIds"]?.value as? [Any])?.compactMap { $0 as? String } ?? []
            let response = extensionBridge.handleReconcile(
                commandID: command.id,
                executedIds: executedIds,
                pendingIds: pendingIds
            )
            healthStore.markReconcile()
            return response

        case "extension_health":
            // Composite snapshot: bridge state + HealthStore counters + placeholders
            // for fields wired in Commit 1b (executedLogSize, claimedByProfiles,
            // engineCircuitBreakerState, killSwitchActive).
            let snapshot = extensionBridge.healthSnapshot(store: healthStore)
            return Response.success(id: command.id, value: AnyCodable(snapshot))

        case "watch_download":
            return await handleWatchDownload(commandID: command.id, params: command.params)

        case "generate_pdf":
            return await handleGeneratePdf(commandID: command.id, params: command.params)

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
    /// Supported methods: extension_status, extension_execute, extension_health.
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
        case "extension_health":
            let snapshot = extensionBridge.healthSnapshot(store: healthStore)
            return Response.success(id: commandID, value: AnyCodable(snapshot))
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

    // MARK: - Download Watcher

    private func handleWatchDownload(commandID: String, params: [String: AnyCodable]) async -> Response {
        let start = CFAbsoluteTimeGetCurrent()

        // SD-26: AnyCodable's decoder tries Int.self before Double.self, so
        // integer JSON literals (e.g. `"timeout":5000`) decode as Int. Plain
        // `as? Double` returns nil on Int (Swift cast-rule), then the SUT
        // fell back to 30000ms — silently giving callers a 30-second
        // timeout regardless of what they passed. Production bug: real
        // callers writing `{"timeout": 5000}` got 30s, not 5s.
        // Fix: accept Double OR Int (widened to Double) for the same cast.
        let timeoutMs = numericToDouble(params["timeout"]?.value) ?? 30000.0
        let timeoutSec = timeoutMs / 1000.0

        let filenamePattern = params["filenamePattern"]?.value as? String

        var clickCtx: ClickContextParams? = nil
        if let ctxDict = params["clickContext"]?.value as? [String: Any] {
            clickCtx = ClickContextParams(
                href: ctxDict["href"] as? String,
                downloadAttr: ctxDict["downloadAttr"] as? String,
                tabUrl: ctxDict["tabUrl"] as? String,
                timestamp: ctxDict["timestamp"] as? Double
            )
        }

        let watcher: DownloadWatcher
        do {
            watcher = try DownloadWatcher(
                timeout: timeoutSec,
                filenamePattern: filenamePattern,
                clickContext: clickCtx
            )
        } catch DownloadError.directoryNotFound(let dir) {
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "DOWNLOAD_DIR_NOT_FOUND",
                    message: "Download directory not found: \(dir)",
                    retryable: false
                ),
                elapsedMs: elapsed
            )
        } catch {
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "DOWNLOAD_INIT_ERROR",
                    message: error.localizedDescription,
                    retryable: false
                ),
                elapsedMs: elapsed
            )
        }

        do {
            let result = try await watcher.watch()
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000

            let value: [String: Any] = [
                "filename": result.filename,
                "path": result.path,
                "url": result.url as Any,
                "referrer": result.referrer as Any,
                "size": result.size,
                "mimeType": result.mimeType as Any,
                "contentType": result.contentType as Any,
                "duration": result.duration,
                "quarantined": result.quarantined,
            ]
            return Response.success(id: commandID, value: AnyCodable(value), elapsedMs: elapsed)
        } catch DownloadError.fsEventsUnavailable(let dir) {
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "FSEVENTS_UNAVAILABLE",
                    message: "Failed to create filesystem monitor for: \(dir)",
                    retryable: false
                ),
                elapsedMs: elapsed
            )
        } catch DownloadError.timeout(_) {
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "DOWNLOAD_TIMEOUT",
                    message: "No download completed within \(Int(timeoutMs))ms",
                    retryable: true
                ),
                elapsedMs: elapsed
            )
        } catch DownloadError.cancelled {
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "DOWNLOAD_CANCELLED",
                    message: "Download was cancelled",
                    retryable: false
                ),
                elapsedMs: elapsed
            )
        } catch {
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "DOWNLOAD_ERROR",
                    message: error.localizedDescription,
                    retryable: false
                ),
                elapsedMs: elapsed
            )
        }
    }

    // MARK: - PDF Generator

    private func handleGeneratePdf(commandID: String, params: [String: AnyCodable]) async -> Response {
        let start = CFAbsoluteTimeGetCurrent()

        let generator: PdfGenerator
        do {
            generator = try PdfGenerator.create(params: params)
        } catch PdfError.invalidOutputPath(let msg) {
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "INVALID_OUTPUT_PATH",
                    message: msg,
                    retryable: false
                ),
                elapsedMs: elapsed
            )
        } catch {
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "PDF_GENERATION_ERROR",
                    message: error.localizedDescription,
                    retryable: false
                ),
                elapsedMs: elapsed
            )
        }

        do {
            let result = try await generator.generate()
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000

            let value: [String: Any] = [
                "path": result.path,
                "pageCount": result.pageCount,
                "fileSize": result.fileSize,
                "warnings": result.warnings,
            ]
            return Response.success(id: commandID, value: AnyCodable(value), elapsedMs: elapsed)
        } catch PdfError.loadFailed(let msg) {
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "WKWEBVIEW_LOAD_ERROR",
                    message: msg,
                    retryable: true
                ),
                elapsedMs: elapsed
            )
        } catch PdfError.generationFailed(let msg) {
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "PDF_GENERATION_ERROR",
                    message: msg,
                    retryable: false
                ),
                elapsedMs: elapsed
            )
        } catch PdfError.emptyPdf {
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "PDF_EMPTY",
                    message: "Generated PDF is empty (0 pages, <100 bytes)",
                    retryable: true
                ),
                elapsedMs: elapsed
            )
        } catch PdfError.timeout {
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "PDF_TIMEOUT",
                    message: "PDF generation timed out",
                    retryable: true
                ),
                elapsedMs: elapsed
            )
        } catch {
            let elapsed = (CFAbsoluteTimeGetCurrent() - start) * 1000
            return Response.failure(
                id: commandID,
                error: StructuredError(
                    code: "PDF_GENERATION_ERROR",
                    message: error.localizedDescription,
                    retryable: false
                ),
                elapsedMs: elapsed
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
