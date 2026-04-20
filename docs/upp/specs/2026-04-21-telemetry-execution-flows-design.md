# Telemetry & Execution Flow Map — Design Spec

**Date:** 2026-04-21
**Status:** Approved
**Deliverables:**
1. Trace instrumentation system (TS + Swift + JS) — always-on, verbose
2. `docs/EXECUTION-FLOWS.md` — canonical execution flow map with telemetry points

---

## 1. Problem Statement

Safari Pilot has four cooperating processes (MCP server, daemon, extension, content script) spanning three languages (TypeScript, Swift, JavaScript). When a tool call fails or produces unexpected results, there is **zero visibility** into which layer received what, where data was transformed, or where the call stalled. The system is completely dark between entry (MCP request) and exit (MCP response).

Current state:
- Daemon: `Logger.info` for connect/disconnect/poll only (no command flow logging)
- Extension: `console.warn` on error paths only (invisible unless Web Inspector is open)
- TypeScript (server, engines): zero telemetry
- No correlation between layers

---

## 2. Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Consumer | Developer debugging | Trace a single tool call end-to-end when something fails |
| Output | Shared NDJSON files (per-process) | Single `grep commandId` gives full trace |
| Activation | Always-on, verbose | ~5-10 lines per tool call. Never miss data. 60KB/day growth. |
| Correlation ID | Existing `commandId` (`req-{ts}-{counter}`) | Already flows through all 4 layers |
| TS↔Daemon unification | Separate files, merge script | Eliminates cross-process file contention |
| Approach | Layered trace (SRE recommended) | Minimal code surface (~200 lines total), no dependencies, grep-debuggable |

---

## 3. Trace Event Schema

Every trace event is one NDJSON line:

```json
{
  "ts": "2026-04-21T02:30:00.123Z",
  "id": "req-1776722002-4",
  "layer": "server",
  "level": "event",
  "event": "engine_selected",
  "data": { "engine": "extension", "reason": "requiresShadowDom" },
  "elapsed_ms": 12
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ts` | ISO 8601 string | yes | When the event was emitted |
| `id` | string | yes | commandId correlating all events for one tool call |
| `layer` | enum | yes | Which component emitted this event |
| `level` | `"event"` or `"error"` | yes | Normal flow vs failure/rejection |
| `event` | string | yes | What happened (snake_case, unique per layer) |
| `data` | object | yes | Free-form payload relevant to the event |
| `elapsed_ms` | number | no | Milliseconds since tool call start or since previous event |

### Layer Enum Values

| Layer | Process | File |
|-------|---------|------|
| `server` | MCP server (TS) | `~/.safari-pilot/trace.ndjson` |
| `engine-proxy` | MCP server (TS) | `~/.safari-pilot/trace.ndjson` |
| `extension-engine` | MCP server (TS) | `~/.safari-pilot/trace.ndjson` |
| `daemon-engine` | MCP server (TS) | `~/.safari-pilot/trace.ndjson` |
| `daemon-dispatcher` | Daemon (Swift) | `~/.safari-pilot/daemon-trace.ndjson` |
| `daemon-bridge` | Daemon (Swift) | `~/.safari-pilot/daemon-trace.ndjson` |
| `extension-bg` | Extension (JS→daemon) | `~/.safari-pilot/daemon-trace.ndjson` |
| `extension-content` | Content script (JS→daemon) | `~/.safari-pilot/daemon-trace.ndjson` |

---

## 4. Trace Output Files

| File | Writer | Contents |
|------|--------|----------|
| `~/.safari-pilot/trace.ndjson` | TypeScript MCP server | Server security pipeline, engine proxy, engine dispatch/result |
| `~/.safari-pilot/daemon-trace.ndjson` | Swift daemon | Command dispatch, extension bridge, extension-forwarded logs |

### Unified View

```bash
# All events for one command:
grep "req-1776722002-4" ~/.safari-pilot/trace.ndjson ~/.safari-pilot/daemon-trace.ndjson | sort -t'"' -k4

# All errors:
grep '"level":"error"' ~/.safari-pilot/trace.ndjson ~/.safari-pilot/daemon-trace.ndjson

# Merge script (scripts/trace-merge.sh):
cat ~/.safari-pilot/trace.ndjson ~/.safari-pilot/daemon-trace.ndjson | sort -t, -k1 | grep "$1"
```

### File Rotation

No automatic rotation in v1. At 60KB/day, files reach ~2MB/month. `scripts/trace-rotate.sh` clears files > 5MB. Not automated — monthly manual cleanup is sufficient for a developer tool.

---

## 5. Instrumentation Points (15 total)

### Server Layer — 8 points (`trace.ndjson`)

