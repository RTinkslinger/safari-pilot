import Foundation

public final class ExtensionBridge: @unchecked Sendable {

    private static let defaultTimeout: TimeInterval = 90.0
    private static let executedLogTTL: TimeInterval = 300.0

    private let queue = DispatchQueue(label: "com.safari-pilot.extension-bridge", qos: .userInitiated)

    private var _isConnected: Bool = false

    private struct PendingCommand {
        let id: String
        let params: [String: AnyCodable]
        let continuation: CheckedContinuation<Response, Never>
        let timeoutTask: Task<Void, Never>
        var delivered: Bool = false
    }

    private struct WaitingPoll {
        let id: String
        let continuation: CheckedContinuation<Response, Never>
        let timeoutTask: Task<Void, Never>
    }

    private struct ExecutedEntry {
        let commandID: String
        let timestamp: Date
    }

    private var pendingCommands: [PendingCommand] = []
    private var waitingPolls: [WaitingPoll] = []
    private var executedLog: [ExecutedEntry] = []
    private var _ipcMechanism: String = "none"

    /// Optional HealthStore reference for keepalive ping recording.
    /// Set after init via `setHealthStore(_:)` to avoid circular initialisation.
    private weak var _keepaliveStore: HealthStore?

    public var isExtensionConnected: Bool {
        queue.sync { _isConnected }
    }

    public init() {}

    /// Wire up a HealthStore so keepalive sentinels can update `lastKeepalivePing`.
    public func setHealthStore(_ store: HealthStore) {
        queue.sync { _keepaliveStore = store }
    }

    /// Check if a command ID exists in the executed log (pruning expired entries first).
    public func isInExecutedLog(_ commandID: String) -> Bool {
        queue.sync {
            pruneExpiredEntries()
            return executedLog.contains(where: { $0.commandID == commandID })
        }
    }

    /// Test-only: insert an entry with a specific timestamp for TTL testing.
    public func addToExecutedLogForTest(commandID: String, at timestamp: Date) {
        queue.sync {
            executedLog.append(ExecutedEntry(commandID: commandID, timestamp: timestamp))
        }
    }

    /// Set the IPC mechanism label (e.g. "none", "tcp", "http") for health reporting.
    public func setIpcMechanism(_ mechanism: String) {
        queue.sync {
            _ipcMechanism = mechanism
        }
    }

    /// Remove entries older than the TTL. Must be called under `queue.sync`.
    private func pruneExpiredEntries() {
        let cutoff = Date().addingTimeInterval(-Self.executedLogTTL)
        executedLog.removeAll(where: { $0.timestamp < cutoff })
    }

    public func handleConnected(commandID: String) -> Response {
        queue.sync { _isConnected = true }
        Logger.info("Extension connected.")
        return Response.success(id: commandID, value: AnyCodable("extension_ack"))
    }

