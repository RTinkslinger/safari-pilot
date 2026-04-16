# Safari MV3 Event-Page Pivot — Design Spec

**Date:** 2026-04-17
**Status:** APPROVED (through brainstorming; awaits written-spec review then → writing-plans)
**Scope:** Extension engine lifecycle fix for Safari Pilot on macOS 26 / Safari 18.x
**Driving synthesis:** [`docs/superpowers/brainstorms/2026-04-17-safari-mv3-event-page-synthesis.md`](../../superpowers/brainstorms/2026-04-17-safari-mv3-event-page-synthesis.md) (H2 recommended, validator PASS)
**Supersedes:** `docs/superpowers/specs/2026-04-16-push-wake-design.md` (push-wake via `SFSafariApplication.dispatchMessage`, rejected for FB9804951 foreground-steal)

---

## 1. Problem

Safari Pilot's Extension engine is 100% broken in production: 0 `extension_result` roundtrips across hundreds of deliveries. Root cause is not wake-unreliability — it's the false premise that a pending `browser.runtime.sendNativeMessage` Promise keeps Safari's MV3 service worker alive. Apple's forum-recommended workaround (switch to event-page form) is necessary but insufficient: event pages also unload aggressively after ~30-45s idle with pending Promises in flight. Correct architecture is genuinely ephemeral — accept that the background script dies, design for fast/reliable resurrection from persisted state.

Blast radius of the fix crosses two languages (Swift + JavaScript), five files, a new reconcile protocol, new daemon state (executedLog, claimedByProfile), security-pipeline interactions (INFRA bypass + per-engine CircuitBreaker), and a tiered pre-publish verification workflow.

## 2. Design principles / hard constraints

- **Event pages unload — treat every wake as cold.** No in-memory state assumptions.
- **Daemon state is the source of truth for commands + results.** Extension's `storage.local` is recovery state.
- **Non-idempotent tools (click/type/submit/select) NEVER auto-retry.** Return structured `EXTENSION_UNCERTAIN` on ambiguous disconnect; caller decides explicitly.
- **Observability ships before the change.** Commit 1a includes `safari_extension_health` so we can measure what 1a did.
- **User-facing releases: three (v0.1.5/1.6/1.7).** Rapid-cadence risk accepted to preserve per-commit production measurability.
- **Local e2e is the publish gate.** No GitHub Actions Safari matrix (user-rejected).
- **No system-state manipulation.** No `pluginkit`, no `lsregister`, no `pkill`, no Safari plist edits. No programmatic Safari quit. No tab-switching to existing tabs.
- **No hook bypasses without explicit maintainer acceptance of the failure.** `prepublishOnly` runs server-side; `release.yml` enforces the gate in CI; `--ignore-scripts` exists as a documented escape hatch with owned risk.

## 3. Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  Daemon (SafariPilotd, LaunchAgent)                         │
│  ┌────────────────────────────────┐                         │
│  │ ExtensionBridge                │                         │
│  │  • pendingCommands[] (existing)│                         │
│  │  • executedLog:Dict<id,Date>   │  NEW — 5-min TTL        │
│  │    pin against youngest pending│                         │
│  │  • reconcile handler           │  NEW — 5-case response  │
│  │  • claimedByProfile on cmds    │  NEW                    │
│  │  • delivered flip-back on disc │  NEW behaviour          │
│  │  • two-tier timeout 30s/90s    │  NEW (1c)               │
│  │  • INFRA_MESSAGE_TYPES bypass  │  NEW — pipeline skip    │
│  │  • CircuitBreaker engine:ext   │  NEW — engine scope     │
│  └────────────────────────────────┘                         │
│  ┌────────────────────────────────┐                         │
│  │ HealthStore (NEW, 1a)          │                         │
│  │  • counters (in-memory)        │                         │
│  │  • persisted: lastAlarmFireTs, │                         │
│  │    forceReloadCount24h         │                         │
│  │    → ~/Library/Application     │                         │
│  │      Support/SafariPilot/      │                         │
│  │      health.json               │                         │
│  └────────────────────────────────┘                         │
└──────────────────────┬──────────────────────────────────────┘
                       │ TCP:19474
┌──────────────────────▼──────────────────────────────────────┐
│  SafariWebExtensionHandler.swift                             │
│  1a: no change (default case passes-through unknown types)  │
│  1b: +15-line switch for 'reconcile' / 'drain' types        │
└──────────────────────┬──────────────────────────────────────┘
                       │ sendNativeMessage (drain-on-wake)
┌──────────────────────▼──────────────────────────────────────┐
│  background.js (EVENT PAGE, persistent:false, no IIFE)      │
│  • Top-level listeners; listenersAttached idempotency flag  │
│  • StorageQueue (storage.local.pendingCommands)             │
│  • WakeSequence: reconcile → apply → drain → execute        │
│  • AlarmHeartbeat (1-min keepalive)                         │
│  • No pollLoop, no nativeMessageChain, no IIFE              │
│  • Post-1a size target: ≤340 lines (vs current 445).        │
│    Adds queue + wake-sequence, drops pollLoop + chain + IIFE.│
│    1b adds reconcile (+~60 lines). 1c adds forceReload/     │
│    degradation (+~30 lines). Post-1c ceiling: ≤430.          │
└──────────────────────┬──────────────────────────────────────┘
                       │ tabs.sendMessage (commandId-tagged)
