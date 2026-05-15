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
// T73: timestamp of the last successful httpPoll resolution. Updated inside
// pollLoop's success try-block, read by supersedePollLoop to skip the abort
// cascade when the prior pollLoop is healthy. Default 0 → first supersede
// after extension load always runs (correct: there's nothing to be healthy
// about yet).
let lastSuccessfulPoll = 0;

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

// T79: clear tab-scoped selectorPack storage on tab close. Keys live under
// prefix `sp_pack_<tabId>_<name>`. Multiple listeners can be added to the
// same event; this one runs independently of the tab-cache listener above.
browser.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const all = await browser.storage.local.get(null);
    const toRemove = Object.keys(all).filter((k) => k.startsWith('sp_pack_' + tabId + '_'));
    if (toRemove.length > 0) {
      await browser.storage.local.remove(toRemove);
      emitTrace('__cleanup__', 'selector_pack_cleared', { layer: 'extension-bg', data: { tabId, count: toRemove.length } });
    }
  } catch (e) {
    emitTrace('__cleanup__', 'selector_pack_clear_failed', { layer: 'extension-bg', data: { tabId, error: e && e.message ? e.message : String(e) } });
  }
});

// T79 Cluster D: re-inject persisted packs into window.__sp_pack on every
// completed navigation. Runs purely from the extension-bg context — no MCP
// command involved. Reads sp_pack_<tabId>_<name> keys and re-injects each
// via the same storage-bus execute_script flow used everywhere else.
browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  let stored;
  try {
    stored = await browser.storage.local.get(null);
  } catch (e) {
    emitTrace('__rehydrate__', 'pack_rehydrate_storage_get_failed', { layer: 'extension-bg', data: { tabId, error: e && e.message ? e.message : String(e) } });
    return;
  }
  const prefix = 'sp_pack_' + tabId + '_';
  const keys = Object.keys(stored).filter((k) => k.startsWith(prefix));
  if (keys.length === 0) return;
  for (const key of keys) {
    const name = key.slice(prefix.length);
    const body = stored[key];
    if (typeof body !== 'string' || !body) continue;
    const injectionScript =
      'window.__sp_pack=window.__sp_pack||{};' +
      'try{' +
        'window.__sp_pack[' + JSON.stringify(name) + ']=new Function(\'root\',\'arg\',' + JSON.stringify(body) + ');' +
        'return JSON.stringify({ok:true,rehydrated:true});' +
      '}catch(e){' +
        'return JSON.stringify({ok:false,error:e&&e.message?e.message:String(e)});' +
      '}';
    const rehydrateCmdId = '__rehydrate_' + tabId + '_' + name + '_' + Date.now();
    const cmdKey = 'sp_cmd_' + rehydrateCmdId;
    const storageCmd = {
      commandId: rehydrateCmdId,
      tabId,
      method: 'execute_script',
      params: { script: injectionScript, commandId: rehydrateCmdId },
      timestamp: Date.now(),
      deadline: Date.now() + 5000,
    };
    try {
      await browser.storage.local.set({ [cmdKey]: storageCmd });
      emitTrace(rehydrateCmdId, 'pack_rehydrated', { layer: 'extension-bg', data: { tabId, name } });
      // Fire-and-forget — content-isolated picks it up, runs the injection.
      // Cleanup the cmd key after a short delay to keep storage lean.
      setTimeout(() => { browser.storage.local.remove([cmdKey, 'sp_result_' + rehydrateCmdId]).catch(() => {}); }, 6000);
    } catch (e) {
      emitTrace(rehydrateCmdId, 'pack_rehydrate_failed', { layer: 'extension-bg', data: { tabId, name, error: e && e.message ? e.message : String(e) } });
    }
  }
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
  // T67: quota recovery mirrors saveTabCache (line 43-58). Pre-T67 a quota
  // throw escaped to every caller (gcPendingStorage, removePendingEntry,
  // updatePendingEntry) and aborted their flows, leaving the extension
  // wedged with isConnected=false until storage was manually cleared.
  try {
    await browser.storage.local.set({ [STORAGE_KEY_PENDING]: pending });
  } catch (e) {
    if (e?.message?.includes?.('quota')) {
      await browser.storage.local.remove([STORAGE_KEY_PENDING]).catch(() => {});
      try {
        await browser.storage.local.set({ [STORAGE_KEY_PENDING]: pending });
      } catch {
        // Second failure: storage is in a worse state than quota alone.
        // Swallow so callers stay alive; in-memory state is unaffected.
      }
    } else {
      throw e;
    }
  }
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

