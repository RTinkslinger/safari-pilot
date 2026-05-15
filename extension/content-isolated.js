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

    // 5A.1 file_upload PROBE — locator-only, validates <input type=file>
    if (cmd.method === 'execute_script' && typeof cmd.params?.script === 'string'
        && cmd.params.script.startsWith('__SP_FILE_UPLOAD_PROBE__:')) {
      handleFileUploadProbe(cmd);
      return;
    }

    // 5A.1 file_upload FINAL — fetch bytes, build Files, postMessage to MAIN
    if (cmd.method === 'execute_script' && typeof cmd.params?.script === 'string'
        && cmd.params.script.startsWith('__SP_FILE_UPLOAD__:')) {
      handleFileUpload(cmd);
      return;
    }

    // v0.1.34 Task 4: __SP_GET_PAGE_INFO__:<json> — CSP-immune page metadata read.
    // ISOLATED world bypasses page CSP/Trusted Types entirely; the DOM is shared
    // between MAIN and ISOLATED so document.title/.querySelector all work.
    if (cmd.method === 'execute_script' && typeof cmd.params?.script === 'string'
        && cmd.params.script.startsWith('__SP_GET_PAGE_INFO__:')) {
      handleGetPageInfo(cmd);
      return;
    }

    // v0.1.34 Task 5: __SP_GET_META_TAGS__:<json> — read <meta> tags (CSP-immune).
    if (cmd.method === 'execute_script' && typeof cmd.params?.script === 'string'
        && cmd.params.script.startsWith('__SP_GET_META_TAGS__:')) {
      handleGetMetaTags(cmd);
      return;
    }

    // v0.1.34 Task 6: __SP_EXTRACT_TEXT_WINDOW__:<json> — textContent of selector
    // matches, capped at max_chars (CSP-immune).
    if (cmd.method === 'execute_script' && typeof cmd.params?.script === 'string'
        && cmd.params.script.startsWith('__SP_EXTRACT_TEXT_WINDOW__:')) {
      handleExtractTextWindow(cmd);
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
      let timeoutId;
      const handler = (ev) => {
        if (ev.data && ev.data.op === 'file_upload_probe_test_response') {
          clearTimeout(timeoutId);
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
      timeoutId = setTimeout(() => {
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

  // 5A.1 — probe handler. Validates locator + element type without staging bytes.
  async function handleFileUploadProbe(cmd) {
    const json = cmd.params.script.slice('__SP_FILE_UPLOAD_PROBE__:'.length);
    let parsed;
    try { parsed = JSON.parse(json); } catch (e) {
      await writeFileUploadProbeResult(cmd.commandId, { ok: false, errorCode: 'INVALID_PARAMS', message: 'probe JSON parse failed' });
      return;
    }
    const { locator } = parsed;
    let result;
    try {
      const el = resolveFileUploadLocator(locator);
      if (!el) {
        result = { ok: false, errorCode: 'LOCATOR_NOT_FOUND' };
      } else if (el.tagName !== 'INPUT' || el.type !== 'file') {
        result = { ok: false, errorCode: 'FILE_UPLOAD_INVALID_ELEMENT', tagName: el.tagName, type: el.type || '' };
      } else {
        result = {
          ok: true,
          isFileInput: true,
          multiple: el.multiple === true,
          accept: el.accept || '',
        };
      }
    } catch (e) {
      result = { ok: false, errorCode: 'PROBE_ERROR', message: String(e && e.message || e) };
    }
    await writeFileUploadProbeResult(cmd.commandId, result);
  }

  // 5A.1 — final upload handler. Bytes via /file-bytes/<token>, File construction
  // in extension permission context, postMessage to MAIN for DataTransfer injection.
  async function handleFileUpload(cmd) {
    const json = cmd.params.script.slice('__SP_FILE_UPLOAD__:'.length);
    let parsed;
    try { parsed = JSON.parse(json); } catch (e) {
      await writeFileUploadResult(cmd.commandId, { ok: false, error: { code: 'INVALID_PARAMS', message: 'upload JSON parse failed' } });
      return;
    }
    const { locator, tokens, clear, probeOpts } = parsed;

    // Fetch bytes for each token — Files constructed in this content-script's
    // permission context (CSP allows http://127.0.0.1:19475/* per spike).
    const files = [];
    const fetchErrors = [];
    for (const tokenInfo of (tokens || [])) {
      try {
        const r = await fetch('http://127.0.0.1:19475/file-bytes/' + tokenInfo.token);
        if (!r.ok) {
          fetchErrors.push({ token: tokenInfo.token, status: r.status });
          continue;
        }
        const buf = await r.arrayBuffer();
        const file = new File([buf], tokenInfo.name, { type: tokenInfo.mimeType });
        files.push({ file, mimeFallback: tokenInfo.mimeFallback === true });
      } catch (e) {
        fetchErrors.push({ token: tokenInfo.token, error: String(e && e.message || e) });
      }
    }

    if (fetchErrors.length > 0) {
      await writeFileUploadResult(cmd.commandId, {
        ok: false,
        error: {
          code: 'FILE_UPLOAD_FETCH_FAILED',
          message: 'failed to fetch ' + fetchErrors.length + ' file(s) from daemon',
          details: fetchErrors,
        },
      });
      return;
    }

    // postMessage to MAIN with File array — structured-clone preserves Files
    // (Phase 0 spike Test B verified this assumption holds in Safari).
    const responsePromise = new Promise((resolve) => {
      let timeoutId;
      const handler = (ev) => {
        if (ev.data && ev.data.op === 'file_upload_response' && ev.data.commandId === cmd.commandId) {
          clearTimeout(timeoutId);
          window.removeEventListener('message', handler);
          resolve(ev.data.payload);
        }
      };
      window.addEventListener('message', handler);
      timeoutId = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve({ ok: false, errorCode: 'INJECT_TIMEOUT', message: 'main-world response timeout (5s)' });
      }, 5000);
    });

    window.postMessage({
      op: 'file_upload_inject',
      commandId: cmd.commandId,
      locator,
      files: files.map((f) => f.file),
      clear: clear === true,
      probeOpts,
    }, '*');

    const response = await responsePromise;

    // DELETE bytes from daemon to release memory (idempotent — 404 is fine).
    await Promise.all((tokens || []).map((t) =>
      fetch('http://127.0.0.1:19475/file-bytes/' + t.token, { method: 'DELETE' }).catch(() => null)
    ));

    if (response.ok === false) {
      await writeFileUploadResult(cmd.commandId, {
        ok: false,
        error: { code: response.errorCode || 'FILE_UPLOAD_FAILED', message: response.message || '' },
      });
      return;
    }

    // Annotate mimeFallback per file in the MAIN response.
    if (Array.isArray(response.files)) {
      for (let i = 0; i < response.files.length; i++) {
        if (files[i]?.mimeFallback) response.files[i].mimeFallback = true;
      }
    }

    await writeFileUploadResult(cmd.commandId, { ok: true, value: JSON.stringify(response) });
  }

  // Helpers — mirror handleFileUploadProbeTest's storage-write pattern.
  async function writeFileUploadProbeResult(commandId, result) {
    const wireResult = { ok: true, value: JSON.stringify(result) };
    try {
      await browser.storage.local.set({
        [makeSpResultKey(commandId)]: { commandId, result: wireResult, timestamp: Date.now() },
      });
    } catch (e) {
      console.warn('[safari-pilot] file-upload-probe sp_result write failed:', e?.message);
    }
  }

  async function writeFileUploadResult(commandId, result) {
    try {
      await browser.storage.local.set({
        [makeSpResultKey(commandId)]: { commandId, result, timestamp: Date.now() },
      });
    } catch (e) {
      console.warn('[safari-pilot] file-upload sp_result write failed:', e?.message);
    }
  }

  // v0.1.34 Tasks 4-6: shared storage-bus writer for ISOLATED-world sentinels.
  // Mirrors writeFileUploadResult — wire-result shape {ok, value, error} written
  // directly to sp_result_<commandId>. ExtensionBridge.handleResult on the daemon
  // side reads value and surfaces it as EngineResult.value.
  async function writeIsolatedSentinelResult(commandId, result) {
    try {
      await browser.storage.local.set({
        [makeSpResultKey(commandId)]: { commandId, result, timestamp: Date.now() },
      });
    } catch (e) {
      console.warn('[safari-pilot] isolated-sentinel sp_result write failed:', e?.message);
    }
  }

  // v0.1.34 Task 4 — __SP_GET_PAGE_INFO__
  async function handleGetPageInfo(cmd) {
    let result;
    try {
      const json = cmd.params.script.slice('__SP_GET_PAGE_INFO__:'.length);
      const args = json ? JSON.parse(json) : {};
      const bodyMaxChars = typeof args.bodyMaxChars === 'number' ? args.bodyMaxChars : 2000;
      const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
      const truncated = bodyText.length > bodyMaxChars;
      const trimmedBody = truncated ? bodyText.slice(0, bodyMaxChars) : bodyText;
      const metaDesc = document.querySelector('meta[name="description"]');
      const metaOgImage = document.querySelector('meta[property="og:image"]');
      const lang = document.documentElement.lang || (navigator.language || '');
      const value = JSON.stringify({
        title: document.title || '',
        url: location.href,
        body_snippet: trimmedBody,
        body_truncated: truncated,
        meta_description: metaDesc ? metaDesc.getAttribute('content') : null,
        meta_og_image: metaOgImage ? metaOgImage.getAttribute('content') : null,
        lang: lang,
      });
      result = { ok: true, value };
    } catch (e) {
      result = { ok: false, error: { name: 'GET_PAGE_INFO_ERROR', message: String(e && e.message || e) } };
    }
    await writeIsolatedSentinelResult(cmd.commandId, result);
  }

  // v0.1.34 Task 5 — __SP_GET_META_TAGS__
  async function handleGetMetaTags(cmd) {
    let result;
    try {
      const json = cmd.params.script.slice('__SP_GET_META_TAGS__:'.length);
      const args = json ? JSON.parse(json) : {};
      const namesFilter = Array.isArray(args.names) ? new Set(args.names) : null;
      const tags = [];
      const metaEls = document.querySelectorAll('meta');
      for (const m of metaEls) {
        let n = m.getAttribute('name');
        let attr_source = 'name';
        if (!n) { n = m.getAttribute('property'); attr_source = 'property'; }
        if (!n) { n = m.getAttribute('http-equiv'); attr_source = 'http-equiv'; }
        if (!n) continue;
        if (namesFilter && !namesFilter.has(n)) continue;
        tags.push({ name: n, content: m.getAttribute('content') || '', attr_source });
      }
      result = { ok: true, value: JSON.stringify({ tags }) };
    } catch (e) {
      result = { ok: false, error: { name: 'META_TAGS_ERROR', message: String(e && e.message || e) } };
    }
    await writeIsolatedSentinelResult(cmd.commandId, result);
  }

  // v0.1.34 Task 6 — __SP_EXTRACT_TEXT_WINDOW__
  async function handleExtractTextWindow(cmd) {
    let result;
    try {
      const json = cmd.params.script.slice('__SP_EXTRACT_TEXT_WINDOW__:'.length);
      const args = json ? JSON.parse(json) : {};
      const sel = args.selector;
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : 5000;
      const matches = document.querySelectorAll(sel);
      let combined = '';
      for (const node of matches) {
        const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
        combined += (combined ? '\n' : '') + t;
        if (combined.length >= maxChars) break;
      }
      const truncated = combined.length > maxChars;
      const text = truncated ? combined.slice(0, maxChars) : combined;
      result = { ok: true, value: JSON.stringify({ text, truncated, selector_matched_count: matches.length }) };
    } catch (e) {
      result = { ok: false, error: { name: 'EXTRACT_TEXT_ERROR', message: String(e && e.message || e) } };
    }
    await writeIsolatedSentinelResult(cmd.commandId, result);
  }

  // Minimal locator resolution for 5A.1 v1 — supports selector, xpath, ref.
  // (Other types — role, text, label, placeholder — require shared resolver
  // not yet wired into extension JS. Phase 7 e2e tests focus on selector + xpath.)
  function resolveFileUploadLocator(locator) {
    if (!locator || typeof locator !== 'object') return null;
    if (typeof locator.selector === 'string') {
      return document.querySelector(locator.selector);
    }
    if (typeof locator.xpath === 'string') {
      try {
        return document.evaluate(locator.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
      } catch { return null; }
    }
    if (typeof locator.ref === 'string') {
      return document.querySelector('[data-sp-ref="' + CSS.escape(locator.ref) + '"]');
    }
    return null;
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
      // v0.1.36 Fix 3 — write content-script readiness heartbeat as soon as
      // we know our tabId. background.js's storage listener picks this up
      // and gates storage-bus dispatch timeouts (decideStorageBusTimeout in
      // extension/lib/cs-readiness.js). Without this, the first storage-bus
      // call to a freshly opened/navigated tab would block the full 30s.
      if (myTabId !== null) {
        try {
          await browser.storage.local.set({
            ['sp_cs_ready_' + myTabId]: { ts: Date.now(), frameId: 0 },
          });
        } catch { /* storage may be transiently unavailable; non-fatal */ }
      }
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
