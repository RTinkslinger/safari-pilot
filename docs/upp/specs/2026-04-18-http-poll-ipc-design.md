# Safari Pilot — HTTP Short-Poll Extension IPC Design Spec

**Date:** 2026-04-18
**Status:** Draft v3 (revised after two adversarial audit rounds: 25 findings in v1→v2, 12 findings in v2→v3)
**Source:** Brainstorm session (Gate A failure → reference repo analysis → Gate B validation → 3-agent adversarial audit → 25-finding product leader audit → 12-finding follow-up audit)

---

## 1. Problem Statement

Safari Pilot's extension engine has never completed an end-to-end roundtrip in production. The current IPC path (`sendNativeMessage` → `SafariWebExtensionHandler` → TCP:19474 → daemon) suffers from:

1. **SFErrorDomain error 3** — concurrent `sendNativeMessage` calls exceed Safari's per-call budget (mitigated in commit 5f7b600 by serializing calls, but fundamentally fragile — any concurrent call pattern triggers it)
2. **30-second event page kill** — Safari terminates the MV3 event page after ~30s, interrupting in-flight `sendNativeMessage` exchanges
3. **Handler instance churn** — each `sendNativeMessage` spawns a new `SafariWebExtensionHandler` instance + new TCP connection to the daemon

The `connectNative` pivot (Gate A, 2026-04-17) was ruled out: Safari's `connectNative` creates a port to the containing macOS app, NOT to the handler. Apple's documentation confirms this is for app-to-extension push communication. Gate A prototype produced zero messages from `connectNative` to the daemon. See `docs/upp/gate-a-results.md` for full evidence.

### Why HTTP over sendNativeMessage

The question "why not just add reconcile to sendNativeMessage?" deserves an explicit answer:

| Factor | sendNativeMessage + reconcile | HTTP fetch + reconcile |
|--------|------|------|
| Handler churn | New handler instance + TCP connection per call | Zero handler involvement |
| SFErrorDomain risk | Remains — any concurrent call pattern can trigger error 3 | Eliminated — no sendNativeMessage calls |
| IPC call cost | Each call: extension → handler → TCP → daemon → TCP → handler → extension (6 hops) | Each call: extension → HTTP → daemon → HTTP → extension (4 hops) |
| Event page kill behavior | In-flight sendNativeMessage is lost; no AbortController | In-flight fetch gets AbortError; clean error handling |
| Reference repo evidence | No reference implementation exists | achiya-automation/safari-mcp ships this in production (205 commits) |
| New dependencies | None | Hummingbird (Swift HTTP framework) |
| New failure modes | None new | Port binding, CORS, HTTP parsing |

HTTP eliminates the root causes (handler churn, SFErrorDomain) at the cost of a new dependency and new failure modes. The tradeoff favors HTTP because the sendNativeMessage failure modes are platform-level (we can't fix Safari's handler lifecycle) while the HTTP failure modes are application-level (we control them).

## 2. Reference Architecture

The original inspiration repo (`achiya-automation/safari-mcp`, 205 commits, v2.8.4) solved this by bypassing native messaging entirely:

- Extension uses `fetch()` HTTP long-polling to `localhost:9224`
- `SafariWebExtensionHandler` is an unused echo stub (extension never calls `sendNativeMessage` — confirmed: zero occurrences in their 2178-line background.js)
- Three HTTP endpoints: `POST /connect`, `GET /poll` (5s hold), `POST /result`
- Three keepalive layers: active fetch, storage heartbeat (20s), alarm reconnect (1 min)
- Started with WebSocket (March 19, 2026), demoted to secondary transport after 2 days ("Safari blocks WebSocket from service workers") — WebSocket still exists for Chrome extensions, HTTP polling became the primary transport for Safari
- Their manifest does NOT include `nativeMessaging` permission — they explicitly chose not to use native messaging

