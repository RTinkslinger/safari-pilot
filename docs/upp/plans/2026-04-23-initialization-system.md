# Initialization System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Safari Pilot fully initialize before any tool runs — session window open, extension connected, health verified — with live checks before every tool call and transparent recovery.

**Architecture:** MCP `initialize()` blocks until all systems green. Before every tool call, a live HTTP check to the daemon confirms health. If anything is down, transparent recovery (up to 10s) or explicit error. Multi-session detection via daemon-side session registry.

**Tech Stack:** TypeScript (MCP server), Swift (daemon HealthStore + HTTP routes), AppleScript (window management)

---

### Task 1: Add SessionRecoveryError to error hierarchy

**Files:**
- Modify: `src/errors.ts:4-28` (add error code)
- Modify: `src/errors.ts` (add error class, after existing error classes)

- [ ] **Step 1: Add SESSION_RECOVERY_FAILED to ERROR_CODES**

In `src/errors.ts`, add to the `ERROR_CODES` object:

```typescript
SESSION_RECOVERY_FAILED: 'SESSION_RECOVERY_FAILED',
```

- [ ] **Step 2: Add SessionRecoveryError class**

After the existing error classes in `src/errors.ts`, add:

```typescript
export class SessionRecoveryError extends SafariPilotError {
  readonly code = ERROR_CODES.SESSION_RECOVERY_FAILED as ErrorCode;
  readonly retryable = true;
  readonly hints: string[];

  constructor(details: { daemon: boolean; extension: boolean; window: boolean; durationMs: number }) {
    const down: string[] = [];
    if (!details.daemon) down.push('daemon not running');
    if (!details.extension) down.push('extension not connected');
    if (!details.window) down.push('session window closed');
    super(`Session recovery failed after ${details.durationMs}ms: ${down.join(', ')}`);
    this.name = 'SessionRecoveryError';
    this.hints = [
      'Check Safari is running',
      'Check extension is enabled in Safari > Settings > Extensions',
      'Try restarting the daemon: launchctl kickstart -k gui/$(id -u)/com.anthropic.safari-pilot',
    ];
  }
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 4: Commit**

```bash
git add src/errors.ts
git commit -m "feat: add SessionRecoveryError for init system recovery failures"
```

---

### Task 2: Add session registry to daemon HealthStore

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/HealthStore.swift`

- [ ] **Step 1: Add session registry fields and methods**

After the existing `mcpConnected` fields (around line 41), add:

```swift
// Session registry: tracks active MCP sessions
private var _activeSessions: [(sessionId: String, lastSeen: Date)] = []
public var activeSessionCount: Int {
    queue.sync {
        pruneStaleSessionsLocked()
        return _activeSessions.count
    }
}
```

After `recordHttpRequestError()` (around line 128), add:

```swift
// MARK: - Session registry

/// Register an MCP session. If sessionId already exists, update lastSeen.
public func registerSession(_ sessionId: String) {
    queue.sync {
        if let idx = _activeSessions.firstIndex(where: { $0.sessionId == sessionId }) {
            _activeSessions[idx].lastSeen = Date()
        } else {
            _activeSessions.append((sessionId: sessionId, lastSeen: Date()))
        }
        Logger.info("Session registered: \(sessionId) (total: \(_activeSessions.count))")
    }
}

/// Update lastSeen for a session (called on each /status check as implicit heartbeat).
public func touchSession(_ sessionId: String) {
    queue.sync {
        if let idx = _activeSessions.firstIndex(where: { $0.sessionId == sessionId }) {
            _activeSessions[idx].lastSeen = Date()
        }
    }
}

/// Remove sessions not seen in 60s.
private func pruneStaleSessionsLocked() {
    let cutoff = Date(timeIntervalSinceNow: -60)
    _activeSessions.removeAll(where: { $0.lastSeen < cutoff })
}
```

- [ ] **Step 2: Build the daemon**

Run: `cd daemon && swift build 2>&1 | tail -5`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/HealthStore.swift
git commit -m "feat(daemon): add session registry to HealthStore for multi-session tracking"
```

---

### Task 3: Add POST /session/register route and extend GET /status response

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift`

- [ ] **Step 1: Add the /session/register route**

