# Execution Flows — Safari Pilot Telemetry Reference

Canonical map of every tool's execution path, all 15 telemetry points, IPC protocols,
and security pipeline order. Use this when debugging, writing tests, or adding new tools.

---

## 1. How to Read This Document

**Telemetry markers** appear inline in flow diagrams as `📍N` where N is the trace point number.
Every `📍N` corresponds to one line in a trace file.

**Cross-referencing a live trace:**

```bash
# Follow a single request through all layers
grep '"id":"req-1745196000-42"' ~/.safari-pilot/trace.ndjson ~/.safari-pilot/daemon-trace.ndjson

# See all 15 points for one request in order
grep '"id":"req-1745196000-42"' ~/.safari-pilot/trace.ndjson ~/.safari-pilot/daemon-trace.ndjson \
  | jq -r '"\(.ts) [\(.layer)] \(.event)"' | sort

# Merge server + daemon traces chronologically
jq -s 'sort_by(.ts)' \
  ~/.safari-pilot/trace.ndjson \
  ~/.safari-pilot/daemon-trace.ndjson \
  | jq -r '"\(.ts) [\(.layer)] \(.event) \(.data)"'

# Filter by event type across all requests
grep '"event":"engine_selected"' ~/.safari-pilot/trace.ndjson | jq '{id,data}'
```

**Trace files:**

| File | Written by | Contains |
|------|-----------|---------|
| `~/.safari-pilot/trace.ndjson` | `src/trace.ts` (TypeScript) | Points 📍1–📍8 and 📍9 (errors) |
| `~/.safari-pilot/daemon-trace.ndjson` | `daemon/Sources/SafariPilotdCore/Trace.swift` | Points 📍9–📍12 (daemon) and 📍13–📍15 (extension, routed via `__trace__` sentinel) |

Both files use the same NDJSON schema:

```json
{
  "ts": "2026-04-21T01:23:45.678Z",
  "id": "req-1745196000-42",
  "layer": "server",
  "level": "event",
  "event": "tool_received",
  "data": { "tool": "safari_click", "tabUrl": "https://example.com", "paramKeys": ["tabUrl", "selector"] },
  "elapsed_ms": 0
}
```

`elapsed_ms` is only present on `tool_result` and `tool_error` events (cumulative from `tool_received`).

---

## 2. Trace Files

### `~/.safari-pilot/trace.ndjson` — Server-side (TypeScript)

Source: `/Users/Aakash/Claude Projects/Skills Factory/safari-pilot/src/trace.ts`

Appended by `trace(id, layer, event, data, level?, elapsed_ms?)` called from
`src/server.ts:executeToolWithSecurity()`.

**Layers in this file:** `server`

### `~/.safari-pilot/daemon-trace.ndjson` — Daemon + Extension (Swift + JS)

Source: `/Users/Aakash/Claude Projects/Skills Factory/safari-pilot/daemon/Sources/SafariPilotdCore/Trace.swift`

Appended by `Trace.emit(id, layer:, event:, data:)` from:

- `CommandDispatcher.swift` — daemon dispatcher entry
- `ExtensionBridge.swift` — bridge queue/result events
- Extension `background.js` emitting via `__trace__` sentinel → `ExtensionBridge.handleResult()` routes to `Trace.emit()`

**Layers in this file:** `daemon-dispatcher`, `daemon-bridge`, `extension-bg`

---

## 3. Tool Classes

There are 5 execution classes. A tool can belong to multiple classes (Class 4 overlaps all others).

### Class 1 — Extension-Engine (full 15-point flow)

The default class. JavaScript is executed in the page via the Safari extension.
All 15 telemetry points fire on the happy path.

