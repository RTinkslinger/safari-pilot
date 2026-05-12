# Safari Pilot Architecture — Canonical Source of Truth

*Last verified: 2026-05-03 | Branch: main | Latest tag: v0.1.24*

**This document describes how Safari Pilot ACTUALLY works as shipped. Every statement is backed by verified evidence. If code changes contradict this document, either the code is wrong or this document must be updated — never silently diverge.**

**Update rule:** Any commit that changes component behavior, data flow, IPC protocol, security pipeline order, engine selection logic, or test architecture MUST update this document in the same commit.

---

## System Overview

Safari Pilot is a native Safari browser automation framework exposing **82 tools** via MCP (stdio). It controls Safari through three engine tiers, protected by 7 pre-execution security layers + 3 post-execution checks.

```
Claude Code / AI Agent
        │
        │ MCP JSON-RPC over stdin/stdout
        ▼
┌─────────────────────────────────┐
│  MCP Server (src/index.ts)      │
│  ┌───────────────────────────┐  │
│  │ SafariPilotServer         │  │
│  │  • 82 tools registered    │  │
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
**Capabilities:** Shadow DOM (open), CSP bypass (partial — MAIN world only), dialog interception, network interception, framework detection.

**Cross-origin frames (T34, 2026-04-26): NOT supported.** `extension/manifest.json` content_scripts entries default to top-frame injection only — they lack `all_frames: true`. The extension cannot read, query, or interact with cross-origin iframe DOMs. `ENGINE_CAPS.extension.framesCrossOrigin` was flipped to `false` to match this reality and is guarded by `test/unit/engine-selector/cap-manifest-parity.test.ts`. Cross-origin support is tracked under **T55a** (frame-aware storage-bus routing — the actual prereq) — landing T55a + manifest `all_frames: true` will require flipping the cap back in the same commit (the parity test enforces this). T55 was reduced to docs-only on 2026-04-29 after audit re-read established that a manifest-only flip would race the single-slot `sp_result` storage key across frames.

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

**`safari_evaluate` engine routing (SD-01, 2026-04-25):** The async wrapper above only resolves correctly when the engine awaits Promise-returning injected scripts. Per `engine-selector.ts`, only the extension engine has `EngineCapabilities.asyncJs === true`; daemon and AppleScript serialize the IIFE's Promise as `{}` or `[object Promise]`. The tool definition declares `requirements.requiresAsyncJs: true`, so `selectEngine` routes `safari_evaluate` to the extension engine when available and throws `EngineUnavailableError` (with code `EXTENSION_REQUIRED`) when extension is config-killed, breaker-tripped, or not yet connected — never silently falling through to daemon/applescript. Same pattern as `safari_idb_list` / `safari_idb_get` (T6). Covered by `test/unit/tools/extraction-requirements.test.ts`.

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

**Response metadata:** Every MCP response includes `_meta.engine` reflecting the engine selector's choice. For proxy-based tools (12 of 17 modules), `_meta.engine` reflects BOTH selector choice AND physical execution engine. For direct-engine tools (Navigation, Compound, Download, PDF) and the daemon-direct ExtensionDiagnostics tool, `_meta.engine` reflects selector choice only — physical execution uses a hardcoded engine (AppleScript, daemon, or server).

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
| 9 | **IdpiAnnotator** | Post-execution: scans extraction results for prompt-injection patterns and annotates `_meta` (never blocks; T35). `EXTRACTION_TOOLS` Set extended in v0.1.31 to include `safari_dismiss_overlays` so its `content[0].text` summary is scanned. | server.ts:920 |
| 10 | **AuditLog** | Post-execution: records tool, URL, engine, params, result, timing | server.ts:659 |

**Note (T36, 2026-04-26):** A "ScreenshotRedaction" layer was previously documented at slot 10. It was deleted as a no-op — the module returned a CSS-blur script in `_meta.redactionScript` but the script was never injected into the page before `screencapture -x` ran, and `screencapture` is OS-level so CSS blur in the DOM doesn't apply to it anyway.

**ScreenshotPolicy (T59, 2026-04-26, `src/security/screenshot-policy.ts`):** Handler-level guard inside `ExtractionTools.handleTakeScreenshot`. Runs BEFORE `screencapture -x` is invoked — the policy check is the first thing in the handler body, outside the inner try-catch, so `ScreenshotBlockedError` propagates directly to `executeToolWithSecurity` and is formatted as a `SCREENSHOT_BLOCKED` degraded response.

- **Seed list**: `BANKING_DOMAIN_SEED` — anchored hostname-regex patterns for chase.com, paypal.com, wellsfargo.com, bankofamerica.com, citibank.com, hsbc.com, barclays.com, stripe.com, venmo.com, plus `/(^|\.)bank\./i` (TLD-agnostic).
- **Override semantics**: if `screenshotPolicy.blockedPatterns` is set in `safari-pilot.config.json`, the seed list is REPLACED (not merged). The config field is validated as `string[]`.
- **Fail-open behaviour**: if `tabUrl` is absent or not a string (e.g. null), the policy is skipped — screencapture proceeds. Parse errors inside `ScreenshotPolicy.checkDomain` (malformed URL) also fail open. Parseable non-HTTP URLs (e.g. `ftp://paypal.com`) are still checked against the seed (hostname extraction succeeds).
- **TOCTOU note**: the policy checks `params.tabUrl` at call time. If a tab navigates to a banking domain between when the URL was recorded and when this check runs, the registry URL may not reflect the blocked domain. The wiring in handler-level position (not security-pipeline position) is intentional — `safari_take_screenshot` takes a whole-screen capture, not a tab-specific one; `tabUrl` is metadata, not the interaction target.
- **Wiring**: `server.ts` passes `new ScreenshotPolicy(this.config.screenshotPolicy)` as the second constructor arg to `ExtractionTools`. If `screenshotPolicy` key is absent from config, `ScreenshotPolicy` defaults to the seed list.
- **Injection seam**: `ExtractionTools` accepts an optional third constructor arg `screencaptureRunner` (production: `defaultScreencaptureRunner` via `childProcess.execFile`). Unit tests inject a `vi.fn()` stub directly — no `vi.mock('node:child_process')` needed.

