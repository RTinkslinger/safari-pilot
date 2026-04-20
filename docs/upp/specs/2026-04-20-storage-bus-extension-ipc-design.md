# Storage-Based Message Bus for Safari Extension IPC — Design Spec

## 1. Problem Statement

Safari's non-persistent background page (event page) has broken IPC when woken by alarms. Three core WebExtension APIs fail silently in the alarm-triggered context:

- `browser.tabs.query({})` → returns `[]` (empty array)
- `browser.tabs.sendMessage()` → returns `undefined` (message dropped)
- `browser.scripting.executeScript()` → returns `null` for func return value

This is a confirmed Safari/WebKit synchronization failure — the IPC proxies connecting the background script to tab content processes are not initialized when the event page is alarm-woken. Documented in Apple Developer Forum thread 721222, WebKit Bug 296702, StackOverflow 78570837.

**Evidence from this project:**
- `browser.tabs.query({})` returns 41 tabs from the interactive Safari console, but `[]` from alarm-triggered `executeCommand()` in `background.js`
- `browser.tabs.sendMessage` returns `undefined` — confirmed by adding a null check that triggers the fallback
- `browser.scripting.executeScript` returns `null` for the `func` return value in both MAIN and ISOLATED worlds — tested in builds 202604200300 through 202604200343

**Impact:** The extension engine is dead code. Every `safari_evaluate`, `safari_get_text`, `safari_click`, etc. that routes through the extension engine fails with "No target tab" or returns empty results. All 88 e2e tests "pass" only because they silently fall back to the daemon/AppleScript engine.

## 2. Root Cause

When a `browser.alarms` event wakes Safari's non-persistent background service worker, the JavaScript code begins executing immediately. But the browser's internal IPC proxies and tab/frame routing tables that connect the worker to tab content processes are not yet fully initialized. API calls made in this unready window are dispatched before routing is complete. The browser returns empty/null/undefined results without throwing errors.

This is a synchronization failure, not a permissions issue. The same APIs work correctly from the Safari developer console (which keeps the event page fully active and initialized).

The tab discovery half of the problem was already fixed by the tab cache (`tabs.onCreated`/`tabs.onUpdated` listeners persisting tab data to `browser.storage.local`). This spec fixes the command delivery half.

## 3. Solution: Storage-Based Message Bus

Replace the broken `background.js → tabs.sendMessage → content-isolated.js` channel with `browser.storage.local` as the message transport:

```
background.js                    content-isolated.js              content-main.js
─────────────                    ───────────────────              ───────────────
1. Write command to              2. storage.onChanged fires       4. window message
   storage key 'sp_cmd'   ────→    reads command, validates  ──→   executes script
                                   forwards via postMessage        returns result
                                                                      │
5. storage.onChanged fires       3. window message received  ←──────┘
   reads 'sp_result',     ←────    writes result to
   resolves Promise                storage key 'sp_result'
```

This bypasses the broken `tabs.sendMessage` IPC entirely. The `browser.storage` API is reliable because it doesn't depend on the IPC proxy being initialized — it uses a different persistence channel.

**What stays unchanged:**
- `content-main.js` — completely untouched. Still receives `SAFARI_PILOT_CMD` via `window.addEventListener('message')`, still executes scripts using captured `_Function` constructor, still responds with `SAFARI_PILOT_RESPONSE`
- The `content-isolated.js ↔ content-main.js` relay via `window.postMessage` — stays as-is
- Daemon (`ExtensionBridge`, `ExtensionHTTPServer`) — completely unaffected
- MCP server (`ExtensionEngine`, `server.ts`) — completely unaffected
- HTTP polling (`pollLoop`, `POST /result`) — stays as-is
- Tab cache — stays (solves tab discovery, orthogonal to command delivery)
- Reconcile protocol — stays

## 4. Command Protocol

### 4.1 Storage Keys

| Key | Written by | Read by | Purpose |
|-----|-----------|---------|---------|
| `sp_cmd` | background.js | content-isolated.js (via `onChanged`) | Current pending command |
| `sp_result` | content-isolated.js | background.js (via `onChanged`) | Result of executed command |

