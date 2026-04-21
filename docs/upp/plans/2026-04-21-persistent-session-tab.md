# Persistent Session Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the 15s extension dead window by opening a persistent session tab with a keepalive ping, bootstrapped automatically by the MCP server.

**Architecture:** MCP server checks daemon `/status` before extension dispatch. If disconnected, opens a session tab (daemon-served dashboard at `http://127.0.0.1:19475/session`). Content script on that page pings `runtime.sendMessage` every 20s, keeping extension alive. Alarm stays as backup.

**Tech Stack:** TypeScript (server), Swift/Hummingbird (daemon HTTP), JavaScript (extension content script + background handler)

**Branch:** `feat/persistent-session-tab` (from `feat/telemetry`)

---

## Task 0: Branch + Baseline

- [ ] **Step 1: Create branch and verify**

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git checkout -b feat/persistent-session-tab feat/telemetry
npm run build
npm run test:unit
```

Expected: build clean, 1470+ tests pass.

### Commit
No commit — baseline only.

---

## Task 1: Add HealthStore fields + `/status` route to daemon

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/HealthStore.swift`
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift`
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`

- [ ] **Step 1: Add HealthStore fields**

In `HealthStore.swift`, add three new fields:

```swift
// In-memory: tracks session tab and MCP connection
private var _sessionTabActive: Bool = false
public var sessionTabActive: Bool { queue.sync { _sessionTabActive } }

private var _lastKeepalivePing: Date? = nil
public var lastKeepalivePing: Date? { queue.sync { _lastKeepalivePing } }

private var _mcpConnected: Bool = false
public var mcpConnected: Bool { queue.sync { _mcpConnected } }
```

Add public setters:

```swift
public func recordSessionServed() {
    queue.sync { _sessionTabActive = true }
}

public func recordKeepalivePing() {
    queue.sync { _lastKeepalivePing = Date() }
}

public func setMcpConnected(_ connected: Bool) {
    queue.sync { _mcpConnected = connected }
}

/// Returns false if no keepalive received within the given timeout
public func isSessionAlive(timeout: TimeInterval = 60) -> Bool {
    queue.sync {
        guard _sessionTabActive, let last = _lastKeepalivePing else { return false }
        return Date().timeIntervalSince(last) < timeout
    }
}
```

- [ ] **Step 2: Add `GET /status` route to ExtensionHTTPServer**

In `buildRouter()`, add after the existing `router.post("result")` block:

```swift
router.get("status") { [self] _, _ -> HBResponse in
    let ext = self.bridge.isConnected
    let mcp = self.healthStore.mcpConnected
    let sessionTab = self.healthStore.isSessionAlive()
    let lastPingAge: Int
    if let ping = self.healthStore.lastKeepalivePing {
        lastPingAge = Int(Date().timeIntervalSince(ping) * 1000)
    } else {
        lastPingAge = -1
    }
    
    Trace.emit("status", layer: "daemon-bridge", event: "status_check", data: [
        "ext": ext, "mcp": mcp, "sessionTab": sessionTab
    ])
    
    let json: [String: Any] = [
        "ext": ext,
        "mcp": mcp,
        "sessionTab": sessionTab,
        "lastPingAge": lastPingAge
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: json) else {
        return HBResponse(status: .internalServerError)
    }
    return HBResponse(
        status: .ok,
        headers: [.contentType: "application/json"],
        body: .init(byteBuffer: ByteBuffer(data: data))
    )
}
```

- [ ] **Step 3: Add `__keepalive__` sentinel to ExtensionBridge handleResult**

In `ExtensionBridge.swift`, in the handleResult method (where `__trace__` sentinel was added), add BEFORE the `__trace__` check:

```swift
// Handle keepalive pings from session tab content script
if let requestId = params["requestId"]?.value as? String, requestId == "__keepalive__" {
    healthStore.recordKeepalivePing()
    return Response.success(id: commandID, value: AnyCodable("ok"))
}
```

- [ ] **Step 4: Verify daemon builds**

```bash
cd daemon && swift build 2>&1 | tail -3
```

Expected: "Build complete!" with no errors.

- [ ] **Step 5: Commit**

```
feat(daemon): add /status route + keepalive tracking in HealthStore

GET /status returns {ext, mcp, sessionTab, lastPingAge} for fast MCP
server bootstrap checks. __keepalive__ sentinel updates lastKeepalivePing.
HealthStore gains sessionTabActive, lastKeepalivePing, mcpConnected fields.
```