┌──────────────────────▼──────────────────────────────────────┐
│  content-main.js (MAIN world)                                │
│  • window.__safariPilotExecutedCommands = new Map()          │
│    (commandId → {result, timestamp})                         │
│  • Refuse duplicate commandId within page session            │
│  • Returns cached result on duplicate                        │
└─────────────────────────────────────────────────────────────┘
```

### Changes summary

**Manifest:** `"background": {"service_worker":"background.js", "type":"module"}` → `{"scripts":["background.js"], "persistent":false}`

**Deleted from `background.js`:** `pollLoop`, `pollForCommands`, `pollLoopRunning`, `nativeMessageChain`, IIFE wrapper. **Note on IIFE removal:** dropping the IIFE is NOT a style change — it's a semantic change. Event pages re-evaluate the top-level script on every wake; listener registration must be at top level for Safari's wake-event dispatch to find them. An IIFE wrapper defers listener registration to the IIFE's execution frame, which on a Chrome-style service worker was fine but on a non-persistent event page is a load-bearing correctness issue per Apple's sample code and S2 Q4.

**Added:** `StorageQueue`, `WakeSequence`, `listenersAttached` flag, reconcile send/apply, drain-on-wake, alarm-fire timestamp logging, `forceReload` handler (1c, gated by Gate C).

**Daemon:** `executedLog Dict<String, Date>` with 5-min TTL + pin-against-youngest, `handleReconcile`, `claimedByProfile`, `delivered` flip-back on disconnect, two-tier timeout (1c), `HealthStore` with partial persistence (1a), `INFRA_MESSAGE_TYPES` pipeline bypass, engine-scoped `CircuitBreaker`.

**New tools (observability, 1a):** `safari_extension_health`, `safari_extension_debug_dump`. Scoped `safari_extension_*`; NOT counted against "no new user-facing product tools" (per B12). Inventory grows 76 → 78.

**New files (1a):** `extension/build.config.js` (compile flag `__DEBUG_HARNESS__` for test force-unload), `hooks/pre-publish-verify.sh`, `scripts/promote-stable.sh`, `docs/upp/incidents/TEMPLATE.md`, `test/manual/multi-profile.md`.

**Kill-switch (1a):** `safari-pilot.config.json` + `extension.enabled: boolean`. Config-only toggle disables Extension engine server-side in ms; no rebuild/sign/notarize required. Any collaborator with npm publish access can ship config-only patch as `v0.1.N.1` in ≤30 min. Binary patches require Aakash.

## 4. Data flow — four lifecycle cases

### 4.1 Happy path (event page alive)
1. Agent call → `SafariPilotServer.executeToolWithSecurity` → `selectEngine()` returns `extension` → `DaemonEngine.execute(extension_execute sentinel)`
2. `CommandDispatcher.handleInternalCommand` → `ExtensionBridge.handleExecute()` queues `PendingCommand(id=X, delivered=false, continuation, 30s PENDING timer, 90s TIMEOUT timer, claimedByProfile=none)`
3. Extension page is alive + drain loop picks up command → `tabs.sendMessage` → content-script executes → ack + result → `sendNativeMessage({type:'result', id:X, result})` → daemon `handleResult` → `executedLog[X] = now()`, resolves continuation

### 4.2 Cold-wake path (page was dormant)
1. Command X queued (delivered=false, no active port)
2. ≤60s later, extension's 1-min keepalive alarm fires → `initialize('keepalive alarm')` → log alarm-fire timestamp to daemon
3. Extension wake sequence:
   a. Read `storage.local.pendingCommands` (typically empty on cold wake)
   b. sendNativeMessage `{type:'reconcile', profile:<id>, completed:[], inProgress:[]}` → daemon responds `{acked:[], doNotReExecute:[], pushNew:[X], forget:[], reQueued:[]}`
   c. For each `pushNew`: write `storage.local.pendingCommands[X] = {status:'executing', tabUrl, script, timestamp}`
   d. Dispatch via `tabs.sendMessage` → content-script → execute (or return cached result via Map)
   e. Ack → update storage `{status:'completed', result}`
   f. sendNativeMessage `{type:'result', id:X, result}` → daemon resolves, adds to executedLog
   g. Delete from storage

### 4.3 Interrupted path (page unloads mid-execute, result never delivered to daemon)
1. Steps 1-4.2c as cold-wake path
2. Content-script executes command (adds X to `window.__safariPilotExecutedCommands` Map)
3. Content-script sends ack back to background
4. Background updates `storage.local.pendingCommands[X].status='completed', result`
5. **Page unloads before sending result via sendNativeMessage**
6. Daemon still has `pendingCommands[X]` with `delivered=true`, no result; connection disconnect → daemon flips `X.delivered=false`
7. Later wake:
   - Reads storage, sees `completed` with result
   - sendNativeMessage `{type:'reconcile', profile:<id>, completed:[{X, result}], inProgress:[]}`
   - Daemon's `handleReconcile`: X in completed → call `handleResult(X, result)` inline → adds to executedLog, resolves continuation → respond `{acked:[X]}`
   - Extension deletes X from storage

### 4.4 Race / timeout path (daemon resolved to caller via timeout, extension still has result)
1. Interrupted path steps 1-6
2. 90s elapses → `EXTENSION_TIMEOUT` fires, continuation resolves, pendingCommand removed
3. (30s hit earlier → `EXTENSION_PENDING` is not a terminal code, removed from taxonomy; may be emitted via an MCP progress notification (`notifications/progress` via the SDK's server-initiated notification path) if maintainer chooses, but not in 1c scope)
4. Later wake sends reconcile with `completed:[{X, result}]`
5. Daemon: X not in pendingCommands, not in executedLog → respond `{forget:[X]}`
6. Extension deletes X from storage. Stale result dropped. **Caller already saw `EXTENSION_TIMEOUT`** — bounded by 90s, acceptable.

### 4.5 5th case: extension-unknown (5-case reconcile response requires this)
Daemon has `pendingCommands[X]` with `delivered=true` + no result; extension's storage has NO record (storage.local write lost on unload mid-write). On reconcile, extension doesn't mention X in `completed` or `inProgress`. Daemon sees X's `delivered=true` flag but no matching extension entry → **re-queue**: flips `delivered=false`, adds X to response's `reQueued[]`. Extension treats `reQueued[]` same as `pushNew[]` — accepts and executes.

### 4.6 Profile collision (multi-profile wake race)
1. Profile A wakes, sends reconcile `{profile:'A', inProgress:[X]}`
2. Daemon records `pendingCommands[X].claimedByProfile = 'A'`
3. Profile B wakes concurrently, sends reconcile `{profile:'B', inProgress:[X]}`
4. Daemon sees X already claimed by A → response `{acked:[X], claimTaken:[X]}` to profile B
5. Profile B drops X from storage.

## 5. Components and interfaces

> **Commit 1a scope note (post-audit):** 1a intentionally carries significant surface area — it ships observability early (B8) so the lifecycle fix can be measured immediately. That moves health tool + counters + LaunchAgent cron + canary checks + 2 new MCP tools + kill-switch + idempotent-field-migration-across-76-tools + INFRA bypass + per-engine CircuitBreaker into 1a, on top of the core refactor. This is deliberate: 1a without observability is unmeasurable in production. Acknowledged risk: 1a is the largest of the three commits. Mitigation: the `commit-1a-shippable.test.ts` gate (§7.1) is the minimum-viable-ship proof; review is scoped to the core refactor + observability anchor, and 1b/1c only add reconcile + timeout/forceReload behavior on top.

### 5.1 `extension/manifest.json` (1a)

```json
{
  "manifest_version": 3,
  "background": { "scripts": ["background.js"], "persistent": false }
}
```
Other fields unchanged.

### 5.2 `extension/background.js` (1a rewrite; 1b adds reconcile; 1c adds forceReload)

**Module layout (in one file, no ES modules — event pages don't support them):**

- `Constants`: `APP_BUNDLE_ID`, `KEEPALIVE_ALARM_NAME`, `KEEPALIVE_PERIOD_MIN`, error codes.
- `ProfileId`: stable identifier derived from `browser.runtime.id` + first 8 chars of a random persistent UUID stored in `storage.local.__safari_pilot_profile_id`. Sent on every reconcile.
- `StorageQueue`: read/write `storage.local.pendingCommands` (object `{[commandId]: {status, tabUrl, script, timestamp, result?}}`). Atomic reads + writes; no locking needed (single event page instance per profile).
- `NativeMessenger`: thin wrapper around `browser.runtime.sendNativeMessage`. No explicit Promise chain; wake sequence is serial by function structure.
- `CommandExecutor`: finds target tab by URL (existing logic) → `tabs.sendMessage({type:'SAFARI_PILOT_COMMAND', method:'execute_script', commandId, params:{script}})` → receives ack + result.
- `WakeSequence` (~40 lines): the core orchestration. On any wake trigger:
  1. Guarded by `listenersAttached` flag — ensure listeners registered
  2. Read storage, compute `completed` list + `inProgress` list
  3. sendNativeMessage reconcile (1b)
  4. Apply reconcile response (1b): delete forget + acked + claimTaken; re-execute anything not in doNotReExecute; execute pushNew + reQueued
  5. Loop until storage is empty
- `AlarmHeartbeat`: top-level `browser.alarms.create('safari-pilot-keepalive', {periodInMinutes:1})`. On fire: `initialize('keepalive alarm')` + `extension_log` alarm timestamp to daemon for Gate B analysis.
- `ForceReloadHandler` (1c, gated): if daemon response includes `{forceReload:true}`, call `browser.runtime.reload()` — but only if Gate C prototype validates safety. Else softer path: set `_meta.degradationReason='extension_wedged'` and fall through.

**Hard rules encoded in the file:**
- No ES module syntax.
- No IIFE wrapper.
- Every async function that could be interrupted writes state to `storage.local` BEFORE the interruptible action.
- Listener registration guarded by `listenersAttached`; duplicate calls idempotent.

### 5.3 `extension/content-main.js` (1a additive, ~15 lines)

```javascript
if (!window.__safariPilotExecutedCommands) {
  window.__safariPilotExecutedCommands = new Map(); // commandId → {result, timestamp}
}

