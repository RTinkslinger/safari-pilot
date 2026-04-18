# v0.1.6 Ship Readiness — Design Spec

## 1. Problem Statement

Safari Pilot v0.1.6 was merged to main with the HTTP short-poll IPC pivot and event-page lifecycle changes. However, three gaps prevent it from being fully shippable:

1. **Binary artifacts are stale.** The daemon binary (`bin/SafariPilotd`), TypeScript dist (`dist/`), and extension `.app` (`bin/Safari Pilot.app`) were not rebuilt from the merged main source. E2E tests and benchmarks will produce misleading results against old binaries. `src/index.ts` still reports version 0.1.4.

2. **Test results are not captured.** Vitest outputs to console only — no structured JUnit XML or JSON files. The benchmark runner saves structured history (`benchmark/history.json`, `benchmark/traces/`), but vitest test runs leave no artifact. Future recipe development needs both test and benchmark data as queryable seed data.

3. **HTTP server observability is incomplete.** The health check script probes HTTP:19475 (added this session), but the daemon itself has no HTTP error counters, no structured READY log, and no startup self-test. If the HTTP server fails silently, the only signal is the hourly health check probe — no real-time visibility.

## 2. Scope

**In scope (v1):**
- Rebuild all binary artifacts from current main
- Fix `src/index.ts` version 0.1.4 → 0.1.6
- Extend `verify-artifact-integrity.sh` with HTTP-specific checks
- Run full verification pipeline (artifact integrity + extension smoke tests)
- Create GitHub Release v0.1.6 as draft with daemon + extension artifacts
- Add JUnit XML + JSON vitest reporters to `vitest.config.ts`
- Test result files at `test-results/junit/` and `test-results/json/` (gitignored)
- Retention policy: keep last 10 test result files per format
- HTTP error counters (`httpBindFailureCount`, `httpRequestErrorCount1h`) in HealthStore
- Structured READY log (`HTTP_READY port=19475` / `HTTP_BIND_FAILED port=19475`)
- Daemon startup self-test (verify HTTP:19475 is serving after start)
- Update ARCHITECTURE.md to document new health fields and startup sequence
- Update CLAUDE.md test count (700+ → actual count)
- Extend `health-check.sh` to parse new health fields

**Explicitly NOT in scope:**
- npm publish (manual step after user verifies in Safari)
- CI/CD integration for test results
- Anomaly detection on test history
- HTML dashboard for benchmark/test results
- Long-poll timeout tests or concurrent poll stress tests
- Benchmark runner changes (already has structured output)
- Universal binary build (local rebuild is host-arch only; CI pipeline handles universal via release.yml)

## 3. Architecture

### Execution Order (Optimized Sequential Pipeline)

```
Subsystem C: Observability Hardening (code only, no rebuild yet)
  HealthStore HTTP counters → ExtensionHTTPServer onServerRunning callback
  → self-test wiring → swift build --package-path daemon (compile gate)
          │ compile gate passes
          ▼
Subsystem A: Rebuild Pipeline (incorporates C's changes)
  src/index.ts version fix → npm build → daemon rebuild (includes C)
  → extension build → artifact verification → smoke test → GitHub Release draft
          │
          ▼
Subsystem B: Test Result Capture
  vitest.config.ts reporters → test-results/ directory → retention script
  → verification run → confirm seed data files exist
```

**Why C before A:** Subsystem C modifies daemon Swift code. By coding C first and verifying it compiles (`swift build --package-path daemon`), we incorporate C's changes into A's single daemon rebuild. This avoids rebuilding the daemon twice. The compile gate (`swift build` succeeds) must pass before A proceeds — if C introduces compile errors, they're caught immediately before touching the build pipeline.

**Distribution personas:** Git-clone users and npm users receive updated daemon + extension when the GitHub Release draft is promoted (manual step) and `npm publish` is run (out of scope). No additional work needed beyond the existing release + publish pipeline.

### Data Flow

