# Safari Pilot Architecture — Canonical Source of Truth

*Last verified: 2026-04-23 | Branch: main*

**This document describes how Safari Pilot ACTUALLY works as shipped. Every statement is backed by verified evidence. If code changes contradict this document, either the code is wrong or this document must be updated — never silently diverge.**

**Update rule:** Any commit that changes component behavior, data flow, IPC protocol, security pipeline order, engine selection logic, or test architecture MUST update this document in the same commit.

---

## System Overview

Safari Pilot is a native Safari browser automation framework exposing **78 tools** via MCP (stdio). It controls Safari through three engine tiers, protected by 7 pre-execution security layers + 3 post-execution checks.

```
Claude Code / AI Agent
        │
        │ MCP JSON-RPC over stdin/stdout
        ▼
┌─────────────────────────────────┐
│  MCP Server (src/index.ts)      │
│  ┌───────────────────────────┐  │
│  │ SafariPilotServer         │  │
│  │  • 78 tools registered    │  │
│  │  • 9 security layers      │  │
│  │  • Engine selection       │  │
│  └───────────────────────────┘  │
└──────┬──────────┬───────────────┘
       │          │
       ▼          ▼
   Extension    Daemon/AppleScript
   Engine       Engine
```

---

## Three-Tier Engine Model

### Tier 1: Extension Engine (0-5s active, ~22s weighted avg)
**Capabilities:** Shadow DOM (open), CSP bypass (partial — MAIN world only), dialog interception, network interception, framework detection, cross-origin frames

**Data flow (verified 2026-04-18, HTTP short-poll IPC):**
```
ExtensionEngine.executeJsInTab(tabUrl, jsCode)
  │ sends: __SAFARI_PILOT_INTERNAL__ extension_execute {"script":"...","tabUrl":"..."}
  ▼
DaemonEngine.execute(sentinel)
  │ NDJSON over stdin to daemon process
  ▼
CommandDispatcher.handleInternalCommand()
  │ routes to ExtensionBridge.handleExecute()
  ▼
ExtensionBridge (in-memory queue)
  │ queues command, suspends via CheckedContinuation
  │ 90s timeout via Task
  ▼
Daemon serves THREE listeners:
  stdin    (NDJSON — MCP server child_process)
  TCP:19474 (NDJSON — DaemonEngine in LaunchAgent mode, health checks, benchmarks)
  HTTP:19475 (extension background.js via fetch(), Hummingbird)
  ▼
background.js polls via HTTP fetch:
  │ wake triggers: onStartup / onInstalled / alarm / session_* / script_load
  │ POST /connect {executedIds, pendingIds} → reconcile response
  │ → handleReconcileResponse: remove acked, re-send uncertain, execute pushNew
  │ → enter pollLoop: GET /poll (5s hold) → {commands:[...]} or 204
  ▼
background.js extracts commands from response.commands
  │ iterates each command: finds target tab by URL via tab cache
  │ (browser.tabs.query returns [] in alarm-woken context — persistent cache via
  │  tabs.onCreated/onUpdated/onRemoved, stored in browser.storage.local)
  │ falls back to active tab if no URL match
  ▼
Storage bus IPC (browser.storage.local as message transport):
  │ background.js writes command to storage key 'sp_cmd'
  │ content-isolated.js reads via storage.onChanged listener OR init read
  │ content-isolated.js relays to content-main.js via window.postMessage
  │ content-main.js evaluates script in MAIN world (new Function())
  │ result flows back: content-main.js → postMessage → content-isolated.js
  │ content-isolated.js writes result to storage key 'sp_result'
  │ background.js reads via storage.onChanged listener
  │
  │ Why storage bus: Safari's browser.tabs.sendMessage and
  │ browser.scripting.executeScript return undefined/null in alarm-woken
  │ event page context. browser.storage.local is the only reliable
  │ cross-context channel that survives event page lifecycle transitions.
  │
  │ Bug 6 fix (2026-04-23): storage.onChanged only fires for FUTURE
  │ changes. In newly opened tabs (content scripts inject at document_idle),
  │ commands written before injection are invisible to the listener.
  │ Fix: content-isolated.js reads current sp_cmd from storage after tabId
  │ registration and processes if it targets this tab. Dedup guard
  │ (processedCommandIds Set) prevents double-execution.
  ▼
Result persisted to storage.local (status:completed), then sent:
  background.js → POST /result {requestId, result}
  → ExtensionHTTPServer → ExtensionBridge.handleResult()
  → records in executedLog (5-min TTL) → resumes CheckedContinuation
  → DaemonEngine → ExtensionEngine
  → SafariPilotServer → MCP response with _meta.engine='extension'
```

**Disconnect detection:** HTTP server tracks last request time. Background Task checks
every 10s: if no request in 15s, calls handleDisconnected() which flips delivered=false
on unacked commands for re-delivery on next wake.

**Reconcile protocol (5-case classification):**
- **acked**: extension says executed, daemon's executedLog confirms → extension removes from storage
- **uncertain**: extension says executed, daemon has no record → extension re-sends result
- **reQueued**: extension says pending, daemon has it undelivered → no client action (re-delivered via /poll)
- **inFlight**: extension says pending, daemon has it delivered → no client action (timeout handles)
- **pushNew**: daemon has undelivered commands extension doesn't know about → pushed in reconcile response

