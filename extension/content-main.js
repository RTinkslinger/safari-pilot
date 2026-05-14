// content-main.js — MAIN world
// WARNING: This code runs in the page's context. It CAN be observed by page JS.
// Never store secrets. Never read credentials. Minimal footprint.

(() => {
  'use strict';

  // Capture Function constructor before CSP can restrict eval/Function.
  // Extension content scripts load before page CSP is enforced, so this
  // reference remains usable even on strict-CSP pages like Reddit/GitHub.
  const _Function = Function;

  // ── Layer 3: Trusted Types policy registration (v0.1.34) ──
  // On pages that enforce `require-trusted-types-for 'script'`, any remaining
  // MAIN-world string→sink path (e.g. legacy code that does .innerHTML = str)
  // needs a registered policy to route through. If the page's `trusted-types`
  // directive doesn't allow the 'safari-pilot' policy name, the createPolicy
  // call throws TypeError; we flag that and let task-3 error UX surface it.
  // The probe sentinel __SP_TT_PROBE__:<json> below exposes this state.
  (function registerTrustedTypesPolicy() {
    try {
      if (typeof window.trustedTypes === 'undefined' || typeof window.trustedTypes.createPolicy !== 'function') {
        return;
      }
      try {
        const policy = window.trustedTypes.createPolicy('safari-pilot', {
          createScript: (s) => s,
          createHTML: (s) => s,
          createScriptURL: (s) => s,
        });
        window.__SP_TT_POLICY__ = policy;
      } catch (e) {
        window.__SP_TT_HARD_BLOCK = true;
      }
    } catch (e) {
      // Defensive: anything unexpected shouldn't break the rest of the script.
    }
  })();

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

  // ─── T21: SPA URL refresh (history.pushState / replaceState / popstate) ───
  // Safari does NOT reliably fire `tabs.onUpdated` for SPA URL changes via
  // the History API. The extension's `tabCacheMap` therefore goes stale on
  // any client-side route change, causing `findTargetTab` cache-only lookups
  // (alarm-wake context) to miss — surfacing as TAB_NOT_FOUND post-T27.
  //
  // This wrapper runs in MAIN world (the page's `history` object lives here
  // and ISOLATED-world content scripts can't intercept it directly). Each
  // hook fires a `SAFARI_PILOT_URL_CHANGE` postMessage to the same window.
  // The ISOLATED-world relay (content-isolated.js) forwards to background
  // via `runtime.sendMessage({type:'sp_url_changed', url})` and background
  // updates `tabCacheMap`.
  //
  // Idempotency: stamp `__sp_t21_wrapped = true` on the wrapped function so
  // Safari's bf-cache restore (which re-runs content scripts) doesn't
  // double-wrap. SPA libraries that wrap pushState themselves (Next.js,
  // React Router) sit either above or below us; either way, our wrapper
  // fires the event when invoked. We do NOT re-wrap once stamped.
  if (!history.pushState.__sp_t21_wrapped) {
    const _emit = () => {
      try {
        window.postMessage(
          { type: 'SAFARI_PILOT_URL_CHANGE', url: location.href },
          window.location.origin
        );
      } catch { /* ignore — postMessage should never throw, but guard anyway */ }
    };
    const _wrap = (orig) => {
      const wrapped = function(...args) {
        const r = orig.apply(this, args);
        _emit();
        return r;
      };
      wrapped.__sp_t21_wrapped = true;
      return wrapped;
    };
    history.pushState = _wrap(history.pushState);
    history.replaceState = _wrap(history.replaceState);
    // popstate fires on history.back/forward and on user back/forward
    // navigation. The URL is already updated by the time this listener
    // fires (per HTML spec).
    window.addEventListener('popstate', _emit);
  }

  // ─── 5A.1 phase-0: file upload probe — ISOLATED→MAIN File structured-clone test
  // Receives a probe File from content-isolated.js, verifies it arrived as a real
  // File instance with the SPFUBYTE signature bytes intact, and responds via
  // postMessage. This is Test B of the phase-0 spike: if File objects can't
  // survive structured-clone across the isolation boundary, Approach 3 is dead.
  window.addEventListener('message', (ev) => {
    if (!ev.data || ev.data.op !== 'file_upload_probe_test_request') return;
    const file = ev.data.file;
    // Verify File object survived structured clone with bytes intact.
    const payload = { ok: false };
    try {
      if (!(file instanceof File)) {
        payload.error = `not a File instance: ${Object.prototype.toString.call(file)}`;
      } else {
        payload.name = file.name;
        payload.size = file.size;
        payload.type = file.type;
        // Read bytes via blob.arrayBuffer() and verify the SPFUBYTE signature.
        file.arrayBuffer().then((buf) => {
          const view = new Uint8Array(buf);
          const expected = [0x53, 0x50, 0x46, 0x55, 0x42, 0x59, 0x54, 0x45];
          const bytesMatch = view.length === expected.length && expected.every((b, i) => view[i] === b);
          window.postMessage({
            op: 'file_upload_probe_test_response',
            commandId: ev.data.commandId,
            payload: { ok: bytesMatch, name: file.name, size: file.size, type: file.type, bytesMatchExpected: bytesMatch },
          }, '*');
        }).catch((e) => {
          window.postMessage({
            op: 'file_upload_probe_test_response',
            commandId: ev.data.commandId,
            payload: { ok: false, error: `arrayBuffer failed: ${String(e && e.message || e)}` },
          }, '*');
        });
        return;
      }
      window.postMessage({
        op: 'file_upload_probe_test_response',
        commandId: ev.data.commandId,
        payload,
      }, '*');
    } catch (e) {
      window.postMessage({
        op: 'file_upload_probe_test_response',
        commandId: ev.data.commandId,
        payload: { ok: false, error: String(e && e.message || e) },
      }, '*');
    }
  });

  // ─── 5A.1 file_upload INJECT handler — fires DataTransfer + defineProperty + events
  // in MAIN world (page-side; CSP allows native APIs that ISOLATED cannot access for
  // the input.files mutation that frameworks observe).
  window.addEventListener('message', (ev) => {
    if (!ev.data || ev.data.op !== 'file_upload_inject') return;

    const respond = (payload) => {
      window.postMessage({ op: 'file_upload_response', commandId: ev.data.commandId, payload }, '*');
    };

    try {
      // a. Resolve input via inline minimal locator (selector/xpath/ref).
      const input = resolveFileUploadInjectLocator(ev.data.locator);
      if (!input) {
        respond({ ok: false, errorCode: 'LOCATOR_NOT_FOUND', message: 'locator did not resolve in main world' });
        return;
      }
      // b. Detached-element check
      if (!document.contains(input)) {
        respond({ ok: false, errorCode: 'FILE_UPLOAD_ELEMENT_DETACHED' });
        return;
      }
      // c. tagName/type re-check (probe-vs-inject divergence)
      if (input.tagName !== 'INPUT' || input.type !== 'file') {
        respond({ ok: false, errorCode: 'FILE_UPLOAD_INVALID_ELEMENT', tagName: input.tagName, type: input.type || '' });
        return;
      }
      // d. multiple-attr re-check
      if (!ev.data.clear && ev.data.files.length > 1 && input.multiple === false) {
        respond({ ok: false, errorCode: 'FILE_UPLOAD_MULTIPLE_NOT_ALLOWED' });
        return;
      }
      // e. Build DataTransfer
      const dt = new DataTransfer();
      if (!ev.data.clear) {
        for (const file of ev.data.files) dt.items.add(file);
      }
      // f. Set input.files via direct assignment — the spec-compliant path that
      // updates the internal [[Files]] slot WebKit's FormData reads from.
      // Object.defineProperty alone shadows the prototype getter for JS reads
      // but does NOT update the internal slot, so new FormData(form) at submit
      // time sees an empty FileList (root cause of the empty multipart parts
      // observed in Phase 7 e2e). Direct assignment goes through the proper
      // HTMLInputElement.files setter (designed for DataTransfer-based assignment
      // since ~2019). defineProperty is kept as a fallback for contexts where
      // the setter is missing or read-only — frameworks like React/Vue still
      // observe the change via input/change events fired below.
      try {
        input.files = dt.files;
      } catch (e) {
        Object.defineProperty(input, 'files', {
          value: dt.files, writable: false, configurable: true,
        });
      }
      // g. Fire input + change events
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // h. Validation probe at +probeOpts.validationProbeMs
      const probeMs = (ev.data.probeOpts && typeof ev.data.probeOpts.validationProbeMs === 'number')
        ? ev.data.probeOpts.validationProbeMs : 0;
      const finalize = () => {
        const out = {
          ok: true,
          uploaded: ev.data.clear ? 0 : ev.data.files.length,
          files: (ev.data.clear ? [] : ev.data.files).map((f) => ({
            name: f.name, size: f.size, mimeType: f.type, path: '',
          })),
        };
        if (probeMs > 0) {
          const validation = collectFileUploadValidation(input);
          if (validation) out.validation = validation;
        }
        respond(out);
      };
      if (probeMs > 0) setTimeout(finalize, probeMs);
      else finalize();
    } catch (e) {
      respond({ ok: false, errorCode: 'INJECT_ERROR', message: String(e && e.message || e) });
    }
  });

  // 5A.1 — minimal MAIN-world locator (selector/xpath/ref). Same coverage as
  // content-isolated.js's resolveFileUploadLocator; production locator chain
  // (role/text/label/placeholder) requires shared helper not yet in extension JS.
  function resolveFileUploadInjectLocator(locator) {
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

  // 5A.1 — collect client-side validation surface for the probe.
  // Scope: closest <form> ancestor; fallback to input.parentElement.
  // Returns undefined if nothing surfaced (no validation field in the response).
  function collectFileUploadValidation(input) {
    const form = input.closest('form');
    const scope = form || input.parentElement || document.body;

    const message = input.validationMessage || '';
    const alerts = [];

    // [role=alert]
    for (const el of scope.querySelectorAll('[role="alert"]')) {
      if (alerts.length >= 3) break;
      const text = (el.textContent || '').trim();
      if (text) alerts.push(text.length > 500 ? text.slice(0, 500) + '…' : text);
    }
    // [aria-invalid=true]
    for (const el of scope.querySelectorAll('[aria-invalid="true"]')) {
      if (alerts.length >= 3) break;
      const text = (el.textContent || '').trim();
      if (text) alerts.push(text.length > 500 ? text.slice(0, 500) + '…' : text);
    }
    // aria-errormessage IDREF list
    const ariaErrAttr = input.getAttribute('aria-errormessage');
    if (ariaErrAttr) {
      for (const id of ariaErrAttr.split(/\s+/)) {
        if (alerts.length >= 3) break;
        const el = document.getElementById(id);
        if (el) {
          const text = (el.textContent || '').trim();
          if (text) alerts.push(text.length > 500 ? text.slice(0, 500) + '…' : text);
        }
      }
    }

    if (!message && alerts.length === 0) return undefined;
    const out = {};
    if (message) out.message = message;
    if (alerts.length > 0) out.alerts = alerts;
    return out;
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
            // ── EARLY INTERCEPT: __SP_SCROLL_TO_ELEMENT__:<json> (v0.1.31 Task 5) ──
            // Sentinel-routed handler for safari_scroll_to_element. Sits at the
            // top of the case so it runs before commandId caching and the
            // _Function compile path. Errors thrown here flow through the outer
            // catch → respond(false, { error: { message, name } }), which the
            // daemon (ExtensionBridge.handleResult) maps to error.code on the
            // Node side via StructuredError.code = error.name.
            if (typeof params.script === 'string' && params.script.startsWith('__SP_SCROLL_TO_ELEMENT__:')) {
              const args = JSON.parse(params.script.slice('__SP_SCROLL_TO_ELEMENT__:'.length));
              const sel = args.selector;
              const txt = args.text;
              const role = args.role;
              const name = args.name;
              const nth = typeof args.nth === 'number' ? args.nth : 0;
              const behavior = args.behavior === 'smooth' ? 'smooth' : 'instant';
              const L = window.__SP_LOCATOR__;
              if (!L) {
                throw Object.assign(
                  new Error('locator.js not loaded in MAIN world'),
                  { name: 'TARGET_NOT_FOUND' },
                );
              }
              const candidates = L.resolveScrollTargets({ selector: sel, text: txt, role, name });
              if (candidates.length === 0) {
                const hidden = L.resolveScrollTargets({ selector: sel, text: txt, role, name, includeHidden: true });
                if (hidden.length > 0) {
                  throw Object.assign(
                    new Error('element exists but is not visible (display:none, hidden, or in closed <details>)'),
                    { name: 'TARGET_HIDDEN' },
                  );
                }
                throw Object.assign(
                  new Error('no element matched the provided locator'),
                  { name: 'TARGET_NOT_FOUND' },
                );
              }
              if (nth >= candidates.length) {
                throw Object.assign(
                  new Error('nth=' + nth + ' out of range (matchCount=' + candidates.length + ')'),
                  { name: 'INVALID_PARAMS' },
                );
              }
              const target = candidates[nth];
              const fromY = window.scrollY;
              target.element.scrollIntoView({ behavior, block: 'center', inline: 'nearest' });
              await L.waitForScrollSettle(500);
              const matchedNode = L.serializeNode(target.element);
              const allMatches = candidates.length > 1
                ? candidates.slice(0, 5).map((c) => L.serializeNode(c.element, true))
                : undefined;
              result = {
                scrolledTo: { strategy: target.strategy, matchedNode, matchCount: candidates.length, allMatches },
                viewport: { scrollX: window.scrollX, scrollY: window.scrollY, innerWidth: window.innerWidth, innerHeight: window.innerHeight },
                scrolledFromY: fromY,
              };
              break;
            }
            // ── EARLY INTERCEPT: __SP_DISMISS_OVERLAYS__:<json> (v0.1.31 Task 10) ──
            // Sentinel-routed handler for safari_dismiss_overlays. Same Option A shape
            // as the scroll intercept above: success → result = {...}; break;
            // failure → throw with error.name → daemon maps to error.code.
            if (typeof params.script === 'string' && params.script.startsWith('__SP_DISMISS_OVERLAYS__:')) {
              try {
                const args = JSON.parse(params.script.slice('__SP_DISMISS_OVERLAYS__:'.length));
                const { categories, patterns, killSwitchEngaged, paywallEnabled } = args;
                const L = window.__SP_LOCATOR__;
                if (!L) {
                  throw Object.assign(
                    new Error('locator.js not loaded in MAIN world'),
                    { name: 'NO_LOCATOR' },
                  );
                }
                if (killSwitchEngaged) {
                  result = {
                    dismissed: [],
                    skipped: [{ reason: 'kill_switch_engaged' }],
                    overlaysAtStart: 0,
                    overlaysAtEnd: 0,
                  };
                  break;
                }
                const dismissed = [];
                const skipped = [];
                let overlaysAtStart = 0;
                const filtered = (patterns || []).filter((p) => !categories || categories.includes(p.category));
                for (const pattern of filtered) {
                  // Paywall opt-in gate
                  if (pattern.category === 'paywall' && !paywallEnabled) {
                    const root = L.findPatternRoot(pattern);
                    if (root) {
                      const sel = pattern.signals.find((s) => s.type === 'selector');
                      skipped.push({
                        reason: 'paywall_opt_in_required',
                        candidate: { selector: sel ? sel.value : undefined, category: 'paywall' },
                      });
                    }
                    continue;
                  }
                  const root = L.findPatternRoot(pattern);
                  if (!root) {
                    const sel = pattern.signals.find((s) => s.type === 'selector');
                    skipped.push({
                      reason: 'allowlist_miss',
                      candidate: { selector: sel ? sel.value : undefined, category: pattern.category },
                    });
                    continue;
                  }
                  overlaysAtStart++;
                  try {
                    const verifyResult = await L.dismissPattern(pattern, root);
                    if (!verifyResult.verified) {
                      const sel = pattern.signals.find((s) => s.type === 'selector');
                      skipped.push({
                        reason: 'verify_failed_overlay_persists',
                        candidate: { selector: sel ? sel.value : undefined, hint: pattern.id },
                      });
                    } else {
                      const sel = pattern.signals.find((s) => s.type === 'selector');
                      dismissed.push({
                        category: pattern.category,
                        id: pattern.id,
                        selector: sel ? sel.value : '',
                        action: pattern.dismiss.action,
                        site: window.location.hostname,
                        verified: true,
                      });
                    }
                  } catch (e) {
                    skipped.push({
                      reason: 'click_failed',
                      candidate: { hint: String((e && e.message) || e) },
                    });
                  }
                }
                // Recount remaining
                let remaining = 0;
                for (const p of filtered) { if (L.findPatternRoot(p)) remaining++; }
                result = {
                  dismissed,
                  skipped,
                  overlaysAtStart,
                  overlaysAtEnd: remaining,
                };
                break;
              } catch (e) {
                // Re-throw with NO_LOCATOR semantic (any unexpected failure surfaces here).
                // If it already has a .name, preserve it; otherwise tag NO_LOCATOR.
                if (e && e.name && e.name !== 'Error') throw e;
                throw Object.assign(
                  new Error(String((e && e.message) || e)),
                  { name: 'NO_LOCATOR' },
                );
              }
            }
            // ── EARLY INTERCEPT: __SP_TT_PROBE__:<json> (v0.1.34 Task 2) ──
            // Reads Layer 3 init state. Used by csp-tt-policy-registration.test.ts AND by
            // T3's safari_evaluate CSP_BLOCKED error UX to distinguish CSP_BLOCKED from
            // CSP_HARD_BLOCK. Args ignored (probe takes no parameters; the trailing JSON
            // is required only to satisfy the prefix-then-colon convention).
            if (typeof params.script === 'string' && params.script.startsWith('__SP_TT_PROBE__:')) {
              result = {
                hardBlock: window.__SP_TT_HARD_BLOCK === true,
                policyRegistered: typeof window.__SP_TT_POLICY__ !== 'undefined',
              };
              break;
            }
            // ── EARLY INTERCEPT: __SP_RESOLVE_LOCATOR__:<json> (v0.1.34 Task 7b) ──
            // CSP-immune locator resolution for the playwright-style accessible
            // locator path (role/text/label/testId/placeholder/xpath + chain).
            // Replaces the TS-side generateLocatorJs JS-string call which hits
            // `new Function()` and fails on Trusted-Types-strict pages. Returns
            // the same envelope shape: { found, selector?, element?, matchCount?,
            // strictnessSatisfied?, hint? }. AppleScript fallback path keeps
            // using the IIFE form from src/locator.ts (no __SP_LOCATOR__ outside
            // the extension).
            if (typeof params.script === 'string' && params.script.startsWith('__SP_RESOLVE_LOCATOR__:')) {
              const payload = JSON.parse(params.script.slice('__SP_RESOLVE_LOCATOR__:'.length));
              const L = window.__SP_LOCATOR__;
              if (!L || typeof L.resolveLocator !== 'function') {
                throw Object.assign(
                  new Error('__SP_LOCATOR__.resolveLocator not available'),
                  { name: 'NO_LOCATOR' },
                );
              }
              result = L.resolveLocator(payload.locator || payload, payload.options || {});
              break;
            }
            // ── EARLY INTERCEPT: __SP_CLICK__:<json> (v0.1.34 Task 7) ──
            // CSP-immune safari_click. Mirrors the previous actionJs body verbatim:
            // MouseEvent dispatch (mousedown → mouseup → click/contextmenu/auxclick),
            // modifier flags, native link-following for primary <a> clicks, and
            // downloadContext payload for safari_download_link integration.
            if (typeof params.script === 'string' && params.script.startsWith('__SP_CLICK__:')) {
              const args = JSON.parse(params.script.slice('__SP_CLICK__:'.length));
              const el = document.querySelector(args.selector);
              if (!el) {
                throw Object.assign(
                  new Error('Element not found: ' + args.selector),
                  { name: 'ELEMENT_NOT_FOUND' },
                );
              }
              const buttonNum = args.buttonNum;
              const m = args.modifiers || {};
              const rect = el.getBoundingClientRect();
              const opts = {
                bubbles: true, cancelable: true, view: window,
                clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
                button: buttonNum,
                buttons: 1 << buttonNum,
                ctrlKey: !!m.ctrl, shiftKey: !!m.shift, altKey: !!m.alt, metaKey: !!m.meta,
              };
              const terminalEvent = buttonNum === 0 ? 'click' : buttonNum === 2 ? 'contextmenu' : 'auxclick';
              el.dispatchEvent(new MouseEvent('mousedown', opts));
              el.dispatchEvent(new MouseEvent('mouseup', opts));
              el.dispatchEvent(new MouseEvent(terminalEvent, opts));

              const linkEl = el.tagName === 'A' ? el : (el.closest ? el.closest('a') : null);
              let navigatedTo = null;
              if (buttonNum === 0 && linkEl && linkEl.href && !linkEl.hasAttribute('download')) {
                const tgt = linkEl.getAttribute('target');
                if (!tgt || tgt === '_self') navigatedTo = linkEl.href;
              }

              result = {
                clicked: true,
                navigatedTo: navigatedTo,
                element: {
                  tagName: el.tagName,
                  id: el.id || undefined,
                  textContent: (el.textContent || '').slice(0, 100),
                },
                downloadContext: linkEl ? {
                  href: linkEl.href || undefined,
                  downloadAttr: linkEl.getAttribute('download') == null ? undefined : linkEl.getAttribute('download'),
                  isDownloadLink: linkEl.hasAttribute('download'),
                } : undefined,
              };

              if (navigatedTo) {
                window.location.href = navigatedTo;
              }
              break;
            }
            // ── EARLY INTERCEPT: __SP_FILL__:<json> (v0.1.34 Task 8) ──
            // CSP-immune safari_fill. Mirrors the previous actionJs verbatim:
            // framework auto-detect (react/vue/vanilla), React native-setter
            // trick for controlled inputs, Vue path, clearFirst, pressEnterAfter.
            if (typeof params.script === 'string' && params.script.startsWith('__SP_FILL__:')) {
              const args = JSON.parse(params.script.slice('__SP_FILL__:'.length));
              const el = document.querySelector(args.selector);
              if (!el) {
                throw Object.assign(
                  new Error('Element not found: ' + args.selector),
                  { name: 'ELEMENT_NOT_FOUND' },
                );
              }

              let detectedFramework = 'vanilla';
              if (Object.keys(el).some((k) => k.startsWith('__reactFiber$'))) {
                detectedFramework = 'react';
              } else if (el.__vue__ || el.__vueParentComponent) {
                detectedFramework = 'vue';
              }
              const fw = args.framework === 'auto' ? detectedFramework : args.framework;

              if (args.clearFirst) {
                el.focus();
                el.value = '';
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }

              if (fw === 'react') {
                const inputDesc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                const textareaDesc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
                const nativeSetter = inputDesc ? inputDesc.set : (textareaDesc ? textareaDesc.set : null);
                if (nativeSetter) {
                  nativeSetter.call(el, args.value);
                } else {
                  el.value = args.value;
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
              } else if (fw === 'vue') {
                el.value = args.value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } else {
                el.focus();
                el.value = args.value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
              }

              if (args.pressEnterAfter) {
                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
              }

              result = {
                filled: true,
                element: { tagName: el.tagName, id: el.id || undefined, name: el.name || undefined, type: el.type || undefined },
                framework: fw,
                verifiedValue: el.value,
              };
              break;
            }
            // ── EARLY INTERCEPT: __SP_TYPE__:<json> (v0.1.34 Task 9) ──
            // CSP-immune safari_type. Per-character keyboard event dispatch in
            // MAIN world. Mirrors the previous JS-string loop verbatim:
            // focus → for each char: keydown / keypress / append to value /
            // input / keyup.
            if (typeof params.script === 'string' && params.script.startsWith('__SP_TYPE__:')) {
              const args = JSON.parse(params.script.slice('__SP_TYPE__:'.length));
              const el = document.querySelector(args.selector);
              if (!el) {
                throw Object.assign(
                  new Error('Element not found'),
                  { name: 'ELEMENT_NOT_FOUND' },
                );
              }
              el.focus();
              const text = String(args.content || '');
              for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                const code = 'Key' + ch.toUpperCase();
                el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code, bubbles: true }));
                el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, code, bubbles: true }));
                el.value = (el.value || '') + ch;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, code, bubbles: true }));
              }
              result = { typed: true, length: text.length };
              break;
            }
            // ── EARLY INTERCEPT: __SP_SCROLL__:<json> (v0.1.34 Task 10) ──
            // CSP-immune safari_scroll. Mirrors the previous actionJs branching:
            // toTop / toBottom / toElement / delta directional. Operates on the
            // document.documentElement by default, or a passed targetSelector
            // for scroll-inside-container.
            if (typeof params.script === 'string' && params.script.startsWith('__SP_SCROLL__:')) {
              const args = JSON.parse(params.script.slice('__SP_SCROLL__:'.length));
              const target = args.targetSelector
                ? document.querySelector(args.targetSelector)
                : document.documentElement;
              if (!target) {
                throw Object.assign(
                  new Error('Scroll target not found'),
                  { name: 'ELEMENT_NOT_FOUND' },
                );
              }
              if (args.toTop) {
                target.scrollTo({ top: 0, behavior: 'smooth' });
              } else if (args.toBottom) {
                target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
              } else if (args.toElement) {
                const scrollTarget = document.querySelector(args.toElement);
                if (scrollTarget) scrollTarget.scrollIntoView({ behavior: 'smooth' });
              } else {
                const amt = args.amount;
                const dir = args.direction;
                if (dir === 'down') target.scrollBy({ top: amt, behavior: 'smooth' });
                else if (dir === 'up') target.scrollBy({ top: -amt, behavior: 'smooth' });
                else if (dir === 'right') target.scrollBy({ left: amt, behavior: 'smooth' });
                else if (dir === 'left') target.scrollBy({ left: -amt, behavior: 'smooth' });
              }
              result = {
                scrolled: true,
                scrollPosition: { x: target.scrollLeft || window.scrollX, y: target.scrollTop || window.scrollY },
                atTop: (target.scrollTop || window.scrollY) === 0,
                atBottom: (target.scrollTop || window.scrollY) + (target.clientHeight || window.innerHeight) >= (target.scrollHeight - 1),
              };
              break;
            }
            // ── EARLY INTERCEPT: __SP_EXTRACT_METADATA__:<json> (v0.1.34 Task 15e) ──
            // CSP-immune safari_extract_metadata. Reproduces the previous
            // JS-string body using native DOM APIs. Result-envelope shape
            // preserved verbatim: { meta, canonical, openGraph, twitter, jsonLd, url }
            if (typeof params.script === 'string' && params.script.startsWith('__SP_EXTRACT_METADATA__:')) {
              const getMeta = (n) => {
                const el = document.querySelector('meta[name="' + n + '"]') ||
                           document.querySelector('meta[property="' + n + '"]');
                return el ? el.getAttribute('content') : null;
              };

              const meta = {
                title: document.title || null,
                description: getMeta('description'),
                keywords: getMeta('keywords'),
                author: getMeta('author'),
                robots: getMeta('robots'),
                viewport: getMeta('viewport'),
              };

              const canonicalEl = document.querySelector('link[rel="canonical"]');
              const canonical = canonicalEl ? canonicalEl.getAttribute('href') : null;

              const og = {};
              const ogMetas = document.querySelectorAll('meta[property^="og:"]');
              for (let i = 0; i < ogMetas.length; i++) {
                const prop = ogMetas[i].getAttribute('property').replace('og:', '');
                og[prop] = ogMetas[i].getAttribute('content');
              }

              const twitter = {};
              const twMetas = document.querySelectorAll('meta[name^="twitter:"]');
              for (let j = 0; j < twMetas.length; j++) {
                const nm = twMetas[j].getAttribute('name').replace('twitter:', '');
                twitter[nm] = twMetas[j].getAttribute('content');
              }

              const jsonLd = [];
              const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
              for (let k = 0; k < ldScripts.length; k++) {
                try {
                  jsonLd.push(JSON.parse(ldScripts[k].textContent));
                } catch (_e) { /* skip malformed */ }
              }

              result = {
                meta,
                canonical,
                openGraph: og,
                twitter,
                jsonLd,
                url: location.href,
              };
              break;
            }
            // ── EARLY INTERCEPT: __SP_EXTRACT_IMAGES__:<json> (v0.1.34 Task 15d) ──
            // CSP-immune safari_extract_images. Reproduces the previous
            // JS-string body using native DOM APIs. Result-envelope shape
            // preserved verbatim:
            //   { images: [{src, alt, width, height, naturalWidth, naturalHeight}], count }
            if (typeof params.script === 'string' && params.script.startsWith('__SP_EXTRACT_IMAGES__:')) {
              const args = JSON.parse(params.script.slice('__SP_EXTRACT_IMAGES__:'.length));
              const minW = typeof args.minWidth === 'number' ? args.minWidth : 0;
              const minH = typeof args.minHeight === 'number' ? args.minHeight : 0;
              const imgs = document.querySelectorAll('img');
              const images = [];
              for (let i = 0; i < imgs.length; i++) {
                const img = imgs[i];
                const w = img.width || img.offsetWidth || 0;
                const h = img.height || img.offsetHeight || 0;
                if (w < minW || h < minH) continue;
                images.push({
                  src: img.src || img.getAttribute('src') || '',
                  alt: img.alt || '',
                  width: w,
                  height: h,
                  naturalWidth: img.naturalWidth || 0,
                  naturalHeight: img.naturalHeight || 0,
                });
              }
              result = { images, count: images.length };
              break;
            }
            // ── EARLY INTERCEPT: __SP_EXTRACT_LINKS__:<json> (v0.1.34 Task 15c) ──
            // CSP-immune safari_extract_links. Reproduces the previous
            // JS-string body using native DOM APIs. Result-envelope shape
            // preserved verbatim: { links: [{href, text, context, internal}], count }
            if (typeof params.script === 'string' && params.script.startsWith('__SP_EXTRACT_LINKS__:')) {
              const args = JSON.parse(params.script.slice('__SP_EXTRACT_LINKS__:'.length));
              const filterMode = args.filter || 'all';
              const pageOrigin = location.origin;
              const anchors = document.querySelectorAll('a[href]');
              const links = [];

              for (let i = 0; i < anchors.length; i++) {
                const a = anchors[i];
                const href = a.href || '';
                const t = (a.innerText || a.textContent || '').trim().slice(0, 200);

                let isInternal = false;
                try {
                  isInternal = new URL(href).origin === pageOrigin;
                } catch (e) {
                  isInternal = !href.startsWith('http') || href.startsWith(pageOrigin);
                }

                if (filterMode === 'internal' && !isInternal) continue;
                if (filterMode === 'external' && isInternal) continue;

                let context = '';
                let node = a.parentElement;
                while (node && node !== document.body) {
                  const tag = node.tagName ? node.tagName.toUpperCase() : '';
                  if (/^H[1-6]$/.test(tag) || tag === 'P' || tag === 'LI') {
                    context = (node.innerText || node.textContent || '').trim().slice(0, 200);
                    break;
                  }
                  node = node.parentElement;
                }

                links.push({ href, text: t, context, internal: isInternal });
              }
              result = { links, count: links.length };
              break;
            }
            // ── EARLY INTERCEPT: __SP_EXTRACT_TABLES__:<json> (v0.1.34 Task 15b) ──
            // CSP-immune safari_extract_tables. Reproduces the previous
            // JS-string body using native DOM APIs. Result-envelope shape
            // preserved verbatim: { tables: [{headers, rows}], count }
            if (typeof params.script === 'string' && params.script.startsWith('__SP_EXTRACT_TABLES__:')) {
              const args = JSON.parse(params.script.slice('__SP_EXTRACT_TABLES__:'.length));
              const tables = args.selector
                ? document.querySelectorAll(args.selector)
                : document.querySelectorAll('table');
              const out = [];
              for (let t = 0; t < tables.length; t++) {
                const table = tables[t];
                const headers = [];
                const rows = [];

                let thEls = table.querySelectorAll('thead th');
                if (thEls.length === 0) thEls = table.querySelectorAll('tr:first-child th');
                for (let h = 0; h < thEls.length; h++) {
                  headers.push((thEls[h].innerText || thEls[h].textContent || '').trim());
                }

                const trEls = table.querySelectorAll(headers.length > 0 ? 'tbody tr' : 'tr');
                if (trEls.length === 0 && headers.length > 0) {
                  const allRows = table.querySelectorAll('tr');
                  for (let ri = 1; ri < allRows.length; ri++) {
                    const cells = allRows[ri].querySelectorAll('td');
                    if (cells.length > 0) {
                      const row = [];
                      for (let ci = 0; ci < cells.length; ci++) {
                        row.push((cells[ci].innerText || cells[ci].textContent || '').trim());
                      }
                      rows.push(row);
                    }
                  }
                } else {
                  for (let ri2 = 0; ri2 < trEls.length; ri2++) {
                    const cells2 = trEls[ri2].querySelectorAll('td');
                    if (cells2.length > 0) {
                      const row2 = [];
                      for (let ci2 = 0; ci2 < cells2.length; ci2++) {
                        row2.push((cells2[ci2].innerText || cells2[ci2].textContent || '').trim());
                      }
                      rows.push(row2);
                    }
                  }
                }

                out.push({ headers, rows });
              }
              result = { tables: out, count: out.length };
              break;
            }
            // ── EARLY INTERCEPT: __SP_SMART_SCRAPE__:<json> (v0.1.34 Task 15a) ──
            // CSP-immune safari_smart_scrape. Delegates to
            // __SP_LOCATOR__.smartScrape (ported verbatim from
            // src/tools/structured-extraction.ts handleSmartScrape).
            // Result-envelope shape preserved verbatim:
            //   { data: { [field]: value | null }, fieldsExtracted: number }
            if (typeof params.script === 'string' && params.script.startsWith('__SP_SMART_SCRAPE__:')) {
              const args = JSON.parse(params.script.slice('__SP_SMART_SCRAPE__:'.length));
              const L = window.__SP_LOCATOR__;
              if (!L || typeof L.smartScrape !== 'function') {
                throw Object.assign(
                  new Error('__SP_LOCATOR__.smartScrape not available'),
                  { name: 'NO_LOCATOR' },
                );
              }
              result = L.smartScrape({ schema: args.schema, scope: args.scope });
              break;
            }
            // ── EARLY INTERCEPT: __SP_SNAPSHOT__:<json> (v0.1.34 Task 14) ──
            // CSP-immune safari_snapshot. Delegates to
            // __SP_LOCATOR__.buildSnapshot (ported from src/aria.ts
            // generateSnapshotJs). Result-envelope shape preserved verbatim:
            //   {snapshot, url, title, elementCount, interactiveCount, refMap}
            if (typeof params.script === 'string' && params.script.startsWith('__SP_SNAPSHOT__:')) {
              const args = JSON.parse(params.script.slice('__SP_SNAPSHOT__:'.length));
              const L = window.__SP_LOCATOR__;
              if (!L || typeof L.buildSnapshot !== 'function') {
                throw Object.assign(
                  new Error('__SP_LOCATOR__.buildSnapshot not available'),
                  { name: 'NO_LOCATOR' },
                );
              }
              result = L.buildSnapshot({
                scopeSelector: args.scopeSelector,
                maxDepth: args.maxDepth,
                includeHidden: args.includeHidden,
                format: args.format,
              });
              break;
            }
            // ── EARLY INTERCEPT: __SP_QUERY_ALL__:<json> (v0.1.34 Task 13) ──
            // CSP-immune safari_query_all. Two payload variants:
            //   selector branch: { selector, limit } → document.querySelectorAll
            //   locator branch:  { locator, limit }  → __SP_LOCATOR__.resolveLocatorAll
            // Result-envelope shape preserved verbatim:
            //   {items: [{ref, tagName, text, attrs, boundingBox, visible}], count, limit, truncated}
            if (typeof params.script === 'string' && params.script.startsWith('__SP_QUERY_ALL__:')) {
              const args = JSON.parse(params.script.slice('__SP_QUERY_ALL__:'.length));
              const limit = (typeof args.limit === 'number' && args.limit > 0) ? args.limit : 100;
              if (args.selector) {
                const all = Array.prototype.slice.call(document.querySelectorAll(args.selector));
                const truncated = all.length > limit;
                const slice = all.slice(0, limit);
                const items = [];
                for (let i = 0; i < slice.length; i++) {
                  const el = slice[i];
                  const ref = 'sp-' + Math.random().toString(36).substring(2, 8);
                  el.setAttribute('data-sp-ref', ref);
                  const rect = el.getBoundingClientRect();
                  const attrs = {};
                  if (el.attributes) {
                    for (let ai = 0; ai < el.attributes.length; ai++) {
                      const a = el.attributes[ai];
                      if (a.name && a.name !== 'data-sp-ref') attrs[a.name] = a.value;
                    }
                  }
                  const style = window.getComputedStyle(el);
                  const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                  items.push({
                    ref,
                    tagName: el.tagName || '',
                    text: ((el.innerText !== undefined ? el.innerText : el.textContent) || '').replace(/\s+/g, ' ').trim().substring(0, 500),
                    attrs,
                    boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    visible,
                  });
                }
                result = { items, count: all.length, limit, truncated };
                break;
              }
              const L = window.__SP_LOCATOR__;
              if (!L || typeof L.resolveLocatorAll !== 'function') {
                throw Object.assign(
                  new Error('__SP_LOCATOR__.resolveLocatorAll not available'),
                  { name: 'NO_LOCATOR' },
                );
              }
              result = L.resolveLocatorAll(args.locator || {}, { limit });
              break;
            }
            // ── EARLY INTERCEPT: __SP_GET_TEXT__:<json> (v0.1.34 Task 12) ──
            // CSP-immune safari_get_text. Mirrors the previous JS-string body:
            //   multi:false → {text, length, truncated}   (full-page when no selector)
            //   multi:true  → {matches: string[], count}  (selector required)
            if (typeof params.script === 'string' && params.script.startsWith('__SP_GET_TEXT__:')) {
              const args = JSON.parse(params.script.slice('__SP_GET_TEXT__:'.length));
              const sel = args.selector;
              const max = typeof args.maxLength === 'number' ? args.maxLength : 50000;
              if (args.multi) {
                if (!sel) {
                  throw Object.assign(
                    new Error('multi:true requires a selector'),
                    { name: 'INVALID_PARAMS' },
                  );
                }
                const els = document.querySelectorAll(sel);
                const matches = [];
                for (let i = 0; i < els.length; i++) {
                  const t = els[i].innerText || els[i].textContent || '';
                  matches.push(t.slice(0, max));
                }
                result = { matches, count: els.length };
              } else {
                const el = sel ? document.querySelector(sel) : document.body;
                if (!el) {
                  throw Object.assign(
                    new Error('Element not found'),
                    { name: 'ELEMENT_NOT_FOUND' },
                  );
                }
                const text = el.innerText || el.textContent || '';
                result = { text: text.slice(0, max), length: text.length, truncated: text.length > max };
              }
              break;
            }
            // ── EARLY INTERCEPT: __SP_COMPOSE_FINAL_EVIDENCE__:<json> (v0.1.35 Task 7) ──
            // Sentinel-routed handler for safari_compose_final_evidence. Resolves the
            // optional locator, scrolls the matched element into view (center), grabs
            // the matching DOM snippet (or the body text fallback), and computes a
            // simple textual claim_grounded check. The TS-side handler captures a
            // screenshot afterward and returns all three fields in metadata.
            if (typeof params.script === 'string' && params.script.startsWith('__SP_COMPOSE_FINAL_EVIDENCE__:')) {
              const payload = JSON.parse(params.script.slice('__SP_COMPOSE_FINAL_EVIDENCE__:'.length));
              const claim = typeof payload.claim === 'string' ? payload.claim : '';
              const locator = payload.locator;
              let element = null;
              if (locator) {
                const L = window.__SP_LOCATOR__;
                if (L && typeof L.resolveLocator === 'function') {
                  const resolved = L.resolveLocator(locator, {});
                  if (resolved && resolved.found && resolved.selector) {
                    try { element = document.querySelector(resolved.selector); } catch { element = null; }
                  }
                }
                // Fallback: direct selector if locator has a literal `selector` key
                if (!element && locator.selector) {
                  try { element = document.querySelector(locator.selector); } catch { element = null; }
                }
                if (element && typeof element.scrollIntoView === 'function') {
                  try { element.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { /* best-effort */ }
                }
              }
              const dom_snippet = element
                ? element.outerHTML.slice(0, 2000)
                : (document.body ? document.body.innerText.slice(0, 2000) : '');
              let claim_grounded = false;
              if (claim) {
                if (dom_snippet.includes(claim)) {
                  claim_grounded = true;
                } else {
                  const words = claim.split(/\s+/).filter((w) => w.length > 3);
                  claim_grounded = words.length > 0 && words.every((w) => dom_snippet.includes(w));
                }
              }
              result = { dom_snippet, claim_grounded };
              break;
            }
            // ── existing default execute_script path ──
            const commandId = params.commandId;
            if (commandId && window.__safariPilotExecutedCommands.has(commandId)) {
              const cached = window.__safariPilotExecutedCommands.get(commandId);
              result = cached.result;
              break;
            }
            const fn = new _Function(params.script);
            // Await the result so injected scripts that `return new Promise(...)`
            // resolve properly. `await` on a non-Promise is a no-op, so this is
            // safe for synchronous scripts too. Required for T6 (IndexedDB tools)
            // and enables async-aware use of safari_evaluate.
            result = await fn();
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
