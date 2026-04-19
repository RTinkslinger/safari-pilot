# v0.1.6 Ship Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild all binary artifacts, add test result capture infrastructure, harden HTTP observability, and create a GitHub Release draft for v0.1.6.

**Architecture:** Optimized sequential pipeline: observability code changes first (compile-gated), then single rebuild incorporating all changes, then test capture config. Three subsystems (C→A→B) executed as one pipeline to avoid double-building the daemon.

**Tech Stack:** Swift 5.9 (Hummingbird 2.x), TypeScript (vitest 2.1.9), Bash scripts, `gh` CLI

**Spec:** `docs/upp/specs/2026-04-18-v016-ship-readiness-design.md` (v4, 3 adversarial audit rounds, 40 findings addressed)

---

## File Structure

| File | Action | Subsystem | Responsibility |
|------|--------|-----------|----------------|
| `daemon/Sources/SafariPilotdCore/HealthStore.swift` | Modify | C | HTTP error counters (persisted + rolling) |
| `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` | Modify | C | onServerRunning callback, error counting in jsonResponse |
| `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` | Modify | C | Wire new health fields into healthSnapshot |
| `daemon/Sources/SafariPilotd/main.swift` | Modify | C+A | Wire callbacks + self-test in onReady |
| `daemon/Tests/SafariPilotdTests/HealthStoreTests.swift` | Modify | C | Tests for new HTTP counters |
| `daemon/Tests/SafariPilotdTests/ExtensionHTTPServerTests.swift` | Modify | C | Test for onReady callback |
| `src/index.ts` | Modify | A | Fix version 0.1.4 → 0.1.6 |
| `scripts/verify-artifact-integrity.sh` | Modify | A | Add HTTP-specific artifact checks |
| `scripts/health-check.sh` | Modify | C | Parse new health fields + breach thresholds |
| `vitest.config.ts` | Modify | B | Add junit + json reporters + globalSetup |
| `test/setup-retention.ts` | Create | B | Retention teardown (prune to last 10 files) |
| `.gitignore` | Modify | B | Add test-results/ |
| `ARCHITECTURE.md` | Modify | A | Document new health fields + test capture |
| `CLAUDE.md` | Modify | A | Update test count |

---

## Task 0: HealthStore HTTP Error Counters (TDD)

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/HealthStore.swift`
- Test: `daemon/Tests/SafariPilotdTests/HealthStoreTests.swift`

- [ ] **Step 0.1: Write failing tests for httpBindFailureCount**

Add to `registerHealthStoreTests()` in `daemon/Tests/SafariPilotdTests/HealthStoreTests.swift`:

```swift
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
```

- [ ] **Step 0.2: Run tests to verify they fail**

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
swift build --package-path daemon 2>&1 | tail -5
```

Expected: FAIL — `httpBindFailureCount`, `recordHttpBindFailure`, `recordHttpRequestError`, `httpRequestErrorCount1h` not found.

- [ ] **Step 0.3: Implement HealthStore HTTP counters**

In `daemon/Sources/SafariPilotdCore/HealthStore.swift`:

1. Add `PersistedState` field (line 84, after `forceReloadTimestamps`):
```swift
private struct PersistedState: Codable {
    let lastAlarmFireTimestamp: Date
    let forceReloadTimestamps: [Date]
    var httpBindFailureCount: Int?
}
```

2. Add private stored property (line 12, after `forceReloadTimestamps`):
```swift
private var _httpBindFailureCount: Int = 0
```

3. Add in-memory rolling window (line 17, after `uncertainTimestamps`):
```swift
private var httpRequestErrorTimestamps: [Date] = []
```

4. Update `init(persistPath:)` — after line 34 (`self.forceReloadTimestamps = decoded.forceReloadTimestamps`):
```swift
self._httpBindFailureCount = decoded.httpBindFailureCount ?? 0
```

