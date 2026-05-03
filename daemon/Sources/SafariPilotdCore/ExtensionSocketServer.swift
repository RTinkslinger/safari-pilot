import Foundation
import Network

public final class ExtensionSocketServer: @unchecked Sendable {

    private let listener: NWListener
    private let dispatcher: CommandDispatcher
    private let queue = DispatchQueue(label: "com.safari-pilot.extension-socket", qos: .userInitiated)
    private var actualPort: UInt16 = 0

    /// Throws when NWListener cannot bind to the requested port. Pre-T45
    /// the catch silently fell back to `try! NWListener(using: .tcp)` —
    /// a random ephemeral port that no client could discover, leaving the
    /// daemon in a "split-brain" state where it claimed to be running on
    /// 19474 but was serving traffic somewhere else. Now the failure
    /// propagates and `main.swift` translates it into a fatal exit so the
    /// problem is visible at startup instead of via mysterious "extension
    /// can't reach daemon" symptoms much later.
    public init(port: UInt16 = 19474, dispatcher: CommandDispatcher) throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        // NWEndpoint.Port(rawValue:) accepts any UInt16, including 0 (= ephemeral).
        // Force-unwrap is safe: rawValue is in-range by construction.
        self.listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        self.dispatcher = dispatcher
    }

    @discardableResult
    public func start() -> UInt16? {
        let semaphore = DispatchSemaphore(value: 0)
        var startedPort: UInt16?

        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                if let port = self?.listener.port?.rawValue {
                    self?.actualPort = port
                    startedPort = port
                    Logger.info("ExtensionSocketServer listening on localhost:\(port)")
                }
                semaphore.signal()
            case .failed(let error):
                Logger.error("ExtensionSocketServer failed to start: \(error)")
                semaphore.signal()
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }

        listener.start(queue: queue)
        _ = semaphore.wait(timeout: .now() + 5)
        return startedPort
    }

    public func stop() {
        listener.cancel()
        Logger.info("ExtensionSocketServer stopped")
    }

    public var port: UInt16 { actualPort }

    // MARK: - Connection Handling

    /// T69a: per-connection accumulation cap. Long click JS payloads observed
    /// up to ~100 KB; anything past 4 MB indicates a misbehaving / malicious
    /// client and we refuse rather than buffer indefinitely.
    private static let maxAccumulatedBytes = 4 * 1024 * 1024

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)
        receiveLoop(connection: connection, accumulated: Data())
    }

    /// T69a — accumulate-until-newline. Pre-fix the receive callback fired
    /// once per connection with `minimumIncompleteLength: 1` and immediately
    /// dispatched whatever bytes had arrived so far. Any TCP-segmented
    /// message (long click JS payloads >~64KB observed in production traces)
    /// got dispatched as the truncated first segment → JSONSerialization
    /// fails → PARSE_ERROR with id="unknown" → originating pending request
    /// times out with no diagnostic. Post-fix we recurse the receive call,
    /// appending bytes to a per-connection buffer until \n arrives, then
    /// dispatch the complete line. Client request-response contract
    /// unchanged: one command per connection, server cancels after sending
    /// response.
    private func receiveLoop(connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self = self else {
                connection.cancel()
                return
            }
            if let error = error {
                Logger.warning("ExtensionSocketServer: receive error: \(error)")
                connection.cancel()
                return
            }

            var buffer = accumulated
            if let data = data, !data.isEmpty {
                buffer.append(data)
            }

            // Look for the end of the first complete line. The TS client
            // contract is one NDJSON message per connection terminated by \n.
            if let nlIndex = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                // Slice off the line (without the newline) and dispatch.
                let lineData = buffer.prefix(upTo: nlIndex)
                Task {
                    let responseData = await self.dispatchMessage(data: Data(lineData))
                    connection.send(content: responseData, completion: .contentProcessed { _ in
                        connection.cancel()
                    })
                }
                return
            }

            // No newline yet. If the buffer crossed the safety cap, refuse.
            if buffer.count > Self.maxAccumulatedBytes {
                let fallback = #"{"id":"unknown","ok":false,"error":{"code":"PARSE_ERROR","message":"Message exceeded max accumulated bytes without newline"}}"# + "\n"
                connection.send(content: Data(fallback.utf8), completion: .contentProcessed { _ in
                    connection.cancel()
                })
                return
            }

            // If the peer half-closed without sending a newline, give up.
            if isComplete {
                connection.cancel()
                return
            }

            // More to come — recurse to read the next chunk.
            self.receiveLoop(connection: connection, accumulated: buffer)
        }
    }

    private func dispatchMessage(data: Data) async -> Data {
        guard let line = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !line.isEmpty else {
            let fallback = #"{"id":"unknown","ok":false,"error":{"code":"PARSE_ERROR","message":"Empty or invalid UTF-8 message"}}"# + "\n"
            return Data(fallback.utf8)
        }

        let response = await dispatcher.dispatch(line: line)

        do {
            let serialized = try NDJSONSerializer.serialize(response: response)
            return Data((serialized + "\n").utf8)
        } catch {
            let fallback = #"{"id":"unknown","ok":false,"error":{"code":"SERIALIZATION_ERROR","message":"Response serialization failed"}}"# + "\n"
            return Data(fallback.utf8)
        }
    }
}
