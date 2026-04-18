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
        healthStore: HealthStore
    ) {
        self.port = port
        self.bridge = bridge
        self.healthStore = healthStore
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
                    )
                )
                Logger.info("ExtensionHTTPServer starting on 127.0.0.1:\(port)")
                try await app.runService()
            } catch {
                Logger.error("ExtensionHTTPServer error: \(error)")
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
    }

    /// Serialize a dictionary to a JSON HTTP response with application/json content type.
    private func jsonResponse(
        _ dict: [String: Any],
        status: HTTPTypes.HTTPResponse.Status = .ok
    ) -> HBResponse {
        guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []) else {
            let fallback = ByteBuffer(string: "{\"error\":\"serialization_failed\"}")
            var headers = HTTPFields()
            headers.append(HTTPField(name: .contentType, value: "application/json"))
            return HBResponse(
                status: .internalServerError,
                headers: headers,
                body: .init(byteBuffer: fallback)
            )
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