**Why single keys, not per-tab:** The daemon sends one command at a time via `pollLoop()`. The background processes commands sequentially (`for...of` with `await`). No concurrent commands exist. A single `sp_cmd` key is sufficient — overwriting it IS the intended behavior.

### 4.2 Command Schema

```javascript
// Written to storage key 'sp_cmd' by background.js
{
  commandId: "cmd-uuid",        // from daemon's command ID
  tabId: 67393,                 // target tab (from tab cache lookup)
  script: "return doc...",      // JS code to execute (for execute_script)
  method: "execute_script",     // command method name
  params: {                     // full params for content-main.js relay
    script: "return doc...",
    commandId: "cmd-uuid"
  },
  timestamp: 1776636000000,     // creation time
  deadline: 1776636030000       // expire after 30s (timestamp + 30000)
}
```

### 4.3 Result Schema

```javascript
// Written to storage key 'sp_result' by content-isolated.js
{
  commandId: "cmd-uuid",        // correlates to command
  result: {                     // matches existing sendResponse shape
    ok: true,
    value: "Example Domain"
  },
  timestamp: 1776636001000
}
```

### 4.4 TabId Registration

Content scripts don't have direct access to their own `tabId`. They learn it at load time via `runtime.sendMessage` (content → background direction — this works because the content script initiates the connection, and `runtime.sendMessage` reliably wakes the background):

```javascript
// content-isolated.js — on load (document_idle)
let myTabId = null;
browser.runtime.sendMessage({ action: 'sp_getTabId' }).then(response => {
  myTabId = response?.tabId ?? null;
}).catch(() => { /* background not available — will retry on next page event */ });
```

```javascript
// background.js — top-level listener
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'sp_getTabId') {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return true;
  }
});
```

The `sender.tab.id` is provided by Safari's extension API on the `sender` object — this does NOT depend on the broken `tabs.query` IPC.

## 5. Data Flow (Detailed)

### 5.1 Happy Path

```
DAEMON (HTTP:19475)
  │ GET /poll → command arrives (e.g., safari_evaluate with tabUrl + script)
  ▼
BACKGROUND.JS (event page, alarm-woken)
  │ 1. findTargetTab(cmd.tabUrl) → tab.id from persistent tab cache
  │ 2. Construct command object with {commandId, tabId, script, method, params, deadline}
  │ 3. Write command to browser.storage.local key 'sp_cmd'
  │ 4. Create Promise that listens for storage.onChanged on key 'sp_result'
  │ 5. await Promise (with 30s timeout)
  │    ... storage.onChanged fires when content script writes result ...
  │ 6. Read result from 'sp_result'
  │ 7. Delete 'sp_cmd' and 'sp_result' from storage (cleanup)
  │ 8. Return result to postResult(commandId, result)
  │ 9. postResult sends HTTP POST /result to daemon
  ▼
CONTENT-ISOLATED.JS (ISOLATED world, target tab)
  │ storage.onChanged fires for key 'sp_cmd'
  │ Filter: cmd.tabId === myTabId? → if not, ignore
  │ Filter: cmd.deadline > Date.now()? → if expired, ignore
  │ Generate requestId for the content-main.js relay
  │ Forward to content-main.js via window.postMessage({type: 'SAFARI_PILOT_CMD', ...})
  │ Wait for response from content-main.js via window.addEventListener('message')
  │ Write result to browser.storage.local key 'sp_result'
  ▼
CONTENT-MAIN.JS (MAIN world, target tab) — UNCHANGED
  │ Receives SAFARI_PILOT_CMD via window.addEventListener('message')
  │ Executes: new _Function(params.script)() — captured Function constructor
  │ Responds via window.postMessage({type: 'SAFARI_PILOT_RESPONSE', ...})
```

### 5.2 Error Paths

**Content script not loaded on target tab:**
- No `storage.onChanged` listener in that tab → command sits in `sp_cmd`
- Background's 30s timeout expires → Promise rejects → result = `{ok: false, error: {message: 'Storage bus timeout'}}`
- Background cleans up `sp_cmd` → `postResult` sends error to daemon