**Handler stub:** SafariWebExtensionHandler.swift is a Xcode-required stub (echo-only).
The extension never calls sendNativeMessage — all IPC is via HTTP fetch to localhost:19475.

**Verification command:**
```bash
echo '{"id":"test","method":"extension_status"}' | nc -w 3 localhost 19474
# Expected: {"ok":true,"value":"connected"}
curl -s http://127.0.0.1:19475/poll
# Expected: 204 (no pending commands) or 200 with {commands:[...]}
```

**CSP handling (2026-04-15):** Primary execution path uses content script relay (background.js → content-isolated.js → content-main.js). content-main.js captures the `Function` constructor at load time and handles `execute_script` method. Falls back to `browser.scripting.executeScript` for pages without content scripts. Structured extension operations (queryShadow, dialog interception, network interception) work on CSP-protected pages via pre-defined methods in content-main.js. Arbitrary eval-style JS may still be blocked by strict CSP — this is a Safari platform limitation.

**`safari_evaluate` async wrapper (2026-04-24):** `handleEvaluate` in `src/tools/extraction.ts` wraps the user script in an ASYNC IIFE (`return (async () => { var __userResult = await (async function() { ${script} })(); return { value: __userResult, type: typeof __userResult }; })()`). The outer `await` resolves any Promise the user script returns before the value crosses the content-main → content-isolated → background postMessage boundary. Pre-fix a synchronous IIFE returned the Promise object unresolved, and structured-clone threw `DataCloneError`. Pairs with T6's `await fn()` in `content-main.js:execute_script`. Covered by `test/e2e/evaluate-async.test.ts`.

### Tier 2: Daemon Engine (5ms p50)
**Capabilities:** Fast AppleScript execution, PDF generation (WKWebView.createPDF), download watching (FSEvents + DispatchSource)

**Data flow:**
```
DaemonEngine.execute(appleScript)
  │ NDJSON: {"id":"req-N","method":"execute","params":{"script":"tell app..."}}
  │ over stdin to daemon process (bin/SafariPilotd)
  ▼
CommandDispatcher routes to AppleScriptExecutor
  │ NSAppleScript.executeAndReturnError (LRU cached, max 100)
  ▼
Response via stdout NDJSON
```

**Verification:**
```bash
echo '{"id":"t","method":"ping"}' | ./bin/SafariPilotd
# Expected: {"id":"t","ok":true,"value":"pong"}
```

**TCP mode self-healing (2026-04-24, T9):** when the LaunchAgent daemon is live on `TCP:19474`, `DaemonEngine` sets `useTcp=true` after a successful probe and routes subsequent commands through `sendCommandViaTcp()` instead of its own stdin pipe. If a command fails via socket 'error', timeout, or unparseable JSON response, `useTcp` is reset to `false` so the next `ensureRunning()` call can re-probe or fall back to spawning a local daemon. Pre-T9 only the 'error' path reset the flag — timeouts and parse failures left the engine stuck on the dead TCP endpoint indefinitely. Unit-tested in `test/unit/engines/daemon.test.ts` with mocked `node:net`.

### Tier 3: AppleScript Engine (80ms p50)
**Capabilities:** Basic navigation, form filling, text extraction, JS evaluation — always available fallback

**Data flow:**
```
AppleScriptEngine.execute(script)
  │ child_process.execFile('osascript', ['-e', script])
  ▼
macOS osascript → Safari via Apple Events
```

### Engine Selection (src/engine-selector.ts)

Called in `executeToolWithSecurity()` for EVERY tool call.

```typescript
selectEngine(tool.requirements, {daemon: bool, extension: bool}) → Engine
```

Logic:
1. If tool requires extension capabilities (shadowDom, cspBypass, etc.) AND extension available → `'extension'`
2. If tool requires extension AND extension NOT available → throw `EngineUnavailableError`
3. Otherwise: prefer extension → daemon → applescript (best available)

**Response metadata:** Every MCP response includes `_meta.engine` reflecting the engine selector's choice. For proxy-based tools (13 of 17 modules), `_meta.engine` reflects BOTH selector choice AND physical execution engine. For direct-engine tools (Navigation, Compound, Download, PDF), `_meta.engine` reflects selector choice only — physical execution uses a hardcoded engine (AppleScript or daemon).

**Engine proxy pattern (server.ts:228-251):** 12 of 17 tool modules receive an `EngineProxy` instance. Before each tool call, `server.ts:500-502` calls `proxy.setDelegate(selectedEngine)`, so proxy-based tools physically execute through the selected engine. Five modules receive engines directly: `NavigationTools(AppleScriptEngine)`, `CompoundTools(AppleScriptEngine)`, `DownloadTools(server)`, `PdfTools(server)`, `ExtensionDiagnosticsTools(DaemonEngine|null)`.

---

## Security Pipeline

**7 pre-execution layers + 3 post-execution checks on every tool call** (src/server.ts `executeToolWithSecurity`):