**Members (62 tools):** All tools not listed in Classes 2 or 3. Specifically includes:
`safari_begin_trace`, `safari_check`, `safari_click`, `safari_click_shadow`,
`safari_clipboard_read`, `safari_clipboard_write`, `safari_delete_cookie`,
`safari_double_click`, `safari_drag`, `safari_end_trace`, `safari_eval_in_frame`,
`safari_evaluate`, `safari_extension_debug_dump`, `safari_extension_health`,
`safari_extract_images`, `safari_extract_links`, `safari_extract_metadata`,
`safari_extract_tables`, `safari_fill`, `safari_get_attribute`,
`safari_get_console_messages`, `safari_get_cookies`, `safari_get_html`,
`safari_get_network_request`, `safari_get_page_metrics`, `safari_get_text`,
`safari_handle_dialog`, `safari_hover`, `safari_idb_get`, `safari_idb_list`,
`safari_intercept_requests`, `safari_list_frames`, `safari_list_network_requests`,
`safari_local_storage_get`, `safari_local_storage_set`, `safari_media_control`,
`safari_mock_request`, `safari_monitor_page`, `safari_navigate_back`,
`safari_navigate_forward`, `safari_network_offline`, `safari_network_throttle`,
`safari_override_geolocation`, `safari_override_locale`, `safari_override_timezone`,
`safari_override_useragent`, `safari_paginate_scrape`, `safari_permission_get`,
`safari_permission_set`, `safari_press_key`, `safari_query_shadow`, `safari_scroll`,
`safari_select_option`, `safari_session_storage_get`, `safari_session_storage_set`,
`safari_set_cookie`, `safari_smart_scrape`, `safari_snapshot`,
`safari_storage_state_export`, `safari_storage_state_import`, `safari_sw_list`,
`safari_sw_unregister`, `safari_take_screenshot`,
`safari_test_flow`, `safari_type`, `safari_wait_for`, `safari_websocket_filter`,
`safari_websocket_listen`

**Flow diagram:**

