# Push-Wake Design — Safari MV3 Extension Resilience

> ⚠️ **SUPERSEDED 2026-04-17** — rejected after adversarial audit + parallel-cli research.
> Findings that killed it:
> 1. `SFSafariApplication.dispatchMessage` from containing app brings Safari to foreground on every call (Apple FB9804951, acknowledged bug). Dealbreaker for agent UX.
> 2. Apple's own documented workaround for MV3 service-worker "permanently killed" bug is to switch to **event page** background: `{"scripts":[...], "persistent":false}`. Dramatically simpler than push-wake and avoids the foreground-steal bug entirely.
>
> This spec encodes the old push-wake thinking. Kept as historical record. DO NOT implement.
> See `CHECKPOINT.md` for the current path and the next-session prompt for research tasks.

---

**Date:** 2026-04-16
**Status:** Superseded — see banner above
**Authors:** Brainstorming session with Aakash
**Supersedes:** Prior session's stashed attempts (commit `b24eedd`, `WIP: push-based extension delivery attempts`)
**Related:** Task #3 (daemon long-polling, completed); Task #4 (extension_result roundtrip, in progress)

## 1. Problem

Safari's MV3 service worker for `com.safari-pilot.app.Extension` is aggressively unloaded by Safari, even with pending `sendNativeMessage` Promises, `browser.alarms`, `runtime.onStartup`, and `runtime.onInstalled` registered. Observed evidence:

- Safari > Develop > Web Extension Background Content shows **"not loaded"** for all three profiles (Developer, Personal, Research) minutes after the last worker activity.
- Daemon log: 264 `extension_execute` deliveries across sessions, **0 `extension_result`** responses ever. Every roundtrip fails because the worker is dead by the time the result would be sent.
- Standard JS-side keepalive techniques (chained Promise poll loop, keepalive alarm at the 1-minute Safari minimum) are insufficient to keep the worker alive across normal idle periods.

**Root cause:** Safari does not honor the MV3 keepalive semantics Chrome implements. Once the worker is unloaded, standard browser-dispatched events (tab updates, alarms, runtime messages) do not reliably revive it within product-acceptable latency.

**Consequence for product:** the Extension engine (the differentiator for Shadow DOM access, CSP bypass, network interception, cross-origin frames) is effectively unusable beyond ~5 minutes after `.app` registration. Current benchmark result: 42.2% pass rate, with most failures attributable to dead-worker timeouts.

## 2. Solution: Hybrid Push-Wake

Wake the dormant service worker via **`SFSafariApplication.dispatchMessage()` called from the containing app**, which is the only Apple-supported sub-2s push path to a Safari Web Extension. A safety-net keepalive alarm remains as a defense-in-depth fallback.

### 2.1 Architecture (end-to-end)

```
FAST PATH (push, <1s wake target)

  MCP client
    │
    ▼ stdin or TCP:19474
  daemon (SafariPilotd, LaunchAgent)
    │
    ▼ CommandDispatcher → ExtensionBridge.handleExecute
    │  queues PendingCommand(delivered=false)
    │  wakes waitingPolls[0] if any (Task #3 fast-path)
    │  fires ExtensionBridge.onCommandQueued hook
    │
    ▼ AppRelayServer.signalWake()
  TCP:19475 broadcast "wake\n" to all connected relay clients
    │
    ▼ NWConnection
  Safari Pilot.app (LaunchAgent, LSUIElement, no Dock)
    │  AppDelegate.listenForWakeSignals receives bytes
    │
    ▼ SFSafariApplication.dispatchMessage(
    │    withName: "commandReady",
    │    toExtensionWithIdentifier: "com.safari-pilot.app.Extension",
    │    userInfo: nil)
    │
    ▼ Safari routes to extension background.js
  browser.runtime.onMessage handler branches on {name:'commandReady'}
    │
    ▼ initialize('pushWake') → pollLoop()
    │
    ▼ sendNativeMessage({type:'poll'})
  daemon.handlePoll fast-path (Task #3): pendingCommand is already
  queued, delivered=false → returns it immediately, flips delivered=true
    │
    ▼ background.js executeAndReturnResult
    │
    ▼ sendNativeMessage({type:'result', id, result})
  daemon.handleResult resolves original extension_execute continuation
    │
    ▼ MCP response


SAFETY NET (keepalive alarm, up to 60s wake latency)

  browser.alarms.create('safari-pilot-keepalive', {periodInMinutes: 1})
    │
    ▼ onAlarm fires (Safari MV3 minimum)
  initialize('keepalive alarm') → pollLoop()

  Independent of the push path. If push fails (app down, dispatchMessage
  errors, extension onMessage listener missed the event), the worker
  still wakes within 60 seconds and drains any queued commands.
```