**Content script loaded but script throws:**
- content-main.js catches the error in its try/catch (existing code at content-main.js:334)
- Responds with `{ok: false, error: {message, name}}` via postMessage
- content-isolated.js writes error result to `sp_result`
- Background reads error result, forwards to daemon

**Event page dies between write and result:**
- Command sits in `sp_cmd`. Content script writes result to `sp_result`.
- Next alarm wakes event page → `wakeSequence` → check for stale `sp_cmd`/`sp_result` → clean them
- Daemon's `handleExecute` continuation timed out (90s default) → daemon returns `EXTENSION_TIMEOUT`

**Multiple content scripts match the tabId:**
- Impossible — tabId is unique per tab. Only one content-isolated.js instance runs per tab.
- If a tab navigates, the OLD content script is destroyed and a NEW one loads. The new one re-registers its tabId.

**Content script receives command for wrong tab:**
- `cmd.tabId !== myTabId` → content script ignores the command

## 6. Changes by File

### 6.1 `extension/background.js`

**Add:** `runtime.onMessage` handler for `sp_getTabId` (top-level, ~5 lines)

**Replace in `executeCommand()`:** The `browser.tabs.sendMessage` primary path + `browser.scripting.executeScript` fallback (~30 lines) becomes storage write + onChanged listener + timeout (~35 lines):

```javascript
async function executeCommand(cmd) {
  const commandId = cmd.id;
  // ... existing pending entry update ...

  if (!cmd.script) {
    return { ok: true, value: null };
  }

  const tab = await findTargetTab(cmd.tabUrl);
  if (!tab || tab.id == null) {
    return { ok: false, error: { message: `No target tab for url="${cmd.tabUrl}"` } };
  }

  // Write command to storage bus
  const storageCmd = {
    commandId,
    tabId: tab.id,
    method: 'execute_script',
    params: { script: cmd.script, commandId },
    timestamp: Date.now(),
    deadline: Date.now() + 30000,
  };
  await browser.storage.local.set({ sp_cmd: storageCmd });

  // Wait for result via storage.onChanged (30s timeout)
  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      browser.storage.onChanged.removeListener(listener);
      resolve({ ok: false, error: { message: 'Storage bus timeout (30s)' } });
    }, 30000);

    function listener(changes, area) {
      if (area !== 'local' || !changes.sp_result?.newValue) return;
      const reply = changes.sp_result.newValue;
      if (reply.commandId !== commandId) return;
      clearTimeout(timeout);
      browser.storage.onChanged.removeListener(listener);
      resolve(reply.result);
    }
    browser.storage.onChanged.addListener(listener);
  });

  // Cleanup
  await browser.storage.local.remove(['sp_cmd', 'sp_result']);

  await updatePendingEntry(commandId, { status: 'completed', result });
  return result;
}
```

**Add to `wakeSequence()`:** Stale command cleanup before loading tab cache:
```javascript
async function wakeSequence(reason) {
  try {
    // Clean stale commands from previous wake cycles
    await browser.storage.local.remove(['sp_cmd', 'sp_result']);
    await loadTabCache();
    await gcPendingStorage();
    await connectAndReconcile();
    await pollLoop();
  } catch (e) {
    console.warn('[safari-pilot] wakeSequence error:', e.message);
  }
}
```

### 6.2 `extension/content-isolated.js`

**Add:** TabId registration on load (~10 lines at top of IIFE):

```javascript
let myTabId = null;

// Register this tab's ID with the background script.
// runtime.sendMessage (content → background) works reliably because
// the content script initiates the connection.
(async () => {
  try {
    const response = await browser.runtime.sendMessage({ action: 'sp_getTabId' });
    myTabId = response?.tabId ?? null;
  } catch {
    // Background not available — tabId stays null, commands won't match
  }
})();
```

**Add:** `storage.onChanged` listener for commands (~25 lines):

