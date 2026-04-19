// content-main.js — MAIN world
// WARNING: This code runs in the page's context. It CAN be observed by page JS.
// Never store secrets. Never read credentials. Minimal footprint.

(() => {
  'use strict';

  // Capture Function constructor before CSP can restrict eval/Function.
  // Extension content scripts load before page CSP is enforced, so this
  // reference remains usable even on strict-CSP pages like Reddit/GitHub.
  const _Function = Function;

  // Namespace to minimize collision risk
  const SP = Object.create(null);

  // ─── Shadow DOM Traversal ─────────────────────────────────────────────────
  // Traverses open AND closed shadow roots. Closed roots are accessible from
  // MAIN world because we intercept Element.attachShadow at document_idle.
  // Primary reason this extension exists — no other automation layer can do this.

  SP.queryShadow = (selector, shadowSelector) => {
    // If shadowSelector provided: find hosts matching selector, then query inside their shadows
    // If only selector: query entire document including all shadow subtrees
    const results = [];

    const walkShadow = (node, targetSelector) => {
      const shadow = node.shadowRoot;
      if (shadow) {
        const found = shadow.querySelectorAll(targetSelector);
        results.push(...found);
        shadow.querySelectorAll('*').forEach(child => walkShadow(child, targetSelector));
      }
    };

    if (shadowSelector) {
      // Two-phase: find shadow hosts by selector, then query inside their shadows
      const hosts = document.querySelectorAll(selector);
      hosts.forEach(host => {
        if (host.shadowRoot) {
          results.push(...host.shadowRoot.querySelectorAll(shadowSelector));
          host.shadowRoot.querySelectorAll('*').forEach(child => walkShadow(child, shadowSelector));
        }
      });
    } else {
      // Single-phase: query full document + all shadow subtrees
      results.push(...document.querySelectorAll(selector));
      document.querySelectorAll('*').forEach(el => walkShadow(el, selector));
    }

    return results;
  };

  SP.queryShadowAll = (selector, root = document) => {
    const results = [];
    const walk = (node) => {
      if (node.shadowRoot) {
        results.push(...node.shadowRoot.querySelectorAll(selector));
        node.shadowRoot.querySelectorAll('*').forEach(walk);
      }
      node.querySelectorAll('*').forEach(child => {
        if (child.shadowRoot) walk(child);
      });
    };
    results.push(...root.querySelectorAll(selector));
    walk(root);
    return results;
  };

  // ─── Framework-Aware Form Filling ─────────────────────────────────────────
  // React tracks input state via _valueTracker. A plain .value assignment won't
  // trigger React's synthetic event system. We must use the native setter and
  // delete the tracker so React sees the change as "new" input.

  SP.fillReact = (element, value) => {
    const nativeInputValueSetter =
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

    if (!nativeInputValueSetter) {
      throw new Error('Cannot find native value setter');
    }

    // Bypass React's _valueTracker so it sees the programmatic change as new
    if (element._valueTracker) {
      element._valueTracker.setValue('');
    }

    nativeInputValueSetter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  };

  SP.fillVue = async (element, value) => {
    // Vue 3 uses Proxy-based reactivity — direct assignment triggers v-model
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    // Wait for Vue's nextTick so watchers run before change event
    await new Promise(resolve => setTimeout(resolve, 0));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // ─── Dialog Interception ──────────────────────────────────────────────────
  // Replaces window.alert/confirm/prompt with captured versions.
  // Must run in MAIN world — ISOLATED world cannot override window globals.

  SP.interceptDialogs = () => {
    const dialogQueue = [];
    const handlers = {};

    ['alert', 'confirm', 'prompt'].forEach(type => {
      const original = window[type];
      window[type] = function(message, defaultValue) {
        const entry = { type, message, timestamp: Date.now() };
        dialogQueue.push(entry);

        if (handlers[type]) {
          return handlers[type](message, defaultValue);
        }
        // Sensible defaults: accept alerts, auto-confirm, return empty prompt
        if (type === 'alert') return undefined;
        if (type === 'confirm') return true;
        if (type === 'prompt') return defaultValue || '';
      };
    });

    return {
      getQueue: () => [...dialogQueue],
      setHandler: (type, fn) => { handlers[type] = fn; },
      clear: () => { dialogQueue.length = 0; },
    };
  };

  // ─── Network Interception ─────────────────────────────────────────────────
  // Monkey-patches fetch and XMLHttpRequest for capture and mocking.
  // Only JS-initiated requests are interceptable — browser-native resource
  // loading (img src, link href, etc.) bypasses this.

  SP.interceptNetwork = () => {
    const captured = [];
    const originalFetch = window.fetch;
    const OriginalXHR = window.XMLHttpRequest;

    window.fetch = async function(...args) {
      const request = new Request(...args);
      const entry = {
        type: 'fetch',
        url: request.url,
        method: request.method,
        timestamp: Date.now(),
      };
      try {
        const response = await originalFetch.apply(this, args);
        entry.status = response.status;
        entry.statusText = response.statusText;
        captured.push(entry);
        return response;
      } catch (error) {
        entry.error = error.message;
        captured.push(entry);
        throw error;
      }
    };

    // Patch XMLHttpRequest
    window.XMLHttpRequest = function() {
      const xhr = new OriginalXHR();
      const entry = { type: 'xhr', timestamp: Date.now() };

      const originalOpen = xhr.open.bind(xhr);
      xhr.open = function(method, url, ...rest) {
        entry.method = method;
        entry.url = url;
        return originalOpen(method, url, ...rest);
      };

      xhr.addEventListener('load', () => {
        entry.status = xhr.status;
        entry.statusText = xhr.statusText;
        captured.push({ ...entry });
      });

      xhr.addEventListener('error', () => {
        entry.error = 'XHR error';
        captured.push({ ...entry });
      });

      return xhr;
    };

    return {
      getCaptured: () => [...captured],
      clear: () => { captured.length = 0; },
      restore: () => {
        window.fetch = originalFetch;
        window.XMLHttpRequest = OriginalXHR;
      },
    };
  };

  // ─── Framework Detection ──────────────────────────────────────────────────

  SP.detectFramework = () => {
    const detected = [];

    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot]') || document.querySelector('[data-reactid]')) {
      detected.push('react');
    }
    if (window.__vue_devtools_global_hook__ || document.querySelector('[data-v-app]')) {
      detected.push('vue');
    }
    if (window.ng || window.getAllAngularRootElements?.()?.length > 0) {
      detected.push('angular');
    }
    if (document.querySelector('[data-svelte]') || window.__svelte) {
      detected.push('svelte');
    }

    return detected;
  };

  // ─── Expose namespace ──────────────────────────────────────────────────────
  window.__safariPilot = SP;

  // ─── Command idempotency cache ────────────────────────────────────────────
  // Cache executed commands by commandId so the extension can wake, poll for a
  // command the content script has already run, and return the cached result
  // instead of re-executing (prevents double-side-effects on non-idempotent ops).
  // Cache is page-lifetime; clears on navigation. Daemon's executedLog is the
  // cross-page authoritative source (added in commit 1b).
  if (!window.__safariPilotExecutedCommands) {
    window.__safariPilotExecutedCommands = new Map(); // commandId → {result, timestamp}
  }

  // ─── Message Channel from ISOLATED World ──────────────────────────────────
  // The ISOLATED world relay forwards background script commands here via
  // window.postMessage. We respond with results on the same channel.
  // SECURITY: use window.location.origin (never '*') as postMessage target.

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== 'SAFARI_PILOT_CMD') return;

    const { requestId, method, params } = event.data;

    const respond = (ok, payload) => {
      window.postMessage(
        { type: 'SAFARI_PILOT_RESPONSE', requestId, ok, ...payload },
        window.location.origin
      );
    };

    (async () => {
      try {
        let result;
        switch (method) {
          case 'queryShadow': {
            const elements = SP.queryShadow(params.selector, params.shadowSelector);
            result = Array.from(elements).map(el => ({
              tagName: el.tagName,
              id: el.id,
              className: el.className,
              textContent: el.textContent?.slice(0, 200),
            }));
            break;
          }
          case 'queryShadowAll': {
            const elements = SP.queryShadowAll(params.selector);
            result = Array.from(elements).map(el => ({
              tagName: el.tagName,
              id: el.id,
              className: el.className,
              textContent: el.textContent?.slice(0, 200),
            }));
            break;
          }
          case 'fillReact': {
            const target = document.querySelector(params.selector);
            if (!target) throw new Error(`Element not found: ${params.selector}`);
            SP.fillReact(target, params.value);
            result = { filled: true };
            break;
          }
          case 'fillVue': {
            const target = document.querySelector(params.selector);
            if (!target) throw new Error(`Element not found: ${params.selector}`);
            await SP.fillVue(target, params.value);
            result = { filled: true };
            break;
          }
          case 'interceptDialogs': {
            const controller = SP.interceptDialogs();
            // Store controller so later commands can query it
            SP._dialogController = controller;
            result = { intercepting: true };
            break;
          }
          case 'getDialogQueue': {
            result = SP._dialogController?.getQueue() ?? [];
            break;
          }
          case 'interceptNetwork': {
            const controller = SP.interceptNetwork();
            SP._networkController = controller;
            result = { intercepting: true };
            break;
          }
          case 'getNetworkCaptures': {
            result = SP._networkController?.getCaptured() ?? [];
            break;
          }
          case 'detectFramework': {
            result = SP.detectFramework();
            break;
          }
          case 'execute_script': {
            const commandId = params.commandId;
            if (commandId && window.__safariPilotExecutedCommands.has(commandId)) {
              const cached = window.__safariPilotExecutedCommands.get(commandId);
              result = cached.result;
              break;
            }
            const fn = new _Function(params.script);
            result = fn();
            if (commandId) {
              window.__safariPilotExecutedCommands.set(commandId, { result, timestamp: Date.now() });
            }
            break;
          }
          default:
            throw new Error(`Unknown method: ${method}`);
        }
        respond(true, { value: result });
      } catch (error) {
        respond(false, { error: { message: error.message, name: error.name } });
      }
    })();
  });
})();
