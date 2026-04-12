// background.js — Extension Service Worker
// Handles native messaging to the Safari app extension handler via
// browser.runtime.sendNativeMessage, routes commands from content scripts,
// manages cookie/DNR APIs, and tracks active tabs.

(function () {
  'use strict';

  // ─── Constants ──────────────────────────────────────────────────────────────

  // Bundle ID of the containing macOS app — Safari routes
  // sendNativeMessage calls to the app's web extension handler.
  const APP_BUNDLE_ID = 'com.safari-pilot.app';
  const POLL_IDLE_MS = 5000;
  const POLL_ACTIVE_MS = 200;
  const ACTIVE_COOLDOWN_MS = 10000;

  // ─── State ────────────────────────────────────────────────────────────────

  let isConnected = false;
  const activeTabs = new Map(); // tabId → { url, status }
  let pollTimerId = null;
  let currentPollInterval = POLL_IDLE_MS;
  let lastCommandTime = 0;

  // ─── Native Messaging (sendNativeMessage-based) ───────────────────────────

  /**
   * Send a message to the native extension handler and return the response.
   * Uses browser.runtime.sendNativeMessage (request/response per call).
   */
  function sendNativeRequest(message) {
    return browser.runtime.sendNativeMessage(APP_BUNDLE_ID, message);
  }

  /**
   * Poll the native handler for pending commands from the daemon.
   * If a command is returned, route it to the content script,
   * collect the result, and send it back via native messaging.
   */
  async function pollForCommands() {
    try {
      const response = await sendNativeRequest({ type: 'poll' });

      if (response && response.command && response.command !== null) {
        lastCommandTime = Date.now();
        switchToActivePolling();
        const cmd = response.command;
        await executeAndReturnResult(cmd);
      } else if (currentPollInterval === POLL_ACTIVE_MS &&
                 Date.now() - lastCommandTime > ACTIVE_COOLDOWN_MS) {
        switchToIdlePolling();
      }
    } catch (e) {
      console.warn('[SafariPilot] Poll error:', e);
    }
  }

  function switchToActivePolling() {
    if (currentPollInterval === POLL_ACTIVE_MS) return;
    currentPollInterval = POLL_ACTIVE_MS;
    stopPolling();
    pollTimerId = setInterval(pollForCommands, POLL_ACTIVE_MS);
    console.log('[SafariPilot] Switched to active polling (200ms)');
  }

  function switchToIdlePolling() {
    if (currentPollInterval === POLL_IDLE_MS) return;
    currentPollInterval = POLL_IDLE_MS;
    stopPolling();
    pollTimerId = setInterval(pollForCommands, POLL_IDLE_MS);
    console.log('[SafariPilot] Switched to idle polling (5s)');
  }

  /**
   * Execute a command received from the daemon (via poll) and send the
   * result back through the native handler.
   */
  async function executeAndReturnResult(cmd) {
    const commandId = cmd.id;

    try {
      let result;

      if (cmd.script) {
        // Route script execution to the active tab's content script
        const tabs = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        const tabId = tabs[0]?.id;

        if (tabId != null) {
          const responses = await browser.tabs.sendMessage(tabId, {
            type: 'SAFARI_PILOT_COMMAND',
            method: 'execute_script',
            params: { script: cmd.script },
          });
          result = responses;
        } else {
          result = { ok: false, error: { message: 'No active tab' } };
        }
      } else {
        result = { ok: true, value: null };
      }

      await sendNativeRequest({
        type: 'result',
        id: commandId,
        result: result,
      });
    } catch (err) {
      // Send error result back so the daemon doesn't hang
      try {
        await sendNativeRequest({
          type: 'result',
          id: commandId,
          result: { ok: false, error: { message: err.message } },
        });
      } catch (sendErr) {
        console.error('[SafariPilot] Failed to send error result:', sendErr);
      }
    }
  }

  // ─── Poll Loop ────────────────────────────────────────────────────────────

  function startPolling() {
    if (pollTimerId != null) return;
    currentPollInterval = POLL_IDLE_MS;
    pollTimerId = setInterval(pollForCommands, POLL_IDLE_MS);
    console.log('[SafariPilot] Polling started (idle: 5s)');
  }

  function stopPolling() {
    if (pollTimerId != null) {
      clearInterval(pollTimerId);
      pollTimerId = null;
      console.log('[SafariPilot] Polling stopped');
    }
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
      sendResponse({ ok: true, type: 'pong', extensionVersion: '0.1.3' });
      return false;
    }

    // MCP server session signal — switch to active polling
    if (message && message.type === 'session_start') {
      lastCommandTime = Date.now();
      switchToActivePolling();
      sendResponse({ ok: true, polling: 'active' });
      return false;
    }

    // MCP server session end — switch to idle polling
    if (message && message.type === 'session_end') {
      switchToIdlePolling();
      sendResponse({ ok: true, polling: 'idle' });
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

  // Send status check on startup to register as connected
  sendNativeRequest({ type: 'status' })
    .then((response) => {
      if (response && response.connected) {
        isConnected = true;
        console.log('[SafariPilot] Native handler connected, version:', response.version);
      }
    })
    .catch((err) => {
      console.warn('[SafariPilot] Initial status check failed:', err);
    });

  // Start polling for daemon commands
  startPolling();
})();