---

## Task 2: Add `/session` dashboard page route to daemon

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift`

- [ ] **Step 1: Add `GET /session` route**

In `buildRouter()`, add after the `/status` route:

```swift
router.get("session") { [self] _, _ -> HBResponse in
    self.healthStore.recordSessionServed()
    Trace.emit("session", layer: "daemon-bridge", event: "session_page_served", data: [:])
    
    let html = Self.sessionPageHTML
    return HBResponse(
        status: .ok,
        headers: [.contentType: "text/html; charset=utf-8"],
        body: .init(byteBuffer: ByteBuffer(string: html))
    )
}
```

- [ ] **Step 2: Add the static HTML property**

Add as a static property on `ExtensionHTTPServer`:

```swift
private static let sessionPageHTML: String = """
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Safari Pilot — Active Session</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a1a; color: #e0e0e0; padding: 40px; min-height: 100vh; }
  .container { max-width: 480px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
  .subtitle { color: #888; font-size: 13px; margin-bottom: 32px; }
  .status-grid { display: grid; gap: 12px; }
  .status-row { display: flex; align-items: center; justify-content: space-between; background: #242424; padding: 12px 16px; border-radius: 8px; }
  .status-label { font-size: 13px; color: #aaa; }
  .status-value { font-size: 13px; font-weight: 500; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 8px; }
  .dot-green { background: #22c55e; }
  .dot-red { background: #ef4444; }
  .dot-gray { background: #555; }
  .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #333; color: #666; font-size: 12px; }
</style>
</head>
<body>
<div class="container">
  <h1>Safari Pilot — Active Session</h1>
  <p class="subtitle">This tab keeps Safari Pilot connected. Do not close it while automation is running.</p>
  <div class="status-grid">
    <div class="status-row">
      <span class="status-label">Extension</span>
      <span class="status-value" id="ext"><span class="dot dot-gray"></span>Checking...</span>
    </div>
    <div class="status-row">
      <span class="status-label">Claude Code</span>
      <span class="status-value" id="mcp"><span class="dot dot-gray"></span>Checking...</span>
    </div>
    <div class="status-row">
      <span class="status-label">Last Command</span>
      <span class="status-value" id="cmd">—</span>
    </div>
    <div class="status-row">
      <span class="status-label">Uptime</span>
      <span class="status-value" id="uptime">—</span>
    </div>
  </div>
  <div class="footer">Closing this tab may interrupt Safari Pilot automation.</div>
</div>
<script>
const start = Date.now();
function dot(ok) { return '<span class="dot dot-' + (ok ? 'green' : 'red') + '"></span>'; }
function update() {
  fetch('/health').then(r => r.json()).then(d => {
    document.getElementById('ext').innerHTML = dot(d.isConnected) + (d.isConnected ? 'Connected' : 'Disconnected');
    document.getElementById('mcp').innerHTML = dot(d.mcpConnected) + (d.mcpConnected ? 'Connected' : 'Disconnected');
    const lastCmd = d.lastExecutedResultTimestamp;
    document.getElementById('cmd').textContent = lastCmd ? new Date(lastCmd).toLocaleTimeString() : '—';
    const secs = Math.floor((Date.now() - start) / 1000);
    const m = Math.floor(secs / 60); const s = secs % 60;
    document.getElementById('uptime').textContent = m + 'm ' + s + 's';
  }).catch(() => {
    document.getElementById('ext').innerHTML = dot(false) + 'Error';
    document.getElementById('mcp').innerHTML = dot(false) + 'Error';
  });
}
update();
setInterval(update, 5000);
</script>
</body>
</html>
"""
```

- [ ] **Step 3: Extend `/health` response with mcpConnected**

In the health endpoint handler (in `ExtensionBridge.swift` where the health snapshot is built), add `mcpConnected` to the response dict:

```swift
"mcpConnected": store.mcpConnected,
```

- [ ] **Step 4: Verify daemon builds**

```bash
cd daemon && swift build 2>&1 | tail -3
```

- [ ] **Step 5: Commit**

```
feat(daemon): add /session dashboard page with live status polling

Serves HTML at GET /session showing extension + MCP connection state,
last command timestamp, and uptime. Polls /health every 5s for updates.
Dark theme, minimal, user-facing "do not close" message.
```

---

## Task 3: Add MCP connection tracking in daemon

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` or `CommandDispatcher.swift`