5. Add public accessors (after `forceReloadCount24h` at line 41):
```swift
public var httpBindFailureCount: Int { queue.sync { _httpBindFailureCount } }
public var httpRequestErrorCount1h: Int { queue.sync { countInWindow(httpRequestErrorTimestamps, seconds: 3600) } }
```

6. Add mutation methods (after `markExecutedResult()` at line 64):
```swift
public func recordHttpBindFailure() {
    queue.sync {
        _httpBindFailureCount += 1
        persist()
    }
}

public func recordHttpRequestError() {
    queue.sync { httpRequestErrorTimestamps.append(Date()) }
}
```

7. Update `persist()` — change `PersistedState` construction (line 72):
```swift
let state = PersistedState(
    lastAlarmFireTimestamp: _lastAlarmFireTimestamp,
    forceReloadTimestamps: forceReloadTimestamps.filter {
        $0 >= Date(timeIntervalSinceNow: -86400)
    },
    httpBindFailureCount: _httpBindFailureCount
)
```

- [ ] **Step 0.4: Run tests to verify they pass**

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
swift build --package-path daemon && daemon/.build/debug/SafariPilotdTests 2>&1 | grep -E "testHttp|Results"
```

Expected: 3 new tests PASS, all existing tests still pass.

- [ ] **Step 0.5: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/HealthStore.swift daemon/Tests/SafariPilotdTests/HealthStoreTests.swift
git commit -m "feat(health): add httpBindFailureCount (persisted) + httpRequestErrorCount1h (rolling)"
```

---

## Task 1: Wire Health Fields into healthSnapshot + health-check.sh

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift:431-446`
- Modify: `scripts/health-check.sh`

- [ ] **Step 1.1: Add new fields to ExtensionBridge.healthSnapshot**

In `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`, inside the return dictionary of `healthSnapshot(store:)` (line 431-446), insert after `"forceReloadCount24h": store.forceReloadCount24h,` (line 439):

```swift
"httpBindFailureCount": store.httpBindFailureCount,
"httpRequestErrorCount1h": store.httpRequestErrorCount1h,
```

- [ ] **Step 1.2: Update health-check.sh to parse new fields**

In `scripts/health-check.sh`, after the `FORCE_RELOAD` extraction (line 19), add:

```bash
HTTP_BIND_FAIL=$(echo "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('value',{}).get('httpBindFailureCount',0))" 2>/dev/null || echo "0")
HTTP_REQ_ERR=$(echo "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('value',{}).get('httpRequestErrorCount1h',0))" 2>/dev/null || echo "0")
```

Update the log line (line 21) to include new fields:

```bash
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) rt=$ROUNDTRIP to=$TIMEOUT un=$UNCERTAIN fr=$FORCE_RELOAD http=$HTTP_STATUS hbf=$HTTP_BIND_FAIL hre=$HTTP_REQ_ERR" >> "$LOG"
```

Add breach detection (after line 27, the existing `http-server-down` check):

```bash
if [[ "$HTTP_BIND_FAIL" -gt 0 ]]; then BREACH="$BREACH http-bind-failure"; fi
if [[ "$HTTP_REQ_ERR" -gt 5 ]]; then BREACH="$BREACH http-request-errors"; fi
```

- [ ] **Step 1.3: Add healthSnapshot field assertion test**

Add to `registerExtensionBridgeTests()` in `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift`:

```swift
test("testHealthSnapshotIncludesHttpCounters") {
    let bridge = ExtensionBridge()
    let tmpPath = FileManager.default.temporaryDirectory
        .appendingPathComponent("test-health-\(UUID().uuidString).json")
    let health = HealthStore(persistPath: tmpPath)

    let snapshot = bridge.healthSnapshot(store: health)
    // Verify new HTTP counter fields exist with correct types
    try assertTrue(snapshot["httpBindFailureCount"] is Int,
                   "httpBindFailureCount should be Int, got \(type(of: snapshot["httpBindFailureCount"]))")
    try assertTrue(snapshot["httpRequestErrorCount1h"] is Int,
                   "httpRequestErrorCount1h should be Int, got \(type(of: snapshot["httpRequestErrorCount1h"]))")
    try assertEqual(snapshot["httpBindFailureCount"] as? Int, 0)
    try assertEqual(snapshot["httpRequestErrorCount1h"] as? Int, 0)
}
```

- [ ] **Step 1.4: Run daemon tests to verify all pass**

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
swift build --package-path daemon && daemon/.build/debug/SafariPilotdTests 2>&1 | grep -E "testHealthSnapshot|testExtensionHealth|Results"
```