// v0.1.36 Track A Fix 3 — content-script readiness map (inlined from
// extension/lib/cs-readiness.js; tested in test/unit/extension/
// cs-readiness.test.ts). Content scripts write a heartbeat to
// `sp_cs_ready_<tabId>` on load; we mirror it into spCsReadyMap and use
// it to choose between a fast-fail (5s) vs. normal (30s) storage-bus
// timeout. Without this, dispatching to a freshly opened/navigated tab
// blocks the full 30s before the agent can recover.
const SP_CS_READY_MAX_AGE_MS = 60_000;
const SP_CS_NOT_READY_FAST_FAIL_MS = 10_000;
const spCsReadyMap = new Map();
function spRecordCsReady(tabId, now) { spCsReadyMap.set(tabId, { timestamp: now }); }
function spIsCsReady(tabId, now, maxAgeMs) {
  const entry = spCsReadyMap.get(tabId);
  if (!entry) return false;
  return (now - entry.timestamp) <= (maxAgeMs ?? SP_CS_READY_MAX_AGE_MS);
}
function spDecideStorageBusTimeout(tabId, now, callerDefaultMs) {
  if (spIsCsReady(tabId, now)) {
    return { timeoutMs: callerDefaultMs, reason: 'cs_ready' };
  }
  return {
    timeoutMs: Math.min(callerDefaultMs, SP_CS_NOT_READY_FAST_FAIL_MS),
    reason: 'cs_not_ready',
  };
}
// Storage listener: mirror `sp_cs_ready_<tabId>` keys into the in-memory map.
// Content-isolated.js writes one on load; on navigation, the new content
// script writes a fresh timestamp, refreshing the readiness window.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const k of Object.keys(changes)) {
    if (!k.startsWith('sp_cs_ready_')) continue;
    const tabId = parseInt(k.slice('sp_cs_ready_'.length), 10);
    const nv = changes[k].newValue;
    if (!Number.isFinite(tabId)) continue;
    if (nv && typeof nv.ts === 'number') spRecordCsReady(tabId, nv.ts);
    if (nv === undefined || nv === null) spCsReadyMap.delete(tabId);
  }
});
// Cleanup readiness state when a tab closes.
browser.tabs.onRemoved.addListener((tabId) => {
  spCsReadyMap.delete(tabId);
  try { browser.storage.local.remove('sp_cs_ready_' + tabId).catch(() => {}); } catch { /* shrug */ }
});
// Rehydrate readiness map from storage on event-page startup. MV3 wakes the
// event page repeatedly — any heartbeats written while it was asleep would be
// invisible to the in-memory map without this scan.
(async () => {
  try {
    const stored = await browser.storage.local.get(null);
    for (const k of Object.keys(stored)) {
      if (!k.startsWith('sp_cs_ready_')) continue;
      const tabId = parseInt(k.slice('sp_cs_ready_'.length), 10);
      const v = stored[k];
      if (!Number.isFinite(tabId)) continue;
      if (v && typeof v.ts === 'number') spRecordCsReady(tabId, v.ts);
    }
  } catch { /* storage transiently unavailable — gate falls back to fast-fail */ }
})();
// On navigation completion, prior heartbeat is stale: a new content script
// will load and post a fresh one. We DON'T evict eagerly here — we let the
// fresh write overwrite, and the max-age window covers the rare gap.

// v0.1.36 Track A Fix 1 — tolerant URL matcher (inlined from
// extension/lib/tab-url-matcher.js; tested in test/unit/extension/
// tab-url-matcher.test.ts). MV3 background can't import ES modules, so the
// implementation is duplicated here. Keep behaviour in sync with the lib.
const SP_TRACKING_PARAM_PREFIXES = ['utm_'];
const SP_TRACKING_PARAM_EXACT = new Set([
  'gclid', 'fbclid', 'msclkid', 'mc_eid', 'mc_cid',
  'ref', 'referrer', 'source', 'campaign',
  '_ga', '_gl', 'igshid', 'yclid', 'twclid', 'dclid',
]);
function spStripTrailingSlash(s) { return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s; }
function spNormalizeForMatch(url) {
  if (typeof url !== 'string' || url.length === 0) return url || '';
  let u;
  try { u = new URL(url); } catch { return spStripTrailingSlash(url); }
  const scheme = u.protocol.toLowerCase();
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    const lk = k.toLowerCase();
    if (SP_TRACKING_PARAM_EXACT.has(lk)) continue;
    if (SP_TRACKING_PARAM_PREFIXES.some((p) => lk.startsWith(p))) continue;
    params.append(k, v);
  }
  const queryStr = params.toString();
  const port = u.port ? ':' + u.port : '';
  const path = spStripTrailingSlash(u.pathname || '/');
  return `${scheme}//${host}${port}${path}${queryStr ? '?' + queryStr : ''}`;
}
function spOriginAndPath(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return {
      origin: `${u.protocol.toLowerCase()}//${host}${u.port ? ':' + u.port : ''}`,
      path: spStripTrailingSlash(u.pathname || '/'),
    };
  } catch { return null; }
}
function spPathIsPrefix(requestedPath, candidatePath) {
  if (candidatePath === requestedPath) return true;
  if (!candidatePath.startsWith(requestedPath)) return false;
  return candidatePath.charAt(requestedPath.length) === '/';
}
/** Returns the matched candidate's id (whatever the caller passes in `id`),
 *  or null if no tier matches. Candidates: Array<{id, url}>. */
