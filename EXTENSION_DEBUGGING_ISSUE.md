# Extension Runtime Debugging — Reference Document
*Written: 2026-04-16 | Session: continuation from c67cd056-1d53-46c1-ab93-34c03fa10d85*

## The Issue

**Symptom:** Commands queued in the daemon's `ExtensionBridge` time out after 30s. The extension's `background.js` never picks them up and executes them.

**What works:**
- `extension_status` returns "connected" via daemon socket (localhost:19474)
- `extension_connected` signal arrives at the daemon (background.js calls it on startup)
- Handler's NWConnection to daemon works (TCP proxy forwards messages correctly)
- Health check via MCP shows extension: ok=true
- Content scripts (content-main.js, content-isolated.js) inject successfully — `window.__safariPilot` namespace is created in pages

**What does NOT work:**
- `extension_execute` command: daemon queues it, but background.js's polling never retrieves it
- No poll requests arrive at the daemon (the daemon log shows only "Extension connected" entries, never "extension_poll" activity)
- The service worker appears to be running (connected signal arrives) but not polling

## Intended Architecture (per research)

```
MCP server → DaemonEngine → daemon CommandDispatcher → ExtensionBridge.handleExecute (queues command, suspends continuation)
                                                                    ↓
                                                           [Something wakes the extension]
                                                                    ↓
background.js polls → handler → daemon extension_poll → returns queued command
                                                                    ↓
background.js executeAndReturnResult → content script / scripting.executeScript → result
                                                                    ↓
background.js sendNativeRequest({type:'result'}) → handler → daemon extension_result → resumes continuation
                                                                    ↓
MCP response returned with result
```

The critical question: **what wakes the extension?** This is where Safari MV3 service worker lifecycle breaks every approach.

## Approaches Tried (and why each failed)

### 1. setInterval(pollForCommands, 5000) — OLD APPROACH
**Status:** Does not work in Safari MV3
**Why:** Safari suspends MV3 service workers after ~30 seconds of inactivity. setInterval dies with the worker. First poll never fires because worker suspends before 5s elapses.
**Evidence:** Daemon log shows only `extension_connected` events, no poll activity.

### 2. browser.alarms API
**Status:** Period minimum is 30s (in production), completely wrong for real-time
**Why:** Alarms fire only on minimum 30-second intervals. Latency target is 1-2s.
**Evidence:** Research document Reference 3.

### 3. Persistent background page (`"persistent": true`)
**Status:** Safari rejects
**Why:** Safari MV3 requires service worker mode. Error: "Invalid persistent manifest entry. A manifest_version greater than or equal to 3 must be non-persistent."
**Evidence:** Error shown in Safari Extensions settings.

### 4. Chain polls via `sendNativeRequest(...).then(pollForCommands).then(startPolling)`
**Status:** Service worker still suspends between chains
**Why:** When the last Promise resolves, nothing keeps the worker alive.
**Evidence:** No poll activity in daemon log after initialization.

### 5. SFSafariApplication.dispatchMessage from containing app
**Status:** Untested — dispatchMessage is marked unavailable in app extensions in Xcode 16+
**Why:** Apple deprecated the API for use inside app extensions. The containing APP (not appex) can call it, but the StackOverflow thread suggests it doesn't work reliably.
**Evidence:** Research document Reference 15. StackOverflow thread: https://stackoverflow.com/questions/78997580/sfsafariapplication-dispatchmessage-on-xcode-16

### 6. Long-polling with stored NSExtensionContext
**Status:** Implemented but times out
**Why:** Handler holds the NSExtensionContext open, polls daemon every 500ms. Supposedly the pending `sendNativeMessage` Promise keeps the service worker alive. But the poll chain never produces activity in daemon logs — suggests the handler's process itself is terminated before it can poll enough times.
**Evidence:** `LONG-POLL-TEST` timed out after 30s with no daemon activity between the initial connected signal and the timeout.

### 7. App-Relay Push (NWConnection from app → daemon push signal → app calls dispatchMessage → extension)
**Status:** Partially wired, `dispatchMessage` appears not to reach background.js
**Why:** Even with the relay working (daemon signals wake, app receives it, calls dispatchMessage), background.js's onMessage listeners don't fire. Either the signal doesn't arrive, or the listener isn't registered by the time the signal arrives (worker was suspended).
**Evidence:** `AppRelayServer: signaling wake to 1 relay client(s)` appears in daemon log after queuing command, but no subsequent poll activity.

### 8. Hybrid: setInterval (for active) + alarms (for wake)
**Status:** Alarms fire at 30s minimum — too infrequent
**Why:** Combination of #1 and #2 problems.

### 9. connectNative port
**Status:** Implemented but port messages never received
**Why:** When the service worker suspends, the port disconnects. When the worker wakes (due to dispatchMessage), it re-runs initialization including connectNativePort(). But by then the wake message has already been delivered (and lost, because there was no listener).

## What Has NOT Been Tried

### A. Actual debugging with Safari Web Inspector
The only way to see what's happening inside background.js is to open Safari → Develop → Web Extension Background Content → Safari Pilot → check Console for errors.

**Questions the inspector can answer in 30 seconds:**
1. Is background.js even executing? (Console will show `'[SafariPilot] Connected to daemon via handler proxy'` if init ran)
2. Is `sendNativeRequest` being called? (Console logs from the call sites)
3. What error is thrown when the poll fails? (red error messages)
4. Is the service worker suspended? (Inspector shows "[Extension Background Content]" as active or inactive)
5. Is `connectNative` returning a valid port? (typeof port check)

**Without this debugging, every attempt is blind guessing.**

### B. Using `SFSafariApplication.getActiveWindow` + `page.dispatchMessageToScript`
This is the LEGACY Safari App Extension API (pre-web-extension), but `SFSafariPage.dispatchMessageToScript` delivers messages to content scripts via `safari.self.addEventListener('message', ...)`. Not clear if this works for web extensions.

