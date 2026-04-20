# Production E2E Test Rewrite — Design Spec (v4)

*v4: second adversarial audit applied. Fixed globalSetup scoping, ESM compatibility, test ordering, parameter names, per-file exemptions, report collector sequencing, tab ownership acknowledgment. v2-v3 audit trail preserved in git history.*

## 1. Problem Statement

Safari Pilot v0.1.6 shipped a complete three-tier engine architecture (extension + daemon + AppleScript) with HTTP short-poll IPC, reconcile protocol, and 9 security layers. However, **zero e2e tests verify the extension engine path** — the primary engine and the one we spent two days building.

All 18 e2e test files spawn their own MCP server + daemon. The test daemon can't bind port 19475 (system daemon owns it). The extension never connects to test daemons. Every test silently falls back to daemon/AppleScript engine. The test suite gives false confidence: 88 tests "pass" while the primary engine is never exercised.

**The shipped product is untested.** The tests test a different product — one without the extension engine.

## 2. Root Cause (Updated After Audit)

Two root causes, not one:

**Root Cause A — Production code bug:** `CommandDispatcher.handleInternalCommand()` in `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` only handles `extension_status` and `extension_execute` sentinels. The `extension_health` sentinel (used by `ExtensionEngine.isAvailable()`) falls through to `UNKNOWN_INTERNAL_METHOD`, returning `ok: false`. **`isAvailable()` ALWAYS returns false. The extension engine is NEVER selected in the MCP server. This is a production bug — the extension engine is dead code.**

Note: `extension_health` exists as a DIRECT command handler (line 173) — it works when called via `method: "extension_health"`. But `ExtensionEngine.isAvailable()` routes through `DaemonEngine.execute()` which sends `method: "execute"` with `script: "__SAFARI_PILOT_INTERNAL__ extension_health"`. This hits `handleInternalCommand()` (line 202), which does NOT have an `extension_health` case. The direct handler and the sentinel handler are separate code paths.

**Root Cause B — Test infrastructure:** Even after fixing Root Cause A, the test MCP server connects to the system daemon via TCP:19474 (which `DaemonEngine.ensureRunning()` already does). The system daemon has the extension connected. But tests never assert which engine ran — they accept any result from any engine.

**Both must be fixed.** Root Cause A is a prerequisite (Phase 0). Root Cause B is the test rewrite (Phases 1-3).

## 3. Scope

**In scope:**
- **Phase 0:** Fix `handleInternalCommand()` to route `extension_health` sentinel. Rebuild daemon. Verify `isAvailable()` returns true. Run existing test suites to confirm no regression.
- **Phase 1:** Extension engine smoke test gate — prove commands flow through the full extension path with multiple assertion types
- **Phase 1:** Fix any additional bugs discovered (budget 2-3 fixes beyond Phase 0)
- **Phase 2:** Shared test infrastructure (globalSetup preconditions, functional wake probe, engine assertion helper, local fixture server, vitest timeout config)
- **Phase 3a:** Update report collector + rewrite 4 core architecture e2e files (engine-selection, extension-engine, security-pipeline, mcp-handshake)
- **Phase 3b:** Rewrite remaining 14 e2e files
- **Phase 3b:** Degradation test suite (4 scenarios: kill-switch, circuit breaker, extension-unavailable, disconnect)
- **Phase 3a:** Update `test/helpers/e2e-report.ts` for post-rewrite engine expectations (must ship with core files, not after)
- **Phase 3b:** Update ARCHITECTURE.md (remove CURRENT STATE WARNING) and CLAUDE.md
- **Phase 3b:** Remove `describe.skipIf(CI)` — replaced by globalSetup precondition