In `buildRouter()`, after the `router.get("health")` block (around line 142), add:

```swift
router.post("session/register") { [self] request, context -> HBResponse in
    self.touchLastRequestTime()
    let buffer = try await request.body.collect(upTo: context.maxUploadSize)
    guard buffer.readableBytes > 0,
          let data = buffer.getData(at: buffer.readerIndex, length: buffer.readableBytes),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let sessionId = json["sessionId"] as? String else {
        throw HTTPError(.badRequest, message: "Missing sessionId in body")
    }
    self.healthStore.registerSession(sessionId)
    return self.jsonResponse([
        "ok": true,
        "activeSessions": self.healthStore.activeSessionCount,
    ])
}
```

- [ ] **Step 2: Extend GET /status response with activeSessions count**

In `handleStatus()` (around line 236), add the session count to the response. Change the return to:

```swift
return jsonResponse([
    "ext": extConnected,
    "mcp": mcpConn,
    "sessionTab": sessionTab,
    "lastPingAge": lastPingAge,
    "activeSessions": healthStore.activeSessionCount,
])
```

- [ ] **Step 3: Add sessionId to GET /status for heartbeat**

Add a `sessionId` query parameter to the status route so the MCP server can heartbeat its session on every status check. Replace the `router.get("status")` block:

```swift
router.get("status") { [self] request, _ -> HBResponse in
    // Extract sessionId from query string for implicit heartbeat
    if let sessionId = request.uri.queryParameters.get("sessionId") {
        self.healthStore.touchSession(sessionId)
    }
    return self.handleStatus()
}
```

- [ ] **Step 4: Build the daemon**

Run: `cd daemon && swift build 2>&1 | tail -5`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift
git commit -m "feat(daemon): add session registration route and extend /status with session count"
```

---

### Task 4: Add session dashboard session ID display

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` (the `sessionPageHTML` static string)

- [ ] **Step 1: Update the session dashboard HTML**

In the `sessionPageHTML` static string, add a session ID display row to the status table. After the Uptime row (`<td class="value" id="uptime">—</td>`), add:

```html
<tr>
  <td class="label">Session</td>
  <td class="value" id="session-id">—</td>
</tr>
```

In the JavaScript `poll()` function, add after the uptime update:

```javascript
if (d.sessionId) {
  document.getElementById('session-id').textContent = d.sessionId;
}
```

And extend the `/health` endpoint response in `handleHealth()` to include the session tab's URL query param sessionId. Actually, the simpler approach: the session tab URL will include the sessionId as a query param: `http://127.0.0.1:19475/session?id=sess_abc123`. The JavaScript on the page reads it:

Add to the top of the `<script>` block in sessionPageHTML:

```javascript
const sessionId = new URLSearchParams(location.search).get('id') || '—';
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('session-id').textContent = sessionId;
});
```

- [ ] **Step 2: Build the daemon**

Run: `cd daemon && swift build 2>&1 | tail -5`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift
git commit -m "feat(daemon): show session ID on session dashboard page"
```

---

### Task 5: Rebuild daemon binary and deploy

**Files:**
- Modify: `bin/SafariPilotd` (rebuilt binary)

- [ ] **Step 1: Rebuild daemon with all changes**

Run: `bash scripts/update-daemon.sh`
Expected: Binary rebuilt, LaunchAgent restarted, daemon running on TCP:19474 + HTTP:19475

- [ ] **Step 2: Verify daemon is alive**

Run: `curl -s http://127.0.0.1:19475/status`
Expected: JSON with `ext`, `mcp`, `sessionTab`, `lastPingAge`, `activeSessions` fields

- [ ] **Step 3: Verify new route exists**

Run: `curl -s -X POST http://127.0.0.1:19475/session/register -H 'Content-Type: application/json' -d '{"sessionId":"test-123"}'`
Expected: `{"ok":true,"activeSessions":1}`

- [ ] **Step 4: Commit**

```bash
git add bin/SafariPilotd
git commit -m "build: rebuild daemon with session registry and extended /status"
```

---

### Task 6: Rewrite server initialize() — full startup sequence

This is the core task. Move session window creation and extension bootstrap from `executeToolWithSecurity()` into `initialize()`. Block until all systems green.

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Update sessionTabUrl to include sessionId**

