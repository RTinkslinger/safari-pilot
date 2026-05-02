import Foundation
import SafariPilotdCore

func registerFileStagingStoreTests() {

    test("testStageAndPeekReturnsBytes") {
        let store = FileStagingStore()
        let bytes = Data([0x01, 0x02, 0x03, 0x04])
        let token = "deadbeef"
        syncAwait {
            await store.stage(token: token, file: StagedFile(bytes: bytes, mimeType: "application/octet-stream", expiresAt: Date(timeIntervalSinceNow: 60)))
        }
        let peeked = syncAwait { await store.peek(token: token) }
        try assertTrue(peeked != nil, "peek should return staged file")
        try assertEqual(peeked?.bytes, bytes)
    }

    test("testPeekDoesNotRemove") {
        let store = FileStagingStore()
        let token = "abc"
        syncAwait {
            await store.stage(token: token, file: StagedFile(bytes: Data([1]), mimeType: "x", expiresAt: Date(timeIntervalSinceNow: 60)))
        }
        _ = syncAwait { await store.peek(token: token) }
        let again = syncAwait { await store.peek(token: token) }
        try assertTrue(again != nil, "peek must NOT remove the entry — DELETE does")
    }

    test("testReleaseRemovesEntry") {
        let store = FileStagingStore()
        let token = "to-release"
        syncAwait {
            await store.stage(token: token, file: StagedFile(bytes: Data([1]), mimeType: "x", expiresAt: Date(timeIntervalSinceNow: 60)))
        }
        syncAwait { await store.release(token: token) }
        let peeked = syncAwait { await store.peek(token: token) }
        try assertTrue(peeked == nil, "entry should be gone after release")
    }

    test("testReleaseOnMissingTokenIsBenign") {
        let store = FileStagingStore()
        // DELETE on already-evicted token — should not crash; daemon returns 404 to extension.
        syncAwait { await store.release(token: "never-existed") }
        // No assertion — just verify no crash.
    }

    test("testEvictExpiredRemovesPastDueEntries") {
        let store = FileStagingStore()
        let now = Date()
        syncAwait {
            await store.stage(token: "future", file: StagedFile(bytes: Data([1]), mimeType: "x", expiresAt: now.addingTimeInterval(60)))
            await store.stage(token: "past", file: StagedFile(bytes: Data([1]), mimeType: "x", expiresAt: now.addingTimeInterval(-1)))
        }
        let evicted = syncAwait { await store.evictExpired(now: now) }
        try assertEqual(evicted, 1)
        let stillThere = syncAwait { await store.peek(token: "future") }
        try assertTrue(stillThere != nil, "future entry should still be present")
        let gone = syncAwait { await store.peek(token: "past") }
        try assertTrue(gone == nil, "past entry should have been evicted")
    }

    test("testConcurrentStageDoesNotCorrupt") {
        let store = FileStagingStore()
        // Fan out 50 concurrent stages, each with a distinct token; verify all land.
        syncAwait {
            await withTaskGroup(of: Void.self) { group in
                for i in 0..<50 {
                    group.addTask {
                        await store.stage(
                            token: "tok-\(i)",
                            file: StagedFile(
                                bytes: Data([UInt8(i)]),
                                mimeType: "x",
                                expiresAt: Date(timeIntervalSinceNow: 60)
                            )
                        )
                    }
                }
            }
        }
        var allPresent = true
        for i in 0..<50 {
            let entry = syncAwait { await store.peek(token: "tok-\(i)") }
            if entry?.bytes != Data([UInt8(i)]) {
                allPresent = false
                break
            }
        }
        try assertTrue(allPresent, "all 50 concurrent stages should be retrievable with correct bytes")
    }
}
