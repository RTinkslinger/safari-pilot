import Foundation
import Hummingbird
import HummingbirdCore
import HTTPTypes
import NIOCore

/// Disambiguate Hummingbird's Response/Request from our NDJSON types (Models.swift).
private typealias HBResponse = HummingbirdCore.Response
private typealias HBRequest = HummingbirdCore.Request

/// HTTP server that the Safari extension polls via `fetch()`.
///
/// Replaces the handler-based TCP proxy path (sendNativeMessage -> handler -> TCP:19474)
/// with direct HTTP communication on `127.0.0.1:19475`.
///
/// Routes:
///   POST /connect  — reconcile extension state with daemon
///   GET  /poll     — long-poll for pending commands (5s timeout)
///   POST /result   — deliver script execution result
///
/// All routes include CORS headers (via Hummingbird CORSMiddleware).
/// Disconnect detection runs as a background Task checking every 10s.
@available(macOS 14.0, *)
public final class ExtensionHTTPServer: @unchecked Sendable {

    private let port: UInt16
    private let bridge: ExtensionBridge
    private let healthStore: HealthStore
    private let onReady: (@Sendable () async -> Void)?
    private let onBindFailure: (@Sendable (Error) -> Void)?

    /// Tracks the last time any HTTP request was received.
    private let lock = DispatchQueue(label: "com.safari-pilot.http-server")
    private var _lastRequestTime: Date = Date()
    private var _serverTask: Task<Void, Never>?
    private var _disconnectTask: Task<Void, Never>?

    /// Time without requests before declaring extension disconnected.
    private static let disconnectTimeout: TimeInterval = 15.0
    /// Interval between disconnect-detection checks.
    private static let disconnectCheckInterval: TimeInterval = 10.0
    /// Long-poll wait timeout for GET /poll.
    private static let pollWaitTimeout: TimeInterval = 5.0

    public init(
        port: UInt16 = 19475,
        bridge: ExtensionBridge,
        healthStore: HealthStore,
        onReady: (@Sendable () async -> Void)? = nil,
        onBindFailure: (@Sendable (Error) -> Void)? = nil
    ) {
        self.port = port
        self.bridge = bridge
        self.healthStore = healthStore
        self.onReady = onReady
        self.onBindFailure = onBindFailure
    }

    // MARK: - Lifecycle