**CircuitBreaker dual scope (src/security/circuit-breaker.ts):** The breaker carries two INDEPENDENT scopes on the same instance.
- **Per-domain scope** (existing): 5 failures in a 60s rolling window → 120s cooldown. API: `recordFailure(domain)` / `recordSuccess(domain)` / `isOpen(domain)` / `getState(domain)` / `assertClosed(domain)`. Runs inline at layer 6.
- **Per-engine scope** (Task 9; wired 2026-04-24, T12): 5 extension-lifecycle errors in a 120s rolling window → 120s cooldown. API: `recordEngineFailure(engine, errorCode)` / `isEngineTripped(engine)` / `getEngineState(engine)`. Only `EXTENSION_TIMEOUT`, `EXTENSION_UNCERTAIN`, and `EXTENSION_DISCONNECTED` count; all other codes are ignored. `engine-selector.selectEngine(tool, available, breaker?)` honors this scope — when the extension breaker is tripped, selection falls back to daemon/applescript for non-extension-required tools and throws `EngineUnavailableError` for extension-required tools. The two scopes never interact — domain failures do not trip the engine breaker, and engine failures do not trip the domain breaker. `getEngineState` backs the `engineCircuitBreakerState` field of the `extension_health` snapshot. **Wiring**: `server.ts`'s `executeToolWithSecurity` error-path calls `this.recordToolFailure(domain, engine, error)`, which fires both scopes. Pre-T12 only the per-domain side was called; engine breaker was defined but never incremented.

**Extension kill-switch (Task 13, safari-pilot.config.json):** The config now has an `extension` section with `enabled: boolean` + `killSwitchVersion: string`. When `extension.enabled=false`, `selectEngine` skips the Extension engine (tools requiring it throw `EngineUnavailableError`; others fall back to daemon/applescript). This is the 30-second config-only rollback path for the Extension engine — no rebuild/sign/notarize required.

**Engine-degradation security re-run (Task 10, src/server.ts step 7.5):** When the Extension engine is available and its breaker is closed but `selectEngine` returns a non-extension engine, the pipeline calls `HumanApproval.invalidateForDegradation(tool)` + `IdpiAnnotator.invalidateForDegradation(tool)` and re-asserts `HumanApproval.assertApproved` against the fallback engine's action surface. `metadata.degradedReason` is set to `extension_unavailable_fallback_to_<engine>` (or `extension_degraded_approval_required: <msg>` if approval now fails). The `invalidate*` methods are no-ops — HumanApproval and IdpiAnnotator are stateless — and exist for API symmetry with future engine-aware caching.

**EXTENSION_UNCERTAIN (src/errors.ts):** Typed error for the non-idempotent + Extension-engine ambiguous disconnect case. Carries `StructuredUncertainty { disconnectPhase, likelyExecuted, recommendation }` surfaced on `ToolError.uncertainResult`. `retryable=false` — the caller decides whether to probe page state or retry; the pipeline never auto-retries.

**INFRA_MESSAGE_TYPES (src/server.ts):** Documented bypass set for daemon↔extension infrastructure methods — `extension_poll`, `extension_drain`, `extension_reconcile`, `extension_connected`, `extension_disconnected`, `extension_log`, `extension_result`. These are coordination messages, not per-domain tool calls, and must never traverse the 9-layer pipeline. Commit 1a declares the contract as an exported `ReadonlySet<string>`; Commit 1b wires the reconcile + drain routes. These messages currently flow via `ExtensionSocketServer` + NDJSON dispatcher in the daemon, never reaching `executeToolWithSecurity` (whose name parameter only receives registered `safari_*` tool names). No pre-pipeline bypass check is required at 1a — the constant is declarative and becomes enforcement-wired when 1b introduces the reconcile/drain routes.

**Tab ownership enforcement (identity-based, 2026-04-21):**