| # | Layer | What it does | Wired at |
|---|-------|-------------|----------|
| 1 | **KillSwitch** | Global emergency stop — blocks ALL automation | server.ts:391 |
| 2 | **DomainPolicy** | Per-domain trust levels, blocked domains list | server.ts:406 |
| 3 | **HumanApproval** | Blocks sensitive actions on OAuth/financial URLs | server.ts:410 |
| 4 | **RateLimiter** | 120 actions/min global, per-domain buckets | server.ts:452 |
| 5 | **CircuitBreaker** | 5 errors on a domain → 120s cooldown (see dual-scope note below) | server.ts:459 |
| 6 | **Engine Selection** | Picks best available engine for tool's requirements | server.ts:463 |
| 7 | **TabOwnership** | Identity-based: defers to post-execution if extension engine + domain match | server.ts:512 |
| — | **Tool Execution** | Calls the tool handler with selected engine | server.ts:576 |
| 8 | **Post-exec Ownership** | Backfill extensionTabId, refresh URL, verify deferred ownership | server.ts:602 |
| 9 | **IdpiScanner** | Post-execution: scans extraction results for prompt injection | server.ts:638 |
| 10 | **ScreenshotRedaction** | Post-execution: attaches redaction script for banking/cross-origin | server.ts:654 |
| 11 | **AuditLog** | Post-execution: records tool, URL, engine, params, result, timing | server.ts:659 |

**CircuitBreaker dual scope (src/security/circuit-breaker.ts):** The breaker carries two INDEPENDENT scopes on the same instance.
- **Per-domain scope** (existing): 5 failures in a 60s rolling window → 120s cooldown. API: `recordFailure(domain)` / `recordSuccess(domain)` / `isOpen(domain)` / `getState(domain)` / `assertClosed(domain)`. Runs inline at layer 6.
- **Per-engine scope** (Task 9; wired 2026-04-24, T12): 5 extension-lifecycle errors in a 120s rolling window → 120s cooldown. API: `recordEngineFailure(engine, errorCode)` / `isEngineTripped(engine)` / `getEngineState(engine)`. Only `EXTENSION_TIMEOUT`, `EXTENSION_UNCERTAIN`, and `EXTENSION_DISCONNECTED` count; all other codes are ignored. `engine-selector.selectEngine(tool, available, breaker?)` honors this scope — when the extension breaker is tripped, selection falls back to daemon/applescript for non-extension-required tools and throws `EngineUnavailableError` for extension-required tools. The two scopes never interact — domain failures do not trip the engine breaker, and engine failures do not trip the domain breaker. `getEngineState` backs the `engineCircuitBreakerState` field of the `extension_health` snapshot. **Wiring**: `server.ts`'s `executeToolWithSecurity` error-path calls `this.recordToolFailure(domain, engine, error)`, which fires both scopes. Pre-T12 only the per-domain side was called; engine breaker was defined but never incremented.

**Extension kill-switch (Task 13, safari-pilot.config.json):** The config now has an `extension` section with `enabled: boolean` + `killSwitchVersion: string`. When `extension.enabled=false`, `selectEngine` skips the Extension engine (tools requiring it throw `EngineUnavailableError`; others fall back to daemon/applescript). This is the 30-second config-only rollback path for the Extension engine — no rebuild/sign/notarize required.

**Engine-degradation security re-run (Task 10, src/server.ts step 7.5):** When the Extension engine is available and its breaker is closed but `selectEngine` returns a non-extension engine, the pipeline calls `HumanApproval.invalidateForDegradation(tool)` + `IdpiScanner.invalidateForDegradation(tool)` and re-asserts `HumanApproval.assertApproved` against the fallback engine's action surface. `metadata.degradedReason` is set to `extension_unavailable_fallback_to_<engine>` (or `extension_degraded_approval_required: <msg>` if approval now fails). The `invalidate*` methods are no-ops at 1a — HumanApproval and IdpiScanner are stateless — and exist for API symmetry with future engine-aware caching (commit 1c).

**EXTENSION_UNCERTAIN (src/errors.ts):** Typed error for the non-idempotent + Extension-engine ambiguous disconnect case. Carries `StructuredUncertainty { disconnectPhase, likelyExecuted, recommendation }` surfaced on `ToolError.uncertainResult`. `retryable=false` — the caller decides whether to probe page state or retry; the pipeline never auto-retries.

**INFRA_MESSAGE_TYPES (src/server.ts):** Documented bypass set for daemon↔extension infrastructure methods — `extension_poll`, `extension_drain`, `extension_reconcile`, `extension_connected`, `extension_disconnected`, `extension_log`, `extension_result`. These are coordination messages, not per-domain tool calls, and must never traverse the 9-layer pipeline. Commit 1a declares the contract as an exported `ReadonlySet<string>`; Commit 1b wires the reconcile + drain routes. These messages currently flow via `ExtensionSocketServer` + NDJSON dispatcher in the daemon, never reaching `executeToolWithSecurity` (whose name parameter only receives registered `safari_*` tool names). No pre-pipeline bypass check is required at 1a — the constant is declarative and becomes enforcement-wired when 1b introduces the reconcile/drain routes.

**Tab ownership enforcement (identity-based, 2026-04-21):**

