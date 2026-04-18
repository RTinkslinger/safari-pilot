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

**Explicitly NOT in scope:**
- npm publish (manual step after user verifies in Safari)
- CI/CD integration for test results
- Anomaly detection on test history
- HTML dashboard for benchmark/test results
- Long-poll timeout tests or concurrent poll stress tests
- Benchmark runner changes (already has structured output)

## 3. Architecture

### Execution Order (Approach A: Sequential Pipeline)

```
Subsystem A: Rebuild Pipeline
  src/index.ts version fix → npm build → daemon rebuild → extension build
  → artifact verification → extension smoke test → GitHub Release draft
          │
          ▼
Subsystem C: Observability Hardening
  HealthStore HTTP counters → ExtensionHTTPServer READY callback
  → daemon startup self-test → rebuild daemon (incorporates changes)
          │
          ▼
Subsystem B: Test Result Capture
  vitest.config.ts reporters → test-results/ directory → retention script
  → verification run → confirm seed data files exist
```

Subsystem A must come first — correct binaries are prerequisite for meaningful test runs and observability verification. Subsystem C modifies daemon Swift code, requiring a second daemon rebuild. Subsystem B is a vitest config change with no production code impact.

**Optimization:** Subsystem C's daemon changes can be coded before Subsystem A's rebuild, so only ONE daemon rebuild is needed (incorporating both the merged main code AND the new observability code). The sequence becomes: C code changes → A rebuild (includes C) → A verification → B test capture.

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
  │   (now includes: httpBindFailureCount, httpRequestErrorCount1h)
  ├── HTTP:19475 probe → curl status code
  └── ~/.safari-pilot/health.log (append-only log line)
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

This script: builds universal binary (arm64 + x86_64), atomic swap of `bin/SafariPilotd`, `launchctl` restart of the LaunchAgent. The binary now includes Hummingbird and the ExtensionHTTPServer.

Verify: `./bin/SafariPilotd --version` reports `0.1.6`.

### 4.4 Extension Build

```bash
bash scripts/build-extension.sh
```

This script: Xcode archive → export → codesign → notarize → staple → copy to `bin/Safari Pilot.app`. Per CLAUDE.md hard rules: never bypass this script, never use manual codesign, version syncs from package.json, build number is timestamp-based.

Verify: `codesign -d --entitlements - "bin/Safari Pilot.app"` shows `app-sandbox`.

### 4.5 Artifact Verification

Extend `scripts/verify-artifact-integrity.sh` with HTTP-specific checks:
- `bin/Safari Pilot.app/.../background.js` contains `fetch(` and `127.0.0.1:19475`
- `bin/Safari Pilot.app/.../background.js` does NOT contain `sendNativeMessage`
- `bin/Safari Pilot.app/.../manifest.json` contains `connect-src` with `127.0.0.1:19475`
- `bin/Safari Pilot.app/.../manifest.json` version is `0.1.6`

Run the extended script. All checks must pass.

### 4.6 Extension Smoke Test

```bash
bash scripts/verify-extension-smoke.sh
```

Runs 5 critical e2e tests against the rebuilt artifacts. Must all pass.

### 4.7 GitHub Release Draft

```bash
cd bin && zip -r "Safari Pilot.zip" "Safari Pilot.app"
gh release create v0.1.6 --draft \
  --title "v0.1.6 — HTTP Short-Poll IPC + Event-Page Lifecycle" \
  --notes "..." \
  bin/SafariPilotd \
  "bin/Safari Pilot.zip"
```

Draft release — not published until user manually promotes after Safari verification.

## 5. Subsystem C: Observability Hardening

### 5.1 HTTP Error Counters in HealthStore

Add two new fields to `HealthStore`:
- `httpBindFailureCount: Int` — incremented when HTTP server fails to bind port. Persisted (survives daemon restart).
- `httpRequestErrorCount1h: Int` — rolling 1-hour window counter for HTTP request errors (5xx responses, malformed request bodies). In-memory only (like existing `roundtripCount1h`).

Exposed in `healthSnapshot()` return dictionary alongside existing counters.

### 5.2 ExtensionHTTPServer READY Callback

Add a callback mechanism from ExtensionHTTPServer to the caller (main.swift):
- On successful Hummingbird bind: `Logger.info("HTTP_READY port=19475")`
- On bind failure: `Logger.error("HTTP_BIND_FAILED port=19475 error=\(error)")` + increment `healthStore.httpBindFailureCount`

