# Persistent Session Tab — Design Spec

**Date:** 2026-04-21
**Status:** Approved

---

## 1. Problem Statement

The Safari extension event page dies after ~30s of inactivity due to Safari's MV3 lifecycle enforcement. The 1-minute alarm keepalive creates ~15s dead windows every cycle where the extension is unreachable and commands queue. This causes:

- `ExtensionEngine.isAvailable()` returning false during the dead window
- Engine selector falling back to daemon for tools that would benefit from extension
- The `_meta` tab identity system (tab-ownership-by-identity) never receiving data
- Unpredictable tool call latency (0-15s depending on where in the alarm cycle the call lands)

## 2. Solution

A **persistent session tab** opened by the MCP server on first tool call. The tab loads a daemon-served page (`http://127.0.0.1:19475/session`) whose content script pings `runtime.sendMessage` every 20s, keeping the extension background alive indefinitely. The daemon serves a live dashboard on this page showing connection state.

The MCP server handles the full bootstrap: check extension connectivity → open session tab if needed → wait for connection → proceed or fallback.

## 3. Architecture

### Bootstrap Flow (server.ts)

```
Tool call arrives at executeToolWithSecurity()
  → Engine selection picks 'extension'
  → ensureExtensionReady()
    → GET http://127.0.0.1:19475/status (fast check, <1ms)
    → Response: {ext: bool, mcp: bool, sessionTab: bool, lastPingAge: ms}
    → If ext == true: proceed immediately
    → If ext == false:
      → If sessionTab == false: open session tab via AppleScript
        osascript: tell Safari to make new document with URL "http://127.0.0.1:19475/session"
      → Poll /status every 1s, up to 10s
      → If ext becomes true within 10s: proceed with extension engine
      → If not: fall back to daemon engine for this call (set degraded flag)
        Next call will retry (session tab now exists, extension should wake)
```

### Daemon HTTP Routes (ExtensionHTTPServer, Hummingbird on :19475)

Two new routes on the existing HTTP server:

**`GET /session`** — Serves the session page HTML. Sets `sessionTabActive = true` in HealthStore.

**`GET /status`** — Fast connectivity check for the MCP server bootstrap. Returns:
```json
{
  "ext": true,
  "mcp": true,
  "sessionTab": true,
  "lastPingAge": 3200
}
```
- `ext` — extension isConnected right now
- `mcp` — at least one MCP server TCP connection alive
- `sessionTab` — `/session` has been served and daemon received a keepalive ping within 60s
- `lastPingAge` — ms since last keepalive ping was received (forwarded via extension_log)

**`GET /health`** — Existing endpoint, extended with `mcpConnected` and `sessionTabActive` fields for the dashboard page to poll.

### Session Page (served by daemon)

HTML page with:
- Header: "Safari Pilot — Active Session"
- Status indicators (polled every 5s via `fetch('/health')`):
  - Extension connected: green/red indicator
  - MCP server connected: green/red indicator (daemon knows if TCP client is alive)
  - Last command: timestamp
  - Active agent tabs: count
- Footer: "Do not close this tab while Safari Pilot is running."
- On MCP disconnect: shows "Disconnected from Claude Code" prominently

The page's content script handles keepalive (see below). The page's own JS handles the dashboard display.

### Content Script Keepalive (content-isolated.js)

```javascript
if (location.href.startsWith('http://127.0.0.1:19475/session')) {
  setInterval(() => {
    browser.runtime.sendMessage({ type: 'keepalive' }).catch(() => {});
  }, 20000);
  browser.runtime.sendMessage({ type: 'keepalive' }).catch(() => {});
}
```

This runs ONLY on the session page URL. Every 20s, `runtime.sendMessage` resets Safari's 30s kill timer on the extension background.

### Background.js Keepalive Handler

```javascript
if (message?.type === 'keepalive') {
  emitTrace('session', 'keepalive_received', {});
  // Forward to daemon so /status can report lastPingAge
  httpPost('/result', {
    requestId: '__keepalive__',
    result: { type: 'keepalive', ts: Date.now() }
  }).catch(() => {});
  sendResponse({ ok: true });
  return false;
}
```

Daemon's handleResult detects `requestId === '__keepalive__'` and updates `lastKeepalivePing` timestamp in HealthStore.