Dual-key registry: tabs are tracked by both positional `TabId` (windowIndex * 1000 + tabIndex) and stable `extensionTabId` (Safari's `tab.id` from the extension). URL is mutable and refreshed on every extension-engine result.

- **Registration:** `safari_new_tab` registers with URL + null extensionTabId. The extensionTabId is backfilled on the first extension-engine tool call (via `_meta.tabId` in the result).
- **Ownership check flow (server.ts step 7d, after engine selection):**
  1. `findByUrl(tabUrl)` → if found, `assertOwnership(tabId)` (fast path)
  2. If URL not found AND extension engine selected → set `deferredOwnershipCheck = true` (deferred path; verified post-execution via `_meta.tabId`)
  3. If URL not found AND not extension engine → throw `TabUrlNotRecognizedError` (fail closed)
- **Post-execution verify (server.ts step 8.post2):**
  1. Read `engineProxy.getLastMeta()` — contains `_meta.tabId` + `_meta.tabUrl` from extension result
  2. Backfill `extensionTabId` on first call via `setExtensionTabId()`
  3. Refresh URL in registry via `findByExtensionTabId()` + `updateUrl()` (keeps `findByUrl` working for next call)
  4. If `deferredOwnershipCheck`: verify `findByExtensionTabId(extTabId)` returns an owned tab. If undefined → throw (tab not ours). If no `_meta` returned → throw (fail closed).
- **SKIP_OWNERSHIP_TOOLS:** `safari_list_tabs`, `safari_new_tab`, `safari_health_check` (navigate_back/forward now go through the deferred path)
- **Domain guard (T24, 2026-04-25):** Removed. The previous `domainMatches` method on `TabOwnership` (with ccTLD-aware `extractRegistrableDomain`) was unwired in `server.ts` at `75177e8` because it broke legitimate cross-domain link clicks. Per T24 we deleted the method (and the helper) rather than re-wire — the post-execution `_meta.tabId` verification at step 8.post2 already provides identity-based ownership without needing a pre-execution domain guard.
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

### Frame-Aware Storage Bus (T55a, 2026-05-02)

Cross-origin iframe access. Manifest sets `all_frames: true` on both content_scripts entries; every frame loads its own content-isolated.js and content-main.js. Storage keys are commandId-suffixed so concurrent commands across frames/tabs cannot race.

**Storage keys:**
- `sp_cmd_<commandId>` — written by background.js, read+filtered by every frame, removed by background after result.
- `sp_result_<commandId>` — written by exactly one frame (the one passing the routing filter), read by background's filtered listener.
- Idle-sweep at `executeCommand`'s outer scope reads `storage.local.get(null)`, prefix-scans `sp_cmd_*`/`sp_result_*`, removes any whose commandId is not in the live `pendingCommandIds` set.

**Routing rule (load-bearing, single source of truth in `extension/lib/route-command.js`, inlined into content-isolated.js):**
```
shouldProcess(cmd, myTabId, myFrameId, currentLocationHref):
  if cmd.tabId !== myTabId → false
  if myFrameId === null → null  (queue, handshake pending)
  if (cmd.frameId ?? 0) !== myFrameId → false
  if cmd.frameUrl != null && cmd.frameUrl !== currentLocationHref → false (emit FRAME_NAVIGATED)
  → true
```

**Lazy `sp_getFrameId` handshake (state machine in `extension/lib/handshake-machine.js`, inlined):**
- `IDLE` → first sp_cmd arrival → `AWAITING_FRAME_ID` (queue cmd, send sp_getFrameId message)
- `AWAITING_FRAME_ID` → response → `READY` (drain queue) | error → `IDLE` (next cmd retries)
- `READY` → process cmds immediately, no handshake needed
- Why lazy: every iframe sees every `sp_cmd_*` storage event. A 50-iframe page with one cross-frame command incurs 50 simultaneous handshakes. Eager registration would amplify on every page load.

**Frame discovery + validation:**
- `safari_list_frames` extension path uses `webNavigation.getAllFrames(tabId)` directly (via `__SP_LIST_FRAMES__` sentinel intercepted in background.js executeCommand). Returns `{frameId, parentFrameId, url}` per frame. AppleScript path falls back to top-frame DOM enumeration with `frameId: null`.
- `executeCommand` validates `cmd.frameId` via `webNavigation.getAllFrames` before any storage-bus write. Missing frame → `FRAME_NOT_FOUND` immediately. Successful match → `cmd.frameUrl` is re-resolved to `frame.url` so content-isolated.js's mutation guard has the authoritative value.

**Document-mutation guard:**
- Frame can navigate between dispatch-time validation (background) and storage-bus arrival (content-isolated.js).
- background writes `cmd.frameUrl = <validated frame.url>`; content-isolated.js compares to `location.href`.
- Mismatch → write `sp_result_<commandId>` with `FRAME_NAVIGATED` error.
- pagehide listener also fires `sp_frame_unloading` to background as a best-effort fast-fail signal (not guaranteed during teardown).

**Timeout discipline:**
- Top-frame commands: 30s storage-bus timeout (existing).
- Frame-targeted commands: 10s timeout, emits `FRAME_UNREACHABLE` on expiry as sandbox/CSP/injection-failure heuristic.

**`ENGINE_CAPS.extension.framesCrossOrigin: true`** with precision: covers typical cross-origin iframes via content-script injection. `FRAME_UNREACHABLE` returned for sandbox-without-`allow-scripts`, page CSP that blocks extension scripts, COOP/COEP-isolated frames, silent injection failures. Parity test (`test/unit/engine-selector/cap-manifest-parity.test.ts`) asserts `framesCrossOrigin === every-content_scripts-entry-has-all_frames`.

**Tool surface — 7 tools touched:**
- `safari_list_frames` — returns `frameId`/`parentFrameId`/`url` (extension) or `frameId: null` (AppleScript).
- `safari_eval_in_frame`, `safari_get_text`, `safari_get_html`, `safari_get_attribute`, `safari_query_shadow`, `safari_click_shadow` — accept optional `frameId`. Routed via shared `routeFrameAware` helper at `src/tools/_frame-routing-helper.ts`. Adding a new frame-aware tool that bypasses the helper fails the parameterized routing test at `test/unit/tools/frame-aware-tools-routing.test.ts`.

**Litmus tests (delete-a-component → must fail):**
- Remove `webNavigation` permission → `t55a-list-frames-cross-origin.test.ts` fails (frameId becomes null).
- Remove `all_frames: true` → `t55a-eval-in-frame-cross-origin.test.ts` fails (no content script in iframe).
- Remove webNavigation validation → `t55a-frame-not-found.test.ts` fails (10s timeout instead of fast FRAME_NOT_FOUND).
- Move frame validation before security pipeline → `t55a-frame-targeted-respects-security-pipeline.test.ts` fails.
- Remove `routeFrameAware` engine guard → `t55a-extension-down-frame-call.test.ts` fails (silent fallback to AppleScript returns DOMException SecurityError).
- Revert to single-slot sp_cmd/sp_result → `t55a-concurrent-frame-commands.test.ts` fails (frame races clobber).
- Remove `sender.frameId !== 0` filter at background.js:687 → `t55a-url-change-relay-iframe-filter.test.ts` fails (iframe URL pollutes tabCacheMap).

### Event-Page Lifecycle (commit 1a, v0.1.5; T60 fix v0.1.19; T67 fix v0.1.24)
- Manifest: `background = {scripts:['background.js'], persistent:false}`; `alarms` permission required for keepalive.
- No IIFE, no ES modules: Safari re-evaluates the script on every wake; listeners must be registered at top level.
- Wake sequence (post-T67 ordering, run on every init: onStartup / onInstalled / alarm / session_* / script_load):
  1. `loadTabCache()` — re-hydrate `tabCacheMap` from `storage.local[safari_pilot_tab_cache]`. Read-only; never throws.
  2. `connectAndReconcile()` — POST `/connect` to daemon. **Critical-path: must run before any storage write.** Daemon updates `lastReconcileTimestamp` and ships back the 5-case reconcile response (acked / uncertain / reQueued / inFlight / pushNew).
  3. `gcPendingStorage()` — best-effort. Removes completed entries older than 10 min from `storage.local[safari_pilot_pending_commands]`.
  4. `cleanupStaleStorageBus()` — best-effort. Prefix-scans `sp_cmd_*` / `sp_result_*` keys, removes any whose commandId is not in the live `pendingCommandIds` set.
  Each step is wrapped in its own `try`/`catch` and emits a step-tagged trace event on failure (`wake_load_error`, `wake_reconcile_error`, `wake_gc_error`, `wake_cleanup_error`) — operators can identify which step failed without re-reading source. After wakeSequence returns, `supersedePollLoop(reason)` runs OUTSIDE the wake-setup lock.
- Keepalive: `browser.alarms` named `safari-pilot-keepalive` fires every 1 min, emits `alarm_fire` log (ingested by `HealthStore.lastAlarmFireTimestamp`) and re-runs the wake sequence.
- Pending-command persistence uses `storage.local` key `safari_pilot_pending_commands` (status `executing` → `completed`); profile identity persisted under `safari_pilot_profile_id`.

**T67 (v0.1.24, 2026-05-03) — quota recovery + reorder.** Pre-T67 `wakeSequence` ran `loadTabCache → gcPendingStorage → cleanupStaleStorageBus → connectAndReconcile` inside a single outer try/catch. When `browser.storage.local` filled to Safari's ~5 MB cap, `gcPendingStorage`'s `writePending` threw "Exceeded storage quota" — the throw aborted the chain BEFORE `connectAndReconcile()` ran. `/connect` never landed; `lastReconcileTimestamp` flatlined; `isConnected` stayed `false` for as long as storage stayed full (32+ hours observed live; trace evidence at `~/.safari-pilot/daemon-trace.ndjson:109513+`). T67's structural fix: (1) reorder so reconcile runs second (after read-only `loadTabCache`), (2) per-step try/catch + step-tagged traces, (3) `writePending` gains quota recovery mirroring `saveTabCache` (catch quota → `remove(STORAGE_KEY_PENDING)` → retry `set` once → swallow on second failure → re-throw non-quota). Existing wedged installs auto-recover on first wake under v0.1.24. Guarded by 6 unit tests in `test/unit/extension/t67-storage-quota-blocks-reconcile.test.ts` (4 structural invariants + 1 defense-in-depth + 1 behavioral via eval-sandbox of `writePending`).

**T60 (v0.1.19, 2026-05-02) — pollLoop decoupled from wake-setup lock.** Pre-T60 `pollLoop` ran INSIDE `isWakeRunning`'s try/finally; the forever-loop never returned, so `finally` never cleared the lock, and a fetch suspended by event-page sleep would wedge `isWakeRunning=true` indefinitely. Fix: `supersedePollLoop()` aborts any prior pollLoop's `AbortController` (releasing wedged fetches) and starts a fresh one OUTSIDE the wake-setup lock; `pollLoop(abortSignal)` combines an external AbortSignal with `AbortSignal.timeout(10000)` via `AbortSignal.any` so a wedged fetch from a prior alarm cycle is forcibly killed when the next alarm supersedes it. Guarded by `test/unit/extension/t60-pollloop-decouple.test.ts`.

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
  4. If anything down → `recoverSession()`: reopen window if gone, poll for extension up to 10s, then re-call `registerWithDaemon()` so the daemon's session registry stays consistent across daemon restarts (T38, 2026-04-26 — closes the recovery side of the SD-32 multi-session contract). Both branches (window-only and extension-recovery) re-register on success.
  5. If recovery fails → throw `SessionRecoveryError` with details of what's down. **No register call on failure** — a session whose recovery failed is not advertised to the daemon as healthy.

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
- `health.json` — extension-engine observability state produced by `HealthStore.swift`. Persisted: `lastAlarmFireTimestamp` + `forceReloadTimestamps` (24h rolling window, filtered on write) + `httpBindFailureCount`. In-memory only (reset on daemon restart): `httpRequestErrorCount1h` (1h rolling window — pruned on append per T39, 2026-04-26), and the placeholders `roundtripCount1h` / `timeoutCount1h` / `uncertainCount1h`. **Caveat (SD-33, 2026-04-26):** the three placeholder counts always surface as 0 in the health snapshot because their increment methods (`incrementRoundtrip`/`incrementTimeout`/`incrementUncertain`) have zero production callers — the instrumentation was scaffolded but never wired. Decision pending: wire them up at the relevant production sites (CommandDispatcher / ExtensionBridge), or delete them. Tracked in `docs/FOLLOW-UPS.md`.

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

88 tools across 22 modules (3 helpers — `_frame-routing-helper.ts`, `har.ts`, `mime.ts` — don't expose tools; `selector-pack.ts` exists but is not registered, so its 2 tools don't ship). 14 modules accept `IEngine` interface (engine-agnostic). 2 modules (navigation, compound) use `AppleScriptEngine` for tab management. 2 modules (downloads, pdf) get engine from server. 1 module (extension-diagnostics) proxies the daemon's `extension_health` dispatch via `DaemonEngine.sendRawCommand`. 1 module (file-upload) takes a `DaemonEngine` injected at constructor time for byte staging via NDJSON `stage_file`.

Every tool declares `requirements.idempotent: boolean` (required field — no default). Non-idempotent tools (click, type, fill, select_option, press_key, hover, drag, scroll, navigate*, reload, cookie writes, storage writes, permission_set, override_*, mock_request, network_offline/throttle, websocket_listen, emergency_stop, evaluate, eval_in_frame, file_upload, authenticate, clear_authentication, compound tools that mutate state) MUST NOT be auto-retried on an ambiguous Extension-engine disconnect. The `EXTENSION_UNCERTAIN` error (Task 7) surfaces disconnect-during-execution and relies on this flag to decide retry safety.

| Module | Tools | Engine Type |
|--------|-------|-------------|
| navigation.ts | 7 | AppleScriptEngine |
| interaction.ts | 12 | IEngine (includes `safari_scroll_to_element` v0.1.31) |
| file-upload.ts | 1 | IEngine + DaemonEngine (byte staging) |
| extraction.ts | 7 | IEngine |
| network.ts | 10 | IEngine |
| storage.ts | 11 | IEngine |
| auth.ts | 2 | IEngine (extension-required) |
| shadow.ts | 2 | IEngine |
| frames.ts | 2 | IEngine |
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
| overlays.ts | 1 | IEngine (extension-required, v0.1.31) |
| skills.ts | 2 | IEngine (sub-step dispatch — bypasses pipeline) |
| selector-pack.ts | 0 | IEngine (module exists; not registered in `listToolDefinitions` or `initialize` — dead code, 2 unshipped tools) |
| tool-search.ts | 1 | IEngine |
| server.ts (direct) | 2 | N/A (health_check, emergency_stop) |

**`extension-diagnostics.ts`** adds 2 observability tools: `safari_extension_health` and `safari_extension_debug_dump`. Both are idempotent, read-only, and route through the daemon's `extension_health` dispatch.

**`auth.ts`** (5A.9, 2026-05-02) adds `safari_authenticate` and `safari_clear_authentication`. HTTP Basic auth via DNR `modifyHeaders` rule registration; requires `declarativeNetRequestWithHostAccess` manifest permission. Stable rule id from `urlPattern` hash so re-issue replaces and clear targets by pattern. EXTENSION_REQUIRED before dispatch for non-extension engines.

**`network.ts` HAR additions** (5A.7, 2026-05-02): `safari_dump_har` produces HAR 1.2 from the interceptor buffer (with optional filter); `safari_route_from_har` translates HAR back into safari_mock_request rules. Both pure transformers in `src/tools/har.ts`; no extension change required (network.ts interceptor was extended to capture request/response headers — see commit `1addfe1` and TRACES iter 49).

**`file-upload.ts`** (5A.1 / T41, 2026-05-03) adds `safari_file_upload` for programmatic upload to `<input type=file>` elements. Approach 3 architecture: TS handler reads bytes via Node fs → daemon `stage_file` NDJSON command → token-keyed `FileStagingStore` actor (60s TTL) → extension `content-isolated.js` fetches `GET http://127.0.0.1:19475/file-bytes/<token>` → constructs `File` objects in extension context → `window.postMessage` ISOLATED→MAIN with bytes intact via structured clone → `content-main.js` builds `DataTransfer`, calls `input.files = dt.files` (spec-compliant setter; `Object.defineProperty` does NOT update WebKit's internal `[[Files]]` slot that `FormData(form)` reads). 25 MiB / file × 4 / call. Phase 0 architectural gate validated empirically against fixture origin; gate test scaffolding stays in tree as permanent diagnostic. NOT supported: drag-and-drop dropzones, custom pickers, native OS dialogs, label/role/text/placeholder locator types in v1 extension JS (only `selector`/`xpath`/`ref`).

**`interaction.ts` `safari_scroll_to_element` (v0.1.31)** — scrolls a specific element into the visible viewport. Multi-mode input ({selector, text, role+name}) with precedence selector > role+name > text. Open shadow root penetration via `extension/locator.js` `querySelectorWithShadow` + same-origin iframe traversal. Visibility filtering, RAF-driven scroll-settle (50ms grace, 500ms cap). Returns `{scrolledTo: {strategy, matchedNode, matchCount, allMatches}, viewport, scrolledFromY}`. New error codes `TARGET_NOT_FOUND`, `TARGET_HIDDEN` (data-only, no thrown class). Extension-engine only (`requiresAsyncJs: true`). Sentinel `__SP_SCROLL_TO_ELEMENT__:<json>` intercepted in `extension/content-main.js` `case 'execute_script':` early-path — MUST live there, not `background.js` (service worker has no DOM access). Success via `result = X; break;`, errors via `throw Object.assign(new Error(msg), { name: 'CODE' })`.

**`overlays.ts` `safari_dismiss_overlays` (v0.1.31)** — detects and dismisses ~14 known overlay patterns (cookie-consent, registration-wall, app-install, paywall) using a curated allowlist with a two-signal-per-pattern rule. Signal types: `selector`, `aria-label-substring`, `aria-role`, `fixed-position`, `z-index-above`. Allowlist content lives in `src/overlays/*.json`, copied to `dist/overlays/` by build script, loaded at boot via `loadAllAllowlists()` (which validates schema + two-signal-minimum + duplicate-id detection). Returns `{dismissed[], skipped[], overlaysAtStart, overlaysAtEnd}`. `dismissed[]` entries are sanitized to 6 fields ({category, id, selector, action, site, verified}) — page-injected hostile strings cannot leak via response. Extension-engine only (`requiresShadowDom: true`). Sentinel `__SP_DISMISS_OVERLAYS__:<json>` intercepted in `extension/content-main.js`. Six safety mitigations: kill switch (`SAFARI_PILOT_DISABLE_OVERLAY_DISMISS=true` env), paywall opt-IN flag (`SAFARI_PILOT_ENABLE_PAYWALL_DISMISS=true` env, default off), two-signal pattern rule, per-pattern negative-fixture tests (14 paired in `test/fixtures/overlays-negative/`), per-dismissal audit log via standard pipeline, IdpiAnnotator scan extension via `EXTRACTION_TOOLS` Set (server.ts:1053-1059) so `content[0].text` summary is scanned for indirect prompt injection. `extension/locator.js` adds `matchSignal`, `findPatternRoot`, `dismissPattern` helpers exposed via `window.__SP_LOCATOR__`. `matchSignal('selector')` uses `el.matches()` (NOT `hostDoc.querySelector()`) so shadow-encapsulated elements match correctly.

---

## Test Architecture

**Status (2026-04-23):** All previous unit, integration, and e2e tests were deleted — they were mock-based fakes that provided false confidence while the product was broken. Tests are being rebuilt from zero with live-only validation.

### E2E Tests (test/e2e/) — 75 files, ~150 tests (v0.1.31 sprint expanded)

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

### Daemon Tests (daemon/Tests/) — 153 tests
- ExtensionSocketServer, ExtensionBridge, CommandDispatcher, HealthStore, SleepWakeMemoryRecovery, ExtensionHTTPServer, FileStagingStore (5A.1)
- Real Swift tests against real types, with I/O-isolation mocks at the NSAppleScript boundary
- The MockExecutor / StubExecutor / SequencedMockExecutor types substitute the external NSAppleScript → Safari boundary so tests run without a live Safari, but the SUT (CommandDispatcher, ExtensionBridge, HealthStore, ExtensionHTTPServer, FileStagingStore) is the real production code. Per the test rubric this is acceptable: mocks at the I/O boundary, real types at the SUT boundary.

### Unit Tests (test/unit/) — 668 tests (104 files)
- Pure-logic coverage for `src/`: tool handlers, security layers, engine selector, error shapes, escape contract.
- Per CLAUDE.md unit-test policy: may mock Node boundaries (`fs`, `net`, `child_process`, `AbortSignal`, timers); MUST NOT mock internal modules.
- T67's `t67-storage-quota-blocks-reconcile.test.ts` is illustrative: structural source-text invariants on `extension/background.js` plus one behavioral test that extracts `writePending` source via regex and eval-sandboxes it with a stubbed `browser.storage.local` to verify quota recovery without escaping.

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

### v0.1.18 — 2026-05-02 (T55a frame-aware storage bus)
Manifest gains `webNavigation` permission + `all_frames: true` on both content_scripts entries. Storage migrates from single-slot `sp_cmd`/`sp_result` to commandId-keyed `sp_cmd_<id>`/`sp_result_<id>`. Lazy `sp_getFrameId` handshake state machine in `extension/lib/handshake-machine.js`. Pure routing helper `shouldProcess` in `extension/lib/route-command.js` (inlined into content-isolated.js). Shared `routeFrameAware` (`src/tools/_frame-routing-helper.ts`) is the single source of truth across 6 frame-aware tool handlers. `safari_list_frames` returns frameId via `webNavigation.getAllFrames` intercepted in background.js by the `__SP_LIST_FRAMES__` sentinel. Frame validation at dispatch (FRAME_NOT_FOUND), document-mutation guard via cmd.frameUrl vs location.href (FRAME_NAVIGATED), 10s frame-targeted timeout (FRAME_UNREACHABLE), capability gating in routeFrameAware (FRAME_NOT_SUPPORTED for non-extension engines). 4 new error classes in `src/errors.ts`. 22 new unit tests + 9 e2e tests at `test/e2e/t55a-*.test.ts`.

### v0.1.19 — 2026-05-02 (T60 pollLoop decoupling)
Extension dormancy bug — alarm fires but no `/connect` or `/poll` reach the daemon. Root cause: `initialize()` wrapped both wakeSequence-setup AND `pollLoop` in `isWakeRunning`. `pollLoop` is a forever-loop; once Safari's MV3 event-page suspended a `/poll` fetch into an unresolvable pending state, `isWakeRunning` stayed `true` permanently and every subsequent alarm-driven `initialize()` bailed at the early-return. Fix: `pollLoop` decoupled — `wakeSequence` runs the BOUNDED setup phase only, `pollLoop` is supervised OUTSIDE the lock by `supersedePollLoop()` which aborts the prior pollLoop's `AbortController` (releasing wedged fetches) and starts a fresh one. `pollLoop(abortSignal)` combines an external AbortSignal with `AbortSignal.timeout(10000)` via `AbortSignal.any`. Verified empirically: v0.1.19 install produced `init_proceeding` → `setup_completed` → `pollloop_started` traces followed by sustained POLLs every 5s. Guarded by `test/unit/extension/t60-pollloop-decouple.test.ts` (7 structural invariants).

### v0.1.21 — 2026-05-02 (Phase 5A · Group A · Chunk 1: cookies HTTPOnly + saveAs + HTTP basic auth)
- **5A.8 cookies HTTPOnly:** `__SP_COOKIE_GET_ALL__/SET/REMOVE` sentinels route through `browser.cookies` API which sees httpOnly. document.cookie path preserved as AppleScript fallback. Discovery: `browser.cookies.getAll({})` empty filter returns only HttpOnly cookies in Safari — fix passes `url: tabUrl` (or `domain` if specified) filter.
- **5A.2 download saveAs:** Pure-TS post-process via `applySaveAs(metadata, saveAs?)` helper. Threaded through 4 `makeSuccessResponse` call sites in downloads.ts. Typed `DownloadSourceMissingError`.
- **5A.9 HTTP basic auth:** New `auth.ts` module + `__SP_DNR_ADD_RULE__`/`REMOVE_RULE__` sentinels routing to existing DNR handlers. Stable rule id from `urlPattern` hash. Manifest gains `declarativeNetRequestWithHostAccess` permission (without it, `modifyHeaders` rule registration succeeds but action silently no-ops at the network layer — empirical discovery).

### v0.1.23 — 2026-05-03 (5A.1 safari_file_upload — T41)
Programmatic file upload to standard `<input type=file>` elements via Approach 3 architecture (out-of-band byte fetch). Daemon NDJSON `stage_file` command + token-keyed `FileStagingStore` actor (60s TTL) + Hummingbird routes `GET/DELETE /file-bytes/<token>`. Extension `content-isolated.js` fetches bytes, constructs `File` objects, posts to `content-main.js` (structured-clone preserves File with bytes intact). content-main.js builds `DataTransfer` and uses spec-compliant `input.files = dt.files` setter (NOT `Object.defineProperty`, which shadows JS reads but doesn't update WebKit's internal `[[Files]]` slot that `FormData(form)` reads at submit). 200ms validation probe reads `input.validationMessage` + sibling `[role=alert]` / `[aria-invalid]`. 10 new error codes in `src/errors.ts`; `paths: []` rejected with `FILE_UPLOAD_EMPTY_PATHS` (use `clear: true` for explicit clearing — removes agent-`.filter()` foot-gun). 25 MiB / file × 4 / call. Phase 0 architectural gate (`test/e2e/5A1-phase0-spike.test.ts`) empirically validated against fixture origin: content-script `fetch('http://127.0.0.1:19475/...')` works under Safari WebExt CSP, `File` survives ISOLATED→MAIN structured-clone with bytes intact. 11/14 5A.1 e2e PASS + 3 SKIPPED (RHF label-locator gap, detached-element race, concurrent multi-MB pipe atomicity — all documented). Fixture-server origin has permissive CSP so the e2e suite cannot exercise strict-CSP-site failure mode (filed as T66 follow-up after Gmail smoke test surfaced it).

### v0.1.33 — 2026-05-12 (daemon HTTP-layer hardening)

Two daemon Swift fixes surfaced during the v0.1.32 T24 ship-gate attempt. `ExtensionHTTPServer.start()` now retries with exponential backoff (1/2/4/8/16/30s, max 5 attempts) when `runService()` throws AFTER `onServerRunning` fired — converting transient `NIOFcntlFailedError` mid-flight from a launchctl crashloop into an in-process restart. Initial bind failures (never ready) retain the pre-v0.1.33 fatal-exit behavior. A private `LockedFlag` (NSLock-backed `@unchecked Sendable`) propagates the "ever ready" signal from the `onServerRunning` callback to the retry loop. HTTP_SELF_TEST self-loopback no longer deadlocks on the very server it's probing — the test request now fires in a `Task.detached` with 200ms accept-loop grace and explicit 5s URLRequest timeout, passing status=200 within ~236ms (was 60s URLSession-default timeout fail on every startup since 2026-04-19). `bench/webvoyager/CONCURRENCY` corrected 8 → 1 to match the v0.1.30 baseline operator-override precedent and avoid Anthropic Max's 8-concurrent `claude -p` queue serialization. Underlying `NIOFcntlFailedError` trigger remains opaque (3-min synthetic 8-worker HTTP storm did not reproduce); the daemon is resilient regardless. 156/156 daemon unit tests pass.

### v0.1.32 — 2026-05-09 (v0.1.31 sprint: evidence grounding for WebVoyager)

Sprint scope-labeled "v0.1.31"; published as v0.1.32 because mid-sprint marketing-version bumps were required for Safari extension cache invalidation per `feedback-extension-version-both-fields`. Three v0.1.33 carry-forwards documented in CHANGELOG.

**Added (2 MCP tools, 4 skills, 1 slash command, 1 hook gain):**
- `safari_scroll_to_element` (interaction.ts) + extension/locator.js helpers (`querySelectorWithShadow`, `resolveScrollTargets`, `waitForScrollSettle`, `serializeNode`) + sentinel `__SP_SCROLL_TO_ELEMENT__:`. 6 e2e assertions PASS, p95 ≈ 291ms.
- `safari_dismiss_overlays` (overlays.ts NEW) + extension/locator.js dismiss helpers (`matchSignal`, `findPatternRoot`, `dismissPattern`) + sentinel `__SP_DISMISS_OVERLAYS__:`. 14 allowlist patterns across 4 categories (cookie-consent×6, registration-walls×3, app-install×2, paywalls×3). 6 dismiss-base + 5 dismiss-aux + 28 per-pattern = 39 e2e assertions PASS. EXTRACTION_TOOLS Set extended; IdpiAnnotator scans response.
- `skills/evidence-grounded-screenshot.SKILL.md` (procedural: dismiss → scroll → screenshot)
- `skills/dismiss-overlays-recovery.SKILL.md` (strategy: recover from blocked extraction)
- `skills/visible-evidence-grounding.SKILL.md` (strategy: ground in current visible page state)
- `skills/temporal-substitution.SKILL.md` (strategy: substitute past-relative dates)
- `/safari-pilot:stats` slash command — local-only metrics summary over `~/.safari-pilot/trace.ndjson` (per-tool count/error-rate/p50/p95, top errors, top domains; supports `--since`, `--by-tool`, `--by-error`, `--by-domain`, `--tail`, `--json`, plus `SAFARI_PILOT_TRACE_OVERRIDE` env for test hermeticity).
- `hooks/session-start.sh` now emits `{"hookSpecificOutput":{"additionalContext":"Current date: YYYY-MM-DD"}}` JSON to stdout before final exit 0 (preserves existing stderr discipline; for the temporal-substitution skill).
- `.claude-plugin/plugin.json` registers all 8 skills (was: only safari-pilot/SKILL.md). Three legacy skills (login, paginate-and-scrape, robust-form-fill) were on disk but unregistered until v0.1.31.

**Fixed (2 real bugs caught + fixed mid-sprint):**
- `extension/locator.js matchSignal('selector')` switched from `hostDoc.querySelector(value)` to `el.matches(value)`. The former returns false for shadow-encapsulated elements because `hostDoc` is the outer light-DOM document. Surfaced by T12 shadow-DOM penetration test.
- `smart-app-banner` allowlist pattern was unmatchable: required `meta[name=apple-itunes-app]` (head) AND `.smart-app-banner` (body) signals — both `selector` type — to match the same element. Replaced head-meta requirement with `fixed-position` structural discriminator. Surfaced by T14 per-pattern integration sweep. Content-only patch (no extension rebuild needed for the pattern fix itself).

**Internal:**
- New error codes (data-only via `ERROR_METADATA`, no thrown classes): `TARGET_NOT_FOUND`, `TARGET_HIDDEN`.
- New `src/overlays/` directory: `index.ts` loader, `types.ts`, 4 JSON files. Loader enforces two-signal-minimum + duplicate-id detection at boot.
- `src/cli/` directory: `format.ts` + `stats.ts` (NDJSON aggregator).
- Allowlist content lives in `src/overlays/*.json` and is patch-releasable via `npm publish` (no extension rebuild needed for content-only changes; user must run `npm update safari-pilot` to pick up patches; propagation is not silent).
- Pre-tag-check (`scripts/pre-tag-check.sh`) extended from 9 to 11 gates: allowlist parse-validate (loader schema + two-signal rule) + content-only patch flow proof (`tests/ci/content-only-patch.sh` mutates one allowlist entry, asserts npm build doesn't touch `bin/Safari Pilot.app` mtime).
- Test counts: 668 unit (was 656 pre-sprint) / 75 e2e files (was 7 — incl. 14 per-pattern overlays + 4 dismiss-related + 1 scroll + 1 stats e2e + 5 hook unit). Lint clean.
- v0.1.33 carry-forwards documented in CHANGELOG: daemon `Models.swift` AnyCodable bool/int coercion (NSNumber 0/1 → false/true; tests use `asInt()` normalizer); allowlist pattern over-broadness (`generic-newsletter-modal`, `generic-aria-cookie`, registry-order collision); `skipped[]` field-level sanitization + `MALFORMED_SENTINEL` error name distinct from `NO_LOCATOR`.

**Paywall safety:** 3 paywall patterns ship OPT-IN by default (NYT-soft, FT-modal, Bloomberg-overlay); user must set `SAFARI_PILOT_ENABLE_PAYWALL_DISMISS=true` to activate. Default install does not dismiss paywalls. Two engineering reviews independently flagged this as the highest-residual-risk decision; opt-in default-off was the agreed compromise.

### v0.1.30 — 2026-05-08 (safari_take_screenshot captures Safari WebView only)

**BREAKING:** `safari_take_screenshot` switched from macOS `screencapture` CLI to Safari Web Extension `tabs.captureVisibleTab` API. Captures only the rendered viewport of the target tab at native devicePixelRatio (Retina = 2× viewport pixels). Previous behavior captured whatever was frontmost on screen — almost never Safari during automated benchmarks. `format='jpeg'` now rejected with `INVALID_PARAMS` (silently returned PNG previously).

**Added:** error codes `WINDOW_CLOSED`, `CAPTURE_RACE`, `CAPTURE_FAILED`, `INVALID_PARAMS`. `requiresViewportCapture` flag in `ToolRequirements`; `viewportCapture` in `EngineCapabilities`. Engine selector routes any viewport-capture tool to extension engine (`EngineUnavailableError` when extension offline). WebVoyager harness gains two-tier screenshot capture protocol (agent self-capture + post-hoc fallback) + `capture_failure_rate` field in score output. New `__SP_TAKE_SCREENSHOT__` sentinel in `extension/background.js`. `bench/webvoyager/` driver + score CLI. Build script gains `--skip-notarize` flag (later REMOVED in v0.1.31 per `feedback-no-skip-notarize`).

### v0.1.24 — 2026-05-03 (T67 storage-quota recovery + release SOP codification)
- **T67 fix:** `extension/background.js` `wakeSequence` reordered so `connectAndReconcile()` runs second (after read-only `loadTabCache`); housekeeping (`gcPendingStorage`, `cleanupStaleStorageBus`) becomes best-effort and runs after. Each step in its own try/catch with step-tagged trace event (`wake_load_error`, `wake_reconcile_error`, `wake_gc_error`, `wake_cleanup_error`). `writePending` gains quota recovery mirroring `saveTabCache`. Existing wedged installs auto-recover on first wake. Guarded by 6 unit tests in `test/unit/extension/t67-storage-quota-blocks-reconcile.test.ts`.
- **Release SOP codified:** `scripts/pre-tag-check.sh` — 9 local checks mirroring every CI verify step (working tree clean, version lockstep, app+appex codesign+entitlements+stapler, zip free of AppleDouble, extracted-bundle codesign, daemon binary, unit tests, tag uniqueness, prepublish hook short-circuits on CI). `hooks/pre-publish-verify.sh` short-circuits on `CI=true` / `GITHUB_ACTIONS=true` (CI's T47 verify is the equivalent gate). `scripts/build-extension.sh` `ditto` invocations now use `--norsrc --noextattr --noqtn --noacl` to produce zips free of AppleDouble (`._*`) metadata that previously broke `codesign --verify --deep --strict` in CI. CLAUDE.md "Extension Build: Hard Rules" extended with rules #8 (ditto flags), #9 (mandatory pre-tag-check.sh), #10 (CI must skip local prepublish hook).