```
MCP Client
    │  JSON-RPC 2.0 (stdin/stdout, Content-Length framed)
    ▼
SafariPilotServer.executeToolWithSecurity()
    │
    ├── 📍1  tool_received          [server] entry point, traceId assigned
    │
    ├── KillSwitch.checkBeforeAction()
    │
    ├── URL/domain extraction
    │
    ├── DomainPolicy.evaluate(url)
    ├── 📍3  domain_policy          [server] trust level, blocked flag
    │
    ├── HumanApproval.assertApproved()
    │
    ├── RateLimiter.checkLimit() + recordAction()
    ├── 📍4  rate_limit_check       [server] domain
    │
    ├── CircuitBreaker.assertClosed()
    │
    ├── selectEngine(requirements, availability, breaker, config)
    ├── EngineProxy.setDelegate(extension engine)
    ├── 📍5  engine_selected        [server] engine=extension, degraded=false
    │
    ├── EngineProxy.resetMeta()
    │
    ├── TabOwnership check (step 7d)
    ├── 📍2  ownership_check        [server] found, deferred, or skipped
    │
    ├── (optional) engine-degradation re-run (step 7.5)
    │
    ├── DaemonEngine.setTraceId(traceId)
    ├── 📍6  engine_dispatch        [server] engine=extension, tabUrl
    │
    ├── callTool(name, params)
    │       │
    │       ▼  Tool handler calls EngineProxy.executeJsInTab()
    │       │  EngineProxy delegates to ExtensionEngine.executeJsInTab()
    │       │
    │       │  DaemonEngine.execute("__SAFARI_PILOT_INTERNAL__ extension_execute {...}")
    │       │
    │       │  TCP:19474 / stdin NDJSON  ──────────────────────────────────────────────┐
    │       │                                                                            │
    │       │                              SafariPilotd (Swift daemon)                  │
    │       │                                  │                                        │
    │       │                                  ├── CommandDispatcher.dispatch()         │
    │       │                                  ├── 📍9  command_received  [daemon-dispatcher]
    │       │                                  │                                        │
    │       │                                  ├── handleInternalCommand("extension_execute")
    │       │                                  │                                        │
    │       │                                  └── ExtensionBridge.handleExecute()      │
    │       │                                      ├── 📍10 bridge_queued  [daemon-bridge]
    │       │                                      │                                    │
    │       │                                      │  HTTP:19475 short-poll             │
    │       │                                      │  background.js GET /poll ──────────┘
    │       │                                      │                                    │
    │       │                                      ├── handlePoll delivers command      │
    │       │                                      ├── 📍11 extension_polled [daemon-bridge]
    │       │                                      │                                    │
    │       │                                      │  background.js (Safari extension)  │
    │       │                                      │  ├── writes sp_cmd to storage      │
    │       │                                      │  ├── 📍13 cmd_dispatched [extension-bg]
    │       │                                      │  │                                 │
    │       │                                      │  │  storage.onChanged bus          │
    │       │                                      │  │  content-isolated.js            │
    │       │                                      │  │  → postMessage → content-main.js│
    │       │                                      │  │  → executes JS in MAIN world    │
    │       │                                      │  │  → result via postMessage back  │
    │       │                                      │  │  → sp_result in storage         │
    │       │                                      │  │                                 │
    │       │                                      │  ├── resultListener fires          │
    │       │                                      │  ├── 📍14 result_received [extension-bg]
    │       │                                      │  │                                 │
    │       │                                      │  ├── _meta enrichment (tabId, tabUrl)
    │       │                                      │  ├── 📍15 result_enriched [extension-bg]
    │       │                                      │  │                                 │
    │       │                                      │  └── POST /result to daemon        │
    │       │                                      │     (traces 📍13–15 sent via __trace__ sentinel)
    │       │                                      │                                    │
    │       │                                      └── handleResult() processes response│
    │       │                                          ├── 📍12 bridge_result [daemon-bridge]
    │       │                                          └── resumes continuation         │
    │       │                                                                            │
    │       │  ◄─────────────────────── TCP:19474 / stdin NDJSON response ─────────────┘
    │       │
    │       └── EngineResult → ToolResponse
    │
    ├── 📍7  tool_result            [server] ok=true, engine, metaTabId, metaTabUrl, elapsed_ms
    │
    ├── (safari_new_tab) → TabOwnership.registerTab()
    │
    ├── EngineProxy.getLastMeta() → backfill extensionTabId, refresh URL
    │       └── (deferred check) → verify ownership via _meta.tabId
    ├── 📍8  post_verify            [server] deferredVerified, metaPresent
    │
    ├── (extraction tools) → IdpiScanner.scan()
    │
    ├── (safari_take_screenshot) → ScreenshotRedaction.getRedactionScript()
    │
    └── AuditLog.record() → success
```

---

### Class 2 — AppleScript-Only (truncated flow, no daemon bridge)

These tools use `osascript` directly via `AppleScriptEngine`. The daemon and extension
are not involved. Points 📍9–📍15 do not fire.

**Members (6 tools):**
`safari_close_tab`, `safari_health_check`, `safari_list_tabs`, `safari_navigate`,
`safari_new_tab`, `safari_reload`

> Note: `safari_navigate` uses AppleScript for URL navigation (`open location` via
> `do JavaScript "window.location.href = ..."` via `do JavaScript in tab`). It is
> Class 2 when the AppleScript engine handles it. When the extension engine is
> available and selected, it may route through Class 1.

**Flow diagram (happy path, engine_selected=applescript):**

```
MCP Client
    │  JSON-RPC 2.0 (stdin/stdout, Content-Length framed)
    ▼
SafariPilotServer.executeToolWithSecurity()
    │
    ├── 📍1  tool_received
    ├── KillSwitch / URL extraction
    ├── 📍3  domain_policy
    ├── HumanApproval
    ├── 📍4  rate_limit_check
    ├── CircuitBreaker
    ├── selectEngine() → applescript
    ├── 📍5  engine_selected        [engine=applescript]
    ├── EngineProxy.resetMeta()
    ├── 📍2  ownership_check        [skipped for Class 4 tools]
    ├── 📍6  engine_dispatch
    │
    ├── callTool(name, params)
    │       │
    │       ▼  AppleScriptEngine.execute(script)
    │              │  execFile("osascript", [...])
    │              │  macOS AppleScript runtime
    │              └── Safari controlled via Apple Events
    │
    ├── 📍7  tool_result
    ├── (safari_new_tab) → TabOwnership.registerTab()
    ├── 📍8  post_verify            [metaPresent=false — no _meta from AppleScript]
    └── AuditLog.record()
```