Expected: both existing `testExtensionHealthReturnsComposite` and new `testHealthSnapshotIncludesHttpCounters` pass.

- [ ] **Step 1.5: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/ExtensionBridge.swift daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift scripts/health-check.sh
git commit -m "feat(health): wire httpBindFailureCount + httpRequestErrorCount1h into healthSnapshot and health-check.sh"
```

---

## Task 2: ExtensionHTTPServer onServerRunning + Error Counting

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift`
- Test: `daemon/Tests/SafariPilotdTests/ExtensionHTTPServerTests.swift`

- [ ] **Step 2.1: Write failing test for onReady callback**

Add to `registerExtensionHTTPServerTests()` in `ExtensionHTTPServerTests.swift`:

```swift
test("testHTTPServerCallsOnReadyAfterStart") {
    let bridge = ExtensionBridge()
    let tmpPath = FileManager.default.temporaryDirectory
        .appendingPathComponent("test-http-health-\(UUID().uuidString).json")
    let health = HealthStore(persistPath: tmpPath)
    let port = nextTestPort
    nextTestPort += 1

    let readyExpectation = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var readyCalled = false

    let server = ExtensionHTTPServer(
        port: port,
        bridge: bridge,
        healthStore: health,
        onReady: {
            readyCalled = true
            readyExpectation.signal()
        }
    )
    server.start()
    defer { server.stop() }

    let result = readyExpectation.wait(timeout: .now() + 5)
    try assertTrue(result == .success, "onReady should fire within 5s")
    try assertTrue(readyCalled, "onReady callback should have been called")
}
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
swift build --package-path daemon 2>&1 | tail -5
```

Expected: compile error — `ExtensionHTTPServer` init doesn't accept `onReady` parameter.

- [ ] **Step 2.3: Add onReady/onBindFailure constructor parameters**

In `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift`:

1. Add private stored properties (after `healthStore` at line 28):
```swift
private let onReady: (@Sendable () async -> Void)?
private let onBindFailure: (@Sendable (Error) -> Void)?
```

2. Update `init` (line 43-51) to accept and store the new parameters:
```swift
public init(
    port: UInt16 = 19475,
    bridge: ExtensionBridge,
    healthStore: HealthStore,
    onReady: (@Sendable () async -> Void)? = nil,
    onBindFailure: (@Sendable (Error) -> Void)? = nil
) {
    self.port = port
    self.bridge = bridge
    self.healthStore = healthStore
    self.onReady = onReady
    self.onBindFailure = onBindFailure
}
```

3. Update `start()` — modify the `Application` constructor (line 60-66) to use `onServerRunning`:
```swift
let app = Application(
    router: router,
    configuration: ApplicationConfiguration(
        address: .hostname("127.0.0.1", port: Int(port)),
        serverName: "SafariPilot-ExtHTTP"
    ),
    onServerRunning: { [self] _ in
        Logger.info("HTTP_READY port=\(self.port)")
        await self.onReady?()
    }
)
```

4. Update the catch block (line 69-71) to call `onBindFailure`:
```swift
} catch {
    Logger.error("HTTP_BIND_FAILED port=\(port) error=\(error)")
    self.onBindFailure?(error)
}
```