**Key difference:** The reference repo uses a **service worker** (`"background": {"service_worker": "background.js"}`). Safari Pilot uses an **event page** (`"background": {"scripts": ["background.js"], "persistent": false}`). Gate B (2026-04-18) confirmed this matters — active `fetch()` does NOT prevent Safari from killing the event page at 30s. The design adapts with short 5-second poll holds (5-6 polls per 30s wake window).

**The reconcile protocol (Section 6) is Safari Pilot's invention, NOT from the reference repo.** The reference repo's `POST /connect` simply returns `{"status": "connected"}`. They don't need reconcile because their service worker stays alive indefinitely. Safari Pilot's event page dies every 30s, requiring state reconciliation on each re-wake.

## 3. Validated Assumptions

| Assumption | Status | Evidence |
|------------|--------|----------|
| `fetch()` from event page to localhost works | **Validated** | Smoke test (2026-04-17): POST received by test server from Safari/605.1.15 user-agent |
| CSP `connect-src` allows localhost HTTP | **Validated** | Smoke test with `content_security_policy` in manifest.json; single fetch succeeded |
| CORS headers accepted by extension fetch | **Validated** | Gate B (2026-04-18): `Access-Control-Allow-Origin: *` headers accepted, POST succeeded |
| Active fetch keeps event page alive past 30s | **Disproven** | Gate B: event page killed at ~30s regardless of pending fetch response |
| Simple fetch calls work within 30s window | **Validated** | Gate B: 5-6 heartbeat POSTs (fire-and-forget) succeeded per 30s wake cycle |
| 5s long-poll hold works within 30s window | **Untested** | Gate B tested fire-and-forget POSTs, not held-open responses. A poll started at 28s may be interrupted at 30s. Extension must handle AbortError gracefully. |
| Alarm re-wakes event page after kill | **Validated** | Gate B: new poll cycle started after each 30s kill |
| ExtensionBridge handlePoll/handleResult are transport-agnostic | **Partial** | Code review confirms signatures don't depend on transport. BUT: handlePoll's `waitTimeout > 0` code path has NEVER been called by any consumer (CommandDispatcher passes 0). First consumer will be the HTTP server. Must test this path independently. |
| handleReconcile exists | **Does not exist** | Must be implemented from scratch. Not a single line of reconcile code exists in ExtensionBridge.swift today. |
| executedLog exists | **Does not exist** | The `executedLogSize` field in `healthSnapshot()` is a hardcoded placeholder returning `0`. The data structure must be implemented from scratch. |
| `extension_reconcile` route exists in CommandDispatcher | **Does not exist** | The string `extension_reconcile` appears in `src/server.ts:124` as a declared constant, but CommandDispatcher.swift has no matching case. Must be added. |
| TCP:19474 has consumers beyond the handler | **Validated** | DaemonEngine.ts (lines 258-263, TCP fallback for LaunchAgent mode), health-check.sh (line 9, `nc localhost 19474`), benchmark/runner.ts (lines 415/435), main.swift (socket server keeps process alive when stdin closes) |
| CORS preflight caching for extension origins | **Untested** | Standard browsers cache preflights via `Access-Control-Max-Age`, but extension origins (`safari-web-extension://...`) may behave differently |

## 4. Architecture

### Data Flow

```
MCP Client (stdio)
  → SafariPilotServer → ExtensionEngine.execute()
  → ExtensionBridge.handleExecute() — suspends via CheckedContinuation
  → Daemon serves THREE listeners:
      stdin    (NDJSON — MCP server child_process)
      TCP:19474 (NDJSON — DaemonEngine in LaunchAgent mode, health checks, benchmarks)
      HTTP:19475 (NEW — extension background.js via fetch(), Hummingbird)
  ← GET /poll  (5s hold → returns command or 204)
  ← POST /result  (extension sends result → handleResult resumes continuation)
  ← POST /connect  (extension announces alive + reconcile payload)
  → result flows back through MCP with _meta.engine='extension'
```

