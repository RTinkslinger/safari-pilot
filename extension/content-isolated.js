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

  // ─── Inlined pure helpers (canonical sources in extension/lib/) ───────────
  // Content scripts in MV3 cannot use ESM imports. These are copied verbatim
  // from extension/lib/{route-command,handshake-machine,storage-keys}.js. If
  // you change any of these, mirror the change in extension/lib/ + the unit
  // tests. A concatenation build step is deferred to v2.

  // From extension/lib/route-command.js
  // Returns: true (process), false (skip), null (handshake pending — queue)
  function shouldProcess(cmd, myTabId, myFrameId, currentLocationHref) {
    if (cmd.tabId !== myTabId) return false;
    if (myFrameId === null) return null;
    const targetFrameId = cmd.frameId ?? 0;
    if (targetFrameId !== myFrameId) return false;
    if (cmd.frameUrl != null && currentLocationHref != null && cmd.frameUrl !== currentLocationHref) {
      return false;
    }
    return true;
  }

  // From extension/lib/handshake-machine.js
  const INITIAL_HANDSHAKE_STATE = { phase: 'IDLE', myFrameId: null, queue: [] };
  function frameIdHandshakeReducer(state, event) {
    switch (event.type) {
      case 'sp_cmd_arrived': {
        if (state.phase === 'IDLE') {
          return {
            state: { ...state, phase: 'AWAITING_FRAME_ID', queue: [event.cmd] },
            effects: [{ type: 'send_sp_getFrameId' }],
          };
        }
        if (state.phase === 'AWAITING_FRAME_ID') {
          return {
            state: { ...state, queue: [...state.queue, event.cmd] },
            effects: [],
          };
        }
        // READY
        return { state, effects: [{ type: 'process_cmd', cmd: event.cmd }] };
      }
      case 'sp_getFrameId_response': {
        if (state.phase !== 'AWAITING_FRAME_ID') return { state, effects: [] };
        const drained = state.queue.map((cmd) => ({ type: 'process_cmd', cmd }));
        return {
          state: { phase: 'READY', myFrameId: event.frameId, queue: [] },
          effects: drained,
        };
      }
      case 'sp_getFrameId_error': {
        if (state.phase !== 'AWAITING_FRAME_ID') return { state, effects: [] };
        return { state: INITIAL_HANDSHAKE_STATE, effects: [] };
      }
      default:
        return { state, effects: [] };
    }
  }

  // From extension/lib/storage-keys.js
  const SP_CMD_PREFIX = 'sp_cmd_';
  const SP_RESULT_PREFIX = 'sp_result_';
  const makeSpResultKey = (commandId) => SP_RESULT_PREFIX + commandId;
  const pickSpCmdKeys = (obj) => Object.keys(obj).filter((k) => k.startsWith(SP_CMD_PREFIX));

  // ─── State ────────────────────────────────────────────────────────────────
  let nextRequestId = 0;
  const pendingRequests = new Map();

  // Storage Bus: TabId Registration
  // Safari's tabs.sendMessage returns undefined in alarm-woken event pages.
  // Commands are delivered via browser.storage.local instead.
  // Content scripts need their tabId to filter commands meant for them.
  let myTabId = null;
  let handshakeState = INITIAL_HANDSHAKE_STATE;

  const processedCommandIds = new Set();

  // ─── Handshake dispatch ───────────────────────────────────────────────────
  function dispatch(event) {
    const { state, effects } = frameIdHandshakeReducer(handshakeState, event);
    handshakeState = state;
    applyEffects(effects);
  }

  function applyEffects(effects) {
    for (const eff of effects) {
      if (eff.type === 'send_sp_getFrameId') {
        browser.runtime.sendMessage({ action: 'sp_getFrameId' }).then(
          (resp) => dispatch({ type: 'sp_getFrameId_response', frameId: resp?.frameId ?? null }),
          () => dispatch({ type: 'sp_getFrameId_error' }),
        );
      } else if (eff.type === 'process_cmd') {
        processStorageCommand(eff.cmd);
      }
    }
  }

  function processStorageCommand(cmd) {
    const decision = shouldProcess(cmd, myTabId, handshakeState.myFrameId, location.href);
    if (decision === null) {
      // Handshake pending — route through dispatch which queues
      dispatch({ type: 'sp_cmd_arrived', cmd });
      return;
    }
    if (decision === false) {
      // Distinguish frameUrl mismatch (emit FRAME_NAVIGATED) from other
      // rejections (different tab, different frame — silently ignore; those
      // frames' content-isolated.js will handle their own commands).
      const isOurFrame = cmd.tabId === myTabId && (cmd.frameId ?? 0) === handshakeState.myFrameId;
      if (isOurFrame && cmd.frameUrl != null && cmd.frameUrl !== location.href && cmd.commandId) {
        browser.storage.local.set({
          [makeSpResultKey(cmd.commandId)]: {
            commandId: cmd.commandId,
            result: {
              ok: false,
              error: {
                code: 'FRAME_NAVIGATED',
                message: `Frame URL changed: expected ${cmd.frameUrl}, found ${location.href}`,
                expected: cmd.frameUrl,
                actual: location.href,
              },
            },
            timestamp: Date.now(),
          },
        }).catch((e) => console.warn('[safari-pilot] FRAME_NAVIGATED sp_result write failed:', e?.message));
      }
      return;
    }

    // decision === true — proceed with processing
    if (cmd.deadline && cmd.deadline < Date.now()) return;
    // Guard against processing the same command twice (init read + onChanged race)
    if (cmd.commandId && processedCommandIds.has(cmd.commandId)) return;
    if (cmd.commandId) processedCommandIds.add(cmd.commandId);

    /*@DEBUG_HARNESS_BEGIN@*/
    // Test bridge: scripts prefixed with `__SP_TEST_HARNESS__:` are intercepted
    // here and executed in the isolated world (where browser.storage.local is
    // available), instead of being forwarded to the MAIN world. Used by e2e
    // tests to manipulate extension-side state (storage flags, cache reset)
    // that no shipped tool exposes. Stripped from release builds by
    // scripts/build-extension.sh — production has no such prefix and skips
    // this branch.
    const TEST_HARNESS_PREFIX = '__SP_TEST_HARNESS__:';
    if (cmd.method === 'execute_script' && typeof cmd.params?.script === 'string'
        && cmd.params.script.startsWith(TEST_HARNESS_PREFIX)) {
      handleTestHarnessCommand(cmd, cmd.params.script.slice(TEST_HARNESS_PREFIX.length));
      return;
    }
    /*@DEBUG_HARNESS_END@*/

    // 5A.1 phase-0: file upload probe sentinel — runs in ISOLATED world so
    // Test A (content-script fetch to 127.0.0.1:19475) and Test B (File
    // structured-clone ISOLATED→MAIN) execute under real content-script CSP.
    // Intercepted here (before the MAIN-world postMessage relay) because
    // Test A only needs browser.storage and fetch — no MAIN world involvement
    // until the File structured-clone sub-test. The MAIN world handler for
    // 'file_upload_probe_test_request' is registered in content-main.js.
    if (cmd.method === 'execute_script' && typeof cmd.params?.script === 'string'
        && cmd.params.script.startsWith('__SP_FILE_UPLOAD_PROBE_TEST__')) {
      handleFileUploadProbeTest(cmd);
      return;
    }

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
      (value) => {
        browser.storage.local.set({
          [makeSpResultKey(cmd.commandId)]: {
            commandId: cmd.commandId,
            result: { ok: true, value },
            timestamp: Date.now(),
          },
        }).catch((e) => console.warn('[safari-pilot] sp_result write failed:', e?.message));
      },
      (error) => {
        browser.storage.local.set({
          [makeSpResultKey(cmd.commandId)]: {
            commandId: cmd.commandId,
            result: { ok: false, error },
            timestamp: Date.now(),
          },
        }).catch((e) => console.warn('[safari-pilot] sp_result write failed:', e?.message));
      },
    );
  }

  // 5A.1 phase-0: file upload probe handler — runs in ISOLATED world.
  // Verifies two assumptions Approach 3 depends on:
  //   Test A: content-script fetch to 127.0.0.1:19475/health is permitted
  //   Test B: File objects survive ISOLATED→MAIN window.postMessage structured-clone
  // with bytes intact (SPFUBYTE signature: [0x53,0x50,0x46,0x55,0x42,0x59,0x54,0x45]).
  async function handleFileUploadProbeTest(cmd) {
    const probeResults = { fetchOk: false, structuredCloneOk: false, errors: [] };

    // Test A: content-script fetch from 127.0.0.1:19475
    try {
      const r = await fetch('http://127.0.0.1:19475/health');
      probeResults.fetchOk = r.ok;
      probeResults.fetchStatus = r.status;
    } catch (e) {
      probeResults.errors.push(`fetch failed: ${String(e && e.message || e)}`);
    }

    // Test B: build File from a hardcoded ArrayBuffer; postMessage to MAIN;
    // MAIN reports back via window.postMessage to ISOLATED.
    // Use a known signature so byte-equality can be verified end-to-end.
    const signature = new Uint8Array([0x53, 0x50, 0x46, 0x55, 0x42, 0x59, 0x54, 0x45]); // "SPFUBYTE"
    const probeFile = new File([signature], 'probe.bin', { type: 'application/octet-stream' });

    const mainResponse = await new Promise((resolve) => {
      const handler = (ev) => {
        if (ev.data && ev.data.op === 'file_upload_probe_test_response') {
          window.removeEventListener('message', handler);
          resolve(ev.data.payload);
        }
      };
      window.addEventListener('message', handler);
      window.postMessage({
        op: 'file_upload_probe_test_request',
        commandId: cmd.commandId,
        file: probeFile,
      }, '*');
      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve({ ok: false, error: 'MAIN-world response timeout (2s)' });
      }, 2000);
    });

    probeResults.structuredCloneOk = mainResponse && mainResponse.ok === true;
    probeResults.mainResponse = mainResponse;

    let result;
    try {
      result = { ok: true, value: JSON.stringify(probeResults) };
    } catch (e) {
      result = { ok: false, error: { name: 'PROBE_SERIALIZE_ERROR', message: String(e && e.message || e) } };
    }

    try {
      await browser.storage.local.set({
        [makeSpResultKey(cmd.commandId)]: { commandId: cmd.commandId, result, timestamp: Date.now() },
      });
    } catch (e) {
      console.warn('[safari-pilot] file-upload-probe sp_result write failed:', e?.message);
    }
  }

  /*@DEBUG_HARNESS_BEGIN@*/
  // Test-bridge transport. Operates in the isolated world. Forwards the parsed
  // op to background.js (which owns the state being mutated — tabCacheMap is a
  // module-local Map that can't be reached from this script). Background's
  // onMessage handler executes the op and returns {ok, value, error}.
  async function handleTestHarnessCommand(cmd, payload) {
    let result;
    try {
      const op = JSON.parse(payload);
      const resp = await browser.runtime.sendMessage({ type: '__sp_test__', op });
      if (resp?.ok) {
        result = { ok: true, value: resp.value ?? null };
      } else {
        result = { ok: false, error: resp?.error ?? { name: 'TEST_HARNESS_NO_RESPONSE', message: 'no response from background' } };
      }
    } catch (e) {
      result = { ok: false, error: { name: 'TEST_HARNESS_ERROR', message: e?.message ?? String(e) } };
    }
    try {
      await browser.storage.local.set({
        [makeSpResultKey(cmd.commandId)]: { commandId: cmd.commandId, result, timestamp: Date.now() },
      });
    } catch (e) {
      console.warn('[safari-pilot] test-harness sp_result write failed:', e?.message);
    }
  }
  /*@DEBUG_HARNESS_END@*/

  (async () => {
    try {
      const response = await browser.runtime.sendMessage({ action: 'sp_getTabId' });
      myTabId = response?.tabId ?? null;
      // Check for commands written to storage BEFORE this content script loaded.
      // storage.onChanged only fires for future changes — commands written while
      // the page was loading (document_idle) are invisible to the listener.
      // Scan all sp_cmd_* keys and dispatch each to the handshake state machine.
      if (myTabId !== null) {
        const stored = await browser.storage.local.get(null);
        for (const key of pickSpCmdKeys(stored)) {
          const cmd = stored[key];
          if (cmd) dispatch({ type: 'sp_cmd_arrived', cmd });
        }
      }
    } catch {
      // Background not available on first load — retry on visibility change
    }
  })();

  // Retry tabId registration when tab becomes visible (handles case where
  // background wasn't running when content script first loaded).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && myTabId === null) {
      browser.runtime.sendMessage({ action: 'sp_getTabId' }).then((response) => {
        myTabId = response?.tabId ?? null;
      }).catch(() => {});
    }
  });

  // ─── Storage Bus: Command Listener ────────────────────────────────────────
  // Receives commands written by background.js to keys matching sp_cmd_*.
  // Forwards to MAIN world via the existing window.postMessage relay.
  // Writes results to storage key 'sp_result_<commandId>'.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of Object.keys(changes)) {
      if (!key.startsWith(SP_CMD_PREFIX)) continue;
      const cmd = changes[key].newValue;
      if (!cmd) continue;
      dispatch({ type: 'sp_cmd_arrived', cmd });
    }
  });

  // ─── pagehide: best-effort fast-fail for FRAME_NAVIGATED ──────────────────
  // Notifies background that this frame is unloading so in-flight commands
  // targeting this frame can fail fast. Unload-time message delivery is not
  // guaranteed — the frameUrl mutation guard inside the next
  // content-isolated.js is the secondary path; webNavigation revalidation on
  // the next call is the final safety net.
  window.addEventListener('pagehide', () => {
    try {
      browser.runtime.sendMessage({
        action: 'sp_frame_unloading',
        frameId: handshakeState.myFrameId,
      }).catch(() => {});
    } catch {}
  });

  // ─── MAIN World → ISOLATED World ──────────────────────────────────────────
  // Receive responses from the MAIN world content script.
  // Only process messages from the same window (blocks cross-frame injection).

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    // T21: SPA URL change relay. Forward the new URL to background via
    // runtime.sendMessage so background can refresh its tabCacheMap.
    // Top-frame discrimination happens in background via sender.frameId.
    if (event.data?.type === 'SAFARI_PILOT_URL_CHANGE') {
      const url = event.data.url;
      if (typeof url === 'string') {
        browser.runtime.sendMessage({ type: 'sp_url_changed', url }).catch(() => {});
      }
      return;
    }

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
