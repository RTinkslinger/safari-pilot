# Safari Pilot connectNative Pivot — Design Spec

> **Type:** Actionable Spec | **Feedback items:** 9 of 9 | **Verdict:** ACTIONABLE
> **Date:** 2026-04-17
> **Supersedes:** Commits 1b (reconcile) and 1c (two-tier timeout) from the event-page design spec
> **Builds on:** Commit 1a (v0.1.5) — all infrastructure remains load-bearing
> **Source evidence:** `safari-sendnativemessage-limits.md` (Parallel deep research, ultra-fast tier)

---

## 1. Problem Statement

Commit 1a shipped the event-page lifecycle fix: `persistent:false` manifest, storage-backed command queue, alarm-driven wake, daemon-side command queuing with flip-back on disconnect. The infrastructure works — daemon queues commands, extension wakes on alarm, polls arrive at daemon, daemon returns queued commands.

But the extension never completes a round-trip. Root cause (confirmed by systematic debugging + deep research):

**Safari kills event pages ~30 seconds after wake.** Each `sendNativeMessage` call creates a separate TCP connection through `SafariWebExtensionHandler.swift` → daemon:19474 → response → connection closed. The full poll→execute→result chain requires multiple sequential `sendNativeMessage` calls. Safari terminates the event page before the chain completes, causing `SFErrorDomain error 3` on in-flight calls.

This is not a concurrency bug or a call-budget limit — it's a fundamental mismatch between `sendNativeMessage`'s per-call connection model and the event page's ~30s lifetime. The research confirms: Apple developer forum staff recommend `browser.runtime.connectNative` for persistent ports; `connectNative` keeps the page alive longer and avoids per-call IPC launch overhead.

**The `sendNativeMessage` drain-on-wake architecture cannot work.** No amount of call ordering, serialization, or retry logic fixes a 30-second kill timer when the poll+execute+result chain can take 60+ seconds (alarm wake delay + content script execution + result delivery).

## 2. Affected Areas

| File | Current Role | Change Scope |
|------|-------------|-------------|
| `extension/background.js` | Wake sequence: alarm → poll via `sendNativeMessage` → execute → result via `sendNativeMessage` | Replace `sendNativeMessage` calls with `connectNative` port; daemon pushes commands; extension sends results on same port |
| `extension/native/SafariWebExtensionHandler.swift` | One-shot TCP proxy: each `sendNativeMessage` → new NWConnection → daemon:19474 → response → cancel | Persistent connection model: port establishment → message loop → no per-message cancel |
| `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` | Poll-driven: extension requests commands via handlePoll; daemon waits passively | Push-driven: daemon sends commands immediately down open port; handlePoll becomes handleDrain (port-triggered); reconcile on reconnect |
| `daemon/Sources/SafariPilotdCore/ExtensionSocketServer.swift` | Transient connections: one receive → dispatch → send → cancel per message | Persistent connections: message loop per connection; no auto-cancel; connection lifecycle tracked |
| `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` | Routes `extension_poll`, `extension_result`, etc. | New route: `extension_port_message` (multiplexed command/result/reconcile on single connection) |
| `src/engines/extension.ts` | `execute()` sends sentinel, waits 90s | No API change; internal timeout semantics adjust (includes reconnect window) |
| `safari-pilot.config.json` | `extension.enabled` kill-switch | No change; kill-switch applies identically |

**Unchanged (load-bearing from 1a):** `HealthStore.swift`, `src/types.ts` (idempotent, StructuredUncertainty), `src/errors.ts` (EXTENSION_UNCERTAIN), `src/security/circuit-breaker.ts` (engine scope), `src/security/human-approval.ts` + `idpi-scanner.ts` (invalidateForDegradation), `src/server.ts` (INFRA_MESSAGE_TYPES, degradation re-run, extension-diagnostics registration), `src/config.ts` (ExtensionConfig), all test infrastructure, all release scripts.

## 3. Approaches

### Option A: connectNative with daemon-push (selected)