Dual-key registry: tabs are tracked by both positional `TabId` (windowIndex * 1000 + tabIndex) and stable `extensionTabId` (Safari's `tab.id` from the extension). URL is mutable and refreshed on every extension-engine result.

- **Registration:** `safari_new_tab` registers with URL + null extensionTabId. The extensionTabId is backfilled on the first extension-engine tool call (via `_meta.tabId` in the result).
- **Ownership check flow (server.ts step 7d, after engine selection):**
  1. `findByUrl(tabUrl)` → if found, `assertOwnership(tabId)` (fast path)
  2. If URL not found AND extension engine selected AND `domainMatches(tabUrl)` → set `deferredOwnershipCheck = true` (deferred path)
  3. If URL not found AND (not extension engine OR domain doesn't match) → throw `TabUrlNotRecognizedError` (fail closed)
- **Post-execution verify (server.ts step 8.post2):**
  1. Read `engineProxy.getLastMeta()` — contains `_meta.tabId` + `_meta.tabUrl` from extension result
  2. Backfill `extensionTabId` on first call via `setExtensionTabId()`
  3. Refresh URL in registry via `findByExtensionTabId()` + `updateUrl()` (keeps `findByUrl` working for next call)
  4. If `deferredOwnershipCheck`: verify `findByExtensionTabId(extTabId)` returns an owned tab. If undefined → throw (tab not ours). If no `_meta` returned → throw (fail closed).
- **SKIP_OWNERSHIP_TOOLS:** `safari_list_tabs`, `safari_new_tab`, `safari_health_check` (navigate_back/forward now go through the deferred path)
- **Domain guard (`domainMatches`):** Declared on `TabOwnership` with ccTLD-aware registrable-domain matching (via `extractRegistrableDomain()`, handles `.co.uk`, `.com.au`, etc.). **NOT currently wired into the deferred-ownership path** — was removed from `server.ts` at `75177e8` because it broke legitimate cross-domain link clicks. Tracked for resolution as T24 in `docs/AUDIT-TASKS.md` (wire it correctly or delete the method). The ccTLD-aware implementation is kept so that, if wired, it does not treat `evil.co.uk` as the same registrable domain as `bank.co.uk`.
- **Known limitations:**
  - SPA `history.pushState` does not fire `tabs.onUpdated` — extensionTabId cache and server URL both go stale. First call after pushState will fail.
  - Multiple tabs at same URL: `findByUrl` returns first found. `findByExtensionTabId` is unambiguous after backfill.
  - AppleScript-only sessions: no extension → no tab.id backfill → ownership remains URL-only (same as pre-identity behavior).

**Circuit breaker pipeline usage:**
- Uses `assertClosed(domain)` (not `isOpen()` + manual throw) — correctly handles half-open probe logic

**Escaping contract:**
- **All user-input sites migrated** to `escapeForJsSingleQuote()` / `escapeForTemplateLiteral()` from `src/escape.ts`. Zero inline `.replace()` escaping remains in tool modules. Files: extraction.ts, storage.ts, network.ts, structured-extraction.ts, permissions.ts, interaction.ts, shadow.ts, frames.ts.
- Characters escaped: `\`, `'`, `\n`, `\r`, `\0`, U+2028, U+2029 (single-quote context); `\`, `` ` ``, `${` (template context)

---

## IPC Architecture

### MCP ↔ Server
- Protocol: JSON-RPC 2.0 over stdin/stdout
- Entry: src/index.ts → StdioServerTransport → Server
- Tool results include `_meta` with engine metadata

### Server ↔ Daemon
- Protocol: NDJSON over stdin/stdout of spawned child process
- Binary: bin/SafariPilotd (Swift, arm64)
- ID-based request/response matching (not FIFO)
- Timeout: 30s default

### Daemon ↔ Extension Handler
- Protocol: TCP JSON, one message per connection
- Port: localhost:19474 (ExtensionSocketServer)
- Handler connects, sends JSON + newline, reads response, disconnects
- Completion guard prevents double-complete race on timeout

### Extension background.js ↔ Daemon HTTP Server
- Protocol: HTTP fetch to 127.0.0.1:19475 (ExtensionHTTPServer, Hummingbird)
- Routes:
  - `POST /connect {executedIds, pendingIds}` → reconcile response (5 categories)
  - `GET /poll` → 5s long-poll hold → `{commands:[...]}` or 204
  - `POST /result {requestId, result}` → resumes continuation
  - `GET /status?sessionId=X` → `{ext, mcp, sessionTab, lastPingAge, activeSessions}` (touches session heartbeat)
  - `POST /session/register {sessionId}` → `{ok, activeSessions}` (registers MCP session)
  - `GET /session?id=X` → session dashboard HTML
  - `GET /health` → `{isConnected, mcpConnected, lastExecutedResultTimestamp}`
- CORS: `Access-Control-Allow-Origin: *` (extension origin is `safari-web-extension://...`)
- CSP: manifest.json allows `connect-src http://127.0.0.1:19475`
- Handler (SafariWebExtensionHandler.swift) is a stub — never called by background.js

### background.js ↔ Content Scripts
- ISOLATED world: browser.runtime.onMessage relay
- MAIN world: window.postMessage with origin check
- Script execution: browser.scripting.executeScript with world:'MAIN'
- Idempotency: content-main.js caches executed commands in a page-lifetime
  `window.__safariPilotExecutedCommands` Map keyed by `params.commandId`;
  repeat calls for the same id return the cached result instead of re-running.

### Event-Page Lifecycle (commit 1a, v0.1.5)
- Manifest: `background = {scripts:['background.js'], persistent:false}`; `alarms` permission required for keepalive.
- No IIFE, no ES modules: Safari re-evaluates the script on every wake; listeners must be registered at top level.
- Wake sequence (run on every init: onStartup / onInstalled / alarm / session_* / script_load):
  1. `readPending()` — re-deliver any `completed` results from `storage.local[safari_pilot_pending_commands]` left un-acked by a prior wake.
  2. Announce `{type:'connected'}` to the daemon (idempotent on `ExtensionBridge`).
  3. Drain the daemon queue via `{type:'poll'}` in a loop — supports `{commands:[...]}` (Task 3) with `{command:{...}}` legacy fallback — executing each command and sending `{type:'result'}`.
- Keepalive: `browser.alarms` named `safari-pilot-keepalive` fires every 1 min, emits `alarm_fire` log (ingested by `HealthStore.lastAlarmFireTimestamp`) and re-runs the wake sequence.
- Pending-command persistence uses `storage.local` key `safari_pilot_pending_commands` (status `executing` → `completed`); profile identity persisted under `safari_pilot_profile_id`.
- **DEBUG_HARNESS force-unload hook:** A `browser.runtime.onMessage` listener responds to `{type: '__safari_pilot_test_force_unload__'}` by calling `browser.runtime.reload()` after a 50ms delay — used by e2e tests to simulate cold-wake. Gated inside `/*@DEBUG_HARNESS_BEGIN@*/ … /*@DEBUG_HARNESS_END@*/` markers; stripped from release builds by `build-extension.sh`.

### Initialization System (2026-04-23)

MCP `initialize()` blocks until all systems are green. Every tool call does a live health check. Transparent recovery on disconnect.

- **Startup sequence** (`server.ts:start()`): Runs BEFORE any tool is available.
  1. `registerWithDaemon()` — POST `/session/register` with sessionId. Returns count of existing sessions.
  2. `ensureSessionWindow()` — Opens new Safari window with session dashboard (`127.0.0.1:19475/session?id=<sessionId>`). Captures `_sessionWindowId`. **Throws `SessionWindowInitError` (T11, 2026-04-24) if the AppleScript fails or returns an unparseable window id** — propagates through `start()` → `main()` so the MCP server exits with a clear error instead of silently continuing into a wedged state that surfaces 15s later as a misleading "extension not connected" message.
  3. Poll `GET /status` every 1s for 15s until `ext: true`. Updates `engineAvailability`.
  4. Store `_initMeta` (sessionId, windowId, existingSessions, systems, initDurationMs).
  5. Log progress to stderr: "found N existing sessions", "waiting for extension", "all systems green (Nms)".

- **Pre-call health gate** (`executeToolWithSecurity()` top): Runs BEFORE every tool call.
  1. `checkExtensionStatus()` — HTTP GET `/status?sessionId=X` (2s timeout). Returns `{ext, mcp, sessionTab, lastPingAge, activeSessions}`.
  2. `checkWindowExists()` — AppleScript: `exists window id N` (2s timeout).
  3. If both green → update `engineAvailability`, proceed.
  4. If anything down → `recoverSession()`: reopen window if gone, poll for extension up to 10s.
  5. If recovery fails → throw `SessionRecoveryError` with details of what's down.

- **Multi-session isolation**: Each MCP session gets its own Safari window. Daemon's `HealthStore.activeSessions` tracks registered sessions (60s stale pruning). `/status?sessionId=X` heartbeats the session implicitly.

- **Session dashboard** (`GET /session?id=<sessionId>`): Shows session ID, extension status, MCP connection, last command, uptime. Polls `/health` every 5s.

- **Keepalive** (`content-isolated.js`): On the session page URL, content script sends `runtime.sendMessage({type:'keepalive'})` every 20s. Background.js forwards via `__keepalive__` sentinel to daemon's HealthStore.

- **Alarm backup**: 1-minute `browser.alarms` fires as belt-and-suspenders.

### Shutdown Lifecycle (2026-04-23, T10)

The MCP server runs one Safari window per process lifetime (`_sessionWindowId`). A crash or exit without cleanup leaves that window behind, and vitest — which spawns a new server per test file — accumulates hundreds of orphans.

- **Signal handlers** (`src/index.ts`): `SIGINT` and `SIGTERM` are registered BEFORE `safariPilot.start()`, because `start()` blocks up to ~10s waiting for the extension. If the harness sends SIGTERM during that interval (exactly when vitest tears down a test file) and the handler isn't wired yet, Node's default termination path fires and the window leaks. Handlers are idempotent (guarded by `shuttingDown`), race shutdown against a 3s hard timeout, and exit with 130 (SIGINT) / 143 (SIGTERM).
- **`SafariPilotServer.shutdown()`**: closes the session window first, then calls `engine.shutdown()` for each engine. Order matters: closing via AppleScript is independent of the engine pool, but running it first ensures we don't burn the 3s budget on engine teardown and leave the window open.
- **`closeSessionWindow()`**: `osascript -e 'tell application "Safari" to if (exists window id N) then close window id N'` with a 3s execSync timeout. Traces `session_window_close_start` / `session_window_closed` / `session_window_close_failed`.
- **AppleScript ghost-reference quirk**: after `close window id N` succeeds, Safari keeps the AppleScript dictionary entry alive, so `exists window id N` returns `true` indefinitely. `visible of window id N` is the truthful signal — it flips to `false` at close. The T10 test asserts on `visible`, not `exists` (see `test/e2e/signal-shutdown.test.ts`).
- **Uncatchable signals**: `SIGKILL` and process crashes bypass this path by design. The next session's `registerWithDaemon()` is responsible for surfacing stale state; there is no userspace way to close a Safari window after process death.

### ExtensionBridge Command Queue
- In-memory queue (not file-based — sandbox blocks filesystem access)
- handleExecute: queues command + suspends via CheckedContinuation; fast-paths a waiting long-poll if one is registered
- handlePoll: drains ALL undelivered commands at once (`{commands: [...]}`), marks them delivered=true; supports long-poll via `waitTimeout` (default 0.0 returns `{commands: []}` immediately)
- handleResult: matches by requestId, resumes continuation; if result contains `_meta` key, wraps as `{"value": innerValue, "_meta": meta}` for ExtensionEngine to extract

### _meta Tab Identity Propagation (2026-04-21)
- **background.js** enriches every successful `executeCommand()` result with `_meta: { tabId: tab.id, tabUrl: tab.url }` — `tab` is from `findTargetTab()`, guaranteed non-null by that point
- **ExtensionBridge.swift** detects `_meta` in the result dict and wraps the response as `{"value": innerValue, "_meta": meta}` (backward-compatible: absent `_meta` returns `innerValue` directly)
- **DaemonEngine** (daemon.ts:179) JSON.stringifies object values, so the wrapper passes through as a string
- **ExtensionEngine** (extension.ts) `JSON.parse`s the result, detects `_meta` key, extracts into `EngineResult.meta`, unwraps inner value
- **EngineProxy** captures `result.meta` from `executeJsInTab()` into `_lastMeta`; server reads via `getLastMeta()` after tool execution
- Timeout: 30s, cancels via Task
- Disconnect (event-page wake semantics): flips `delivered=true → false` on unacked commands so the next poll redelivers them; clears waiting long-polls with empty commands array. Pending commands are NEVER cancelled on disconnect — the event page unloads aggressively and will wake + poll shortly.

### Daemon State Files (`~/.safari-pilot/`)
- `health.json` — extension-engine observability state produced by `HealthStore.swift`. Persisted: `lastAlarmFireTimestamp` + `forceReloadTimestamps` (24h rolling window, filtered on write). In-memory only (reset on daemon restart): `roundtripCount1h`, `timeoutCount1h`, `uncertainCount1h`. Consumed starting in Commit 1a (v0.1.5).

### Dispatcher ↔ HealthStore routes (Commit 1a)
- `extension_log` — breadcrumb/telemetry from `background.js`. Messages with prefix `alarm_fire` advance `HealthStore.lastAlarmFireTimestamp` (persisted), letting `/health` surface wake-tick progress across daemon restarts. All messages are logged via `Logger.info("EXT-LOG: …")`. Returns `"log_ack"`.
- `extension_health` — composite snapshot via `ExtensionBridge.healthSnapshot(store:)`: `isConnected` + `pendingCommandsCount` from the bridge, `lastAlarmFireTimestamp` / `lastReconcileTimestamp` / `lastExecutedResultTimestamp` / `roundtripCount1h` / `timeoutCount1h` / `uncertainCount1h` / `forceReloadCount24h` from `HealthStore`. `executedLogSize`, `claimedByProfiles`, `engineCircuitBreakerState`, `killSwitchActive` are placeholders wired in Commit 1b.

---

## Extension Build Pipeline

**Source of truth for handler:** `extension/native/SafariWebExtensionHandler.swift`

**Manifest change (v0.1.5):** `extension/manifest.json` specifies `background: {scripts:['background.js'], persistent:false}` (MV3 event page). Prior to v0.1.5 this was `background: {service_worker:'background.js'}` (MV3 service worker). The event-page form allows Safari to manage the page lifecycle (suspend/wake) while preserving top-level listener registration.

The Xcode project is REGENERATED on every build by `safari-web-extension-packager`. This overwrites the handler with a stub. The build script (`scripts/build-extension.sh`) copies our custom handler AFTER project generation.

Build steps:
1. `safari-web-extension-packager` generates Xcode project (creates stub handler)
2. **Custom handler copied** from `extension/native/` → overwrites stub
3. pbxproj patched: bundle ID, version, signing identity
4. **Entitlements created**: app-sandbox + files.user-selected.read-only + **network.client** (extension needs TCP)
5. Entitlements injected into pbxproj via python3 (macOS sed doesn't handle tabs)
6. xcodebuild archive → export → sign
7. notarytool submit → stapler staple
8. Copy to bin/Safari Pilot.app

**Entitlements (extension appex):**
- `com.apple.security.app-sandbox` — required for App Store/notarization
- `com.apple.security.files.user-selected.read-only` — basic file access
- `com.apple.security.network.client` — **outbound TCP to daemon socket**

**DEBUG_HARNESS compile-time flag:** `extension/build.config.js` documents the flag; `scripts/build-extension.sh` (Step 1c) strips `/*@DEBUG_HARNESS_BEGIN@*/ … /*@DEBUG_HARNESS_END@*/` blocks from bundled `background.js` / `content-*.js` when `SAFARI_PILOT_TEST_MODE != "1"`. Used by Task 18's force-unload test hook.

---

## Tool Modules

78 tools across 17 modules. 12 modules accept `IEngine` interface (engine-agnostic). 2 modules (navigation, compound) use `AppleScriptEngine` for tab management. 2 modules (downloads, pdf) get engine from server. 1 module (extension-diagnostics) proxies the daemon's `extension_health` dispatch via `DaemonEngine.sendRawCommand`.

Every tool declares `requirements.idempotent: boolean` (required field — no default). Non-idempotent tools (click, type, fill, select_option, press_key, hover, drag, scroll, navigate*, reload, cookie writes, storage writes, permission_set, override_*, mock_request, network_offline/throttle, websocket_listen, emergency_stop, evaluate, eval_in_frame, switch_frame, compound tools that mutate state) MUST NOT be auto-retried on an ambiguous Extension-engine disconnect. The `EXTENSION_UNCERTAIN` error (Task 7) surfaces disconnect-during-execution and relies on this flag to decide retry safety.

| Module | Tools | Engine Type |
|--------|-------|-------------|
| navigation.ts | 7 | AppleScriptEngine |
| interaction.ts | 11 | IEngine |
| extraction.ts | 7 | IEngine |
| network.ts | 8 | IEngine |
| storage.ts | 11 | IEngine |
| shadow.ts | 2 | IEngine |
| frames.ts | 3 | IEngine |
| permissions.ts | 6 | IEngine |
| clipboard.ts | 2 | IEngine |
| service-workers.ts | 2 | IEngine |
| performance.ts | 3 | IEngine |
| structured-extraction.ts | 5 | IEngine |
| wait.ts | 1 | IEngine |
| compound.ts | 4 | AppleScriptEngine |
| downloads.ts | 1 | via server |
| pdf.ts | 1 | via server |
| extension-diagnostics.ts | 2 | DaemonEngine (read-only) |
| server.ts (direct) | 2 | N/A (health_check, emergency_stop) |

**`extension-diagnostics.ts`** adds 2 observability tools: `safari_extension_health` and `safari_extension_debug_dump`. Both are idempotent, read-only, and route through the daemon's `extension_health` dispatch (Task 5). When the daemon is unavailable the tools return a degraded response (`degradedReason: 'daemon_unavailable'`) instead of throwing. At 1a the two tools overlap closely; at 1b `safari_extension_debug_dump` will additionally proxy extension-side `storage.local` state.

---

## Test Architecture

**Status (2026-04-23):** All previous unit, integration, and e2e tests were deleted — they were mock-based fakes that provided false confidence while the product was broken. Tests are being rebuilt from zero with live-only validation.

### E2E Tests (test/e2e/) — 7 files, 34 tests

**Shared harness (2026-04-23, T-Harness):** one MCP server per test run, not per file. Production runs one server per Claude Code session; the test suite now mirrors that. `test/helpers/shared-client.ts` exposes `getSharedClient()` — first call spawns + initializes; subsequent calls (any file, any test) return the same instance with a shared `nextId()` monotonic counter.

Vitest config is load-bearing: `pool: 'forks' + poolOptions.forks.singleFork: true + isolate: false`. Remove any and every test file gets its own fork and its own "singleton" — i.e. one MCP server per file, which is exactly the bug this refactor fixed.

Teardown (three layers, idempotent):
1. Setup file `afterAll` (primary) — registered via `setupFiles: ['./test/helpers/shared-teardown.ts']`, fires after the last test in the last file.
2. `process.on('beforeExit')` (backup) — catches paths where the setupFile didn't register.
3. T10's server-side SIGTERM handler — catches `kill -TERM` or abort on the worker.

Per-test isolation is via unique URL markers: every `safari_new_tab` call uses `?sp_<file>_<purpose>=${Date.now()}` so trace assertions scanning the shared `~/.safari-pilot/trace.ndjson` can filter to this test's events. Tests MUST close any tabs they open in try/finally or `afterAll`.

Carve-outs (files that intentionally do NOT use the shared client):
- `signal-shutdown.test.ts` — tests the signal handler itself, needs fresh spawns.
- `initialization.test.ts` — one of its tests measures first-spawn init latency, so it does its own `initClient` + `close` alongside the shared client used by the other tests.

| File | Tests | What it proves |
|------|-------|---------------|
| `initialization.test.ts` | 5 | Init blocks until green, health check returns metadata, new_tab + evaluate through extension engine, pre-call gate |
| `phase1-core-navigation.test.ts` | 6 | navigate, list_tabs, screenshot, back/forward, close_tab |
| `phase2-page-understanding.test.ts` | 6 | ARIA snapshot with refs, get_text, get_html, extract_links, extract_metadata, engine verification |
| `phase3-interaction.test.ts` | 4 | fill (verified readback), click, wait_for, engine verification |
| `phase5-storage-async.test.ts` | 2 | T6 — IDB tools await async JS, seeded DB visible via list + get |
| `security-ownership.test.ts` | 9 | T1/T2/T5/T7/T8 — ownership registry, schema-required tabUrl, fail-closed on unknown URL, no fake switch_frame envelope |
| `signal-shutdown.test.ts` | 2 | T10 — SIGTERM/SIGINT close the session window (asserts on `visible of window id`, not `exists`) |

### Daemon Tests (daemon/Tests/) — 51 tests
- ExtensionSocketServer, ExtensionBridge, CommandDispatcher, HealthStore, SleepWakeMemoryRecovery
- These are real Swift tests, not mocked — kept from before the purge

### Trace Capture (mandatory)
All test runs capture structured JSONL traces for the recipe system's learning pipeline. See CLAUDE.md "Trace capture" section for format and rules.

---

## Litmus Tests

If any of these would NOT fail a test, the test suite is incomplete:

| What if... | Which test should fail |
|------------|----------------------|
| Extension engine never connects | initialization.test.ts (init blocks until green) |
| Session window doesn't open | initialization.test.ts (health check has no windowId) |
| safari_new_tab doesn't work | initialization.test.ts + all phase tests (beforeAll fails) |
| safari_evaluate times out in new tabs | initialization.test.ts (evaluate test) |
| ARIA snapshot returns no refs | phase2 (snapshot test checks ref=) |
| safari_fill doesn't set value | phase3 (fill test reads value back) |
| Engine selector always picks daemon | initialization.test.ts + phase2 (engine verification tests) |
| Remove executeJsInTab from IEngine | Compile error in 12 tool modules |

**Coverage gaps (known, to be addressed in later phases):**
- No test proves security pipeline fires (tab ownership, IDPI, rate limiter)
- No test proves extension→daemon fallback
- No test proves shadow DOM access
- No test proves multi-session isolation
- No test proves navigate_back/forward

---

## Version History

| Date | Change | Verified By |
|------|--------|-------------|
| 2026-04-15 | CSP bypass: content script relay, error propagation fix, HumanApproval action mapping | 41 daemon tests (at time), 1378 unit tests (at time), 74 e2e tests |
| 2026-04-15 | Extension engine operational: TCP proxy handler, daemon socket, in-memory bridge | Manual: document.title on example.com. E2E: 74 tests, _meta.engine assertions |
| 2026-04-15 | All 9 security layers wired | Unit: 1378 pass. E2E: security-pipeline tests |
| 2026-04-15 | Engine selection invoked every call | E2E: engine-selection tests assert _meta.engine |
| 2026-04-14 | PDF generation via WKWebView.createPDF | E2E: pdf-generation tests verify real PDFs |
| 2026-04-14 | Download handling via FSEvents | E2E: downloads tests (tool existence verified) |
| 2026-04-14 | Shadow DOM slot traversal fix | Integration: Reddit 82→18178 chars |
| 2026-04-14 | Click navigation via el.href | Integration: links actually navigate |

### v0.1.5 (Commit 1a) — 2026-04-17
Event-page lifecycle pivot: service_worker → non-persistent event page, storage-backed command queue, 1-minute alarm keepalive, drain-on-wake via sendNativeMessage. HealthStore observability + safari_extension_health/debug_dump tools. Per-tool idempotent flag (76→78 tools). Per-engine CircuitBreaker. Extension kill-switch via config. Pre-publish verify harness + LaunchAgent health-check cron.

### v0.1.10 — 2026-04-23 (Saving the Project)
All 1470 mock-based tests deleted. Initialization system: MCP init blocks until all systems green, pre-call live health gate, transparent 10s recovery, multi-session detection + session registry, SessionRecoveryError. Bug 6 fix: content script reads sp_cmd on init (storage bus timeout in new tabs). 19 real e2e tests across 4 files — all against real Safari through extension engine. Trace capture for all test runs (tool-calls.jsonl, stderr.log, server/daemon NDJSON). Phases 1-3 validated: navigate, new_tab, close_tab, list_tabs, evaluate, screenshot, ARIA snapshot with refs, get_text, get_html, extract_links, extract_metadata, fill, click, wait_for.

### v0.1.6 (Commit 2) — 2026-04-18
HTTP short-poll IPC pivot: sendNativeMessage → fetch() to daemon HTTP:19475 (Hummingbird). Reconcile protocol (5-case classification: acked/uncertain/reQueued/inFlight/pushNew). executedLog with 5-min TTL. Disconnect detection (15s poll-gap timeout). Handler stripped to stub. TCP:19474 preserved for DaemonEngine/health-checks/benchmarks. Extension version 0.1.6. HTTP observability: `httpBindFailureCount` (persisted), `httpRequestErrorCount1h` (rolling 1h), `HTTP_READY` / `HTTP_SELF_TEST` startup logs, `onServerRunning` callback. Test result capture: JUnit XML + JSON to `test-results/` (last 10 runs retained via vitest globalSetup). Benchmark data: `benchmark/history.json` + `benchmark/reports/` + `benchmark/traces/` (unchanged).