The daemon needs to know if an MCP server is connected. The MCP server connects via TCP:19474 (when `useTcp=true`). The `ExtensionSocketServer` handles these connections.

- [ ] **Step 1: Track active TCP connections**

In the TCP socket server code (wherever TCP connections are accepted on port 19474), set `healthStore.setMcpConnected(true)` when a connection opens and `healthStore.setMcpConnected(false)` when it closes.

If the TCP server doesn't have connection lifecycle hooks easily accessible, a simpler approach: the daemon receives commands via TCP regularly (every tool call). Use a heartbeat — if any TCP command has been received in the last 30s, consider MCP connected:

Add to HealthStore:
```swift
private var _lastTcpCommandTimestamp: Date? = nil

public func recordTcpCommand() {
    queue.sync { _lastTcpCommandTimestamp = Date(); _mcpConnected = true }
}

// Called by disconnect checker
public func checkMcpConnection(timeout: TimeInterval = 30) {
    queue.sync {
        if let last = _lastTcpCommandTimestamp, Date().timeIntervalSince(last) > timeout {
            _mcpConnected = false
        }
    }
}
```

In `CommandDispatcher.swift`, at the top of the TCP command handler (where commands arrive via TCP), add:
```swift
healthStore.recordTcpCommand()
```

In the disconnect-detection background task (ExtensionHTTPServer), add:
```swift
self.healthStore.checkMcpConnection()
```

- [ ] **Step 2: Verify daemon builds**

```bash
cd daemon && swift build 2>&1 | tail -3
```

- [ ] **Step 3: Commit**

```
feat(daemon): track MCP server connection via TCP command heartbeat

healthStore.mcpConnected reflects whether any MCP server has sent a TCP
command in the last 30s. Session page uses this to show connection state.
```

---

## Task 4: Rebuild daemon

- [ ] **Step 1: Rebuild and restart**

```bash
bash scripts/update-daemon.sh
```

- [ ] **Step 2: Verify /status and /session endpoints**

```bash
curl -s http://127.0.0.1:19475/status | python3 -m json.tool
curl -s http://127.0.0.1:19475/session | head -5
```

Expected: /status returns JSON with ext/mcp/sessionTab/lastPingAge fields. /session returns HTML.

### Commit
No commit — binary is gitignored.

---

## Task 5: Add content script keepalive + background handler

**Files:**
- Modify: `extension/content-isolated.js`
- Modify: `extension/background.js`

- [ ] **Step 1: Add keepalive ping to content-isolated.js**

At the END of `extension/content-isolated.js` (after all existing code), add:

```javascript
// ── Session tab keepalive ──────────────────────────────────────────────────
// When on the daemon's session page, ping the background every 20s to prevent
// Safari from killing the event page. This keeps the extension alive for the
// entire duration of the agent session.
if (location.href.startsWith('http://127.0.0.1:19475/session')) {
  browser.runtime.sendMessage({ type: 'keepalive' }).catch(() => {});
  setInterval(() => {
    browser.runtime.sendMessage({ type: 'keepalive' }).catch(() => {});
  }, 20000);
}
```

- [ ] **Step 2: Add keepalive handler + alarm_fire to background.js**

In background.js, in the `browser.runtime.onMessage.addListener` block (where `sp_getTabId`, `ping`, etc. are handled), add before the final `return false`:

```javascript
    if (message?.type === 'keepalive') {
      emitTrace('session', 'keepalive_received', {});
      httpPost('/result', {
        requestId: '__keepalive__',
        result: { type: 'keepalive', ts: Date.now() }
      }).catch(() => {});
      sendResponse({ ok: true });
      return false;
    }
```

Also add `alarm_fire` logging in the alarm handler. Find the `browser.alarms.onAlarm.addListener` block and add before `initialize('keepalive')`:

```javascript
    // Report alarm fire to daemon for health telemetry
    httpPost('/result', {
      requestId: '__trace__',
      result: { type: 'trace', id: 'alarm', layer: 'extension-bg', event: 'alarm_fire', data: {} }
    }).catch(() => {});
```

- [ ] **Step 3: Commit**

```
feat(extension): add session tab keepalive + alarm_fire telemetry

content-isolated.js pings runtime.sendMessage every 20s on the session
page URL. background.js handles keepalive (forwards to daemon as
__keepalive__ sentinel). Alarm fire now reported via __trace__ for
health telemetry visibility.
```

