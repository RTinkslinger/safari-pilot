// content-isolated.js — ISOLATED world
// This script CANNOT be modified by page JS. It serves as a trusted relay.
//
// Role: Secure bridge between the background service worker and the MAIN world
// content script. Page JavaScript operates in a separate context and cannot
// read or tamper with this script's state or the browser extension API.
//
// Message flow:
//   Background (runtime.sendMessage)
//     → ISOLATED world (browser.runtime.onMessage)
//       → MAIN world (window.postMessage with type SAFARI_PILOT_CMD)
//         → ISOLATED world (window.addEventListener 'message' SAFARI_PILOT_RESPONSE)
//           → Background (sendResponse callback)

(() => {
  'use strict';

  let nextRequestId = 0;
  const pendingRequests = new Map();

  // ─── Storage Bus: TabId Registration ──────────────────────────────────────
  // Safari's tabs.sendMessage returns undefined in alarm-woken event pages.
  // Commands are delivered via browser.storage.local instead.
  // Content scripts need their tabId to filter commands meant for them.
  let myTabId = null;
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
        if (myTabId !== null && pendingStorageCmd) {
          const cmd = pendingStorageCmd;
          pendingStorageCmd = null;
          processStorageCommand(cmd);
        }
      }).catch(() => {});
    }
  });

  // ─── Storage Bus: Command Listener ────────────────────────────────────────
  // Receives commands written by background.js to storage key 'sp_cmd'.
  // Forwards to MAIN world via the existing window.postMessage relay.
  // Writes results to storage key 'sp_result'.
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

  // ─── MAIN World → ISOLATED World ──────────────────────────────────────────
  // Receive responses from the MAIN world content script.
  // Only process messages from the same window (blocks cross-frame injection).

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'SAFARI_PILOT_RESPONSE') return;

    const { requestId, ok, value, error } = event.data;
    const pending = pendingRequests.get(requestId);
    if (!pending) return;

    pendingRequests.delete(requestId);
    if (ok) {
      pending.resolve(value);
    } else {
      pending.reject(error);
    }
  });

  // ─── Background → ISOLATED World ──────────────────────────────────────────
  // Receive commands from the background service worker via runtime messaging.
  // Returns true to indicate async sendResponse (keeps message channel open).

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'SAFARI_PILOT_COMMAND') return false;

    const requestId = `sp_${++nextRequestId}_${Date.now()}`;

    const promise = new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });

      // Forward to MAIN world. Use window.location.origin (never '*') per spec.
      window.postMessage(
        {
          type: 'SAFARI_PILOT_CMD',
          requestId,
          method: message.method,
          params: message.params ?? {},
        },
        window.location.origin
      );

      // Timeout: MAIN world has 10 s to respond before we fail the request
      setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          reject({ message: 'MAIN world timeout', code: 'TIMEOUT' });
        }
      }, 10_000);
    });

    promise.then(
      value => sendResponse({ ok: true, value }),
      error => sendResponse({ ok: false, error })
    );

    return true; // Keep the message channel open for async sendResponse
  });
})();

// ── Session tab keepalive ──────────────────────────────────────────────────
// When on the daemon's session page, ping the background every 20s to prevent
// Safari from killing the event page. This keeps the extension alive for the
// entire duration of the agent session.
if (location.href.startsWith('http://127.0.0.1:19475/session')) {
  browser.runtime.sendMessage({ type: 'keepalive' }).catch(() => {});
  setInterval(() => {
    browser.runtime.sendMessage({ type: 'keepalive' }).catch(() => {});
  }, 20000);
}