function spMatchTabUrl(requestedUrl, candidates) {
  if (typeof requestedUrl !== 'string' || requestedUrl.length === 0) return null;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  // Tier 0 — exact (trailing-slash tolerant).
  const targetExact = spStripTrailingSlash(requestedUrl);
  for (const c of candidates) {
    if (spStripTrailingSlash(c.url || '') === targetExact) return c.id;
  }
  // Tier 1 — normalized.
  const targetNorm = spNormalizeForMatch(requestedUrl);
  for (const c of candidates) {
    if (spNormalizeForMatch(c.url || '') === targetNorm) return c.id;
  }
  // Tier 2 — origin + path-prefix (longest unambiguous).
  const reqOriginPath = spOriginAndPath(requestedUrl);
  if (!reqOriginPath) return null;
  let bestId = null;
  let bestLen = -1;
  let bestCount = 0;
  for (const c of candidates) {
    const cop = spOriginAndPath(c.url || '');
    if (!cop) continue;
    if (cop.origin !== reqOriginPath.origin) continue;
    if (!spPathIsPrefix(reqOriginPath.path, cop.path)) continue;
    if (cop.path.length > bestLen) {
      bestLen = cop.path.length; bestId = c.id; bestCount = 1;
    } else if (cop.path.length === bestLen) {
      bestCount += 1;
    }
  }
  return bestId !== null && bestCount === 1 ? bestId : null;
}