- [ ] **Step 2.4: Add error counting in jsonResponse**

In the `jsonResponse()` method (line 231), add before the final `return` of the normal path:

```swift
if status.code >= 500 {
    healthStore.recordHttpRequestError()
}
```

Also add in the serialization fallback path (line 235-242), before the fallback `return`:

```swift
healthStore.recordHttpRequestError()
```

- [ ] **Step 2.5: Run tests to verify they pass**

```bash
swift build --package-path daemon && daemon/.build/debug/SafariPilotdTests 2>&1 | tail -5
```

Expected: all tests pass including new `testHTTPServerCallsOnReadyAfterStart`.

- [ ] **Step 2.6: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift daemon/Tests/SafariPilotdTests/ExtensionHTTPServerTests.swift
git commit -m "feat(http): onServerRunning READY callback + error counting in jsonResponse"
```

---

## Task 3: Wire Self-Test in main.swift

**Files:**
- Modify: `daemon/Sources/SafariPilotd/main.swift`

- [ ] **Step 3.1: Update httpServer construction with onReady + onBindFailure**

In `daemon/Sources/SafariPilotd/main.swift`, replace the `if #available` block (lines 176-186) with:

```swift
if #available(macOS 14.0, *) {
    let httpServer = ExtensionHTTPServer(
        port: 19475,
        bridge: dispatcher.extensionBridge,
        healthStore: healthStore,
        onReady: {
            // Self-test: verify HTTP server is actually serving
            // Uses POST /connect (instant) instead of GET /poll (5s long-hold)
            do {
                let url = URL(string: "http://127.0.0.1:19475/connect")!
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "executedIds": [] as [String],
                    "pendingIds": [] as [String],
                ])
                let (_, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if status == 200 {
                    Logger.info("HTTP_SELF_TEST pass status=\(status)")
                } else {
                    Logger.warning("HTTP_SELF_TEST unexpected status=\(status)")
                }
            } catch {
                Logger.error("HTTP_SELF_TEST fail error=\(error)")
                healthStore.recordHttpBindFailure()
            }
        },
        onBindFailure: { error in
            healthStore.recordHttpBindFailure()
        }
    )
    // start() spawns internal Tasks — errors are logged inside, not thrown.
    httpServer.start()
} else {
    Logger.warning("ExtensionHTTPServer requires macOS 14+. Extension HTTP polling unavailable on this OS version.")
}
```

- [ ] **Step 3.2: Compile gate — verify daemon builds**

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
swift build --package-path daemon 2>&1 | tail -3
```

Expected: `Build complete!`

- [ ] **Step 3.3: Run full daemon test suite**

```bash
daemon/.build/debug/SafariPilotdTests 2>&1 | tail -3
```

Expected: all tests pass (should be ~71 now with the 3 new health tests + 1 onReady test).

- [ ] **Step 3.4: Commit**

```bash
git add daemon/Sources/SafariPilotd/main.swift
git commit -m "feat(daemon): wire HTTP self-test via onReady + onBindFailure callbacks"
```

---

## Task 4: Compile Gate (Subsystem C Complete)

- [ ] **Step 4.1: Full clean build verification**

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
swift build --package-path daemon -c release 2>&1 | tail -5
```

Expected: `Build complete!` in release mode. This confirms all Subsystem C changes compile cleanly before the rebuild pipeline.

- [ ] **Step 4.2: Run full daemon tests one more time**

```bash
daemon/.build/debug/SafariPilotdTests 2>&1 | tail -3
```

Expected: all tests pass.

**Subsystem C is now code-complete. Proceeding to Subsystem A (rebuild).**

---

## Task 5: Version Fix + TypeScript Build

**Files:**
- Modify: `src/index.ts:15`

- [ ] **Step 5.1: Fix src/index.ts version**

Change line 15 from `version: '0.1.4'` to `version: '0.1.6'`:

```typescript
{ name: 'safari-pilot', version: '0.1.6' },
```

- [ ] **Step 5.2: TypeScript build**

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
npm run build
```

Expected: compiles without errors.

- [ ] **Step 5.3: Verify version in built output**

```bash
grep '0.1.6' dist/index.js
```

Expected: line containing `version: '0.1.6'`.

- [ ] **Step 5.4: Run unit tests against fresh dist**

```bash
npm run test:unit 2>&1 | tail -5
```

Expected: all tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add src/index.ts
git commit -m "fix(version): sync src/index.ts version to 0.1.6"
```

---

## Task 6: Daemon Rebuild

- [ ] **Step 6.1: Rebuild daemon binary**

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
bash scripts/update-daemon.sh
```

This builds for host architecture (ARM64), atomic-swaps the binary, and restarts the LaunchAgent. Subsystem C's observability changes are included in this build.

Expected: script completes with `✓ SafariPilotd updated`.

- [ ] **Step 6.2: Verify version**

```bash
./bin/SafariPilotd --version
```

Expected: `SafariPilotd 0.1.6`

- [ ] **Step 6.3: Verify HTTP_READY log** (optional — requires daemon restart)

```bash
# The LaunchAgent restart from update-daemon.sh should produce this in system log:
log show --predicate 'process == "SafariPilotd"' --last 30s 2>/dev/null | grep "HTTP_READY\|HTTP_SELF_TEST" || echo "Check daemon stderr manually"
```

---

## Task 7: Extension Build

- [ ] **Step 7.1: Build, sign, and notarize extension**

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
bash scripts/build-extension.sh
```

Expected: script completes through all 10 steps (generate → archive → export → sign → notarize → Gatekeeper check).

- [ ] **Step 7.2: Verify entitlements**

```bash
codesign -d --entitlements - "bin/Safari Pilot.app" 2>&1 | grep -c "app-sandbox"
```

Expected: `1` (app-sandbox entitlement present).

```bash
codesign -d --entitlements - "bin/Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex" 2>&1 | grep -c "app-sandbox"
```

Expected: `1`.

---

## Task 8: Artifact Verification

**Files:**
- Modify: `scripts/verify-artifact-integrity.sh`

- [ ] **Step 8.1: Add HTTP-specific checks to verify-artifact-integrity.sh**

Append after the existing check 6 (line 57, before the final "PASS" echo):

```bash
# 7. HTTP IPC: background.js has fetch(), not sendNativeMessage
BG_PATH="$APPEX/Contents/Resources/background.js"
if [ ! -f "$BG_PATH" ]; then
  echo "FAIL: background.js not found in appex" >&2
  exit 1
fi
if ! grep -q 'fetch(' "$BG_PATH"; then
  echo "FAIL: background.js missing fetch() — HTTP IPC not present" >&2
  exit 1
fi
if ! grep -q '127.0.0.1:19475' "$BG_PATH"; then
  echo "FAIL: background.js missing HTTP URL 127.0.0.1:19475" >&2
  exit 1
fi
if grep -q 'sendNativeMessage' "$BG_PATH"; then
  echo "FAIL: background.js still contains sendNativeMessage — should use HTTP" >&2
  exit 1
fi

# 8. HTTP IPC: manifest.json has CSP connect-src for localhost:19475
MANIFEST_PATH="$APPEX/Contents/Resources/manifest.json"
if ! grep -q 'connect-src' "$MANIFEST_PATH"; then
  echo "FAIL: manifest.json missing CSP connect-src for HTTP" >&2
  exit 1
fi
```

- [ ] **Step 8.2: Run the extended verification script**

```bash
bash scripts/verify-artifact-integrity.sh
```

Expected: `Artifact integrity: PASS (v0.1.6, appex build YYYYMMDDHHMM)`

- [ ] **Step 8.3: Run e2e tests against rebuilt artifacts**