Replace `sendNativeMessage` per-wake calls with a single persistent `browser.runtime.connectNative()` port. Daemon pushes commands to the extension as they arrive. Extension sends results back on the same port. Port survives across the event-page wake window (research: "open port can help keep the background script alive").

**Pros:** Single connection eliminates per-call IPC overhead. Daemon can push immediately (no 60s alarm-wake delay for new commands). Port keeps event page alive during active command processing. Aligns with Apple's explicit recommendation.

**Cons:** More complex lifecycle management (port connect/disconnect/reconnect). Requires handler rewrite for persistent connections. Reconcile protocol needed on reconnect (commands sent during port-down window). Safari may still kill the page even with an open port (under memory pressure) — need fallback.

### Option B: Batched single-call (rejected)

Combine poll + N commands + N results into a single `sendNativeMessage` round-trip. Extension sends one message; daemon responds with commands; extension executes all; sends one message with all results.

**Why rejected:** Still subject to the 30s kill timer. If command execution takes >25s (content script on slow page, multiple tabs), the single-call window is exceeded. Also, batching requires knowing all commands upfront — new commands arriving during execution can't be delivered until next alarm wake (back to 60s latency).

### Option C: Hybrid connectNative + sendNativeMessage fallback (rejected for initial implementation)

Use connectNative as primary, fall back to sendNativeMessage batch if connectNative fails (Gate A failure path).

**Why rejected for now:** Premature complexity. Ship connectNative-only first; if Gate A validation fails, the existing `sendNativeMessage` code from 1a is still in git history and can be restored. The kill-switch (`extension.enabled=false`) provides immediate rollback.

## 4. Design

### 4.1 Port Lifecycle

```
Extension wake (alarm / onStartup / onInstalled / script_load)
  │
  ├─ Is port alive? ─── YES ──→ Send reconcile on existing port
  │                                │
  │                                ├─ Daemon responds with pushNew / acked / forget
  │                                │
  │                                └─ Listen for daemon-pushed commands via port.onMessage
  │
  └─ NO ──→ port = browser.runtime.connectNative(APP_BUNDLE_ID)
             │
             ├─ port.onMessage.addListener(handleDaemonMessage)
             │
             ├─ port.onDisconnect.addListener(handlePortDisconnect)
             │
             ├─ Send reconcile: {type:'reconcile', profile, completed, inProgress}
             │
             └─ Listen for daemon-pushed commands
```

**Port establishment:** `browser.runtime.connectNative(APP_BUNDLE_ID)` creates a persistent messaging channel to the native handler. Safari keeps the port open as long as:
- The event page is alive AND
- The native handler hasn't closed the connection AND
- No system memory pressure forces termination

**Port disconnect triggers:**
- Event page unloaded (idle timeout ~30s, memory pressure)
- `port.disconnect()` called explicitly
- Native handler closes the TCP connection to daemon
- Safari kills the extension process

**On disconnect:** Extension stores current state to `storage.local`. On next wake, establishes a new port and reconciles.

### 4.2 SafariWebExtensionHandler — Persistent Connection Model

Currently: each `sendNativeMessage` → `beginRequest` → new NWConnection → one send/receive → cancel.

New model: `connectNative` creates a **persistent port**. Safari calls `beginRequest` once to establish the port. The handler opens a TCP connection to daemon:19474 and keeps it open. Messages flow bidirectionally:

```
Extension port ←──── Safari IPC ────→ Handler ←──── TCP:19474 ────→ Daemon
  port.postMessage(msg)  ──→  beginRequest  ──→  connection.send  ──→  dispatch
  port.onMessage(msg)    ←──  returnResponse ←──  connection.receive ←──  response
```

**Critical change:** The handler's `forwardToDaemon` method becomes a **message loop**, not a one-shot transaction:

```swift
// Pseudo-code for persistent handler
func beginRequest(with context: NSExtensionContext) {
    // First message establishes the port
    let message = extractMessage(context)
    
    // Open persistent TCP connection to daemon
    let connection = NWConnection(host: "127.0.0.1", port: 19474, using: .tcp)
    connection.start(queue: queue)
    
    // Forward first message
    sendToDaemon(connection, message) { response in
        self.returnResponse(response, context: context)
    }
    
    // Keep connection open for subsequent messages
    // Safari will call beginRequest again for each port.postMessage
    // OR Safari may reuse the same context for the port lifetime
}
```

