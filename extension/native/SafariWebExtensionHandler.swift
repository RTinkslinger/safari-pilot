import SafariServices
import os.log
import Network

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private static let daemonHost = "127.0.0.1"
    private static let daemonPort: UInt16 = 19474
    private static let connectionTimeout: TimeInterval = 10.0

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "SafariPilot: received native message: %@", String(describing: message))

        guard let messageDict = message as? [String: Any] else {
            os_log(.error, "SafariPilot: message is not a dictionary")
            returnResponse(["error": "Invalid message format", "ok": false], context: context)
            return
        }

        forwardToDaemon(message: messageDict) { response in
            self.returnResponse(response, context: context)
        }
    }

    private func forwardToDaemon(message: [String: Any], completion: @escaping ([String: Any]) -> Void) {
        let host = NWEndpoint.Host(Self.daemonHost)
        guard let port = NWEndpoint.Port(rawValue: Self.daemonPort) else {
            completion(["error": "Invalid daemon port", "ok": false])
            return
        }
        let connection = NWConnection(host: host, port: port, using: .tcp)
        let queue = DispatchQueue(label: "com.safari-pilot.handler-conn")

        var completed = false
        let safeComplete: ([String: Any]) -> Void = { response in
            queue.sync {
                guard !completed else { return }
                completed = true
            }
            completion(response)
        }

        let timeoutItem = DispatchWorkItem {
            os_log(.error, "SafariPilot: daemon connection timed out")
            connection.cancel()
            safeComplete(["error": "Daemon connection timed out", "ok": false])
        }
        queue.asyncAfter(deadline: .now() + Self.connectionTimeout, execute: timeoutItem)

        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                self.sendAndReceive(connection: connection, message: message) { response in
                    timeoutItem.cancel()
                    connection.cancel()
                    safeComplete(response)
                }
            case .failed(let error):
                os_log(.error, "SafariPilot: connection failed: %@", error.localizedDescription)
                timeoutItem.cancel()
                connection.cancel()
                safeComplete(["error": "Daemon not reachable: \(error.localizedDescription)", "ok": false])
            case .cancelled:
                break
            default:
                break
            }
        }

        connection.start(queue: queue)
    }

    private func sendAndReceive(
        connection: NWConnection,
        message: [String: Any],
        completion: @escaping ([String: Any]) -> Void
    ) {
        let daemonMessage = buildDaemonMessage(from: message)

        guard let jsonData = try? JSONSerialization.data(withJSONObject: daemonMessage),
              var payload = String(data: jsonData, encoding: .utf8) else {
            completion(["error": "Failed to serialize message", "ok": false])
            return
        }
        payload += "\n"

        let sendData = payload.data(using: .utf8)!
        connection.send(content: sendData, completion: .contentProcessed { error in
            if let error = error {
                os_log(.error, "SafariPilot: send failed: %@", error.localizedDescription)
                completion(["error": "Send failed", "ok": false])
                return
            }

            connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) { data, _, _, error in
                guard let data = data,
                      let response = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    completion(["error": "No response from daemon", "ok": false])
                    return
                }
                completion(response)
            }
        })
    }

    private func buildDaemonMessage(from message: [String: Any]) -> [String: Any] {
        let requestId = UUID().uuidString
        let type = message["type"] as? String ?? "unknown"

        switch type {
        case "poll":
            return ["id": requestId, "method": "extension_poll"]

        case "result":
            var params: [String: Any] = [:]
            if let cmdId = message["id"] { params["requestId"] = cmdId }
            if let result = message["result"] { params["result"] = result }
            if let error = message["error"] { params["error"] = error }
            return ["id": requestId, "method": "extension_result", "params": params]

        case "status":
            return ["id": requestId, "method": "extension_status"]

        case "connected":
            return ["id": requestId, "method": "extension_connected"]

        case "disconnected":
            return ["id": requestId, "method": "extension_disconnected"]

        case "ping":
            return ["id": requestId, "method": "ping"]

        default:
            return ["id": requestId, "method": type, "params": message]
        }
    }

    private func returnResponse(_ response: [String: Any], context: NSExtensionContext) {
        let responseItem = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            responseItem.userInfo = [SFExtensionMessageKey: response]
        } else {
            responseItem.userInfo = ["message": response]
        }
        context.completeRequest(returningItems: [responseItem], completionHandler: nil)
    }
}
