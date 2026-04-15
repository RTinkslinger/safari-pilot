# Safari Pilot Architecture — Canonical Source of Truth

*Last verified: 2026-04-15 | Branch: feat/file-download-handling | Commit: b288628*

**This document describes how Safari Pilot ACTUALLY works as shipped. Every statement is backed by verified evidence. If code changes contradict this document, either the code is wrong or this document must be updated — never silently diverge.**

**Update rule:** Any commit that changes component behavior, data flow, IPC protocol, security pipeline order, engine selection logic, or test architecture MUST update this document in the same commit.

---

## System Overview

Safari Pilot is a native Safari browser automation framework exposing **76 tools** via MCP (stdio). It controls Safari through three engine tiers, protected by 9 security layers.

```
Claude Code / AI Agent
        │
        │ MCP JSON-RPC over stdin/stdout
        ▼
┌─────────────────────────────────┐
│  MCP Server (src/index.ts)      │
│  ┌───────────────────────────┐  │
│  │ SafariPilotServer         │  │
│  │  • 76 tools registered    │  │
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

### Tier 1: Extension Engine (10ms p50)
**Capabilities:** Shadow DOM (open), CSP bypass (partial — MAIN world only), dialog interception, network interception, framework detection, cross-origin frames

**Data flow (verified 2026-04-15):**
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
  │ 30s timeout via Task
  ▼
background.js polls via sendNativeMessage({type:'poll'})
  │
  ▼
SafariWebExtensionHandler.beginRequest()
  │ TCP proxy: NWConnection to localhost:19474
  ▼
ExtensionSocketServer (daemon)
  │ dispatches to CommandDispatcher
  │ returns: {ok:true, value:{command:{id,script,tabUrl}}}
  ▼
SafariWebExtensionHandler returns response to background.js
  ▼
background.js extracts command from response.value.command
  │ finds target tab by URL (queries all tabs, filters by URL)
  │ falls back to active tab if no URL match
  ▼
browser.scripting.executeScript({target:{tabId}, func, args:[script], world:'MAIN'})
  │ executes in page's MAIN world JavaScript context
  ▼
Result flows back:
  background.js → sendNativeMessage({type:'result', id, result})
  → handler → TCP to daemon → ExtensionBridge.handleResult()
  → resumes CheckedContinuation → DaemonEngine → ExtensionEngine
  → SafariPilotServer → MCP response with _meta.engine='extension'
```

**Verification command:**
```bash
echo '{"id":"test","method":"extension_status"}' | nc -w 3 localhost 19474
# Expected: {"ok":true,"value":"connected"}
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

**Response metadata:** Every MCP response includes `_meta.engine` showing which engine actually executed. Forwarded via `_meta` field in MCP CallToolResult (src/index.ts).

---

## Security Pipeline

**9 layers, executed in this order on every tool call** (src/server.ts `executeToolWithSecurity`):

| # | Layer | What it does | Wired at |
|---|-------|-------------|----------|
| 1 | **KillSwitch** | Global emergency stop — blocks ALL automation | server.ts:357 |
| 2 | **TabOwnership** | Agent can only touch tabs it created via safari_new_tab | server.ts:369 |
| 3 | **DomainPolicy** | Per-domain trust levels, blocked domains list | server.ts:380 |
| 4 | **HumanApproval** | Blocks sensitive actions on OAuth/financial URLs | server.ts:383 |
| 5 | **RateLimiter** | 120 actions/min global, per-domain buckets | server.ts:418 |
| 6 | **CircuitBreaker** | 5 errors on a domain → 120s cooldown | server.ts:424 |
| 7 | **Engine Selection** | Picks best available engine for tool's requirements | server.ts:430 |
| 8 | **Tool Execution** | Calls the tool handler with selected engine | server.ts:452 |
| 8a | **IdpiScanner** | Scans extraction results for prompt injection patterns | server.ts:457 |
| 8b | **ScreenshotRedaction** | Attaches redaction script for banking/cross-origin iframes | server.ts:474 |
| 9 | **AuditLog** | Records every tool call: tool, URL, engine, params, result, timing | server.ts:484 |

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

### Extension Handler ↔ background.js
- Protocol: browser.runtime.sendNativeMessage (Safari native messaging)
- Handler translates message types:
  - `{type:'poll'}` → `{method:'extension_poll'}`
  - `{type:'result', id, result}` → `{method:'extension_result', params:{requestId, result}}`
  - `{type:'connected'}` → `{method:'extension_connected'}`

### background.js ↔ Content Scripts
- ISOLATED world: browser.runtime.onMessage relay
- MAIN world: window.postMessage with origin check
- Script execution: browser.scripting.executeScript with world:'MAIN'

### ExtensionBridge Command Queue
- In-memory queue (not file-based — sandbox blocks filesystem access)
- handleExecute: queues command + suspends via CheckedContinuation
- handlePoll: returns first pending command (or null)
- handleResult: matches by requestId, resumes continuation
- Timeout: 30s, cancels via Task
- Disconnect: cancels all pending commands

---

## Extension Build Pipeline

**Source of truth for handler:** `extension/native/SafariWebExtensionHandler.swift`

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

---

## Tool Modules

76 tools across 16 modules. 12 modules accept `IEngine` interface (engine-agnostic). 2 modules (navigation, compound) use `AppleScriptEngine` for tab management. 2 modules (downloads, pdf) get engine from server.

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
| server.ts (direct) | 2 | N/A (health_check, emergency_stop) |

---

## Test Architecture

### E2E Tests (test/e2e/) — 14 files, 74+ tests
- Spawn real `node dist/index.js`, talk JSON-RPC
- Zero mocks, zero source imports
- Verify `_meta.engine` on every tool response (architecture test, not just functional)
- Extension-required tools assert engine='extension' or proper rejection with degraded=true
- Tests create own tabs, clean up in afterAll, never touch user tabs
- Litmus: deleting SafariWebExtensionHandler.swift would fail extension-engine and engine-selection tests

### Integration Tests (test/integration/) — including extension-build (10 tests)
- Verify built artifacts: entitlements, code signing, handler is not stub
- Gate tests verify tool count (76)

### Unit Tests (test/unit/) — 49 files, 1378 tests
- Extension unit tests verify protocol contracts (sentinel format, payload structure)
- Engine selector tests cover all requirement combinations
- Security layer tests cover each layer in isolation

### Daemon Tests (daemon/Tests/) — 41 tests
- ExtensionSocketServer: TCP accept, ping dispatch, concurrent connections, invalid JSON
- ExtensionBridge: queue/poll/result cycle, timeout, disconnect cancellation
- CommandDispatcher: routing, NDJSON parsing, extension_poll

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
| 2026-04-15 | CSP bypass: content script relay, error propagation fix, HumanApproval action mapping | 41 daemon tests, 1378 unit tests, 74 e2e tests |
| 2026-04-15 | Extension engine operational: TCP proxy handler, daemon socket, in-memory bridge | Manual: document.title on example.com. E2E: 74 tests, _meta.engine assertions |
| 2026-04-15 | All 9 security layers wired | Unit: 1378 pass. E2E: security-pipeline tests |
| 2026-04-15 | Engine selection invoked every call | E2E: engine-selection tests assert _meta.engine |
| 2026-04-14 | PDF generation via WKWebView.createPDF | E2E: pdf-generation tests verify real PDFs |
| 2026-04-14 | Download handling via FSEvents | E2E: downloads tests (tool existence verified) |
| 2026-04-14 | Shadow DOM slot traversal fix | Integration: Reddit 82→18178 chars |
| 2026-04-14 | Click navigation via el.href | Integration: links actually navigate |
