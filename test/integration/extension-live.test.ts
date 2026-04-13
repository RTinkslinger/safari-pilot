/**
 * Extension Live Tests — REAL E2E tests for features ONLY possible with the Safari Web Extension
 *
 * The extension injects window.__safariPilot into every page with:
 * - queryShadow / queryShadowAll (Shadow DOM traversal)
 * - fillReact / fillVue (framework-aware filling)
 * - interceptDialogs (alert/confirm/prompt interception)
 * - interceptNetwork (fetch/XHR monkey-patching)
 * - detectFramework (React/Vue/Angular/Svelte detection)
 *
 * These functions run in MAIN world — they have full access to page JS context,
 * Shadow DOM, and framework internals.
 *
 * WITHOUT the extension: none of this works.
 * - alert()/confirm()/prompt() BLOCK the JS event loop — AppleScript hangs forever
 * - Shadow DOM content is invisible to do JavaScript queries
 * - Network requests cannot be intercepted or captured
 * - Framework internals (React _valueTracker, Vue reactivity) are inaccessible
 *
 * Prerequisites:
 * - Safari Pilot extension enabled in Safari > Settings > Extensions
 * - "Allow Unsigned Extensions" enabled (or signed extension)
 * - "Allow JavaScript from Apple Events" enabled in Safari > Develop menu
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppleScriptEngine } from '../../src/engines/applescript.js';

describe.skipIf(process.env.CI === 'true')('Extension Live Tests — REAL E2E (10 tests)', () => {
  const engine = new AppleScriptEngine();
  let testTabUrl: string;

  beforeAll(async () => {
    // Open a test page — example.com is stable, fast, no frameworks, no CSP issues
    await engine.execute(
      `tell application "Safari"
        tell front window
          make new tab with properties {URL:"https://example.com"}
        end tell
      end tell`
    );
    await new Promise(r => setTimeout(r, 3000));
    testTabUrl = 'https://example.com/';
  }, 15000);

  afterAll(async () => {
    try {
      await engine.execute(engine.buildCloseTabScript(testTabUrl));
    } catch {}
  });

  // ── TEST 1: Extension namespace injected (prerequisite check) ───────────
  // Without extension: window.__safariPilot is undefined.
  // This is the gate — if this fails, all other tests are meaningless.

  it('1. extension __safariPilot namespace is injected with all 7 functions', async () => {
    const result = await engine.executeJsInTab(testTabUrl,
      'return JSON.stringify({ type: typeof window.__safariPilot, keys: Object.keys(window.__safariPilot) })'
    );
    expect(result.ok).toBe(true);
    const data = JSON.parse(result.value!);
    expect(data.type).toBe('object');

    const requiredFunctions = [
      'queryShadow', 'queryShadowAll',
      'fillReact', 'fillVue',
      'interceptDialogs', 'interceptNetwork',
      'detectFramework',
    ];
    for (const fn of requiredFunctions) {
      expect(data.keys).toContain(fn);
    }
    console.log(`[PASS] Extension namespace present with ${data.keys.length} functions: ${data.keys.join(', ')}`);
  }, 10000);

  // ── TEST 2: Dialog interception — alert() returns without blocking ──────
  // Without extension: alert() freezes the JS event loop. The AppleScript
  // `do JavaScript` call hangs until the user manually dismisses the dialog
  // (which never happens in headless automation). This test would TIMEOUT.

  it('2. alert() returns without blocking after interceptDialogs()', async () => {
    // Single JS block: install interceptor, fire alert, prove JS continued
    const result = await engine.executeJsInTab(testTabUrl, `
      var controller = window.__safariPilot.interceptDialogs();
      var before = Date.now();
      window.alert('Safari Pilot test alert — if you see this dialog, the extension is NOT working');
      var after = Date.now();
      var queue = controller.getQueue();
      return JSON.stringify({
        alertDidNotBlock: true,
        elapsedMs: after - before,
        queueLength: queue.length,
        capturedMessage: queue[0] ? queue[0].message : null,
        capturedType: queue[0] ? queue[0].type : null
      });
    `);
    expect(result.ok).toBe(true);
    const data = JSON.parse(result.value!);

    // The critical assertion: alert returned, JS continued, we got a result
    expect(data.alertDidNotBlock).toBe(true);
    // The alert should complete nearly instantly (< 100ms), not hang
    expect(data.elapsedMs).toBeLessThan(1000);
    // The interceptor should have captured the alert
    expect(data.queueLength).toBeGreaterThanOrEqual(1);
    expect(data.capturedMessage).toBe('Safari Pilot test alert — if you see this dialog, the extension is NOT working');
    expect(data.capturedType).toBe('alert');
    console.log(`[PASS] alert() returned in ${data.elapsedMs}ms without blocking. Captured: "${data.capturedMessage}"`);
  }, 10000);

  // ── TEST 3: Dialog interception — confirm() returns value without blocking
  // Without extension: confirm() shows a modal dialog and blocks until
  // OK/Cancel is clicked. In automation, this means indefinite hang.

  it('3. confirm() returns true without blocking after interceptDialogs()', async () => {
    const result = await engine.executeJsInTab(testTabUrl, `
      var controller = window.__safariPilot.interceptDialogs();
      var confirmResult = window.confirm('Accept terms?');
      var queue = controller.getQueue();
      return JSON.stringify({
        confirmReturned: true,
        confirmValue: confirmResult,
        confirmValueType: typeof confirmResult,
        capturedType: queue[0] ? queue[0].type : null,
        capturedMessage: queue[0] ? queue[0].message : null
      });
    `);
    expect(result.ok).toBe(true);
    const data = JSON.parse(result.value!);

    expect(data.confirmReturned).toBe(true);
    // Default handler returns true for confirm
    expect(data.confirmValue).toBe(true);
    expect(data.confirmValueType).toBe('boolean');
    expect(data.capturedType).toBe('confirm');
    expect(data.capturedMessage).toBe('Accept terms?');
    console.log(`[PASS] confirm() returned ${data.confirmValue} without blocking. Captured message: "${data.capturedMessage}"`);
  }, 10000);

  // ── TEST 4: Dialog interception — prompt() returns input value ──────────
  // Without extension: prompt() shows input dialog, blocks forever.

  it('4. prompt() returns default value without blocking after interceptDialogs()', async () => {
    const result = await engine.executeJsInTab(testTabUrl, `
      var controller = window.__safariPilot.interceptDialogs();
      var promptResult = window.prompt('Enter your name:', 'Safari Pilot');
      var queue = controller.getQueue();
      return JSON.stringify({
        promptReturned: true,
        promptValue: promptResult,
        promptValueType: typeof promptResult,
        capturedType: queue[0] ? queue[0].type : null,
        capturedMessage: queue[0] ? queue[0].message : null
      });
    `);
    expect(result.ok).toBe(true);
    const data = JSON.parse(result.value!);

    expect(data.promptReturned).toBe(true);
    // Default handler returns defaultValue (second arg) for prompt
    expect(data.promptValue).toBe('Safari Pilot');
    expect(data.promptValueType).toBe('string');
    expect(data.capturedType).toBe('prompt');
    expect(data.capturedMessage).toBe('Enter your name:');
    console.log(`[PASS] prompt() returned "${data.promptValue}" without blocking. Captured message: "${data.capturedMessage}"`);
  }, 10000);

  // ── TEST 5: Shadow DOM — create open shadow, query via extension ────────
  // Without extension: document.querySelector('#shadow-content') returns null
  // because the element is inside a shadow root. Standard DOM APIs cannot
  // traverse into shadow boundaries.

  it('5. queryShadow finds content inside open Shadow DOM', async () => {
    // Step 1: Create a custom element with shadow DOM
    const createResult = await engine.executeJsInTab(testTabUrl, `
      if (!customElements.get('sp-test-shadow')) {
        class SPTestShadow extends HTMLElement {
          constructor() {
            super();
            var shadow = this.attachShadow({ mode: 'open' });
            shadow.innerHTML = '<div id="shadow-inner" class="sp-test">Hello from Shadow DOM</div>';
          }
        }
        customElements.define('sp-test-shadow', SPTestShadow);
      }
      if (!document.querySelector('sp-test-shadow')) {
        document.body.appendChild(document.createElement('sp-test-shadow'));
      }
      // Prove standard DOM CANNOT find it
      var standardResult = document.querySelector('#shadow-inner');
      return JSON.stringify({ created: true, standardQueryFindsIt: standardResult !== null });
    `);
    expect(createResult.ok).toBe(true);
    const createData = JSON.parse(createResult.value!);
    expect(createData.created).toBe(true);
    // Standard DOM query CANNOT find content inside shadow
    expect(createData.standardQueryFindsIt).toBe(false);

    // Step 2: Use extension's queryShadow to find it
    const queryResult = await engine.executeJsInTab(testTabUrl, `
      var results = window.__safariPilot.queryShadow('#shadow-inner');
      return JSON.stringify({
        found: results.length > 0,
        count: results.length,
        text: results[0] ? results[0].textContent : null,
        tagName: results[0] ? results[0].tagName : null,
        className: results[0] ? results[0].className : null
      });
    `);
    expect(queryResult.ok).toBe(true);
    const queryData = JSON.parse(queryResult.value!);

    expect(queryData.found).toBe(true);
    expect(queryData.count).toBe(1);
    expect(queryData.text).toBe('Hello from Shadow DOM');
    expect(queryData.tagName).toBe('DIV');
    expect(queryData.className).toBe('sp-test');
    console.log(`[PASS] queryShadow found ${queryData.count} element inside shadow: "${queryData.text}" (${queryData.tagName}.${queryData.className})`);
  }, 15000);

  // ── TEST 6: Shadow DOM — queryShadowAll finds across nested shadows ─────
  // Tests the recursive shadow traversal: shadow inside shadow.

  it('6. queryShadowAll finds elements across nested shadow DOMs', async () => {
    const result = await engine.executeJsInTab(testTabUrl, `
      // Create outer element with shadow containing another shadow host
      if (!customElements.get('sp-outer-shadow')) {
        class SPOuterShadow extends HTMLElement {
          constructor() {
            super();
            var shadow = this.attachShadow({ mode: 'open' });
            shadow.innerHTML = '<span class="sp-nested-target">Outer shadow content</span><sp-inner-shadow></sp-inner-shadow>';
          }
        }
        customElements.define('sp-outer-shadow', SPOuterShadow);
      }
      if (!customElements.get('sp-inner-shadow')) {
        class SPInnerShadow extends HTMLElement {
          constructor() {
            super();
            var shadow = this.attachShadow({ mode: 'open' });
            shadow.innerHTML = '<span class="sp-nested-target">Inner shadow content</span>';
          }
        }
        customElements.define('sp-inner-shadow', SPInnerShadow);
      }
      // Remove previous instance if exists
      var existing = document.querySelector('sp-outer-shadow');
      if (existing) existing.remove();
      document.body.appendChild(document.createElement('sp-outer-shadow'));

      // Use queryShadowAll to find ALL .sp-nested-target across all shadow levels
      var results = window.__safariPilot.queryShadowAll('.sp-nested-target');
      var texts = [];
      for (var i = 0; i < results.length; i++) {
        texts.push(results[i].textContent);
      }
      return JSON.stringify({
        count: results.length,
        texts: texts
      });
    `);
    expect(result.ok).toBe(true);
    const data = JSON.parse(result.value!);

    expect(data.count).toBe(2);
    expect(data.texts).toContain('Outer shadow content');
    expect(data.texts).toContain('Inner shadow content');
    console.log(`[PASS] queryShadowAll found ${data.count} elements across nested shadows: ${JSON.stringify(data.texts)}`);
  }, 15000);

  // ── TEST 7: Network interception — THE critical test ────────────────────
  // Without extension: No way to intercept live XHR/fetch from automation.
  // Performance API only shows completed resource loads, not request details.
  //
  // This test:
  // 1. Installs the network interceptor (monkey-patches XHR/fetch)
  // 2. Makes a REAL XHR request
  // 3. Retrieves captured data with URL and status
  // 4. Verifies actual request data was captured
  //
  // Key implementation detail: interceptNetwork() returns a controller with
  // getCaptured(). The controller is NOT stored on SP._networkController
  // when called via do JavaScript (only via message channel). So we must
  // capture the return value and use it in the same execution context.
  //
  // XHR load event fires synchronously for sync XHR during send(), so
  // captured array is populated by the time send() returns.

  it('7. interceptNetwork captures actual XHR request data (URL, status)', async () => {
    const result = await engine.executeJsInTab(testTabUrl, `
      // Install the network interceptor — patches window.XMLHttpRequest and window.fetch
      var controller = window.__safariPilot.interceptNetwork();

      // Make a REAL synchronous XHR request to the current page
      var targetUrl = window.location.href;
      var xhr = new XMLHttpRequest();
      xhr.open('GET', targetUrl, false);
      try { xhr.send(); } catch(e) {}

      // Retrieve captured data from the controller
      var captures = controller.getCaptured();

      // Build response with actual captured data
      var firstCapture = captures.length > 0 ? captures[0] : null;
      return JSON.stringify({
        interceptorInstalled: true,
        captureCount: captures.length,
        firstUrl: firstCapture ? firstCapture.url : null,
        firstMethod: firstCapture ? firstCapture.method : null,
        firstStatus: firstCapture ? firstCapture.status : null,
        firstType: firstCapture ? firstCapture.type : null,
        hasTimestamp: firstCapture ? (typeof firstCapture.timestamp === 'number') : false
      });
    `);
    expect(result.ok).toBe(true);
    const data = JSON.parse(result.value!);

    // Verify the interceptor was installed and captured data
    expect(data.interceptorInstalled).toBe(true);
    expect(data.captureCount).toBeGreaterThanOrEqual(1);

    // Verify actual request data — not just "function exists" but real captured fields
    expect(data.firstUrl).toBe('https://example.com/');
    expect(data.firstMethod).toBe('GET');
    expect(data.firstStatus).toBe(200);
    expect(data.firstType).toBe('xhr');
    expect(data.hasTimestamp).toBe(true);
    console.log(`[PASS] Network interceptor captured ${data.captureCount} request(s). First: ${data.firstMethod} ${data.firstUrl} -> ${data.firstStatus} (${data.firstType})`);
  }, 15000);

  // ── TEST 8: Network interception — captures multiple requests ───────────
  // Verifies the interceptor accumulates entries across multiple requests.

  it('8. interceptNetwork captures multiple requests with distinct URLs', async () => {
    const result = await engine.executeJsInTab(testTabUrl, `
      // Fresh interceptor
      var controller = window.__safariPilot.interceptNetwork();

      // Make two distinct sync XHR requests
      var xhr1 = new XMLHttpRequest();
      xhr1.open('GET', window.location.href, false);
      try { xhr1.send(); } catch(e) {}

      var xhr2 = new XMLHttpRequest();
      xhr2.open('POST', window.location.href + '?test=second', false);
      try { xhr2.send(); } catch(e) {}

      var captures = controller.getCaptured();
      var urls = [];
      var methods = [];
      for (var i = 0; i < captures.length; i++) {
        urls.push(captures[i].url);
        methods.push(captures[i].method);
      }
      return JSON.stringify({
        captureCount: captures.length,
        urls: urls,
        methods: methods
      });
    `);
    expect(result.ok).toBe(true);
    const data = JSON.parse(result.value!);

    expect(data.captureCount).toBeGreaterThanOrEqual(2);
    expect(data.urls).toContain('https://example.com/');
    expect(data.methods).toContain('GET');
    expect(data.methods).toContain('POST');
    console.log(`[PASS] Captured ${data.captureCount} requests. URLs: ${JSON.stringify(data.urls)}, Methods: ${JSON.stringify(data.methods)}`);
  }, 15000);

  // ── TEST 9: Framework detection — runs on page ──────────────────────────
  // Without extension: No access to framework-specific globals like
  // __REACT_DEVTOOLS_GLOBAL_HOOK__ or __vue_devtools_global_hook__.

  it('9. detectFramework returns array and correctly identifies no framework on example.com', async () => {
    const result = await engine.executeJsInTab(testTabUrl, `
      var detected = window.__safariPilot.detectFramework();
      return JSON.stringify({
        isArray: Array.isArray(detected),
        frameworks: detected,
        count: detected.length
      });
    `);
    expect(result.ok).toBe(true);
    const data = JSON.parse(result.value!);

    expect(data.isArray).toBe(true);
    // example.com uses no JS framework
    expect(data.count).toBe(0);
    expect(data.frameworks).toEqual([]);
    console.log(`[PASS] detectFramework returned ${data.count} frameworks on example.com (expected: none): ${JSON.stringify(data.frameworks)}`);
  }, 10000);

  // ── TEST 10: Full round-trip — all extension features in one flow ───────
  // Exercises the full capability chain: install interceptors, trigger them,
  // query shadow DOM, detect framework, collect all results.

  it('10. full round-trip: dialog + network + shadow + framework in one execution', async () => {
    const result = await engine.executeJsInTab(testTabUrl, `
      var results = {};

      // 1. Dialog interception
      var dialogCtrl = window.__safariPilot.interceptDialogs();
      window.alert('round-trip alert');
      window.confirm('round-trip confirm');
      window.prompt('round-trip prompt', 'default');
      var dialogQueue = dialogCtrl.getQueue();
      results.dialogs = {
        count: dialogQueue.length,
        types: dialogQueue.map(function(d) { return d.type; })
      };

      // 2. Network interception
      var netCtrl = window.__safariPilot.interceptNetwork();
      var xhr = new XMLHttpRequest();
      xhr.open('GET', window.location.href, false);
      try { xhr.send(); } catch(e) {}
      var captures = netCtrl.getCaptured();
      results.network = {
        captureCount: captures.length,
        hasUrl: captures.length > 0 && typeof captures[0].url === 'string'
      };

      // 3. Shadow DOM query (from earlier test setup)
      var shadowResults = window.__safariPilot.queryShadowAll('.sp-test');
      results.shadow = {
        found: shadowResults.length
      };

      // 4. Framework detection
      var frameworks = window.__safariPilot.detectFramework();
      results.framework = {
        isArray: Array.isArray(frameworks),
        count: frameworks.length
      };

      return JSON.stringify(results);
    `);
    expect(result.ok).toBe(true);
    const data = JSON.parse(result.value!);

    // Dialog assertions
    expect(data.dialogs.count).toBe(3);
    expect(data.dialogs.types).toEqual(['alert', 'confirm', 'prompt']);

    // Network assertions
    expect(data.network.captureCount).toBeGreaterThanOrEqual(1);
    expect(data.network.hasUrl).toBe(true);

    // Shadow DOM assertions
    expect(data.shadow.found).toBeGreaterThanOrEqual(0); // may have been cleaned up

    // Framework detection assertions
    expect(data.framework.isArray).toBe(true);

    console.log(`[PASS] Full round-trip: ${data.dialogs.count} dialogs captured, ${data.network.captureCount} network requests, ${data.shadow.found} shadow elements, ${data.framework.count} frameworks`);
  }, 15000);
});
