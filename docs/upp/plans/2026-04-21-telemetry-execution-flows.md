# Telemetry & Execution Flow Map — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add always-on verbose trace instrumentation (15 points across TS/Swift/JS) and a canonical execution flow map document.

**Architecture:** Stateless `trace()` function per language appends NDJSON to per-process files (`~/.safari-pilot/trace.ndjson` for TS, `~/.safari-pilot/daemon-trace.ndjson` for Swift+extension). A `traceId` is generated at `executeToolWithSecurity()` entry and injected into DaemonEngine so the same ID appears in both files. Extension traces route through the existing `extension_log` HTTP path to the daemon.

**Tech Stack:** TypeScript (Node.js fs), Swift (Foundation FileHandle), JavaScript (fetch to daemon HTTP)

**Branch:** `feat/telemetry` (from `feat/tab-ownership-by-identity`)

---

## Task 0: Branch + Baseline

**Depends on:** nothing

### Steps

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git checkout -b feat/telemetry feat/tab-ownership-by-identity
npm run build
npm run test:unit
```

### Verify

- Build completes with exit 0
- Unit tests pass (1461+ tests)

### Commit

No commit — baseline verification only.

---

## Task 1: Create `src/trace.ts`

**Depends on:** Task 0

### File: `src/trace.ts` (CREATE)

- [ ] **Step 1: Write the test**

Create `test/unit/trace.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We need to test trace() with a custom path, so we test the internal logic
// by setting the env var before importing
const TEST_TRACE_DIR = join(tmpdir(), `safari-pilot-trace-test-${Date.now()}`);
process.env['SAFARI_PILOT_TRACE_DIR'] = TEST_TRACE_DIR;

// Dynamic import after env is set
const { trace } = await import('../../../src/trace.js');

