# Production E2E Test Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a production code bug that makes the extension engine dead code, then rewrite all 18 e2e test files to verify the shipped three-tier engine architecture (extension → daemon → AppleScript) with engine assertions on every tool call.

**Architecture:** Each e2e test spawns a fresh MCP server (`node dist/index.js`) that connects to the system daemon via TCP:19474. The system daemon has the Safari extension connected via HTTP:19475. After Phase 0 (Swift fix), the MCP server's `ExtensionEngine.isAvailable()` returns true, and `selectEngine()` picks extension for all capable tools. Tests assert `_meta.engine === 'extension'` on every tool call to prove engine selection works. Tests run serially (`fileParallelism: false`), each file spawns its own server.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), vitest, Swift (daemon), Safari Web Extension, MCP JSON-RPC over stdio

**Spec:** `docs/upp/specs/2026-04-19-production-e2e-rewrite-design.md` (v4)

**MANDATORY:** Before implementing ANY task, read **Spec Section 11 (LLM Execution Anti-Patterns)** in full. It contains 10 subsections of specific failure modes. Key ones referenced per-task below.

---

## File Structure

### Files to CREATE
| File | Responsibility |
|------|---------------|
| `test/e2e/setup-production.ts` | vitest globalSetup — 4 precondition checks before e2e suite |
| `test/helpers/ensure-extension-awake.ts` | Functional wake probe — sends real command through extension engine |
| `test/helpers/assert-engine.ts` | `callToolExpectingEngine()` — wraps `rawCallTool` with engine assertion |
| `test/e2e/00-extension-smoke-gate.test.ts` | Phase 1 gate — 5 tests proving extension engine path works end-to-end |

### Files to MODIFY
| File | Change |
|------|--------|
| `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift:215-219` | Add `extension_health` case to `handleInternalCommand()` switch |
| `vitest.config.ts` | Add `setup-production.ts` to globalSetup, add timeout overrides |
| `test/helpers/e2e-report.ts` | Default `extensionConnected = true`, update `expectedEngineFor()`, rename `TOOLS_WITH_NO_ENGINE` |
| 15 standard e2e test files | Per-file changes: remove `skipIf(CI)`, add wake probe, replace `callTool` with `callToolExpectingEngine`, remove `extensionConnected` branches |
| 3 exempt e2e test files | Only remove `describe.skipIf(CI)` |
| `ARCHITECTURE.md` | Remove CURRENT STATE WARNING, update verified date |
| `CLAUDE.md` | Update e2e testing section, test count, Phase 0 fix |

### Files to RENAME
| From | To |
|------|-----|
| `test/e2e/three-tier-fallback.test.ts` | `test/e2e/engine-routing.test.ts` (via `git mv`) |
| `test/e2e/applescript-fallback.test.ts` | `test/e2e/degradation.test.ts` (via `git mv`) |

---

## Critical Reference: Parameter Names

These are verified against `inputSchema` in source and will be used throughout the plan:

| Tool | Key parameter | Source |
|------|--------------|--------|
| `safari_evaluate` | `script` (NOT `expression`) | `extraction.ts:152` |
| `safari_new_tab` | `url` | `navigation.ts:100-105` |
| `safari_navigate` | `url` (destination, required) + `tabUrl` (which tab, optional) | `navigation.ts:34-35` |
| `safari_get_text` | `tabUrl` | `extraction.ts:77` |
| `safari_close_tab` | `tabUrl` | `navigation.ts:128` |

---

## Critical Reference: ID Management

`McpTestClient` uses ID-based response routing. Every tool call consumes one ID. Pattern:

```typescript
const init = await initClient(SERVER_PATH);  // ID 1 used by initialize
let nextId = init.nextId;                    // nextId starts at 2

// For rawCallTool/callTool — post-increment at call site:
const { payload, meta } = await rawCallTool(client, tool, args, nextId++, timeout);

// For ensureExtensionAwake — captures returned nextId:
nextId = await ensureExtensionAwake(client, tabUrl, nextId);

// For callToolExpectingEngine — post-increment at call site (function does NOT return nextId):
const { payload, meta } = await callToolExpectingEngine(client, tool, args, 'extension', nextId++, timeout);
```

Two requests with the same ID → one response consumed, the other hangs forever.

---

### Task 1: Phase 0 — Fix `extension_health` sentinel routing in daemon

**Anti-patterns:** Spec 11.1 (verify daemon rebuilt — don't claim "done" without running `update-daemon.sh`), 11.6 (gate discipline — don't skip to Phase 1 without verification)

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift:215-219`

- [ ] **Step 1: Read the current handleInternalCommand switch**

Read `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` lines 202-230. Verify the switch at line 215 only has `extension_status` and `extension_execute` cases.

- [ ] **Step 2: Add extension_health case**

In `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift`, add a new case to the switch at line 215, between `extension_execute` and `default`:

```swift
        case "extension_health":
            let snapshot = extensionBridge.healthSnapshot(store: healthStore)
            return Response.success(id: commandID, value: AnyCodable(snapshot))
```

This is identical to the direct handler at line 173 — same method call, same response shape.

- [ ] **Step 3: Rebuild daemon**

Run: `bash scripts/update-daemon.sh`

Expected: Build succeeds, daemon binary replaced atomically, launchctl restarts the service. Wait 2 seconds for the daemon to start accepting connections.

- [ ] **Step 4: Verify the fix via NDJSON**

Run:
```bash
sleep 2 && echo '{"id":"t","method":"execute","params":{"script":"__SAFARI_PILOT_INTERNAL__ extension_health"}}' | nc -w 3 localhost 19474
```

Expected: `{"ok":true,"value":{"ipcMechanism":"http","isConnected":true,...}}`

If `value` is missing `ipcMechanism` or the response has `ok: false`, the sentinel route is still broken.

- [ ] **Step 5: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/CommandDispatcher.swift
git commit -m "fix(daemon): route extension_health sentinel through handleInternalCommand

The sentinel protocol (__SAFARI_PILOT_INTERNAL__ extension_health) was not
routed, causing ExtensionEngine.isAvailable() to always return false.
The extension engine was dead code in the MCP server."
```

---

### Task 2: Phase 0 Gate — Verify fix and run existing test suites

**Files:** None (verification only)

- [ ] **Step 1: Verify isAvailable() returns true**

Run: `npm run build`

