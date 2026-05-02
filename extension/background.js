// extension/background.js — Event Page (persistent:false)
// All listeners registered at top level. No IIFE (Safari re-evaluates on every wake).
// No ES module syntax (event pages do not support modules).
'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const APP_BUNDLE_ID = 'com.safari-pilot.app';
const KEEPALIVE_ALARM_NAME = 'safari-pilot-keepalive';
const KEEPALIVE_PERIOD_MIN = 1;
const STORAGE_KEY_PENDING = 'safari_pilot_pending_commands';
const EXTENSION_VERSION = '0.1.6';

// ─── State ───────────────────────────────────────────────────────────────────
let listenersAttached = false;
let isWakeRunning = false;  // serializes concurrent wake-SETUP triggers
let wakePending = false;
// T60: pollLoop is decoupled from the wake-setup lock. It runs as a
// fire-and-forget singleton with its own AbortController so a fresh alarm
// wake can forcibly kill a prior pollLoop whose fetch is stuck on a
// suspended event-page (the T60 dormancy mode: alarm_fire trace events
// continue but no /connect or /poll reach the daemon because the prior
// initialize() is awaiting a fetch promise that will never resolve, and
// its `finally` never runs to clear isWakeRunning).
let pollLoopController = null;

// ─── Tab Cache ──────────────────────────────────────────────────────────────
// Safari's browser.tabs.query({}) returns [] when called from alarm-triggered
// event page context. Maintain a persistent tab index via lifecycle events.
// Cache is loaded from storage on wake and updated in real-time via listeners.
const STORAGE_KEY_TAB_CACHE = 'safari_pilot_tab_cache';
let tabCacheMap = new Map(); // tabId → {url, title}

async function loadTabCache() {
  try {
    const stored = await browser.storage.local.get(STORAGE_KEY_TAB_CACHE);
    const entries = stored[STORAGE_KEY_TAB_CACHE];
    if (Array.isArray(entries)) {
      tabCacheMap = new Map(entries);
    }
  } catch { /* ignore */ }
}

async function saveTabCache() {
  try {
    // Limit cache to 50 most recent tabs to prevent storage quota overflow
    const entries = Array.from(tabCacheMap.entries());
    const limited = entries.slice(-50);
    await browser.storage.local.set({
      [STORAGE_KEY_TAB_CACHE]: limited,
    });
  } catch (e) {
    if (e?.message?.includes?.('quota')) {
      // Storage full — clear stale data and retry
      await browser.storage.local.remove([STORAGE_KEY_TAB_CACHE, STORAGE_KEY_PENDING]).catch(() => {});
      tabCacheMap.clear();
    }
  }
}