**ExtensionEngine.ts requires ZERO changes.** The command submission path (ExtensionEngine → DaemonEngine → stdin/TCP → CommandDispatcher → ExtensionBridge) is unchanged. Only the POLLING path changes (from sendNativeMessage→handler→TCP:19474 to fetch→HTTP:19475). TCP:19474 serves TypeScript-side daemon commands. HTTP:19475 serves extension-side polling. Different clients, different ports — 19474 is NOT replaced by 19475.

### Extension Wake Cycle (30s window)

```
Wake trigger (alarm / onStartup / onInstalled / script_load)
  → POST /connect {executedIds, pendingIds, profileId}
  ← Reconcile response {acked, uncertain, reQueued, inFlight, pushNew}
  → Process reconcile: remove acked from storage, re-send uncertain results,
    execute pushNew commands, POST /result for each
  → Enter poll loop:
       GET /poll (server holds up to 5s)
         200 → {command} → execute → POST /result → loop
         204 → no command → loop immediately
       Poll at ~28s may be interrupted by event page kill → AbortError → exit loop
  → ~30s: Safari kills event page
  → Alarm fires at next 1-min mark → re-wakes → cycle repeats from POST /connect
```

### Disconnect Detection (Server-Side)

When the event page dies at ~30s, there is NO HTTP call to notify the daemon. Without detection, `_isConnected` stays `true` forever and commands marked `delivered=true` during a poll stay stuck (the flip-back logic in `handleDisconnected()` never runs).

**Solution:** The HTTP server tracks the timestamp of the last received request (any endpoint: /poll, /result, /connect). A background Task checks every 10 seconds: if no request has arrived in 15 seconds, call `ExtensionBridge.handleDisconnected()`. This resets `_isConnected=false` and flips `delivered=true` back to `delivered=false` on pending commands, allowing re-delivery on the next wake.

The 15-second timeout is chosen because: polls arrive every 5s during an active wake window. A gap of 15s means 3 missed polls — the page is definitely dead. This is well below the 30s page lifetime and well above the 5s poll interval, avoiding false disconnects.

### Keepalive Strategy

1. **Active `fetch()` in poll loop** — provides useful work window during each 5s poll hold
2. **`browser.storage.local.set({_heartbeat: Date.now()})` every 20s** — diagnostic breadcrumb for debugging when the page was last alive (copied from reference repo; NOT proven to extend the 30s kill timer — Gate B showed the 30s kill is absolute)
3. **`browser.alarms.create("keepalive", {periodInMinutes: 1})`** — guaranteed re-wake after event page kill

### Latency Characteristics

| Scenario | Latency | Explanation |
|----------|---------|-------------|
| Page active, polling | **0-5s** | Command delivered on next poll response |
| Page active, between polls | **0-5s** | Poll in-flight, command delivered when current hold completes |
| Page just killed (worst case) | **5-65s** | Alarm cycle is asynchronous to page kill. Best: alarm fires immediately (5s). Worst: 60s alarm wait + 5s poll. |
| **Weighted average** | **~22s** | Page active ~30s per 90s cycle (33%). Active: avg 2.5s. Dead: avg 32.5s. Weighted: 0.33 × 2.5 + 0.67 × 32.5 ≈ 22.6s. |

**This is significantly worse than the theoretical 10ms p50 for the extension engine listed in ARCHITECTURE.md.** The 22s average applies when the agent sends commands unpredictably. For burst workflows (many commands in sequence), commands after the first one in a wake window are delivered in 0-5s because the page is already active.

## 5. Daemon HTTP Server (Hummingbird)

### Dependency Analysis

Adding Hummingbird is the first external dependency in the daemon. Current state:
- `Package.swift` has zero dependencies (only Foundation)
- Daemon binary is ~2MB
- Build time: ~5s (incremental), ~15s (clean)

