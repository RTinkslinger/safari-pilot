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