### Session Tab Visibility

The session tab is **visible** to the agent in `safari_list_tabs` with a marker:
```json
{"tabId": 1001, "url": "http://127.0.0.1:19475/session", "title": "Safari Pilot — Active Session", "type": "session"}
```

This gives the agent a fast signal that the extension pipeline is likely active. The definitive check remains `GET /status` via the daemon.

`safari_close_tab` works on the session tab (no protection). If closed, `ensureExtensionReady()` reopens it on the next tool call (self-healing).

### Multi-Session Handling

The daemon tracks whether a session tab exists (`sessionTabActive` flag, set when `/session` is served, cleared after 60s with no keepalive). If a second MCP server calls `ensureExtensionReady()` and the daemon reports `sessionTab: true`, it skips opening a new tab — the existing one serves both sessions.

### Alarm (Backup)

The 1-minute alarm (`browser.alarms`) is kept as-is. It serves as a backup for the edge case where all tabs are closed (no content script running). The alarm ensures the extension reconnects within 60s even without the session tab. Not the primary mechanism — just belt-and-suspenders.

## 4. Telemetry

### New Trace Points

**Server (trace.ndjson):**
| Event | Data | Level |
|-------|------|-------|
| `extension_bootstrap_start` | `{alreadyConnected: bool}` | event |
| `extension_bootstrap_result` | `{outcome: 'already_connected' \| 'tab_opened_connected' \| 'timeout_fallback', waitMs: number}` | event |

**Daemon (daemon-trace.ndjson):**
| Event | Data | Level |
|-------|------|-------|
| `session_page_served` | `{firstServe: bool}` | event |
| `status_check` | `{ext: bool, mcp: bool, sessionTab: bool}` | event |
| `keepalive_ping` | `{ageMs: number}` | event |

**Extension (via __trace__ → daemon-trace.ndjson):**
| Event | Data | Level |
|-------|------|-------|
| `keepalive_received` | `{}` | event |

### Existing Telemetry

The `alarm_fire` log message that was missing from background.js should also be added — emit `extension_log` with "alarm_fire" prefix when the alarm handler fires. This updates `lastAlarmFireTimestamp` in HealthStore (fixing the stale telemetry we discovered).

## 5. Files Changed

| File | Change |
|------|--------|
| `src/server.ts` | Add `ensureExtensionReady()` method, call before extension-engine dispatch |
| `src/engines/daemon.ts` | Add `checkStatus()` method (GET /status via HTTP, not TCP) |
| `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` | Add `/session` and `/status` routes |
| `daemon/Sources/SafariPilotdCore/HealthStore.swift` | Add `sessionTabActive`, `lastKeepalivePing`, `mcpConnected` fields |
| `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` | Handle `__keepalive__` sentinel in handleResult |
| `extension/content-isolated.js` | Add keepalive ping block for session page URL |
| `extension/background.js` | Add `keepalive` message handler + `alarm_fire` log |

## 6. Scope Boundaries

**In scope:**
- Server-side `ensureExtensionReady()` bootstrap with 10s bounded wait
- Daemon `/session` route serving live dashboard page
- Daemon `/status` fast-check route
- Content script keepalive for session page
- Background.js keepalive handler + alarm_fire telemetry fix
- Telemetry for all new flow points
- Self-healing (auto-reopen on tab close)
- Multi-session shared tab

**Out of scope:**
- Removing the alarm (kept as backup)
- Rich dashboard features beyond basic status (command history, log streaming — future spec)
- Private window support for session tab
- Session tab in iOS Safari

## 7. Known Limitations

1. **First tool call latency:** If extension is cold (no session tab, alarm hasn't fired), first tool call incurs up to 10s bootstrap wait. Subsequent calls are immediate.
2. **Daemon must be running:** The session page and /status endpoint require the daemon HTTP server. If daemon is down, bootstrap fails and falls back to... nothing (daemon IS the fallback engine, so if daemon is down, everything fails).
3. **Single daemon instance:** Multi-session works because both MCP servers talk to the same daemon. If somehow two daemons run, behavior is undefined.
4. **Content script on localhost:** The extension's `content_scripts` matches `<all_urls>` which includes `http://127.0.0.1:*`. If Safari restricts content script injection on localhost in a future update, the keepalive breaks. Alarm backup covers this.