    /// Event-page wake semantics: flip `delivered=true → false` for unacked commands
    /// so the next poll redelivers them. Never cancel pending commands on disconnect —
    /// the event page unloads aggressively and will wake + poll shortly.
    /// Waiting long-polls are resolved with an empty commands array and cleared.
    public func handleDisconnected(commandID: String) -> Response {
        // Take snapshot under the queue; resume continuations outside.
        let pollsToResolve: [WaitingPoll] = queue.sync {
            _isConnected = false

            var flippedCount = 0
            for idx in pendingCommands.indices where pendingCommands[idx].delivered {
                pendingCommands[idx].delivered = false
                flippedCount += 1
            }

            let snapshot = waitingPolls
            waitingPolls.removeAll()

            Logger.info("Extension disconnected. Flipped delivered=false for \(flippedCount) unacked command(s); cleared \(snapshot.count) waiting poll(s).")
            return snapshot
        }

        for wp in pollsToResolve {
            wp.timeoutTask.cancel()
            wp.continuation.resume(returning: Response.success(
                id: wp.id,
                value: AnyCodable(["commands": [[String: Any]]()])
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

            // Append the command; if a poll is already waiting, fast-path by marking
            // the command delivered and preparing to wake the poll. All mutations
            // under the queue; continuations resumed outside.
            typealias FastPathResult = (waitingPoll: WaitingPoll, commandDict: [String: Any])
            let (fastPath, queuedCount): (FastPathResult?, Int) = queue.sync {
                pendingCommands.append(PendingCommand(
                    id: commandID,
                    params: params,
                    continuation: continuation,
                    timeoutTask: timeoutTask,
                    delivered: false
                ))

                let count = pendingCommands.count

                guard !waitingPolls.isEmpty else { return (nil, count) }

                let wp = waitingPolls.removeFirst()

                // Mark this just-queued command as delivered.
                if let idx = pendingCommands.firstIndex(where: { $0.id == commandID }) {
                    pendingCommands[idx].delivered = true
                }

                var commandDict: [String: Any] = ["id": commandID]
                for (key, val) in params {
                    commandDict[key] = val.value
                }
                return ((waitingPoll: wp, commandDict: commandDict), count)
            }

            Trace.emit(commandID, layer: "daemon-bridge", event: "bridge_queued", data: [
                "pendingCount": queuedCount,
            ])

            if let fp = fastPath {
                fp.waitingPoll.timeoutTask.cancel()
                fp.waitingPoll.continuation.resume(returning: Response.success(
                    id: fp.waitingPoll.id,
                    value: AnyCodable(["commands": [fp.commandDict]])
                ))
            }
        }
    }

    /// Drains ALL currently undelivered commands and marks them delivered=true.
    /// If none are pending and `waitTimeout > 0`, suspends as a WaitingPoll and
    /// resolves when `handleExecute` wakes it (fast path) or on timeout with `{commands: []}`.
    /// With `waitTimeout == 0`, returns `{commands: []}` synchronously when empty.
    public func handlePoll(commandID: String, waitTimeout: TimeInterval = 0.0) async -> Response {
        let pendingCount = queue.sync { pendingCommands.count }
        Logger.info("POLL: commandID=\(commandID) pendingCount=\(pendingCount) waitTimeout=\(waitTimeout)")
        let collected: [[String: Any]] = queue.sync {
            var results: [[String: Any]] = []
            for idx in pendingCommands.indices where !pendingCommands[idx].delivered {
                pendingCommands[idx].delivered = true

                let cmd = pendingCommands[idx]
                var commandDict: [String: Any] = ["id": cmd.id]
                for (key, val) in cmd.params {
                    commandDict[key] = val.value
                }
                results.append(commandDict)
            }
            return results
        }

        if !collected.isEmpty {
            Trace.emit(collected.first?["id"] as? String ?? "poll", layer: "daemon-bridge", event: "extension_polled", data: [
                "deliveredCount": collected.count,
            ])
            return Response.success(id: commandID, value: AnyCodable(["commands": collected]))
        }

        if waitTimeout <= 0 {
            return Response.success(id: commandID, value: AnyCodable(["commands": [[String: Any]]()]))
        }

        // Long-poll: suspend until a new execute arrives OR waitTimeout elapses.
        return await withCheckedContinuation { (continuation: CheckedContinuation<Response, Never>) in
            let timeoutTask = Task {
                try? await Task.sleep(nanoseconds: UInt64(waitTimeout * 1_000_000_000))
                guard !Task.isCancelled else { return }

                let stillWaiting: Bool = self.queue.sync {
                    if let idx = self.waitingPolls.firstIndex(where: { $0.id == commandID }) {
                        self.waitingPolls.remove(at: idx)
                        return true
                    }
                    return false
                }
                if stillWaiting {
                    continuation.resume(returning: Response.success(
                        id: commandID,
                        value: AnyCodable(["commands": [[String: Any]]()])
                    ))
                }
            }

            queue.sync {
                waitingPolls.append(WaitingPoll(
                    id: commandID,
                    continuation: continuation,
                    timeoutTask: timeoutTask
                ))
            }
        }
    }

    public func handleResult(commandID: String, params: [String: AnyCodable]) -> Response {
        // Handle keepalive sentinel — update lastKeepalivePing, no continuation to resume.
        // Must be checked BEFORE __trace__ since keepalive is the most frequent sentinel.
        if let requestId = params["requestId"]?.value as? String, requestId == "__keepalive__" {
            _keepaliveStore?.recordKeepalivePing()
            Trace.emit(commandID, layer: "daemon-bridge", event: "keepalive_received", data: [:])
            return Response.success(id: commandID, value: AnyCodable("ok"))
        }

        // Handle extension trace events — route to daemon-trace.ndjson, not to a continuation
        if let requestId = params["requestId"]?.value as? String, requestId == "__trace__" {
            if let result = params["result"]?.value as? [String: Any],
               let traceType = result["type"] as? String, traceType == "trace",
               let traceId = result["id"] as? String,
               let layer = result["layer"] as? String,
               let event = result["event"] as? String {
                let data = result["data"] as? [String: Any] ?? [:]
                Trace.emit(traceId, layer: layer, event: event, data: data)
            }
            return Response.success(id: commandID, value: AnyCodable("ok"))
        }

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

        // Check for top-level error (direct error reporting)
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
        }
        // Check for error nested inside result (background.js sends {result: {ok:false, error:{...}}})
        else if let resultParam = params["result"],
                let resultDict = resultParam.value as? [String: Any],
                let ok = resultDict["ok"] as? Bool, !ok,
                let errorObj = resultDict["error"] as? [String: Any] {
            let msg = errorObj["message"] as? String ?? "Extension script error"
            let name = errorObj["name"] as? String ?? "EXTENSION_ERROR"
            callerResponse = Response.failure(
                id: cmd.id,
                error: StructuredError(
                    code: name,
                    message: msg,
                    retryable: true
                )
            )
        }
        // Unwrap success: background.js sends {result: {ok:true, value:<jsResult>, _meta:{...}}}
        // Extract the inner value. If _meta is present (tab identity), wrap as
        // {"value": innerValue, "_meta": meta} so ExtensionEngine can extract it.
        // If _meta is absent (old extension), return innerValue directly (backward compat).
        else if let resultParam = params["result"],
                let resultDict = resultParam.value as? [String: Any],
                let ok = resultDict["ok"] as? Bool, ok {
            // Preserve null/nil faithfully — don't convert to empty string
            let innerValue = resultDict["value"] as Any? ?? NSNull()
            if let meta = resultDict["_meta"] as? [String: Any] {
                // Pass through _meta alongside the value in a wrapper object.
                // ExtensionEngine detects this wrapper via the "_meta" key presence.
                callerResponse = Response.success(
                    id: cmd.id,
                    value: AnyCodable(["value": innerValue, "_meta": meta])
                )
            } else {
                callerResponse = Response.success(id: cmd.id, value: AnyCodable(innerValue))
            }
        } else {
            let resultValue: AnyCodable
            if let resultParam = params["result"] {
                resultValue = resultParam
            } else {
                resultValue = AnyCodable("")
            }
            callerResponse = Response.success(id: cmd.id, value: resultValue)
        }

        let hasMeta = (params["result"]?.value as? [String: Any])?["_meta"] != nil
        Trace.emit(cmd.id, layer: "daemon-bridge", event: "bridge_result", data: [
            "ok": callerResponse.ok,
            "hasMeta": hasMeta,
        ])

        cmd.continuation.resume(returning: callerResponse)

        // Record in executedLog for reconcile (prune expired entries while we're here)
        queue.sync {
            pruneExpiredEntries()
            executedLog.append(ExecutedEntry(commandID: cmd.id, timestamp: Date()))
        }

        return Response.success(id: commandID, value: AnyCodable("extension_ack"))
    }

    /// Reconcile extension-reported command state against daemon-internal state.
    /// Classifies IDs into 5 categories without resuming any continuations
    /// (read-only classification, except marking pushNew commands as delivered).
    ///
    /// - **acked**: executedId found in executedLog (daemon already processed result)
    /// - **uncertain**: executedId NOT in executedLog AND NOT in pendingCommands
    /// - **reQueued**: pendingId is in pendingCommands with delivered=false
    /// - **inFlight**: pendingId is in pendingCommands with delivered=true
    /// - **pushNew**: undelivered pendingCommand NOT known to extension AND NOT reQueued → deliver
    public func handleReconcile(
        commandID: String,
        executedIds: [String],
        pendingIds: [String]
    ) -> Response {
        let result: [String: Any] = queue.sync {
            pruneExpiredEntries()

            var acked: [String] = []
            var uncertain: [String] = []
            var reQueued: [String] = []
            var inFlight: [String] = []
            var pushNew: [[String: Any]] = []

            // Classify executedIds
            for eid in executedIds {
                if executedLog.contains(where: { $0.commandID == eid }) {
                    acked.append(eid)
                } else if pendingCommands.contains(where: { $0.id == eid }) {
                    // Still pending — not uncertain, just not yet completed
                    // This shouldn't normally happen (extension says executed but daemon still has it pending),
                    // but classify as uncertain since daemon didn't process the result
                    uncertain.append(eid)
                } else {
                    uncertain.append(eid)
                }
            }

            // Classify pendingIds
            let pendingIdSet = Set(pendingIds)
            for pid in pendingIds {
                if let cmd = pendingCommands.first(where: { $0.id == pid }) {
                    if cmd.delivered {
                        inFlight.append(pid)
                    } else {
                        reQueued.append(pid)
                    }
                }
                // If pid not in pendingCommands at all, extension has stale state — ignore
            }

            // Collect reQueued IDs for exclusion from pushNew
            let reQueuedSet = Set(reQueued)

            // pushNew: undelivered commands NOT in extension's known IDs AND NOT reQueued
            for idx in pendingCommands.indices where !pendingCommands[idx].delivered {
                let cid = pendingCommands[idx].id
                if !pendingIdSet.contains(cid) && !reQueuedSet.contains(cid) {
                    // Mark delivered and serialize for push
                    pendingCommands[idx].delivered = true

                    var commandDict: [String: Any] = ["id": cid]
                    for (key, val) in pendingCommands[idx].params {
                        commandDict[key] = val.value
                    }
                    pushNew.append(commandDict)
                }
            }

            return [
                "acked": acked,
                "uncertain": uncertain,
                "reQueued": reQueued,
                "inFlight": inFlight,
                "pushNew": pushNew,
            ]
        }

        return Response.success(id: commandID, value: AnyCodable(result))
    }

    public func handleStatus(commandID: String) -> Response {
        let connected = isExtensionConnected
        return Response.success(
            id: commandID,
            value: AnyCodable(connected ? "connected" : "disconnected")
        )
    }

    /// Composite health snapshot: bridge-internal state + HealthStore counters.
    ///
    /// IMPORTANT: HealthStore access must NOT be nested inside `queue.sync` on this
    /// bridge — HealthStore has its own serial queue and cross-queue synchronous
    /// nesting risks deadlock if the two ever need to coordinate. We read
    /// `pendingCommands.count` under our own queue.sync, then read HealthStore values
    /// outside. Both stores are thread-safe on their own.
    public func healthSnapshot(store: HealthStore) -> [String: Any] {
        // Bridge-internal state: read under our queue.
        let (connected, pendingCount, logSize, ipcMech) = queue.sync {
            pruneExpiredEntries()
            return (_isConnected, pendingCommands.count, executedLog.count, _ipcMechanism)
        }

        // HealthStore access outside our queue — it serialises on its own queue.
        let alarmMs = store.lastAlarmFireTimestamp.timeIntervalSince1970 * 1000
        let reconcileMs: Any = store.lastReconcileTimestamp.map {
            $0.timeIntervalSince1970 * 1000
        } ?? NSNull()
        let execResultMs: Any = store.lastExecutedResultTimestamp.map {
            $0.timeIntervalSince1970 * 1000
        } ?? NSNull()

        return [
            "isConnected": connected,
            "mcpConnected": store.mcpConnected,
            "lastAlarmFireTimestamp": alarmMs,
            "lastReconcileTimestamp": reconcileMs,
            "lastExecutedResultTimestamp": execResultMs,
            "roundtripCount1h": store.roundtripCount1h,
            "timeoutCount1h": store.timeoutCount1h,
            "uncertainCount1h": store.uncertainCount1h,
            "forceReloadCount24h": store.forceReloadCount24h,
            "httpBindFailureCount": store.httpBindFailureCount,
            "httpRequestErrorCount1h": store.httpRequestErrorCount1h,
            "pendingCommandsCount": pendingCount,
            "executedLogSize": logSize,
            "ipcMechanism": ipcMech,
            "claimedByProfiles": [] as [String],
            "engineCircuitBreakerState": "closed",
            "killSwitchActive": false,
        ]
    }
}