```
vitest run
  │
  ├── console (default reporter — human-readable)
  ├── test-results/junit/<timestamp>.xml (JUnit XML reporter)
  └── test-results/json/<timestamp>.json (JSON reporter)

benchmark run (existing, unchanged)
  │
  ├── benchmark/history.json (rolling 20-run history)
  ├── benchmark/reports/<runId>.md (per-run markdown)
  └── benchmark/traces/<runId>/<taskId>.json (per-task traces)

health-check.sh (hourly LaunchAgent)
  │
  ├── TCP:19474 probe → extension_health JSON → parse counters
  │   (existing: roundtripCount1h, timeoutCount1h, uncertainCount1h, forceReloadCount24h)
  │   (new: httpBindFailureCount, httpRequestErrorCount1h)
  ├── HTTP:19475 probe → curl status code (already added)
  └── ~/.safari-pilot/health.log (append-only log line with all fields)
```

## 4. Subsystem A: Rebuild Pipeline

### 4.1 Version Fix

`src/index.ts` line 15 reports `version: '0.1.4'`. Must be updated to `'0.1.6'` to match package.json, manifest.json, background.js, and main.swift (all already synced to 0.1.6).

### 4.2 TypeScript Build

```bash
npm run build  # tsc → dist/
```

Verify: `dist/index.js` exists, `grep '0.1.6' dist/index.js` confirms version.

### 4.3 Daemon Rebuild

```bash
bash scripts/update-daemon.sh
```

This script: builds for host architecture (`swift build -c release` — ARM64 on this machine, NOT universal), does `launchctl stop` → build → atomic `mv` swap of `bin/SafariPilotd` → `launchctl unload` → `launchctl load` → `launchctl kickstart`. The binary now includes Hummingbird, ExtensionHTTPServer, and Subsystem C's observability changes.

**Note:** This produces an ARM64-only binary. Universal binary (ARM64 + x86_64 via `lipo`) is handled by the CI release pipeline (`release.yml`) on tag push, not by the local dev rebuild script. The GitHub Release draft will contain an ARM64-only binary; the CI pipeline replaces it with a universal binary when the tag is pushed.

Verify: `./bin/SafariPilotd --version` reports `0.1.6`.

### 4.4 Extension Build

```bash
bash scripts/build-extension.sh
```

This script: generate Xcode project → replace generated stub handler with custom handler → strip DEBUG blocks → patch pbxproj → create entitlements → archive → export → copy to bin/ → verify signature → notarize → Gatekeeper check. Per CLAUDE.md hard rules: never bypass this script, never use manual codesign, version syncs from package.json, build number is timestamp-based.

Verify: `codesign -d --entitlements - "bin/Safari Pilot.app"` shows `app-sandbox`.

### 4.5 Artifact Verification

Extend `scripts/verify-artifact-integrity.sh` with HTTP-specific checks. The background.js inside the .app is at `bin/Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex/Contents/Resources/background.js`. Add checks:

```bash
BG_PATH="bin/Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex/Contents/Resources/background.js"
MANIFEST_PATH="bin/Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex/Contents/Resources/manifest.json"

# HTTP IPC checks
grep -q 'fetch(' "$BG_PATH" || { echo "FAIL: background.js missing fetch()"; exit 1; }
grep -q '127.0.0.1:19475' "$BG_PATH" || { echo "FAIL: background.js missing HTTP URL"; exit 1; }
grep -q 'sendNativeMessage' "$BG_PATH" && { echo "FAIL: background.js still has sendNativeMessage"; exit 1; }
grep -q 'connect-src' "$MANIFEST_PATH" || { echo "FAIL: manifest.json missing CSP connect-src"; exit 1; }
```

Append these to the existing script after the current checks. Run the extended script. All checks must pass.

### 4.6 Extension Smoke Test

**Note:** `scripts/verify-extension-smoke.sh` has 6 steps — steps 1-5 rebuild TypeScript, daemon, and extension from scratch, then step 6 runs 5 e2e tests. Since steps 4.2-4.4 already rebuilt everything, running the full smoke script would double-build (~10-15 min wasted on notarization alone).

**Solution:** Run only the e2e test step directly:

```bash
npx vitest run test/e2e/mcp-handshake.test.ts test/e2e/extension-engine.test.ts \
  test/e2e/extension-lifecycle.test.ts test/e2e/extension-health.test.ts \
  test/e2e/commit-1a-shippable.test.ts test/e2e/http-roundtrip.test.ts
```

All 6 e2e test files must pass. This verifies the already-built artifacts without rebuilding.

### 4.7 GitHub Release Draft