**Open question (Gate A must answer):** Does Safari call `beginRequest` once per `connectNative` port (persistent context) or once per `port.postMessage` call? If per-message, the handler can reuse a stored TCP connection. If per-port, the handler must implement an internal message loop.

**Fallback:** If Safari's `connectNative` doesn't work with the App Extension handler model (the handler is designed for one-shot requests), the handler stores the TCP connection on first `beginRequest` and reuses it for subsequent calls within the same port lifetime. Connection keyed by extension context ID.

### 4.3 Daemon ExtensionBridge — Push Model

**Current (poll-driven):**
1. `handleExecute` queues PendingCommand
2. Extension wakes → sends `poll` → `handlePoll` returns all undelivered
3. Extension executes → sends `result` → `handleResult` resolves continuation

**New (push-driven):**
1. `handleExecute` queues PendingCommand
2. If port is open: daemon **immediately sends command down the port** (no poll needed)
3. If port is closed: command stays queued; on next port connect, daemon pushes all queued
4. Extension executes → sends `result` on port → `handleResult` resolves continuation

**Key new method: `pushToPort(command)`**

```swift
func pushToPort(_ command: PendingCommand) {
    guard let activePort = currentPort else {
        // Port not open — command stays queued, will be pushed on next connect
        return
    }
    command.delivered = true
    activePort.send(commandDict)  // writes JSON to the persistent TCP connection
}
```

**Reconcile on reconnect** (when port re-establishes after event-page reload):

Extension sends: `{type: 'reconcile', profile: <id>, completed: [{commandId, result}], inProgress: [commandId]}`

Daemon responds (same 5-case protocol from 1a spec §5.4):
- `acked`: completed results the daemon already processed
- `doNotReExecute`: commands the daemon knows finished (in executedLog)
- `pushNew`: undelivered commands to send now
- `forget`: stale commands the extension should drop
- `reQueued`: commands the daemon re-queued after delivery uncertainty

This is the reconcile protocol from commit 1b — it becomes part of this commit instead.

### 4.4 background.js — connectNative Pattern

```javascript
// Top-level state
let port = null;
let portAlive = false;

// Port management
function ensurePort() {
    if (port && portAlive) return port;
    
    port = browser.runtime.connectNative(APP_BUNDLE_ID);
    portAlive = true;
    
    port.onMessage.addListener(handleDaemonMessage);
    port.onDisconnect.addListener(() => {
        portAlive = false;
        port = null;
        // State persisted in storage.local — next wake reconnects
    });
    
    return port;
}

// Daemon message handler (commands pushed by daemon)
async function handleDaemonMessage(msg) {
    if (msg.type === 'execute') {
        const cmd = msg.command;
        await updatePendingEntry(cmd.id, { status: 'executing', ... });
        const result = await executeCommand(cmd);
        await updatePendingEntry(cmd.id, { status: 'completed', result });
        // Send result back on same port (no new sendNativeMessage)
        if (port && portAlive) {
            port.postMessage({ type: 'result', id: cmd.id, result });
            await removePendingEntry(cmd.id);
        }
        // If port died during execution, result stays in storage for reconcile
    }
    
    if (msg.type === 'reconcile_response') {
        // Apply daemon's reconcile: acked, doNotReExecute, pushNew, forget, reQueued
        applyReconcileResponse(msg);
    }
}

// Wake sequence (alarm-driven)
async function wakeSequence(reason) {
    const p = ensurePort();
    
    // Reconcile: tell daemon what we have in storage
    const pending = await readPending();
    const completed = [], inProgress = [];
    for (const [id, entry] of Object.entries(pending)) {
        if (entry.status === 'completed') completed.push({ commandId: id, result: entry.result });
        else if (entry.status === 'executing') inProgress.push(id);
    }
    
    p.postMessage({
        type: 'reconcile',
        profile: await getProfileId(),
        completed,
        inProgress,
    });
    
    // Commands arrive async via port.onMessage — no explicit poll loop
}
```

