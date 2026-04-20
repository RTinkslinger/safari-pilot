# Safari Pilot Architecture — Canonical Source of Truth

*Last verified: 2026-04-20 | Branch: fix/e2e-test-tab-ownership*

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
  │ content-isolated.js reads via storage.onChanged listener
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
| 2 | **TabOwnership** | Agent can only touch tabs it created via safari_new_tab | server.ts:403 |
| 3 | **DomainPolicy** | Per-domain trust levels, blocked domains list | server.ts:414 |
| 4 | **HumanApproval** | Blocks sensitive actions on OAuth/financial URLs | server.ts:418 |
| 5 | **RateLimiter** | 120 actions/min global, per-domain buckets | server.ts:452 |
| 6 | **CircuitBreaker** | 5 errors on a domain → 120s cooldown (see dual-scope note below) | server.ts:459 |
| 7 | **Engine Selection** | Picks best available engine for tool's requirements | server.ts:463 |
| — | **Tool Execution** | Calls the tool handler with selected engine | server.ts:558 |
| 8 | **IdpiScanner** | Post-execution: scans extraction results for prompt injection | server.ts:575 |
| 9 | **ScreenshotRedaction** | Post-execution: attaches redaction script for banking/cross-origin | server.ts:591 |
| 10 | **AuditLog** | Post-execution: records tool, URL, engine, params, result, timing | server.ts:596 |

**CircuitBreaker dual scope (src/security/circuit-breaker.ts):** The breaker carries two INDEPENDENT scopes on the same instance.
- **Per-domain scope** (existing): 5 failures in a 60s rolling window → 120s cooldown. API: `recordFailure(domain)` / `recordSuccess(domain)` / `isOpen(domain)` / `getState(domain)` / `assertClosed(domain)`. Runs inline at layer 6.
- **Per-engine scope** (new, Task 9): 5 extension-lifecycle errors in a 120s rolling window → 120s cooldown. API: `recordEngineFailure(engine, errorCode)` / `isEngineTripped(engine)` / `getEngineState(engine)`. Only `EXTENSION_TIMEOUT`, `EXTENSION_UNCERTAIN`, and `EXTENSION_DISCONNECTED` count; all other codes are ignored. `engine-selector.selectEngine(tool, available, breaker?)` honors this scope — when the extension breaker is tripped, selection falls back to daemon/applescript for non-extension-required tools and throws `EngineUnavailableError` for extension-required tools. The two scopes never interact — domain failures do not trip the engine breaker, and engine failures do not trip the domain breaker. `getEngineState` backs the `engineCircuitBreakerState` field of the `extension_health` snapshot.

**Extension kill-switch (Task 13, safari-pilot.config.json):** The config now has an `extension` section with `enabled: boolean` + `killSwitchVersion: string`. When `extension.enabled=false`, `selectEngine` skips the Extension engine (tools requiring it throw `EngineUnavailableError`; others fall back to daemon/applescript). This is the 30-second config-only rollback path for the Extension engine — no rebuild/sign/notarize required.

**Engine-degradation security re-run (Task 10, src/server.ts step 7.5):** When the Extension engine is available and its breaker is closed but `selectEngine` returns a non-extension engine, the pipeline calls `HumanApproval.invalidateForDegradation(tool)` + `IdpiScanner.invalidateForDegradation(tool)` and re-asserts `HumanApproval.assertApproved` against the fallback engine's action surface. `metadata.degradedReason` is set to `extension_unavailable_fallback_to_<engine>` (or `extension_degraded_approval_required: <msg>` if approval now fails). The `invalidate*` methods are no-ops at 1a — HumanApproval and IdpiScanner are stateless — and exist for API symmetry with future engine-aware caching (commit 1c).

**EXTENSION_UNCERTAIN (src/errors.ts):** Typed error for the non-idempotent + Extension-engine ambiguous disconnect case. Carries `StructuredUncertainty { disconnectPhase, likelyExecuted, recommendation }` surfaced on `ToolError.uncertainResult`. `retryable=false` — the caller decides whether to probe page state or retry; the pipeline never auto-retries.