---

## Task 6: Add `ensureExtensionReady()` to server.ts

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Add HTTP status check method**

Add a private method to `SafariPilotServer`:

```typescript
  /**
   * Fast connectivity check via daemon's /status HTTP endpoint.
   * Bypasses the NDJSON command channel — direct HTTP for <1ms response.
   */
  private async checkExtensionStatus(): Promise<{ ext: boolean; mcp: boolean; sessionTab: boolean; lastPingAge: number }> {
    try {
      const resp = await fetch('http://127.0.0.1:19475/status', { signal: AbortSignal.timeout(2000) });
      if (!resp.ok) return { ext: false, mcp: false, sessionTab: false, lastPingAge: -1 };
      return await resp.json();
    } catch {
      return { ext: false, mcp: false, sessionTab: false, lastPingAge: -1 };
    }
  }
```

- [ ] **Step 2: Add `ensureExtensionReady()` method**

```typescript
  private sessionTabUrl = 'http://127.0.0.1:19475/session';
  private _sessionTabOpened = false;

  /**
   * Ensure the extension is connected before dispatching an extension-engine call.
   * Opens the session tab if needed and waits up to 10s for connection.
   * Returns true if extension is ready, false if caller should fall back to daemon.
   */
  private async ensureExtensionReady(traceId: string): Promise<boolean> {
    trace(traceId, 'server', 'extension_bootstrap_start', { alreadyConnected: false });

    const status = await this.checkExtensionStatus();
    if (status.ext) {
      trace(traceId, 'server', 'extension_bootstrap_result', { outcome: 'already_connected', waitMs: 0 });
      return true;
    }

    // Open session tab if not already open
    if (!status.sessionTab && !this._sessionTabOpened) {
      try {
        const { execSync } = await import('node:child_process');
        execSync(`osascript -e 'tell application "Safari" to make new document with properties {URL:"${this.sessionTabUrl}"}'`, { timeout: 5000 });
        this._sessionTabOpened = true;
      } catch { /* AppleScript failed — proceed with wait anyway */ }
    }

    // Poll /status every 1s for up to 10s
    const start = Date.now();
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const check = await this.checkExtensionStatus();
      if (check.ext) {
        trace(traceId, 'server', 'extension_bootstrap_result', {
          outcome: 'tab_opened_connected',
          waitMs: Date.now() - start,
        });
        return true;
      }
    }

    trace(traceId, 'server', 'extension_bootstrap_result', {
      outcome: 'timeout_fallback',
      waitMs: Date.now() - start,
    }, 'error');
    return false;
  }
```

- [ ] **Step 3: Wire `ensureExtensionReady()` into `executeToolWithSecurity()`**

After engine selection resolves to `'extension'` (after the `engine_selected` trace point), and BEFORE the ownership check (step 7d), insert:

```typescript
    // 7a.5: Ensure extension is ready (opens session tab if needed)
    if (selectedEngineName === 'extension') {
      const ready = await this.ensureExtensionReady(traceId);
      if (!ready) {
        // Fall back to daemon for this call
        selectedEngineName = 'daemon';
        const fallbackEngine = this.engines.get('daemon') || this._engine!;
        this.engineProxy?.setDelegate(fallbackEngine);
        trace(traceId, 'server', 'engine_selected', { engine: 'daemon', degraded: true });
      }
    }
```

- [ ] **Step 4: Verify build + tests**

```bash
npm run build
npm run lint
npm run test:unit
```

All must pass.

- [ ] **Step 5: Commit**

```
feat(server): add ensureExtensionReady() bootstrap with session tab

Checks daemon /status before extension dispatch. If extension not
connected, opens session tab via AppleScript and polls for up to 10s.
Falls back to daemon engine on timeout. Self-healing: reopens tab if
closed by user.
```

---

## Task 7: Bump version + rebuild extension

- [ ] **Step 1: Bump version**

```bash
npm version patch --no-git-tag-version
```

This bumps to 0.1.9. The build script syncs manifest.json automatically.

- [ ] **Step 2: Rebuild extension**

```bash
bash scripts/build-extension.sh
```

Expected: "Build Complete: v0.1.9"

- [ ] **Step 3: Install and verify**