// Top-level tab lifecycle listeners — MUST be registered synchronously at script
// load time so Safari wakes the event page when tabs change.
browser.tabs.onCreated.addListener((tab) => {
  if (tab.id != null) {
    tabCacheMap.set(tab.id, { url: tab.url || '', title: tab.title || '' });
    saveTabCache();
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const entry = tabCacheMap.get(tabId) || { url: '', title: '' };
  if (changeInfo.url !== undefined) entry.url = changeInfo.url;
  if (changeInfo.title !== undefined) entry.title = changeInfo.title;
  // Also pick up from the full tab object if changeInfo is sparse
  if (tab.url && !entry.url) entry.url = tab.url;
  if (tab.title && !entry.title) entry.title = tab.title;
  tabCacheMap.set(tabId, entry);
  saveTabCache();
});

browser.tabs.onRemoved.addListener((tabId) => {
  tabCacheMap.delete(tabId);
  saveTabCache();
});

// ─── HTTP IPC to daemon ─────────────────────────────────────────────────────
const HTTP_URL = 'http://127.0.0.1:19475';

async function httpPost(path, body) {
  const res = await fetch(`${HTTP_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 204) return null;
  return res.json();
}

async function httpPoll(externalAbortSignal) {
  /*@DEBUG_HARNESS_BEGIN@*/
  // Test-only: precise injection of a single transient fetch failure on
  // the NEXT /poll iteration, used by T22's e2e to verify the pollLoop's
  // retry ladder without involving daemon kickstart (which destabilizes
  // both the daemon and MCP-side TCP connection). Read-once-and-clear so
  // a single trigger drives exactly one retry cycle.
  if (globalThis.__sp_test_inject_next_poll_failure) {
    globalThis.__sp_test_inject_next_poll_failure = false;
    const err = new TypeError('__sp_test_injected_failure');
    throw err;
  }
  /*@DEBUG_HARNESS_END@*/
  // T60: combine the per-fetch 10s timeout with the externally provided
  // abort signal (from pollLoopController) so the next alarm wake can
  // forcibly cancel a fetch promise that Safari's event-page suspension
  // has left in an unresolvable state.
  const timeoutSignal = AbortSignal.timeout(10000);
  const signal = externalAbortSignal
    ? AbortSignal.any([externalAbortSignal, timeoutSignal])
    : timeoutSignal;
  const res = await fetch(`${HTTP_URL}/poll`, { signal });
  if (res.status === 204) return null;
  return res.json();
}

function postResult(commandId, result) {
  httpPost('/result', { requestId: commandId, result })
    .catch((e) => console.warn('[safari-pilot] postResult failed:', e.message));
}

function emitTrace(commandId, event, data) {
  httpPost('/result', {
    requestId: '__trace__',
    result: { type: 'trace', id: commandId, layer: 'extension-bg', event, data }
  }).catch(() => {});
}

// ─── Storage-backed pending queue ────────────────────────────────────────────
async function readPending() {
  const s = await browser.storage.local.get(STORAGE_KEY_PENDING);
  return s[STORAGE_KEY_PENDING] || {};
}

async function writePending(pending) {
  await browser.storage.local.set({ [STORAGE_KEY_PENDING]: pending });
}

async function updatePendingEntry(commandId, partial) {
  const pending = await readPending();
  pending[commandId] = { ...(pending[commandId] || {}), ...partial };
  await writePending(pending);
}

async function removePendingEntry(commandId) {
  const pending = await readPending();
  delete pending[commandId];
  await writePending(pending);
}

// ─── Command execution ───────────────────────────────────────────────────────
async function findTargetTab(tabUrl) {
  if (tabUrl) {
    const target = tabUrl.replace(/\/$/, '');

    // Test-only escape hatch: if `__sp_test_skip_tabs_query__` is set in
    // storage, the tabs.query primary path is skipped. Used by e2e tests to
    // simulate Safari's alarm-wake context where tabs.query({}) returns [].
    // Production never sets this key; the DEBUG_HARNESS markers strip the
    // read from release builds entirely (see scripts/build-extension.sh).
    let skipTabsQuery = false;
    /*@DEBUG_HARNESS_BEGIN@*/
    try {
      const flag = await browser.storage.local.get('__sp_test_skip_tabs_query__');
      skipTabsQuery = !!flag['__sp_test_skip_tabs_query__'];
    } catch { /* ignore */ }
    /*@DEBUG_HARNESS_END@*/

    if (!skipTabsQuery) {
      // Primary: browser.tabs.query (works when event page is fully active)
      const all = await browser.tabs.query({});
      if (all.length > 0) {
        const match = all.find((t) => (t.url || '').replace(/\/$/, '') === target);
        if (match) return match;
      }
    }

    // Fallback: persistent tab cache (works when tabs.query returns [] in
    // alarm-triggered wake context — Safari event page lifecycle limitation).
    if (tabCacheMap.size > 0) {
      for (const [tabId, info] of tabCacheMap) {
        if ((info.url || '').replace(/\/$/, '') === target) {
          // Return a minimal tab-like object with the id for scripting API
          return { id: tabId, url: info.url, title: info.title };
        }
      }
    }

    // T27: tabUrl was explicitly provided but BOTH lookups missed. Fail
    // closed instead of falling through to the active-tab — silently
    // running the agent's command in whichever tab is frontmost would
    // violate tab isolation. The caller turns null into a TAB_NOT_FOUND
    // structured error.
    return null;
  }
  const actives = await browser.tabs.query({ active: true, currentWindow: true });
  return actives[0];
}

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
    // T27: structured error so the daemon's ExtensionBridge.handleResult
    // lifts `name` into StructuredError.code. The TS-side ExtensionEngine
    // round-trips that as the error code, surfacing TAB_NOT_FOUND to MCP.
    const error = cmd.tabUrl
      ? { name: 'TAB_NOT_FOUND', message: `No agent-owned tab matches url="${cmd.tabUrl}" (extension cache miss)` }
      : { message: `No target tab for url="${cmd.tabUrl}"` };
    const result = { ok: false, error };
    await updatePendingEntry(commandId, { status: 'completed', result });
    return result;
  }

  // T55a: list_frames sentinel — bypass storage bus, call webNavigation directly.
  // safari_list_frames sends '__SP_LIST_FRAMES__' as the script string when
  // engine.name === 'extension'. Returns frame topology with stable frameIds.
  // Placed AFTER findTargetTab (need valid tab.id) and BEFORE frameId validation
  // (list_frames itself doesn't target a frame — it queries the topology).
  if (cmd.script === '__SP_LIST_FRAMES__') {
    let frames;
    try {
      frames = await browser.webNavigation.getAllFrames({ tabId: tab.id });
    } catch (e) {
      const result = { ok: false, error: { name: 'WEBNAVIGATION_ERROR', message: `webNavigation.getAllFrames failed: ${e?.message ?? String(e)}` } };
      await updatePendingEntry(commandId, { status: 'completed', result });
      return result;
    }
    const value = JSON.stringify({
      count: frames.length,
      frames: frames.map((f) => ({
        frameId: f.frameId,
        parentFrameId: f.parentFrameId,
        url: f.url,
        errorOccurred: f.errorOccurred ?? false,
      })),
    });
    const result = { ok: true, value };
    await updatePendingEntry(commandId, { status: 'completed', result });
    return result;
  }

  // T55a: validate frameId at dispatch time. Missing frame → fast-fail
  // before any storage-bus traffic. Re-resolve frame.url so content-isolated.js's
  // mutation guard has the authoritative value when comparing to location.href.
  if (cmd.frameId != null && cmd.frameId !== 0) {
    let frames;
    try {
      frames = await browser.webNavigation.getAllFrames({ tabId: tab.id });
    } catch (e) {
      const result = { ok: false, error: { name: 'FRAME_NOT_FOUND', message: `webNavigation.getAllFrames failed for tab ${tab.id}: ${e?.message ?? String(e)}` } };
      await updatePendingEntry(commandId, { status: 'completed', result });
      return result;
    }
    const target = (frames || []).find((f) => f.frameId === cmd.frameId);
    if (!target) {
      const result = { ok: false, error: { name: 'FRAME_NOT_FOUND', message: `Frame ${cmd.frameId} not found in tab ${tab.id}` } };
      await updatePendingEntry(commandId, { status: 'completed', result });
      return result;
    }
    // Re-resolve frameUrl to the frame's CURRENT URL at dispatch time.
    // content-isolated.js compares this against location.href on receipt;
    // mismatch → FRAME_NAVIGATED. Mutating cmd in place so storageCmd
    // construction below picks it up.
    cmd.frameUrl = target.url;
  }

  // ── Storage bus: write command, wait for result ──────────────────────────
  // Safari's tabs.sendMessage and scripting.executeScript return undefined/null
  // in alarm-woken event page context. Use browser.storage.local as the message
  // transport instead. Content-isolated.js picks up commands via onChanged.
  //
  // IMPORTANT: Attach the result listener BEFORE writing the command.
  // If the write triggers onChanged synchronously before the listener is
  // attached, the result event would be missed and we'd wait 30s for nothing.
  // T55a: keys are commandId-suffixed (sp_cmd_<id>/sp_result_<id>) to avoid
  // single-slot collisions when multiple frame-targeted commands are in flight.
  const cmdKey = 'sp_cmd_' + commandId;
  const resultKey = 'sp_result_' + commandId;
  const isFrameTargeted = cmd.frameId != null && cmd.frameId !== 0;
  const TIMEOUT_MS = isFrameTargeted ? 10000 : 30000;
  const storageCmd = {
    commandId,
    tabId: tab.id,
    method: 'execute_script',
    params: { script: cmd.script, commandId },
    ...(isFrameTargeted ? { frameId: cmd.frameId, frameUrl: cmd.frameUrl } : {}),
    timestamp: Date.now(),
    deadline: Date.now() + TIMEOUT_MS,
  };

  // Step 1: Attach result listener FIRST
  let resultResolver;
  const resultPromise = new Promise((resolve) => {
    resultResolver = resolve;
  });

  // Keep-alive: Safari kills event pages after ~30s of inactivity. setTimeout
  // and storage reads don't count as "active work." Periodic HTTP fetch to the
  // daemon keeps the event page alive so the timeout and onChanged listener fire.
  const keepAlive = setInterval(() => {
    fetch(`${HTTP_URL}/poll`, { signal: AbortSignal.timeout(1000) }).catch(() => {});
  }, 10000);

  const resultTimeout = setTimeout(() => {
    clearInterval(keepAlive);
    browser.storage.onChanged.removeListener(resultListener);
    const errorCode = isFrameTargeted ? 'FRAME_UNREACHABLE' : 'STORAGE_BUS_TIMEOUT';
    const errorMessage = isFrameTargeted
      ? `Frame ${cmd.frameId} unreachable — content script did not respond within ${TIMEOUT_MS}ms (sandbox/CSP/injection failure?)`
      : `Storage bus timeout (${TIMEOUT_MS}ms) — content script may not be loaded on target tab`;
    resultResolver({ ok: false, error: { name: errorCode, message: errorMessage } });
  }, TIMEOUT_MS);

  function resultListener(changes, area) {
    if (area !== 'local' || !changes[resultKey]?.newValue) return;
    const reply = changes[resultKey].newValue;
    // commandId match is implied by the keyed lookup; defensive double-check
    if (reply.commandId !== commandId) return;
    clearInterval(keepAlive);
    clearTimeout(resultTimeout);
    browser.storage.onChanged.removeListener(resultListener);
    emitTrace(commandId, 'result_received', { ok: reply.result?.ok ?? null, hasValue: reply.result?.value !== undefined });
    resultResolver(reply.result);
  }
  browser.storage.onChanged.addListener(resultListener);

  // Step 2: THEN write the command (listener is already waiting)
  await browser.storage.local.set({ [cmdKey]: storageCmd });
  emitTrace(commandId, 'cmd_dispatched', { tabId: tab.id, tabUrl: cmd.tabUrl });

  // Step 3: Wait for result
  const result = await resultPromise;

  // Enrich result with tab identity metadata.
  // `tab` is from findTargetTab (line 168) — has the stable tab.id and current URL.
  // _meta is a sideband channel: ExtensionBridge passes it through alongside the value,
  // and ExtensionEngine extracts it into EngineResult.meta on the TypeScript side.
  const enrichedResult = result && typeof result === 'object'
    ? { ...result, _meta: { tabId: tab.id, tabUrl: tab.url } }
    : result;
  emitTrace(commandId, 'result_enriched', { tabId: tab.id, tabUrl: tab.url, enriched: typeof enrichedResult === 'object' && '_meta' in enrichedResult });

  // Cleanup storage keys (safe — result already captured in `result` variable)
  try { await browser.storage.local.remove([cmdKey, resultKey]); } catch { /* ignore cleanup errors */ }

  await updatePendingEntry(commandId, { status: 'completed', result: enrichedResult });
  return enrichedResult;
}

// Results are sent via postResult() in the poll loop and reconcile handler.
// Pending entries are only removed when daemon confirms via reconcile acked response.

// ─── Cookie Operations (preserved verbatim) ──────────────────────────────────
async function handleCookieGet(params) {
  const result = await browser.cookies.get({
    url: params.url, name: params.name, storeId: params.storeId,
  });
  return { ok: true, value: result };
}

async function handleCookieSet(params) {
  const result = await browser.cookies.set({
    url: params.url, name: params.name, value: params.value,
    domain: params.domain, path: params.path ?? '/',
    secure: params.secure ?? false, httpOnly: params.httpOnly ?? false,
    sameSite: params.sameSite, expirationDate: params.expirationDate,
    storeId: params.storeId,
  });
  return { ok: true, value: result };
}

async function handleCookieRemove(params) {
  const result = await browser.cookies.remove({
    url: params.url, name: params.name, storeId: params.storeId,
  });
  return { ok: true, value: result };
}

async function handleCookieGetAll(params) {
  const result = await browser.cookies.getAll({
    url: params.url, domain: params.domain, name: params.name,
    path: params.path, secure: params.secure, storeId: params.storeId,
  });
  return { ok: true, value: result };
}

// ─── DNR Operations (preserved verbatim) ─────────────────────────────────────
async function handleDnrAddRule(params) {
  await browser.declarativeNetRequest.updateDynamicRules({
    addRules: [params.rule], removeRuleIds: [],
  });
  return { ok: true, value: { added: true, ruleId: params.rule?.id } };
}

async function handleDnrRemoveRule(params) {
  await browser.declarativeNetRequest.updateDynamicRules({
    addRules: [], removeRuleIds: [params.ruleId],
  });
  return { ok: true, value: { removed: true, ruleId: params.ruleId } };
}

// ─── execute_in_main (forward to content script, preserved) ──────────────────
async function handleExecuteInMain(message, sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null) {
    return { ok: false, error: { message: 'No tab context available' } };
  }
  try {
    const [result] = await browser.tabs.sendMessage(tabId, {
      type: 'SAFARI_PILOT_COMMAND',
      method: message.method,
      params: message.params ?? {},
    });
    return result ?? { ok: true, value: null };
  } catch (err) {
    return { ok: false, error: { message: err.message } };
  }
}

// ─── Command Router (preserved) ──────────────────────────────────────────────
async function handleCommand(message, sender) {
  const { command, params } = message;
  try {
    switch (command) {
      case 'execute_in_main': return await handleExecuteInMain(message, sender);
      case 'cookie_get': return await handleCookieGet(params ?? {});
      case 'cookie_set': return await handleCookieSet(params ?? {});
      case 'cookie_remove': return await handleCookieRemove(params ?? {});
      case 'cookie_get_all': return await handleCookieGetAll(params ?? {});
      case 'dnr_add_rule': return await handleDnrAddRule(params ?? {});
      case 'dnr_remove_rule': return await handleDnrRemoveRule(params ?? {});
      default: return { ok: false, error: { message: `Unknown command: ${command}` } };
    }
  } catch (err) {
    return { ok: false, error: { message: err.message, name: err.name } };
  }
}

// ─── Reconcile response handler ──────────────────────────────────────────────
async function handleReconcileResponse(data) {
  // Destructure all 5 categories. reQueued and inFlight need no client action:
  // reQueued → daemon flipped delivered=false, will re-deliver via /poll
  // inFlight → daemon knows extension is executing them; timeout handles failures
  const { acked = [], uncertain = [], reQueued = [], inFlight = [], pushNew = [] } = data;
  for (const commandId of acked) {
    await removePendingEntry(commandId);
  }
  const pending = await readPending();
  for (const commandId of uncertain) {
    const entry = pending[commandId];
    if (entry && entry.status === 'completed' && entry.result) {
      postResult(commandId, entry.result);
    }
  }
  for (const cmd of pushNew) {
    const result = await executeCommand(cmd);
    postResult(cmd.id, result);
  }
}

// ─── Storage GC ─────────────────────────────────────────────────────────────
async function gcPendingStorage() {
  const pending = await readPending();
  const cutoff = Date.now() - 600000;
  let changed = false;
  for (const [commandId, entry] of Object.entries(pending)) {
    if (entry.status === 'completed' && entry.timestamp && entry.timestamp < cutoff) {
      delete pending[commandId];
      changed = true;
    }
  }
  if (changed) await writePending(pending);
}

// ─── Storage-bus cleanup (T44) ──────────────────────────────────────────────
// Safari may suspend the event page between writing `sp_cmd_<id>` and removing
// it at executeCommand's post-success cleanup. On wake, that orphan key is
// invisible to the previous session's resultListener (which is dead) and can
// be re-read by content-isolated.js on next tab load — phantom execution.
// Same risk for `sp_result_<id>` left behind by a session that died before
// delivering its result. Run this after gcPendingStorage so the "live"
// predicate reflects the post-GC pending map, and before
// connectAndReconcile/pollLoop so the daemon's first dispatched command
// can never collide with a leftover key.
// T55a: storage bus migrated to commandId-keyed slots — prefix-scan all
// sp_cmd_*/sp_result_* keys instead of two literals.
async function cleanupStaleStorageBus() {
  try {
    const stored = await browser.storage.local.get(null);
    const pending = await readPending();
    const liveIds = new Set();
    for (const [commandId, entry] of Object.entries(pending)) {
      if (entry && entry.status === 'executing') {
        liveIds.add(commandId);
      }
    }
    const toRemove = [];
    const removedDetails = {};
    // T55a: prefix-scan all sp_cmd_*/sp_result_* keys. Any whose commandId is
    // not in the live set (no in-flight handleCommand owns it) is stale and removed.
    for (const key of Object.keys(stored)) {
      if (!key.startsWith('sp_cmd_') && !key.startsWith('sp_result_')) continue;
      const commandId = key.startsWith('sp_cmd_') ? key.slice('sp_cmd_'.length) : key.slice('sp_result_'.length);
      if (!liveIds.has(commandId)) {
        toRemove.push(key);
        removedDetails[key] = commandId;
      }
    }
    if (toRemove.length > 0) {
      await browser.storage.local.remove(toRemove);
      // Trace contract (load-bearing for T44 e2e discriminator):
      // emitted ONLY on actual orphan removal. Test asserts the
      // commandIds match the planted poison after a forceUnload.
      // Pre-fix this function doesn't exist → trace never appears.
      emitTrace('__cleanup__', 'orphan_storage_bus_removed', {
        removed: toRemove,
        commandIds: removedDetails,
      });
    }
  } catch (e) {
    console.warn('[safari-pilot] cleanupStaleStorageBus error:', e?.message);
  }
}

// ─── Connect + Reconcile ────────────────────────────────────────────────────
async function connectAndReconcile() {
  const pending = await readPending();
  const executedIds = [];
  const pendingIds = [];
  for (const [commandId, entry] of Object.entries(pending)) {
    if (entry.status === 'completed' && entry.result) {
      executedIds.push(commandId);
    } else if (entry.status === 'executing') {
      pendingIds.push(commandId);
    }
  }
  const data = await httpPost('/connect', { executedIds, pendingIds });
  if (data) {
    await handleReconcileResponse(data);
  }
}

// ─── Poll loop (T22: transient-retry ladder) ────────────────────────────────
// On any non-Abort/non-Timeout error (network blip, daemon restart, dropped
// TCP), retry with exponential backoff + jitter rather than yielding to the
// keepalive alarm immediately. After MAX_ATTEMPTS, yield so the alarm
// (≤60 s) is the upper-bound recovery time. The success-after-retry path
// emits `pollloop_recovered` with `attempts > 0` — observable in
// `~/.safari-pilot/daemon-trace.ndjson`. Do NOT add this trace emission to
// the alarm-rearm path: T22's e2e test discriminates the retry-vs-alarm
// recovery paths specifically by asserting on `pollloop_recovered` with
// `attempts > 0`. An alarm-rearm always restarts pollLoop with attempts=0.
async function pollLoop(abortSignal) {
  // 0 + 250 + 500 + 1000 + 2000 = 3750 ms total wait; with ~1 s daemon cold
  // start the post-fix recovery comfortably fits inside the test's 10 s
  // budget. Dropping a tail tier vs. the original 6-tier plan was a
  // test-reviewer recommendation to preserve budget margin.
  const BACKOFF_MS = [0, 250, 500, 1000, 2000];
  const MAX_ATTEMPTS = 5;
  let attempts = 0;
  // T60: honor the abort signal threaded from pollLoopController so a fresh
  // alarm wake can forcibly stop a prior pollLoop instance — even one whose
  // fetch is wedged from event-page suspension recovery.
  while (!(abortSignal && abortSignal.aborted)) {
    try {
      const data = await httpPoll(abortSignal);
      if (attempts > 0) {
        emitTrace('__pollloop__', 'pollloop_recovered', { attempts });
        attempts = 0;
      }
      if (data && data.commands) {
        for (const cmd of data.commands) {
          const result = await executeCommand(cmd);
          postResult(cmd.id, result);
        }
      }
    } catch (err) {
      // AbortError = clean cancel from another path (test teardown OR T60
      // alarm-driven supersede via pollLoopController.abort()).
      if (err.name === 'AbortError') {
        emitTrace('__pollloop__', 'pollloop_aborted', { reason: 'abort_signal' });
        return;
      }
      // TimeoutError = the per-fetch 10 s timeout fired with no command —
      // this is the NORMAL idle case (the daemon long-polls up to 5 s).
      // Pre-T22 this killed the loop, requiring an alarm to re-arm: bug.
      if (err.name === 'TimeoutError') {
        attempts = 0;
        continue;
      }
      attempts++;
      if (attempts > MAX_ATTEMPTS) {
        emitTrace('__pollloop__', 'pollloop_yield_to_alarm', { attempts, errName: err?.name, errMessage: err?.message });
        console.warn('[safari-pilot] pollLoop yielding to alarm after retries:', err?.name, err?.message);
        return;
      }
      const baseMs = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
      const jitter = Math.random() * 250;
      await new Promise((r) => setTimeout(r, baseMs + jitter));
    }
  }
  emitTrace('__pollloop__', 'pollloop_aborted', { reason: 'signal_aborted_pre_iter' });
}

// T60: idempotent supersede. Aborts any prior pollLoop instance (releasing
// stuck fetches) and starts a fresh one with a new AbortController. The
// previous loop returns via its AbortError catch; this one runs free.
function supersedePollLoop(reason) {
  if (pollLoopController) {
    try { pollLoopController.abort(); } catch { /* ignore */ }
  }
  const controller = new AbortController();
  pollLoopController = controller;
  emitTrace('__pollloop__', 'pollloop_started', { reason });
  pollLoop(controller.signal).catch((e) => {
    emitTrace('__pollloop__', 'pollloop_crashed', { errName: e?.name, errMessage: e?.message });
  });
}

// ─── Wake sequence (HTTP) ───────────────────────────────────────────────────
// T60: wakeSequence runs the BOUNDED setup phase only — tab cache load,
// storage GC, stale storage-bus cleanup, /connect + reconcile. It does NOT
// call pollLoop. pollLoop is started by initialize() AFTER this returns,
// outside the wake-setup lock, via supersedePollLoop(). Pre-T60 the lock
// wrapped pollLoop, so any forever-pending fetch inside pollLoop kept
// isWakeRunning=true permanently and made all subsequent alarm wakes no-ops.
async function wakeSequence(reason) {
  try {
    await loadTabCache();
    await gcPendingStorage();
    await cleanupStaleStorageBus();
    await connectAndReconcile();
  } catch (e) {
    emitTrace('__wake__', 'wake_setup_error', { errName: e?.name, errMessage: e?.message });
    console.warn('[safari-pilot] wakeSequence error:', e.message);
  }
}

async function initialize(reason) {
  if (isWakeRunning) {
    // T60 diagnostic: when alarm fires while a prior setup is still in
    // flight, the new wake is coalesced. With the T60 fix, pollLoop no
    // longer holds the lock, so this should only fire during legitimate
    // overlapping setup (rare). If you see this every alarm cycle without
    // a corresponding setup_completed, the bug returned at a different layer.
    emitTrace('__init__', 'init_coalesced', { reason });
    wakePending = true;
    return;
  }
  isWakeRunning = true;
  emitTrace('__init__', 'init_proceeding', { reason });
  try {
    // Verify keepalive alarm exists — recreate if cleared by update/restart/bug
    const alarms = await browser.alarms.getAll();
    if (!alarms.some(a => a.name === KEEPALIVE_ALARM_NAME)) {
      browser.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
    }
    await wakeSequence(reason);
    while (wakePending) {
      wakePending = false;
      await wakeSequence('coalesced');
    }
    emitTrace('__init__', 'setup_completed', { reason });
  } finally {
    isWakeRunning = false;
  }
  // T60: pollLoop is supervised OUTSIDE the wake-setup lock. Each alarm
  // wake supersedes the prior pollLoop — aborting its (possibly wedged)
  // fetch and starting a fresh one. This is the architectural fix for
  // pre-T60 dormancy where a suspended fetch held isWakeRunning hostage.
  supersedePollLoop(reason);
}

// ─── Top-level listener registration ─────────────────────────────────────────
if (!listenersAttached) {
  listenersAttached = true;

  browser.runtime.onStartup.addListener(() => { initialize('onStartup'); });
  browser.runtime.onInstalled.addListener(() => { initialize('onInstalled'); });

  // Clear-then-create ensures the alarm is recreated even after extension updates
  // (Safari may silently clear alarms during version transitions).
  browser.alarms.clear(KEEPALIVE_ALARM_NAME).finally(() => {
    browser.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM_NAME) return;
    // Report alarm fire to daemon for health telemetry
    emitTrace('alarm', 'alarm_fire', {});
    // Wake sequence handles connect + poll loop via HTTP IPC.
    initialize('keepalive');
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Storage bus: content scripts request their own tabId on load.
    // sender.tab.id is provided by Safari's extension API — does NOT
    // depend on the broken tabs.query IPC.
    if (message?.action === 'sp_getTabId') {
      sendResponse({ tabId: sender.tab?.id ?? null });
      return false;
    }
    // T55a: content-isolated.js calls this lazily on first sp_cmd_* arrival.
    // sender.frameId is the authoritative answer — 0 = top frame, > 0 = iframe.
    // frameId is stable for the life of the frame (across SPA navigations).
    if (message?.action === 'sp_getFrameId') {
      sendResponse({ frameId: sender.frameId ?? null });
      return false;
    }
    // T55a: best-effort fast-fail signal from a frame's pagehide listener.
    // If the message lands before reload finishes, callers waiting on
    // in-flight commands targeting this frameId can short-circuit. v1
    // minimum: log + return ok. Future iterations may use this to
    // proactively resolve pending listeners with FRAME_NAVIGATED. The
    // frameUrl mutation guard in content-isolated.js + webNavigation
    // revalidation on the next call are the safety nets.
    if (message?.action === 'sp_frame_unloading') {
      emitTrace('frame', 'frame_unloading', {
        tabId: sender?.tab?.id ?? null,
        frameId: message.frameId ?? null,
      });
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'ping') {
      sendResponse({ ok: true, type: 'pong', extensionVersion: EXTENSION_VERSION });
      return false;
    }
    if (message?.type === 'keepalive') {
      emitTrace('session', 'keepalive_received', {});
      httpPost('/result', {
        requestId: '__keepalive__',
        result: { type: 'keepalive', ts: Date.now() }
      }).catch(() => {});
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'session_start' || message?.type === 'session_end') {
      initialize(message.type);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'SAFARI_PILOT_COMMAND') {
      handleCommand(message, sender).then(sendResponse);
      return true;
    }
    // T21: SPA URL change relayed from content-isolated.js. Top-frame only —
    // a child frame's pushState would otherwise clobber the top-level tab URL.
    if (message?.type === 'sp_url_changed' && typeof message.url === 'string') {
      if (sender?.frameId !== 0) {
        sendResponse({ ok: true, ignored: 'non_top_frame' });
        return false;
      }
      const tabId = sender?.tab?.id;
      if (tabId == null) {
        sendResponse({ ok: false, error: { message: 'no sender.tab.id' } });
        return false;
      }
      const existing = tabCacheMap.get(tabId) || { url: '', title: '' };
      tabCacheMap.set(tabId, { url: message.url, title: existing.title });
      saveTabCache().catch(() => {});
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
}

/*@DEBUG_HARNESS_BEGIN@*/
// Test-only: allows e2e to simulate event-page unload on demand.
// Stripped from release builds by scripts/build-extension.sh.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === '__safari_pilot_test_force_unload__') {
    // browser.runtime.reload() reinstalls the extension — simulates a fresh cold-wake.
    sendResponse({ ok: true });
    setTimeout(() => browser.runtime.reload(), 50);
    return false;
  }
  return false;
});

// Test-only: dispatcher for the `__SP_TEST_HARNESS__:` bridge in
// content-isolated.js. Executes state mutations that aren't reachable from
// the isolated world (tabCacheMap is module-local to background.js).
// Stripped from release builds.
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== '__sp_test__') return false;
  const op = message.op || {};
  (async () => {
    try {
      if (op.action === 'setStorageFlag') {
        // Note: setting `sp_cmd_<id>` / `sp_result_<id>` directly via this action
        // will be wiped by `executeCommand`'s post-success cleanup before
        // any subsequent test observation can land. For T44's poison
        // verification, use `forceUnloadWithPoison` instead — it plants
        // the poison atomically after the bridge call's cleanup completes.
        await browser.storage.local.set({ [op.key]: op.value });
        sendResponse({ ok: true, value: { set: op.key } });
      } else if (op.action === 'removeStorageFlag') {
        await browser.storage.local.remove(op.key);
        sendResponse({ ok: true, value: { removed: op.key } });
      } else if (op.action === 'clearTabCache') {
        tabCacheMap.clear();
        await browser.storage.local.remove(STORAGE_KEY_TAB_CACHE);
        sendResponse({ ok: true, value: { cleared: 'tabCacheMap+storage' } });
      } else if (op.action === 'getStorage') {
        const stored = await browser.storage.local.get(op.key);
        sendResponse({ ok: true, value: { key: op.key, value: stored[op.key] ?? null } });
      } else if (op.action === 'forceUnload') {
        // Acknowledge before reloading — the response must flush before the
        // runtime tears down. Same pattern as the existing
        // __safari_pilot_test_force_unload__ handler.
        sendResponse({ ok: true, value: 'unload_requested' });
        setTimeout(() => browser.runtime.reload(), 50);
        return;
      } else if (op.action === 'injectNextPollFailure') {
        // Arms a one-shot fetch-failure injection in the next httpPoll
        // iteration. Used by T22's e2e to verify pollLoop's retry ladder
        // without daemon kickstart (which has shown to deadlock the
        // daemon process under concurrent test load — separate
        // production bug, tracked elsewhere).
        globalThis.__sp_test_inject_next_poll_failure = true;
        sendResponse({ ok: true, value: { armed: true } });
      } else if (op.action === 'forceUnloadWithPoison') {
        // Atomic plant-and-unload for T44's e2e verification. The bridge
        // architecture itself uses `sp_cmd_<id>`/`sp_result_<id>`, and
        // `executeCommand` cleanup wipes both post-success — so a separate
        // setStorageFlag → forceUnload sequence would have its poison
        // wiped before reload. This single action:
        //   T+0   : ack + return (bridge response flushes through normal path)
        //   T+~50 : bridge content-isolated writes its own sp_result_<id>, bg's
        //           resultListener resolves, `executeCommand` cleanup wipes
        //           sp_cmd_<id>/sp_result_<id>. State is null.
        //   T+250 : timer fires — plants the poison into sp_cmd_<id>/sp_result_<id>.
        //   T+350 : reload. wakeSequence → cleanupStaleStorageBus runs on
        //           the poison; production fix (T44) removes it; pre-fix
        //           the poison persists.
        // Test waits ~5 s for reload + reconcile, then reads back via
        // `getStorage`. Discriminator: pre-fix sees the poison, post-fix
        // sees null.
        // Note: response wrapped in an object — handleEvaluate's harness
        // path JSON.parses the result, and a bare string 'foo' would
        // fail to parse. Object survives JSON.stringify→parse roundtrip.
        sendResponse({ ok: true, value: { scheduled: true, action: 'poison_and_unload' } });
        setTimeout(async () => {
          try {
            // T55a: storage bus migrated to commandId-keyed slots. Caller's poison op
            // must include `op.poison.commandId` so writes land in the correct slot.
            // Pre-T55a callers that omit commandId fall back to a literal 'unknown'
            // suffix — preserves test compatibility for tests that don't care about
            // exact key match (poison detection itself is the assertion).
            const poisonCommandId = op.poison?.commandId ?? 'unknown';
            const writes = {};
            if (op.poison?.sp_result) writes['sp_result_' + poisonCommandId] = op.poison.sp_result;
            if (op.poison?.sp_cmd) writes['sp_cmd_' + poisonCommandId] = op.poison.sp_cmd;
            if (Object.keys(writes).length > 0) {
              await browser.storage.local.set(writes);
            }
          } catch (e) {
            console.warn('[safari-pilot test-harness] poison plant failed:', e?.message);
          }
          setTimeout(() => browser.runtime.reload(), 100);
        }, 250);
        return;
      } else {
        sendResponse({ ok: false, error: { name: 'TEST_HARNESS_UNKNOWN_ACTION', message: `unknown action: ${op.action}` } });
      }
    } catch (e) {
      sendResponse({ ok: false, error: { name: 'TEST_HARNESS_ERROR', message: e?.message ?? String(e) } });
    }
  })();
  return true; // async sendResponse
});
/*@DEBUG_HARNESS_END@*/

// First-run initialization for this event-page load cycle.
initialize('script_load');