---

### Class 3 — Daemon-Direct (daemon command, not extension_execute)

These tools send a non-extension command directly to the daemon (`watch_download`
or `generate_pdf`). They use `DaemonEngine.execute()` with a non-`extension_execute`
method. The extension bridge is not invoked. Points 📍10–📍15 do not fire.

**Members (2 tools):**
`safari_export_pdf`, `safari_wait_for_download`

**Flow diagram:**

```
MCP Client
    │  JSON-RPC 2.0
    ▼
SafariPilotServer.executeToolWithSecurity()
    │
    ├── 📍1  tool_received
    ├── KillSwitch / URL / 📍3 domain_policy
    ├── HumanApproval / 📍4 rate_limit_check / CircuitBreaker
    ├── selectEngine() → daemon
    ├── 📍5  engine_selected        [engine=daemon]
    ├── EngineProxy / 📍2 ownership_check / 📍6 engine_dispatch
    │
    ├── callTool()
    │       │
    │       ▼  DaemonEngine.execute("watch_download {...}" or "generate_pdf {...}")
    │              │  TCP:19474 NDJSON
    │              ▼
    │          CommandDispatcher.dispatch()
    │          ├── 📍9  command_received     [method=watch_download or generate_pdf]
    │          └── handleWatchDownload() or handleGeneratePdf()
    │                 │
    │                 ├── DownloadWatcher.watch() or PdfGenerator.generate()
    │                 │   (native macOS FSEvents / WKWebView)
    │                 └── Response ──► TCP:19474 back to DaemonEngine
    │
    ├── 📍7  tool_result
    ├── 📍8  post_verify            [metaPresent=false]
    └── AuditLog.record()
```

---

### Class 4 — Skip-Ownership (modifier, overlaps Classes 1–3)

These tools skip step 7d (tab ownership check) because they don't operate on an
agent-owned tab. Point 📍2 still fires but with `skipped=true`.

**Members (5 tools):**
`safari_health_check`, `safari_list_tabs`, `safari_new_tab`,
`safari_navigate_back`, `safari_navigate_forward`

> `safari_navigate_back` and `safari_navigate_forward` are also Class 1 (extension-engine)
> but their ownership enforcement is unreliable — they query the tab by stale URL
> after `history.back()`/`history.forward()`. Ownership is skipped for safety.
> `safari_new_tab` is Class 2 but triggers `TabOwnership.registerTab()` post-execution.

**Diff from Class 1/2 flow:**

```
    ├── 📍2  ownership_check        [skipped=true — tool is in SKIP_OWNERSHIP_TOOLS set]
```

---

### Class 5 — Navigation + Ownership Update (modifier, overlaps Class 1)

After a Class 1 tool executes, `EngineProxy.getLastMeta()` returns `{tabId, tabUrl}`
from the extension result. The server uses this to:

1. Backfill `extensionTabId` on first extension call for a tab.
2. Refresh the URL in the ownership registry (keeps `findByUrl()` working after navigation).
3. Verify deferred ownership — if step 7d was deferred, confirm the tab belongs to this agent.

All Class 1 tools implicitly belong to Class 5. The post-execution ownership update
fires on every successful extension-engine call where `_meta.tabId` is present.

**Members:** All Class 1 tools (when extension engine is used).

**Post-execution flow detail:**

