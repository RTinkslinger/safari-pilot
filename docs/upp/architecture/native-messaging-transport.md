# Native Messaging Transport — Architecture (v0.1.36+)

> **Status:** DESIGN. Not yet implemented. This doc unblocks the implementation in [task #12].
>
> **Goal:** replace the current HTTP short-poll between Safari extension and daemon with `browser.runtime.connectNative`. Eliminates the 5s poll-hold per command cycle. Expected impact: 30-60s saved per WebVoyager task on a 20-tool-call workload.

## Problem (current state)

`extension/background.js` (line ~700+ in the worktree HEAD) communicates with the Swift daemon via:

```
GET  http://127.0.0.1:19475/poll      (long-poll: holds up to 5s for a command)
POST http://127.0.0.1:19475/result    (delivers execution result)
POST http://127.0.0.1:19475/connect   (reconcile on wake)
```

Every command incurs a `/poll` hold delay (worst-case 5s before the daemon delivers a queued command). For a task doing 20 tool calls, that's up to **100s of pure poll-wait** per task — and bench profile data confirms the median task burns ~30-60s on this transport alone.

The HTTP server is implemented in `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` (Hummingbird-based, port 19475).

## Solution architecture

Safari WebExtension's `browser.runtime.connectNative(hostId)` opens a **persistent stdio pipe** between the extension's background script and a native messaging host process that Safari spawns and manages. Apple's reference: ["Messaging a web extension's native app"](https://developer.apple.com/documentation/safariservices/safari_web_extensions/messaging_a_web_extension_s_native_app).

**The key win**: sub-millisecond to low-millisecond round-trip per message (versus 0-5000ms HTTP poll-hold). Push, not poll.

### Component diagram

```
                                  Safari (host: macOS)
                                  ┌───────────────────────────────┐
   ┌───────────────────┐          │  Safari Pilot Extension       │
   │ MCP server (Node) │          │  ┌─────────────────────────┐  │
   │ (per Claude       │  TCP     │  │ background.js (event    │  │
   │  Code session)    │ :19474   │  │ page, NOT polling)      │  │
   │                   │◄────────►│  │                         │  │
   └─────────┬─────────┘   NDJSON │  │ port = runtime          │  │
             │                    │  │ .connectNative(host)    │  │
             │                    │  └──────┬──────────────────┘  │
             │                    └─────────│─────────────────────┘
             │                              │  stdio (JSON, framed)
             │                              ▼
   ┌─────────▼─────────┐           ┌────────────────────┐
   │ SafariPilotd      │   UDS     │ SafariPilotNative  │
   │ (long-running     │◄─────────►│ Host (per extension│
   │  daemon,          │ /tmp/sp   │  instance, short-  │
   │  launchctl)       │  .sock    │  lived)            │
   └───────────────────┘           └────────────────────┘
```

The native host is a **thin shim** — Swift executable, single file — that:
1. Reads JSON messages from stdin (framed with 4-byte big-endian length prefix, per Apple's WebExtension native messaging protocol).
2. Forwards to the daemon via a Unix Domain Socket at `/tmp/safari-pilot.sock`.
3. Forwards daemon responses back to extension via stdout.

The daemon does NOT change lifetime — it stays launchctl-managed and long-running. The native host comes and goes with each extension session (Safari spawns/respawns it on extension wake).

### Why not make the daemon itself the native host?

- The daemon needs to outlive a single Safari session (it persists across browser restarts, services other clients).
- Safari spawns the native host with its own privileges/sandbox — entangling that with the daemon's launchctl service would complicate signing/lifecycle.
- The shim is ~50 lines of Swift; no real cost to keeping it separate.

### Why not use XPC instead of UDS?

XPC is Mach-port-based and is the "Apple way" for daemon IPC on macOS. UDS is simpler and well-understood. For the first cut, UDS keeps the daemon implementation small (Hummingbird's transport story is HTTP/TCP, not XPC). Future revision can upgrade to XPC if the per-message overhead matters (likely doesn't — sub-ms either way).

## Implementation plan

### Phase 1 — Daemon: add UDS listener (parallel to existing TCP/HTTP)

- New file: `daemon/Sources/SafariPilotdCore/NativeMessagingUDSServer.swift`.
- Bind to `/tmp/safari-pilot.sock` (mode 0600, owner-only).
- Accept connections; each connection is one long-running native-host instance.
- Per connection: read framed JSON messages (4-byte big-endian length + payload), dispatch through the existing `CommandDispatcher`, write framed responses back.
- Lifecycle: started in `main.swift` alongside HTTP server. Removed on daemon shutdown.

**Acceptance**: `nc -U /tmp/safari-pilot.sock` can manually send a framed `extension_health` message and receive a structured response.

### Phase 2 — Native host executable

- New file: `daemon/Sources/SafariPilotNativeHost/main.swift` (or a sibling target).
- Reads framed JSON from stdin (extension → host direction).
- Opens UDS connection to `/tmp/safari-pilot.sock`.
- Bidirectional relay between stdin/stdout (extension side) and UDS (daemon side).
- Exit cleanly on EOF (when Safari closes the connection).
- Build artifact: `bin/SafariPilotNativeHost` (universal binary, signed).

**Acceptance**: launching manually with a framed JSON on stdin (echoed from a fixture) sees the response on stdout.

### Phase 3 — Native messaging host plist

- New file: `app/Safari Pilot Extension/NativeMessagingHosts/com.safari-pilot.native-host.json` (path may need tweaking for Safari's lookup):

```json
{
  "name": "com.safari-pilot.native-host",
  "description": "Safari Pilot native messaging host",
  "path": "SafariPilotNativeHost",
  "type": "stdio",
  "allowed_extensions": ["com.safari-pilot.SafariPilot.Extension"]
}
```

- Bundled inside the `.app` at `Contents/Library/NativeMessagingHosts/`.
- `scripts/build-extension.sh` must:
  - Build the native host binary.
  - Copy it into the app bundle.
  - Place the plist in the bundle.
  - Re-sign and re-notarize.

**Acceptance**: `pluginkit -v -m | grep safari-pilot` shows the native host registered.

### Phase 4 — Manifest update

- `extension/manifest.json`:
  ```json
  "permissions": [..., "nativeMessaging"]
  ```
- Add the native messaging host ID to the manifest if Safari requires explicit declaration (TBD — Apple's docs are vague; cross-check against the WebKit source for `WebExtensionAPINativeMessaging`).

### Phase 5 — Extension: use connectNative

- `extension/background.js`: replace `httpPoll()` / `pollLoop()` with:
  ```js
  const port = browser.runtime.connectNative('com.safari-pilot.native-host');
  port.onMessage.addListener((cmd) => { dispatch(cmd); });
  port.onDisconnect.addListener(() => { /* respawn on next wake */ });
  // To send result back:
  port.postMessage({ kind: 'result', commandId, value });
  ```
- Wake/sleep: on background-page reactivation (alarm fire), check if `port` is still connected; if not, call `connectNative` again. The daemon-side UDS handler must be re-entrant (multiple connections from the same extension across wake cycles).
- Keep HTTP poll as fallback path under a feature flag (`SP_USE_NATIVE_MESSAGING=false` opts out).

### Phase 6 — TS engine update

- `src/engines/extension.ts`: no change. The TS layer talks to the daemon over TCP:19474 (NDJSON). The daemon is the one switching transports under the hood — TS still issues `extension_execute` commands and gets responses.

### Phase 7 — E2E test

- `test/e2e/native-messaging-transport.test.ts`:
  - Spawn MCP server, daemon, extension.
  - Open a tab via safari_new_tab.
  - Issue 10 quick safari_get_text calls.
  - Assert: total wall < 5s (currently this would be ~30s+ due to poll-hold delays).
  - Optional: assert daemon's `/status` shows the native-messaging path was used (`transport: "native-messaging"` field).

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Safari's native-messaging API behaves differently than Chrome's on event-page wake | High | Test wake/sleep cycles explicitly; keep HTTP fallback under feature flag |
| Signing/notarization of the native host adds complexity | Medium | Sign with same Developer ID as daemon; bundle inside .app |
| UDS permissions / sandbox issues | Medium | Use `/tmp/` path (sandbox-friendly); mode 0600; daemon and native host both run as same user |
| Native host plist location is undocumented for Safari (vs Chrome) | Low | Apple sample project shows the canonical location |
| Framed JSON parsing bugs (length-prefix off-by-one) | Low | Reference: `node-native-messaging` libraries; spec is well-documented |

## What this is NOT

- **Not WebDriver BiDi.** WebDriver BiDi for Safari isn't shipping in STP 231 (Oct 2025); this is a different mechanism that works today.
- **Not RWI / Remote Inspector.** Per deep research, the RWI socket on macOS is not exposed for third-party tools; this is the actual viable channel.
- **Not WKWebView.** WKWebView would mean "not real Safari" — different fingerprint, isolated storage. We keep real Safari.
- **Not a replacement for AppleScript-routed tools.** Navigation tools (safari_navigate, safari_new_tab, safari_close_tab) stay on AppleScript — they target Safari's tab system, not the per-tab JS execution path.

## Rollout

- Build dev.11 (after dev.10 with the timeout fixes ships).
- Feature flag `SP_USE_NATIVE_MESSAGING=true` default-on in dev.11.
- HTTP poll stays as automatic fallback on `connectNative` failure.
- 50-task probe to verify wall reduction.
- If green, ship as v0.1.36 (or v0.1.37 — depends on release cadence).

## Implementation sequencing for the worktree

The phases above are ordered for delivery. Implementation-wise:
1. Phase 2 + 3 (native host + plist) can be built first as standalone test fixture (`echo '{...}' | ./SafariPilotNativeHost` should round-trip).
2. Phase 1 (UDS server in daemon) can be built in parallel with Phase 2.
3. Phases 4-5 wait for 1 + 2 to land; gated by extension build pipeline.
4. Phase 7 e2e gated on all of the above.

Estimated effort: **3-5 focused days** for a working dev.11. Risk-adjusted: 5-7 days.

## References

- Apple sample: ["Messaging a web extension's native app"](https://developer.apple.com/documentation/safariservices/safari_web_extensions/messaging_a_web_extension_s_native_app)
- Apple ref: [`browser.runtime.connectNative`](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/connectNative) (Mozilla docs apply; Safari is Mozilla-compatible)
- Existing: `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` (Hummingbird HTTP server)
- Existing: `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` (where new UDS-routed commands land)
- Existing: `extension/background.js:700+` (httpPoll loop to be replaced)
- Precedent: [Epistates/MCPSafari](https://github.com/Epistates/MCPSafari) uses WebSocket-on-localhost for similar reasons