describe('trace', () => {
  const traceFile = join(TEST_TRACE_DIR, 'trace.ndjson');

  afterEach(() => {
    try { unlinkSync(traceFile); } catch { /* may not exist */ }
  });

  it('appends NDJSON line to trace file', () => {
    trace('req-test-1', 'server', 'tool_received', { tool: 'safari_click' });
    const content = readFileSync(traceFile, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.id).toBe('req-test-1');
    expect(event.layer).toBe('server');
    expect(event.event).toBe('tool_received');
    expect(event.data.tool).toBe('safari_click');
    expect(event.level).toBe('event');
    expect(event.ts).toBeDefined();
  });

  it('supports error level', () => {
    trace('req-test-2', 'server', 'ownership_rejected', { tabUrl: 'https://evil.com' }, 'error');
    const content = readFileSync(traceFile, 'utf-8');
    const event = JSON.parse(content.trim());
    expect(event.level).toBe('error');
  });

  it('includes elapsed_ms when provided', () => {
    trace('req-test-3', 'server', 'tool_result', { ok: true }, 'event', 42);
    const content = readFileSync(traceFile, 'utf-8');
    const event = JSON.parse(content.trim());
    expect(event.elapsed_ms).toBe(42);
  });

  it('omits elapsed_ms when not provided', () => {
    trace('req-test-4', 'server', 'engine_selected', { engine: 'extension' });
    const content = readFileSync(traceFile, 'utf-8');
    const event = JSON.parse(content.trim());
    expect(event.elapsed_ms).toBeUndefined();
  });

  it('appends multiple events to same file', () => {
    trace('req-test-5', 'server', 'event_a', {});
    trace('req-test-5', 'server', 'event_b', {});
    const content = readFileSync(traceFile, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('silently handles write failure (never throws)', () => {
    // Passing invalid data that could cause issues — should not throw
    expect(() => {
      trace('req-test-6', 'server', 'test', { circular: undefined });
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/trace.test.ts
```

Expected: FAIL (module not found)

- [ ] **Step 3: Write the implementation**

Create `src/trace.ts`:

```typescript
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TRACE_DIR = process.env['SAFARI_PILOT_TRACE_DIR'] ?? join(homedir(), '.safari-pilot');
const TRACE_FILE = join(TRACE_DIR, 'trace.ndjson');

try { mkdirSync(TRACE_DIR, { recursive: true }); } catch { /* exists */ }

export type TraceLayer = 'server' | 'engine-proxy' | 'extension-engine' | 'daemon-engine';
export type TraceLevel = 'event' | 'error';

export function trace(
  id: string,
  layer: TraceLayer,
  event: string,
  data: Record<string, unknown>,
  level: TraceLevel = 'event',
  elapsed_ms?: number,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    id,
    layer,
    level,
    event,
    data,
    ...(elapsed_ms !== undefined && { elapsed_ms }),
  });
  try {
    appendFileSync(TRACE_FILE, line + '\n');
  } catch {
    // Never break the product — telemetry failure is silent
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/unit/trace.test.ts
```

Expected: 6 tests pass

- [ ] **Step 5: Run full unit suite — verify no regressions**

```bash
npm run lint
npm run test:unit
```

- [ ] **Step 6: Commit**

```
feat(trace): add TypeScript trace module for NDJSON telemetry

Stateless trace() function appends structured events to
~/.safari-pilot/trace.ndjson. Always-on, silent on failure.
Supports SAFARI_PILOT_TRACE_DIR override for testing.
```

---

## Task 2: Add traceId injection to DaemonEngine

**Depends on:** Task 1

### File: `src/engines/daemon.ts` (MODIFY)

The `commandId` is generated inside `sendCommand()` at line 359 via `nextId()`. Server.ts cannot see it. To get unified correlation across TS and Swift trace files, we add a one-shot `traceId` that overrides the auto-generated id.

- [ ] **Step 1: Write the test**

Add to `test/unit/engines/daemon-trace-id.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DaemonEngine } from '../../../src/engines/daemon.js';

describe('DaemonEngine traceId injection', () => {
  let engine: DaemonEngine;

  beforeEach(() => {
    engine = new DaemonEngine({ daemonPath: '/nonexistent', tcpPort: 0 });
  });

  it('setTraceId stores and getLastTraceId retrieves', () => {
    engine.setTraceId('req-custom-1');
    expect(engine.getLastTraceId()).toBe('req-custom-1');
  });

  it('getLastTraceId returns undefined when not set', () => {
    expect(engine.getLastTraceId()).toBeUndefined();
  });

  it('clearTraceId resets to undefined', () => {
    engine.setTraceId('req-custom-2');
    engine.clearTraceId();
    expect(engine.getLastTraceId()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/engines/daemon-trace-id.test.ts
```

Expected: FAIL (setTraceId not a function)

- [ ] **Step 3: Implement traceId methods on DaemonEngine**

In `src/engines/daemon.ts`, add after line 50 (`private shuttingDown = false;`):

```typescript
  private _traceId: string | undefined;
```

Add after the constructor (after line 66):

```typescript
  /**
   * Set a trace ID to use as the command ID for the next sendCommand call.
   * One-shot: consumed by sendCommand, then cleared.
   * Server.ts calls this before tool dispatch so the same ID appears in
   * both trace.ndjson (TS) and daemon-trace.ndjson (Swift).
   */
  setTraceId(id: string): void {
    this._traceId = id;
  }

  getLastTraceId(): string | undefined {
    return this._traceId;
  }

  clearTraceId(): void {
    this._traceId = undefined;
  }
```

In `sendCommand()` (line 359), replace:

```typescript
    const id = nextId();
```

with:

```typescript
    const id = this._traceId ?? nextId();
    this._traceId = undefined; // one-shot: consumed
```

In `sendCommandViaTcp()` (line 387), replace:

```typescript
    const id = nextId();
```

with:

```typescript
    const id = this._traceId ?? nextId();
    this._traceId = undefined; // one-shot: consumed
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/unit/engines/daemon-trace-id.test.ts
```

- [ ] **Step 5: Run full unit suite**

```bash
npm run lint
npm run test:unit
```

- [ ] **Step 6: Commit**

```
feat(daemon-engine): add traceId injection for cross-process correlation

setTraceId() stores a one-shot ID consumed by the next sendCommand call,
replacing the auto-generated req-{ts}-{counter}. Server.ts uses this so
the same ID appears in both TS and daemon trace files.
```

---

## Task 3: Instrument `server.ts` (8 trace points)

**Depends on:** Tasks 1, 2

### File: `src/server.ts` (MODIFY)

- [ ] **Step 1: Add import and traceId counter**

At the top of `src/server.ts`, add import:

```typescript
import { trace } from './trace.js';
```

Add a module-level counter after the existing imports/constants (~line 130 area):

```typescript
let _traceCounter = 0;
function nextTraceId(): string {
  return `req-${Date.now()}-${++_traceCounter}`;
}
```

- [ ] **Step 2: Add trace point 1 (tool_received) + traceId generation**

At the start of `executeToolWithSecurity()`, after `const start = Date.now();` (line 391), add:

```typescript
    const traceId = nextTraceId();
    trace(traceId, 'server', 'tool_received', {
      tool: name,
      tabUrl: (params['tabUrl'] ?? params['url'] ?? '') as string,
      paramKeys: Object.keys(params),
    });
```

- [ ] **Step 3: Add trace point 2 (ownership_check)**

After the ownership check block (step 7d, after the closing `}` of the ownership if-block at ~line 533), add:

```typescript
    trace(traceId, 'server', 'ownership_check', {
      tabUrl: (params['tabUrl'] as string) ?? null,
      found: params['tabUrl'] ? !!this.tabOwnership.findByUrl(params['tabUrl'] as string) : null,
      deferred: deferredOwnershipCheck,
      skipped: !params['tabUrl'] || SKIP_OWNERSHIP_TOOLS.has(name),
    });
```

- [ ] **Step 4: Add trace point 3 (domain_policy)**

After the domain policy evaluation (after `const policy = this.domainPolicy.evaluate(url);` at ~line 406), add:

```typescript
    trace(traceId, 'server', 'domain_policy', {
      domain,
      trustLevel: policy.trust,
      blocked: policy.blocked ?? false,
    });
```

- [ ] **Step 5: Add trace point 4 (rate_limit_check)**

After rate limiter (after `this.rateLimiter.recordAction(domain);` at ~line 475), add:

```typescript
    trace(traceId, 'server', 'rate_limit_check', { domain });
```

- [ ] **Step 6: Add trace point 5 (engine_selected)**

After engine selection completes (after the proxy setup at ~line 504), add:

```typescript
    trace(traceId, 'server', 'engine_selected', {
      engine: selectedEngineName,
      degraded: degradedFromExtension ?? false,
    });
```

- [ ] **Step 7: Add trace point 6 (engine_dispatch) + inject traceId into daemon**

Before the `try {` that wraps `callTool` (at ~line 576), add:

```typescript
    // Inject traceId into daemon engine so the same ID appears in daemon-trace.ndjson
    const daemonEngine = this.getDaemonEngine();
    if (daemonEngine) {
      daemonEngine.setTraceId(traceId);
    }
    trace(traceId, 'server', 'engine_dispatch', {
      engine: selectedEngineName,
      tabUrl: (params['tabUrl'] ?? '') as string,
    });
```

- [ ] **Step 8: Add trace point 7 (tool_result)**

After `const result = await this.callTool(name, params);` (inside the try, after circuit breaker recordSuccess), add:

```typescript
      const engineMeta = this.engineProxy?.getLastMeta();
      trace(traceId, 'server', 'tool_result', {
        ok: true,
        engine: selectedEngineName,
        metaTabId: engineMeta?.tabId ?? null,
        metaTabUrl: engineMeta?.tabUrl ?? null,
      }, 'event', Date.now() - start);
```

Note: `engineMeta` may already be declared later in the post-verify block. If so, move the `const engineMeta` declaration to before this trace point and remove the duplicate declaration in the post-verify block.

- [ ] **Step 9: Add trace point 8 (post_verify)**

After the post-execution ownership block (after the `else if (deferredOwnershipCheck)` closing), add:

```typescript
      trace(traceId, 'server', 'post_verify', {
        backfilled: engineMeta?.tabId !== undefined && params['tabUrl']
          ? !!this.tabOwnership.findByUrl(params['tabUrl'] as string)
          : false,
        urlRefreshed: engineMeta?.tabUrl ?? null,
        deferredVerified: deferredOwnershipCheck,
      });
```

- [ ] **Step 10: Add error-path trace in the catch block**

In the `catch (error)` block (at ~line 708), before `this.circuitBreaker.recordFailure(domain);`, add:

```typescript
      trace(traceId, 'server', 'tool_error', {
        tool: name,
        error: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string }).code ?? 'UNKNOWN',
      }, 'error', Date.now() - start);
```

- [ ] **Step 11: Verify**

```bash
npm run build
npm run lint
npm run test:unit
```

All must pass. The trace calls are side-effect-only (append to file) and don't affect logic.

- [ ] **Step 12: Commit**

```
feat(server): add 8 trace instrumentation points to security pipeline

Generates traceId at tool entry, injects into DaemonEngine for cross-process
correlation. Traces: tool_received, ownership_check, domain_policy,
rate_limit_check, engine_selected, engine_dispatch, tool_result, post_verify.
Error path traced as tool_error.
```

---

## Task 4: Create `daemon/Sources/SafariPilotdCore/Trace.swift`

**Depends on:** Task 0

### File: `daemon/Sources/SafariPilotdCore/Trace.swift` (CREATE)

- [ ] **Step 1: Create Trace.swift**

```swift
import Foundation

/// Appends structured NDJSON trace events to ~/.safari-pilot/daemon-trace.ndjson.
/// Always-on, silent on failure. Never blocks or throws.
enum Trace {
    private static let filePath: String = {
        let dir = NSHomeDirectory() + "/.safari-pilot"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: nil)
        return dir + "/daemon-trace.ndjson"
    }()

    private static let fileHandle: FileHandle? = {
        if !FileManager.default.fileExists(atPath: filePath) {
            FileManager.default.createFile(atPath: filePath, contents: nil)
        }
        return FileHandle(forWritingAtPath: filePath)
    }()

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func emit(
        _ id: String,
        layer: String,
        event: String,
        data: [String: Any] = [:],
        level: String = "event"
    ) {
        let obj: [String: Any] = [
            "ts": iso8601.string(from: Date()),
            "id": id,
            "layer": layer,
            "level": level,
            "event": event,
            "data": data
        ]
        guard let json = try? JSONSerialization.data(withJSONObject: obj),
              var line = String(data: json, encoding: .utf8) else { return }
        line += "\n"
        guard let lineData = line.data(using: .utf8) else { return }
        fileHandle?.seekToEndOfFile()
        fileHandle?.write(lineData)
    }
}
```

- [ ] **Step 2: Verify daemon builds**

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
cd daemon && swift build 2>&1 | tail -5
cd ..
```

Expected: Build complete with no errors (warnings about Sendable are pre-existing).

- [ ] **Step 3: Commit**

```
feat(daemon): add Swift Trace module for NDJSON telemetry

Stateless Trace.emit() appends structured events to
~/.safari-pilot/daemon-trace.ndjson. Always-on, silent on failure.
```

---

## Task 5: Instrument Swift daemon (4 trace points + `__trace__` sentinel)

**Depends on:** Task 4

### Files:
- MODIFY: `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift`
- MODIFY: `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`

- [ ] **Step 1: Add trace point 9 (command_received) in CommandDispatcher**

In `CommandDispatcher.swift`, in the `dispatch()` method, right after the command is parsed (after `let command = try JSONDecoder()...`), add:

```swift
        Trace.emit(command.id, layer: "daemon-dispatcher", event: "command_received", data: [
            "method": command.method,
            "hasTabUrl": command.params.keys.contains("tabUrl") || command.params.keys.contains("script"),
        ])
```

- [ ] **Step 2: Add trace point 10 (bridge_queued) in ExtensionBridge.handleExecute**

In `ExtensionBridge.swift`, in `handleExecute()`, after the command is queued and the continuation is created, add:

```swift
        Trace.emit(commandID, layer: "daemon-bridge", event: "bridge_queued", data: [
            "pendingCount": self.pendingCommands.count,
            "extensionConnected": self.isConnected,
        ])
```

- [ ] **Step 3: Add trace point 11 (extension_polled) in ExtensionBridge.handlePoll**

In `ExtensionBridge.swift`, in the poll handler where commands are delivered (after marking `delivered=true`), for each command delivered add:

```swift
        Trace.emit(cmd.id, layer: "daemon-bridge", event: "extension_polled", data: [
            "deliveredCount": deliveredCommands.count,
        ])
```

Use the existing loop variable — emit once per delivered batch, not per command. Place it after the commands array is built.

- [ ] **Step 4: Add trace point 12 (bridge_result) in ExtensionBridge.handleResult**

In `ExtensionBridge.swift`, in `handleResult()`, right before `cmd.continuation.resume(returning: callerResponse)` (at ~line 329), add:

```swift
        let hasMeta = (params["result"]?.value as? [String: Any])?["_meta"] != nil
        let metaTabId = ((params["result"]?.value as? [String: Any])?["_meta"] as? [String: Any])?["tabId"]
        Trace.emit(cmd.id, layer: "daemon-bridge", event: "bridge_result", data: [
            "ok": callerResponse.isSuccess,
            "hasMeta": hasMeta,
            "metaTabId": metaTabId as Any? ?? "null",
            "wrapperApplied": hasMeta,
        ])
```

Note: `callerResponse.isSuccess` — check if Response has this property. If not, use a local boolean that's set during the result parsing branches above.

- [ ] **Step 5: Add `__trace__` sentinel handling in handleResult**

At the top of `handleResult()`, before the existing command lookup, add:

```swift
        // Handle extension trace events — append to daemon-trace.ndjson, don't route to continuation
        if let requestId = params["requestId"]?.value as? String, requestId == "__trace__" {
            if let result = params["result"]?.value as? [String: Any],
               let traceType = result["type"] as? String, traceType == "trace",
               let traceId = result["id"] as? String,
               let layer = result["layer"] as? String,
               let event = result["event"] as? String {
                let data = result["data"] as? [String: Any] ?? [:]
                Trace.emit(traceId, layer: layer, event: event, data: data)
            }
            return Response.success(id: commandID, value: AnyCodable("ok"))
        }
```

- [ ] **Step 6: Verify daemon builds**

```bash
cd daemon && swift build 2>&1 | tail -5 && cd ..
```

- [ ] **Step 7: Commit**

```
feat(daemon): instrument 4 trace points + __trace__ sentinel handler

Traces: command_received, bridge_queued, extension_polled, bridge_result.
The __trace__ sentinel routes extension trace events to daemon-trace.ndjson.
```

---

## Task 6: Rebuild daemon

**Depends on:** Task 5

- [ ] **Step 1: Rebuild and restart**

```bash
bash scripts/update-daemon.sh
```

- [ ] **Step 2: Verify daemon starts and trace file is created**

```bash
echo '{"id":"trace-test","method":"ping","params":{}}' | nc -w 2 localhost 19474
ls -la ~/.safari-pilot/daemon-trace.ndjson
```

The ping should return `{"ok":true,"value":"pong"}` and the trace file should exist (may be empty if no extension_execute commands have run yet — the ping doesn't trigger trace points).

- [ ] **Step 3: Commit**

No commit — binary is gitignored. Task 5's commit covers the source.

---

## Task 7: Add `emitTrace` to `extension/background.js` (3 trace points)

**Depends on:** Task 5 (needs `__trace__` sentinel in daemon)

### File: `extension/background.js` (MODIFY)

- [ ] **Step 1: Add emitTrace function**

After the `postResult` function (~line 102), add:

```javascript
function emitTrace(commandId, event, data) {
  httpPost('/result', {
    requestId: '__trace__',
    result: { type: 'trace', id: commandId, layer: 'extension-bg', event, data }
  }).catch(() => {});
}
```

- [ ] **Step 2: Add trace point 13 (cmd_dispatched)**

In `executeCommand()`, after `await browser.storage.local.set({ sp_cmd: storageCmd });` (~line 223), add:

```javascript
  emitTrace(commandId, 'cmd_dispatched', { tabId: tab.id, tabUrl: cmd.tabUrl });
```

- [ ] **Step 3: Add trace point 14 (result_received)**

In the `resultListener` function, after `resultResolver(reply.result);` (~line 218), add:

```javascript
    emitTrace(commandId, 'result_received', {
      ok: reply.result?.ok ?? null,
      hasValue: reply.result?.value !== undefined,
    });
```

- [ ] **Step 4: Add trace point 15 (result_enriched)**

After the `enrichedResult` construction (~line 234), add:

```javascript
  emitTrace(commandId, 'result_enriched', {
    tabId: tab.id,
    tabUrl: tab.url,
    enriched: typeof enrichedResult === 'object' && '_meta' in enrichedResult,
  });
```

- [ ] **Step 5: Commit**

```
feat(extension): add 3 trace points to background.js command execution

Traces: cmd_dispatched, result_received, result_enriched.
Routes via __trace__ sentinel to daemon's trace file.
```

---

## Task 8: Rebuild extension

**Depends on:** Task 7

- [ ] **Step 1: Rebuild, sign, notarize**

```bash
bash scripts/build-extension.sh
```

- [ ] **Step 2: Install and verify**

```bash
open "bin/Safari Pilot.app"
codesign -d --entitlements - "bin/Safari Pilot.app" 2>&1 | grep -c "app-sandbox"
```

Must show `1` (entitlements present).

After install, verify extension is enabled in Safari > Settings > Extensions.

- [ ] **Step 3: Commit**

```
feat(extension): rebuild with trace instrumentation

Includes 3 trace points (cmd_dispatched, result_received, result_enriched)
routed to daemon trace file via __trace__ sentinel.
```

---

## Task 9: Write `docs/EXECUTION-FLOWS.md`

**Depends on:** Tasks 1-8 (all instrumentation in place)

### File: `docs/EXECUTION-FLOWS.md` (CREATE)

Write the canonical execution flow document. This is a documentation task — reference the spec at `docs/upp/specs/2026-04-21-telemetry-execution-flows-design.md` Section 7 for the structure.

Must include:

1. **How to Read** section — trace file locations, grep commands, merge script reference
2. **Trace Files** section — paths, format, rotation
3. **Tool Classes** — 5 classes with ASCII flow diagrams and `📍N` telemetry markers:
   - Class 1: Extension-Engine Tools (full 15-point flow)
   - Class 2: AppleScript-Only Tools (server points only, 8 max)
   - Class 3: Daemon-Direct Tools (safari_export_pdf, safari_wait_for_download)
   - Class 4: Skip-Ownership Tools (overlaps with 1-3, skip point #2)
   - Class 5: Navigation + Ownership Update (extension flow + post-exec _meta refresh)
4. **Security Pipeline** — layer-by-layer order with telemetry points
5. **IPC Protocols** — wire formats, timeouts, telemetry boundaries
6. **Tool → Class Mapping** — table of all 78 tools and their class

Each tool class section must have an ASCII diagram like:

```
MCP Client ──JSON-RPC──▶ server.ts
  📍1 tool_received
  📍2 ownership_check
  📍3 domain_policy
  📍4 rate_limit_check
  📍5 engine_selected
  📍6 engine_dispatch ──NDJSON/TCP──▶ CommandDispatcher.swift
    📍9  command_received ──▶ ExtensionBridge
    📍10 bridge_queued ──HTTP:19475──▶ background.js
      📍11 extension_polled
      📍13 cmd_dispatched ──storage bus──▶ content script
      📍14 result_received ◀──storage bus──
      📍15 result_enriched ──HTTP POST──▶
    📍12 bridge_result ◀──continuation──
  📍7 tool_result ◀──NDJSON/TCP──
  📍8 post_verify
MCP Client ◀──JSON-RPC──
```

**Update rule:** Any commit that adds a tool, changes engine routing, modifies the security pipeline, or adds/removes a telemetry point MUST update this document.

- [ ] **Step 1: Write the document**
- [ ] **Step 2: Verify all 78 tools are listed in the mapping table**

```bash
grep -c "safari_" docs/EXECUTION-FLOWS.md
```

Should be >= 78.

- [ ] **Step 3: Commit**

```
docs: create canonical execution flow map with telemetry points

Maps all 78 tools to 5 execution classes. Diagrams show full data flow
with 15 telemetry points marked. Includes IPC protocols, security
pipeline order, and grep/merge commands for debugging.
```

---

## Task 10: Scripts + End-to-End Verification

**Depends on:** Tasks 1-9

### Files:
- CREATE: `scripts/trace-merge.sh`
- CREATE: `scripts/trace-rotate.sh`

- [ ] **Step 1: Create trace-merge.sh**

```bash
#!/usr/bin/env bash
# Merge TS and daemon trace files, sorted by timestamp, filtered by optional commandId
set -euo pipefail

TRACE_DIR="${HOME}/.safari-pilot"
TS_FILE="${TRACE_DIR}/trace.ndjson"
DAEMON_FILE="${TRACE_DIR}/daemon-trace.ndjson"

if [ $# -eq 0 ]; then
  cat "$TS_FILE" "$DAEMON_FILE" 2>/dev/null | sort -t'"' -k4
else
  cat "$TS_FILE" "$DAEMON_FILE" 2>/dev/null | grep "$1" | sort -t'"' -k4
fi
```

- [ ] **Step 2: Create trace-rotate.sh**

```bash
#!/usr/bin/env bash
# Rotate trace files larger than 5MB
set -euo pipefail

TRACE_DIR="${HOME}/.safari-pilot"
MAX_SIZE=$((5 * 1024 * 1024))

for f in "${TRACE_DIR}/trace.ndjson" "${TRACE_DIR}/daemon-trace.ndjson"; do
  if [ -f "$f" ] && [ "$(stat -f%z "$f" 2>/dev/null || echo 0)" -gt "$MAX_SIZE" ]; then
    mv "$f" "${f}.$(date +%Y%m%d%H%M%S).bak"
    echo "Rotated: $f"
  fi
done
```

- [ ] **Step 3: Make scripts executable**

```bash
chmod +x scripts/trace-merge.sh scripts/trace-rotate.sh
```

- [ ] **Step 4: End-to-end verification — run a tool call and check both trace files**

```bash
# Clear trace files
> ~/.safari-pilot/trace.ndjson
> ~/.safari-pilot/daemon-trace.ndjson

# Run a simple MCP tool call via the e2e test helper
SAFARI_PILOT_E2E=1 npx vitest run test/e2e/mcp-handshake.test.ts

# Check TS trace file
echo "=== TS trace ==="
cat ~/.safari-pilot/trace.ndjson | head -20

# Check daemon trace file
echo "=== Daemon trace ==="
cat ~/.safari-pilot/daemon-trace.ndjson | head -20

# Verify correlation — pick a traceId from the TS file and grep both
TRACE_ID=$(head -1 ~/.safari-pilot/trace.ndjson | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
echo "=== Merged trace for ${TRACE_ID} ==="
bash scripts/trace-merge.sh "$TRACE_ID"
```

Expected: Both files have events. The merged output shows events from both files sorted chronologically with the same traceId.

- [ ] **Step 5: Verify full unit suite passes**

```bash
npm run build
npm run lint
npm run test:unit
```

- [ ] **Step 6: Commit**

```
feat: add trace-merge and trace-rotate scripts + end-to-end verification

trace-merge.sh: unified view across TS and daemon trace files.
trace-rotate.sh: rotate files > 5MB.
Verified: tool calls emit correlated events in both trace files.
```

---

## Summary of Files Changed

| File | Change |
|------|--------|
| `src/trace.ts` | CREATE — TypeScript trace function |
| `test/unit/trace.test.ts` | CREATE — trace function tests |
| `src/engines/daemon.ts` | MODIFY — add traceId injection (setTraceId/clearTraceId) |
| `test/unit/engines/daemon-trace-id.test.ts` | CREATE — traceId injection tests |
| `src/server.ts` | MODIFY — 8 trace points + traceId generation |
| `daemon/Sources/SafariPilotdCore/Trace.swift` | CREATE — Swift trace function |
| `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` | MODIFY — 1 trace point |
| `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` | MODIFY — 3 trace points + __trace__ sentinel |
| `extension/background.js` | MODIFY — emitTrace function + 3 trace points |
| `docs/EXECUTION-FLOWS.md` | CREATE — canonical execution flow map |
| `scripts/trace-merge.sh` | CREATE — merge both trace files |
| `scripts/trace-rotate.sh` | CREATE — rotate files > 5MB |