After adding Hummingbird:
- Transitive dependencies: `swift-nio`, `swift-nio-extras`, `swift-http-types`, `swift-service-lifecycle`, `swift-log`, `swift-collections`
- Expected binary size increase: ~5-10MB (to ~7-12MB total)
- Expected build time increase: ~60-120s additional for first build (SwiftNIO compilation is heavy), ~5-10s incremental
- Minimum deployment target: verify Hummingbird 2.x supports `.macOS(.v12)` or adjust upward
- CI impact: `release.yml` daemon build step will take longer

**Why accept this cost:** Hand-rolling HTTP/1.1 parsing (request lines, headers, Content-Length, CORS preflight) for a Swift daemon is ~300-400 lines of code with high risk of subtle bugs (case-insensitive headers, `\r\n` vs `\n`, Content-Length off-by-one, CORS timing). Hummingbird eliminates this entire risk class. The alternative was considered and the user chose Hummingbird explicitly.

### Routes

**`POST /connect`** — Extension announces it's alive and sends reconcile payload.
```
Request:  { executedIds: string[], pendingIds: string[], profileId: string }
Response: { acked: string[], uncertain: string[], reQueued: string[],
            inFlight: string[], pushNew: {id, script, tabUrl}[] }
```
Calls (in order): `ExtensionBridge.handleConnected()`, then `ExtensionBridge.handleReconcile()` (**must be implemented — does not exist today**), then `HealthStore.markReconcile()`

**`GET /poll`** — Extension polls for commands.
```
Response 200: { id: string, script: string, tabUrl?: string }
Response 204: (no content — no command available)
```
Server holds response for up to 5 seconds. If a command arrives during the hold, responds immediately with 200. If no command after 5s, responds with 204.
Calls: `ExtensionBridge.handlePoll(commandID: uuid, waitTimeout: 5.0)` — **Note: `waitTimeout > 0` is an existing but never-tested code path** (line 178 of ExtensionBridge.swift). Current consumers always pass `waitTimeout: 0`. This will be the first real consumer.

**`POST /result`** — Extension sends command execution result.
```
Request:  { requestId: string, result: any, error?: string }
Response: { ok: true }
```
Calls: `ExtensionBridge.handleResult()` — **this method exists and is tested**

**All routes include CORS headers:**
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

**OPTIONS preflight** on all paths responds with 204 + CORS headers. CORS preflight caching for extension origins is unverified — if Safari doesn't cache preflights, every POST takes an extra round-trip (~5ms). Add a P1 test to verify caching behavior.

### Implementation Requirements

