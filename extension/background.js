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
let isWakeRunning = false;  // serializes concurrent wake triggers
let wakePending = false;

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

async function httpPoll() {
  const res = await fetch(`${HTTP_URL}/poll`, {
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 204) return null;
  return res.json();
}

function postResult(commandId, result) {
  httpPost('/result', { requestId: commandId, result })
    .catch((e) => console.warn('[safari-pilot] postResult failed:', e.message));
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
    const all = await browser.tabs.query({});
    const target = tabUrl.replace(/\/$/, '');
    const match = all.find((t) => (t.url || '').replace(/\/$/, '') === target);
    if (match) return match;
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
    const result = { ok: false, error: { message: 'No target tab' } };
    await updatePendingEntry(commandId, { status: 'completed', result });
    return result;
  }

  let result;
  try {
    // Primary: content script relay (bypasses CSP via pre-captured Function ref).
    // commandId rides inside params so content-main.js can dedupe via
    // __safariPilotExecutedCommands (content-isolated.js only forwards method+params).
    result = await browser.tabs.sendMessage(tab.id, {
      type: 'SAFARI_PILOT_COMMAND',
      method: 'execute_script',
      params: { script: cmd.script, commandId },
    });
  } catch (relayErr) {
    // Fallback: browser.scripting.executeScript (works when no content script is present)
    try {
      const execResults = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: (scriptBody) => {
          try {
            const fn = new Function(scriptBody);
            return { ok: true, value: fn() };
          } catch (e) {
            return { ok: false, error: { message: e.message, name: e.name } };
          }
        },
        args: [cmd.script],
        world: 'MAIN',
      });
      result = execResults[0]?.result ?? { ok: true, value: null };
    } catch (scriptErr) {
      result = { ok: false, error: { message: scriptErr.message, name: scriptErr.name } };
    }
  }

  await updatePendingEntry(commandId, { status: 'completed', result });
  return result;
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

// ─── Poll loop ──────────────────────────────────────────────────────────────
async function pollLoop() {
  while (true) {
    try {
      const data = await httpPoll();
      if (data && data.commands) {
        for (const cmd of data.commands) {
          const result = await executeCommand(cmd);
          postResult(cmd.id, result);
        }
      }
    } catch (err) {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') {
        return;
      }
      console.warn('[safari-pilot] pollLoop error:', err.name, err.message);
      return;
    }
  }
}

// ─── Wake sequence (HTTP) ───────────────────────────────────────────────────
async function wakeSequence(reason) {
  try {
    await gcPendingStorage();
    await connectAndReconcile();
    await pollLoop();
  } catch (e) {
    console.warn('[safari-pilot] wakeSequence error:', e.message);
  }
}

async function initialize(reason) {
  if (isWakeRunning) {
    wakePending = true;
    return;
  }
  isWakeRunning = true;
  try {
    await wakeSequence(reason);
    while (wakePending) {
      wakePending = false;
      await wakeSequence('coalesced');
    }
  } finally {
    isWakeRunning = false;
  }
}

// ─── Top-level listener registration ─────────────────────────────────────────
if (!listenersAttached) {
  listenersAttached = true;

  browser.runtime.onStartup.addListener(() => { initialize('onStartup'); });
  browser.runtime.onInstalled.addListener(() => { initialize('onInstalled'); });

  browser.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_PERIOD_MIN });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM_NAME) return;
    // Wake sequence handles connect + poll loop via HTTP IPC.
    initialize('keepalive');
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'ping') {
      sendResponse({ ok: true, type: 'pong', extensionVersion: EXTENSION_VERSION });
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
/*@DEBUG_HARNESS_END@*/

// First-run initialization for this event-page load cycle.
initialize('script_load');
