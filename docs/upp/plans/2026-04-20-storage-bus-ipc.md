# Storage-Based Message Bus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken `browser.tabs.sendMessage` IPC in the Safari extension with a `browser.storage.local`-based message bus so commands reliably reach content scripts from the alarm-woken event page.

**Architecture:** Background.js writes commands to storage key `sp_cmd`. Content-isolated.js listens via `storage.onChanged`, forwards to content-main.js via the existing `window.postMessage` relay, and writes results back to storage key `sp_result`. Background.js reads results via its own `storage.onChanged` listener. Content-main.js is completely unchanged.

**Tech Stack:** Safari WebExtension APIs (`browser.storage.local`, `browser.storage.onChanged`, `browser.runtime.sendMessage`), vanilla JS (no modules — event pages don't support ESM)

**Spec:** `docs/upp/specs/2026-04-20-storage-bus-extension-ipc-design.md`

---

## File Structure

### Files to MODIFY
| File | Change |
|------|--------|
| `extension/background.js` | Add `sp_getTabId` handler (top-level). Replace `executeCommand()` body: sendMessage+executeScript → storage write + onChanged listener. |
| `extension/content-isolated.js` | Add tabId self-registration on load. Add `storage.onChanged` listener for `sp_cmd` key. Write results to `sp_result` key. |

### Files NOT modified
| File | Why unchanged |
|------|---------------|
| `extension/content-main.js` | Still receives `SAFARI_PILOT_CMD` via `window.addEventListener('message')`. The relay interface is identical whether the command arrived via `runtime.onMessage` or `storage.onChanged`. |
| `extension/manifest.json` | Already has `storage`, `tabs`, `scripting` permissions. No new permissions needed. |
| `daemon/Sources/**` | Daemon is unaffected — still receives results via HTTP POST `/result`. |
| `src/**` | MCP server is unaffected — still calls `ExtensionEngine.executeJsInTab()`. |

---

## Storage Key Reference

| Key | Written by | Read by | Lifetime |
|-----|-----------|---------|----------|
| `sp_cmd` | background.js | content-isolated.js | Cleared by background after result received or timeout |
| `sp_result` | content-isolated.js | background.js | Cleared by background after read |

---

### Task 1: Add `sp_getTabId` message handler to background.js

**Files:**
- Modify: `extension/background.js` (inside the existing `runtime.onMessage` listener block at line 421-436)

- [ ] **Step 1: Add the handler**

In `extension/background.js`, find the `runtime.onMessage` listener block (line 421). Add a new case BEFORE the existing `if (message?.type === 'ping')` check:

```javascript
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Storage bus: content scripts request their own tabId on load.
    // sender.tab.id is provided by Safari's extension API — does NOT
    // depend on the broken tabs.query IPC.
    if (message?.action === 'sp_getTabId') {
      sendResponse({ tabId: sender.tab?.id ?? null });
      return false;
    }
    if (message?.type === 'ping') {
```

This inserts the `sp_getTabId` handler at the top of the existing listener. The `sender.tab.id` value comes from Safari's extension infrastructure, not from `tabs.query`, so it works even in alarm-woken context.

- [ ] **Step 2: Verify no syntax errors**

Run: `node --check extension/background.js`

Expected: No output (clean parse).

- [ ] **Step 3: Commit**

```bash
git add extension/background.js
git commit -m "feat(extension): add sp_getTabId handler for content script tab registration

Content scripts need their tabId to filter storage bus commands.
They request it via runtime.sendMessage on load. sender.tab.id
comes from Safari's extension infrastructure, not tabs.query."
```

---

### Task 2: Add tabId registration and storage bus listener to content-isolated.js

**Files:**
- Modify: `extension/content-isolated.js`

- [ ] **Step 1: Add tabId registration inside the IIFE**

In `extension/content-isolated.js`, inside the IIFE, insert the tabId registration code AFTER the existing variable declarations at lines 18-19 (`let nextRequestId = 0;` and `const pendingRequests = new Map();`). The new code MUST come AFTER these declarations because the storage listener uses `nextRequestId` and `pendingRequests` — `let` variables have a Temporal Dead Zone and referencing them before declaration causes a runtime ReferenceError.

Insert AFTER line 19 (`const pendingRequests = new Map();`):

```javascript
  // ─── Storage Bus: TabId Registration ──────────────────────────────────────
  // Safari's tabs.sendMessage returns undefined in alarm-woken event pages.
  // Commands are delivered via browser.storage.local instead.
  // Content scripts need their tabId to filter commands meant for them.
  let myTabId = null;

  (async () => {
    try {
      const response = await browser.runtime.sendMessage({ action: 'sp_getTabId' });
      myTabId = response?.tabId ?? null;
      // Process any command that arrived before registration completed
      if (myTabId !== null && pendingStorageCmd) {
        const cmd = pendingStorageCmd;
        pendingStorageCmd = null;
        processStorageCommand(cmd);
      }
    } catch {
      // Background not available on first load — retry on visibility change
    }
  })();

  // Retry tabId registration when tab becomes visible (handles case where
  // background wasn't running when content script first loaded).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && myTabId === null) {
      browser.runtime.sendMessage({ action: 'sp_getTabId' }).then(response => {
        myTabId = response?.tabId ?? null;
      }).catch(() => {});
    }
  });
```

- [ ] **Step 2: Add the storage.onChanged command listener**

Still in `content-isolated.js`, AFTER the tabId registration code and BEFORE the existing `window.addEventListener('message', ...)` block, add:

```javascript
  // ─── Storage Bus: Command Listener ────────────────────────────────────────
  // Receives commands written by background.js to storage key 'sp_cmd'.
  // Forwards to MAIN world via the existing window.postMessage relay.
  // Writes results to storage key 'sp_result'.
  // Buffer for commands that arrive before tabId registration completes.
  // The async runtime.sendMessage for tabId can take 50-200ms. If a command
  // arrives in that window, we buffer it and process after registration.
  let pendingStorageCmd = null;

  function processStorageCommand(cmd) {
    if (cmd.tabId !== myTabId) return;
    if (cmd.deadline && cmd.deadline < Date.now()) return;

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
          reject({ message: 'MAIN world timeout (storage bus)', code: 'TIMEOUT' });
        }
      }, 10_000);
    });

    promise.then(
      value => {
        browser.storage.local.set({
          sp_result: {
            commandId: cmd.commandId,
            result: { ok: true, value },
            timestamp: Date.now(),
          },
        }).catch(e => console.warn('[safari-pilot] sp_result write failed:', e.message));
      },
      error => {
        browser.storage.local.set({
          sp_result: {
            commandId: cmd.commandId,
            result: { ok: false, error },
            timestamp: Date.now(),
          },
        }).catch(e => console.warn('[safari-pilot] sp_result write failed:', e.message));
      }
    );
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.sp_cmd?.newValue) return;

    const cmd = changes.sp_cmd.newValue;

    if (myTabId === null) {
      // TabId not registered yet — buffer the command and process after registration
      pendingStorageCmd = cmd;
      return;
    }

    processStorageCommand(cmd);
  });
```

**CRITICAL:** `nextRequestId` and `pendingRequests` are declared at lines 18-19 of the original file. All new code (tabId registration, storage listener, `processStorageCommand`) MUST be inserted AFTER these declarations. Inserting before them causes a Temporal Dead Zone (TDZ) ReferenceError at runtime — `let` variables cannot be accessed before their declaration line.

The storage bus listener shares `nextRequestId` and `pendingRequests` with the existing `runtime.onMessage` listener — both use the same `window.postMessage` relay to content-main.js.

- [ ] **Step 3: Verify no syntax errors**

Run: `node --check extension/content-isolated.js`

Expected: No output (clean parse).

- [ ] **Step 4: Commit**

```bash
git add extension/content-isolated.js
git commit -m "feat(extension): add storage bus listener to content-isolated.js

Registers tabId via runtime.sendMessage on load. Listens for commands
on storage key 'sp_cmd', filters by tabId, forwards to content-main.js
via existing postMessage relay, writes results to 'sp_result'."
```

---

### Task 3: Replace executeCommand() in background.js with storage bus

**Files:**
- Modify: `extension/background.js` (the `executeCommand` function, lines 144-212)

- [ ] **Step 1: Replace the executeCommand body**

In `extension/background.js`, replace the entire `executeCommand` function (lines 144-212) with:

```javascript
async function executeCommand(cmd) {
  const commandId = cmd.id;
  await updatePendingEntry(commandId, {
    status: 'executing',
    tabUrl: cmd.tabUrl,
    script: cmd.script,
    timestamp: Date.now(),
  });

  if (!cmd.script) {
    const result = { ok: true, value: null };
    await updatePendingEntry(commandId, { status: 'completed', result });
    return result;
  }

  const tab = await findTargetTab(cmd.tabUrl);
  if (!tab || tab.id == null) {
    const result = { ok: false, error: { message: `No target tab for url="${cmd.tabUrl}"` } };
    await updatePendingEntry(commandId, { status: 'completed', result });
    return result;
  }

  // ── Storage bus: write command, wait for result ──────────────────────────
  // Safari's tabs.sendMessage and scripting.executeScript return undefined/null
  // in alarm-woken event page context. Use browser.storage.local as the message
  // transport instead. Content-isolated.js picks up commands via onChanged.
  //
  // IMPORTANT: Attach the result listener BEFORE writing the command.
  // If the write triggers onChanged synchronously before the listener is
  // attached, the result event would be missed and we'd wait 30s for nothing.
  const storageCmd = {
    commandId,
    tabId: tab.id,
    method: 'execute_script',
    params: { script: cmd.script, commandId },
    timestamp: Date.now(),
    deadline: Date.now() + 30000,
  };

  // Step 1: Attach result listener FIRST
  let resultResolver;
  const resultPromise = new Promise((resolve) => {
    resultResolver = resolve;
  });

  const resultTimeout = setTimeout(() => {
    browser.storage.onChanged.removeListener(resultListener);
    resultResolver({ ok: false, error: { message: 'Storage bus timeout (30s) — content script may not be loaded on target tab' } });
  }, 30000);

  function resultListener(changes, area) {
    if (area !== 'local' || !changes.sp_result?.newValue) return;
    const reply = changes.sp_result.newValue;
    if (reply.commandId !== commandId) return;
    clearTimeout(resultTimeout);
    browser.storage.onChanged.removeListener(resultListener);
    resultResolver(reply.result);
  }
  browser.storage.onChanged.addListener(resultListener);

  // Step 2: THEN write the command (listener is already waiting)
  await browser.storage.local.set({ sp_cmd: storageCmd });

  // Step 3: Wait for result
  const result = await resultPromise;

  // Cleanup storage keys (safe — result already captured in `result` variable)
  try { await browser.storage.local.remove(['sp_cmd', 'sp_result']); } catch { /* ignore cleanup errors */ }

  await updatePendingEntry(commandId, { status: 'completed', result });
  return result;
}
```

- [ ] **Step 2: Do NOT add cleanup to wakeSequence**

No changes to `wakeSequence`. Cleanup happens ONLY inside `executeCommand()` after the result is received (the `try { await browser.storage.local.remove(...) } catch {}` at the end of the function). Adding cleanup to wakeSequence would delete commands that a content script hasn't processed yet — a race condition that causes silent command loss.

- [ ] **Step 3: Verify no syntax errors**

Run: `node --check extension/background.js`

Expected: No output (clean parse).

- [ ] **Step 4: Commit**

```bash
git add extension/background.js
git commit -m "feat(extension): replace sendMessage with storage bus in executeCommand

Writes command to storage key 'sp_cmd', waits for result on 'sp_result'
via storage.onChanged listener with 30s timeout. Listener attached BEFORE
write to prevent race condition. Completely bypasses broken Safari IPC."
```

---

### Task 4: Rebuild extension and verify smoke test

**Files:**
- No source changes (build + test only)

- [ ] **Step 1: Rebuild the extension**

Run: `bash scripts/build-extension.sh`

**IMPORTANT:** This build takes 3-5 minutes (Xcode build + codesign + notarize + staple). Set tool timeout to at least 300 seconds.

Expected: Build succeeds with `=== Build Complete: v0.1.6 (build YYYYMMDDHHMM) ===`

- [ ] **Step 2: Register the updated extension with Safari**

Run: `open "bin/Safari Pilot.app"`

Wait **90 seconds** for the extension to reconnect. The alarm period is 1 minute (`KEEPALIVE_PERIOD_MIN = 1`), so worst case is ~60s after opening the app plus reconnection time.

- [ ] **Step 3: Verify extension health**

Run:
```bash
echo '{"id":"h","method":"execute","params":{"script":"__SAFARI_PILOT_INTERNAL__ extension_health"}}' | nc -w 5 localhost 19474
```

Expected: Response contains `"isConnected":true` and `"ipcMechanism":"http"`.

If `isConnected` is false, wait another 30 seconds (alarm cycle is 1 minute) and retry.

- [ ] **Step 4: Run the smoke test**

Run: `npx vitest run test/e2e/00-extension-smoke-gate.test.ts`

Expected: All 5 tests pass:
- Test 1 (health check): `ipcMechanism === 'http'`, `isConnected === true`
- Test 2 (JS execution): `meta.engine === 'extension'`, `payload.value` contains "Example Domain"
- Test 3 (result marshaling): JSON round-trip through extension produces correct object
- Test 4 (URL query params): tab found and script executed via extension
- Test 5 (sequential commands): two commands in sequence, no deadlock

If tests fail, check:
1. Extension connected? → health check above
2. "Storage bus timeout" → content script not loaded on target tab. Create the tab, wait 3+ seconds for content scripts to inject, then retry.
3. `_meta.engine === 'daemon'` → Phase 0 fix not applied (run `bash scripts/update-daemon.sh`)
4. `payload.value` is null/undefined → storage bus result not reaching background. Check Safari extension console for errors.

- [ ] **Step 5: Commit build artifacts**

```bash
git add extension/background.js extension/content-isolated.js
git commit -m "feat(extension): storage-based message bus for Safari IPC

Replaces broken tabs.sendMessage (returns undefined in alarm-woken context)
with browser.storage.local as message transport. Commands flow:
background → sp_cmd storage → content-isolated onChanged → content-main
postMessage → result → sp_result storage → background onChanged.

Root cause: Safari/WebKit IPC proxy race condition (Apple Forum 721222,
WebKit Bug 296702). Confirmed by empirical testing — tabs.query returns
41 tabs from console but [] from alarm handler."
```