**INFRA_MESSAGE_TYPES (src/server.ts):** Documented bypass set for daemon↔extension infrastructure methods — `extension_poll`, `extension_drain`, `extension_reconcile`, `extension_connected`, `extension_disconnected`, `extension_log`, `extension_result`. These are coordination messages, not per-domain tool calls, and must never traverse the 9-layer pipeline. Commit 1a declares the contract as an exported `ReadonlySet<string>`; Commit 1b wires the reconcile + drain routes. These messages currently flow via `ExtensionSocketServer` + NDJSON dispatcher in the daemon, never reaching `executeToolWithSecurity` (whose name parameter only receives registered `safari_*` tool names). No pre-pipeline bypass check is required at 1a — the constant is declarative and becomes enforcement-wired when 1b introduces the reconcile/drain routes.

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

### ExtensionBridge Command Queue
- In-memory queue (not file-based — sandbox blocks filesystem access)
- handleExecute: queues command + suspends via CheckedContinuation; fast-paths a waiting long-poll if one is registered
- handlePoll: drains ALL undelivered commands at once (`{commands: [...]}`), marks them delivered=true; supports long-poll via `waitTimeout` (default 0.0 returns `{commands: []}` immediately)
- handleResult: matches by requestId, resumes continuation
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

### E2E Tests (test/e2e/) — 17 files, 74+ tests
- Spawn real `node dist/index.js`, talk JSON-RPC
- Zero mocks, zero source imports
- Verify `_meta.engine` on every tool response (architecture test, not just functional)
- Extension-required tools assert engine='extension' or proper rejection with degraded=true
- Tests create own tabs, clean up in afterAll, never touch user tabs
- Litmus: deleting SafariWebExtensionHandler.swift would fail extension-engine and engine-selection tests

### Integration Tests (test/integration/) — including extension-build (10 tests)
- Verify built artifacts: entitlements, code signing, handler is not stub
- Gate tests verify tool count (76 — pre-extension-diagnostics baseline; the 2 extension-diagnostics tools are registered at server startup but not yet reflected in gate test constants)

### Unit Tests (test/unit/) — 55 files, 1427 tests
- Extension unit tests verify protocol contracts (sentinel format, payload structure)
- Engine selector tests cover all requirement combinations
- Security layer tests cover each layer in isolation

### Daemon Tests (daemon/Tests/) — 51 tests
- ExtensionSocketServer: TCP accept, ping dispatch, concurrent connections, invalid JSON
- ExtensionBridge: queue/poll/result cycle, timeout, disconnect flip-back redelivery
- CommandDispatcher: routing, NDJSON parsing, extension_poll, extension_log, extension_health
- HealthStore: persistence to `~/.safari-pilot/health.json`, alarm-fire timestamp, rolling window counters
- SleepWakeMemoryRecovery: memory pressure + sleep/wake resilience

---

## Litmus Tests

If any of these would NOT fail a test, the test suite is incomplete:

| What if... | Which test should fail |
|------------|----------------------|
| Delete SafariWebExtensionHandler.swift | e2e/extension-engine, e2e/engine-selection |
| Remove selectEngine() call from server | e2e/engine-selection (engine field wrong) |
| Remove HumanApproval from pipeline | e2e/security-pipeline (OAuth test) |
| Remove IdpiScanner.scan() call | e2e/security-pipeline (IDPI metadata) |
| Remove network.client entitlement | integration/extension-build (entitlements check) |
| Change daemon socket port | Extension can't connect → extension status = disconnected |
| Remove executeJsInTab from IEngine | Compile error in 12 tool modules |

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

### v0.1.6 (Commit 2) — 2026-04-18
HTTP short-poll IPC pivot: sendNativeMessage → fetch() to daemon HTTP:19475 (Hummingbird). Reconcile protocol (5-case classification: acked/uncertain/reQueued/inFlight/pushNew). executedLog with 5-min TTL. Disconnect detection (15s poll-gap timeout). Handler stripped to stub. TCP:19474 preserved for DaemonEngine/health-checks/benchmarks. Extension version 0.1.6. HTTP observability: `httpBindFailureCount` (persisted), `httpRequestErrorCount1h` (rolling 1h), `HTTP_READY` / `HTTP_SELF_TEST` startup logs, `onServerRunning` callback. Test result capture: JUnit XML + JSON to `test-results/` (last 10 runs retained via vitest globalSetup). Benchmark data: `benchmark/history.json` + `benchmark/reports/` + `benchmark/traces/` (unchanged).