**Key differences from 1a:**
- No `sendNativeMessage` calls anywhere in the wake sequence
- All communication via `port.postMessage` (non-blocking, no Promise)
- Results delivered on the same port (one connection, not three)
- Daemon pushes commands; extension doesn't pull
- Reconcile replaces poll as the synchronization mechanism

### 4.5 Error Recovery

| Scenario | Detection | Recovery |
|----------|-----------|----------|
| Event page killed mid-execution | `port.onDisconnect` fires | Result saved in storage.local; reconcile on next wake delivers it |
| Event page killed before result send | `port.onDisconnect` fires | Same — completed result in storage; reconcile sends it |
| Daemon crashes while port open | `port.onDisconnect` fires (TCP drops) | Extension retries `connectNative` on next alarm; daemon restarts via LaunchAgent |
| Port open but daemon slow to push | No error — normal async wait | Alarm keepalive ensures page wakes even if no commands; port.onMessage fires when command arrives |
| connectNative fails entirely | `port.onDisconnect` fires immediately or `connectNative` throws | Circuit breaker trips after 5 failures; engine-selector falls back to AppleScript |
| Memory pressure kills extension | `port.onDisconnect` fires | Same as event-page kill — storage.local persists; reconcile on next wake |
| Non-idempotent command + disconnect mid-execute | `port.onDisconnect` + storage has `status:'executing'` | Daemon sees disconnect → flips `delivered=false`. On reconnect, reconcile reports `inProgress:[commandId]`. Daemon returns `EXTENSION_UNCERTAIN` with structured `_meta.uncertainResult` (caller decides retry). Content-main.js idempotency Map prevents double-execution if page wasn't navigated. |

### 4.6 Security Pipeline Interaction

- **INFRA_MESSAGE_TYPES:** Add `extension_port_message` to the bypass set. Port messages are daemon↔extension coordination, not per-domain tool calls.
- **Per-engine CircuitBreaker:** Unchanged. 5 `EXTENSION_TIMEOUT` + `EXTENSION_UNCERTAIN` in 120s → engine cooldown. Port disconnect counts as potential timeout if command was in-flight.
- **HumanApproval/IdpiScanner re-run on degradation:** Unchanged. If engine-selector falls back from extension, security pipeline re-runs.
- **Kill-switch:** `extension.enabled=false` disables the extension engine entirely. connectNative port is never established. Unchanged from 1a.

### 4.7 What 1b/1c Scope Merges Into This Commit

| Originally | Now |
|-----------|-----|
| 1b: reconcile protocol | Merged — reconcile is required on port reconnect |
| 1b: daemon executedLog (5-min TTL) | Merged — needed for doNotReExecute response |
| 1b: claimedByProfile | Merged — multi-profile port isolation |
| 1b: SafariWebExtensionHandler reconcile/drain routing | Replaced — handler now does persistent port, not one-shot routing |
| 1c: two-tier timeout (30s/90s) | Simplified — single 90s timeout remains; 30s progress signal is optional |
| 1c: forceReload | Deferred — not needed if connectNative works; if port dies, alarm reconnects naturally |
| 1c: soft degradation | Retained — `_meta.degradationReason` on AppleScript fallback |

### 4.8 Gate A Validation (prototype before implementation)

Before implementing the full spec, validate on a disposable branch `prototype/connectNative`:

**Check 1:** Does `browser.runtime.connectNative(APP_BUNDLE_ID)` return a usable port in Safari 18 with an App Extension handler (not a standalone native host)?

**Check 2:** Does `port.postMessage({...})` deliver messages to the handler's `beginRequest`? Does the handler receive them as separate `NSExtensionContext` invocations or as a stream on one context?

**Check 3:** Can the daemon push a message back to the extension via the handler's response path? Does `port.onMessage` fire when the daemon writes to the TCP connection?

**Check 4:** Does `port.onDisconnect` fire reliably when the event page unloads?

