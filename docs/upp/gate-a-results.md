# Gate A Results — connectNative Prototype

**Date:** 2026-04-17
**Branch:** prototype/connectNative (deleted after test)
**Verdict:** FAIL — `connectNative` does NOT provide a persistent channel between extension and handler

## Checks

| Check | Result | Evidence |
|-------|--------|----------|
| 1. connectNative succeeded | Likely PASS (API exists) | No throw caught — script continued to wake sequence |
| 2. postMessage sent | Likely PASS | No throw caught |
| 3. Handler beginRequest fired | **FAIL** | Daemon log shows NO ping from connectNative probe. Only `sendNativeMessage`-based messages (poll, connected, logs) reached the daemon. |
| 4. port.onMessage received | **FAIL** | No response possible since handler was never invoked |
| 5. Alive after 30s | N/A | Checks 3-4 failed — persistence is moot |
| 6. Handler instance address | N/A | Handler never fired for connectNative messages |

## Root Cause

Safari's `browser.runtime.connectNative` is **fundamentally different** from Chrome's:

- **Chrome**: `connectNative` launches a native host process, creates a stdio pipe. Extension sends/receives messages bidirectionally.
- **Safari**: `connectNative` establishes a port to the **containing macOS app** (the .app host), NOT to the handler (the .appex). It's designed for the **app to push messages TO the extension**, not for the extension to communicate with the handler.

From [Apple Developer Documentation](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension):

> **Send messages from the app to JavaScript:**
> To prepare the JavaScript script to receive messages from the macOS app, use `browser.runtime.connectNative` to establish a port connection to the containing app.

Safari's native messaging model:
- `sendNativeMessage` → extension sends to **handler** (`SafariWebExtensionHandler.beginRequest`) → daemon
- `connectNative` → establishes port to **containing macOS app** (Safari Pilot.app) → NOT the handler

The plan assumed `connectNative` would work like Chrome's — creating a persistent channel between `background.js` and the handler/daemon. This is architecturally impossible in Safari's model.

## Daemon Log Evidence

After daemon restart and extension wake:
```
[2026-04-17T16:21:43.298Z] [INFO] POLL: commandID=... pendingCount=0 waitTimeout=0.0
[2026-04-17T16:21:43.378Z] [INFO] Extension connected.
[2026-04-17T16:21:43.481Z] [INFO] EXT-LOG: wake: script_load
[2026-04-17T16:21:43.688Z] [INFO] POLL: commandID=... pendingCount=0 waitTimeout=0.0
[2026-04-17T16:21:43.811Z] [INFO] Extension connected.
[2026-04-17T16:21:43.972Z] [INFO] EXT-LOG: wake: coalesced
```

All messages are from `sendNativeMessage`. Zero messages from `connectNative` probe's `port.postMessage({ type: 'ping' })`.

## Impact

The connectNative pivot plan (v3, 2993 lines, 9 tasks) **cannot proceed**. The fundamental premise — that `connectNative` creates a persistent channel to the handler — is false in Safari's WebExtension model.

## What Still Works

The 1a architecture (`sendNativeMessage` + event page + alarm keepalive) remains the only viable IPC path between extension and handler in Safari. The `SFErrorDomain error 3` from concurrent `sendNativeMessage` calls was fixed in commit 5f7b600.

## Alternative Paths (Not Yet Evaluated)

1. **App-mediated relay**: Use `connectNative` port for the Safari Pilot.app to relay messages, with the app forwarding to the daemon. Requires the .app to be running.
2. **Optimized sendNativeMessage**: Keep the 1a architecture but add reconcile protocol OVER `sendNativeMessage` (not over a persistent port). One `sendNativeMessage` per reconcile round-trip.
3. **WebSocket from content script**: Content script opens a WebSocket to the daemon. Bypasses the handler entirely but requires the page to have a content script injected.
