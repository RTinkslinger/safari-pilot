# Safari Pilot — Initialization System Design

**Date:** 2026-04-22
**Status:** Draft
**Scope:** MCP initialize → session window → all-green gate → pre-call health check → transparent recovery → multi-session detection

---

## Problem

Safari Pilot has no initialization handshake. The MCP server starts, checks engine availability once (stale forever), and hopes for the best. The session window opens on the first tool call — too late. The extension engine was dead code for the entire project history because the bootstrap never ran at the right time. There is no live health check before tool calls, no recovery when components disconnect mid-session, and no awareness of other sessions.

The agent has no confidence that Safari Pilot is ready before sending commands.

## Solution

A four-part initialization system:

1. **Startup init** — MCP `initialize` blocks until all systems are green (daemon, extension, session window)
2. **Pre-call gate** — every tool call does a live `/status` check before executing
3. **Transparent recovery** — if the gate finds a component down, recover silently (up to 10s) or fail explicitly
4. **Multi-session awareness** — detect existing sessions, report count, isolate in separate windows

---

## 1. Initialization on MCP `initialize`

### Current behavior

`initialize()` in `server.ts` checks daemon and extension availability once, caches the result in `engineAvailability`, and returns. Session window opens on the first tool call via `ensureSessionWindow()`.

### New behavior

`initialize()` performs the full startup sequence and blocks until all systems are confirmed connected:

```
initialize() {
  1. Start daemon engine (existing — TCP probe or spawn)
  2. Register this session with daemon (POST /session/register)
  3. Query existing sessions from daemon (GET /status → existingSessions count)
  4. Open session window (AppleScript → new Safari window with session dashboard URL)
  5. Poll GET /status every 1s until ext: true (max 15s)
  6. Set engineAvailability based on live result
  7. Return MCP initialize response with session metadata
}
```

### MCP initialize response (extended)

The standard MCP response includes `serverInfo` and `capabilities`. We add session metadata to the result:

```json
{
  "protocolVersion": "2024-11-05",
  "serverInfo": { "name": "safari-pilot", "version": "0.1.11" },
  "capabilities": { "tools": {} },
  "_meta": {
    "sessionId": "sess_abc123",
    "windowId": 42,
    "existingSessions": 1,
    "systems": {
      "daemon": true,
      "extension": true,
      "sessionTab": true
    },
    "initDurationMs": 3200
  }
}
```

### Extension connection timing

The extension connects when the session tab loads and the content script sends a keepalive ping. This typically takes 2-5s but can take up to 15s if the extension's alarm hasn't fired yet.

The init loop polls `/status` every 1s. Progress is visible on the session dashboard page in Safari (the user can see "Extension: Connecting..." turn to "Extension: Connected").

If extension doesn't connect within 15s:
- `initialize()` still succeeds (daemon engine is a valid fallback)
- `_meta.systems.extension` is `false`
- Tools will work through daemon/AppleScript — no hard failure
- If extension connects later, the pre-call gate (Section 2) will detect it

### Session dashboard update

The session page at `127.0.0.1:19475/session` adds the session ID:
- Shows: "Session: sess_abc123"
- Existing fields: Extension status, MCP status, Last Command, Uptime

---

## 2. Pre-call live health gate

### Where it runs

At the top of `executeToolWithSecurity()`, before any security checks or engine selection.

### What it checks

Single HTTP GET to `127.0.0.1:19475/status` (timeout 2s):

```json
{ "ext": true, "mcp": true, "sessionTab": true, "lastPingAge": 1254 }
```

Plus a fast AppleScript check that the session window still exists:
```applescript
tell application "Safari" to return (exists window id 42)
```

### Decision matrix

| `/status` ext | Window exists | Action |
|---|---|---|
| true | true | Proceed — all green |
| true | false | Recovery: open new window (Section 3) |
| false | true | Recovery: wait for extension reconnect (Section 3) |
| false | false | Recovery: open window + wait for extension (Section 3) |
| /status unreachable | any | Recovery: restart daemon + open window (Section 3) |

### Performance

- HTTP GET to localhost: ~5-15ms
- AppleScript window exists check: ~10-30ms
- Total overhead per tool call: ~15-45ms
- Acceptable: tool execution itself takes 50-500ms+ depending on engine

### Replacing engineAvailability cache