```bash
cd bin && zip -r "Safari Pilot.zip" "Safari Pilot.app"
gh release create v0.1.6 --draft \
  --title "v0.1.6 — HTTP Short-Poll IPC + Event-Page Lifecycle" \
  --notes-file /dev/stdin <<'NOTES'
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
NOTES
  bin/SafariPilotd \
  "bin/Safari Pilot.zip"
```

**Rollback:** If artifacts are broken after promotion, `gh release delete v0.1.6` removes the release. Previous version (v0.1.5) remains available.

## 5. Subsystem C: Observability Hardening

### 5.1 HTTP Error Counters in HealthStore

Add two new fields to `HealthStore` (`daemon/Sources/SafariPilotdCore/HealthStore.swift`):

**`httpBindFailureCount: Int`** — Persisted (survives daemon restart).
- Add `httpBindFailureCount: Int` to the `PersistedState` Codable struct (currently has `lastAlarmFireTimestamp` and `forceReloadTimestamps`)
- Declare as `var httpBindFailureCount: Int?` in `PersistedState` (Optional — Swift's synthesized Codable decoder decodes missing keys as `nil` for Optional properties. `var x: Int = 0` does NOT work — synthesized Codable always tries to decode non-Optional properties and throws `DecodingError.keyNotFound` if the key is missing, causing the entire decode to fail and ALL persisted state to be lost)
- Add `private var _httpBindFailureCount: Int = 0` stored property to HealthStore (alongside existing `_lastAlarmFireTimestamp` at line 7)
- Update `init(persistPath:)` to read: `self._httpBindFailureCount = state.httpBindFailureCount ?? 0` (line ~33, defaults nil to 0)
- Update `persist()` to explicitly pass the value: `PersistedState(lastAlarmFireTimestamp: ..., forceReloadTimestamps: ..., httpBindFailureCount: _httpBindFailureCount)` (line ~72). Without this, the synthesized memberwise init would pass `nil` (the Optional's default), resetting the counter to 0 on every persist call from `recordAlarmFire()` or `incrementForceReload()`.
- Add public computed var `httpBindFailureCount: Int { queue.sync { _httpBindFailureCount } }`
- Add public `func recordHttpBindFailure()` method (increments `_httpBindFailureCount` under queue + calls `persist()`)

**`httpRequestErrorCount1h: Int`** — In-memory rolling 1-hour window (like existing `roundtripCount1h`).
- Add `private var httpRequestErrorTimestamps: [Date] = []` (same pattern as `roundtripTimestamps`)
- Add public computed var `httpRequestErrorCount1h` that filters to last 60 minutes
- Add public `func recordHttpRequestError()` method
- Counting mechanism: increment directly in `ExtensionHTTPServer.jsonResponse()` when `status.code >= 500`. This function is already the centralized response builder for all error paths (line 231). Add `if status.code >= 500 { healthStore.recordHttpRequestError() }` before the return. ALSO add `healthStore.recordHttpRequestError()` in the JSON serialization fallback path (line 235-242) which returns `.internalServerError` directly — without this, serialization failures bypass the counter. No middleware needed — simpler and catches all error responses including the fallback.

**Wiring into health snapshot:** Update `ExtensionBridge.healthSnapshot(store:)` (at `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift:415`). Insert after the `"forceReloadCount24h"` line (line 439) to group HealthStore-sourced counters together:
```swift
"httpBindFailureCount": store.httpBindFailureCount,
"httpRequestErrorCount1h": store.httpRequestErrorCount1h,
```

**Wiring into health-check.sh:** Add extraction lines following the existing pattern (lines 16-19 of `scripts/health-check.sh`):
```bash
HTTP_BIND_FAIL=$(echo "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('value',{}).get('httpBindFailureCount',0))" 2>/dev/null || echo "0")
HTTP_REQ_ERR=$(echo "$HEALTH_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('value',{}).get('httpRequestErrorCount1h',0))" 2>/dev/null || echo "0")
```

Add to log line (format: `... hbf=$HTTP_BIND_FAIL hre=$HTTP_REQ_ERR`) and breach detection:
```bash
if [[ "$HTTP_BIND_FAIL" -gt 0 ]]; then BREACH="$BREACH http-bind-failure"; fi
if [[ "$HTTP_REQ_ERR" -gt 5 ]]; then BREACH="$BREACH http-request-errors"; fi
```
Threshold: `httpBindFailureCount > 0` is always a breach (any bind failure means HTTP server is down). `httpRequestErrorCount1h > 5` allows occasional transient errors.

### 5.2 ExtensionHTTPServer READY Callback

Use Hummingbird's `onServerRunning` lifecycle callback — this is the built-in API that fires exactly when the server socket is bound and listening. It's passed as a parameter to the `Application` constructor.

**Implementation in ExtensionHTTPServer.swift:**

```swift
// In start(), modify the Application constructor:
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

Note: `onServerRunning` signature is `@escaping @Sendable (any Channel) async -> Void`. The `[self]` capture is explicit. `await self.onReady?()` works because `onReady` is now `async`.

**In the catch block** (existing line 70):
```swift
} catch {
    Logger.error("HTTP_BIND_FAILED port=\(port) error=\(error)")
    self.onBindFailure?(error)
}
```

**Constructor parameters on ExtensionHTTPServer** (not mutable properties — eliminates two-phase init and data race concerns):
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

private let onReady: (@Sendable () async -> Void)?
private let onBindFailure: (@Sendable (Error) -> Void)?
```

`onReady` is `async` because the `onServerRunning` callback is already async — this allows the self-test to use `await URLSession` directly without creating an unstructured Task.

**Wiring in main.swift:**
```swift
let httpServer = ExtensionHTTPServer(
    port: 19475,
    bridge: dispatcher.extensionBridge,
    healthStore: healthStore,
    onReady: {
        // Self-test (Section 5.3) — runs in structured async context
    },
    onBindFailure: { error in
        healthStore.recordHttpBindFailure()
    }
)
httpServer.start()
```

**Thread safety:** Closures are immutable `let` properties set at construction time. No data race possible. The `@Sendable` annotation satisfies Swift's strict concurrency model.

### 5.3 Daemon Startup Self-Test

Wire the self-test to the `onReady` callback (NOT a 500ms delay — eliminates race condition). Since `onReady` is now `async`, the self-test runs in structured concurrency within the `onServerRunning` context — no unstructured Task needed.

**IMPORTANT:** Do NOT use `GET /poll` for the self-test. `handlePoll()` uses a 5-second long-poll hold (`pollWaitTimeout: 5.0`), meaning the self-test would block for 5 seconds on every daemon startup. Use `POST /connect` instead — it returns immediately with a reconcile response and is a better health indicator (tests JSON parsing, bridge access, and reconcile logic):

```swift
// In main.swift, the onReady closure passed to ExtensionHTTPServer init:
onReady: {
    // Self-test: verify HTTP server is actually serving
    // Uses POST /connect (instant response) instead of GET /poll (5s long-hold)
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
}
```

Note: The self-test `POST /connect` will set `isConnected=true` and trigger a reconcile with empty IDs. This is harmless — the real extension connection will overwrite the state on its next connect. The self-test's reconcile response will have all empty arrays (no commands pending at startup).

This runs once at daemon startup within the `onServerRunning` async context. Non-fatal (logging only, no process exit). Returns in <10ms (no long-poll hold). `URLSession.shared.data(for:)` is available from macOS 12+; the self-test only runs inside the macOS 14+ guard so availability is guaranteed.

### 5.4 Tests

- Unit test: HealthStore has `httpBindFailureCount` and `httpRequestErrorCount1h` fields, increments correctly
- Unit test: `ExtensionBridge.healthSnapshot(store:)` includes new fields with correct types (number, not null)
- Integration test: ExtensionHTTPServer calls `onReady` callback after start (start server on test port, verify callback fires within 2s)

### 5.5 Compile Gate

After all C code changes are written, before proceeding to Subsystem A:

```bash
cd daemon && swift build
```

If this fails, fix C's code before touching the rebuild pipeline. This prevents C from blocking A.

## 6. Subsystem B: Test Result Capture

### 6.1 Vitest Reporter Configuration

Update `vitest.config.ts`:

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
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
    fileParallelism: false,
  },
});
```

All three reporters run simultaneously. Console output unchanged. XML and JSON files accumulate in `test-results/`. The `Date.now()` evaluates at config load time — produces unique filenames for each `vitest run` invocation. Watch mode re-runs within the same process would overwrite the same file (acceptable — watch mode is for development, not result capture).

### 6.2 Directory Structure

Add `test-results/` to project root `.gitignore`. The directories are created automatically by vitest when it writes the first result file. No nested `.gitignore` needed — the root entry is sufficient.

### 6.3 Retention Policy

**npm lifecycle constraint:** `posttest` only fires after the exact `test` script, NOT after `test:unit`, `test:e2e`, etc. (npm matches script names exactly). And `npm test` starts vitest in watch mode (never exits cleanly), so `posttest` would never fire in practice.

**Solution:** Use vitest's `globalSetup` config with a named `teardown` export. Vitest does NOT have a `globalTeardown` config key — the `globalSetup` file can export a `teardown` function that runs after all tests complete.

Create `test/setup-retention.ts`:
```typescript
import { execSync } from 'node:child_process';

