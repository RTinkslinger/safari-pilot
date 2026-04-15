import Foundation
import Network

public final class ExtensionSocketServer: @unchecked Sendable {

    private let listener: NWListener
    private let dispatcher: CommandDispatcher
    private let queue = DispatchQueue(label: "com.safari-pilot.extension-socket", qos: .userInitiated)
    private var actualPort: UInt16 = 0

    public init(port: UInt16 = 19474, dispatcher: CommandDispatcher) {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        do {
            self.listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
        } catch {
            Logger.error("ExtensionSocketServer: failed to create listener on port \(port): \(error)")
            self.listener = try! NWListener(using: .tcp)
        }
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

    private func handleConnection(_ connection: NWConnection) {
        connection.start(queue: queue)

        connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) { [weak self] data, _, _, error in
            guard let self = self, let data = data, !data.isEmpty else {
                connection.cancel()
                return
            }

            Task {
                let responseData = await self.dispatchMessage(data: data)
                connection.send(content: responseData, completion: .contentProcessed { _ in
                    connection.cancel()
                })
            }
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