    /// Start the HTTP server and disconnect-detection background tasks.
    public func start() {
        _serverTask = Task { [self] in
            do {
                let router = buildRouter()
                let app = Application(
                    router: router,
                    configuration: ApplicationConfiguration(
                        address: .hostname("127.0.0.1", port: Int(port)),
                        serverName: "SafariPilot-ExtHTTP"
                    ),
                    onServerRunning: { [self] _ in
                        Logger.info("HTTP_READY port=\(self.port)")
                        await self.onReady?()
                    }
                )
                Logger.info("ExtensionHTTPServer starting on 127.0.0.1:\(port)")
                try await app.runService()
            } catch {
                Logger.error("HTTP_BIND_FAILED port=\(port) error=\(error)")
                self.onBindFailure?(error)
            }
        }

        _disconnectTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.disconnectCheckInterval * 1_000_000_000))
                guard !Task.isCancelled, let self = self else { break }
                self.checkDisconnect()
            }
        }
    }

    /// Stop the server and disconnect-detection tasks.
    public func stop() {
        _serverTask?.cancel()
        _disconnectTask?.cancel()
        _serverTask = nil
        _disconnectTask = nil
        Logger.info("ExtensionHTTPServer stopped")
    }

    // MARK: - Router

    private func buildRouter() -> Router<BasicRequestContext> {
        let router = Router<BasicRequestContext>()

        // CORS middleware — handles OPTIONS preflight automatically
        router.addMiddleware {
            CORSMiddleware(
                allowOrigin: .all,
                allowHeaders: [.accept, .contentType, .origin],
                allowMethods: [.get, .post, .options]
            )
        }

        router.post("connect") { [self] request, context -> HBResponse in
            self.touchLastRequestTime()
            return try await self.handleConnect(request: request, context: context)
        }

        router.get("poll") { [self] _, _ -> HBResponse in
            self.touchLastRequestTime()
            return await self.handlePoll()
        }

        router.post("result") { [self] request, context -> HBResponse in
            self.touchLastRequestTime()
            return try await self.handleResult(request: request, context: context)
        }

        router.get("status") { [self] request, _ -> HBResponse in
            // Extract sessionId from query string for implicit heartbeat
            if let sessionId = request.uri.queryParameters.get("sessionId") {
                self.healthStore.touchSession(sessionId)
            }
            return self.handleStatus()
        }

        router.get("session") { [self] _, _ -> HBResponse in
            return self.handleSession()
        }

        router.get("health") { [self] _, _ -> HBResponse in
            return self.handleHealth()
        }

        router.post("session/register") { [self] request, context -> HBResponse in
            self.touchLastRequestTime()
            let buffer = try await request.body.collect(upTo: context.maxUploadSize)
            guard buffer.readableBytes > 0,
                  let data = buffer.getData(at: buffer.readerIndex, length: buffer.readableBytes),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let sessionId = json["sessionId"] as? String else {
                throw HTTPError(.badRequest, message: "Missing sessionId in body")
            }
            self.healthStore.registerSession(sessionId)
            return self.jsonResponse([
                "ok": true,
                "activeSessions": self.healthStore.activeSessionCount,
            ])
        }

        return router
    }

    // MARK: - Route Handlers

    /// POST /connect — reconcile extension state with daemon.
    private func handleConnect(request: HBRequest, context: BasicRequestContext) async throws -> HBResponse {
        // Parse optional JSON body
        var executedIds: [String] = []
        var pendingIds: [String] = []

        let buffer = try await request.body.collect(upTo: context.maxUploadSize)
        if buffer.readableBytes > 0,
           let data = buffer.getData(at: buffer.readerIndex, length: buffer.readableBytes),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            executedIds = (json["executedIds"] as? [Any])?.compactMap { $0 as? String } ?? []
            pendingIds = (json["pendingIds"] as? [Any])?.compactMap { $0 as? String } ?? []
        }

        // Mark IPC mechanism
        bridge.setIpcMechanism("http")

        // Mark connected
        _ = bridge.handleConnected(commandID: "http-connect")

        // Run reconcile
        let reconcileResponse = bridge.handleReconcile(
            commandID: "http-reconcile",
            executedIds: executedIds,
            pendingIds: pendingIds
        )
        healthStore.markReconcile()

        // Extract reconcile result and build JSON response
        guard let resultDict = reconcileResponse.value?.value as? [String: Any] else {
            return jsonResponse(["error": "reconcile_failed"], status: .internalServerError)
        }

        return jsonResponse(resultDict)
    }

    /// GET /poll — long-poll for pending commands.
    /// Returns 200 with command JSON when available, 204 when empty after timeout.
    private func handlePoll() async -> HBResponse {
        let commandID = "http-poll-\(UUID().uuidString.prefix(8))"

        let pollResponse = await bridge.handlePoll(
            commandID: commandID,
            waitTimeout: Self.pollWaitTimeout
        )

        guard let valueDict = pollResponse.value?.value as? [String: Any],
              let commands = valueDict["commands"] as? [[String: Any]],
              !commands.isEmpty else {
            // No commands — 204 No Content
            return HBResponse(status: .noContent, headers: HTTPFields(), body: .init())
        }

        // Return ALL commands — bridge marks all as delivered, so we must send all.
        return jsonResponse(["commands": commands])
    }

    /// POST /result — deliver script execution result back to the waiting continuation.
    private func handleResult(request: HBRequest, context: BasicRequestContext) async throws -> HBResponse {
        let buffer = try await request.body.collect(upTo: context.maxUploadSize)
        guard buffer.readableBytes > 0,
              let data = buffer.getData(at: buffer.readerIndex, length: buffer.readableBytes),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let requestId = json["requestId"] as? String else {
            throw HTTPError(.badRequest, message: "Missing requestId in body")
        }

        var params: [String: AnyCodable] = [
            "requestId": AnyCodable(requestId)
        ]
        if let result = json["result"] {
            params["result"] = AnyCodable(result)
        }
        if let error = json["error"] as? String {
            params["error"] = AnyCodable(error)
        }

        _ = bridge.handleResult(
            commandID: "http-result-\(UUID().uuidString.prefix(8))",
            params: params
        )

        return jsonResponse(["ok": true])
    }

    /// GET /status — fast status check for MCP server bootstrap.
    /// Returns {ext, mcp, sessionTab, lastPingAge} with no blocking I/O.
    private func handleStatus() -> HBResponse {
        let extConnected = bridge.isExtensionConnected
        let mcpConn = healthStore.mcpConnected
        let sessionTab = healthStore.sessionTabActive
        let lastPingAge: Any
        if let last = healthStore.lastKeepalivePing {
            lastPingAge = Int(Date().timeIntervalSince(last) * 1000)
        } else {
            lastPingAge = NSNull()
        }

        Trace.emit("status", layer: "daemon-http", event: "status_polled", data: [
            "ext": extConnected,
            "mcp": mcpConn,
            "sessionTab": sessionTab,
        ])

        return jsonResponse([
            "ext": extConnected,
            "mcp": mcpConn,
            "sessionTab": sessionTab,
            "lastPingAge": lastPingAge,
            "activeSessions": healthStore.activeSessionCount,
        ])
    }

    /// GET /health — returns health data for the session dashboard page.
    /// Combines extension connectivity, MCP connection, and command timestamps.
    private func handleHealth() -> HBResponse {
        let lastExecMs: Any
        if let ts = healthStore.lastExecutedResultTimestamp {
            lastExecMs = ts.timeIntervalSince1970 * 1000
        } else {
            lastExecMs = NSNull()
        }

        return jsonResponse([
            "isConnected": bridge.isExtensionConnected,
            "mcpConnected": healthStore.mcpConnected,
            "lastExecutedResultTimestamp": lastExecMs,
        ])
    }

    /// GET /session — serves the user-facing session dashboard page.
    /// Records session served in HealthStore and emits a trace event.
    private func handleSession() -> HBResponse {
        healthStore.recordSessionServed()

        Trace.emit("session", layer: "daemon-http", event: "session_page_served", data: [:])

        let html = Self.sessionPageHTML
        guard let data = html.data(using: .utf8) else {
            healthStore.recordHttpRequestError()
            let fallback = ByteBuffer(string: "<html><body>Error</body></html>")
            var headers = HTTPFields()
            headers.append(HTTPField(name: .contentType, value: "text/html; charset=utf-8"))
            return HBResponse(status: .internalServerError, headers: headers, body: .init(byteBuffer: fallback))
        }
        let buffer = ByteBuffer(data: data)
        var headers = HTTPFields()
        headers.append(HTTPField(name: .contentType, value: "text/html; charset=utf-8"))
        headers.append(HTTPField(name: .contentLength, value: String(data.count)))
        return HBResponse(status: .ok, headers: headers, body: .init(byteBuffer: buffer))
    }

    private static let sessionPageHTML: String = """
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Safari Pilot — Active Session</title>
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          background: #1a1a1a;
          color: #e0e0e0;
          font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif;
          font-size: 14px;
          line-height: 1.5;
          padding: 32px 24px;
          max-width: 480px;
          margin: 0 auto;
        }
        h1 { font-size: 18px; font-weight: 600; color: #ffffff; margin-bottom: 4px; }
        .subtitle {
          font-size: 12px;
          color: #888;
          margin-bottom: 28px;
          line-height: 1.4;
        }
        .status-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
        .status-table tr { border-bottom: 1px solid #2a2a2a; }
        .status-table tr:last-child { border-bottom: none; }
        .status-table td { padding: 10px 0; vertical-align: middle; }
        .label { color: #999; font-size: 13px; width: 50%; }
        .value { font-size: 13px; color: #e0e0e0; text-align: right; display: flex; align-items: center; justify-content: flex-end; gap: 7px; }
        .dot {
          display: inline-block;
          width: 9px;
          height: 9px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .dot-green { background: #3fb950; box-shadow: 0 0 5px #3fb95066; }
        .dot-red   { background: #f85149; box-shadow: 0 0 5px #f8514966; }
        .dot-gray  { background: #555; }
        footer {
          font-size: 11px;
          color: #666;
          border-top: 1px solid #2a2a2a;
          padding-top: 16px;
          margin-top: 4px;
        }
      </style>
    </head>
    <body>
      <h1>Safari Pilot — Active Session</h1>
      <p class="subtitle">This tab keeps Safari Pilot connected. Do not close it while automation is running.</p>

      <table class="status-table">
        <tr>
          <td class="label">Extension</td>
          <td class="value" id="ext-status"><span class="dot dot-gray"></span>—</td>
        </tr>
        <tr>
          <td class="label">Claude Code</td>
          <td class="value" id="mcp-status"><span class="dot dot-gray"></span>—</td>
        </tr>
        <tr>
          <td class="label">Last Command</td>
          <td class="value" id="last-cmd">—</td>
        </tr>
        <tr>
          <td class="label">Uptime</td>
          <td class="value" id="uptime">—</td>
        </tr>
        <tr>
          <td class="label">Session</td>
          <td class="value" id="session-id">—</td>
        </tr>
      </table>

      <footer>Closing this tab may interrupt Safari Pilot automation.</footer>

      <script>
        const sessionId = new URLSearchParams(location.search).get('id') || '—';
        document.addEventListener('DOMContentLoaded', () => {
          document.getElementById('session-id').textContent = sessionId;
        });

        const startTime = Date.now();

        function fmt(ms) {
          if (ms == null) return '—';
          const ago = Math.floor((Date.now() - ms) / 1000);
          if (ago < 60) return ago + 's ago';
          const m = Math.floor(ago / 60), s = ago % 60;
          return m + 'm ' + s + 's ago';
        }

        function uptime() {
          const s = Math.floor((Date.now() - startTime) / 1000);
          const m = Math.floor(s / 60), ss = s % 60;
          return m + ':' + String(ss).padStart(2, '0');
        }

        function dot(connected) {
          const cls = connected ? 'dot-green' : 'dot-red';
          const label = connected ? 'Connected' : 'Disconnected';
          return '<span class="dot ' + cls + '"></span>' + label;
        }

        async function poll() {
          try {
            const r = await fetch('/health');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const d = await r.json();

            document.getElementById('ext-status').innerHTML = dot(!!d.isConnected);
            document.getElementById('mcp-status').innerHTML = dot(!!d.mcpConnected);

            const lastMs = d.lastExecutedResultTimestamp;
            document.getElementById('last-cmd').textContent =
              (lastMs && lastMs > 0) ? fmt(lastMs) : '—';
          } catch (e) {
            // silently ignore fetch errors — daemon may be restarting
          }
          document.getElementById('uptime').textContent = uptime();
        }

        poll();
        setInterval(poll, 5000);
        setInterval(() => {
          document.getElementById('uptime').textContent = uptime();
        }, 1000);
      </script>
    </body>
    </html>
    """

    // MARK: - Helpers

    private func touchLastRequestTime() {
        lock.sync { _lastRequestTime = Date() }
    }

    private var lastRequestTime: Date {
        lock.sync { _lastRequestTime }
    }

    private func checkDisconnect() {
        let elapsed = Date().timeIntervalSince(lastRequestTime)
        if elapsed > Self.disconnectTimeout && bridge.isExtensionConnected {
            Logger.info("ExtensionHTTPServer: no request in \(Int(elapsed))s — marking disconnected")
            _ = bridge.handleDisconnected(commandID: "http-disconnect-timeout")
        }
        // Check MCP connection heartbeat — clears mcpConnected if no TCP command in 30s.
        healthStore.checkMcpConnection()
    }

    /// Serialize a dictionary to a JSON HTTP response with application/json content type.
    private func jsonResponse(
        _ dict: [String: Any],
        status: HTTPTypes.HTTPResponse.Status = .ok
    ) -> HBResponse {
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []) else {
            healthStore.recordHttpRequestError()
            let fallback = ByteBuffer(string: "{\"error\":\"serialization_failed\"}")
            var headers = HTTPFields()
            headers.append(HTTPField(name: .contentType, value: "application/json"))
            return HBResponse(
                status: .internalServerError,
                headers: headers,
                body: .init(byteBuffer: fallback)
            )
        }
        if status.code >= 500 {
            healthStore.recordHttpRequestError()
        }
        let buffer = ByteBuffer(data: data)
        var headers = HTTPFields()
        headers.append(HTTPField(name: .contentType, value: "application/json; charset=utf-8"))
        headers.append(HTTPField(name: .contentLength, value: String(data.count)))
        return HBResponse(
            status: status,
            headers: headers,
            body: .init(byteBuffer: buffer)
        )
    }
}
