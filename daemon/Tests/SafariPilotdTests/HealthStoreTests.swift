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

    test("testCountersRollOffAfterWindow") {
        let (dir, healthPath) = makeTempHealthPath()
        defer { cleanup(dir) }

        let store = HealthStore(persistPath: healthPath)
        let oldTimestamp = Date(timeIntervalSinceNow: -7200)  // 2h past — well beyond the 1h window, robust to scheduling lag
        store.recordRoundtripAt(oldTimestamp)
        store.recordRoundtripAt(Date())
        try assertEqual(store.roundtripCount1h, 1, "roundtrips older than 1h should not count")
    }
}