### 2.2 Why `dispatchMessage` is available in this context

The Xcode 16 availability attribute marks `SFSafariApplication.dispatchMessage` as unavailable **when called from an app extension target (.appex)** — because Apple wants extensions to use `browser.runtime.sendMessage` peer-to-peer instead. We call it from the **containing app target** (`Safari Pilot.app/Contents/MacOS/Safari Pilot`), where it remains fully supported. The stashed `AppDelegate.swift` calls it from this container context. Validation step included in implementation (compile + runtime verify in macOS 26 / Xcode 16).

## 3. Components

### 3.1 New components

**`AppRelayServer.swift`** (daemon) — recovered from stash.
- Listens on `TCP localhost:19475`.
- Accepts N concurrent client connections (only 1 expected in practice: the containing app).
- `signalWake()` writes `"wake\n"` to each client's NWConnection.
- Removes clients on `.cancelled` or `.failed` state.
- `start()` called unconditionally during daemon boot in `main.swift`. If no clients are connected (e.g., app not running), `signalWake()` becomes a no-op with a single `Logger.info` line — no detection logic needed.

**`AppDelegate.swift`** (containing app) — recovered from stash, unchanged.
- `applicationDidFinishLaunching`: connects NWConnection to `127.0.0.1:19475`.
- `listenForWakeSignals`: on any non-empty receive → calls `SFSafariApplication.dispatchMessage(withName:"commandReady", toExtensionWithIdentifier:"com.safari-pilot.app.Extension", userInfo:nil)`.
- Auto-reconnect with 5-second backoff on `.failed` or `.cancelled`.
- `applicationShouldTerminateAfterLastWindowClosed: false` so the app doesn't quit when its (invisible) window is dismissed.

**LaunchAgent plist for the containing app** — new.
- Path: `scripts/launchagent/com.safari-pilot.app.plist` in-repo; installed to `~/Library/LaunchAgents/com.safari-pilot.app.plist` by postinstall.
- `RunAtLoad: true`, `KeepAlive: true`, `ProgramArguments: ["<bin>/Safari Pilot.app/Contents/MacOS/Safari Pilot"]`.
- Postinstall: `launchctl bootstrap gui/<uid> <plist>` (preferred over deprecated `load`).

**`Info.plist` change (containing app)** — add `LSUIElement: YES` so the app has no Dock icon / menu bar / windows. It runs silently as a relay daemon.