Then verify MCP server registers extension engine:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"verify","version":"1.0"}}}' | gtimeout 10 node dist/index.js 2>&1 | head -5
```

Look for `extension: true` or `extensionAvailable: true` in stderr output (server logs).

- [ ] **Step 2: Run unit tests**

Run: `npm run test:unit`

Expected: 1428 tests pass, 0 fail. Any failure means the Swift change broke something — investigate before proceeding.

- [ ] **Step 3: Run daemon tests**

Run: `npx vitest run test/unit/daemon-lifecycle.test.ts test/e2e/daemon-engine.test.ts`

Expected: All daemon tests pass.

- [ ] **Step 4: Gate check**

All three conditions met:
1. `isAvailable()` returns true ✓
2. Unit tests pass ✓
3. Daemon tests pass ✓

**Phase 0 complete. Phase 1 may begin.**

---

### Task 3: Phase 1 — Create extension engine smoke test gate

**Anti-patterns:** Spec 11.2 (ID management — `nextId` starts at 2 from `initClient`), 11.7 (URL handling — use returned URL, not input URL), 11.8 (parameter name is `script`, NOT `expression`)

**Files:**
- Create: `test/e2e/00-extension-smoke-gate.test.ts`

- [ ] **Step 1: Create the smoke test file**

```typescript
/**
 * Extension Engine Smoke Test — GATE
 *
 * This file MUST run before all other e2e tests (00- prefix forces alphabetical-first).
 * It proves the extension engine path works end-to-end: MCP → server → engine selector
 * → extension engine → daemon → extension background.js → content script → result.
 *
 * If ANY test fails here, the extension engine is broken. Do not proceed to Phase 2.
 *
 * Zero mocks. Zero source imports. Real process over stdio.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe('Extension Engine Smoke Gate', () => {
  let client: McpTestClient;
  let nextId: number;
  let tab1Url: string | undefined;
  let tab2Url: string | undefined;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
  }, 30_000);

  afterAll(async () => {
    try {
      if (tab1Url && client) {
        await rawCallTool(client, 'safari_close_tab', { tabUrl: tab1Url }, nextId++, 10_000)
          .catch(() => {});
      }
      if (tab2Url && client) {
        await rawCallTool(client, 'safari_close_tab', { tabUrl: tab2Url }, nextId++, 10_000)
          .catch(() => {});
      }
    } finally {
      await client?.close().catch(() => {});
    }
  });

  it('Test 1 — extension health reports ipcMechanism http', async () => {
    const result = await callTool(
      client,
      'safari_extension_health',
      {},
      nextId++,
      20_000,
    );

    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    expect(parsed['ipcMechanism']).toBe('http');
    expect(parsed['isConnected']).toBe(true);
  }, 90_000);

  it('Test 2 — simple JS execution through extension engine', async () => {
    // Create tab and capture ACTUAL URL (Safari may normalize)
    const tabResult = await callTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      20_000,
    );
    tab1Url = tabResult['tabUrl'] as string;
    expect(tab1Url).toBeDefined();

    // Wait for page load
    await new Promise(r => setTimeout(r, 3000));

    // Execute JS through extension engine
    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { script: 'return document.title', tabUrl: tab1Url },
      nextId++,
      90_000,
    );

    expect(meta?.['engine']).toBe('extension');
    expect(payload['value']).toContain('Example Domain');
  }, 90_000);

  it('Test 3 — complex result marshaling through extension', async () => {
    expect(tab1Url).toBeDefined();

    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { script: 'return JSON.stringify({a: 1, b: "hello", c: [1,2,3]})', tabUrl: tab1Url },
      nextId++,
      90_000,
    );

    expect(meta?.['engine']).toBe('extension');

    // The value is the result of the script — a JSON string
    const value = payload['value'] as string;
    expect(value).toBeDefined();
    const parsed = JSON.parse(value);
    expect(parsed).toEqual({ a: 1, b: 'hello', c: [1, 2, 3] });
  }, 90_000);

  it('Test 4 — URL with query params (findTargetTab stress test)', async () => {
    const tabResult = await callTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com/?e2e=smoke&ts=12345' },
      nextId++,
      20_000,
    );
    tab2Url = tabResult['tabUrl'] as string;
    expect(tab2Url).toBeDefined();

    await new Promise(r => setTimeout(r, 3000));

    // Use the ACTUAL returned URL, not the input URL
    const { payload, meta } = await rawCallTool(
      client,
      'safari_evaluate',
      { script: 'return document.title', tabUrl: tab2Url },
      nextId++,
      90_000,
    );

    expect(meta?.['engine']).toBe('extension');
    expect(payload['value']).toBeDefined();
  }, 90_000);

  it('Test 5 — sequential commands (no deadlock)', async () => {
    expect(tab1Url).toBeDefined();

    const { payload: p1, meta: m1 } = await rawCallTool(
      client,
      'safari_evaluate',
      { script: 'return 1 + 1', tabUrl: tab1Url },
      nextId++,
      90_000,
    );
    expect(m1?.['engine']).toBe('extension');
    expect(p1['value']).toBe(2);

    const { payload: p2, meta: m2 } = await rawCallTool(
      client,
      'safari_evaluate',
      { script: 'return "hello" + " world"', tabUrl: tab1Url },
      nextId++,
      90_000,
    );
    expect(m2?.['engine']).toBe('extension');
    expect(p2['value']).toBe('hello world');
  }, 90_000);
});
```

- [ ] **Step 2: Run the smoke test**

Run: `npx vitest run test/e2e/00-extension-smoke-gate.test.ts`

Expected: All 5 tests pass with `_meta.engine === 'extension'`.

- [ ] **Step 3: If any test fails, debug per Section 6.2 of the spec**

Failure priority:
1. `engine === 'daemon'` → Phase 0 fix didn't work (check daemon rebuild, check `isAvailable()` response)
2. Timeout (90s) → Extension not polling (check health-check.sh, HTTP:19475)
3. `No target tab` → URL mismatch (compare `tab1Url` with what `browser.tabs.query` returns)
4. Wrong result shape → JSON marshaling broken through extension chain

Budget 2-3 fixes beyond Phase 0.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/00-extension-smoke-gate.test.ts
git commit -m "test(e2e): add extension engine smoke test gate

5 tests proving the extension engine path works end-to-end:
health check, JS execution, result marshaling, URL matching, sequential commands.
All assert _meta.engine === 'extension'."
```

**Phase 1 complete. Phase 2 may begin.**

---

### Task 4: Phase 2 — Create globalSetup for e2e preconditions

**Anti-patterns:** Spec 11.4 (ESM — use `import.meta.url`, NOT `__dirname`), 11.4 (must NOT import from `src/` — use raw TCP)

**Files:**
- Create: `test/e2e/setup-production.ts`

- [ ] **Step 1: Create the globalSetup file**

Write the full file as specified in spec Section 7.1. The file must:
- Use `import.meta.url` for path resolution (ESM project — `__dirname` is NOT available)
- Detect e2e vs unit runs and skip checks for non-e2e runs
- Use raw TCP to query daemon health (NOT import from `src/`)
- Kill spawned processes in ALL cases
- Export both `setup()` and `teardown()`

```typescript
/**
 * E2E Production Stack Precondition Checks
 *
 * Verifies the system daemon, Safari extension, Safari browser, and MCP server
 * are all running before e2e tests execute. Skips checks for unit/integration runs.
 *
 * Uses raw TCP/NDJSON — does NOT import from src/ (e2e rule).
 */