In the class fields (around line 165), change:

```typescript
private readonly sessionTabUrl = 'http://127.0.0.1:19475/session';
```

to:

```typescript
private get sessionTabUrl(): string {
  return `http://127.0.0.1:19475/session?id=${this.sessionId}`;
}
```

- [ ] **Step 2: Add registerWithDaemon() method**

After `checkExtensionStatus()`, add:

```typescript
/**
 * Register this session with the daemon and get existing session count.
 */
private async registerWithDaemon(): Promise<number> {
  try {
    const resp = await fetch('http://127.0.0.1:19475/session/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: this.sessionId }),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return 0;
    const data = await resp.json() as { activeSessions?: number };
    return (data.activeSessions ?? 1) - 1; // subtract self
  } catch {
    return 0;
  }
}
```

- [ ] **Step 3: Update checkExtensionStatus() to include sessionId for heartbeat**

Change the fetch URL in `checkExtensionStatus()` from:

```typescript
const resp = await fetch('http://127.0.0.1:19475/status', { signal: AbortSignal.timeout(5000) });
```

to:

```typescript
const resp = await fetch(`http://127.0.0.1:19475/status?sessionId=${this.sessionId}`, { signal: AbortSignal.timeout(2000) });
```

Also update the return type to include `activeSessions`:

```typescript
private async checkExtensionStatus(): Promise<{ ext: boolean; mcp: boolean; sessionTab: boolean; lastPingAge: number | null; activeSessions: number }> {
```

And the catch block default return:

```typescript
return { ext: false, mcp: false, sessionTab: false, lastPingAge: null, activeSessions: 0 };
```

- [ ] **Step 4: Rewrite initialize() with full startup sequence**

Replace the `start()` method (around line 983):

```typescript
async start(): Promise<void> {
  await this.initialize();

  // ── Full startup sequence ─────────────────────────────────────────
  // 1. Register session with daemon
  const otherSessions = await this.registerWithDaemon();
  if (otherSessions > 0) {
    console.error(`Safari Pilot: found ${otherSessions} existing session(s), starting session ${otherSessions + 1} in new window`);
  }

  // 2. Open session window
  await this.ensureSessionWindow('init');

  // 3. Wait for extension to connect (up to 15s)
  console.error('Safari Pilot: waiting for extension connection...');
  const initStart = Date.now();
  let extensionConnected = false;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const status = await this.checkExtensionStatus();
    if (status.ext) {
      extensionConnected = true;
      this.setEngineAvailability({ ...this.engineAvailability, extension: true });
      break;
    }
  }
  const initDuration = Date.now() - initStart;

  if (extensionConnected) {
    console.error(`Safari Pilot: all systems green (${initDuration}ms)`);
  } else {
    console.error(`Safari Pilot: extension not connected after ${initDuration}ms — tools will use daemon engine`);
  }

  // Store init metadata for MCP response enrichment
  this._initMeta = {
    sessionId: this.sessionId,
    windowId: this._sessionWindowId ?? null,
    existingSessions: otherSessions,
    systems: {
      daemon: this.engineAvailability.daemon,
      extension: extensionConnected,
      sessionTab: this._sessionTabOpened,
    },
    initDurationMs: initDuration,
  };

  console.error('Safari Pilot MCP server started');
}
```

- [ ] **Step 5: Add _initMeta field to the class**

In the class fields (around line 164), add:

```typescript
private _initMeta: {
  sessionId: string;
  windowId: number | null;
  existingSessions: number;
  systems: { daemon: boolean; extension: boolean; sessionTab: boolean };
  initDurationMs: number;
} | undefined;
```

And a getter for index.ts to use:

```typescript
getInitMeta(): typeof this._initMeta {
  return this._initMeta;
}
```

- [ ] **Step 6: Remove old ensureExtensionReady and ensureSessionWindow calls from executeToolWithSecurity**

In `executeToolWithSecurity()`, remove the step 6.5a and 6.5b blocks:

```typescript
// DELETE these lines (the old bootstrap):
// 6.5a. Session window — every MCP session gets its own Safari window.
if (!this._sessionWindowId) {
  await this.ensureSessionWindow(traceId);
}
// 6.5b. Extension bootstrap — runs BEFORE engine selection...
if (this.engines.has('daemon') && !this.engineAvailability.extension) {
  await this.ensureExtensionReady(traceId);
}
```

These are replaced by the pre-call health gate in Task 7.

- [ ] **Step 7: Build and verify**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 8: Commit**

```bash
git add src/server.ts
git commit -m "feat: move session window + extension bootstrap to initialize(), block until green"
```

---

### Task 7: Add pre-call live health gate with transparent recovery

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add checkWindowExists() helper**

After `checkExtensionStatus()`, add:

```typescript
/**
 * Fast check whether the session window still exists in Safari.
 */
private async checkWindowExists(): Promise<boolean> {
  if (!this._sessionWindowId) return false;
  try {
    const { execSync } = await import('node:child_process');
    const result = execSync(
      `osascript -e 'tell application "Safari" to return (exists window id ${this._sessionWindowId})'`,
      { timeout: 2000, encoding: 'utf-8' },
    ).trim();
    return result === 'true';
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Add recoverSession() method**

After `checkWindowExists()`, add:

```typescript
/**
 * Attempt transparent session recovery. Called when pre-call gate finds
 * a component down. Blocks up to 10s. Returns true if recovered.
 */
private async recoverSession(traceId: string): Promise<boolean> {
  const start = Date.now();
  trace(traceId, 'server', 'recovery_start', {
    windowId: this._sessionWindowId,
  });

  // Re-open window if gone
  const windowOk = await this.checkWindowExists();
  if (!windowOk) {
    this._sessionWindowId = undefined;
    await this.ensureSessionWindow(traceId);
  }

  // Poll for extension connection (up to 10s)
  for (let i = 0; i < 10; i++) {
    const status = await this.checkExtensionStatus();
    if (status.ext) {
      this.setEngineAvailability({ ...this.engineAvailability, extension: true });
      const duration = Date.now() - start;
      trace(traceId, 'server', 'recovery_success', { durationMs: duration });
      console.error(`Safari Pilot: session recovered in ${duration}ms`);
      return true;
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  const duration = Date.now() - start;
  trace(traceId, 'server', 'recovery_failed', { durationMs: duration });
  return false;
}
```

- [ ] **Step 3: Add pre-call health gate to executeToolWithSecurity()**

At the very top of `executeToolWithSecurity()`, before any existing code (before the `start` timestamp and traceId), add:

```typescript
// 0. Pre-call health gate — live check before every tool call
const status = await this.checkExtensionStatus();
const windowOk = await this.checkWindowExists();
this.setEngineAvailability({
  daemon: this.engineAvailability.daemon,
  extension: status.ext,
});

if (!status.ext || !windowOk) {
  const traceId = `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const recovered = await this.recoverSession(traceId);
  if (!recovered) {
    throw new SessionRecoveryError({
      daemon: this.engineAvailability.daemon,
      extension: status.ext,
      window: windowOk,
      durationMs: 10000,
    });
  }
}
```

Import `SessionRecoveryError` at the top of server.ts.

- [ ] **Step 4: Build and verify**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat: add pre-call health gate with transparent 10s recovery"
```

---

### Task 8: Expose init metadata in MCP initialize response

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add _meta to the MCP Server constructor**

The MCP SDK's `Server` constructor accepts server info and capabilities. The initialize response is controlled by the SDK. To inject `_meta`, we need to check if the SDK supports it.

Read: `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts` to check if the `Server` constructor or `connect()` accepts custom metadata.

If the SDK doesn't support custom metadata in initialize response (likely), the fallback is: the agent's first call to `safari_health_check` returns the init metadata. Update `handleHealthCheck()` to include `_initMeta` in its response.

In `src/server.ts`, in the `handleHealthCheck` method, add the init metadata to the response:

```typescript
// Add after the existing health check response construction:
if (this._initMeta) {
  healthData.init = this._initMeta;
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`
Expected: Clean compilation

- [ ] **Step 3: Commit**

```bash
git add src/server.ts src/index.ts
git commit -m "feat: expose init metadata via safari_health_check response"
```

---

### Task 9: Live validation — prove the full init sequence works

This is the proof task. No mocks. Real MCP server, real Safari, real extension.

**Files:**
- Create: `test/e2e/initialization.test.ts`

- [ ] **Step 1: Write the e2e test**

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { initClient, callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';

describe('Initialization system', () => {
  let client: McpTestClient;
  let nextId: number;

  afterAll(async () => {
    if (client) await client.close();
  });

  it('MCP initialize blocks until session window opens and extension connects', async () => {
    // This is the real test: spawn node dist/index.js, do MCP handshake.
    // initClient blocks until initialize response arrives — which now blocks
    // until the session window is open and extension is connected.
    const startMs = Date.now();
    const result = await initClient('dist/index.js');
    client = result.client;
    nextId = result.nextId;
    const elapsed = Date.now() - startMs;

    // Init should take 2-15s (extension connection time)
    expect(elapsed).toBeGreaterThan(1000);
    expect(elapsed).toBeLessThan(20000);
  }, 25000);

  it('safari_health_check returns init metadata with all systems green', async () => {
    const result = await callTool(client, 'safari_health_check', { verbose: true }, nextId++);

    expect(result.healthy).toBe(true);
    expect(result.init).toBeDefined();
    expect(result.init.sessionId).toMatch(/^sess_/);
    expect(result.init.windowId).toBeGreaterThan(0);
    expect(result.init.systems.daemon).toBe(true);
    expect(result.init.systems.extension).toBe(true);
    expect(result.init.systems.sessionTab).toBe(true);
    expect(result.init.initDurationMs).toBeGreaterThan(0);
  }, 15000);

  it('tools execute through extension engine (not daemon fallback)', async () => {
    // First open a tab so we have something to evaluate on
    const tab = await callTool(client, 'safari_new_tab', { url: 'https://example.com' }, nextId++);
    expect(tab.tabUrl).toContain('example.com');

    // Evaluate JS — should route through extension engine
    const raw = await rawCallTool(
      client, 'safari_evaluate',
      { tabUrl: tab.tabUrl, script: 'return document.title' },
      nextId++,
      15000,
    );
    expect(raw.meta?.engine).toBe('extension');
  }, 30000);

  it('pre-call gate detects and reports system status', async () => {
    // Just calling a tool proves the gate runs (it checks /status before executing).
    // If we get a result, the gate passed.
    const result = await callTool(client, 'safari_list_tabs', {}, nextId++);
    expect(Array.isArray(result) || typeof result === 'object').toBe(true);
  }, 10000);
});
```

- [ ] **Step 2: Run the test against real Safari**

Run: `npx vitest run test/e2e/initialization.test.ts --reporter=verbose`
Expected: All 4 tests pass. Safari window opens. Extension connects. Tools execute through extension engine.

- [ ] **Step 3: If any test fails, use upp:systematic-debugging to diagnose**

Do NOT ad-hoc fix. Follow the debugging skill phases. Read the error, reproduce, trace data flow, form hypothesis, test minimally.

- [ ] **Step 4: Commit the passing test**

```bash
git add test/e2e/initialization.test.ts
git commit -m "test(e2e): prove initialization system works against real Safari"
```

---

### Task 10: Close tab and verify no orphan windows

**Files:**
- None (manual verification)

- [ ] **Step 1: Verify the test from Task 9 left a session window open**

Check Safari — there should be a window with the session dashboard showing the session ID and "Connected" status for both Extension and Claude Code.

- [ ] **Step 2: Verify the session tab shows the correct session ID**

The dashboard should display the session ID that matches what `safari_health_check` returned.

- [ ] **Step 3: Close the test client**

The `afterAll` in the test already calls `client.close()`. Verify the MCP process exited cleanly.

- [ ] **Step 4: Document result**

Update `docs/ROADMAP.md` — add a "Shipped" section at the top if it doesn't exist. Add:

```markdown
## Shipped

| # | Capability | Date | Proof |
|---|---|---|---|
| 0.1 | Initialization system — session window, all-green gate, pre-call health check, recovery | 2026-04-23 | test/e2e/initialization.test.ts passes against real Safari |
```

- [ ] **Step 5: Commit**

```bash
git add docs/ROADMAP.md
git commit -m "docs: mark initialization system as shipped with e2e proof"
```