async function findTargetTab(tabUrl) {
  if (tabUrl) {
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
      // Primary: browser.tabs.query, run through the 3-tier matcher so SPA
      // URL drift / www-prefix / tracking-params don't trigger TAB_NOT_FOUND.
      const all = await browser.tabs.query({});
      if (all.length > 0) {
        const matchedId = spMatchTabUrl(tabUrl, all.map((t) => ({ id: t.id, url: t.url || '' })));
        if (matchedId != null) {
          const t = all.find((x) => x.id === matchedId);
          if (t) return t;
        }
      }
    }

    // Fallback: persistent tab cache (works when tabs.query returns [] in
    // alarm-triggered wake context — Safari event page lifecycle limitation).
    if (tabCacheMap.size > 0) {
      const cacheList = [];
      for (const [tabId, info] of tabCacheMap) {
        cacheList.push({ id: tabId, url: info.url || '' });
      }
      const matchedId = spMatchTabUrl(tabUrl, cacheList);
      if (matchedId != null) {
        const info = tabCacheMap.get(matchedId);
        return { id: matchedId, url: info.url, title: info.title };
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
    //
    // v0.1.36 Fix 1: enrich the error with the closest same-origin
    // candidate URL so the agent can update its stored tabUrl on retry.
    // (Tier 2 matching already covers most drift cases; this branch only
    //  fires when even the path-prefix tier missed — e.g. agent's URL is
    //  on origin X but the only X-origin tab is at an unrelated path.)
    let hint = '';
    if (cmd.tabUrl) {
      try {
        const u = new URL(cmd.tabUrl);
        const reqOrigin = u.protocol + '//' + u.hostname.replace(/^www\./, '');
        const seen = new Set();
        const sameOriginUrls = [];
        for (const [, info] of tabCacheMap) {
          if (!info.url) continue;
          try {
            const cu = new URL(info.url);
            const co = cu.protocol + '//' + cu.hostname.replace(/^www\./, '');
            if (co === reqOrigin && !seen.has(info.url)) {
              seen.add(info.url);
              sameOriginUrls.push(info.url);
            }
          } catch { /* skip unparsable */ }
        }
        if (sameOriginUrls.length > 0) {
          hint = ` Same-origin tabs in cache: ${sameOriginUrls.slice(0, 3).join(', ')}. Update tabUrl in subsequent calls.`;
        }
      } catch { /* unparsable requested URL — no hint */ }
    }
    const error = cmd.tabUrl
      ? { name: 'TAB_NOT_FOUND', message: `No agent-owned tab matches url="${cmd.tabUrl}" (extension cache miss).${hint}` }
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

  // 5A.9: DNR sentinels — bypass storage bus, call browser.declarativeNetRequest
  // directly via the existing dnr handlers. Used by safari_authenticate to inject
  // Authorization: Basic <b64> headers (HTTP basic auth parity with Playwright).
  if (typeof cmd.script === 'string' && cmd.script.startsWith('__SP_DNR_')) {
    const colonIdx = cmd.script.indexOf(':');
    const sentinel = colonIdx > 0 ? cmd.script.slice(0, colonIdx) : cmd.script;
    let parsed = {};
    if (colonIdx > 0) {
      try { parsed = JSON.parse(cmd.script.slice(colonIdx + 1)); }
      catch (e) {
        const result = { ok: false, error: { name: 'DNR_PARAM_PARSE', message: `Failed to parse DNR params: ${e?.message ?? String(e)}` } };
        await updatePendingEntry(commandId, { status: 'completed', result });
        return result;
      }
    }
    let result;
    try {
      let dnrResult;
      if (sentinel === '__SP_DNR_ADD_RULE__') dnrResult = await handleDnrAddRule(parsed);
      else if (sentinel === '__SP_DNR_REMOVE_RULE__') dnrResult = await handleDnrRemoveRule(parsed);
      else {
        const r = { ok: false, error: { name: 'UNKNOWN_DNR_SENTINEL', message: `Unknown DNR sentinel: ${sentinel}` } };
        await updatePendingEntry(commandId, { status: 'completed', result: r });
        return r;
      }
      result = { ok: true, value: JSON.stringify(dnrResult.value ?? null) };
    } catch (e) {
      result = { ok: false, error: { name: 'DNR_API_ERROR', message: e?.message ?? String(e) } };
    }
    await updatePendingEntry(commandId, { status: 'completed', result });
    return result;
  }

  // safari_take_screenshot — capture the visible viewport of the target tab
  // via browser.tabs.captureVisibleTab. Triggered by the __SP_TAKE_SCREENSHOT__
  // sentinel from src/tools/extraction.ts. Briefly activates target tab in its
  // window (no Safari app activation), captures, restores prior active tab.
  if (cmd.script === '__SP_TAKE_SCREENSHOT__') {
    let prevActiveTabId = null;
    try {
      if (tab.windowId == null) {
        throw { name: 'WINDOW_CLOSED', message: 'tab.windowId missing' };
      }

      // Snapshot the previous active tab so we can restore it.
      const prevActive = await browser.tabs.query({ windowId: tab.windowId, active: true });
      prevActiveTabId = prevActive[0]?.id ?? null;

      // Activate the target tab if it isn't already active. tabs.update resolves
      // before Safari's internal active-tab state settles, so we verify by
      // polling tabs.query before the capture (TOCTOU narrows but doesn't close).
      if (prevActiveTabId !== tab.id) {
        await browser.tabs.update(tab.id, { active: true });
        let activated = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          await new Promise((r) => setTimeout(r, 40));
          const check = await browser.tabs.query({ windowId: tab.windowId, active: true });
          if (check[0]?.id === tab.id) { activated = true; break; }
        }
        if (!activated) {
          throw { name: 'CAPTURE_RACE', message: 'target tab did not become active within 200ms' };
        }
      }

      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const commaIdx = dataUrl.indexOf(',');
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;

      const result = { ok: true, value: base64 };
      await updatePendingEntry(commandId, { status: 'completed', result });
      return result;
    } catch (e) {
      const errName = e?.name && typeof e.name === 'string' ? e.name : 'CAPTURE_FAILED';
      const result = { ok: false, error: { name: errName, message: e?.message ?? String(e) } };
      await updatePendingEntry(commandId, { status: 'completed', result });
      return result;
    } finally {
      if (prevActiveTabId != null && prevActiveTabId !== tab.id) {
        try { await browser.tabs.update(prevActiveTabId, { active: true }); } catch { /* tab may have closed */ }
      }
    }
  }

  // 5A.1 phase-0: file upload probe sentinel — dispatched via the storage bus
  // to content-isolated.js (Test A: content-script fetch; Test B: File structured-
  // clone). Unlike cookie/DNR sentinels (which execute entirely in background.js),
  // this MUST reach the content script. We write a standard storage-bus command
  // and wait for the result using the same resultListener machinery below.
  // Placed AFTER findTargetTab/tab-null-check and AFTER list_frames/DNR/cookie
  // sentinels, and BEFORE frame validation (probe is top-frame, no frameId).
  if (typeof cmd.script === 'string' && cmd.script.startsWith('__SP_FILE_UPLOAD_PROBE_TEST__')) {
    const cmdKey = 'sp_cmd_' + commandId;
    const resultKey = 'sp_result_' + commandId;
    const PROBE_TIMEOUT_MS = 15000;
    const probeStorageCmd = {
      commandId,
      tabId: tab.id,
      method: 'execute_script',
      params: { script: cmd.script, commandId },
      timestamp: Date.now(),
      deadline: Date.now() + PROBE_TIMEOUT_MS,
    };
    let probeResultResolver;
    const probeResultPromise = new Promise((resolve) => {
      probeResultResolver = resolve;
    });
    const probeKeepAlive = setInterval(() => {
      fetch(`${HTTP_URL}/poll`, { signal: AbortSignal.timeout(1000) }).catch(() => {});
    }, 10000);
    const probeTimeout = setTimeout(() => {
      clearInterval(probeKeepAlive);
      browser.storage.onChanged.removeListener(probeResultListener);
      probeResultResolver({ ok: false, error: { name: 'PROBE_TIMEOUT', message: `File upload probe timeout (${PROBE_TIMEOUT_MS}ms)` } });
    }, PROBE_TIMEOUT_MS);
    function probeResultListener(changes, area) {
      if (area !== 'local' || !changes[resultKey]?.newValue) return;
      const reply = changes[resultKey].newValue;
      if (reply.commandId !== commandId) return;
      clearInterval(probeKeepAlive);
      clearTimeout(probeTimeout);
      browser.storage.onChanged.removeListener(probeResultListener);
      probeResultResolver(reply.result);
    }
    browser.storage.onChanged.addListener(probeResultListener);
    await browser.storage.local.set({ [cmdKey]: probeStorageCmd });
    const probeResult = await probeResultPromise;
    try { await browser.storage.local.remove([cmdKey, resultKey]); } catch { /* ignore */ }
    await updatePendingEntry(commandId, { status: 'completed', result: probeResult });
    return probeResult;
  }

  // 5A.1 file_upload probe sentinel — locator-only, ~1KB payload.
  // Routes via storage bus to content-isolated.js, which validates
  // element type without staging any bytes.
  if (typeof cmd.script === 'string' && cmd.script.startsWith('__SP_FILE_UPLOAD_PROBE__:')) {
    const cmdKey = 'sp_cmd_' + commandId;
    const resultKey = 'sp_result_' + commandId;
    const FILE_UPLOAD_PROBE_TIMEOUT_MS = 30000;
    const probeStorageCmd = {
      commandId,
      tabId: tab.id,
      method: 'execute_script',
      params: { script: cmd.script, commandId },
      timestamp: Date.now(),
      deadline: Date.now() + FILE_UPLOAD_PROBE_TIMEOUT_MS,
    };
    let probeResultResolver;
    const probeResultPromise = new Promise((resolve) => {
      probeResultResolver = resolve;
    });
    const probeKeepAlive = setInterval(() => {
      fetch(`${HTTP_URL}/poll`, { signal: AbortSignal.timeout(1000) }).catch(() => {});
    }, 10000);
    const probeTimeout = setTimeout(() => {
      clearInterval(probeKeepAlive);
      browser.storage.onChanged.removeListener(probeResultListener);
      probeResultResolver({ ok: false, error: { name: 'FILE_UPLOAD_PROBE_TIMEOUT', message: `probe timeout (${FILE_UPLOAD_PROBE_TIMEOUT_MS}ms)` } });
    }, FILE_UPLOAD_PROBE_TIMEOUT_MS);
    function probeResultListener(changes, area) {
      if (area !== 'local' || !changes[resultKey]?.newValue) return;
      const reply = changes[resultKey].newValue;
      if (reply.commandId !== commandId) return;
      clearInterval(probeKeepAlive);
      clearTimeout(probeTimeout);
      browser.storage.onChanged.removeListener(probeResultListener);
      probeResultResolver(reply.result);
    }
    browser.storage.onChanged.addListener(probeResultListener);
    await browser.storage.local.set({ [cmdKey]: probeStorageCmd });
    const probeResult = await probeResultPromise;
    try { await browser.storage.local.remove([cmdKey, resultKey]); } catch { /* ignore */ }
    await updatePendingEntry(commandId, { status: 'completed', result: probeResult });
    return probeResult;
  }

  // 5A.1 file_upload final sentinel — token list + locator + clear + probeOpts.
  // content-isolated.js fetches bytes from /file-bytes/<token>, builds Files,
  // postMessages to MAIN for DataTransfer injection, then DELETEs the bytes.
  if (typeof cmd.script === 'string' && cmd.script.startsWith('__SP_FILE_UPLOAD__:')) {
    const cmdKey = 'sp_cmd_' + commandId;
    const resultKey = 'sp_result_' + commandId;
    const FILE_UPLOAD_TIMEOUT_MS = 30000;
    const uploadStorageCmd = {
      commandId,
      tabId: tab.id,
      method: 'execute_script',
      params: { script: cmd.script, commandId },
      timestamp: Date.now(),
      deadline: Date.now() + FILE_UPLOAD_TIMEOUT_MS,
    };
    let uploadResultResolver;
    const uploadResultPromise = new Promise((resolve) => {
      uploadResultResolver = resolve;
    });
    const uploadKeepAlive = setInterval(() => {
      fetch(`${HTTP_URL}/poll`, { signal: AbortSignal.timeout(1000) }).catch(() => {});
    }, 10000);
    const uploadTimeout = setTimeout(() => {
      clearInterval(uploadKeepAlive);
      browser.storage.onChanged.removeListener(uploadResultListener);
      uploadResultResolver({ ok: false, error: { name: 'FILE_UPLOAD_TIMEOUT', message: `upload timeout (${FILE_UPLOAD_TIMEOUT_MS}ms)` } });
    }, FILE_UPLOAD_TIMEOUT_MS);
    function uploadResultListener(changes, area) {
      if (area !== 'local' || !changes[resultKey]?.newValue) return;
      const reply = changes[resultKey].newValue;
      if (reply.commandId !== commandId) return;
      clearInterval(uploadKeepAlive);
      clearTimeout(uploadTimeout);
      browser.storage.onChanged.removeListener(uploadResultListener);
      uploadResultResolver(reply.result);
    }
    browser.storage.onChanged.addListener(uploadResultListener);
    await browser.storage.local.set({ [cmdKey]: uploadStorageCmd });
    const uploadResult = await uploadResultPromise;
    try { await browser.storage.local.remove([cmdKey, resultKey]); } catch { /* ignore */ }
    await updatePendingEntry(commandId, { status: 'completed', result: uploadResult });
    return uploadResult;
  }

  // 5A.8: cookie sentinels — bypass storage bus, call browser.cookies directly.
  // Format: __SP_COOKIE_<OP>__:<json-params>. The JS path cannot see/set
  // httpOnly cookies; this routes through the extension API which can.
  // Placed AFTER findTargetTab (need a valid tab context for the call site,
  // even though browser.cookies operates on URL not tab) and BEFORE frame
  // validation (cookie ops are tab-scoped, not frame-scoped).
  if (typeof cmd.script === 'string' && cmd.script.startsWith('__SP_COOKIE_')) {
    const colonIdx = cmd.script.indexOf(':');
    const sentinel = colonIdx > 0 ? cmd.script.slice(0, colonIdx) : cmd.script;
    let parsed = {};
    if (colonIdx > 0) {
      try { parsed = JSON.parse(cmd.script.slice(colonIdx + 1)); }
      catch (e) {
        const result = { ok: false, error: { name: 'COOKIE_PARAM_PARSE', message: `Failed to parse cookie params: ${e?.message ?? String(e)}` } };
        await updatePendingEntry(commandId, { status: 'completed', result });
        return result;
      }
    }
    let result;
    try {
      let cookieResult;
      if (sentinel === '__SP_COOKIE_GET_ALL__') cookieResult = await handleCookieGetAll(parsed);
      else if (sentinel === '__SP_COOKIE_SET__') cookieResult = await handleCookieSet(parsed);
      else if (sentinel === '__SP_COOKIE_REMOVE__') cookieResult = await handleCookieRemove(parsed);
      else {
        const r = { ok: false, error: { name: 'UNKNOWN_COOKIE_SENTINEL', message: `Unknown cookie sentinel: ${sentinel}` } };
        await updatePendingEntry(commandId, { status: 'completed', result: r });
        return r;
      }
      // Stringify the cookie API's bare value so it travels over the same
      // result.value-is-a-string contract the storage bus uses for scripts.
      result = { ok: true, value: JSON.stringify(cookieResult.value ?? null) };
    } catch (e) {
      result = { ok: false, error: { name: 'COOKIE_API_ERROR', message: e?.message ?? String(e) } };
    }
    await updatePendingEntry(commandId, { status: 'completed', result });
    return result;
  }

  // T79 Cluster D: selectorPack register/unregister sentinels.
  // Pack registration writes both to (a) page-scope window.__sp_pack[name] for
  // immediate use AND (b) browser.storage.local sp_pack_<tabId>_<name>=body for
  // persistence across navigations. The tabs.onUpdated listener below
  // re-injects (a) from (b) on every navigation. The existing tabs.onRemoved
  // listener cleans up (b) on tab close.
  //
  // Body must be a string already validated upstream by validatePackBody (the
  // MCP-side selector-pack tool). The extension does NOT re-validate — it
  // trusts that ANY script that reaches this sentinel passed validation.
  // Single source of truth on the MCP side avoids drift.
  if (typeof cmd.script === 'string' && cmd.script.startsWith('__SP_PACK_')) {
    const colonIdx = cmd.script.indexOf(':');
    const sentinel = colonIdx > 0 ? cmd.script.slice(0, colonIdx) : cmd.script;
    let parsed = {};
    if (colonIdx > 0) {
      try { parsed = JSON.parse(cmd.script.slice(colonIdx + 1)); }
      catch (e) {
        const result = { ok: false, error: { name: 'PACK_PARAM_PARSE', message: `Failed to parse pack params: ${e?.message ?? String(e)}` } };
        await updatePendingEntry(commandId, { status: 'completed', result });
        return result;
      }
    }

    const name = parsed.name;
    const body = parsed.body;
    if (typeof name !== 'string' || !name) {
      const result = { ok: false, error: { name: 'PACK_INVALID_NAME', message: 'pack sentinel requires non-empty name' } };
      await updatePendingEntry(commandId, { status: 'completed', result });
      return result;
    }

    const storageKey = 'sp_pack_' + tab.id + '_' + name;

    if (sentinel === '__SP_PACK_REGISTER__') {
      if (typeof body !== 'string' || !body) {
        const result = { ok: false, error: { name: 'PACK_INVALID_BODY', message: 'pack register sentinel requires non-empty body' } };
        await updatePendingEntry(commandId, { status: 'completed', result });
        return result;
      }
      try {
        // Persist for re-injection on navigation.
        await browser.storage.local.set({ [storageKey]: body });
      } catch (e) {
        const result = { ok: false, error: { name: 'PACK_STORAGE_WRITE_FAILED', message: e?.message ?? String(e) } };
        await updatePendingEntry(commandId, { status: 'completed', result });
        return result;
      }
      // Inject into page now via the standard storage-bus execute path. The
      // page-side evaluator (content-main.js) wraps scripts in `new
      // Function(script)()`, so the script must use a top-level `return` —
      // an IIFE expression statement would have its result discarded.
      // Embed name + body via JSON.stringify so quotes / backslashes survive
      // the round-trip without bespoke escaping.
      const injectionScript =
        'window.__sp_pack=window.__sp_pack||{};' +
        'try{' +
          'window.__sp_pack[' + JSON.stringify(name) + ']=new Function(\'root\',\'arg\',' + JSON.stringify(body) + ');' +
          'return JSON.stringify({ok:true,name:' + JSON.stringify(name) + '});' +
        '}catch(e){' +
          'return JSON.stringify({ok:false,error:e&&e.message?e.message:String(e)});' +
        '}';
      // Replace cmd.script and fall through to the regular execute path so
      // the inject runs through the storage-bus content-script flow.
      cmd.script = injectionScript;
      emitTrace(commandId, 'pack_registered', { layer: 'extension-bg', data: { tabId: tab.id, name, bodyBytes: body.length } });
      // Fall through — the regular execute path runs `cmd.script` in-page.
    } else if (sentinel === '__SP_PACK_UNREGISTER__') {
      try {
        await browser.storage.local.remove([storageKey]);
      } catch (e) {
        const result = { ok: false, error: { name: 'PACK_STORAGE_REMOVE_FAILED', message: e?.message ?? String(e) } };
        await updatePendingEntry(commandId, { status: 'completed', result });
        return result;
      }
      const removalScript =
        'var __removed=false;' +
        'if(window.__sp_pack&&window.__sp_pack[' + JSON.stringify(name) + ']){' +
          'delete window.__sp_pack[' + JSON.stringify(name) + '];' +
          '__removed=true;' +
        '}' +
        'return JSON.stringify({ok:true,removed:__removed});';
      cmd.script = removalScript;
      emitTrace(commandId, 'pack_unregistered', { layer: 'extension-bg', data: { tabId: tab.id, name } });
      // Fall through — regular execute path runs the removal.
    } else {
      const r = { ok: false, error: { name: 'UNKNOWN_PACK_SENTINEL', message: `Unknown pack sentinel: ${sentinel}` } };
      await updatePendingEntry(commandId, { status: 'completed', result: r });
      return r;
    }
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
  // v0.1.36 Fix 3 (initial-soft) — gate timeout on content-script readiness.
  // Initial shipping behaviour: track heartbeats for telemetry but do NOT
  // fast-fail. The in-memory readiness map is wiped whenever Safari restarts
  // the MV3 event page, which falsely flags long-lived tabs as not-ready.
  // The tighter fast-fail behaviour will return in v0.1.37 once heartbeat
  // rehydration from storage is robust.
  const baseTimeout = isFrameTargeted ? 10000 : 30000;
  const isCsReadyNow = spIsCsReady(tab.id, Date.now());
  const TIMEOUT_MS = baseTimeout;
  const timeoutReason = isCsReadyNow ? 'cs_ready' : 'cs_not_ready_observed';
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
    // v0.1.36 Fix 3 — emit CONTENT_SCRIPT_NOT_READY when the timeout was
    // gated short because no recent heartbeat existed. This is a recoverable
    // error: agent should call safari_wait_for or safari_navigate, then retry.
    let errorCode;
    let errorMessage;
    if (isFrameTargeted) {
      errorCode = 'FRAME_UNREACHABLE';
      errorMessage = `Frame ${cmd.frameId} unreachable — content script did not respond within ${TIMEOUT_MS}ms (sandbox/CSP/injection failure?)`;
    } else if (timeoutReason === 'cs_not_ready_observed') {
      // Heartbeat absent at decision time AND full timeout elapsed.
      errorCode = 'CONTENT_SCRIPT_NOT_READY';
      errorMessage = `Content script did not respond within ${TIMEOUT_MS}ms; no readiness heartbeat observed for this tab. Page may still be loading; call safari_wait_for with selector="body" before retrying.`;
    } else {
      errorCode = 'STORAGE_BUS_TIMEOUT';
      errorMessage = `Storage bus timeout (${TIMEOUT_MS}ms) — content script registered but did not respond in time`;
    }
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
  // T72: pre-launch the FIRST /poll fetch BEFORE entering the while loop so
  // a fetch is always in flight by the time the loop body runs. Combined
  // with the in-loop reassignment below, this guarantees that MV3's event
  // page never sees an idle moment between iterations — preventing the
  // suspension that drove T71's 80% multi-file e2e sweep flake rate. The
  // in-flight variable is awaited inside the existing BACKOFF_MS retry
  // ladder so cold-start fetch errors still hit the retry path.
  let inflightPoll = httpPoll(abortSignal);
  // T60: honor the abort signal threaded from pollLoopController so a fresh
  // alarm wake can forcibly stop a prior pollLoop instance — even one whose
  // fetch is wedged from event-page suspension recovery.
  while (!(abortSignal && abortSignal.aborted)) {
    try {
      const data = await inflightPoll;
      // T73: mark this pollLoop as healthy. supersedePollLoop reads this
      // timestamp on each keepalive alarm and skips the abort cascade when
      // recent (<30s). Set BEFORE the next-fetch reassignment so a successful
      // resolution is recorded even if the next httpPoll throws synchronously.
      lastSuccessfulPoll = Date.now();
      // T72: kick the NEXT /poll fetch IMMEDIATELY — before processing this
      // batch's commands — so a fetch is in flight while executeCommand
      // runs. The MV3 event page stays alive on the in-flight fetch even
      // when a tool call takes seconds (e.g. safari_navigate waiting for
      // page load). Without this, a long-running executeCommand can let
      // the page suspend before the next /poll iteration starts.
      inflightPoll = httpPoll(abortSignal);
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
      // T72: re-arm the inflight fetch before continuing so the next iter
      // has a fetch to await (otherwise we'd await a stale resolved value).
      if (err.name === 'TimeoutError') {
        attempts = 0;
        if (!(abortSignal && abortSignal.aborted)) {
          inflightPoll = httpPoll(abortSignal);
        }
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
      // T72: re-arm after backoff so the next iter awaits a fresh fetch
      // rather than the (already-rejected) prior one.
      if (!(abortSignal && abortSignal.aborted)) {
        inflightPoll = httpPoll(abortSignal);
      }
    }
  }
  emitTrace('__pollloop__', 'pollloop_aborted', { reason: 'signal_aborted_pre_iter' });
}

// T60: idempotent supersede. Aborts any prior pollLoop instance (releasing
// stuck fetches) and starts a fresh one with a new AbortController. The
// previous loop returns via its AbortError catch; this one runs free.
//
// T73: skip the abort cascade when the prior pollLoop is healthy. A healthy
// pollLoop has resolved an httpPoll within the last 30s — its in-flight
// /poll is registered in the daemon's waitingPolls and ready to fast-path
// the next execute. Aborting it kills that registration; commands queued
// during the supersede transition wait until the new pollLoop establishes
// a fresh waitingPoll AND a new execute arrives — observed as a 10s gap in
// e2e sweeps (T72-partial validation, 40% residual flake rate). Skipping
// preserves the daemon-side registration through the keepalive nudge.
//
// 30s threshold rationale: daemon long-poll holds 5s normally; bursts of
// activity reset lastSuccessfulPoll on every resolution. Idle systems with
// no commands resolve every 5s (TimeoutError doesn't update the timestamp,
// but the SUCCESS try-block does — and 204 responses count as success here:
// they reach the resolution point in pollLoop). 30s gives 6x headroom.
function supersedePollLoop(reason) {
  // T73 health check — skip when prior pollLoop is alive AND has resolved
  // recently. Only the unhealthy path (wedged fetch, never-resolved poll,
  // or first-load) goes through the abort+restart cascade.
  if (pollLoopController && lastSuccessfulPoll > 0 && Date.now() - lastSuccessfulPoll < 30_000) {
    emitTrace('__pollloop__', 'pollloop_supersede_skipped', {
      reason,
      sinceLastPollMs: Date.now() - lastSuccessfulPoll,
    });
    return;
  }
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
  // T67: per-step isolation + step-tagged trace events.
  //
  // Pre-T67 ordering was loadTabCache → gc → cleanup → connectAndReconcile,
  // wrapped in a single outer try/catch. When gcPendingStorage's writePending
  // threw on Safari's storage-quota cap (~5 MB), the throw aborted the chain
  // and connectAndReconcile never ran. The extension stayed isConnected=false
  // for 32+ hours despite alarms firing every minute. Trace evidence at
  // ~/.safari-pilot/daemon-trace.ndjson around 2026-05-02T02:54:52.
  //
  // Post-T67: connectAndReconcile is the critical path and runs second
  // (after read-only loadTabCache). Housekeeping (gc, cleanup) is best-effort
  // and runs after, with each step in its own try/catch so a throw in one
  // step doesn't skip the others. Each catch emits a step-tagged trace
  // event so future operators can identify which step failed without
  // re-reading source.
  try { await loadTabCache(); }
  catch (e) { emitTrace('__wake__', 'wake_load_error', { errName: e?.name, errMessage: e?.message }); }

  try { await connectAndReconcile(); }
  catch (e) { emitTrace('__wake__', 'wake_reconcile_error', { errName: e?.name, errMessage: e?.message }); }

  try { await gcPendingStorage(); }
  catch (e) { emitTrace('__wake__', 'wake_gc_error', { errName: e?.name, errMessage: e?.message }); }

  try { await cleanupStaleStorageBus(); }
  catch (e) { emitTrace('__wake__', 'wake_cleanup_error', { errName: e?.name, errMessage: e?.message }); }
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
            // T55a: storage bus uses commandId-keyed slots (sp_cmd_<id>/sp_result_<id>).
            // T68 fix: each slot's value already carries its own .commandId (real
            // storage entries do — this mirrors that). Read per-slot first so a test
            // can plant TWO poisons with DIFFERENT ids in one call. Fall back to a
            // shared top-level `op.poison.commandId` for callers that need both slots
            // to share an id, then to 'unknown' for callers that don't care about
            // exact key match (poison detection itself is the assertion).
            const sharedId = op.poison?.commandId ?? 'unknown';
            const resultId = op.poison?.sp_result?.commandId ?? sharedId;
            const cmdId = op.poison?.sp_cmd?.commandId ?? sharedId;
            const writes = {};
            if (op.poison?.sp_result) writes['sp_result_' + resultId] = op.poison.sp_result;
            if (op.poison?.sp_cmd) writes['sp_cmd_' + cmdId] = op.poison.sp_cmd;
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