import { createConnection } from 'node:net';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = fileURLToPath(new URL('.', import.meta.url));

export async function setup() {
  const testFilter = process.env['VITEST_INCLUDE'] ?? process.argv.join(' ');
  const isE2eRun = testFilter.includes('test/e2e') || testFilter.includes('test:e2e')
    || (!testFilter.includes('test/unit') && !testFilter.includes('test:unit')
       && !testFilter.includes('test/integration'));

  const daemonUp = await checkTcp(19474);
  if (!daemonUp) {
    if (!isE2eRun) { console.log('E2E setup: daemon not running (skipped — not an e2e run)'); return; }
    throw new Error(
      'E2E PRECONDITION FAILED: System daemon not running on TCP:19474.\n' +
      'Start it: launchctl load ~/Library/LaunchAgents/com.safari-pilot.daemon.plist'
    );
  }

  const health = await queryExtensionHealth();
  if (health?.ipcMechanism !== 'http') {
    if (!isE2eRun) { console.log('E2E setup: extension not connected (skipped — not an e2e run)'); return; }
    throw new Error(
      'E2E PRECONDITION FAILED: Extension not connected (ipcMechanism: ' + health?.ipcMechanism + ').\n' +
      'Open "bin/Safari Pilot.app" and enable the extension in Safari > Settings > Extensions'
    );
  }

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

function checkTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(3000, () => { sock.destroy(); resolve(false); });
  });
}

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
      sock.on('data', (chunk: Buffer) => {
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

function checkMcpServerSpawns(): Promise<boolean> {
  return new Promise((resolve) => {
    const serverPath = join(__dir, '../../dist/index.js');
    const proc: ChildProcess = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    proc.on('close', () => { clearTimeout(timer); });
  });
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `npx tsc --noEmit test/e2e/setup-production.ts` (or rely on vitest's built-in transform).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/setup-production.ts
git commit -m "test(e2e): add production stack globalSetup with e2e/unit detection

4 precondition checks: daemon TCP:19474, extension ipcMechanism=http,
Safari open, MCP server spawnable. Skips checks for non-e2e runs."
```

---

### Task 5: Phase 2 — Create extension wake probe and engine assertion helper

**Anti-patterns:** Spec 11.2 (ensureExtensionAwake RETURNS nextId — caller MUST capture it), 11.3 (all helpers are async — missing `await` causes test hangs)

**Files:**
- Create: `test/helpers/ensure-extension-awake.ts`
- Create: `test/helpers/assert-engine.ts`

- [ ] **Step 1: Create the wake probe helper**

```typescript
/**
 * Functional extension wake probe.
 *
 * Sends a REAL command through the extension engine and waits for a response.
 * If the extension event page is dead, this waits up to 90s for the alarm cycle
 * (1-minute period) to wake it. Returns the updated nextId counter.
 *
 * Unlike the old wakeExtension(), this checks live presence, not historical state.
 */
import { type McpTestClient, rawCallTool } from './mcp-client.js';

export async function ensureExtensionAwake(
  client: McpTestClient,
  tabUrl: string,
  nextId: number,
): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { meta } = await rawCallTool(
        client,
        'safari_evaluate',
        { script: 'return 1', tabUrl },
        nextId++,
        attempt === 0 ? 90_000 : 30_000,
      );
      if (meta?.engine === 'extension') {
        return nextId;
      }
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

- [ ] **Step 2: Create the engine assertion helper**

```typescript
/**
 * Engine assertion helper for e2e tests.
 *
 * Wraps rawCallTool with an assertion that _meta.engine matches the expected engine.
 * Falls back to the __engine backup field embedded in result content (server.ts:622).
 */
import { type McpTestClient, rawCallTool } from './mcp-client.js';

export async function callToolExpectingEngine(
  client: McpTestClient,
  tool: string,
  args: Record<string, unknown>,
  expectedEngine: 'extension' | 'daemon' | 'applescript',
  nextId: number,
  timeout = 60_000,
): Promise<{ payload: Record<string, unknown>; meta: Record<string, unknown> }> {
  const { payload, meta, result } = await rawCallTool(client, tool, args, nextId, timeout);

  if (!meta?.engine) {
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

- [ ] **Step 3: Commit**

```bash
git add test/helpers/ensure-extension-awake.ts test/helpers/assert-engine.ts
git commit -m "test(helpers): add extension wake probe and engine assertion helper

ensureExtensionAwake: functional probe with 90s/30s timeouts for alarm cycle.
callToolExpectingEngine: wraps rawCallTool with _meta.engine assertion + __engine fallback."
```

---

### Task 6: Phase 2 — Update vitest config

**Files:**
- Modify: `vitest.config.ts`

- [ ] **Step 1: Add globalSetup and timeout overrides**

In `vitest.config.ts`, make these changes:

Change line 13 from:
```typescript
    globalSetup: ['./test/setup-retention.ts'],
```
to:
```typescript
    globalSetup: ['./test/setup-retention.ts', './test/e2e/setup-production.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
```

- [ ] **Step 2: Verify unit tests still pass**

Run: `npm run test:unit`

Expected: All 1428 tests pass. The globalSetup detects non-e2e runs and skips. Timeouts are ceilings — unit tests still finish in milliseconds.

- [ ] **Step 3: Verify e2e smoke test still passes with new config**

Run: `npx vitest run test/e2e/00-extension-smoke-gate.test.ts`

Expected: All 5 smoke tests pass. The globalSetup runs precondition checks and passes.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts
git commit -m "config: add e2e globalSetup and timeout overrides

globalSetup: setup-production.ts checks daemon, extension, Safari, MCP server.
testTimeout: 120s, hookTimeout: 180s — accommodates extension wake cycle."
```

**Phase 2 complete. Phase 3a may begin.**

---

### Task 7: Phase 3a — Update report collector

**Files:**
- Modify: `test/helpers/e2e-report.ts`

This MUST be done BEFORE rewriting Phase 3a core test files. The core files depend on `extensionConnected = true` being the default.

- [ ] **Step 1: Update the report collector**

In `test/helpers/e2e-report.ts`, make these changes:

1. Rename `TOOLS_WITH_NO_ENGINE` to `SELECTOR_ONLY_TOOLS` (line 49) and update the set to contain all tools that execute via hardcoded engines but still receive engine metadata from the selector:

Replace lines 49-55:
```typescript
const TOOLS_WITH_NO_ENGINE = new Set([
  'safari_health_check',
  'safari_emergency_stop',
  'safari_list_tabs',
  'safari_new_tab',
  'safari_close_tab',
]);
```

With:
```typescript
const SELECTOR_ONLY_TOOLS = new Set([
  'safari_health_check',
  'safari_emergency_stop',
  'safari_list_tabs',
  'safari_new_tab',
  'safari_close_tab',
  'safari_navigate',
  'safari_navigate_back',
  'safari_navigate_forward',
  'safari_reload',
  'safari_export_pdf',
  'safari_wait_for_download',
]);
```

2. Update `expectedEngineFor()` (lines 57-70) — all tools expect `extension` when connected:

Replace lines 57-70:
```typescript
function expectedEngineFor(
  tool: string,
  extensionConnected: boolean,
): string {
  if (TOOLS_WITH_NO_ENGINE.has(tool)) return 'any';
  if (EXTENSION_REQUIRED_TOOLS.has(tool)) {
    return extensionConnected ? 'extension' : 'rejected';
  }
  if (EXTENSION_PREFERRED_TOOLS.has(tool)) {
    return extensionConnected ? 'extension' : 'daemon';
  }
  if (extensionConnected) return 'extension';
  return 'daemon';
}
```

With:
```typescript
function expectedEngineFor(
  tool: string,
  extensionConnected: boolean,
): string {
  if (!extensionConnected) {
    if (EXTENSION_REQUIRED_TOOLS.has(tool)) return 'rejected';
    return 'daemon';
  }
  return 'extension';
}
```

3. Change the default `extensionConnected` from `false` to `true` (line 114):

Replace:
```typescript
  private extensionConnected = false;
```
With:
```typescript
  private extensionConnected = true;
```

- [ ] **Step 2: Verify existing tests still compile**

Run: `npx tsc --noEmit`

Expected: No type errors. The `setExtensionConnected` method is retained for `degradation.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add test/helpers/e2e-report.ts
git commit -m "test(helpers): update report collector for extension-always-connected

Default extensionConnected=true, expectedEngineFor returns 'extension' for all tools.
SELECTOR_ONLY_TOOLS tracks tools with selector metadata but hardcoded execution engines.
setExtensionConnected() retained for degradation test scenarios."
```

---

### Task 8: Phase 3a — Rewrite engine-selection.test.ts

> **DEPENDENCY GATE:** Task 7 (report collector update) MUST be complete before this task starts. The rewritten test files call `report.setExtensionConnected(true)` and depend on the collector defaulting to `extensionConnected = true`. If Task 7 is incomplete, all tests will show false compliance violations.

**Anti-patterns:** Spec 11.9 (do NOT recreate files from scratch — modify in-place), 11.5 (robust afterAll with try/finally), 11.7 (use returned tab URL, not input URL), 11.10 (do NOT modify production code)

**Files:**
- Modify: `test/e2e/engine-selection.test.ts`

This is the reference implementation for per-file changes. All subsequent file rewrites follow this pattern.

- [ ] **Step 1: Read the existing file**

Read `test/e2e/engine-selection.test.ts` to understand current structure (240 lines).

- [ ] **Step 2: Apply per-file changes**

Make these changes to `test/e2e/engine-selection.test.ts`:

1. **Add imports** for new helpers (after existing imports, line 20):
```typescript
import { ensureExtensionAwake } from '../helpers/ensure-extension-awake.js';
import { callToolExpectingEngine } from '../helpers/assert-engine.js';
```

2. **Remove `describe.skipIf`** (line 24):
Change `describe.skipIf(process.env.CI === 'true')('Engine Selection', () => {` to `describe('Engine Selection', () => {`

3. **Remove `extensionConnected` and `daemonAvailable` variables** (lines 28-29):
Delete:
```typescript
  let extensionConnected: boolean;
  let daemonAvailable: boolean;
```

4. **Update `beforeAll`** (lines 32-50): Remove the health check probe and engine availability detection. Add tab URL capture and wake probe:
```typescript
  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;

    report.setExtensionConnected(true);

    const newTabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=engine-selection' }, nextId++, 20_000);
    agentTabUrl = newTabResult['tabUrl'] as string | undefined;

    await new Promise((r) => setTimeout(r, 3000));

    nextId = await ensureExtensionAwake(client, agentTabUrl!, nextId);
  }, 180_000);
```

5. **Remove all `if (extensionConnected)` and `if (daemonAvailable)` branches** throughout the file. Replace conditional assertions with unconditional `expect(meta!['engine']).toBe('extension')`.

For example, in the `requiresShadowDom` test (lines 104-117), remove the `if/else` and keep only:
```typescript
    expect(meta!['engine']).toBe('extension');
```

In the `best available engine` test (lines 139-148), remove the `if/else if` and keep only:
```typescript
    expect(meta!['engine']).toBe('extension');
    expect(meta!['engine']).not.toBe('applescript');
```

6. **Replace `rawCallTool` with `callToolExpectingEngine`** where the test primarily checks engine routing. Keep `rawCallTool` where the test needs raw payload for other assertions.

Concrete example — the "best available engine" test (currently lines 122-148) becomes:
```typescript
  it('tool with no special requirements uses extension engine', async () => {
    const tabUrl = agentTabUrl!;

    const { payload } = await callToolExpectingEngine(
      client,
      'safari_get_text',
      { tabUrl },
      'extension',  // ← asserts _meta.engine === 'extension' (throws if not)
      nextId++,
      60_000,
    );

    // Also verify the result (proves the tool actually executed)
    expect(payload['text']).toBeDefined();
    expect((payload['text'] as string)).toContain('Example Domain');
  }, 120_000);
```

And the "consistent engine" test (currently lines 197-215) becomes:
```typescript
  it('same tool selects extension engine consistently', async () => {
    const tabUrl = agentTabUrl!;

    for (let i = 0; i < 3; i++) {
      const { meta } = await callToolExpectingEngine(
        client,
        'safari_get_text',
        { tabUrl },
        'extension',
        nextId++,
        60_000,
      );
      report.recordCall('safari_get_text', { tabUrl }, meta, true);
    }
  }, 120_000);
```

7. **Remove the structural proof tests at the end** (lines 219-238) — these read source files and aren't e2e tests. They belong in unit tests.

- [ ] **Step 3: Run the rewritten test**

Run: `npx vitest run test/e2e/engine-selection.test.ts`

Expected: All tests pass with `engine === 'extension'`.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/engine-selection.test.ts
git commit -m "test(e2e): rewrite engine-selection for extension-always-connected

Remove skipIf(CI), extensionConnected branches, engine availability probing.
Add ensureExtensionAwake, assert engine=extension unconditionally.
Remove structural proof tests (belong in unit tests)."
```

---

### Task 9: Phase 3a — Rewrite extension-engine.test.ts

**Files:**
- Modify: `test/e2e/extension-engine.test.ts`

- [ ] **Step 1: Read the existing file**

Read `test/e2e/extension-engine.test.ts` (355 lines). Note the `if (extensionConnected)` branches at lines 107-110, 183-191, 212-220, 307-310, 347-352.

- [ ] **Step 2: Apply per-file changes**

Apply changes per Spec Section 8.4:
1. Add imports: `import { ensureExtensionAwake } from '../helpers/ensure-extension-awake.js';` and `import { callToolExpectingEngine } from '../helpers/assert-engine.js';`
2. Remove `describe.skipIf(process.env.CI === 'true')`
3. Remove `extensionConnected` and `daemonAvailable` variables and health check probe
4. Replace `beforeAll` body with:
```typescript
  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=extension-engine' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);
```
5. Remove ALL `if (extensionConnected)` branches — keep only the extension-connected path
6. Replace conditional `expect` with unconditional `expect(meta!['engine']).toBe('extension')`
7. For Shadow DOM tests: KEEP the result content assertion (proves physical execution, not just selector)
8. Robust `afterAll` with try/finally (see Spec Section 8.4 item 8 for template)

- [ ] **Step 3: Run the rewritten test**

Run: `npx vitest run test/e2e/extension-engine.test.ts`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/extension-engine.test.ts
git commit -m "test(e2e): rewrite extension-engine for extension-always-connected

Remove all extensionConnected branches. Assert engine=extension unconditionally.
Shadow DOM tests verify result content (physical execution proof)."
```

---

### Task 10: Phase 3a — Rewrite security-pipeline.test.ts

**Files:**
- Modify: `test/e2e/security-pipeline.test.ts`

- [ ] **Step 1: Read the existing file**

Read `test/e2e/security-pipeline.test.ts` (416 lines). Note `if (extensionConnected)` at lines 280-286.

- [ ] **Step 2: Apply per-file changes**

Apply changes per Spec Section 8.4 checklist:

1. Add imports: `import { ensureExtensionAwake } from '../helpers/ensure-extension-awake.js';` and `import { callToolExpectingEngine } from '../helpers/assert-engine.js';`
2. Remove `describe.skipIf(process.env.CI === 'true')` — change to plain `describe`
3. Remove `extensionConnected`/`daemonAvailable` variables and health check probing
4. Replace `beforeAll` body with:
```typescript
  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=security-pipeline' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);
```
5. Remove all `if (extensionConnected)` branches — keep extension-connected path only
6. Replace `rawCallTool` calls that check engine with `callToolExpectingEngine(..., 'extension', nextId++, 60_000)`
7. Robust `afterAll` with try/finally (see Spec Section 8.4 item 8 for template)

**Security-specific:** Tab ownership test: verify the check doesn't throw for agent-created tabs, but do NOT claim "tab ownership is enforced" (see Spec Section 8.1 — `registerTab()` is never called in production code)

- [ ] **Step 3: Run the rewritten test**

Run: `npx vitest run test/e2e/security-pipeline.test.ts`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/security-pipeline.test.ts
git commit -m "test(e2e): rewrite security-pipeline for extension-always-connected

8 functional security layers verified with extension engine routing.
Tab ownership check tested as-is (passes silently — roadmap item to wire up registration)."
```

---

### Task 11: Phase 3a Gate — Verify all core files pass

**Files:** None (verification only)

- [ ] **Step 1: Run all Phase 3a test files together**

Run: `npx vitest run test/e2e/00-extension-smoke-gate.test.ts test/e2e/engine-selection.test.ts test/e2e/extension-engine.test.ts test/e2e/security-pipeline.test.ts`

Expected: All tests pass.

- [ ] **Step 2: Run unit tests to verify no regression**

Run: `npm run test:unit`

Expected: 1428 tests pass.

- [ ] **Step 3: Verify no banned patterns**

Run:
```bash
grep -rn 'describe\.skipIf' test/e2e/00-extension-smoke-gate.test.ts test/e2e/engine-selection.test.ts test/e2e/extension-engine.test.ts test/e2e/security-pipeline.test.ts
grep -rn "from '../../src/" test/e2e/00-extension-smoke-gate.test.ts test/e2e/engine-selection.test.ts test/e2e/extension-engine.test.ts test/e2e/security-pipeline.test.ts
grep -rn '__dirname' test/e2e/00-extension-smoke-gate.test.ts test/e2e/engine-selection.test.ts test/e2e/extension-engine.test.ts test/e2e/security-pipeline.test.ts
```

Expected: All three greps return zero results.

**Phase 3a complete. Phase 3b may begin.**

---

### Task 12: Phase 3b — Rename files and remove skipIf from exempt files

**Anti-patterns:** Spec 11.9 (use `git mv` for renames — preserve history; exempt files get ONLY skipIf removed, nothing else)

**Files:**
- Rename: `test/e2e/three-tier-fallback.test.ts` → `test/e2e/engine-routing.test.ts`
- Rename: `test/e2e/applescript-fallback.test.ts` → `test/e2e/degradation.test.ts`
- Modify: `test/e2e/daemon-engine.test.ts` (exempt — only remove skipIf)
- Modify: `test/e2e/extension-health.test.ts` (exempt — only remove skipIf)
- Modify: `test/e2e/commit-1a-shippable.test.ts` (exempt — only remove skipIf)

- [ ] **Step 1: Rename files using git mv**

```bash
git mv test/e2e/three-tier-fallback.test.ts test/e2e/engine-routing.test.ts
git mv test/e2e/applescript-fallback.test.ts test/e2e/degradation.test.ts
```

- [ ] **Step 2: Remove describe.skipIf from 3 exempt files**

In each file, find and remove `describe.skipIf(process.env.CI === 'true')` — replace with just `describe`. Do NOT make any other changes to these files.

- `test/e2e/daemon-engine.test.ts`: Remove `.skipIf(process.env.CI === 'true')` from the describe call
- `test/e2e/extension-health.test.ts`: Same
- `test/e2e/commit-1a-shippable.test.ts`: Same

- [ ] **Step 3: Commit**

```bash
git add test/e2e/engine-routing.test.ts test/e2e/degradation.test.ts test/e2e/daemon-engine.test.ts test/e2e/extension-health.test.ts test/e2e/commit-1a-shippable.test.ts
git commit -m "test(e2e): rename fallback files, remove skipIf from exempt files

three-tier-fallback → engine-routing (git mv, preserves history).
applescript-fallback → degradation (git mv, will be rewritten next).
3 exempt files: only describe.skipIf removed, structure unchanged."
```

---

### Task 13: Phase 3b — Rewrite standard MCP test files (batch 1: extraction, interaction, navigation)

**Files:**
- Modify: `test/e2e/extraction-tools.test.ts`
- Modify: `test/e2e/interaction-tools.test.ts`
- Modify: `test/e2e/navigation-tools.test.ts`

Apply changes per Spec Section 8.4 checklist to each file. Each step below includes the explicit `beforeAll` template:

- [ ] **Step 1: Rewrite extraction-tools.test.ts**

Read the existing file. Apply these changes (see Task 8 for the reference implementation and Spec Section 8.4 for the full per-file checklist):

1. Add imports: `import { ensureExtensionAwake } from '../helpers/ensure-extension-awake.js';` and `import { callToolExpectingEngine } from '../helpers/assert-engine.js';`
2. Remove `describe.skipIf(process.env.CI === 'true')` — change to plain `describe`
3. Remove `extensionConnected`/`daemonAvailable` variables and health check probing
4. Replace `beforeAll` body with:
```typescript
  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=extraction' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);
```
5. Remove all `if (extensionConnected)` branches — keep extension-connected path only
6. Replace `rawCallTool` calls that check engine with `callToolExpectingEngine(..., 'extension', nextId++, 60_000)`
7. Robust `afterAll` with try/finally (see Task 8 Step 2 item 4 for template)

- [ ] **Step 2: Rewrite interaction-tools.test.ts**

Read the existing file. Apply the same changes as Step 1, with these specifics:

1-3. Same imports, remove skipIf, remove extensionConnected
4. Replace `beforeAll` body with (same template, different URL):
```typescript
  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=interaction' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);
```
5-7. Same branch removal, engine assertions, robust afterAll

- [ ] **Step 3: Rewrite navigation-tools.test.ts**

Read the existing file. Apply the same changes, with these specifics:

1-3. Same imports, remove skipIf, remove extensionConnected
4. Replace `beforeAll` body with:
```typescript
  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=navigation' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);
```
5-7. Same branch removal, engine assertions, robust afterAll

**Navigation-specific:** Navigation tools are direct-engine (NavigationTools receives AppleScriptEngine). Assert `_meta.engine === 'extension'` (selector proof) but ALSO verify the observable result (page loaded, URL changed). For `safari_navigate`, remember: `url` is the destination (required), `tabUrl` is which tab (optional) — see Spec Section 11.8.

- [ ] **Step 4: Run all three files**

Run: `npx vitest run test/e2e/extraction-tools.test.ts test/e2e/interaction-tools.test.ts test/e2e/navigation-tools.test.ts`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/extraction-tools.test.ts test/e2e/interaction-tools.test.ts test/e2e/navigation-tools.test.ts
git commit -m "test(e2e): rewrite extraction, interaction, navigation for extension engine

All three files: remove skipIf, extensionConnected branches. Add wake probe,
assert engine=extension. Navigation tests verify observable results (selector-only proof)."
```

---

### Task 14: Phase 3b — Rewrite standard MCP test files (batch 2: shadow-dom, accessibility, extension-lifecycle, mcp-handshake)

**Files:**
- Modify: `test/e2e/shadow-dom.test.ts`
- Modify: `test/e2e/accessibility.test.ts`
- Modify: `test/e2e/extension-lifecycle.test.ts`
- Modify: `test/e2e/mcp-handshake.test.ts`

- [ ] **Step 1: Rewrite shadow-dom.test.ts**

Read the existing file. Apply changes per Spec Section 8.4:
1. Add imports for `ensureExtensionAwake` and `callToolExpectingEngine`
2. Remove `describe.skipIf(process.env.CI === 'true')`
3. Remove `extensionConnected`/`daemonAvailable` variables and health check probing
4. Replace `beforeAll` body with:
```typescript
  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=shadow-dom' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);
```
5. Remove all `if (extensionConnected)` branches
6. Replace tool calls with `callToolExpectingEngine(..., 'extension', nextId++, 60_000)`
7. Robust `afterAll` with try/finally

**Shadow DOM-specific:** KEEP result content assertions that verify content only the extension can produce (proves physical execution, not just selector routing).

- [ ] **Step 2: Rewrite accessibility.test.ts**

Read the existing file. Apply changes per Spec Section 8.4:
1-3. Same imports, remove skipIf, remove extensionConnected
4. Replace `beforeAll` body with:
```typescript
  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=accessibility' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);
```
5-7. Same branch removal, engine assertions, robust afterAll

- [ ] **Step 3: Rewrite extension-lifecycle.test.ts**

Read the existing file. Apply changes per Spec Section 8.4:
1-3. Same imports, remove skipIf, remove extensionConnected
4. Replace `beforeAll` body with:
```typescript
  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=extension-lifecycle' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);
```
5-7. Same branch removal, engine assertions, robust afterAll

- [ ] **Step 4: Rewrite mcp-handshake.test.ts**

This file tests MCP protocol, not engine routing. Per-file changes apply partially:
1. Add imports for `ensureExtensionAwake` (only needed if the file makes tool calls beyond health check)
2. Remove `describe.skipIf(process.env.CI === 'true')`
3. If the file probes `extensionConnected`, remove the probing — just call `report.setExtensionConnected(true)`
4. Tool listing assertions (verify 78+ tools, all prefixed `safari_`) don't need engine checks — they verify protocol
5. Health check assertions keep their current structure
6. Robust `afterAll` with try/finally

- [ ] **Step 5: Run all four files**

Run: `npx vitest run test/e2e/shadow-dom.test.ts test/e2e/accessibility.test.ts test/e2e/extension-lifecycle.test.ts test/e2e/mcp-handshake.test.ts`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/shadow-dom.test.ts test/e2e/accessibility.test.ts test/e2e/extension-lifecycle.test.ts test/e2e/mcp-handshake.test.ts
git commit -m "test(e2e): rewrite shadow-dom, accessibility, extension-lifecycle, mcp-handshake

Shadow DOM tests verify extension-only content (physical execution proof).
MCP handshake tests verify protocol correctness with extension routing."
```

---

### Task 15: Phase 3b — Rewrite standard MCP test files (batch 3: remaining files)

**Files:**
- Modify: `test/e2e/http-roundtrip.test.ts`
- Modify: `test/e2e/engine-routing.test.ts` (was three-tier-fallback)
- Modify: `test/e2e/pdf-generation.test.ts`
- Modify: `test/e2e/downloads.test.ts`

- [ ] **Step 1: Rewrite http-roundtrip.test.ts**

Read the existing file. Apply changes per Spec Section 8.4:
1. Add imports for `ensureExtensionAwake` and `callToolExpectingEngine`
2. Remove `describe.skipIf(process.env.CI === 'true')`
3. Remove `extensionConnected` variable and health check probing
4. Replace `beforeAll` body with:
```typescript
  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=http-roundtrip' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);
```
5. Remove ALL `if (extensionConnected)` conditional paths — extension IS connected
6. Replace tool calls with `callToolExpectingEngine(..., 'extension', nextId++, 60_000)`
7. Robust `afterAll` with try/finally

- [ ] **Step 2: Rewrite engine-routing.test.ts**

Read the existing file (was `three-tier-fallback.test.ts`, renamed in Task 12). Apply changes per Spec Section 8.4:
1-3. Same imports, remove skipIf, remove extensionConnected
4. Replace `beforeAll` body with:
```typescript
  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=engine-routing' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);
```
5. Update describe block name from `'Three-Tier Fallback'` to `'Engine Routing'`
6-7. Same engine assertions, robust afterAll

- [ ] **Step 3: Rewrite pdf-generation.test.ts**

Read the existing file. Apply changes per Spec Section 8.4:
1-3. Same imports, remove skipIf, remove extensionConnected
4. Replace `beforeAll` body with:
```typescript
  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=pdf-generation' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);
```
5-7. Same branch removal, engine assertions, robust afterAll

**PDF-specific:** PDF is direct-engine (PdfTools uses daemon internally). Assert `_meta.engine === 'extension'` (selector proof), ALSO verify the PDF output file exists.

- [ ] **Step 4: Rewrite downloads.test.ts**

Read the existing file. Apply changes per Spec Section 8.4:
1-3. Same imports, remove skipIf, remove extensionConnected
4. Replace `beforeAll` body with:
```typescript
  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=downloads' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);
```
5-7. Same branch removal, engine assertions, robust afterAll

**Downloads-specific:** DownloadTools uses daemon internally. Selector proof + verify actual download behavior.

- [ ] **Step 5: Run all four files**

Run: `npx vitest run test/e2e/http-roundtrip.test.ts test/e2e/engine-routing.test.ts test/e2e/pdf-generation.test.ts test/e2e/downloads.test.ts`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/http-roundtrip.test.ts test/e2e/engine-routing.test.ts test/e2e/pdf-generation.test.ts test/e2e/downloads.test.ts
git commit -m "test(e2e): rewrite http-roundtrip, engine-routing, pdf-generation, downloads

All files: remove skipIf, extensionConnected branches. Add wake probe.
PDF and downloads verify observable results (selector-only engine proof)."
```

---

### Task 16: Phase 3b — Rewrite degradation.test.ts with 4 scenarios

**Anti-patterns:** Spec 11.5 (config MUST be restored in `finally` block), 11.4 (use `import.meta.dirname` for config path), 11.8 (parameter is `script`, not `expression`), 11.9 (modify in-place, don't delete+recreate)

**Files:**
- Modify: `test/e2e/degradation.test.ts` (was applescript-fallback.test.ts, renamed in Task 12)

- [ ] **Step 1: Read the existing file**

Read `test/e2e/degradation.test.ts` to understand current structure.

- [ ] **Step 2: Rewrite with 4 degradation scenarios**

Replace the file content with this structural scaffold. Fill in each scenario's test body per Spec Section 8.3:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';
import { E2EReportCollector } from '../helpers/e2e-report.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');
const CONFIG_PATH = join(import.meta.dirname, '../../safari-pilot.config.json');

describe('Degradation Scenarios', () => {

  // ── Scenario 1: Config kill-switch ──────────────────────────────────────
  describe('config kill-switch disables extension engine', () => {
    let client: McpTestClient;
    let nextId: number;
    let originalConfig: string;
    const report = new E2EReportCollector('degradation-killswitch');

    beforeAll(async () => {
      originalConfig = readFileSync(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(originalConfig);
      config.extension.enabled = false;
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

      const init = await initClient(SERVER_PATH);
      client = init.client;
      nextId = init.nextId;
      report.setExtensionConnected(false);

      // Create tab for tool calls
      const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=degradation-ks' }, nextId++, 20_000);
      // Wait for page load
      await new Promise(r => setTimeout(r, 3000));
    }, 180_000);

    afterAll(async () => {
      try {
        report.writeReport();
        await client?.close().catch(() => {});
      } finally {
        writeFileSync(CONFIG_PATH, originalConfig);
      }
    });

    it('tools fall back to daemon/applescript when extension disabled', async () => {
      const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=degradation-ks' }, nextId++, 20_000);
      const tabUrl = tabResult['tabUrl'] as string;
      await new Promise(r => setTimeout(r, 2000));

      const { meta } = await rawCallTool(client, 'safari_evaluate', { script: 'return 1', tabUrl }, nextId++, 20_000);
      expect(meta?.['engine']).not.toBe('extension');
      expect(['daemon', 'applescript']).toContain(meta?.['engine']);
      report.recordCall('safari_evaluate', { tabUrl }, meta, true);
    }, 120_000);
  });

  // ── Scenario 2: Circuit breaker trip + recovery ─────────────────────────
  describe('circuit breaker trips after errors and recovers after cooldown', () => {
    let client: McpTestClient;
    let nextId: number;
    let agentTabUrl: string;

    beforeAll(async () => {
      const init = await initClient(SERVER_PATH);
      client = init.client;
      nextId = init.nextId;

      const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=degradation-cb' }, nextId++, 20_000);
      agentTabUrl = tabResult['tabUrl'] as string;
      await new Promise(r => setTimeout(r, 3000));
    }, 180_000);

    afterAll(async () => {
      await client?.close().catch(() => {});
    });

    it('trips after 5 errors and recovers after cooldown', { timeout: 300_000 }, async () => {
      // Trigger 5 errors to trip the domain circuit breaker
      for (let i = 0; i < 5; i++) {
        await rawCallTool(
          client,
          'safari_evaluate',
          { script: '(function(){throw new Error("trip")})()', tabUrl: agentTabUrl },
          nextId++,
          10_000,
        ).catch(() => {}); // errors expected
      }

      // 6th call should get CIRCUIT_BREAKER_OPEN
      const { payload } = await rawCallTool(
        client, 'safari_evaluate',
        { script: 'return 1', tabUrl: agentTabUrl },
        nextId++, 10_000,
      );
      expect(payload._rawText ?? JSON.stringify(payload)).toContain('CIRCUIT_BREAKER_OPEN');

      // Wait for cooldown (120s from config)
      await new Promise(r => setTimeout(r, 120_000));

      // Verify recovery
      const { meta } = await rawCallTool(
        client, 'safari_evaluate',
        { script: 'return 1', tabUrl: agentTabUrl },
        nextId++, 60_000,
      );
      expect(meta?.['engine']).toBe('extension');
    });
  });

  // ── Scenario 3: Extension-unavailable selector path ─────────────────────
  describe('extension-unavailable: extension-required tools throw', () => {
    let client: McpTestClient;
    let nextId: number;
    let originalConfig: string;

    beforeAll(async () => {
      originalConfig = readFileSync(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(originalConfig);
      config.extension.enabled = false;
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

      const init = await initClient(SERVER_PATH);
      client = init.client;
      nextId = init.nextId;
    }, 180_000);

    afterAll(async () => {
      try {
        await client?.close().catch(() => {});
      } finally {
        writeFileSync(CONFIG_PATH, originalConfig);
      }
    });

    it('MCP server lists tools', async () => {
      const resp = await client.send(
        { jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} },
        20_000,
      ) as Record<string, unknown>;
      const result = resp['result'] as Record<string, unknown>;
      const tools = result['tools'] as unknown[];
      expect(tools.length).toBeGreaterThanOrEqual(75);
    }, 120_000);

    it('extension-requiring tools throw EngineUnavailableError', async () => {
      const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=degradation-eu' }, nextId++, 20_000);
      const tabUrl = tabResult['tabUrl'] as string;
      await new Promise(r => setTimeout(r, 2000));

      const { payload } = await rawCallTool(
        client, 'safari_query_shadow',
        { tabUrl, hostSelector: 'div', shadowSelector: 'span' },
        nextId++, 20_000,
      );
      const text = payload._rawText ?? JSON.stringify(payload);
      expect(text).toMatch(/EngineUnavailable|ENGINE_UNAVAILABLE|extension.*required/i);
    }, 120_000);
  });

  // ── Scenario 4: Extension disconnect (OPTIONAL) ─────────────────────────
  const hasDebugHarness = process.env['SAFARI_PILOT_TEST_MODE'] === '1';
  describe.skipIf(!hasDebugHarness)('extension disconnect during use', () => {
    // Only runs when SAFARI_PILOT_TEST_MODE=1
    // See Spec Section 8.3 Scenario 4 for implementation
    it('TODO: send force-unload, verify disconnect, verify reconnect', () => {
      expect(hasDebugHarness).toBe(true);
    });
  });
});
```

Key details:
- Each config-modifying scenario has its OWN `describe` block with its own server and cleanup
- Config backup in `beforeAll`, restore in `afterAll` with `finally` block — ALWAYS restores
- Circuit breaker test uses `{ timeout: 300_000 }` to exceed the 120s cooldown
- Scenario 4 is optional — uses `describe.skipIf(!hasDebugHarness)`

- [ ] **Step 3: Run the degradation test**

Run: `npx vitest run test/e2e/degradation.test.ts`

Expected: Scenarios 1, 2, 3 pass. Scenario 4 skips if `SAFARI_PILOT_TEST_MODE` is not set.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/degradation.test.ts
git commit -m "test(e2e): rewrite degradation test with 4 scenarios

Scenario 1: config kill-switch (extension.enabled=false).
Scenario 2: circuit breaker trip + 120s cooldown + recovery.
Scenario 3: extension-unavailable selector path.
Scenario 4: extension disconnect (optional, needs DEBUG_HARNESS)."
```

---

### Task 17: Phase 3b — Update documentation

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update ARCHITECTURE.md**

1. Remove the "CURRENT STATE WARNING" block (search for "CURRENT STATE" or "WARNING" near the top of the file)
2. Update the verified date to today
3. Change "end-to-end roundtrips not yet confirmed" to "end-to-end roundtrips verified by production-stack e2e tests"
4. Add documentation for the engine proxy pattern (how `server.ts:228-246` passes proxy to 13 modules and AppleScriptEngine directly to 4 modules)
5. Document that `_meta.engine` reflects selector choice for ALL tools, but also reflects physical execution for proxy-based tools

- [ ] **Step 2: Update CLAUDE.md**

1. In the e2e testing section, add: "E2E tests require the production stack: system daemon running on TCP:19474, Safari extension connected via HTTP:19475, Safari open with JS from Apple Events enabled."
2. Update the test count to reflect any new/removed tests
3. Add note about Phase 0 fix: "`handleInternalCommand()` in `CommandDispatcher.swift` routes `extension_health` sentinel for `ExtensionEngine.isAvailable()`"

- [ ] **Step 3: Commit**

```bash
git add ARCHITECTURE.md CLAUDE.md
git commit -m "docs: update ARCHITECTURE.md and CLAUDE.md for e2e rewrite

Remove CURRENT STATE WARNING from ARCHITECTURE.md.
Document engine proxy pattern and _meta.engine semantics.
Update CLAUDE.md e2e section with production stack requirements."
```

---

### Task 18: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run the complete e2e suite**

Run: `npx vitest run test/e2e/`

Expected: All tests pass (19 files, ~100+ tests).

- [ ] **Step 2: Run unit tests**

Run: `npm run test:unit`

Expected: 1428 tests pass.

- [ ] **Step 3: Verify no banned patterns across ALL e2e files**

```bash
grep -rn 'describe\.skipIf' test/e2e/
grep -rn "from '../../src/" test/e2e/
grep -rn '__dirname' test/e2e/
grep -rn 'vi\.mock\|vi\.spyOn\|jest\.mock' test/e2e/
```

Expected: All four greps return zero results.

- [ ] **Step 4: Verify no extensionConnected branches (except degradation)**

```bash
grep -rn 'extensionConnected' test/e2e/ | grep -v degradation
```

Expected: Zero results outside `degradation.test.ts`.

- [ ] **Step 5: Run e2e architecture compliance report**

Check `test/e2e/reports/_combined.txt` for compliance rate.

Expected: 100% compliance rate (or close, with any violations explained by known SELECTOR_ONLY_TOOLS behavior).

- [ ] **Step 6: Commit any remaining changes**

```bash
git add -A
git commit -m "test(e2e): final verification — all tests pass, zero banned patterns

Complete e2e rewrite: 19 test files, extension engine verified on every tool call.
No skipIf(CI), no extensionConnected branches, no source imports, no __dirname."
```