```
    ├── 📍7  tool_result
    │
    ├── 8.post: safari_new_tab → registerTab(syntheticId, tabUrl)
    │
    ├── 8.post2: engineMeta?.tabId present?
    │       ├── YES → setExtensionTabId(ownedByUrl, extTabId)    [backfill]
    │       │         updateUrl(ownedByExtId, extTabUrl)          [URL refresh]
    │       │         deferredOwnershipCheck? → verify or throw   [deferred verify]
    │       └── NO  → deferredOwnershipCheck? → throw TabUrlNotRecognizedError
    │
    ├── 📍8  post_verify            [deferredVerified, metaPresent]
    │
    └── continue to IDPI / screenshot / audit
```

---

## 4. Security Pipeline

Ordered steps in `executeToolWithSecurity()` (source: `src/server.ts`).

```
Step    Component                   Trace point   Blocks on
─────────────────────────────────────────────────────────────────────────────
 1      KillSwitch.checkBeforeAction()             KillSwitchActiveError
 2      URL/domain extraction         —
 3      DomainPolicy.evaluate()       📍3           policy.blocked → Error
 4a     HumanApproval.assertApproved()             HumanApprovalRequiredError
 5      RateLimiter.checkLimit()      📍4           RateLimitedError
 6      CircuitBreaker.assertClosed()              CircuitOpenError
 7      selectEngine()                📍5           EngineUnavailableError
 7b     EngineProxy.setDelegate()     —
 7c     EngineProxy.resetMeta()       —
 7d     TabOwnership check            📍2           TabUrlNotRecognizedError
                                                   (or deferred to 8.post2)
 7.5    Engine-degradation re-run     —            HumanApprovalRequiredError
        (only when extension preferred
         but different engine selected)
 8      DaemonEngine.setTraceId()     📍6
        callTool() → engine execution
 8.post safari_new_tab registration   —
 8.post2 Post-exec _meta ownership    📍8          TabUrlNotRecognizedError
         (backfill, URL refresh,                   (deferred path)
          deferred verify)
 8a     IdpiScanner.scan()            —            (annotates metadata, no block)
         (extraction tools only)
 8b     ScreenshotRedaction           —            (annotates metadata, no block)
         (safari_take_screenshot only)
 9      AuditLog.record()             —            (always runs, success or error)
─────────────────────────────────────────────────────────────────────────────
```

**Error path** — any throw after `📍1` is caught by the outer try/catch in
`executeToolWithSecurity()`. The circuit breaker records a failure, the audit log
records an error, and `📍9` (tool_error) fires at level `error`:

```
    catch (err)
        ├── circuitBreaker.recordFailure(domain)
        ├── 📍9  tool_error   [server, level:error] code, message, engine, elapsed_ms
        └── AuditLog.record(result:'error')
```

**Extraction tools** that trigger IDPI scan (step 8a):
`safari_get_text`, `safari_get_html`, `safari_snapshot`, `safari_evaluate`,
`safari_get_console_messages`, `safari_smart_scrape`, `safari_extract_tables`,
`safari_extract_links`, `safari_extract_images`, `safari_extract_metadata`

---

## 5. IPC Protocols

### MCP ↔ Server (Claude Code → SafariPilotServer)

Protocol: JSON-RPC 2.0 over stdin/stdout
Framing: `Content-Length: N\r\n\r\n` + JSON body
Direction: bidirectional (requests in, responses out)
Entry point: `src/index.ts` → `src/server.ts`

```
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"safari_click","arguments":{...}}}
```

### Server ↔ Daemon (DaemonEngine → SafariPilotd)

Protocol: NDJSON (one JSON object per line, `\n`-terminated)
Transport A: TCP localhost:19474 (one socket per command when `useTcp=true`)
Transport B: stdin/stdout of child process (spawned by DaemonEngine)
Direction: bidirectional (command sent, response received on same channel)

Request format:
```json
{"id":"req-1745196000-42","method":"execute","params":{"script":"..."}}
```
Response format:
```json
{"id":"req-1745196000-42","ok":true,"value":"...","elapsedMs":4}
```

### Daemon ↔ Extension (SafariPilotd → background.js)