### C. Shared container file polling from extension
If the daemon writes a command file to a shared App Group container, and the extension's content scripts poll the container... but content scripts can't access containers. Only the appex can.

### D. WebSocket from content script to daemon (via wss://localhost with trusted cert)
Content scripts CAN make WebSocket connections. If the content script connects to the daemon on every page load, it can receive commands and execute them in the page directly. But wss requires a trusted certificate in the System Keychain.

### E. Checking browser console errors
Browser may be logging errors about manifest parsing, CSP violations in the extension itself, content script injection failures, etc. Console.app filtered for "Safari Pilot" might show these.

## Data Flow — What SHOULD Happen vs What DOES Happen

### Expected (per architecture doc)
```
1. MCP: tools/call → server.executeToolWithSecurity
2. Server: selectEngine → ExtensionEngine
3. EngineProxy: executeJsInTab → ExtensionEngine.executeJsInTab
4. ExtensionEngine: sends "__SAFARI_PILOT_INTERNAL__ extension_execute {script,tabUrl}" to daemon
5. Daemon TCP:19474: receives, dispatches through CommandDispatcher
6. CommandDispatcher: extension_execute → ExtensionBridge.handleExecute
7. ExtensionBridge: queues command, suspends CheckedContinuation
8. [WAKE MECHANISM — this is where it breaks]
9. background.js: polls via sendNativeMessage → handler → daemon extension_poll
10. Daemon: returns queued command
11. background.js: receives command, calls executeAndReturnResult
12. Content script relay → content-main.js executes JS via _Function
13. background.js: sendNativeMessage({type:'result', id, result}) → handler → daemon extension_result
14. ExtensionBridge: matches requestId, resumes continuation
15. Daemon returns result through the original TCP connection
16. ExtensionEngine returns EngineResult
17. MCP response with _meta.engine='extension'
```

### Actual
```
1-7: Works. Command is queued in daemon.
8: BROKEN. No mechanism successfully wakes the background.js service worker.
9-17: Never executes because background.js never polls.
```

## Diagnostic Commands (to use when debugging)

```bash
# Is extension registered with bin/ path?
mdfind "kMDItemCFBundleIdentifier == 'com.safari-pilot.app'"

# What build version is in bin/?
defaults read "bin/Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex/Contents/Info.plist" CFBundleVersion

# Is daemon listening?
lsof -iTCP:19474 -sTCP:LISTEN

# Is extension connected?
echo '{"id":"s","method":"extension_status"}' | nc -w 3 localhost 19474

# Live test extension execute (will timeout if broken)
echo '{"id":"t","method":"extension_execute","params":{"script":"return 1"}}' | nc -w 35 localhost 19474

# Watch daemon log
tail -f ~/.safari-pilot/daemon.log

# Find handler logs in system log (os_log output)
log stream --predicate 'eventMessage CONTAINS "SafariPilot"' --timeout 30
```

## The Debugging Gap

The core problem throughout this session:
1. I tried approach X
2. Rebuild took 3-4 minutes
3. Ran a blind test via CLI (`nc localhost 19474`)
4. Saw timeout
5. Assumed approach X failed
6. Moved to approach Y
7. Repeat

**What I should have done from the start:**
1. Ask the user to open Safari Web Inspector on the background page
2. Trigger one test
3. Read the Console for the exact error
4. Fix THE ACTUAL PROBLEM

Without Web Inspector access, I'm guessing. With it, 90% of these issues would have been solved in 30 minutes instead of 6+ hours.

## Recommended Next Steps

1. **Start with instrumentation, not rebuilding.** Add verbose logging to background.js on every code path. Log to both console AND to a storage value (browser.storage.local) that persists across worker restarts.

2. **Use Safari Web Inspector** (Develop → Web Extension Background Content → Safari Pilot):
   - Check if background.js loaded
   - Check if `sendNativeRequest` is being called
   - Check what the response to `{type: 'connected'}` actually is
   - Set a breakpoint on `pollForCommands` and trigger a daemon command
   - See the exact line where execution stops or errors

3. **Test each layer in isolation:**
   - Can background.js call `sendNativeMessage` at all? (yes — connected signal works)
   - Can background.js call `sendNativeMessage` AFTER the initial setup? (unknown — this is where it fails)
   - Does the worker suspend between the initial call and subsequent calls?

4. **If the worker suspends:** use a mechanism that KEEPS IT ALIVE. The long-polling approach (one `sendNativeMessage` Promise held open) should work — but requires the handler to actually hold the context open, which means the Swift process needs to stay alive. Verify this with Activity Monitor showing the Safari Pilot Extension process is running during the long poll.

5. **If dispatchMessage is the only real wake path:** confirm it works by implementing it in the containing app (not the appex), have background.js log when the wake fires. If it never fires, try `runtime.onMessageExternal` and `runtime.connectNative` port listener both.

## Files Referenced

- `src/engines/extension.ts` — ExtensionEngine with sentinel protocol
- `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` — command queue
- `daemon/Sources/SafariPilotdCore/ExtensionSocketServer.swift` — TCP listener
- `extension/native/SafariWebExtensionHandler.swift` — TCP proxy handler
- `extension/native/AppDelegate.swift` — app relay (in WIP stash)
- `extension/background.js` — service worker with polling
- `extension/manifest.json` — MV3 config
- `scripts/build-extension.sh` — Xcode build + custom file overrides

## Critical Context for Resuming

**The user has been patient through many failed attempts.** When resuming, the FIRST action should be to get Safari Web Inspector access to the background page and read actual errors, not to try another approach blind. The fix is likely a small code change, but finding it requires debugging tools.