// No setup needed — only teardown for retention pruning
export function setup() {}

export function teardown() {
  try {
    execSync('ls -t test-results/junit/*.xml 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null; ls -t test-results/json/*.json 2>/dev/null | tail -n +11 | xargs rm -f 2>/dev/null', { shell: '/bin/bash' });
  } catch { /* no files to prune — directory may not exist yet */ }
}
```

Note: uses `import` (not `require`) because the project is ESM (`"type": "module"` in package.json).

Add to `vitest.config.ts`:
```typescript
globalSetup: ['./test/setup-retention.ts'],
```

This fires after `npm run test:unit`, `npm run test:e2e`, `npx vitest run`, and any other vitest invocation. It does NOT fire in watch mode re-runs (only on process exit), which is acceptable — watch mode is for development, not result capture.

### 6.4 Verification

After setup:
1. Run `npm run test:unit`
2. Confirm `test-results/junit/*.xml` exists, contains `<testsuite>` elements
3. Confirm `test-results/json/*.json` exists, has `numPassedTests` field
4. Run again, confirm 2 files in each directory (both retained)

### 6.5 Documentation Updates

- Update CLAUDE.md line 88: change `700+ unit tests` to actual count from fresh run
- Update ARCHITECTURE.md: add note about test result capture in `test-results/` and benchmark data in `benchmark/`

## 7. Success Criteria

| Criterion | Verification |
|-----------|-------------|
| `bin/SafariPilotd --version` reports 0.1.6 | CLI output |
| `dist/index.js` contains version 0.1.6 | grep |
| `bin/Safari Pilot.app` background.js has HTTP fetch, no sendNativeMessage | verify-artifact-integrity.sh |
| Extension entitlements include app-sandbox | codesign -d --entitlements |
| E2E tests pass (6 files) | vitest exit 0 |
| GitHub Release v0.1.6 exists as draft with 2 artifacts | gh release view v0.1.6 |
| `safari_extension_health` includes `httpBindFailureCount` and `httpRequestErrorCount1h` | daemon test |
| Daemon logs `HTTP_READY port=19475` on startup | daemon stderr |
| Daemon logs `HTTP_SELF_TEST pass` on startup | daemon stderr |
| `npm run test:unit` produces `test-results/junit/*.xml` | file exists + content check |
| `npm run test:unit` produces `test-results/json/*.json` | file exists + content check |
| All unit tests pass | exit 0 |
| All daemon tests pass | exit 0 |
| ARCHITECTURE.md updated with new health fields | diff |
| CLAUDE.md test count updated | diff |

## 8. Risks

| Risk | Mitigation |
|------|-----------|
| Notarization fails (Apple service outage, credential expiry) | build-extension.sh retries. If persistent, fall back to "build without notarize" and notarize manually. |
| Port 19475 already in use during daemon rebuild | update-daemon.sh does launchctl stop → build → swap → unload → load → kickstart. Port freed during stop. |
| Vitest reporter config breaks existing test execution | Reporters are additive — default reporter preserved. JSON/JUnit are output-only, don't affect test behavior. |
| Hummingbird API changes between builds | Package.swift pins `from: "2.0.0"` — resolved version is locked in Package.resolved. |
| C code changes introduce Swift compile errors blocking A | Compile gate (swift build) runs after C, before A. Fix C before proceeding. |
| GitHub Release has ARM64-only binary | Expected for local dev builds. CI release pipeline (release.yml) produces universal binary on tag push. Draft release notes state this. |
| Partial build failure (daemon OK, extension fails) | Each build step is independent. If extension notarization fails, daemon binary is already swapped and running. Retry extension build separately. |
| Existing health.json missing new httpBindFailureCount field | PersistedState decoder uses optional with default 0. Backward compatible. |