```bash
npx vitest run test/e2e/mcp-handshake.test.ts test/e2e/extension-engine.test.ts \
  test/e2e/extension-lifecycle.test.ts test/e2e/extension-health.test.ts \
  test/e2e/commit-1a-shippable.test.ts test/e2e/http-roundtrip.test.ts
```

Expected: all 6 e2e test files pass.

- [ ] **Step 8.4: Commit**

```bash
git add scripts/verify-artifact-integrity.sh
git commit -m "feat(verify): add HTTP IPC artifact checks to verify-artifact-integrity.sh"
```

---

## Task 9: GitHub Release Draft

- [ ] **Step 9.1: Create zip of extension**

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot/bin
zip -r "Safari Pilot.zip" "Safari Pilot.app"
```

- [ ] **Step 9.2: Create draft release**

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
gh release create v0.1.6 --draft \
  --title "v0.1.6 — HTTP Short-Poll IPC + Event-Page Lifecycle" \
  --notes "$(cat <<'EOF'
## What's New

- **HTTP short-poll IPC**: Extension communicates with daemon via fetch() to localhost:19475 (Hummingbird). Replaces sendNativeMessage → handler → TCP proxy.
- **Reconcile protocol**: 5-case classification (acked/uncertain/reQueued/inFlight/pushNew) for reliable command delivery across event page kills.
- **Event-page lifecycle**: MV3 event page (persistent:false) with storage-backed queue, alarm keepalive, and drain-on-wake.
- **Observability**: HTTP error counters, structured READY log, startup self-test, health check HTTP probe.

## Artifacts

- `SafariPilotd` — ARM64 daemon binary (universal binary available from CI on tag push)
- `Safari Pilot.zip` — Signed + notarized extension .app

## Note

This is a draft release. Promote to published after manual Safari verification.
EOF
)" \
  bin/SafariPilotd \
  "bin/Safari Pilot.zip"
```

- [ ] **Step 9.3: Verify draft release exists**

```bash
gh release view v0.1.6 --json isDraft,tagName,assets
```

Expected: `isDraft: true`, `tagName: v0.1.6`, 2 assets listed.

---

## Task 10: Test Result Capture (Subsystem B)

**Files:**
- Modify: `vitest.config.ts`
- Create: `test/setup-retention.ts`
- Modify: `.gitignore`

- [ ] **Step 10.1: Create retention teardown file**

Create `test/setup-retention.ts`:

```typescript
import { execSync } from 'node:child_process';

// No setup needed — only teardown for retention pruning
export function setup() {}

export function teardown() {
  try {
    execSync(
      'ls -t test-results/junit/*.xml 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null; ' +
      'ls -t test-results/json/*.json 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null',
      { shell: '/bin/bash' },
    );
  } catch {
    /* no files to prune — directory may not exist yet */
  }
}
```

- [ ] **Step 10.2: Update vitest.config.ts with reporters + globalSetup**

Replace the contents of `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    reporters: [
      'default',
      ['junit', { outputFile: `test-results/junit/${Date.now()}.xml` }],
      ['json', { outputFile: `test-results/json/${Date.now()}.json` }],
    ],
    globalSetup: ['./test/setup-retention.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
    // E2E tests share Safari — multiple MCP servers creating tabs simultaneously
    // causes tab URL matching failures. Run test files sequentially.
    fileParallelism: false,
  },
});
```

- [ ] **Step 10.3: Add test-results/ to .gitignore**

Append to `.gitignore`:

```
test-results/
```

