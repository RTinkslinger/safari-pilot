// background.js — Extension Service Worker
// Handles native messaging to the Swift daemon, routes commands from
// content scripts, manages cookie/DNR APIs, and tracks active tabs.

(function () {
  'use strict';

  // ─── State ────────────────────────────────────────────────────────────────

  let nativePort = null;
  const pendingRequests = new Map(); // requestId → { resolve, reject }
  let isConnected = false;
  const activeTabs = new Map(); // tabId → { url, status }
  let nextRequestId = 0;

  // ─── Native Messaging ─────────────────────────────────────────────────────

  function connectNative() {
    try {
      nativePort = browser.runtime.connectNative('com.safari-pilot.daemon');
      nativePort.onMessage.addListener(handleNativeMessage);
      nativePort.onDisconnect.addListener(handleNativeDisconnect);
      isConnected = true;
      console.log('[SafariPilot] Native messaging connected');
    } catch (e) {
      console.error('[SafariPilot] Native messaging failed:', e);
      isConnected = false;
      nativePort = null;
    }
  }

  function handleNativeMessage(message) {
    if (message && message.id && pendingRequests.has(message.id)) {
      const pending = pendingRequests.get(message.id);
      pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message);
      }
    }
  }

  function handleNativeDisconnect() {
    isConnected = false;
    nativePort = null;
    console.warn('[SafariPilot] Native port disconnected');

    // Reject all pending requests immediately
    for (const [id, pending] of pendingRequests) {
      pending.reject(new Error('Native port disconnected'));
    }
    pendingRequests.clear();

    // Auto-reconnect after 1 s
    setTimeout(connectNative, 1000);
  }

  function sendNativeMessage(command, params) {
    return new Promise((resolve, reject) => {
      if (!isConnected || !nativePort) {
        reject(new Error('Native port not connected'));
        return;
      }

      const id = `req_${++nextRequestId}_${Date.now()}`;
      pendingRequests.set(id, { resolve, reject });

      // Timeout after 30 s — daemon should reply well before this
      const timer = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error(`Native request timed out: ${command}`));
        }
      }, 30_000);

      try {
        nativePort.postMessage({ id, command, params: params ?? {} });
      } catch (err) {
        clearTimeout(timer);
        pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  // ─── Cookie Operations ────────────────────────────────────────────────────

  async function handleCookieGet(params) {
    const result = await browser.cookies.get({
      url: params.url,
      name: params.name,
      storeId: params.storeId,
    });
    return { ok: true, value: result };
  }

  async function handleCookieSet(params) {
    const result = await browser.cookies.set({
      url: params.url,
      name: params.name,
      value: params.value,
      domain: params.domain,
      path: params.path ?? '/',
      secure: params.secure ?? false,
      httpOnly: params.httpOnly ?? false,
      sameSite: params.sameSite,
      expirationDate: params.expirationDate,
      storeId: params.storeId,
    });
    return { ok: true, value: result };
  }

  async function handleCookieRemove(params) {
    const result = await browser.cookies.remove({
      url: params.url,
      name: params.name,
      storeId: params.storeId,
    });
    return { ok: true, value: result };
  }

  async function handleCookieGetAll(params) {
    const result = await browser.cookies.getAll({
      url: params.url,
      domain: params.domain,
      name: params.name,
      path: params.path,
      secure: params.secure,
      storeId: params.storeId,
    });
    return { ok: true, value: result };
  }

  // ─── Declarative Net Request Operations ───────────────────────────────────

  async function handleDnrAddRule(params) {
    await browser.declarativeNetRequest.updateDynamicRules({
      addRules: [params.rule],
      removeRuleIds: [],
    });
    return { ok: true, value: { added: true, ruleId: params.rule?.id } };
  }

  async function handleDnrRemoveRule(params) {
    await browser.declarativeNetRequest.updateDynamicRules({
      addRules: [],
      removeRuleIds: [params.ruleId],
    });
    return { ok: true, value: { removed: true, ruleId: params.ruleId } };
  }

  // ─── execute_in_main (forward to content script) ──────────────────────────

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

  // ─── Command Router ────────────────────────────────────────────────────────

  async function handleCommand(message, sender) {
    const { command, params } = message;

    try {
      switch (command) {
        case 'execute_in_main':
          return await handleExecuteInMain(message, sender);

        case 'cookie_get':
          return await handleCookieGet(params ?? {});

        case 'cookie_set':
          return await handleCookieSet(params ?? {});

        case 'cookie_remove':
          return await handleCookieRemove(params ?? {});

        case 'cookie_get_all':
          return await handleCookieGetAll(params ?? {});

        case 'dnr_add_rule':
          return await handleDnrAddRule(params ?? {});

        case 'dnr_remove_rule':
          return await handleDnrRemoveRule(params ?? {});

        default:
          // Forward unknown commands to the Swift daemon
          if (isConnected) {
            const response = await sendNativeMessage(command, params);
            return { ok: true, value: response };
          }
          return {
            ok: false,
            error: { message: `Unknown command: ${command}` },
          };
      }
    } catch (err) {
      return {
        ok: false,
        error: { message: err.message, name: err.name },
      };
    }
  }

  // ─── Runtime Message Listener ─────────────────────────────────────────────

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Health check
    if (message && message.type === 'ping') {
      sendResponse({ ok: true, type: 'pong', extensionVersion: '0.1.0' });
      return false;
    }

    // Command dispatch from content-isolated.js
    if (message && message.type === 'SAFARI_PILOT_COMMAND') {
      handleCommand(message, sender).then(sendResponse);
      return true; // Keep message channel open for async response
    }

    return false;
  });

  // ─── Tab Tracking ─────────────────────────────────────────────────────────

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status) {
      activeTabs.set(tabId, {
        url: tab.url ?? activeTabs.get(tabId)?.url,
        status: changeInfo.status,
      });
    }
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    activeTabs.delete(tabId);
  });

  // ─── Initialization ────────────────────────────────────────────────────────

  connectNative();
})();