```bash
open "bin/Safari Pilot.app"
codesign -d --entitlements - "bin/Safari Pilot.app" 2>&1 | grep -c "app-sandbox"
```

Must show `1`.

- [ ] **Step 4: Commit**

```
feat(extension): rebuild v0.1.9 with session tab keepalive

Includes content-isolated.js keepalive ping for session page URL,
background.js keepalive handler, and alarm_fire telemetry.
```

---

## Task 8: End-to-end verification

- [ ] **Step 1: Clear trace files and verify the full flow**

```bash
> ~/.safari-pilot/trace.ndjson
> ~/.safari-pilot/daemon-trace.ndjson

# Restart Safari (user must do this for new extension to load)
# Then run e2e handshake test which will trigger the bootstrap
SAFARI_PILOT_E2E=1 npx vitest run test/e2e/mcp-handshake.test.ts
```

- [ ] **Step 2: Check trace files for bootstrap events**

```bash
grep "extension_bootstrap" ~/.safari-pilot/trace.ndjson
grep "keepalive" ~/.safari-pilot/daemon-trace.ndjson
grep "session_page_served" ~/.safari-pilot/daemon-trace.ndjson
curl -s http://127.0.0.1:19475/status | python3 -m json.tool
```

Expected:
- `extension_bootstrap_start` and `extension_bootstrap_result` in trace.ndjson
- `keepalive_ping` events in daemon-trace.ndjson (after session tab opens)
- /status shows `ext: true, sessionTab: true`

- [ ] **Step 3: Verify extension stays alive continuously**

```bash
# Monitor for 2 minutes — should show UP continuously (no dead windows)
for i in $(seq 1 24); do sleep 5; echo '{"id":"m","method":"extension_health","params":{}}' | nc -w 2 localhost 19474 2>/dev/null | python3 -c "import sys,json; d=json.loads(sys.stdin.read())['value']; print('UP' if d['isConnected'] else 'DOWN')" 2>/dev/null; done
```

Expected: All 24 checks show "UP" (no dead windows).

- [ ] **Step 4: Verify self-healing — close session tab manually, then run a tool call**

The next e2e test should trigger `ensureExtensionReady()` which reopens the session tab.

- [ ] **Step 5: Run full unit suite**

```bash
npm run build && npm run lint && npm run test:unit
```

### Commit
No commit — verification only.

---

## Task 9: Update canonical documentation

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `TRACES.md`
- Modify: `docs/EXECUTION-FLOWS.md`

- [ ] **Step 1: Update ARCHITECTURE.md**

Add a new section "Session Tab & Extension Keepalive" documenting:
- Bootstrap flow (ensureExtensionReady)
- /status and /session endpoints
- Content script keepalive mechanism
- Self-healing behavior
- Alarm as backup

Update the "Extension IPC" section to mention the session page.

- [ ] **Step 2: Update TRACES.md**

Add iteration entry documenting this feature.

- [ ] **Step 3: Update docs/EXECUTION-FLOWS.md**

Add the bootstrap step to the Class 1 (extension-engine) flow diagram — it now has an `ensureExtensionReady()` step before dispatch. Add the new telemetry points (extension_bootstrap_start, extension_bootstrap_result, session_page_served, keepalive_ping, keepalive_received).

- [ ] **Step 4: Commit**

```
docs: update ARCHITECTURE.md, TRACES.md, EXECUTION-FLOWS.md for session tab

Document persistent session tab architecture: bootstrap flow, /status
+ /session endpoints, keepalive mechanism, self-healing, telemetry points.
```

---

## Summary of Files Changed

| File | Change |
|------|--------|
| `daemon/Sources/SafariPilotdCore/HealthStore.swift` | +sessionTabActive, lastKeepalivePing, mcpConnected, recordTcpCommand, checkMcpConnection |
| `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` | +GET /status, +GET /session (dashboard HTML) |
| `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` | +__keepalive__ sentinel handler |
| `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` | +recordTcpCommand() call |
| `extension/content-isolated.js` | +keepalive ping for session page URL |
| `extension/background.js` | +keepalive message handler, +alarm_fire trace |
| `src/server.ts` | +ensureExtensionReady(), +checkExtensionStatus(), bootstrap wiring |
| `ARCHITECTURE.md` | +Session tab section |
| `TRACES.md` | +Iteration entry |
| `docs/EXECUTION-FLOWS.md` | +Bootstrap step in Class 1 flow, +new telemetry points |
