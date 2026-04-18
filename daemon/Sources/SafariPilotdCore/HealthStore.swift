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

    // In-memory: resets on daemon restart
    private var roundtripTimestamps: [Date] = []
    private var timeoutTimestamps: [Date] = []
    private var uncertainTimestamps: [Date] = []
    private var _lastReconcileTimestamp: Date? = nil
    public var lastReconcileTimestamp: Date? {
        queue.sync { _lastReconcileTimestamp }
    }
    private var _lastExecutedResultTimestamp: Date? = nil
    public var lastExecutedResultTimestamp: Date? {
        queue.sync { _lastExecutedResultTimestamp }
    }

    public init(persistPath: URL) {
        self.persistPath = persistPath
        self._lastAlarmFireTimestamp = Date()  // default: init = Date.now()

        if let data = try? Data(contentsOf: persistPath),
           let decoded = try? JSONDecoder().decode(PersistedState.self, from: data) {
            self._lastAlarmFireTimestamp = decoded.lastAlarmFireTimestamp
            self.forceReloadTimestamps = decoded.forceReloadTimestamps
        }
    }

    public var roundtripCount1h: Int { queue.sync { countInWindow(roundtripTimestamps, seconds: 3600) } }
    public var timeoutCount1h: Int { queue.sync { countInWindow(timeoutTimestamps, seconds: 3600) } }
    public var uncertainCount1h: Int { queue.sync { countInWindow(uncertainTimestamps, seconds: 3600) } }
    public var forceReloadCount24h: Int { queue.sync { countInWindow(forceReloadTimestamps, seconds: 86400) } }

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

    private func countInWindow(_ ts: [Date], seconds: TimeInterval) -> Int {
        let cutoff = Date(timeIntervalSinceNow: -seconds)
        return ts.filter { $0 >= cutoff }.count
    }

    private func persist() {
        let state = PersistedState(
            lastAlarmFireTimestamp: _lastAlarmFireTimestamp,
            forceReloadTimestamps: forceReloadTimestamps.filter {
                $0 >= Date(timeIntervalSinceNow: -86400)
            }
        )
        if let data = try? JSONEncoder().encode(state) {
            try? data.write(to: persistPath, options: .atomic)
        }
    }

    private struct PersistedState: Codable {
        let lastAlarmFireTimestamp: Date
        let forceReloadTimestamps: [Date]
    }
}