**`background.js` — `runtime.onMessage` wake branch** — extend existing listener.
- Add branch: `if (message?.name === 'commandReady') { sendResponse({ok:true}); initialize('pushWake'); return false; }`
- `initialize` is idempotent (pollLoopRunning guard from Task #3) — safe to call from push and alarm simultaneously.

### 3.2 Modified components

**`ExtensionBridge.swift`** — add `public var onCommandQueued: (() -> Void)?`. Fire inside `handleExecute`'s `queue.sync` block after `pendingCommands.append`. Already designed in stash diff.

**`daemon/Sources/SafariPilotd/main.swift`** — instantiate `AppRelayServer`, wire `extensionBridge.onCommandQueued = { [weak relay] in relay?.signalWake() }`, start the relay server.

**`scripts/postinstall.sh`** — install the app LaunchAgent plist in addition to the daemon one.

**`scripts/preuninstall.sh`** — `launchctl bootout` both LaunchAgents.

**`scripts/build-extension.sh`** — no change; `AppDelegate.swift` is already part of the Xcode project (it's `@main` for the app target).

## 4. Data flow cases

| Case | Flow | Latency |
|---|---|---|
| **A. Worker alive, waiting poll exists** | `handleExecute` wakes waitingPoll directly (Task #3 fast-path). `signalWake` also fires but the extension is already processing. Harmless redundant wake. | <50ms |
| **B. Worker alive, no waiting poll** | `handleExecute` queues; `signalWake` fires; app dispatches; extension receives `commandReady` → next poll hits fast-path. | <300ms |
| **C. Worker dormant, app running** | `handleExecute` queues; `signalWake` fires; app dispatches; Safari wakes worker to deliver `runtime.onMessage`; handler runs `initialize` → pollLoop → fast-path. | <1s (assumed; measured in acceptance test) |
| **D. Worker dormant, app not running** | `signalWake` has 0 clients → logs and returns. Command sits in queue. After ≤60s, keepalive alarm fires in whichever profile Safari is willing to revive → pollLoop → fast-path. | ≤60s + 30s daemon timeout. If neither fires, `EXTENSION_TIMEOUT` after 30s — caller retries. |
| **E. Push dispatches but worker doesn't wake (Safari refuses/drops)** | `dispatchMessage` completion handler logs the error. Command stays queued. Alarm safety net takes over (≤60s). If Safari acks the dispatch but the extension never receives the onMessage — the only signal is the absence of a subsequent poll; the alarm path still recovers. | ≤60s |
| **F. Extension already processing prior command** | `delivered=true` on earlier pendingCommand; new command queues with `delivered=false`; next poll picks it up. No duplication (Task #3 regression test). | <50ms after prior result |

## 5. Error handling and observability

Every boundary logs on failure:

- `AppRelayServer`: logs client count on each `signalWake`. 0 clients = explicit warning `"AppRelayServer: signaling wake to 0 relay client(s) — is Safari Pilot.app running?"`.
- `AppDelegate`: `NSLog` on connect/disconnect/dispatch errors. Writes to unified log under subsystem `com.safari-pilot.app`; visible via `log stream --predicate 'subsystem == "com.safari-pilot.app"'`.
- Daemon: existing `DISPATCH:` and `EXT-LOG:` instrumentation stays. Add `RELAY:` prefix for relay signal events so filters are clean.
- Extension: push wake branch increments a counter in `storage.local` for post-mortem visibility.

## 6. Testing strategy (TDD)

Every new piece goes through red-green-refactor. Each component listed with its failing test written first.

### 6.1 Swift unit tests (daemon)

- `testAppRelayServerStartsAndReturnsPort` — listener ready, port retrievable.
- `testAppRelayServerAcceptsClient` — connect, assert `clients.count == 1`.
- `testAppRelayServerBroadcastsWakeBytes` — two clients connect, `signalWake` called, both receive `"wake\n"`.
- `testAppRelayServerDropsDisconnectedClient` — client cancels, `clients.count` reverts.
- `testExtensionBridgeFiresOnCommandQueuedAfterExecute` — set hook, call `handleExecute`, assert invoked exactly once.
- `testExtensionBridgeOnCommandQueuedNilSafe` — hook unset, `handleExecute` doesn't crash.

### 6.2 Swift unit tests (containing app)

Split `AppDelegate`'s wake handler out of lifecycle code so it's testable with a protocol-based `DispatchMessageService` injected in tests. Assert:

- `testWakeBytesTriggerDispatchMessage` — feed bytes, assert mock service captures `("commandReady", extensionBundleId, nil)`.
- `testDisconnectReconnectsAfter5s` — simulate `.failed`, virtual clock advances 5s, new NWConnection attempted.
- `testEmptyReceiveDoesNotDispatch` — receive of 0 bytes is ignored.

### 6.3 Vitest source-checks (extension)

Pattern matches existing `test/unit/extension/background.test.ts`:

- `registers runtime.onMessage handler that branches on name:'commandReady'`.
- `commandReady handler calls initialize() (pollLoop idempotent)`.
- `alarms keepalive path unchanged` (regression).

### 6.4 Integration tests (daemon + app)

Standalone Swift test binary that:

1. Spawns daemon as subprocess.
2. Spawns app as subprocess with `DISPATCH_TEST_HOOK_PATH=<fifo>` env var — AppDelegate replaces `SFSafariApplication.dispatchMessage` with a writer to the FIFO in test mode.
3. Sends `extension_execute` to daemon via TCP.
4. Reads FIFO — asserts `("commandReady", ...)` within 1s.

### 6.5 E2E acceptance test (the real one)

Spec: after this change, the following sequence must succeed unattended:

1. Fresh install (or Safari restart).
2. User opens `Safari Pilot.app` once, confirms extension enabled in Safari settings.
3. User closes the `.app` window (LSUIElement means it has no window anyway; LaunchAgent keeps it running).
4. **User waits 10 minutes doing unrelated Safari browsing.** Worker confirmed unloaded via Safari > Develop > Web Extension Background Content.
5. Claude Code session fires `extension_execute`.
6. **Expected: roundtrip returns a result within 5 seconds** via push-wake path.
7. Daemon log shows: `DISPATCH: method=extension_execute`, `AppRelayServer: signaling wake to 1 relay client(s)`, `DISPATCH: method=extension_poll`, `DISPATCH: method=extension_result`.

This test is manual but defines acceptance. If it passes repeatedly (5/5 cold trials over a day), the feature ships. If it fails, we do not ship — we regress.

## 7. Explicit non-scope for v1

- ❌ Command payload inline in `dispatchMessage.userInfo` (signal-only; size-independent and easier to reason about).
- ❌ Per-profile targeting. `dispatchMessage` delivers to all profiles' copies of the extension; our `delivered` flag (Task #3) ensures exactly one executes.
- ❌ App Store distribution concerns (stays Developer ID + notarized, per existing pipeline).
- ❌ Containing-app self-update / versioning checks.
- ❌ Relay protocol versioning beyond raw `"wake\n"` bytes. If we ever need versioned messages, wrap in a length-prefixed framing — out of scope.
- ❌ Metrics / telemetry for wake latency. Logged but not aggregated.
- ❌ Windows / non-macOS support. Already gated by `package.json` `os: ["darwin"]`.

## 8. Migration and deployment

- The daemon change is backwards compatible: `AppRelayServer` runs independently. If no relay client connects, `signalWake` is a no-op. Existing flows (alarm, user-opened-app) keep working.
- The LaunchAgent plist is only installed on fresh npm install / `git clone` install via postinstall. Existing users get it when they update and re-run postinstall (or on first `npm update safari-pilot`).
- First-run UX: after `.app` opens for the first time, user sees extension in Safari settings as before. No new user-facing setup step.

## 9. Open questions for implementation phase

Not blockers for approval, but flagged so the plan's first step can resolve them:

- Verify `SFSafariApplication.dispatchMessage` compiles and runs from the containing app target under Xcode 16 and macOS 26 before committing to the rest. If Apple has tightened the availability attribute in this combination, fall back to Approach C (handler long-hold from stash) or revisit.
- Confirm `LSUIElement: YES` on an app that registers a Safari Web Extension doesn't cause Safari to treat the extension as orphaned on install.
- Confirm `launchctl bootstrap` behavior when the user hasn't granted Full Disk Access / Automation permissions — is the app still scheduled?

## 10. Acceptance criteria

All must be true before merge:

1. All new Swift unit tests pass; existing 42/42 tests still pass.
2. Extension vitest suite passes including new wake-branch test.
3. Integration test (daemon+app, FIFO hook) passes in CI or local runner.
4. Manual E2E acceptance test (§ 6.5) passes 5/5 over a ≥24h window with intentionally long idle gaps.
5. Benchmark rerun shows improvement from 42.2% baseline — acceptance threshold: **≥70%** of extension-requiring tasks pass cold (no `.app` reopen required).
6. `ARCHITECTURE.md` updated with the push-wake section + the corrected worker-lifecycle narrative.
7. `TRACES.md` iteration entry recording the ship.

## 11. Out-of-scope follow-ups (captured as roadmap items, not this spec)

- Latency telemetry dashboard.
- Multi-window / multi-extension-instance coordination if we ever install copies in more than one profile-like container.
- Windows port of this mechanism (entirely different API surface).
