import Foundation
import SafariPilotdCore

func registerTraceTests() {
    print("")
    print("Trace Tests")
    print("-----------")

    // T26: concurrent writers must not corrupt the NDJSON trace file.
    //
    // Production has three queue contexts that all funnel into Trace.emit:
    // CommandDispatcher's stdin loop, ExtensionBridge's HTTP poll handlers,
    // ExtensionHTTPServer's request handlers. The previous implementation
    // performed seekToEndOfFile() and write() as two unsynchronized syscalls
    // on a shared FileHandle, so two concurrent emit() calls could either
    // overwrite one another's bytes or interleave fragments mid-line.
    //
    // This test stresses Trace.writeLine — the same primitive emit() uses
    // internally — with 1000 concurrent writers. With proper serialization
    // every call appends one intact line; without it the file ends up with
    // fewer lines than iterations and/or invalid JSON in some lines.

    // On a single-core sandbox `DispatchQueue.concurrentPerform` serializes
    // its workers, which trivially passes regardless of locking. Skip rather
    // than report false confidence.
    let cores = ProcessInfo.processInfo.activeProcessorCount
    guard cores > 1 else {
        print("  SKIP  testWriteLineSerializesConcurrentWrites — needs >1 core (have \(cores))")
        return
    }

    test("testWriteLineSerializesConcurrentWrites") {
        let tempDir = NSTemporaryDirectory() + "trace-tests-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: tempDir) }

        let tracePath = tempDir + "/trace.ndjson"
        FileManager.default.createFile(atPath: tracePath, contents: nil)
        guard let handle = FileHandle(forWritingAtPath: tracePath) else {
            throw TestFailure("Could not open temp trace file at \(tracePath)")
        }

        let iterations = 1000

        // ~150-byte payload widens the seek/write race window — two syscalls
        // per iteration with non-trivial work between them maximises observable
        // interleaving on a fast multi-core machine when the lock is absent.
        DispatchQueue.concurrentPerform(iterations: iterations) { i in
            let line = "{\"id\":\"trace-\(i)\",\"layer\":\"test\",\"data\":\""
                + String(repeating: "x", count: 100) + "\"}\n"
            guard let data = line.data(using: .utf8) else {
                fatalError("UTF-8 encoding failed for iteration \(i)")
            }
            Trace.writeLine(data, to: handle)
        }
        try? handle.synchronize()
        try? handle.close()

        guard let raw = try? String(contentsOfFile: tracePath, encoding: .utf8) else {
            throw TestFailure("Could not read trace file back from \(tracePath)")
        }
        let lines = raw.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)

        try assertEqual(
            lines.count,
            iterations,
            "Line count must match iteration count — \(iterations - lines.count) writes lost or overlapping (raw size: \(raw.count) bytes)"
        )

        var seenIds = Set<String>()
        for (idx, line) in lines.enumerated() {
            guard let lineData = line.data(using: .utf8) else {
                throw TestFailure("Line \(idx) not UTF-8")
            }
            guard let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else {
                throw TestFailure("Line \(idx) is not valid JSON: \(line.prefix(120))")
            }
            guard let id = obj["id"] as? String else {
                throw TestFailure("Line \(idx) missing 'id' field: \(line.prefix(120))")
            }
            seenIds.insert(id)
        }

        try assertEqual(
            seenIds.count,
            iterations,
            "Each iteration must produce one unique id — id collisions imply overlapping writes mid-line"
        )
    }
}
