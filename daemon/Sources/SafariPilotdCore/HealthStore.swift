import Foundation

public final class HealthStore: @unchecked Sendable {
    private let persistPath: URL
    private let queue = DispatchQueue(label: "com.safari-pilot.health-store")

    // Persisted: survives daemon restart
    private var _lastAlarmFireTimestamp: Date
    public var lastAlarmFireTimestamp: Date {
        queue.sync { _lastAlarmFireTimestamp }
    }
    private var forceReloadTimestamps: [Date] = []
    private var _httpBindFailureCount: Int = 0

    // In-memory: resets on daemon restart
    private var roundtripTimestamps: [Date] = []
    private var timeoutTimestamps: [Date] = []
    private var uncertainTimestamps: [Date] = []
    private var httpRequestErrorTimestamps: [Date] = []
    private var _lastReconcileTimestamp: Date? = nil
    public var lastReconcileTimestamp: Date? {
        queue.sync { _lastReconcileTimestamp }
    }
    private var _lastExecutedResultTimestamp: Date? = nil
    public var lastExecutedResultTimestamp: Date? {
        queue.sync { _lastExecutedResultTimestamp }
    }

    // Session-tab tracking: resets on daemon restart
    private var _sessionTabActive: Bool = false
    public var sessionTabActive: Bool {
        queue.sync { _sessionTabActive }
    }
    private var _lastKeepalivePing: Date? = nil
    public var lastKeepalivePing: Date? {
        queue.sync { _lastKeepalivePing }
    }
    private var _mcpConnected: Bool = false
    public var mcpConnected: Bool {
        queue.sync { _mcpConnected }
    }

    // Session registry: tracks active MCP sessions
    private var _activeSessions: [(sessionId: String, lastSeen: Date)] = []
    public var activeSessionCount: Int {
        queue.sync {
            pruneStaleSessionsLocked()
            return _activeSessions.count
        }
    }

    public init(persistPath: URL) {
        self.persistPath = persistPath
        self._lastAlarmFireTimestamp = Date()  // default: init = Date.now()

        if let data = try? Data(contentsOf: persistPath),
           let decoded = try? JSONDecoder().decode(PersistedState.self, from: data) {
            self._lastAlarmFireTimestamp = decoded.lastAlarmFireTimestamp
            self.forceReloadTimestamps = decoded.forceReloadTimestamps
            self._httpBindFailureCount = decoded.httpBindFailureCount ?? 0
        }
    }

    public var roundtripCount1h: Int { queue.sync { countInWindow(roundtripTimestamps, seconds: 3600) } }
    public var timeoutCount1h: Int { queue.sync { countInWindow(timeoutTimestamps, seconds: 3600) } }
    public var uncertainCount1h: Int { queue.sync { countInWindow(uncertainTimestamps, seconds: 3600) } }
    public var forceReloadCount24h: Int { queue.sync { countInWindow(forceReloadTimestamps, seconds: 86400) } }
    public var httpBindFailureCount: Int { queue.sync { _httpBindFailureCount } }
    public var httpRequestErrorCount1h: Int { queue.sync { countInWindow(httpRequestErrorTimestamps, seconds: 3600) } }

    public func recordAlarmFire(at date: Date = Date()) {
        queue.sync {
            self._lastAlarmFireTimestamp = date
            self.persist()
        }
    }

    public func incrementRoundtrip() { queue.sync { roundtripTimestamps.append(Date()) } }
    public func incrementTimeout() { queue.sync { timeoutTimestamps.append(Date()) } }
    public func incrementUncertain() { queue.sync { uncertainTimestamps.append(Date()) } }

    public func recordRoundtripAt(_ date: Date) { queue.sync { roundtripTimestamps.append(date) } }

    public func incrementForceReload() {
        queue.sync {
            forceReloadTimestamps.append(Date())
            persist()
        }
    }

    public func markReconcile() { queue.sync { _lastReconcileTimestamp = Date() } }
    public func markExecutedResult() { queue.sync { _lastExecutedResultTimestamp = Date() } }

    public func recordSessionServed() { queue.sync { _sessionTabActive = true } }
    public func recordKeepalivePing() { queue.sync { _lastKeepalivePing = Date() } }
    public func setMcpConnected(_ connected: Bool) { queue.sync { _mcpConnected = connected } }

    // MARK: - MCP connection heartbeat

    private var _lastTcpCommandTimestamp: Date? = nil

    /// Called on every inbound TCP command. Marks MCP as connected.
    public func recordTcpCommand() {
        queue.sync {
            _lastTcpCommandTimestamp = Date()
            _mcpConnected = true
        }
    }

    /// Called periodically (e.g. every 10s from the disconnect-detection task).
    /// Clears `mcpConnected` if no TCP command has been received within `timeout` seconds.
    public func checkMcpConnection(timeout: TimeInterval = 30) {
        queue.sync {
            if let last = _lastTcpCommandTimestamp, Date().timeIntervalSince(last) > timeout {
                _mcpConnected = false
            }
        }
    }

    /// Returns true if a keepalive ping was received within `timeout` seconds.
    /// Returns false if no ping has ever been recorded or the last ping is stale.
    public func isSessionAlive(timeout: TimeInterval = 60) -> Bool {
        queue.sync {
            guard let last = _lastKeepalivePing else { return false }
            return Date().timeIntervalSince(last) < timeout
        }
    }

    public func recordHttpBindFailure() {
        queue.sync {
            _httpBindFailureCount += 1
            persist()
        }
    }

    public func recordHttpRequestError() {
        queue.sync { httpRequestErrorTimestamps.append(Date()) }
    }

    // MARK: - Session registry

    /// Register an MCP session. If sessionId already exists, update lastSeen.
    public func registerSession(_ sessionId: String) {
        queue.sync {
            if let idx = _activeSessions.firstIndex(where: { $0.sessionId == sessionId }) {
                _activeSessions[idx].lastSeen = Date()
            } else {
                _activeSessions.append((sessionId: sessionId, lastSeen: Date()))
            }
            Logger.info("Session registered: \(sessionId) (total: \(_activeSessions.count))")
        }
    }

    /// Update lastSeen for a session (called on each /status check as implicit heartbeat).
    public func touchSession(_ sessionId: String) {
        queue.sync {
            if let idx = _activeSessions.firstIndex(where: { $0.sessionId == sessionId }) {
                _activeSessions[idx].lastSeen = Date()
            }
        }
    }

    /// Remove sessions not seen in 60s.
    private func pruneStaleSessionsLocked() {
        let cutoff = Date(timeIntervalSinceNow: -60)
        _activeSessions.removeAll(where: { $0.lastSeen < cutoff })
    }

    private func countInWindow(_ ts: [Date], seconds: TimeInterval) -> Int {
        let cutoff = Date(timeIntervalSinceNow: -seconds)
        return ts.filter { $0 >= cutoff }.count
    }

    private func persist() {
        let state = PersistedState(
            lastAlarmFireTimestamp: _lastAlarmFireTimestamp,
            forceReloadTimestamps: forceReloadTimestamps.filter {
                $0 >= Date(timeIntervalSinceNow: -86400)
            },
            httpBindFailureCount: _httpBindFailureCount
        )
        if let data = try? JSONEncoder().encode(state) {
            try? data.write(to: persistPath, options: .atomic)
        }
    }

    private struct PersistedState: Codable {
        let lastAlarmFireTimestamp: Date
        let forceReloadTimestamps: [Date]
        var httpBindFailureCount: Int?
    }
}