```javascript
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.sp_cmd?.newValue) return;
  if (myTabId === null) return; // Not registered yet

  const cmd = changes.sp_cmd.newValue;
  if (cmd.tabId !== myTabId) return; // Not for this tab
  if (cmd.deadline && cmd.deadline < Date.now()) return; // Expired

  // Forward to MAIN world via existing postMessage relay
  const requestId = `sp_${++nextRequestId}_${Date.now()}`;

  const promise = new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });

    window.postMessage(
      {
        type: 'SAFARI_PILOT_CMD',
        requestId,
        method: cmd.method,
        params: cmd.params ?? {},
      },
      window.location.origin
    );

    setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject({ message: 'MAIN world timeout', code: 'TIMEOUT' });
      }
    }, 10_000);
  });

  promise.then(
    value => {
      browser.storage.local.set({
        sp_result: { commandId: cmd.commandId, result: { ok: true, value }, timestamp: Date.now() }
      });
    },
    error => {
      browser.storage.local.set({
        sp_result: { commandId: cmd.commandId, result: { ok: false, error }, timestamp: Date.now() }
      });
    }
  );
});
```

**Keep:** The existing `browser.runtime.onMessage` listener (lines 45-79). It still works when `tabs.sendMessage` happens to succeed (e.g., when the developer console is open and IPC is initialized). The storage bus is the primary path; the `onMessage` path is a bonus when available.

### 6.3 `extension/content-main.js`

**No changes.** Zero lines modified. The `window.addEventListener('message')` handler at line 240 receives `SAFARI_PILOT_CMD` messages from content-isolated.js's `window.postMessage` — this relay is identical whether the command arrived via `runtime.onMessage` or `storage.onChanged`.

## 7. Scope

**In scope:**
- Storage bus implementation in background.js `executeCommand()`
- TabId registration in content-isolated.js
- `storage.onChanged` listener in content-isolated.js
- `sp_getTabId` handler in background.js
- Stale command cleanup in `wakeSequence()`
- Extension rebuild (build-extension.sh → sign → notarize)
- Smoke test verification (00-extension-smoke-gate.test.ts)

**Out of scope:**
- Daemon changes (none needed)
- MCP server changes (none needed)
- content-main.js changes (none needed)
- Tab cache changes (already working)
- E2e test rewrite (separate plan, blocked on this fix)
- Unit tests for the storage bus (extension code isn't unit-tested — e2e smoke test is the verification)

## 8. Risks

| Risk | Mitigation |
|------|-----------|
| `runtime.sendMessage` for tabId registration fails (background not running when content script loads) | Content script retries on `visibilitychange`. Worst case: `myTabId` stays null, commands for this tab time out, user reloads the page |
| 30s timeout too short for slow pages | Matches the daemon's `EXTENSION_TIMEOUT` constant. Content-main.js has its own 10s timeout for the MAIN world relay. 30s is generous |
| Storage write triggers `onChanged` in ALL content scripts (40+ tabs) | Each listener checks `cmd.tabId !== myTabId` immediately and returns. Cost: ~40 no-op function calls per command. Negligible |
| Command written to storage but content script navigates away before executing | New content script loads on new page, re-registers. Command's `deadline` expires. Background times out, cleans up |
| Event page killed between storage write and result | Daemon's `handleExecute` continuation times out (90s). Next alarm wake cleans stale keys |
| `browser.storage.local` unavailable | Safari guarantees storage API for extensions with `storage` permission (in manifest). If storage itself is broken, the extension can't function at all (pending queue also uses storage) |

## 9. Verification

The existing `test/e2e/00-extension-smoke-gate.test.ts` is the gate test:

| Test | What it verifies | Expected after fix |
|------|-----------------|-------------------|
| Test 1 — health check | Extension connected, ipcMechanism: http | PASS (already passes) |
| Test 2 — JS execution | `safari_evaluate` returns `document.title` via extension engine | PASS — storage bus delivers command, content script executes, result flows back |
| Test 3 — result marshaling | Complex JSON round-trips through extension | PASS — JSON survives storage serialization |
| Test 4 — URL query params | Tab found by URL with query params | PASS (already passes via tab cache) |
| Test 5 — sequential commands | Two commands in sequence, no deadlock | PASS — sequential storage writes don't collide |

All 5 tests must pass with `_meta.engine === 'extension'` before the e2e test rewrite can proceed.