**Check 5:** End-to-end: daemon queues command → pushes to port → extension receives → executes `return document.title` → sends result on port → daemon resolves. Latency?

**Pass:** All 5 checks confirmed. Proceed with full implementation.
**Fail:** connectNative doesn't work with Safari's App Extension model. Fall back to optimized `sendNativeMessage` (batch mode from Option B) or accept that extension engine has 60s+ latency with alarm-driven drain.

**Duration:** 1 day on disposable branch. No commits to main.

## 5. Testing Strategy

| Layer | What to Test | Method |
|-------|-------------|--------|
| Unit (daemon) | executedLog TTL eviction, claimedByProfile rejection, reconcile 5-case response, pushToPort delivery | Swift XCTest in existing harness |
| Unit (TS) | No new TS changes; existing tests cover engine dispatch | vitest (existing 1427 pass) |
| E2E | Full round-trip: MCP call → daemon → port → extension → content script → result | Real Safari, vitest e2e with 90s timeout |
| E2E | Port disconnect recovery: force-unload → reconcile → result delivery | DEBUG_HARNESS force-unload hook |
| E2E | Multi-profile: 2 profiles with separate ports, no command cross-delivery | Manual QA checklist |
| Canary | Real 60s idle → port reconnect → command delivery | Release-time canary (existing test/canary/) |
| Security | EXTENSION_UNCERTAIN on non-idempotent + disconnect; no auto-retry | Existing test/security/ extended |

## 6. Rollback Path

1. **Immediate (config-only, <30 min):** `safari-pilot.config.json` → `extension.enabled: false`. Extension engine disabled; tools degrade to AppleScript. No rebuild needed.
2. **Code rollback:** `git revert` the connectNative commit. 1a's `sendNativeMessage` code is restored from git history. Rebuild extension (`build-extension.sh`), publish `v0.1.5.1` patch.
3. **If connectNative is fundamentally broken (Gate A fails):** Don't implement. Extension engine remains at 1a state (daemon queues, extension wakes on alarm, poll returns commands — but round-trip doesn't complete due to 30s kill timer). Document as known limitation in README. Extension engine is effectively daemon-only until Apple changes event-page lifecycle.

## 7. Feedback Traceability

| # | Feedback Item | Spec Section |
|---|---------------|-------------|
| 1 | Replace sendNativeMessage with connectNative | §4.1 Port Lifecycle, §4.4 background.js |
| 2 | Handler persistent connection support | §4.2 SafariWebExtensionHandler |
| 3 | Daemon push model | §4.3 ExtensionBridge Push Model |
| 4 | Error recovery on port disconnect | §4.5 Error Recovery |
| 5 | Skip 1b/1c, go straight to connectNative | §4.7 Merged Scope |
| 6 | 1a infrastructure remains load-bearing | §2 Affected Areas (Unchanged row) |
| 7 | Security pipeline interaction | §4.6 Security Pipeline |
| 8 | Testing strategy | §5 Testing Strategy |
| 9 | Rollback path | §6 Rollback Path |

## 8. Assumptions

1. **`browser.runtime.connectNative` works with Safari's App Extension handler model.** This is the primary assumption Gate A validates. If false, the entire spec is moot. Apple's documentation doesn't explicitly confirm or deny this for App Extension-based handlers (vs standalone native hosts).
2. **Persistent port keeps the event page alive during active message exchange.** Research says "can help keep the background script alive" — not a guarantee. If Safari still kills the page at 30s regardless of open port, the same problem recurs (but with better recovery via reconcile).
3. **Safari delivers `port.onDisconnect` reliably on event-page termination.** If Safari silently drops the port without firing the event, the daemon enters an ambiguous state (thinks port is alive, sends to dead connection).
4. **Single persistent TCP connection to daemon:19474 handles bidirectional message flow.** The current ExtensionSocketServer is designed for transient connections. Persistent connections require a message-loop handler and careful buffer management.
5. **Reconcile protocol from 1b spec is architecturally sound.** We're merging it in without the 72h observation period originally planned. Risk: reconcile edge cases may surface in production.