Implementation: ExtensionHTTPServer.start() currently logs internally. Add two closure properties to ExtensionHTTPServer: `var onReady: (() -> Void)?` and `var onBindFailure: ((Error) -> Void)?`. Set them in main.swift before calling `start()`. Inside the server Task, call `onReady?()` after `app.runService()` begins (use a small delay or Hummingbird's lifecycle hook), and call `onBindFailure?(error)` in the catch block.

### 5.3 Daemon Startup Self-Test

After HTTP server `start()` returns and a brief delay (500ms for Hummingbird to bind):
- Attempt `URLSession` GET to `http://127.0.0.1:19475/poll`
- Expected: 204 (no pending commands)
- Log: `HTTP_SELF_TEST pass` or `HTTP_SELF_TEST fail error=<msg>`
- On failure: increment `healthStore.httpBindFailureCount`

This runs once at daemon startup. It's a sanity check, not a continuous monitor (the hourly health-check.sh handles ongoing monitoring).

### 5.4 Tests

- Unit test: HealthStore has `httpBindFailureCount` and `httpRequestErrorCount1h` fields
- Unit test: healthSnapshot includes the new fields with correct types
- Integration test: ExtensionHTTPServer calls onReady callback after start

## 6. Subsystem B: Test Result Capture

### 6.1 Vitest Reporter Configuration

Update `vitest.config.ts`:

```typescript
export default defineConfig({
  test: {
    reporters: [
      'default',  // console output (unchanged)
      ['junit', { outputFile: `test-results/junit/${Date.now()}.xml` }],
      ['json', { outputFile: `test-results/json/${Date.now()}.json` }],
    ],
    // ... existing config preserved
  },
});
```

All three reporters run simultaneously. Console output unchanged. XML and JSON files accumulate in `test-results/`.

### 6.2 Directory Structure

```
test-results/
├── junit/          # JUnit XML files (one per run, named by timestamp)
├── json/           # JSON files (one per run, named by timestamp)
└── .gitignore      # Contains: *
```

Add `test-results/` to project root `.gitignore`.

### 6.3 Retention Policy

Post-test cleanup script or vitest setup hook:

```bash
# Keep last 10 files in each directory (by mtime)
ls -t test-results/junit/*.xml 2>/dev/null | tail -n +11 | xargs rm -f
ls -t test-results/json/*.json 2>/dev/null | tail -n +11 | xargs rm -f
```

Wired as a `posttest` script in package.json or as a vitest `globalTeardown` file.

### 6.4 Verification

After setup:
1. Run `npm run test:unit`
2. Confirm `test-results/junit/*.xml` exists, contains `<testsuite>` elements with ~1427 tests
3. Confirm `test-results/json/*.json` exists, contains `numPassedTests: 1427`
4. Run again, confirm 2 files in each directory
5. Run 11 times, confirm oldest file was pruned (10 remain)

## 7. Success Criteria

| Criterion | Verification |
|-----------|-------------|
| `bin/SafariPilotd --version` reports 0.1.6 | CLI output |
| `dist/index.js` contains version 0.1.6 | grep |
| `bin/Safari Pilot.app` background.js has HTTP fetch, no sendNativeMessage | verify-artifact-integrity.sh |
| Extension entitlements include app-sandbox | codesign -d --entitlements |
| Extension smoke tests pass (5/5) | verify-extension-smoke.sh exit 0 |
| GitHub Release v0.1.6 exists as draft with 2 artifacts | gh release view v0.1.6 |
| `safari_extension_health` includes `httpBindFailureCount` and `httpRequestErrorCount1h` | MCP tool call or daemon test |
| Daemon logs `HTTP_READY port=19475` on startup | daemon stderr |
| Daemon logs `HTTP_SELF_TEST pass` on startup | daemon stderr |
| `npm run test:unit` produces `test-results/junit/*.xml` | file exists |
| `npm run test:unit` produces `test-results/json/*.json` | file exists |
| Retention: 11th run prunes oldest file | ls -t count |
| All 1427 unit tests pass | exit 0 |
| All 68 daemon tests pass | exit 0 |
| All e2e tests pass | exit 0 |

## 8. Risks

| Risk | Mitigation |
|------|-----------|
| Notarization fails (Apple service outage, credential expiry) | build-extension.sh retries. If persistent, fall back to "build without notarize" and notarize manually. |
| Port 19475 already in use during daemon rebuild (system daemon running) | update-daemon.sh does launchctl unload → build → swap → launchctl load. Port freed during unload. |
| Vitest reporter config breaks existing test execution | Reporters are additive — default reporter preserved. JSON/JUnit are output-only, don't affect test behavior. |
| Hummingbird API changes between builds | Package.swift pins `from: "2.0.0"` — resolved version is locked in Package.resolved. |
| Self-test probe fails because HTTP server hasn't bound yet | 500ms delay before probe. Hummingbird typically binds in <100ms. If still fails, log warning but don't block daemon startup. |