The current `this.engineAvailability` field becomes a live-read value derived from the pre-call gate, not a startup-cached value. `setEngineAvailability()` is called with fresh data on every tool call.

---

## 3. Transparent recovery with 10s timeout

### Trigger

Pre-call gate (Section 2) finds any component down.

### Recovery procedure

```
recovery(traceId) {
  1. Record what's down (window? extension? daemon?)
  2. If window gone:
     - Open new session window (AppleScript)
     - Capture new _sessionWindowId
  3. If daemon unreachable:
     - Attempt daemon restart (ensureRunning)
  4. Poll GET /status every 1s for up to 10s
  5. If all green:
     - Update engineAvailability
     - Log recovery event (traceId, duration, what recovered)
     - Return success — tool call proceeds
     - Include _meta.recovered: true in tool response metadata
  6. If still down after 10s:
     - Throw SessionRecoveryError with details
     - Error includes: which components are down, recovery duration, suggestion
}
```

### SessionRecoveryError

New error type in `errors.ts`:

```typescript
class SessionRecoveryError extends SafariPilotError {
  code = 'SESSION_RECOVERY_FAILED';
  retryable = true;
  hints = ['Check Safari is running', 'Check extension is enabled in Safari > Settings > Extensions'];
}
```

### Agent experience

- **Fast recovery (1-3s):** Agent sees slightly slower tool call. Response metadata notes `recovered: true`. Agent doesn't need to do anything.
- **Slow recovery (3-10s):** Agent sees a slow tool call. Same metadata.
- **Failed recovery (>10s):** Agent gets `SESSION_RECOVERY_FAILED` error with actionable hints. Agent can tell the user or retry.

---

## 4. Multi-session detection

### Daemon-side session registry

HealthStore gets a new field: `activeSessions: Array<{ sessionId: string; registeredAt: Date }>`.

New HTTP routes on the daemon:
- `POST /session/register` — body: `{ sessionId: string }`. Adds to active list.
- `GET /status` — extended response includes `activeSessions: number` (count only, not IDs).

Sessions are pruned if no tool call has been made through the daemon in 60s (stale session detection). The daemon doesn't need to actively track heartbeats — the pre-call `/status` check from Section 2 serves as an implicit heartbeat.

### MCP server behavior on init

```
1. POST /session/register { sessionId: "sess_abc123" }
2. GET /status → { ..., activeSessions: 2 }
3. Log: "Safari Pilot session sess_abc123 initialized (1 other session active)"
4. Open NEW window (never reuse another session's window)
5. Include existingSessions: 1 in initialize response _meta
```

### No cross-session interference

Each session has:
- Its own `_sessionWindowId` (separate Safari window)
- Its own tab ownership registry (in-process, not shared)
- Its own engine proxy and security pipeline state

Sessions share:
- The daemon process (LaunchAgent singleton)
- The extension (one extension instance in Safari)
- The ExtensionBridge command queue (serialized)

The shared command queue is a known architectural limitation (documented in roadmap). It means two sessions' extension commands are serialized, not parallel. This is acceptable for v1 — true parallelism would require per-session command routing in the bridge.

---

## Files to modify

| File | Change |
|---|---|
| `src/server.ts` | Move session window + extension bootstrap into `initialize()`. Add pre-call gate. Add recovery. Remove stale `engineAvailability` cache. |
| `src/errors.ts` | Add `SessionRecoveryError`. |
| `daemon/Sources/SafariPilotdCore/HealthStore.swift` | Add `activeSessions` array, `registerSession()`, `pruneStale()`. |
| `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` | Add `POST /session/register` route. Extend `GET /status` response. |
| `extension/background.js` | No changes needed. |

## Out of scope (v1)

- Graceful shutdown (close window on session end)
- Per-session command routing in ExtensionBridge
- MCP notifications for progress streaming
- Dashboard tool counters or activity feed

---

## Success criteria

1. MCP `initialize` blocks until session window is open and extension is connected
2. Session dashboard shows session ID
3. Every tool call checks `/status` live before executing
4. If extension disconnects mid-session, next tool call recovers transparently (≤10s) or fails explicitly
5. If session window is closed, next tool call opens a new one
6. Second CC session detects the first, opens its own window, reports "1 other session active"
7. All of the above proven by running real MCP commands against real Safari — no mocks