| # | Event | Location | Data Fields | Level |
|---|-------|----------|-------------|-------|
| 1 | `tool_received` | `executeToolWithSecurity()` entry | `{tool, tabUrl, paramKeys}` | event |
| 2 | `ownership_check` | After step 7d | `{tabUrl, found, deferred, domainMatch, extensionTabId}` | event/error |
| 3 | `domain_policy` | After DomainPolicy.evaluate() | `{domain, trustLevel, blocked}` | event |
| 4 | `rate_limit_check` | After RateLimiter.recordAction() | `{domain, remaining, limit}` | event |
| 5 | `engine_selected` | After selectEngine() | `{engine, degraded, degradedReason, toolRequirements}` | event |
| 6 | `engine_dispatch` | Before tool handler call | `{commandId, engine, tabUrl}` | event |
| 7 | `tool_result` | After tool handler returns | `{ok, hasContent, engine, metaTabId, metaTabUrl, elapsed_ms}` | event/error |
| 8 | `post_verify` | After post-execution ownership | `{backfilled, urlRefreshed, deferredVerified, newUrl, extTabId}` | event/error |

### Daemon Layer — 4 points (`daemon-trace.ndjson`)

| # | Event | Location | Data Fields | Level |
|---|-------|----------|-------------|-------|
| 9 | `command_received` | CommandDispatcher.dispatch() | `{commandId, method, hasTabUrl}` | event |
| 10 | `bridge_queued` | ExtensionBridge.handleExecute() | `{commandId, pendingCount, extensionConnected}` | event |
| 11 | `extension_polled` | ExtensionBridge.handlePoll() delivers | `{commandId, pollWaitMs}` | event |
| 12 | `bridge_result` | ExtensionBridge.handleResult() | `{commandId, ok, hasMeta, metaTabId, metaTabUrl, wrapperApplied}` | event/error |

### Extension Layer — 3 points (via `extension_log` → `daemon-trace.ndjson`)

| # | Event | Location | Data Fields | Level |
|---|-------|----------|-------------|-------|
| 13 | `cmd_dispatched` | After `storage.local.set({sp_cmd})` | `{commandId, tabId, tabUrl}` | event |
| 14 | `result_received` | When resultListener fires | `{commandId, ok, hasValue, elapsed_ms}` | event/error |
| 15 | `result_enriched` | After `_meta` enrichment | `{commandId, tabId, tabUrl, enriched}` | event |

---

## 6. Implementation — Trace Functions

### TypeScript: `src/trace.ts`

```typescript
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TRACE_DIR = join(homedir(), '.safari-pilot');
const TRACE_FILE = join(TRACE_DIR, 'trace.ndjson');

try { mkdirSync(TRACE_DIR, { recursive: true }); } catch { /* exists */ }

export type TraceLayer = 'server' | 'engine-proxy' | 'extension-engine' | 'daemon-engine';
export type TraceLevel = 'event' | 'error';

export function trace(
  id: string,
  layer: TraceLayer,
  event: string,
  data: Record<string, unknown>,
  level: TraceLevel = 'event',
  elapsed_ms?: number,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    id, layer, level, event, data,
    ...(elapsed_ms !== undefined && { elapsed_ms }),
  });
  try { appendFileSync(TRACE_FILE, line + '\n'); } catch { /* never break the product */ }
}
```

### Swift: `daemon/Sources/SafariPilotdCore/Trace.swift`

```swift
import Foundation

enum Trace {
    private static let filePath: String = {
        let dir = NSHomeDirectory() + "/.safari-pilot"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: nil)
        return dir + "/daemon-trace.ndjson"
    }()

    private static let fileHandle: FileHandle? = {
        if !FileManager.default.fileExists(atPath: filePath) {
            FileManager.default.createFile(atPath: filePath, contents: nil)
        }
        return FileHandle(forWritingAtPath: filePath)
    }()

    static func emit(
        _ id: String,
        layer: String,
        event: String,
        data: [String: Any] = [:],
        level: String = "event"
    ) {
        let obj: [String: Any] = [
            "ts": ISO8601DateFormatter().string(from: Date()),
            "id": id,
            "layer": layer,
            "level": level,
            "event": event,
            "data": data
        ]
        guard let json = try? JSONSerialization.data(withJSONObject: obj),
              var line = String(data: json, encoding: .utf8) else { return }
        line += "\n"
        fileHandle?.seekToEndOfFile()
        fileHandle?.write(line.data(using: .utf8) ?? Data())
    }
}
```

### Extension JS: trace via daemon HTTP

```javascript
function emitTrace(commandId, event, data) {
  httpPost('/result', {
    requestId: '__trace__',
    result: { type: 'trace', id: commandId, layer: 'extension-bg', event, data }
  }).catch(() => {});
}
```