Protocol: HTTP short-poll on localhost:19475 (Hummingbird, macOS 14+)
Routes:
- `POST /connect` — extension wakes, reconciles state
- `GET /poll` — extension holds for up to 5 seconds waiting for pending commands
- `POST /result` — extension delivers execution result (or `__trace__` sentinel for telemetry)

Daemon stores pending commands in `ExtensionBridge.pendingCommands[]`.
Poll response delivers commands as `{"commands": [{id, script, tabUrl, ...}]}`.

### Extension ↔ Content Script (background.js → content-isolated.js → content-main.js)

Protocol: `browser.storage.local` event bus
Write key: `sp_cmd` → content-isolated.js reads via `storage.onChanged`
Read key: `sp_result` → background.js reads via `storage.onChanged` (resultListener)
Relay: content-isolated.js ↔ content-main.js via `window.postMessage`
Execution: content-main.js runs the script in the MAIN world (access to page JS)

This pattern replaces `browser.scripting.executeScript` which returns `undefined`
in alarm-woken event page context.

---

## 6. Tool → Class Mapping

All 75 tools. A tool can have multiple classes (comma-separated).

| Tool | Class(es) | Engine | Ownership | Notes |
|------|-----------|--------|-----------|-------|
| safari_begin_trace | 1, 5 | extension | checked | Trace session management |
| safari_check | 1, 5 | extension | checked | |
| safari_click | 1, 5 | extension | checked | Post-click URL change triggers Class 5 URL refresh |
| safari_click_shadow | 1, 5 | extension | checked | Shadow DOM click |
| safari_clipboard_read | 1, 5 | extension | checked | |
| safari_clipboard_write | 1, 5 | extension | checked | |
| safari_close_tab | 2 | applescript | checked | AppleScript `close tab` |
| safari_delete_cookie | 1, 5 | extension | checked | |
| safari_double_click | 1, 5 | extension | checked | |
| safari_drag | 1, 5 | extension | checked | |
| safari_end_trace | 1, 5 | extension | checked | Trace session management |
| safari_eval_in_frame | 1, 5 | extension | checked | |
| safari_evaluate | 1, 5 | extension | checked | IDPI scan applied |
| safari_export_pdf | 3 | daemon | checked | `generate_pdf` command → WKWebView |
| safari_extension_debug_dump | 1, 5 | extension | checked | |
| safari_extension_health | 1, 5 | extension | skipped (Class 4) | |
| safari_extract_images | 1, 5 | extension | checked | IDPI scan applied |
| safari_extract_links | 1, 5 | extension | checked | IDPI scan applied |
| safari_extract_metadata | 1, 5 | extension | checked | IDPI scan applied |
| safari_extract_tables | 1, 5 | extension | checked | IDPI scan applied |
| safari_fill | 1, 5 | extension | checked | |
| safari_get_attribute | 1, 5 | extension | checked | |
| safari_get_console_messages | 1, 5 | extension | checked | IDPI scan applied |
| safari_get_cookies | 1, 5 | extension | checked | |
| safari_get_html | 1, 5 | extension | checked | IDPI scan applied |
| safari_get_network_request | 1, 5 | extension | checked | |
| safari_get_page_metrics | 1, 5 | extension | checked | |
| safari_get_text | 1, 5 | extension | checked | IDPI scan applied |
| safari_handle_dialog | 1, 5 | extension | checked | |
| safari_health_check | 2, 4 | applescript | skipped | Class 4 — no tab param |
| safari_hover | 1, 5 | extension | checked | |
| safari_idb_get | 1, 5 | extension | checked | |
| safari_idb_list | 1, 5 | extension | checked | |
| safari_intercept_requests | 1, 5 | extension | checked | Requires CSP bypass capability |
| safari_list_frames | 1, 5 | extension | checked | |
| safari_list_network_requests | 1, 5 | extension | checked | |
| safari_list_tabs | 2, 4 | applescript | skipped | Class 4 — lists all tabs |
| safari_local_storage_get | 1, 5 | extension | checked | |
| safari_local_storage_set | 1, 5 | extension | checked | |
| safari_media_control | 1, 5 | extension | checked | |
| safari_mock_request | 1, 5 | extension | checked | Requires network intercept capability |
| safari_monitor_page | 1, 5 | extension | checked | |
| safari_navigate | 2 | applescript | checked | URL navigation via Apple Events |
| safari_navigate_back | 1, 4, 5 | extension | skipped | Ownership unreliable post-history.back() |
| safari_navigate_forward | 1, 4, 5 | extension | skipped | Ownership unreliable post-history.forward() |
| safari_network_offline | 1, 5 | extension | checked | |
| safari_network_throttle | 1, 5 | extension | checked | |
| safari_new_tab | 2, 4 | applescript | skipped | Class 4; registers tab post-execution |
| safari_override_geolocation | 1, 5 | extension | checked | |
| safari_override_locale | 1, 5 | extension | checked | |
| safari_override_timezone | 1, 5 | extension | checked | |
| safari_override_useragent | 1, 5 | extension | checked | |
| safari_paginate_scrape | 1, 5 | extension | checked | |
| safari_permission_get | 1, 5 | extension | checked | |
| safari_permission_set | 1, 5 | extension | checked | |
| safari_press_key | 1, 5 | extension | checked | |
| safari_query_shadow | 1, 5 | extension | checked | Requires Shadow DOM capability |
| safari_reload | 2 | applescript | checked | |
| safari_scroll | 1, 5 | extension | checked | |
| safari_select_option | 1, 5 | extension | checked | |
| safari_session_storage_get | 1, 5 | extension | checked | |
| safari_session_storage_set | 1, 5 | extension | checked | |
| safari_set_cookie | 1, 5 | extension | checked | |
| safari_smart_scrape | 1, 5 | extension | checked | IDPI scan applied |
| safari_snapshot | 1, 5 | extension | checked | IDPI scan applied |
| safari_storage_state_export | 1, 5 | extension | checked | |
| safari_storage_state_import | 1, 5 | extension | checked | |
| safari_sw_list | 1, 5 | extension | checked | |
| safari_sw_unregister | 1, 5 | extension | checked | |
| safari_take_screenshot | 1, 5 | extension | checked | Screenshot redaction applied |
| safari_test_flow | 1, 5 | extension | checked | |
| safari_type | 1, 5 | extension | checked | |
| safari_wait_for | 1, 5 | extension | checked | |
| safari_wait_for_download | 3 | daemon | checked | `watch_download` command → FSEvents |
| safari_websocket_filter | 1, 5 | extension | checked | |
| safari_websocket_listen | 1, 5 | extension | checked | |

**Class key:**
- `1` = Extension-engine (full 15-point flow)
- `2` = AppleScript-only (points 1–8 server-side, 9 daemon-dispatcher only)
- `3` = Daemon-direct (points 1–9, no extension bridge)
- `4` = Skip-ownership (📍2 fires with skipped=true)
- `5` = Post-exec ownership update (_meta backfill/refresh)

---

## Update Rule

Any commit that does any of the following MUST update this document in the same commit:

- Adds a new tool (add row to Section 6 table)
- Removes a tool (remove row, update class member lists in Section 3)
- Changes which engine a tool uses (update table + class membership)
- Modifies the security pipeline order (update Section 4)
- Adds, removes, or renames a telemetry point (update Section 3 flow diagrams + Section 6 notes)
- Changes an IPC protocol (update Section 5)
- Changes which tools are in `SKIP_OWNERSHIP_TOOLS` (update Class 4 members + table)
- Changes which tools trigger IDPI scan or screenshot redaction (update Section 4 + table)

Failure to update this document when changing the above leaves the document stale and
makes debugging harder for all future sessions. The document is load-bearing: tests,
debugging sessions, and new developer orientation all depend on it being current.