- Hummingbird server runs on a separate Swift Task, **MUST bind to `127.0.0.1:19475` only** — binding to `0.0.0.0` would expose the HTTP server to the network, creating a remote code execution vulnerability
- Each request dispatched as a separate Swift Task (required for `handlePoll` continuation suspension — concurrent request handling is mandatory, as confirmed by the engineering audit)
- Port hardcoded to `19475` (env var configurability is theater — the extension's `HTTP_URL` constant is hardcoded to `127.0.0.1:19475` with no discovery mechanism)
- Bind failure → log error, continue without HTTP server (daemon still functional via stdin + TCP:19474)
- **Disconnect detection:** Background Task runs every 10s. If no HTTP request received in 15s, calls `ExtensionBridge.handleDisconnected()` to reset `_isConnected` and flip-back delivered commands. Tracks `_lastHttpRequestTime` timestamp updated on every /poll, /result, /connect request.
- **`ipcMechanism` flag:** On any HTTP request, set `ExtensionBridge._lastIpcMechanism = "http"`. Exposed in `healthSnapshot()` as `"ipcMechanism": "http"`. Allows e2e tests to verify the HTTP path was used (vs legacy `sendNativeMessage` which would set `"native"`).

## 6. Reconcile Protocol

**ALL of the following must be implemented from scratch. None of this code exists today.** The `executedLogSize` field in `healthSnapshot()` is a placeholder returning `0`. There is no `handleReconcile` method. There is no `extension_reconcile` route in `CommandDispatcher`.

### executedLog (ExtensionBridge) — NEW

Records command IDs after `handleResult` completes successfully. Entries expire after 300 seconds (5-minute TTL). Used by reconcile to classify commands as acked vs uncertain.

```swift
private struct ExecutedEntry {
    let commandID: String
    let timestamp: Date
}
private var executedLog: [ExecutedEntry] = []
```

Pruned opportunistically on each `handleResult` call. The `executedLogSize` placeholder in `healthSnapshot()` must be wired to return the real count.

**Limitation: `executedLog` is in-memory only.** If the daemon restarts, all entries are lost. This means a daemon restart between "extension executes command" and "extension sends POST /result" will cause the command to be classified as "uncertain" on the next reconcile. The extension will re-send the result, but `handleResult` will find no matching command in `pendingCommands` (lost on restart). The result is silently dropped — the command is permanently orphaned. **Mitigation:** The MCP server caller (ExtensionEngine) will see a timeout on `handleExecute()` and can retry the command.

### handleReconcile (ExtensionBridge) — NEW

Five-case classification:

1. **acked** — command ID in executedLog → daemon has the result, extension can remove from storage
2. **uncertain** — command ID NOT in executedLog AND NOT in pendingCommands → daemon lost it, extension re-sends result
3. **reQueued** — command ID in pendingCommands with `delivered=false` → command was reset after disconnect
4. **inFlight** — command ID in pendingCommands with `delivered=true` → daemon awaiting result
5. **pushNew** — undelivered commands NOT known to extension → push for execution (excludes reQueued to prevent double-execution)

### extension_reconcile route (CommandDispatcher) — NEW

Add a new case in `CommandDispatcher.dispatch()`:
```swift
case "extension_reconcile":
    let executedIds = (command.params["executedIds"]?.value as? [String]) ?? []
    let pendingIds = (command.params["pendingIds"]?.value as? [String]) ?? []
    let response = extensionBridge.handleReconcile(...)
    healthStore.markReconcile()
    return response
```

### Extension Storage Contract

Commands persist in `browser.storage.local` under `safari_pilot_pending_commands`:
```json
{
  "cmd-1": { "status": "completed", "result": {...}, "timestamp": 1776475688 },
  "cmd-2": { "status": "executing", "script": "...", "timestamp": 1776475690 }
}
```

**Storage lifecycle change:** Entries are ONLY removed when the daemon confirms via reconcile `acked` response. This is a behavioral change from the current code, where `sendResult()` calls `removePendingEntry()` immediately after sending. In the new model, storage grows until reconcile acks. **A TTL-based garbage collector is needed:** entries older than 10 minutes with status "completed" should be pruned to prevent unbounded storage growth if reconcile never acks (e.g., daemon down for extended period).

## 7. Extension background.js Changes

Current file: 341 lines.

### Removed (~78 lines)
- `sendNative()` function (lines 29-31)
- `sendLog()` function (lines 33-37)
- `sendResult()` function (lines 131-134) — **Note:** `removePendingEntry` is decoupled from result sending. Old pattern: execute → sendResult → removePendingEntry (immediate). New pattern: execute → postResult (no removal) → reconcile acked → removePendingEntry (deferred).
- `wakeSequence()` poll-first drain loop (lines 224-273)
- `initialize()` serializer (lines 275-290) — rewritten

### Added (~100 lines)
- `HTTP_URL` constant (`http://127.0.0.1:19475`)
- `connectAndReconcile()` — POST /connect with executedIds/pendingIds, process reconcile response
- `pollLoop()` — GET /poll with 5s hold, execute commands, POST /result
- `handleReconcileResponse()` — process acked/uncertain/pushNew
- `postResult(commandId, result)` — POST /result (does NOT call `removePendingEntry`)
- Storage heartbeat interval (20s)
- Error handling: AbortError on poll → clean exit, connection refused → `scheduleReconnect()` via alarm
- Storage GC: prune entries > 10 minutes with status "completed" on each wake

### Unchanged (~244 lines)
- Constants, state, profile identity (lines 1-26)
- Storage-backed pending queue: `readPending`, `writePending`, `updatePendingEntry`, `removePendingEntry` (lines 39-59)
- Command execution: `findTargetTab`, `executeCommand` (lines 62-129) — **these functions have NO dependency on sendNativeMessage.** `executeCommand` writes to storage and returns the result; it does not send it anywhere. The caller is responsible for delivery.
- Cookie operations: `handleCookieGet/Set/Remove/GetAll` (lines 136-168)
- DNR operations: `handleDnrAddRule/RemoveRule` (lines 170-183)
- Content script relay: `handleExecuteInMain` (lines 186-201)
- Command router: `handleCommand` (lines 204-220)
- Top-level listener registration: `onStartup`, `onInstalled`, `onMessage`, `alarms.onAlarm` (lines 293-324) — alarm handler rewired to call new `initialize()` instead of old wake sequence
- Debug harness (lines 326-341)

### manifest.json Changes
```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; connect-src 'self' http://localhost:19475 http://127.0.0.1:19475"
}
```
`nativeMessaging` permission kept as conservative measure — Safari's extension registration cache has caused silent failures when permissions change (see CLAUDE.md extension build hard rules). Can be removed in a future commit after confirming no re-registration issues.

## 8. Handler Changes

Replace `extension/native/SafariWebExtensionHandler.swift` with Xcode template stub:

```swift
import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey]
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: ["echo": message as Any]]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
```

The handler exists because Xcode requires it in the `.appex` target. It is never called by the extension (no `sendNativeMessage` calls in background.js). The `scripts/build-extension.sh` script copies the handler from `extension/native/` — the stub must be committed to that source path.

## 9. Work Breakdown

Every file that must be created or modified:

### New files
| File | What | Est. lines |
|------|------|-----------|
| `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` | Hummingbird HTTP server, 3 routes + CORS | ~120-150 |

### Modified files
| File | What changes | Est. lines changed |
|------|-------------|-------------------|
| `daemon/Package.swift` | Add Hummingbird dependency + resolve transitive deps | ~5 |
| `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` | Add `executedLog`, `isInExecutedLog`, `addToExecutedLogForTest`, `executedLogSize`, `handleReconcile`, `ipcMechanism` field (set to `"http"` by HTTP server on connect/poll, exposed in `healthSnapshot()`) | ~90-110 |
| `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` | Add `extension_reconcile` route | ~10 |
| `daemon/Sources/SafariPilotd/main.swift` | Wire HTTP server startup alongside existing listeners | ~10-15 |
| `daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` | Tests for executedLog + reconcile (inside existing `registerExtensionBridgeTests`) | ~100-150 |
| `daemon/Tests/SafariPilotdTests/ExtensionSocketServerTests.swift` | Tests for HTTP server (or new test file) | ~80-120 |
| `extension/background.js` | Replace sendNativeMessage IPC with fetch-based polling | ~140 lines changed |
| `extension/manifest.json` | Add `content_security_policy` with `connect-src` | ~4 |
| `extension/native/SafariWebExtensionHandler.swift` | Replace TCP proxy with stub | full file replacement |
| `test/unit/extension/background.test.ts` | Update source-text assertions for HTTP instead of sendNativeMessage | ~20-30 |
| `test/e2e/commit-1a-shippable.test.ts` | Update for commit 2 scope | ~20-30 |
| `test/e2e/connectnative-roundtrip.test.ts` | New or renamed: HTTP roundtrip e2e tests | ~80-100 |
| `ARCHITECTURE.md` | Update extension engine data flow for HTTP (mandatory per CLAUDE.md) | ~30-40 |

### Build pipeline verification (no changes expected, but must verify)
| File | Verify |
|------|--------|
| `scripts/build-extension.sh` | Copies handler from `extension/native/` — will pick up the stub automatically |
| `scripts/update-daemon.sh` | Must handle Hummingbird dependency resolution during `swift build` — verify it works |
| `scripts/postinstall.sh` | No changes needed — HTTP port is daemon-internal, not exposed via LaunchAgent plist |

**Total estimated new/changed code: ~700-900 lines** across daemon (Swift), extension (JS), and tests.

## 10. Testing Strategy

### P0 — Must pass before shipping

| Test | Proves | Location |
|------|--------|----------|
| HTTP server accepts GET /poll, holds 5s, returns command when one arrives | Daemon HTTP + long-poll works | daemon tests |
| HTTP server accepts GET /poll, returns 204 after 5s when no command | Long-poll timeout works | daemon tests |
| HTTP server accepts POST /result, resumes continuation | Result delivery works | daemon tests |
| HTTP server accepts POST /connect with reconcile payload | Reconcile over HTTP works | daemon tests |
| HTTP server handles CORS preflight (OPTIONS → 204 + headers) | Extension fetch won't be blocked | daemon tests |
| HTTP server rejects non-127.0.0.1 connections | Security: no remote access | daemon tests |
| executedLog records completed commands, expires after TTL | Reconcile foundation works | daemon tests |
| handleReconcile classifies acked/uncertain/reQueued/inFlight/pushNew | Five-case classification correct | daemon tests |
| Full MCP → extension → Safari → result with `engine: 'extension'` AND `ipcMechanism: 'http'` | End-to-end roundtrip through HTTP path specifically | e2e tests |
| Reconnect after event page kill: alarm fires, extension re-connects, resumes polling | Crash recovery works | e2e tests |
| Unit tests: background.js contains `fetch`, `connectAndReconcile`, no `sendNativeMessage` | Source contract | unit tests |
| AbortError handling: poll interrupted at 28s doesn't crash | Edge case at end of 30s window | unit tests (source check) + e2e |
| Disconnect detection: 15s without poll → handleDisconnected fires, isConnected=false, delivered commands flipped | Command recovery after event page death | daemon tests |
| ipcMechanism field in healthSnapshot returns "http" after HTTP connection | E2E tests can verify HTTP path specifically | daemon tests + e2e |

### P1 — Important, defer with documented risk

| Test | Proves |
|------|--------|
| Concurrent command delivery (2+ commands queued) | Multi-command correctness |
| HTTP latency benchmark (p50/p95) vs sendNativeMessage baseline | Performance characterization |
| Reconcile classifies acked commands after daemon restart (uncertain path) | Daemon restart recovery |
| CORS preflight caching verification for extension origins | Latency impact of CORS |
| 100+ sequential polls without Safari throttling | Rate-limit resistance |
| Storage GC prunes old completed entries | Unbounded storage prevention |

### E2E IPC Path Verification

To distinguish "extension works via HTTP" from "extension works via sendNativeMessage" (audit finding 23), the `extension_health` response must include `ipcMechanism: 'http'` or `'native'`. The P0 e2e test asserts `ipcMechanism: 'http'` alongside `engine: 'extension'`. This is implemented by having the HTTP server set a flag on ExtensionBridge when a connection arrives via HTTP.

### E2E Test Constraints (unchanged from CLAUDE.md)

- No `vi.mock`, `vi.spyOn`, or source imports in `test/e2e/`
- All interaction via MCP JSON-RPC protocol or real Safari
- Pre-commit hook enforces no mocks in e2e directory

## 11. Failure Mode Analysis

| Failure | What happens | Mitigation |
|---------|-------------|------------|
| Hummingbird fails to start (port in use, crash) | Daemon logs error, continues without HTTP server. Extension gets connection refused, schedules alarm reconnect. Commands time out on MCP side. | Bind failure is non-fatal. TCP:19474 + stdin remain functional. |
| Extension fetch gets connection refused | Daemon not running or HTTP server not started. Extension logs error, calls `scheduleReconnect()`. | Alarm re-wakes in 1 min, retries POST /connect. |
| Event page killed mid-command-execution | `executeCommand()` was in-flight. Storage has entry with status "executing". | On re-wake, reconcile sends this as `pendingIds`. Daemon classifies as `inFlight` or `reQueued`. Command may need re-execution. |
| Daemon restarts while extension has completed-but-unacked results | `executedLog` is lost (in-memory). Extension re-sends results on next reconcile. `handleResult` finds no matching pendingCommand. | Result is silently dropped. MCP caller sees timeout, retries command. This is a known gap — persistent executedLog (disk-backed) deferred to future commit. |
| Two daemon instances try to bind port 19475 | Second instance fails to bind, logs error. Extension connects to first instance. | Second instance continues via stdin + TCP:19474. |
| macOS firewall blocks 127.0.0.1 | Extremely unlikely — loopback is almost never firewalled on macOS. | If it happens, extension falls through to alarm reconnect. No silent data loss. |
| Event page dies without disconnect signal | `_isConnected` stays true, delivered commands stuck with no result. | HTTP server detects 15s poll gap → calls `handleDisconnected()` → flips delivered=true back to false, resets _isConnected. |
| Daemon crashes after processing POST /result but before HTTP response | Extension thinks delivery failed, keeps entry in storage. Re-sends on next reconcile. | Harmless — daemon acks the duplicate silently, no data loss. |
| Safari update changes CSP enforcement | `connect-src` for extension pages could be restricted. | CSP is explicitly declared; Apple has not signaled this. Reference repo ships it. Monitor Safari release notes. |

## 12. Risk Register

| Risk | Severity | Mitigation |
|------|----------|------------|
| Safari future update blocks extension fetch to localhost | Medium | CSP is explicit; reference repo ships it in production; monitor Safari release notes |
| Hummingbird dependency: build time, binary size, min macOS version | Medium | Verify Hummingbird 2.x supports macOS 12; measure binary size post-integration; CI build time increase ~60-120s |
| CORS preflight not cached for extension origins | Low | If uncached: extra ~5ms per POST. Add P1 test. Mitigate with `Access-Control-Max-Age: 86400` header. |
| Event page killed mid-command-execution | Medium | Storage-backed pending queue preserves state; reconcile recovers on re-wake |
| E2E tests pass with broken extension (graceful degradation) | High | P0 test asserts both `engine: 'extension'` AND `ipcMechanism: 'http'` |
| 22s average command latency | High | Acceptable for current usage patterns (single commands with human-speed interaction). For burst workflows, latency drops to 0-5s after first command wakes the page. Document in ARCHITECTURE.md. |
| Remote code execution if HTTP binds 0.0.0.0 | Critical | Implementation MUST bind 127.0.0.1 only. P0 test verifies. |

## 13. What's NOT in Scope

- `claimedByProfile` multi-profile isolation (commit 3)
- Service worker migration (could extend wake window beyond 30s, but event page + short polls works)
- Push-wake via containing app (`connectNative` for app→extension push)
- HTTPS/TLS on localhost (unnecessary for loopback)
- HTTP/2 (overkill for 3 routes on localhost)
- Persistent `executedLog` (disk-backed, survives daemon restart) — deferred, mitigated by MCP-side timeout + retry
- Port discovery mechanism (extension and daemon must agree on port 19475)

## 14. Success Criteria

This commit is successful when:

1. `safari_evaluate({script: "return 1+1"})` returns `2` with `_meta.engine: 'extension'` AND the health endpoint shows `ipcMechanism: 'http'` (proving the HTTP path was used)
2. Event page kill + alarm re-wake + resumed polling delivers a queued command
3. Reconcile correctly classifies acked commands (removes from extension storage)
4. Daemon health endpoint (`extension_health`) shows `isConnected: true`, `lastReconcileTimestamp` non-null, and `executedLogSize` reflecting real count (not placeholder 0)
5. Zero `sendNativeMessage` calls in the shipped background.js
6. All existing daemon tests + unit tests + e2e tests pass
7. HTTP server bound to 127.0.0.1 only (verified by P0 test)
8. ARCHITECTURE.md updated to reflect HTTP-based extension data flow
