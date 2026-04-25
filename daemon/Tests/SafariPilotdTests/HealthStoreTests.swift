import Foundation
import SafariPilotdCore

// NOTE: This project uses a custom CLT-only test harness (see main.swift) rather than
// XCTest — Swift Package Manager's XCTest discovery requires an Xcode test target that
// this package deliberately avoids. The assertions below preserve the semantics of the
// plan's XCTest fixtures: setUp creates a per-test temp directory, each test verifies
// one aspect of HealthStore's contract, tearDown cleans up.

func registerHealthStoreTests() {

    // Per-test temp-dir helper — mirrors XCTestCase.setUp/tearDown lifecycle.
    func makeTempHealthPath() -> (dir: URL, file: URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("safari-pilot-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return (dir, dir.appendingPathComponent("health.json"))
    }

    func cleanup(_ dir: URL) {
        try? FileManager.default.removeItem(at: dir)
    }

    test("testInitialAlarmTimestampIsNow") {
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }

        let before = Date()
        let store = HealthStore(persistPath: healthPath)
        try assertTrue(
            store.lastAlarmFireTimestamp.timeIntervalSince1970 >= before.timeIntervalSince1970 - 1,
            "lastAlarmFireTimestamp should default to ~now"
        )
    }

    test("testRecordAlarmFirePersists") {
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }

        let store = HealthStore(persistPath: healthPath)
        let t = Date(timeIntervalSinceNow: -30)
        store.recordAlarmFire(at: t)
        try assertTrue(
            abs(store.lastAlarmFireTimestamp.timeIntervalSince1970 - t.timeIntervalSince1970) < 0.01,
            "in-memory timestamp must match recorded value"
        )

        let store2 = HealthStore(persistPath: healthPath)
        try assertTrue(
            abs(store2.lastAlarmFireTimestamp.timeIntervalSince1970 - t.timeIntervalSince1970) < 0.01,
            "persisted timestamp must survive new instance"
        )
    }

    test("testRoundtripCountInMemoryOnly") {
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }

        let store = HealthStore(persistPath: healthPath)
        store.incrementRoundtrip()
        store.incrementRoundtrip()
        try assertEqual(store.roundtripCount1h, 2)

        let store2 = HealthStore(persistPath: healthPath)
        try assertEqual(store2.roundtripCount1h, 0, "roundtrip count must NOT persist across instances")
    }

    test("testForceReloadCount24hPersists") {
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }

        let store = HealthStore(persistPath: healthPath)
        store.incrementForceReload()
        store.incrementForceReload()

        let store2 = HealthStore(persistPath: healthPath)
        try assertEqual(store2.forceReloadCount24h, 2, "force-reload count must persist across instances")
    }

    test("testHttpBindFailureCountStartsAtZero") {
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        try assertEqual(store.httpBindFailureCount, 0)
    }

    test("testHttpBindFailureCountIncrementsAndPersists") {
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        store.recordHttpBindFailure()
        store.recordHttpBindFailure()
        try assertEqual(store.httpBindFailureCount, 2)

        // Verify persistence: create new store from same path
        let store2 = HealthStore(persistPath: healthPath)
        try assertEqual(store2.httpBindFailureCount, 2,
                        "httpBindFailureCount should survive daemon restart")
    }

    test("testHttpBindFailureCountSurvivesUnrelatedPersist") {
        // Critical: recordAlarmFire() and incrementForceReload() call persist().
        // If persist() doesn't pass httpBindFailureCount explicitly, the counter
        // resets to nil/0 because the Optional PersistedState field defaults to nil.
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        store.recordHttpBindFailure()
        try assertEqual(store.httpBindFailureCount, 1)

        // This calls persist() internally — must preserve httpBindFailureCount
        store.recordAlarmFire()

        let store2 = HealthStore(persistPath: healthPath)
        try assertEqual(store2.httpBindFailureCount, 1,
                        "httpBindFailureCount must survive recordAlarmFire persist")
    }

    test("testHttpRequestErrorCount1hRollingWindow") {
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        store.recordHttpRequestError()
        store.recordHttpRequestError()
        try assertEqual(store.httpRequestErrorCount1h, 2)
    }

    test("testCountersRollOffAfterWindow") {
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }

        let store = HealthStore(persistPath: healthPath)
        let oldTimestamp = Date(timeIntervalSinceNow: -7200)  // 2h past — well beyond the 1h window, robust to scheduling lag
        store.recordRoundtripAt(oldTimestamp)
        store.recordRoundtripAt(Date())
        try assertEqual(store.roundtripCount1h, 1, "roundtrips older than 1h should not count")
    }

    // MARK: - SD-11 coverage for recent-iteration API

    test("testRegisterSessionAddsToActiveCount") {
        // registerSession + activeSessionCount round-trip. Discrimination:
        // commenting out _activeSessions.append in registerSession leaves
        // the count at zero.
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        try assertEqual(store.activeSessionCount, 0)
        store.registerSession("sess_a")
        try assertEqual(store.activeSessionCount, 1)
        store.registerSession("sess_b")
        try assertEqual(store.activeSessionCount, 2)
    }

    test("testRegisterSessionDeduplicatesByIdAndUpdatesLastSeen") {
        // Re-registering the same sessionId must not create duplicates AND
        // must advance lastSeen (the second behaviour is the contract;
        // count alone is non-discriminating per upp:test-reviewer).
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        store.registerSession("sess_a")
        let firstSeen = store.lastSeenForSession("sess_a")
        try assertTrue(firstSeen != nil, "lastSeen must be set on first register")

        // Yield enough wall time for the second register's Date() to differ.
        Thread.sleep(forTimeInterval: 0.02)

        store.registerSession("sess_a")
        try assertEqual(store.activeSessionCount, 1,
                        "duplicate sessionId must not create duplicate entries")

        let secondSeen = store.lastSeenForSession("sess_a")
        try assertTrue(secondSeen != nil)
        try assertTrue(
            secondSeen! > firstSeen!,
            "duplicate registerSession must advance lastSeen, not silently no-op"
        )
    }

    test("testTouchSessionUpdatesExistingLastSeen") {
        // touchSession on a registered sessionId advances lastSeen (the
        // implicit heartbeat path used by /status). Discrimination:
        // commenting out the `_activeSessions[idx].lastSeen = Date()`
        // assignment leaves lastSeen unchanged.
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        store.registerSession("sess_a")
        let firstSeen = store.lastSeenForSession("sess_a")!

        Thread.sleep(forTimeInterval: 0.02)
        store.touchSession("sess_a")

        let secondSeen = store.lastSeenForSession("sess_a")!
        try assertTrue(secondSeen > firstSeen,
                       "touchSession on a registered id must advance lastSeen")
    }

    test("testTouchSessionDoesNotCreateNewEntry") {
        // touchSession on an unknown sessionId is a silent no-op (no
        // accidental session creation through a typoed heartbeat).
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        store.touchSession("never_registered")
        try assertEqual(store.activeSessionCount, 0,
                        "touchSession must not create new sessions for unknown ids")
        try assertTrue(store.lastSeenForSession("never_registered") == nil,
                       "lastSeenForSession must return nil for unregistered id")
    }

    test("testRecordKeepalivePingUpdatesTimestamp") {
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        try assertTrue(store.lastKeepalivePing == nil,
                       "initial lastKeepalivePing must be nil")
        let before = Date()
        store.recordKeepalivePing()
        let stamp = store.lastKeepalivePing
        try assertTrue(stamp != nil, "lastKeepalivePing must be set after recordKeepalivePing")
        try assertTrue(stamp!.timeIntervalSince1970 >= before.timeIntervalSince1970 - 0.5,
                       "lastKeepalivePing must be set to ~now")
    }

    test("testIsSessionAliveFalseBeforeAnyPing") {
        // No keepalive recorded → must return false even with a generous
        // timeout. The guard is on _lastKeepalivePing == nil.
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        try assertFalse(store.isSessionAlive(timeout: 60),
                        "isSessionAlive must be false when no ping has been recorded")
    }

    test("testIsSessionAliveTrueAfterRecentPing") {
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        store.recordKeepalivePing()
        try assertTrue(store.isSessionAlive(timeout: 60),
                       "isSessionAlive must be true within the timeout window")
    }

    test("testIsSessionAliveFalseWhenStale") {
        // Negative timeout makes the elapsed check (>= timeout) instantly
        // satisfy the stale condition. Discrimination: removing the
        // timeout comparison from isSessionAlive (always returns true
        // when lastKeepalivePing is non-nil) makes this fail.
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        store.recordKeepalivePing()
        try assertFalse(store.isSessionAlive(timeout: -1),
                        "isSessionAlive must be false when ping is older than timeout")
    }

    test("testRecordTcpCommandSetsMcpConnected") {
        // recordTcpCommand has the dual side effect of stamping the TCP
        // command timestamp AND flipping mcpConnected to true. This test
        // covers the connected-flip; the timestamp side effect is
        // observed indirectly via the next test.
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        try assertFalse(store.mcpConnected,
                        "mcpConnected must default to false")
        store.recordTcpCommand()
        try assertTrue(store.mcpConnected,
                       "mcpConnected must be true after recordTcpCommand")
    }

    test("testCheckMcpConnectionClearsWhenStale") {
        // Discrimination: removing the staleness branch from
        // checkMcpConnection leaves mcpConnected=true forever; this
        // test fails when that happens.
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        store.recordTcpCommand()
        try assertTrue(store.mcpConnected)
        // Negative timeout makes any prior command stale.
        store.checkMcpConnection(timeout: -1)
        try assertFalse(store.mcpConnected,
                        "checkMcpConnection must clear mcpConnected when ping is stale")
    }

    test("testCheckMcpConnectionPreservesWhenFresh") {
        // The other side: with a generous timeout, a recent recordTcpCommand
        // must NOT clear mcpConnected.
        //
        // SD-11 reviewer strengthening: pre-fix this test relied on
        // `recordTcpCommand` setting mcpConnected=true as a side effect,
        // making the assertion partly tautological vs the SUT path
        // checkMcpConnection actually exercises. We now `setMcpConnected(true)`
        // explicitly first AND `recordTcpCommand` separately — that proves
        // checkMcpConnection's branch reads the timestamp from
        // `_lastTcpCommandTimestamp`, not just observes existing
        // mcpConnected state.
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        store.setMcpConnected(true)
        store.recordTcpCommand()
        store.checkMcpConnection(timeout: 60)
        try assertTrue(store.mcpConnected,
                       "checkMcpConnection must NOT clear when ping is recent")
    }

    test("testSetMcpConnectedExplicitOverride") {
        // setMcpConnected lets external callers (e.g. the disconnect-
        // detection task) flip the flag directly.
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        store.setMcpConnected(true)
        try assertTrue(store.mcpConnected)
        store.setMcpConnected(false)
        try assertFalse(store.mcpConnected)
    }

    test("testMarkExecutedResultUpdatesTimestamp") {
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        try assertTrue(store.lastExecutedResultTimestamp == nil,
                       "initial lastExecutedResultTimestamp must be nil")
        let before = Date()
        store.markExecutedResult()
        let stamp = store.lastExecutedResultTimestamp
        try assertTrue(stamp != nil,
                       "lastExecutedResultTimestamp must be set after markExecutedResult")
        try assertTrue(stamp!.timeIntervalSince1970 >= before.timeIntervalSince1970 - 0.5,
                       "lastExecutedResultTimestamp must be ~now")
    }

    test("testRecordSessionServedFlipsTabActive") {
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }
        let store = HealthStore(persistPath: healthPath)
        try assertFalse(store.sessionTabActive,
                        "sessionTabActive must default to false")
        store.recordSessionServed()
        try assertTrue(store.sessionTabActive,
                       "sessionTabActive must be true after recordSessionServed")
    }

    // SD-23 RESOLVED: prune-cutoff transition tested via injected Clock.
    // The hardcoded -60s cutoff is now exercised by advancing a MockClock
    // forward and asserting the prune fires at exactly the threshold. A
    // regression that changed the cutoff to (say) -600s makes this test
    // fail because the session at lastSeen=now-90s is no longer past the
    // 600s cutoff.

    test("testPruneStaleSessionsLockedAt60sCutoff") {
        // Discrimination targets in pruneStaleSessionsLocked:
        //   1. The cutoff value (-60s) — bumping to -600s leaves sessions
        //      registered <600s ago active even past 60s.
        //   2. The use of clock.now() instead of Date() — without the
        //      injection, the test cannot advance time forward.
        //   3. The < comparison — flipping to <= or > would mis-classify
        //      sessions exactly at the boundary.
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }

        let mock = MockClock(start: Date())
        let store = HealthStore(persistPath: healthPath, clock: mock)

        // Register at mock-time T0.
        store.registerSession("sess-prune-1")
        try assertEqual(store.activeSessionCount, 1,
                        "session must be active immediately after register")

        // Advance mock-time by 30s (under threshold) — session stays.
        mock.advance(by: 30)
        try assertEqual(store.activeSessionCount, 1,
                        "session must still be active 30s post-register (under 60s threshold)")

        // Advance to mock-time T0+90s (past threshold) — session pruned.
        mock.advance(by: 60)  // total elapsed = 90s
        try assertEqual(
            store.activeSessionCount, 0,
            "session must be pruned at >60s post-register; cutoff is clock.now() - 60. "
                + "If non-zero, either the cutoff value drifted from -60s OR the prune is "
                + "still using Date() instead of clock.now()."
        )
    }

    test("testPruneStaleSessionsLockedTouchSessionResetsLastSeen") {
        // touchSession should reset lastSeen so the session is NOT pruned
        // even if registered long ago. Discrimination: removing the
        // touchSession call would let the session age out despite the
        // touch.
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }

        let mock = MockClock(start: Date())
        let store = HealthStore(persistPath: healthPath, clock: mock)

        store.registerSession("sess-touch-prune")
        mock.advance(by: 50)
        store.touchSession("sess-touch-prune")  // reset lastSeen at mock-T0+50s

        // Advance another 50s (total 100s post-register, but only 50s post-touch).
        mock.advance(by: 50)
        try assertEqual(
            store.activeSessionCount, 1,
            "touchSession must reset lastSeen — at mock-T0+100s, the session was "
                + "touched at T0+50s, so it's only 50s stale (under threshold)"
        )

        // Now advance past the post-touch threshold.
        mock.advance(by: 11)  // 61s post-touch
        try assertEqual(
            store.activeSessionCount, 0,
            "session must be pruned at 61s post-touch"
        )
    }
}

// MARK: - SD-23 test helper: MockClock

/// Test-only Clock that returns a controllable Date. Use `advance(by:)` to
/// move time forward without sleeping. Lives in the test target — not part
/// of the production surface.
final class MockClock: TimeSource, @unchecked Sendable {
    private var current: Date

    init(start: Date) {
        self.current = start
    }

    func now() -> Date {
        return current
    }

    /// Move time forward by `seconds`. Negative values move backward (rare
    /// but supported for completeness).
    func advance(by seconds: TimeInterval) {
        current = current.addingTimeInterval(seconds)
    }
}