// In existing execute_script handler:
if (params.commandId && window.__safariPilotExecutedCommands.has(params.commandId)) {
  const cached = window.__safariPilotExecutedCommands.get(params.commandId);
  return { ok: true, cached: true, value: cached.result };
}
// ... execute as usual ...
window.__safariPilotExecutedCommands.set(params.commandId, { result, timestamp: Date.now() });
return { ok: true, value: result };
```

Cache is page-lifetime only; clears on navigation. Daemon's `executedLog` is the cross-page authoritative source.

### 5.4 `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` (extended across 1a/1b/1c)

**1a additions:**
- `handleDisconnected` modified: for every `PendingCommand` with `delivered=true` and no received result, flip `delivered=false` (was: cancel with `EXTENSION_DISCONNECTED`).
- `handlePoll` returns ALL undelivered commands at once (array), not just first. Mark all as `delivered=true`.
- Add new `handleDrain` as an alias for `handlePoll`.
- Store a profile identifier on each `PendingCommand` once claimed (nil until claimed).
- `HealthStore` (new type): counters for roundtripCount1h, timeoutCount1h, uncertainCount1h, forceReloadCount24h. Persists `lastAlarmFireTimestamp` + `forceReloadCount24h` to `~/.safari-pilot/health.json` (colocated with existing daemon state like `~/.safari-pilot/audit.log` — single canonical state directory, not split). Initializes `lastAlarmFireTimestamp = Date.now()` on daemon startup. (Note: `~/.safari-pilot/` is non-sandboxed daemon's local state directory; consistent with existing convention.)

**1b additions:**
- `executedLog`: `[String: Date]` (commandId → completion time). **5-min TTL justification:** Gate B's p99 alarm inter-fire target is 180s; 5 min = ~1.67× that ceiling, giving margin for a late-arriving result from a wake that took longer than typical. If Gate B reveals p99 > 180s, revisit (spec acceptance condition for Gate B is p99 ≤ 180s — fail means retune TTL). **Eviction rule:** `evictIfSafe(commandId)` only if `(now - completionTime) >= 5min` AND `commandId` is NOT within the age window of any currently-outstanding pending command (i.e., don't evict entries that might still match a stale redelivery from a pending command that started before this entry was logged).
- `handleReconcile(commandID, params)`:
  - Input: `{profile: String, completed: [{commandId, result}], inProgress: [commandId]}`
  - Processing:
    - For each `completed[i]`: if pendingCommands contains → call `handleResult` inline; if already in executedLog → `acked`; else → ignore (stale).
    - For each `inProgress[j]`: if in executedLog → `doNotReExecute`; if in pendingCommands and `claimedByProfile != nil && != profile` → `claimTaken`; else → claim for `profile`.
    - Scan pendingCommands for `delivered=true` AND claimedByProfile=nil that are NOT in extension's `inProgress` → that's the 5th case: flip `delivered=false`, include in `reQueued`.
    - Scan pendingCommands for `delivered=false` → include in `pushNew`, claim for `profile`.
    - Scan extension's `completed` list — any commandId unknown to daemon → `forget`.
  - Output: `{acked:[], doNotReExecute:[], pushNew:[], forget:[], reQueued:[], claimTaken:[]}`.

**1c additions:**
- Two-tier timeout: at 30s elapsed, emit internal state `EXTENSION_PENDING` (not a terminal code, may surface via an MCP progress notification (`notifications/progress` via the SDK's server-initiated notification path)); at 90s elapsed, resolve continuation with `EXTENSION_TIMEOUT`.
- ForceReload trigger logic: if `Date.now() - lastAlarmFireTimestamp > 180s` AND `pendingCommands` is non-empty AND Gate C passed → emit `{forceReload:true}` on next extension connection. Gate C fails → emit `_meta.degradationReason='extension_wedged'` instead.
- Per-engine CircuitBreaker: `engine:extension` scope. 5 `EXTENSION_TIMEOUT`+`EXTENSION_UNCERTAIN` in 120s → 120s engine cooldown → engine-selector forces AppleScript fallback.

### 5.5 `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` (1b)
Add routes: `"extension_reconcile" → extensionBridge.handleReconcile`, `"extension_drain" → extensionBridge.handlePoll` (alias).

### 5.6 `extension/native/SafariWebExtensionHandler.swift` (1b, ~15 lines)
Add to `buildDaemonMessage` switch:
```swift
case "reconcile": return ["id": requestId, "method": "extension_reconcile", "params": message]
case "drain":     return ["id": requestId, "method": "extension_drain"]
```
1a requires no change — default case passes unknown types through.

### 5.7 `src/tools/extension-diagnostics.ts` (NEW, 1a)
Two tools: `safari_extension_health`, `safari_extension_debug_dump`. Tool descriptors set `idempotent: true`. Registered in `src/server.ts` alongside existing tools.

### 5.8 `src/server.ts` (1a)
- Add `INFRA_MESSAGE_TYPES` constant set: `{'extension_poll', 'extension_drain', 'extension_reconcile', 'extension_connected', 'extension_disconnected', 'extension_log', 'extension_result'}`. Pipeline-bypass for these (analogous to existing `SKIP_OWNERSHIP_TOOLS`).
- CircuitBreaker wiring: add engine-scope dimension to the breaker's key scheme.
- Engine-degradation re-run: on fallback engine selection, re-invoke HumanApproval + IdpiScanner for the new engine's action surface. Old approval token becomes invalid.

### 5.9 `src/types.ts` / `src/tools/*` (1a) — new required field on ToolRequirements

**Interface change — explicit:**
```typescript
// src/types.ts — ToolRequirements currently begins with requiresShadowDom?, no idempotent field.
// 1a ADDS a new required field:
export interface ToolRequirements {
  idempotent: boolean;   // NEW — required, no default. 1a migration adds the flag to all 76 tool definitions.
  requiresShadowDom?: boolean;
  // ...existing optional flags unchanged
}
```
`tsc --noEmit` fails if any tool definition omits `idempotent`.

**Migration task for 1a:** all 76 existing tool declarations in `src/tools/*.ts` get the flag added explicitly. No default — every tool must declare.

Definite non-idempotent (confirmed): `safari_click`, `safari_type`, `safari_submit_form`, `safari_select_option`, `safari_fill_form`, `safari_upload`.
Definite idempotent (confirmed): all `safari_get_*`, `safari_query_*`, `safari_snapshot`, `safari_get_attribute`, `safari_list_tabs`.
Borderline (implementation-review decides per-tool in 1a; default `false` / non-idempotent if unclear): `safari_press_key` (Enter may submit), `safari_hover` (may trigger JS + animations), `safari_scroll` (usually safe but may fire scroll handlers), `safari_drag` (may trigger dragend handlers).

### 5.10a `docs/upp/incidents/TEMPLATE.md` + `hooks/session-end.sh` wiring (1a)

Template file (required at commit 1a ship):
```markdown
# Incident: <slug>

**Date:** YYYY-MM-DD | **Version that broke:** vX.Y.Z | **Rolled back to:** vX.Y.Z-1

## Trigger fired (which of 6)
[1-6]

## Detection lag
[time from commit-ship to rollback-trigger]

## Diagnostic artifacts
- daemon log tail SHA: <sha>
- safari_extension_health output: [paste]
- reproduction steps: [list]

## Root cause
[specific mechanism]

## Fix commit
[SHA + description]

## Regression test added
[yes — test/<path>.test.ts / no — justify why not]
```

Stop-hook wiring detailed in §8.5. `hooks/session-end.sh` checks `.last-rollback-commit` timestamp vs newest `docs/upp/incidents/*.md` mtime.

### 5.10 `safari-pilot.config.json` (1a)
Add:
```json
{
  "extension": {
    "enabled": true,
    "killSwitchVersion": "0.1.5"
  }
}
```
Config-loader honors `extension.enabled=false` as a runtime kill-switch — engine-selector returns only `daemon`/`applescript`, Extension-engine tools degrade or return `EngineUnavailableError` immediately.

## 6. Error handling

### 6.1 Timeout taxonomy (8 terminal codes — after R1 removed EXTENSION_PENDING)

`EXTENSION_PENDING` was removed entirely from error taxonomy per R1 — it is not an error code. The 30s checkpoint is handled separately in §6.5 as a progress signal, not a terminal response.

| Condition | Code | Behavior | Retryable? |
|-----------|------|----------|-----------|
| cmd delivered, no response 90s | `EXTENSION_TIMEOUT` | terminal; removed from queue | caller decides |
| non-idempotent + disconnect pre-ack | `EXTENSION_UNCERTAIN` with structured `_meta.uncertainResult` | terminal; never auto-retry | caller decides |
| non-idempotent + not delivered + disconnect | requeue (delivered=false) | silent | n/a |
| idempotent + disconnect mid-execute | revert delivered; redeliver + executedLog dedupe | silent | yes (inside stack) |
| daemon delivered=true + no result, ext has no record (5th case) | daemon re-queues with delivered=false | silent | yes |
| profile collision on reconcile | `CLAIM_TAKEN` | first-claimer wins | n/a |
| no alarm-fire > 180s AND pending exists | forceReload via next connection (Gate C pass) OR softer degradation | auto-recovery | n/a |
| Extension engine CircuitBreaker tripped | engine-selector forces AppleScript | silent fallback | n/a |

### 6.2 Structured `_meta.uncertainResult` (R2)

```typescript
{
  disconnectPhase: 'before_dispatch' | 'after_dispatch_before_ack' | 'after_ack_before_result',
  likelyExecuted: boolean,
  recommendation: 'probe_state' | 'caller_decides'
}
```
`retryable: false` set explicitly in the response.

### 6.3 Security re-run on degradation (R5)
When engine-selector falls back (Extension → Daemon → AppleScript), old HumanApproval token becomes invalid; re-invoke HumanApproval + IdpiScanner against the new engine's action surface before execution.

### 6.4 Observability: `safari_extension_health` tool schema

```typescript
{
  isConnected: boolean,
  lastAlarmFireTimestamp: number | null,  // persisted
  lastReconcileTimestamp: number | null,
  lastExecutedResultTimestamp: number | null,
  roundtripCount1h: number,
  timeoutCount1h: number,
  uncertainCount1h: number,
  forceReloadCount24h: number,            // persisted
  executedLogSize: number,
  pendingCommandsCount: number,
  claimedByProfiles: string[],
  engineCircuitBreakerState: 'closed' | 'open' | 'half-open',
  killSwitchActive: boolean
}
```

### 6.5 Response metadata + 30s progress signal (non-terminal)

**Progress signal (NOT an error, NOT terminal):** at 30s elapsed on a pending command, daemon MAY emit an MCP progress notification (`notifications/progress` with the call's `progressToken` from the original `CallToolRequest`) using the @modelcontextprotocol/sdk server's notification path. This is advisory — the tool call still returns exactly one terminal response (either `result` or `EXTENSION_TIMEOUT` at 90s). Whether to emit the 30s signal is a commit-1c implementation decision; the spec does not require it.

**Terminal response metadata additions:**
- `_meta.degradationReason?: string` (e.g., `'extension_dormant_fallback_to_applescript'`, `'extension_wedged'`, `'engine_breaker_tripped'`, `'power_policy_throttling'`)
- `_meta.uncertainResult?: StructuredUncertainty` (per 6.2)
- `_meta.forceReloadTriggered?: boolean`
- `_meta.retryable?: boolean` (explicit for non-idempotent tools; set to `false` on `EXTENSION_UNCERTAIN`)

### 6.6 Rollback trigger detector (B2)
LaunchAgent `com.safari-pilot.health-check.plist` with `StartCalendarInterval` hourly: runs `safari_extension_health --threshold-check` against the daemon, writes to `~/.safari-pilot/health.log`. Breach conditions:
- 0 roundtrips in 2h despite pending commands exist
- `uncertainCount1h` > `max(3× baseline, 2%)` for 4 consecutive hours
- `forceReloadCount24h` > 5
On breach: `osascript -e 'display notification "Safari Pilot: Extension degraded" with title "Safari Pilot"'`. No external telemetry.

## 7. Testing strategy

### 7.1 Commit 1a (v0.1.5) — Lifecycle fix + observability

**Unit:**
- `test/unit/tools/requirements.test.ts` — every tool declares `idempotent` flag; defaults correct per tool class.
- `test/unit/engine-proxy.test.ts` — `EXTENSION_UNCERTAIN` surfaces with structured `_meta.uncertainResult`; no auto-retry.
- `test/unit/extension-kill-switch.test.ts` — `extension.enabled=false` in config makes engine-selector skip `extension`.
- `daemon/Tests/ExtensionBridgeTests.swift` (existing 42 tests + new):
  - `testHandleDisconnectedFlipsDeliveredBackForUnacked`
  - `testHandlePollReturnsAllUndeliveredAtOnce`
  - `testHealthStorePersistsAlarmTimestamp`
  - `testCircuitBreakerEngineExtensionScope`

**E2e:**
- `test/e2e/commit-1a-shippable.test.ts` — **the minimum-viable gate for 1a**. Cold-wake roundtrip + 5 successive idempotent roundtrips + assertion `grep -L reconcile extension/background.js` returns 0 (1a does NOT contain reconcile code).
- `test/e2e/extension-lifecycle.test.ts` — cold-wake via `__safariPilotTestForceUnload()` (compile-flag gated), non-idempotent ambiguous timeout, storage queue persistence.
- `test/e2e/engine-selection.test.ts` (update) — degradation metadata assertions; kill-switch takes effect.
- `test/e2e/extension-health.test.ts` — `safari_extension_health` schema, counter semantics.

**Canary:** `test/canary/real-cold-wake-60s.test.ts` — ONE real-Safari 60s-idle test. Runs at release time only; not in per-publish smoke suite.

**Security:** `test/security/extension-recovery-bypass.test.ts` — `EXTENSION_UNCERTAIN × IdpiScanner` flagged-action no-auto-retry.

### 7.2 Commit 1b (v0.1.6) — Reconcile + executedLog

**Unit:**
- `test/unit/extension/reconcile-schema.test.ts` — serialize + deserialize each of 5 response variants + malformed rejection.
- `daemon/Tests/ExtensionBridgeTests.swift`:
  - Each of 5 reconcile cases (acked/doNotReExecute/pushNew/forget/reQueued)
  - `testExecutedLogTTLEviction`
  - `testExecutedLogPinAgainstYoungestPending`
  - `testClaimedByProfileRejectsSecondClaim` (replaces the thundering-herd e2e claim per R11)
  - `testReconcileSchemaDecoderRejectsMalformed`

**E2e:**
- `test/e2e/extension-reconcile.test.ts` — full reconcile exchange with force-unload mid-execute; cached-result return.
- `test/e2e/concurrent-mcp-sessions.test.ts` (renamed from thundering-herd) — spawns isolated test daemon on TCP:19475, two MCP client sessions, verify `delivered` flag + `claimedByProfile` de-dupe.

**Security:** `test/security/extension-recovery-bypass.test.ts` (extend) — `forceReload × CircuitBreaker` cooldown bypass check.

**Manual:** `test/manual/multi-profile.md` — checklist; `.multi-profile-verified-{commitSha}` flag file gated by pre-publish hook.

### 7.3 Commit 1c (v0.1.7) — Two-tier timeout + forceReload / degradation

**Unit:**
- `test/unit/tools/extension-health.test.ts` (extend) — counters reset on hour boundaries.
- `daemon/Tests/ExtensionBridgeTests.swift`:
  - `testTwoTierTimeout30sPending90sTimeout`
  - `testForceReloadTriggerConditions`
  - `testForceReloadDisabledWhenGateCFails`

**E2e:**
- `test/e2e/force-reload.test.ts` (or `test/e2e/soft-degradation.test.ts` depending on Gate C outcome) — induce trigger, verify recovery.

**Security:** `test/security/extension-recovery-bypass.test.ts` (extend) — rate-limiter double-counting on recovery.

### 7.4 Pre-publish verify harness (1a)

**`npm run verify:extension:smoke`** (≤4-6 min, runs on every publish via hook):
1. `npm run build`
2. `bash scripts/update-daemon.sh`
3. `bash scripts/build-extension.sh`
4. Entitlement + version + bundle-ID canary (R18):
   - `codesign -d --entitlements -` → assert `com.apple.security.app-sandbox=true` on .app AND .appex
   - `CFBundleVersion` of .app matches `package.json` version AND > last-tagged version
   - `CFBundleVersion` of .appex matches regex `^\d{12}$`
5. Compute SHA-256 bundle digest of `bin/Safari Pilot.app` (it's a directory bundle, `shasum` alone refuses directories) and plain SHA-256 of `bin/SafariPilotd`:
   ```bash
   # Bundle digest: deterministic hash over every file in the .app bundle
   BUNDLE_SHA=$(find "bin/Safari Pilot.app" -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256 | awk '{print $1}')
   # Daemon binary: plain file hash
   DAEMON_SHA=$(shasum -a 256 "bin/SafariPilotd" | awk '{print $1}')
   ```
   Both hashes recorded in `.verified-this-session` for the hook to compare at publish time.
6. Run 5 critical e2e: `mcp-handshake`, `extension-engine`, `extension-lifecycle`, `extension-health`, `commit-1a-shippable`. (1b+ add `extension-reconcile`; 1c+ adds `force-reload` or `soft-degradation`.)
7. On green → write `.verified-this-session` with `{commitSha, appSha, daemonSha, suiteResult, timestamp, smokePassed:true}`

**`npm run verify:extension:full`** (15-20 min, local on-demand): full `test/e2e/extension-*.test.ts` + multi-profile manual checklist reminder.

**Hook `hooks/pre-publish-verify.sh`** (PreToolUse on `npm publish`, `gh release create`, `gh release upload`):
1. `.verified-this-session` exists?
2. `commitSha` matches `git rev-parse HEAD`?
3. `appSha` matches `shasum bin/Safari Pilot.app` now?
4. `daemonSha` matches `shasum bin/SafariPilotd` now?
5. `.multi-profile-verified-<commitSha>` exists (B11)?
6. ALL yes → allow. ANY no → block with diagnostic.

**`package.json` `prepublishOnly` script** runs `hooks/pre-publish-verify.sh`. This gates `npm publish` and `npm publish --tag X` (2 of 5 pathways). `.npmrc` with `ignore-scripts=false` declares policy but does NOT prevent CLI bypass via `npm publish --ignore-scripts` — that bypass is an explicit maintainer choice with owned failure.

**PreToolUse hook (Claude Code level)** — `hooks/pre-publish-verify.sh` is also registered as a PreToolUse hook matching Bash invocations of `gh release create`, `gh release upload`, and `gh release edit`. Covers pathways 3-5 when the maintainer uses the `gh` CLI through Claude Code. Direct shell `gh` outside Claude Code is NOT gated — the final defense is release.yml.

**`release.yml` hardening (CI-level defense)** — the GitHub Actions workflow runs `hooks/pre-publish-verify.sh` as its first step and verifies `.verified-this-session` is committed with sha-chain integrity (commit SHA in the file matches the tag-pushed commit; artifact hashes match the artifacts being released). If the verified file is missing, stale, or doesn't match → workflow fails-closed. This catches the tag-push → release.yml pathway (#5) regardless of local hook state.

Summary of gating per pathway:
| # | Pathway | Gate |
|---|---------|------|
| 1 | `npm publish` (local) | `prepublishOnly` script |
| 2 | `npm publish --tag X` (local) | `prepublishOnly` script |
| 3 | `gh release create` (via Claude Code Bash) | PreToolUse hook |
| 4 | `gh release upload` (via Claude Code Bash) | PreToolUse hook |
| 5 | Tag push → `release.yml` (CI) | Workflow first-step hook + sha-chain check |

Bypass paths: `npm publish --ignore-scripts`, `gh release create` outside Claude Code, direct asset upload via browser UI. These are documented escape hatches with owned failure.

### 7.5 Per-commit benchmark smoke (R17)
10-task representative slice (target <3 min). Fails commit if pass-rate drops >1 task vs. baseline. Full 90-task run reserved for pre-commit-2 release.

## 8. Rollback and distribution

### 8.1 Pre-publish gate flow
See 7.4. Tiered (smoke on every publish, full on-demand). Hook enforcement at `prepublishOnly` + `release.yml`.

### 8.2 Post-publish monitoring (24-48h per release)
- **Automated:** LaunchAgent hourly health-check cron with osascript notification on breach (B2).
- **Maintainer-driven:** call `safari_extension_health` periodically; check breach conditions.
- **User-visible:** GitHub Issues; template requires `safari_extension_health` output + daemon log tail.

### 8.3 Rollback triggers (with detectors, per B2+B3)
1. **0 roundtrips despite pending commands for 2h** — hourly cron trigger.
2. **`uncertainCount1h` > `max(3× baseline, 2%)` for 4 consecutive hours** — hourly cron. Baseline measured over first 48h post-1a-release; unmeasurable case triggers on "any sustained >0% for 4h on idempotent tools."
3. **Extension disappears from Safari Settings** (v0.1.1-v0.1.3 class) — user-reported.
4. **Notarization failure** — build-time.
5. **Safari crashes / lost tabs linked to extension** — user-reported. **Instant response via kill-switch (S4).**
6. **`forceReloadCount24h > 5`** — hourly cron.

### 8.4 Kill-switch (config-only rollback)
`safari-pilot.config.json` → `extension.enabled: false`. Engine-selector skips Extension engine; tools degrade or return `EngineUnavailableError`. Config-only patch ships as `v0.1.N.1` via npm publish with only the config file changed — no binary rebuild/sign/notarize required. Turnaround: ≤30 min from decision to user-installed-via-`npm update`. For git-clone users: `git pull` delivers the config change. The `.app` bundle is unchanged, so Safari extension registration stays intact. **This is the 30-second engineering response to trigger 5 (Safari crashes / lost tabs); users get relief as fast as their update cadence allows.**

### 8.5 Rollback procedure (standard, for triggers 1-4, 6)
1. `git revert <commit-sha>` → merge to main → tag as `vN.N.N-revert`
2. `scripts/promote-stable.sh` atomically writes `.last-rollback-commit` file with the reverted commit SHA + timestamp (rollback-detector signal for stop-hook).
3. `bash scripts/build-extension.sh` + notarize
4. Upload to GitHub Release as new `latest`; promote previous `latest` → `latest-stable` per state machine (§8.6)
5. `npm publish`
6. Write incident to `docs/upp/incidents/<date>-rollback.md` per `docs/upp/incidents/TEMPLATE.md`.

**Stop-hook rollback-detection mechanism:** `hooks/session-end.sh` reads `.last-rollback-commit`. If present AND no file matching `docs/upp/incidents/*.md` has modification time newer than the `.last-rollback-commit` timestamp, hook blocks session close with: `"Rollback recorded at <timestamp> — incident doc missing. Create docs/upp/incidents/<date>-<slug>.md before closing session."` When the incident doc is written (mtime > rollback timestamp), the hook passes. The `.last-rollback-commit` file is cleared by the next successful non-revert publish.

**Turnaround:** 2-4h log-diagnosable, 8-24h if new instrumentation needed. **Exception: trigger 5 via kill-switch → 30 min config-only patch.**

### 8.6 `latest-stable` state machine (S5)
```
latest-stable = max(version where age(version) >= 72h AND no rollback triggers fired for this version)
```
Implemented in `scripts/promote-stable.sh`, run at each release. Kept on GitHub Releases alongside `latest`.

### 8.7 Bus-factor (S10)
Any collaborator with npm publish access can ship `v0.1.N.1` config-only kill-switch patch in ≤30 min without Aakash. Binary patches still require Aakash's signing identity + access.

### 8.8 Three-release cadence
- v0.1.5 (Commit 1a) → lifecycle fix + observability
- v0.1.6 (Commit 1b) → reconcile
- v0.1.7 (Commit 1c) → two-tier timeout + forceReload/degradation
- v0.1.8 (Commit 2, pending Gate A) → connectNative if validated
- v0.2.0 (reserved) → H3 descope if triggered (major bump per B14; README "Known Limitations" same commit, release notes, `safari_extension_health.degraded_capability=true`)

## 9. Validation gates

### 9.1 Gate A — `connectNative` empirical suitability (pre-Commit 2)
**Pre-condition:** v0.1.7 shipped + stable ≥ 72h.
**Where:** disposable branch `prototype/connectNative`.
**Duration:** 1-2 days.
**Checks:**
- Does `browser.runtime.connectNative` deliver daemon-pushed messages to a live event page?
- Does `port.onDisconnect` fire reliably on event-page unload?
- Is end-to-end roundtrip latency < `sendNativeMessage` baseline?
**Pass:** Commit 2 (v0.1.8) ships with `connectNative` as primary IPC.
**Fail:** Commit 2 ships documentation-only noop OR no Commit 2; `sendNativeMessage`-drain remains permanent.

### 9.2 Gate B — 1-min alarm empirical reliability (post-v0.1.5 48h observation)
**Pre-condition:** v0.1.5 shipped + 48h observation window via Gate B instrumentation.
**Measurement protocol:**
- Daemon logs every `extension_log` message with `alarm_fire` tag to `~/.safari-pilot/alarm-log.jsonl`.
- Observation scenarios: maintainer runs normal workflow for ≥12h each in: (a) idle Safari (Safari open, no active use), (b) active Safari browsing, (c) Safari + macOS Low-Power-Mode enabled, (d) Safari + lid briefly closed (closed state >5 min then reopened), (e) Safari backgrounded (another app active for ≥10 min).
- Script `scripts/analyze-gate-b.sh` computes per-scenario: median, p90, p99 inter-fire interval.
**Pass:** median ≤ 90s across ALL scenarios; p99 ≤ 180s.
**Fail - tier 1:** median > 90s in one or more scenarios → bump daemon timeout to 180s in v0.1.7.
**Fail - tier 2:** median > 180s in LPM/lid-closed → `safari_extension_health` surfaces `_meta.degradationReason='power_policy_throttling'` for those conditions; Extension engine falls back automatically under detected power policy.
**Fail - tier 3:** median > 180s in idle/active → trigger descope path (H3 → v0.2.0), alarms fundamentally unreliable.

### 9.3 Gate C — `browser.runtime.reload()` safety (pre-Commit 1c)
**Pre-condition:** Commits 1a + 1b shipped. Before 1c coding begins.
**Where:** disposable branch `prototype/forceReload-safety`.
**Duration:** 1 day.
**Checks:**
- Does `browser.runtime.reload()` on Safari 18+ event page actually reinstall + run top-level?
- Does `storage.local` state persist across the reload?
- Do pending in-flight `tabs.sendMessage` operations terminate cleanly?
- Observable user-visible side effects (Safari flashes, tab state changes, etc.)?
**Pass:** Commit 1c ships with `forceReload` as the 180s-no-alarm recovery mechanism.
**Fail:** Commit 1c ships softer degradation (`_meta.degradationReason='extension_wedged'` + AppleScript fallback + release-notes instruction to open `.app` for manual recovery). `forceReload` moves to commit-3+ backlog pending Apple documentation.

## 10. Out-of-scope

### 10.1 Deferred with specific trigger
- **connectNative** → Commit 2 (pending Gate A)
- **Full 90-task benchmark re-run** → pre-Commit-2 release
- **`forceReload` actual implementation** → Commit 1c (pending Gate C); else replaced with soft-degradation in 1c
- **Daemon timeout re-tuning** → post-Gate-B analysis
- **H3 descope pivot → v0.2.0** → triggered only if Gate A + Gate B both fail + 2 remediation cycles don't fix

### 10.2 Permanently out
- CI e2e on GitHub Actions Safari matrix (user explicitly rejected)
- External telemetry (Datadog / Grafana / etc.) — observability is local-only (log files + `safari_extension_health`)
- Multi-profile automated e2e (manual checklist only, enforced via `.multi-profile-verified-<commitSha>` flag)
- WKWebView hybrid pivot (H3 is descoping, not WKWebView)
- Security-pipeline LAYER behavior changes (`INFRA_MESSAGE_TYPES` bypass is a whitelist addition; per-engine CircuitBreaker is a scope addition — neither changes existing layer logic)
- New user-facing PRODUCT tools (observability tools namespaced `safari_extension_*` permitted per B12)
- Packaging infrastructure changes (Xcode project structure, signing identity, notarization pipeline unchanged)

### 10.3 Operational work (not in commits)
- Gate A prototype (disposable branch)
- Gate B measurement analysis (script + log mining)
- Gate C prototype (disposable branch)
- Per-release multi-profile manual QA execution
- 24-48h post-release monitoring via `safari_extension_health`
- Incident documentation at `docs/upp/incidents/` if rollback triggered

## 11. Open questions and risks (resolved via validation work)

1. Does `connectNative` deliver a better primitive in our sandboxed `.appex` + TCP-proxy architecture? → Gate A.
2. What's the empirical alarm-fire distribution on Safari 18+/macOS 26 under mixed load / LPM / lid-closed? → Gate B.
3. Is `browser.runtime.reload()` safe on Safari 18+ event pages? → Gate C.
4. Thundering-herd across 3 profiles in practice — log noise cost, cross-profile coordination quirks. → Observed via v0.1.5+ in production with `safari_extension_health`.
5. Safari profile storage partitioning — do profiles independently run the wake sequence? → Assumed yes per S1 research; verified in multi-profile manual QA.

## 12. Acceptance criteria

All must be true before v0.1.5 ships:

1. Commit 1a scope matches section 5.7-5.10 + relevant parts of 5.2-5.4 (observability added early).
2. All new unit tests in section 7.1 pass; existing 1378 unit tests + 42 daemon tests still pass.
3. `test/e2e/commit-1a-shippable.test.ts` passes on the v0.1.5 HEAD commit specifically.
4. `verify:extension:smoke` passes in ≤6 min locally.
5. Entitlement + version + bundle-ID canary passes (R18 — catches v0.1.1-v0.1.3 class).
6. `.verified-this-session` written with matching commit + artifact SHAs.
7. `.multi-profile-verified-<v0.1.5-sha>` exists (manual QA checked per B11 + S11).
8. `safari_extension_health` tool returns valid schema + counters increment on tool use.
9. Kill-switch: `extension.enabled=false` in config takes immediate effect (engine-selector skips Extension).
10. LaunchAgent health-check installed; hourly cron functional.
11. `latest-stable` state machine documented in `scripts/promote-stable.sh`.
12. `docs/upp/incidents/TEMPLATE.md` exists; stop-hook blocks session close if rollback happened without incident doc.
13. `ARCHITECTURE.md` updated — specifically these sections:
    - "IPC Architecture" — replace description of service-worker polling with event-page wake + reconcile + drain flow.
    - "Three-Tier Engine Model" → "Tier 1: Extension Engine" — update the data flow diagram with storage-backed queue + reconcile cycle.
    - "Security Pipeline" — add `INFRA_MESSAGE_TYPES` bypass note + per-engine CircuitBreaker scope.
    - "Extension Build Pipeline" — note manifest change (service_worker → scripts+persistent:false) + new `build.config.js`.
    - "CURRENT STATE WARNING" — remove the "Extension engine does not work end-to-end" warning once 1a ships and roundtrips are confirmed; update to reflect 1a's observability surface.
    - Add new section "Event-Page Lifecycle" documenting wake sequence, reconcile protocol, executedLog, claimedByProfile.
    - Version history — add entry for v0.1.5 (1a) with verification evidence.
14. `TRACES.md` iteration entry recording the ship.
15. `CHECKPOINT.md` updated: current state is "event-page pivot commit 1a shipped"; lists Gate A/B/C as upcoming.

Parallel acceptance criteria for 1b (v0.1.6) and 1c (v0.1.7) match sections 7.2 and 7.3 respectively.

## 13. Appendix

### 13.1 Glossary
- **Event page**: a non-persistent background script (`"scripts":[…], "persistent":false`). Safari-documented MV3 option.
- **Reconcile**: bidirectional protocol between daemon and extension on wake that synchronizes command state.
- **executedLog**: daemon-side authoritative record of completed commandIds for duplicate-detection.
- **claimedByProfile**: daemon-side field preventing multi-profile double-claim.
- **`EXTENSION_UNCERTAIN`**: terminal error code on non-idempotent tool ambiguous disconnect; structured `_meta.uncertainResult` tells caller how to proceed. Never auto-retried.
- **Kill-switch**: `safari-pilot.config.json` → `extension.enabled: false`. Runtime disable of Extension engine; no rebuild required.
- **Gate A/B/C**: empirical validation prototypes for connectNative feasibility / alarm reliability / `browser.runtime.reload()` safety.

### 13.2 Prior art / references
- Synthesis: [`docs/superpowers/brainstorms/2026-04-17-safari-mv3-event-page-synthesis.md`](../../superpowers/brainstorms/2026-04-17-safari-mv3-event-page-synthesis.md)
- Research artifacts (repo root): `safari-mv3-event-page-wake-2026-04-17.{json,md}`, `safari-mv3-event-page-native-messaging-2026-04-17.{json,md}`, `safari-mv3-alternatives-2026-04-17.{json,md}`
- Superseded: [`docs/superpowers/specs/2026-04-16-push-wake-design.md`](../../superpowers/specs/2026-04-16-push-wake-design.md)
- Project references: `CHECKPOINT.md`, `ARCHITECTURE.md`, `CLAUDE.md`, `TRACES.md`, `extension/background.js`, `extension/manifest.json`, `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`, `extension/native/SafariWebExtensionHandler.swift`