Daemon's `handleResult()` (in `ExtensionBridge.swift`, the method that processes HTTP POST /result from background.js) checks `requestId` before looking up a continuation. If `requestId == "__trace__"`, it appends the `result` dict to `daemon-trace.ndjson` via `Trace.emit()` and returns an empty success response. No continuation lookup occurs.

---

## 7. Execution Flow Document (`docs/EXECUTION-FLOWS.md`)

Canonical document structure:

### Sections

1. **How to Read** — explains trace files, correlation, grep patterns
2. **Trace Files** — paths, merge commands, rotation
3. **Tool Classes** — 5 classes, each with ASCII flow diagram + telemetry point markers:
   - Class 1: Extension-Engine Tools (majority — full 15-point flow)
   - Class 2: AppleScript-Only Tools (safari_new_tab, list_tabs, close_tab — server points only)
   - Class 3: Daemon-Direct Tools (safari_export_pdf, safari_wait_for_download)
   - Class 4: Skip-Ownership Tools (overlaps with 1-3, skip point #2)
   - Class 5: Navigation + Ownership Update (extension flow + post-exec URL refresh)
4. **Security Pipeline** — layer-by-layer order with which points fire
5. **IPC Protocols** — wire formats, timeouts, which telemetry brackets each
6. **Tool → Class Mapping** — table of all 78 tools and their class

### Update Rule

Any commit that adds a tool, changes engine routing, modifies the security pipeline, or adds/removes a telemetry point MUST update `docs/EXECUTION-FLOWS.md` in the same commit. (Same rule as ARCHITECTURE.md.)

---

## 8. Failure Modes & Graceful Degradation

| Failure | Behavior |
|---------|----------|
| Trace file unwritable (permissions, disk full) | `appendFileSync` throws → caught → silently dropped. Tool call proceeds normally. |
| Daemon trace file unwritable | Swift `fileHandle?.write` is nil-safe. Event dropped. Daemon continues. |
| Extension `httpPost('/result', {trace})` fails | `.catch(() => {})` — fire and forget. Command execution unaffected. |
| Trace file grows unbounded | Manual rotation via `scripts/trace-rotate.sh`. No automated mechanism in v1. |

**Hard rule:** Telemetry must NEVER fail a tool call. Every trace call is wrapped in a catch/try that drops silently on failure.

---

## 9. What This Enables (Debugging Scenarios)

| Scenario | How to debug |
|----------|-------------|
| Command never reached daemon | `grep $id trace.ndjson` shows `engine_dispatch` but `daemon-trace.ndjson` has no `command_received`. TCP/NDJSON delivery failed. |
| Stuck in ExtensionBridge | `daemon-trace.ndjson` shows `bridge_queued` but no `extension_polled`. Extension not polling. |
| Storage bus timeout | `daemon-trace.ndjson` shows `cmd_dispatched` from extension but no `result_received`. Content script didn't respond. |
| `_meta` lost/corrupted | `bridge_result` shows `hasMeta:true, wrapperApplied:true` but `tool_result` shows `metaTabId:undefined`. Bug in ExtensionEngine `_meta` extraction. |
| Ownership rejected incorrectly | `ownership_check` shows `{found:false, deferred:false, domainMatch:false}`. Explains why `TabUrlNotRecognizedError` was thrown. |
| Deferred verify failed | `post_verify` shows `{deferredVerified:false, extTabId:undefined}`. extensionTabId was never backfilled. |

---

## 10. Scope Boundaries

**In scope:**
- 15 trace instrumentation points across 3 languages
- `src/trace.ts` module (~25 lines)
- `daemon/Sources/SafariPilotdCore/Trace.swift` (~30 lines)
- Extension `emitTrace()` function (~5 lines)
- Daemon `__trace__` sentinel handling (~10 lines)
- `docs/EXECUTION-FLOWS.md` canonical document
- `scripts/trace-merge.sh` and `scripts/trace-rotate.sh`

**Out of scope:**
- Automated log rotation
- Log aggregation / external systems
- Performance metrics / percentiles
- OpenTelemetry export
- UI for viewing traces
- Modifying AuditLog or TraceCollector (existing systems kept as-is)

---

## 11. Known Limitations

1. **Two files, not one** — requires merge for unified view. Acceptable tradeoff for zero file contention.
2. **Extension trace delivery is fire-and-forget** — if daemon HTTP is down, extension trace events are lost. The daemon's own `bridge_queued`/`bridge_result` still captures the daemon's perspective.
3. **No span hierarchy** — events are flat. Order is inferred from timestamps. Acceptable for a linear call graph (no fan-out/scatter-gather).
4. **`appendFileSync` blocks event loop** — for sub-512-byte writes on SSD, this is sub-microsecond. Not a concern for a one-at-a-time MCP server.
5. **Two-part TLDs in `domainMatch` data** — the telemetry faithfully reports what `domainMatches()` returned. It doesn't fix the eTLD+1 approximation.