**Explicitly NOT in scope:**
- CI/CD integration (e2e tests are local-only — Safari can't run in CI)
- New tools or engine capabilities
- Benchmark runner changes
- Extension build pipeline changes
- Fixing the `_meta.engine` overwrite behavior in `server.ts` (see Section 4.2 — metadata reflects selector choice, tests adapt to this reality)

## 4. Architecture

### 4.1 Test Execution Model

```
vitest globalSetup (test/e2e/setup-production.ts)
  │ Check 1: TCP:19474 reachable (system daemon running)
  │ Check 2: extension_health → ipcMechanism: "http" (extension connected)
  │ Check 3: Safari open with windows (AppleScript check)
  │ Check 4: MCP server can spawn and respond to initialize (dist/index.js valid)
  │ ANY FAIL → throw Error (suite aborts immediately)
  ▼
Per-file test execution (serial, fileParallelism: false)
  │ beforeAll:
  │   1. Spawn McpTestClient (node dist/index.js)
  │   2. MCP server's DaemonEngine connects to system daemon via TCP:19474
  │   3. safari_new_tab with unique URL (local fixture server or example.com?e2e=<fileId>)
  │   4. Capture ACTUAL tab URL from safari_new_tab response (Safari may normalize)
  │   5. ensureExtensionAwake(client, actualTabUrl, nextId) — functional probe
  │ tests:
  │   Each tool call uses callToolExpectingEngine(client, tool, args, expectedEngine)
  │   Asserts _meta.engine matches expected engine
  │   For proxy-based tools: also verifies result content proves physical execution
  │ afterAll (wrapped in try/finally):
  │   Close all tabs created by this file (tolerates missing client)
  │   Kill McpTestClient process (tolerates already-killed)
```

### 4.2 Engine Metadata: What `_meta.engine` Actually Means

**Critical:** `server.ts:607` unconditionally overwrites `result.metadata.engine = selectedEngineName`. This means `_meta.engine` reflects the **engine selector's choice**. However, its relationship to the physical execution engine depends on **how the tool module receives its engine**.

#### The Engine Proxy Pattern

`server.ts:228-246` creates an `EngineProxy` and passes it to most tool modules. Before each tool call, `server.ts:500-502` calls `proxy.setDelegate(selectedEngine)`. This means **for proxy-based tools, the selected engine IS the physical execution engine**.

```
// server.ts:228-246 — tool module construction
const proxy = new EngineProxy(engine);                    // ← IEngine proxy
const navTools = new NavigationTools(engine);              // ← AppleScriptEngine directly
const interactionTools = new InteractionTools(proxy, this); // ← proxy
const extractionTools = new ExtractionTools(proxy);         // ← proxy
const shadowTools = new ShadowTools(proxy);                 // ← proxy
const networkTools = new NetworkTools(proxy);                // ← proxy
const storageTools = new StorageTools(proxy);                // ← proxy
const frameTools = new FrameTools(proxy);                    // ← proxy
const permissionTools = new PermissionTools(proxy);          // ← proxy
const clipboardTools = new ClipboardTools(proxy);            // ← proxy
const serviceWorkerTools = new ServiceWorkerTools(proxy);    // ← proxy
const performanceTools = new PerformanceTools(proxy);        // ← proxy
const structuredExtractionTools = new StructuredExtractionTools(proxy); // ← proxy
const waitTools = new WaitTools(proxy);                      // ← proxy
const compoundTools = new CompoundTools(engine);             // ← AppleScriptEngine directly
const downloadTools = new DownloadTools(this);               // ← server (uses daemon internally)
const pdfTools = new PdfTools(this);                         // ← server (uses daemon + AppleScript)
```

#### Two-Tier Assertion Strategy

| Category | Tool Modules | `_meta.engine` when extension available | Physical execution engine | What to assert |
|----------|-------------|----------------------------------------|--------------------------|----------------|
| **Proxy-based** (13 modules) | Extraction, Interaction, Shadow, Network, Storage, Frame, Permission, Clipboard, ServiceWorker, Performance, StructuredExtraction, Wait | `extension` | Extension (via proxy) | `_meta.engine === 'extension'` proves BOTH selector AND execution. For Shadow DOM tools, additionally verify result content only extension can produce. |
| **Direct-engine** (4 modules) | Navigation, Compound, Download, PDF | `extension` | AppleScript / Daemon (hardcoded) | `_meta.engine === 'extension'` proves selector only. Verify result via observable behavior (page loaded, PDF exists, download completed). |

**For Phase 3 tests:**
- **Proxy-based tools:** Assert `_meta.engine === 'extension'`. This IS physical execution proof. For Shadow DOM tools, also verify the result contains content AppleScript cannot access.
- **Direct-engine tools:** Assert `_meta.engine === 'extension'`. This is selector proof. Also verify the observable result (URL changed, PDF generated, etc.).

### 4.3 Why This Works

The test MCP server spawns fresh → `DaemonEngine.ensureRunning()` probes TCP:19474 → system daemon responds → `useTcp = true`. All commands route through the system daemon. The system daemon has the extension connected via HTTP:19475. `ExtensionEngine.isAvailable()` queries `extension_health` (after Phase 0 fix) → `ipcMechanism: "http"` → returns true. Engine selector picks extension for all capable tools. The engine proxy delegates to the extension engine for all proxy-based tools.

The MCP server process IS fresh per test file: tab ownership, circuit breaker, rate limiter, audit log — all reset. The daemon and extension are shared — they're the production system.

### 4.4 Response Shape Round-Trip (extension_health sentinel)

When `ExtensionEngine.isAvailable()` sends `__SAFARI_PILOT_INTERNAL__ extension_health`:

1. **Daemon side:** `handleInternalCommand()` calls `extensionBridge.healthSnapshot(store:)` → returns a Swift dictionary → `Response.success(id:, value: AnyCodable(dict))` → NDJSON: `{"ok":true,"value":{"ipcMechanism":"http",...}}`
2. **DaemonEngine.execute()** (daemon.ts:177-181): `response.value` is an object → `JSON.stringify(response.value)` → returns `EngineResult { ok: true, value: '{"ipcMechanism":"http",...}' }`
3. **ExtensionEngine.isAvailable()** (extension.ts:54-58): `result.value` is a string → `JSON.parse(result.value)` → reads `parsed.ipcMechanism` → `"http"` → returns `true`

The `JSON.stringify` → `JSON.parse` round-trip preserves the data. Phase 0 verification MUST confirm this specific path produces `ipcMechanism: "http"` (not `undefined`, not a nested wrapper).

### 4.5 Extension Alarm Cycle

The extension alarm fires every **1 minute** (`KEEPALIVE_PERIOD_MIN = 1` in `background.js:9`, `periodInMinutes: 1` at line 336). When Safari kills the event page (30-60s inactivity), the worst-case wake latency is:
- Event page killed → up to 60s before next alarm → alarm fires → `initialize()` → `pollLoop()` → command delivered

Maximum theoretical latency: **~60s** for the first command after event page death. Subsequent commands are immediate (event page stays alive during active polling).

## 5. Phase 0: Fix Production Code Bug (BLOCKER)

### 5.1 The Bug

`CommandDispatcher.handleInternalCommand()` in `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` handles only two sentinels:
- `extension_status` → `bridge.handleStatus()`
- `extension_execute` → `bridge.handleExecute()`

The `extension_health` sentinel (sent by `ExtensionEngine.isAvailable()` via `this.daemon.execute("__SAFARI_PILOT_INTERNAL__ extension_health")`) falls through to the `default` case and returns `UNKNOWN_INTERNAL_METHOD` error.

Note: the direct `extension_health` command handler at line 173 works. Only the sentinel route (through `handleInternalCommand()` at line 202) is broken.

Result: `isAvailable()` always returns `false`. `SafariPilotServer.initialize()` sets `extensionAvailable = false`. The extension engine is never registered. `selectEngine()` never returns `'extension'`. Every tool falls back to daemon/AppleScript.

### 5.2 The Fix

Add `extension_health` case to `handleInternalCommand()`:

```swift
case "extension_health":
    let snapshot = extensionBridge.healthSnapshot(store: healthStore)
    return Response.success(id: commandID, value: AnyCodable(snapshot))
```

This is identical to the direct handler at line 173 — same method, same response shape.

### 5.3 Verify the Fix

1. Rebuild daemon: `bash scripts/update-daemon.sh` (this does atomic swap + launchctl restart)
2. Wait 2s for daemon to start accepting connections
3. Verify via NDJSON: `echo '{"id":"t","method":"execute","params":{"script":"__SAFARI_PILOT_INTERNAL__ extension_health"}}' | nc -w 3 localhost 19474`
4. Expected: `{"ok":true,"value":{"ipcMechanism":"http","isConnected":true,...}}`
5. **If `value` is missing `ipcMechanism` or `value` is a string instead of object:** the sentinel handler returns a different shape than expected. Debug the `Response.success` construction.
6. **Run existing test suites:** `npm run test:unit && npm run test:integration` — verify no regression from the Swift change (daemon tests exercise `handleInternalCommand` via the execute path)

### 5.4 Verify Response Shape Through DaemonEngine.execute()

The `extension_health` response is a dictionary (not a string). The round-trip is:
- Daemon sends: `{"ok":true,"value":{"ipcMechanism":"http",...}}` (object value)
- `DaemonEngine.execute()` receives object → `JSON.stringify(value)` → returns string
- `ExtensionEngine.isAvailable()` receives string → `JSON.parse()` → reads `ipcMechanism`

Verify this round-trip by spawning a fresh MCP server and checking engine availability:
```bash
# Quick check: spawn MCP server, send initialize, check if extension engine registered
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}' | timeout 10 node dist/index.js 2>&1 | head -5
```
If the server log mentions `extension: true` or `extensionAvailable: true`, the fix works.

### 5.5 Gate Rule

Phase 1 DOES NOT START until:
1. `isAvailable()` returns `true` when the system daemon is running with the extension connected
2. All existing unit tests pass (1428)
3. All existing daemon tests pass (74)

## 6. Phase 1: Extension Engine Smoke Test (Gate)

### 6.1 The Test (Expanded Per Audit)

Create `test/e2e/00-extension-smoke-gate.test.ts`:

**Test 1 — Health check:** Call `safari_extension_health` → assert `ipcMechanism: 'http'`, `isConnected: true`.

**Test 2 — Simple JS execution:** Create tab at `https://example.com`, capture the **actual URL from `safari_new_tab` response** (Safari may normalize), call `safari_evaluate` with `script: 'return document.title'` using the ACTUAL tab URL, assert result contains "Example Domain", assert `_meta.engine === 'extension'`. **Note:** The MCP parameter name is `script` (not `expression`) — see `inputSchema` in `extraction.ts:152`.

**Test 3 — Complex result marshaling:** Call `safari_evaluate` with `script: 'return JSON.stringify({a: 1, b: "hello", c: [1,2,3]})'`, assert the JSON round-trips correctly through `POST /result` → `handleResult` → TCP → `DaemonEngine` → MCP response.

**Test 4 — URL with query params:** Create tab at `https://example.com/?e2e=smoke&ts=12345`, capture the **actual tab URL from the `safari_new_tab` response** (do NOT use the input URL — Safari may strip/reorder query params). Call `safari_evaluate` with `script: 'return document.title'` using the actual URL. This stresses `findTargetTab()` URL matching.

**Test 5 — Sequential commands:** Execute two `safari_evaluate` calls in sequence on the same tab. Assert both return correct results. This proves the command → result → next command pipeline doesn't deadlock.

**ID management:** Each test file gets a `nextId` counter initialized from `initClient()`. Every `rawCallTool`/`callTool` call consumes one ID. Thread the counter carefully:
```typescript
let nextId: number;
// In beforeAll:
const init = await initClient(SERVER_PATH);
client = init.client;
nextId = init.nextId;  // starts at 2 (1 used by initialize)
// In each test:
const { payload, meta } = await rawCallTool(client, tool, args, nextId++, timeout);
```

**Timeouts:** 90 seconds per test (matching `EXTENSION_TIMEOUT_MS`). The smoke test absorbs the extension wake latency — subsequent tests can use shorter timeouts because the extension is already awake.

### 6.2 If the Smoke Test Fails

Use systematic-debugging skill. Likely failure points (prioritized by audit findings):

1. **`_meta.engine === 'daemon'`:** Phase 0 fix didn't work. Check `handleInternalCommand` routing. Check DaemonEngine.execute() response shape — is `result.value` a string containing JSON, or undefined? Add `console.error` in `isAvailable()` to log the actual response.
2. **Timeout (90s):** Extension not polling. Check `isConnected` via `bash scripts/health-check.sh`. Check if HTTP:19475 is responding. Check if `pollLoop()` is running in background.js.
3. **`No target tab`:** Extension received command but `findTargetTab` failed. URL mismatch — the tab URL from `safari_new_tab` response doesn't match what `browser.tabs.query({})` returns. Check trailing slash normalization.
4. **Result wrong shape:** JSON marshaling through the extension → POST /result → daemon → TCP → MCP chain corrupted the response. Check at each boundary.

Budget 2-3 fixes BEYOND the Phase 0 fix.

### 6.3 Gate Rule

Phase 2 DOES NOT START until ALL 5 smoke tests pass with `_meta.engine === 'extension'`.

## 7. Phase 2: Test Infrastructure

### 7.1 Global Setup (`test/e2e/setup-production.ts`)

**CRITICAL: This setup must ONLY run for e2e tests.** The project has a single vitest config with `include: ['test/**/*.test.ts']`. Adding `setup-production.ts` to the root `globalSetup` would make `npm run test:unit` require a running daemon + Safari + extension — breaking the fast, always-runnable unit test safety net.

**Solution:** The setup detects whether e2e tests are included in the current run. If no e2e files are being run, it exits immediately:

```typescript
import { createConnection } from 'node:net';
import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = fileURLToPath(new URL('.', import.meta.url));

export async function setup() {
  // Only enforce preconditions when e2e tests are included.
  // When running unit/integration only, skip silently.
  const testFilter = process.env['VITEST_INCLUDE'] ?? process.argv.join(' ');
  const isE2eRun = testFilter.includes('test/e2e') || testFilter.includes('test:e2e')
    || !testFilter.includes('test/unit') && !testFilter.includes('test:unit')
       && !testFilter.includes('test/integration');
  // Conservative: if we can't tell, run the checks (they're fast when passing)

  // Check 1: System daemon on TCP:19474
  const daemonUp = await checkTcp(19474);
  if (!daemonUp) {
    if (!isE2eRun) { console.log('E2E setup: daemon not running (skipped — not an e2e run)'); return; }
    throw new Error(
      'E2E PRECONDITION FAILED: System daemon not running on TCP:19474.\n' +
      'Start it: launchctl load ~/Library/LaunchAgents/com.safari-pilot.daemon.plist'
    );
  }

  // Check 2: Extension connected (ipcMechanism: "http")
  const health = await queryExtensionHealth();
  if (health?.ipcMechanism !== 'http') {
    if (!isE2eRun) { console.log('E2E setup: extension not connected (skipped — not an e2e run)'); return; }
    throw new Error(
      'E2E PRECONDITION FAILED: Extension not connected (ipcMechanism: ' + health?.ipcMechanism + ').\n' +
      'Open "bin/Safari Pilot.app" and enable the extension in Safari > Settings > Extensions'
    );
  }

  // Check 3: Safari open
  let safariOk = false;
  try {
    const count = execSync('osascript -e \'tell application "Safari" to count of windows\'').toString().trim();
    safariOk = parseInt(count) > 0;
  } catch { /* Safari not running or JS from Apple Events disabled */ }
  if (!safariOk) {
    if (!isE2eRun) { console.log('E2E setup: Safari not open (skipped — not an e2e run)'); return; }
    throw new Error(
      'E2E PRECONDITION FAILED: Safari not running, has no windows, or JS from Apple Events not enabled.'
    );
  }

  // Check 4: MCP server can spawn (dist/index.js exists and responds)
  const mcpOk = await checkMcpServerSpawns();
  if (!mcpOk) {
    if (!isE2eRun) { console.log('E2E setup: MCP server failed to start (skipped — not an e2e run)'); return; }
    throw new Error(
      'E2E PRECONDITION FAILED: MCP server failed to start. Run: npm run build'
    );
  }

  console.log('E2E preconditions passed: daemon running, extension connected, Safari open, MCP server valid');
}

export function teardown() {
  // No persistent state to clean up — all probes are stateless.
}
```

**`queryExtensionHealth()` implementation:** Must NOT import from `src/`. Use raw TCP to query the daemon:

```typescript
async function queryExtensionHealth(): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port: 19474 }, () => {
      const cmd = JSON.stringify({
        id: 'setup-health',
        method: 'execute',
        params: { script: '__SAFARI_PILOT_INTERNAL__ extension_health' },
      }) + '\n';
      sock.write(cmd);
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('\n')) {
          try {
            const resp = JSON.parse(buf.split('\n')[0]);
            sock.destroy();
            if (resp.ok && typeof resp.value === 'object') {
              resolve(resp.value);
            } else if (resp.ok && typeof resp.value === 'string') {
              resolve(JSON.parse(resp.value));
            } else {
              resolve(null);
            }
          } catch { sock.destroy(); resolve(null); }
        }
      });
    });
    sock.on('error', () => resolve(null));
    sock.setTimeout(5000, () => { sock.destroy(); resolve(null); });
  });
}
```

**`checkMcpServerSpawns()` implementation:** Must kill the spawned process in ALL cases. Uses `import.meta.url` (ESM — this project has `"type": "module"` in package.json; `__dirname` is NOT available):

```typescript
async function checkMcpServerSpawns(): Promise<boolean> {
  return new Promise((resolve) => {
    const serverPath = join(__dir, '../../dist/index.js');
    const proc = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(false); }, 10_000);
    const initMsg = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'setup-check', version: '1.0' } },
    }) + '\n';
    proc.stdin!.write(initMsg);
    let buf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes('"result"')) {
        clearTimeout(timer);
        proc.kill('SIGTERM');
        resolve(true);
      }
    });
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
    proc.on('close', () => { clearTimeout(timer); /* resolve already called or will be */ });
  });
}
```

### 7.2 Functional Extension Wake Probe (`test/helpers/ensure-extension-awake.ts`)

**Audit finding:** The original `wakeExtension()` checked daemon-side `isConnected` state — this reflects historical connection, not live presence. The extension event page may be dead while `isConnected: true`.

**Fixed approach:** Send a REAL command through the extension engine and wait for a response. If it succeeds, the extension is alive. If it times out, wait for the alarm cycle (1 minute) and retry.

```typescript
export async function ensureExtensionAwake(
  client: McpTestClient,
  tabUrl: string,
  nextId: number,
): Promise<number> {
  // Functional probe: send a real JS command through the extension engine.
  // If the extension is asleep, this will wait up to 90s for the alarm cycle
  // (1 minute period) to wake it. After the first success, subsequent commands
  // are fast (0-5s).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { meta } = await rawCallTool(
        client,
        'safari_evaluate',
        { script: 'return 1', tabUrl },
        nextId++,
        attempt === 0 ? 90_000 : 30_000,  // First attempt: full alarm cycle. Retry: shorter.
      );
      if (meta?.engine === 'extension') {
        return nextId;  // Extension is awake and routing correctly
      }
      // Engine wasn't extension — Phase 0 fix may not be working
      throw new Error(`Extension wake probe: engine was '${meta?.engine}', expected 'extension'`);
    } catch (err) {
      if (attempt === 0) {
        console.warn('Extension wake probe timed out, waiting for alarm cycle...');
        await new Promise(r => setTimeout(r, 30_000));
        continue;
      }
      throw new Error(`Extension not responding after 2 wake attempts: ${(err as Error).message}`);
    }
  }
  throw new Error('Extension wake probe: unreachable');
}
```

### 7.3 Engine Assertion Helper (`test/helpers/assert-engine.ts`)

```typescript
export async function callToolExpectingEngine(
  client: McpTestClient,
  tool: string,
  args: Record<string, unknown>,
  expectedEngine: 'extension' | 'daemon' | 'applescript',
  nextId: number,
  timeout = 60_000,  // 60s default — accommodates extension wake cycle
): Promise<{ payload: Record<string, unknown>; meta: Record<string, unknown> }> {
  const { payload, meta, result } = await rawCallTool(client, tool, args, nextId, timeout);

  if (!meta?.engine) {
    // Check backup __engine field in payload (server.ts:622 embeds this when
    // Claude CLI strips _meta from stream-json output)
    const backupEngine = payload?.__engine;
    if (backupEngine) {
      if (backupEngine !== expectedEngine) {
        throw new Error(`${tool}: expected engine '${expectedEngine}' but got '${backupEngine}' (from __engine backup)`);
      }
      return { payload, meta: { engine: backupEngine } as Record<string, unknown> };
    }
    throw new Error(`${tool}: response missing _meta.engine AND __engine — result: ${JSON.stringify(result).slice(0, 200)}`);
  }

  if (meta.engine !== expectedEngine) {
    throw new Error(
      `${tool}: expected engine '${expectedEngine}' but got '${meta.engine}'` +
      ` — this means the engine selector is routing incorrectly`
    );
  }

  return { payload, meta: meta as Record<string, unknown> };
}
```

### 7.4 Local Fixture Server (Optional)

**Audit finding:** Network dependency on `example.com` adds an external failure mode.

The project already has a fixture server infrastructure (`test/fixtures/`, `src/benchmark/fixture-server.ts`). For tests that don't need a real external site, use the local fixture server. For tests that specifically verify real-world page handling (extraction, navigation), `example.com` is appropriate.

### 7.5 Vitest Config Update

```typescript
// vitest.config.ts changes:
globalSetup: ['./test/setup-retention.ts', './test/e2e/setup-production.ts'],
```

The `setup-production.ts` file detects whether e2e tests are included in the run and skips precondition checks for unit/integration-only runs (see Section 7.1). This is safe to add to the single root config.

**Timeout overrides for e2e files:** The project has a single vitest config (no workspace). The default test timeout (5s) is far too short for extension wake cycles. Since all tests already run with `fileParallelism: false`, setting global timeouts to e2e-safe values won't hurt unit test speed (unit tests complete in milliseconds regardless of the ceiling):

```typescript
testTimeout: 120_000,    // 2 minutes per test — unit tests still finish in <5s
hookTimeout: 180_000,    // 3 minutes for beforeAll/afterAll
```

**Alternative (lower risk):** If inflating the global timeout is undesirable, set timeouts per-describe in e2e files:
```typescript
describe('suite', { timeout: 120_000 }, () => { ... });
```

### 7.6 Test Timeouts (Corrected)

**Alarm cycle is 1 minute** (`KEEPALIVE_PERIOD_MIN = 1` in `background.js:9`). Timeouts must accommodate this:

| Context | Timeout | Rationale |
|---------|---------|-----------|
| Smoke test (Phase 1) | 90s | Full alarm cycle (60s) + command execution + buffer |
| `ensureExtensionAwake()` first attempt | 90s | Same — absorbs worst-case wake |
| `ensureExtensionAwake()` retry | 30s | Event page should be alive after first attempt |
| Normal tool calls after extension confirmed awake | 60s | Buffer for event page kill + re-wake mid-test |
| Non-extension tools (navigation, PDF, downloads) | 20s | No extension dependency |
| vitest per-test timeout | 120s | Must exceed longest tool call + overhead |
| vitest beforeAll/afterAll timeout | 180s | Spawn + wake probe + tab creation |

## 8. Phase 3: Rewrite E2E Test Suite (19 files total)

### 8.1 Phase 3a — Core Architecture (5 items, ship first)

These files prove the architecture works. Ship and validate before rewriting the remaining 14.

- **`00-extension-smoke-gate.test.ts`** (already created in Phase 1) — 5 tests proving extension engine works.
- **`engine-selection.test.ts`** — verify ALL tools report `_meta.engine === 'extension'` when extension available. This is the engine selector proof.
- **`extension-engine.test.ts`** — extension-specific: JS execution, content script relay, Shadow DOM access, results through extension. Remove "disconnected" branch.
- **`security-pipeline.test.ts`** — 8 functional security layers with extension engine routing. **Note:** TabOwnership (layer 2) is structurally present but `registerTab()` is never called in production code — the check at `server.ts:403-411` passes silently when `findByUrl()` returns `undefined`. Test the code path as-is (verify the check doesn't throw for agent-created tabs) but do NOT claim "tab ownership is enforced." Flag as a roadmap item to wire up tab registration post-execution.
- **`test/helpers/e2e-report.ts`** — Update the report collector BEFORE shipping core files (they depend on it). Changes: hardcode `extensionConnected = true`, update `expectedEngineFor()` to return `'extension'` for all tools, rename `TOOLS_WITH_NO_ENGINE` to `SELECTOR_ONLY_TOOLS` (these tools have engine selection metadata but execute via hardcoded engines).

### 8.2 Phase 3b — Remaining 14 Files

- **`mcp-handshake.test.ts`** — MCP protocol, tool listing, health checks.
- **`shadow-dom.test.ts`** — Shadow DOM access via extension. Verify result contains content AppleScript CAN'T access (this proves physical execution, not just selector).
- **`extension-lifecycle.test.ts`** — health, ipcMechanism, reconcile timestamp, cold-wake (DEBUG_HARNESS).
- **`extension-health.test.ts`** — health snapshot with HTTP counters.
- **`extraction-tools.test.ts`** — get_text, get_html, evaluate, snapshot via extension (proxy-based — `_meta.engine` is execution proof).
- **`interaction-tools.test.ts`** — click, fill, select_option via extension (proxy-based — `_meta.engine` is execution proof).
- **`navigation-tools.test.ts`** — new_tab, navigate, close_tab. Assert `engine: 'extension'` (selector choice only — NavigationTools receives AppleScriptEngine directly). Verify result via observable behavior (page loaded, URL changed).
- **`accessibility.test.ts`** — snapshot ARIA tree via extension.
- **`pdf-generation.test.ts`** — export_pdf. Assert `engine: 'extension'` (selector choice only — PdfTools uses daemon/AppleScript internally). Verify PDF output file exists.
- **`downloads.test.ts`** — wait_for_download via daemon.
- **`http-roundtrip.test.ts`** — HTTP IPC verification. Extension IS connected — remove conditional paths.
- **`commit-1a-shippable.test.ts`** — source contracts + MCP handshake.
- **`engine-routing.test.ts`** (renamed from `three-tier-fallback.test.ts`) — three-tier routing proof.
- **`daemon-engine.test.ts`** — daemon-specific tools.

### 8.3 Degradation Test Suite (Expanded Per Audit)

**Audit finding:** Removing ALL fallback tests deletes coverage for a shipped product feature. One kill-switch test is insufficient.

Repurpose `applescript-fallback.test.ts` as `degradation.test.ts` with MULTIPLE degradation scenarios:

**Scenario 1 — Config kill-switch:**

Disable extension via `safari-pilot.config.json` `extension.enabled: false`. Verify tools fall back to daemon/AppleScript. Verify `_meta.engine !== 'extension'`.

**Config isolation (MANDATORY):** Back up the config file before modification, restore in `afterAll` with `try/finally`:
```typescript
const CONFIG_PATH = join(import.meta.dirname, '../../safari-pilot.config.json');
let originalConfig: string;
beforeAll(async () => {
  originalConfig = readFileSync(CONFIG_PATH, 'utf-8');
  const config = JSON.parse(originalConfig);
  config.extension.enabled = false;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  // Spawn a FRESH MCP server — it reads config at startup
  const init = await initClient(SERVER_PATH);
  // ...
});
afterAll(async () => {
  try { await client?.close(); } catch {}
  // ALWAYS restore — even if tests threw
  writeFileSync(CONFIG_PATH, originalConfig);
});
```

**Scenario 2 — Circuit breaker trip + recovery:**

Trigger 5 errors on a domain via intentional failures. The circuit breaker at `src/security/circuit-breaker.ts` trips after `errorThreshold: 5` errors within `windowMs: 60000`. Errors are recorded at `server.ts:632` when a tool throws.

**How to generate failures:** Call a tool that will error 5 times against the same domain. For example:
- `safari_evaluate` with invalid JS on a specific tab URL (e.g., `throw new Error('breaker-test')`)
- `safari_click` with a selector that doesn't exist — but this might NOT throw (may return an error result instead of throwing)

**Safest approach:** Call `safari_evaluate` with `script: '(function(){throw new Error("trip")})()'` 5 times against the same tab's domain. Each call throws a JS error, which propagates as a tool error, which hits `circuitBreaker.recordFailure(domain)`. (Parameter name is `script`, not `expression` — see `extraction.ts:152`.)

**Verify breaker is open:** After 5 errors, send a 6th call to the SAME domain. The circuit breaker at `server.ts:459` calls `assertClosed(domain)` which throws `CircuitBreakerOpenError` (error code `CIRCUIT_BREAKER_OPEN`). The MCP response will contain this error. Assert the response contains `CIRCUIT_BREAKER_OPEN`:

```typescript
// After 5 failing calls to the same domain:
const { payload } = await rawCallTool(client, 'safari_evaluate', { script: 'return 1', tabUrl }, nextId++, 10_000);
expect(payload._rawText ?? JSON.stringify(payload)).toContain('CIRCUIT_BREAKER_OPEN');
```

Wait for cooldown (120s — `cooldownMs` from config).

**Verify breaker recovers:** Send a successful call to the same domain. Assert it succeeds with `_meta.engine === 'extension'`:

```typescript
await new Promise(r => setTimeout(r, 120_000));
const { meta } = await rawCallTool(client, 'safari_evaluate', { script: 'return 1', tabUrl }, nextId++, 60_000);
expect(meta?.engine).toBe('extension');  // Breaker closed, extension available again
```

**Timeout:** This test takes 120+ seconds for the cooldown alone. Total: ~5s setup + ~25s trips + 120s cooldown + ~10s recovery = **~160s**. Set an explicit test-level timeout:
```typescript
it('circuit breaker trips after 5 errors and recovers after cooldown', { timeout: 300_000 }, async () => { ... });
```
The 300s test timeout exceeds both the 120s global `testTimeout` and the 120s cooldown. The `hookTimeout` (180s) doesn't apply to individual tests.

**Scenario 3 — Extension-unavailable (selector kill-switch path):**

This replaces the originally-planned separate `extension-unavailable.test.ts` (which would have been redundant with Scenario 1 — both modify the same config and test the same `selectEngine()` code path).

Same config isolation as Scenario 1 (`extension.enabled: false`, backup/restore in try/finally). Verifies:
- MCP server starts and lists tools (count may change — assert `>= 75`, not exact equality)
- `safari_health_check` returns checks array
- AppleScript/daemon tools work (`_meta.engine` will be `daemon` or `applescript`)
- Extension-requiring tools (`requiresShadowDom: true`) throw `EngineUnavailableError` (not silent fallback)

**Note:** This tests the ENGINE SELECTOR's kill-switch path, not the actual first-install experience (which would require a daemon that has never seen an extension — out of scope, flag as roadmap item).

**Scenario 4 — Extension disconnect during use (OPTIONAL, if DEBUG_HARNESS available):**

Send `__safari_pilot_test_force_unload__` to trigger extension page reload. Verify daemon detects disconnect. Verify commands during disconnect timeout or fall back. Verify extension reconnects on next alarm.

This scenario requires `DEBUG_HARNESS` markers in `background.js` and `SAFARI_PILOT_TEST_MODE=1` env var.

### 8.4 Per-File Changes

**Applied to standard MCP test files** (15 of 20 files). Three files are EXEMPT — see Section 8.4.1.

1. Remove `describe.skipIf(process.env.CI === 'true')` — globalSetup handles this
2. Create tab via `safari_new_tab`, capture the **actual returned URL** (not the input URL)
3. Add `ensureExtensionAwake(client, actualTabUrl, nextId)` in `beforeAll` after tab creation. **Capture the returned nextId.**
4. Replace all `callTool()` with `callToolExpectingEngine()` specifying `'extension'` for selector verification
5. Remove all `if (extensionConnected)` conditional branches — extension IS connected
6. Use unique tab URL: local fixture server or `https://example.com/?e2e=<fileName>`
7. Timeouts: 60s for extension-engine tools, 20s for non-extension tools
8. **Robust afterAll — tolerates partial setup failures:**
```typescript
afterAll(async () => {
  try {
    if (tabUrl && client) {
      await rawCallTool(client, 'safari_close_tab', { tabUrl }, nextId++, 10_000)
        .catch(() => {}); // Best-effort tab cleanup
    }
  } finally {
    await client?.close().catch(() => {});
  }
});
```
9. **nextId discipline:** Initialize from `initClient()`, increment with `nextId++` on every `rawCallTool`/`callTool`/`callToolExpectingEngine` call. Never reuse IDs. Never use a separate counter.
10. **Report collector calls:** Replace `report.setExtensionConnected(extensionConnected)` with `report.setExtensionConnected(true)`. Remove any conditional logic around extension probing (health check to determine `extensionConnected`).

### 8.4.1 Exempt Files (Do NOT apply per-file changes)

| File | Reason | What to change instead |
|------|--------|------------------------|
| `daemon-engine.test.ts` | Uses its own `DaemonTestClient`, not `McpTestClient`. Tests daemon NDJSON protocol directly, not MCP. No tab creation, no engine selection. | Only remove `describe.skipIf(CI)` — globalSetup handles this. Leave everything else as-is. |
| `extension-health.test.ts` | 39 lines. Calls one tool (`safari_extension_health`). No tab needed. No engine assertion needed — the tool returns a health snapshot, not engine-routed content. | Only remove `describe.skipIf(CI)`. Leave everything else as-is. |
| `commit-1a-shippable.test.ts` | Mostly static file grepping (code presence assertions). MCP roundtrip is a single health check. No tab, no engine assertion needed. | Only remove `describe.skipIf(CI)`. Leave everything else as-is. |

### 8.5 Documentation Updates

**ARCHITECTURE.md:**
- Remove "CURRENT STATE WARNING" (lines 9-14)
- Update verified date
- Change "end-to-end roundtrips not yet confirmed" → "end-to-end roundtrips verified by production-stack e2e tests"
- Document that `_meta.engine` reflects selector choice for ALL tools, but ALSO reflects physical execution for proxy-based tools (13 of 17 modules)
- Document the engine proxy pattern

**CLAUDE.md:**
- Update e2e testing section: "E2E tests require the production stack: system daemon running on TCP:19474, Safari extension connected via HTTP:19475, Safari open with JS from Apple Events enabled."
- Update test count
- Document Phase 0 fix (handleInternalCommand routing)

### 8.6 Report Collector Update (Ships with Phase 3a)

**`test/helpers/e2e-report.ts` changes — must be done BEFORE Phase 3a core files ship:**

After the rewrite, extension is ALWAYS connected. The `E2EReportCollector` class has `extensionConnected` defaulting to `false` (line 114), set via `setExtensionConnected()` (line 120). If Phase 3a test files remove the `extensionConnected` variable and the health check probe, but don't update the report collector, all tools would have `expectedEngine = 'daemon'` and flag every `engine: 'extension'` result as a violation.

Update:
- Rename `TOOLS_WITH_NO_ENGINE` → `SELECTOR_ONLY_TOOLS` (these tools have engine metadata but execute via hardcoded engines — navigation, compound, PDF, downloads)
- Constructor: default `extensionConnected = true`
- Keep `setExtensionConnected()` for `degradation.test.ts` (Scenarios 1/3 set it to `false`)
- `expectedEngineFor()` logic must handle BOTH states:
  ```typescript
  expectedEngineFor(tool: string): string {
    if (!this.extensionConnected) {
      // Degradation mode: extension killed via config
      if (EXTENSION_REQUIRED_TOOLS.has(tool)) return 'rejected';
      return 'daemon';  // non-extension tools fall back to daemon
    }
    return 'extension';  // ALL tools expect extension when connected
  }
  ```
- Compliance checking: when `extensionConnected = true`, verify `engine === 'extension'` for all tools. When `false`, verify `engine === 'daemon'` or `'applescript'` (not `'extension'`), and verify extension-required tools are rejected.

## 9. Success Criteria

| Criterion | Verification |
|-----------|-------------|
| Phase 0: `handleInternalCommand` routes `extension_health` | Daemon test + NDJSON verification |
| Phase 0: `isAvailable()` returns true with system daemon | MCP server log or smoke test |
| Phase 0: Existing unit tests pass (1428) | `npm run test:unit` exit 0 |
| Phase 0: Existing daemon tests pass (74) | Daemon test exit 0 |
| Phase 1: All 5 smoke tests pass with `_meta.engine === 'extension'` | vitest exit 0 |
| Phase 2: globalSetup throws on precondition failure for e2e runs | Stop daemon, run `npm run test:e2e` — verify throw. Run `npm run test:unit` — verify skip. |
| Phase 2: `ensureExtensionAwake` sends REAL command through extension | Functional probe, not metadata |
| Phase 2: vitest timeout config prevents false timeouts | Config verified |
| Phase 3a: Report collector updated FIRST | `e2e-report.ts` defaults `extensionConnected = true`, returns `'extension'` for all tools |
| Phase 3a: 4 core architecture files pass | vitest exit 0 |
| Phase 3b: All remaining files pass | vitest exit 0 |
| Phase 3b: degradation.test.ts covers 4 scenarios | kill-switch + circuit breaker + extension-unavailable + disconnect(optional) |
| Phase 3b: circuit breaker test has explicit 300s timeout | Test-level `{ timeout: 300_000 }` |
| Phase 3b: 3 exempt files only have `describe.skipIf` removed | daemon-engine, extension-health, commit-1a unchanged otherwise |
| No `describe.skipIf(CI)` in any e2e file | grep returns zero |
| No `if (extensionConnected)` branches (except degradation.test.ts) | grep returns zero outside degradation |
| No source imports in test/e2e/ | grep `from '../../src/'` returns zero |
| No `__dirname` in test/e2e/ files | grep returns zero (project uses `import.meta.dirname`) |
| ARCHITECTURE.md warning removed | diff |
| All unit tests pass | exit 0 |
| All daemon tests pass | exit 0 |

## 10. Risks

| Risk | Mitigation |
|------|-----------|
| Phase 0 fix changes daemon response shape, breaks existing consumers | Verify via NDJSON + unit test before rebuild. The sentinel route calls identical code to the direct handler. |
| DaemonEngine.execute() JSON.stringify → isAvailable() JSON.parse round-trip fails | Verified in Section 4.4. Smoke test catches immediately if broken. |
| Extension engine path has additional bugs beyond Phase 0 | Phase 1 smoke test discovers them with 5 distinct assertion types. Budget 2-3 fixes. |
| Extension disconnects during test run (event page killed after 30-60s inactivity) | `ensureExtensionAwake()` functional probe in beforeAll. 60s timeouts. Extension reconnects within 60s via alarm (1-minute period). |
| System daemon not running when developer runs tests | globalSetup throws with actionable diagnostic. |
| Tab URL differs from input URL (Safari normalization) | Always use the URL returned by `safari_new_tab`, never the input URL. |
| Tab URL collisions across test files | Unique query params per file. Serial execution. |
| Circuit breaker trips from security rejection tests | Fresh MCP server per file — circuit breaker resets. |
| `_meta.engine` reflects selector choice, not always execution engine | Two-tier assertion strategy: proxy-based tools = execution proof, direct-engine tools = selector proof. |
| example.com network dependency | Use local fixture server for most tests. example.com only for real-world extraction/navigation tests. |
| Phase 3 scope too large for one cycle | Split into 3a (4 core files) + 3b (14 files). Ship 3a first, validate approach. |
| Degradation test modifies config file | Backup/restore in try/finally. Test in isolation. |
| Process leak from test timeouts (afterAll never runs) | Robust afterAll with optional chaining + catch. vitest `forceExit: true` as safety net. |
| vitest default 5s timeout kills tests prematurely | Explicit timeout config: 120s per test, 180s per hook. Circuit breaker test: explicit 300s. |
| globalSetup blocks unit tests | Setup detects e2e vs unit run; skips checks for non-e2e. |
| `__dirname` crashes in ESM | All globalSetup/helper code uses `import.meta.url` / `import.meta.dirname`. |
| Smoke test doesn't run first (alphabetical ordering) | Named `00-extension-smoke-gate.test.ts` to force alphabetical-first. |
| Per-file changes break daemon-engine / extension-health / commit-1a tests | These 3 files explicitly exempt from per-file changes (Section 8.4.1). |
| Tab ownership check is a no-op (`registerTab` never called) | Acknowledged in spec. Test the code path as-is, don't claim enforcement. Roadmap item to wire up registration. |
| Ctrl+C during config-modifying test leaves config corrupted | Documented risk. Manual recovery: `git checkout safari-pilot.config.json`. |
| `safari_evaluate` parameter `script` confused with `expression` | Spec uses correct parameter name `script` throughout. Cross-referenced with `inputSchema` at `extraction.ts:152`. |

## 11. LLM Execution Anti-Patterns (Mandatory Reading Before Implementation)

These are the specific failure modes an LLM will exhibit when executing this spec. The implementor MUST check for each one.

### 11.1 Verification Failures
- **Never claim "tests pass" without running them.** Run the command, read the output, count pass/fail.
- **Never claim "daemon rebuilt" without running `scripts/update-daemon.sh`.** Read the build output for errors.
- **After Phase 0 Swift change: rebuild daemon AND run existing test suites** before touching Phase 1.
- **After ANY source change: rebuild `dist/` via `npm run build`** before running e2e tests. E2E tests run `dist/index.js`, not source.

### 11.2 ID Management
- `McpTestClient` uses ID-based response routing. Two requests with the same ID → one response consumed, the other hangs forever.
- `initClient()` returns `{ client, nextId }`. The `nextId` starts at 2 (ID 1 was used by `initialize`).
- Every `callTool`, `rawCallTool`, `callToolExpectingEngine`, `ensureExtensionAwake` call consumes IDs. Track the counter.
- `ensureExtensionAwake` returns the updated `nextId`. Capture it: `nextId = await ensureExtensionAwake(client, url, nextId)`.

### 11.3 Async Discipline
- `ensureExtensionAwake`, `callToolExpectingEngine`, `rawCallTool` are all async. Missing `await` → test proceeds while extension still waking → subsequent calls fail → confusing timeout errors.
- `client.close()` is async. Missing `await` in afterAll → process leak.

### 11.4 Import and ESM Rules
- E2E tests MUST NOT import from `../../src/`. This is enforced by pre-commit hook `hooks/e2e-no-mocks.sh`.
- E2E tests MUST NOT use `vi.mock`, `vi.spyOn`, or `jest.mock`. Same pre-commit hook.
- `globalSetup` must use raw TCP/NDJSON to query the daemon, not `DaemonEngine` from source.
- Test helpers (`test/helpers/`) are OK to import from e2e tests.
- **ESM:** This project has `"type": "module"` in `package.json`. `__dirname` is NOT available. Use `import.meta.dirname` (all e2e test files already do this — see `mcp-client.ts:17`). In globalSetup, use `fileURLToPath(new URL('.', import.meta.url))` for directory resolution.

### 11.5 Cleanup Robustness
- `afterAll` must handle the case where `beforeAll` threw and `client` is undefined.
- Use `client?.close().catch(() => {})`, not `client.close()`.
- Tab cleanup is best-effort — wrap in try/catch.
- Config file modifications MUST be restored in a `finally` block, not just `afterAll`.

### 11.6 Gate Discipline
- Phase 0 gate: `isAvailable()` returns true + existing tests pass → THEN Phase 1
- Phase 1 gate: all 5 smoke tests pass with `engine === 'extension'` → THEN Phase 2
- Phase 3a gate: 4 core files pass → THEN Phase 3b
- Between EVERY phase: run `npm run test:unit` to verify no regression
- Do NOT combine phases into one commit — each phase is a separate verifiable step

### 11.7 URL Handling
- Safari normalizes URLs. `https://example.com` may become `https://example.com/`.
- Always use the URL returned by `safari_new_tab` response, never the URL you passed in.
- Pass the actual URL to `ensureExtensionAwake` and all subsequent tool calls.

### 11.8 Parameter Names
- `safari_evaluate`'s MCP parameter is **`script`**, NOT `expression`. The `inputSchema` at `extraction.ts:152` defines `script: { type: 'string' }`. Passing `{ expression: '...' }` results in `undefined` script and a confusing error.
- `safari_navigate` has TWO URL parameters with different meanings (see `navigation.ts:34-35`):
  - `url` (required): the destination URL to navigate TO
  - `tabUrl` (optional): which existing tab to navigate (matched by current URL)
  - Confusing these → "Missing required parameter: url" or navigating the wrong tab.
  - Example: `{ url: 'https://new-page.com', tabUrl: existingTabUrl }` — NOT `{ tabUrl: 'https://new-page.com' }`.
- Always verify parameter names against the tool's `getDefinitions()` → `inputSchema` → `properties`, not from memory.

### 11.9 File-Specific Awareness
- `daemon-engine.test.ts`, `extension-health.test.ts`, and `commit-1a-shippable.test.ts` are EXEMPT from per-file changes (Section 8.4.1). Do NOT add `ensureExtensionAwake`, `callToolExpectingEngine`, or tab creation to these files.
- `00-extension-smoke-gate.test.ts` was created in Phase 1. Do NOT recreate it in Phase 3a.
- When renaming `three-tier-fallback.test.ts` → `engine-routing.test.ts`, use `git mv` to preserve history.
- When repurposing `applescript-fallback.test.ts` → `degradation.test.ts`, modify in-place (don't delete + recreate).
- The report collector (`e2e-report.ts`) must be updated BEFORE Phase 3a core files, not after.

### 11.10 What NOT To Do
- Do NOT delete and recreate test files from scratch. Modify existing files to add engine assertions and remove conditionals. Preserve existing test patterns and edge case coverage.
- Do NOT modify production code during Phase 3 (except Phase 0 Swift fix and documentation).
- Do NOT add `vi.mock` "temporarily" or "just for this test."
- Do NOT use `process.exitCode` in globalSetup — use `throw` (for e2e runs).
- Do NOT create new vitest config files — update the existing one.
- Do NOT skip running the full test suite between phases.
- Do NOT use `__dirname` — this is an ESM project. Use `import.meta.dirname`.
- Do NOT apply per-file changes blindly to all 20 files. Check the exemption list (Section 8.4.1).
- Do NOT create `extension-unavailable.test.ts` as a separate file — it's merged into `degradation.test.ts` Scenario 3.