- [ ] **Step 10.4: Verify — run unit tests and check output files**

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
npm run test:unit 2>&1 | tail -5
```

Expected: all tests pass. Then check:

```bash
ls test-results/junit/*.xml && echo "JUnit XML: exists"
ls test-results/json/*.json && echo "JSON: exists"
```

Expected: both files exist.

- [ ] **Step 10.5: Verify XML content**

```bash
head -5 test-results/junit/*.xml
```

Expected: XML with `<testsuite>` elements.

- [ ] **Step 10.6: Verify JSON content**

```bash
python3 -c "import json; d=json.load(open(list(__import__('glob').glob('test-results/json/*.json'))[0])); print(f'passed: {d[\"numPassedTests\"]}')"
```

Expected: `passed: <number>` matching the test count.

- [ ] **Step 10.7: Commit**

```bash
git add vitest.config.ts test/setup-retention.ts .gitignore
git commit -m "feat(test): add JUnit XML + JSON reporters with globalSetup retention (last 10 runs)"
```

---

## Task 11: Documentation Updates

**Files:**
- Modify: `CLAUDE.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 11.1: Update CLAUDE.md test count**

In `CLAUDE.md`, find `npm run test:unit      # 700+ unit tests` (line 88) and update to the actual count from the most recent test run.

- [ ] **Step 11.2: Update ARCHITECTURE.md**

Add to the appropriate section in ARCHITECTURE.md:

1. In the health snapshot / observability section, document the two new fields:
   - `httpBindFailureCount` — persisted counter, incremented when HTTP:19475 fails to bind
   - `httpRequestErrorCount1h` — rolling 1-hour window of HTTP server 5xx errors

2. Document the startup sequence:
   - `HTTP_READY port=19475` logged when Hummingbird binds successfully
   - `HTTP_SELF_TEST pass` logged when self-test POST /connect succeeds

3. Document test result capture:
   - `test-results/junit/` and `test-results/json/` for vitest structured output
   - `benchmark/` for benchmark runner structured output (unchanged)

- [ ] **Step 11.3: Commit**

```bash
git add CLAUDE.md ARCHITECTURE.md
git commit -m "docs: update test count in CLAUDE.md + health fields + test capture in ARCHITECTURE.md"
```

---

## Self-Review Checklist

### Spec coverage

- [x] Section 2 (Scope, rebuild): Tasks 5-9 (version fix, TS build, daemon rebuild, extension build, artifact verify, GitHub Release)
- [x] Section 2 (Scope, test capture): Task 10 (vitest reporters + retention)
- [x] Section 2 (Scope, observability): Tasks 0-3 (HealthStore counters, healthSnapshot wiring, onServerRunning, self-test)
- [x] Section 4.1 (Version fix): Task 5, step 5.1
- [x] Section 4.5 (Artifact verification): Task 8
- [x] Section 4.7 (GitHub Release draft): Task 9
- [x] Section 5.1 (HealthStore counters): Task 0
- [x] Section 5.2 (onServerRunning callback): Task 2
- [x] Section 5.3 (Self-test): Task 3
- [x] Section 5.4 (Tests): Tasks 0 (HealthStore tests), 2 (onReady test)
- [x] Section 5.5 (Compile gate): Task 4
- [x] Section 6.1 (Vitest reporters): Task 10
- [x] Section 6.2 (Directory structure): Task 10
- [x] Section 6.3 (Retention): Task 10
- [x] Section 6.5 (Documentation): Task 11
- [x] Section 5.1 (health-check.sh wiring): Task 1

### Placeholder scan

- No TBD, TODO, "implement later", or "fill in details" found.
- All code blocks contain actual project-specific code, not examples.
- All file paths are exact.

### Type consistency

- `httpBindFailureCount` / `recordHttpBindFailure()` — consistent across Tasks 0, 1, 2, 3
- `httpRequestErrorCount1h` / `recordHttpRequestError()` — consistent across Tasks 0, 1, 2
- `onReady: (@Sendable () async -> Void)?` — consistent between Task 2 (definition) and Task 3 (usage)
- `onBindFailure: (@Sendable (Error) -> Void)?` — consistent between Task 2 and Task 3
- `PersistedState.httpBindFailureCount: Int?` — consistent with `?? 0` defaulting in init
