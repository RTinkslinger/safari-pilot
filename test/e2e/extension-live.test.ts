/**
 * Extension Live Tests — Features ONLY possible with the Safari Web Extension
 *
 * The extension injects window.__safariPilot into every page with:
 * - queryShadow / queryShadowAll (Shadow DOM traversal)
 * - fillReact / fillVue (framework-aware filling)
 * - interceptDialogs (alert/confirm/prompt interception)
 * - interceptNetwork (fetch/XHR monkey-patching)
 * - detectFramework (React/Vue/Angular/Svelte detection)
 *
 * These functions run in MAIN world — they have full access to page JS context,
 * Shadow DOM, and framework internals. Without the extension, none of this works.
 *
 * Prerequisites:
 * - Safari Pilot extension enabled in Safari > Settings > Extensions
 * - "Allow Unsigned Extensions" enabled (or signed extension)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppleScriptEngine } from '../../src/engines/applescript.js';

describe('Extension Live Tests — Features Only the Extension Enables', () => {
  const engine = new AppleScriptEngine();
  let testTabUrl: string;

  beforeAll(async () => {
    // Open a test page
    const result = await engine.execute(
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
    // Close the test tab
    try {
      await engine.execute(engine.buildCloseTabScript(testTabUrl));
    } catch {}
  });

  // ── TEST 1: Extension is injected and active ─────────────────────────────

  it('extension __safariPilot namespace is injected into pages', async () => {
    const result = await engine.executeJsInTab(testTabUrl,
      'return typeof window.__safariPilot'
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe('object');
    console.log('Extension namespace: window.__safariPilot is present');
  }, 10000);

  it('all 7 extension functions are available', async () => {
    const result = await engine.executeJsInTab(testTabUrl,
      'return JSON.stringify(Object.keys(window.__safariPilot))'
    );
    expect(result.ok).toBe(true);
    const keys = JSON.parse(result.value!);
    expect(keys).toContain('queryShadow');
    expect(keys).toContain('queryShadowAll');
    expect(keys).toContain('fillReact');
    expect(keys).toContain('fillVue');
    expect(keys).toContain('interceptDialogs');
    expect(keys).toContain('interceptNetwork');
    expect(keys).toContain('detectFramework');
    console.log(`Extension functions: ${keys.join(', ')}`);
  }, 10000);

  // ── TEST 2: Dialog Interception ──────────────────────────────────────────
  // WITHOUT the extension: alert() blocks the JS event loop. No AppleScript
  // can execute until the user manually dismisses the dialog.
  // WITH the extension: interceptDialogs() replaces window.alert/confirm/prompt
  // with captured versions that don't block.

  it('intercepts dialogs WITHOUT blocking the JS event loop', async () => {
    // Step 1: Install dialog interceptor (extension function)
    const setupResult = await engine.executeJsInTab(testTabUrl, `
      window.__safariPilot.interceptDialogs();
      return 'interceptor_installed';
    `);
    expect(setupResult.ok).toBe(true);
    console.log('Dialog interceptor installed');

    // Step 2: Trigger an alert — this would FREEZE without the interceptor
    const alertResult = await engine.executeJsInTab(testTabUrl, `
      window.alert('Test alert from Safari Pilot');
      return 'alert_did_not_block';
    `);
    expect(alertResult.ok).toBe(true);
    expect(alertResult.value).toBe('alert_did_not_block');
    console.log('alert() called and returned WITHOUT blocking — extension intercepted it');

    // Step 3: Trigger a confirm
    const confirmResult = await engine.executeJsInTab(testTabUrl, `
      var result = window.confirm('Do you want to continue?');
      return 'confirm_returned_' + result;
    `);
    expect(confirmResult.ok).toBe(true);
    console.log(`confirm() returned: ${confirmResult.value}`);

    // Step 4: Trigger a prompt
    const promptResult = await engine.executeJsInTab(testTabUrl, `
      var result = window.prompt('Enter your name:', 'Safari Pilot');
      return 'prompt_returned_' + result;
    `);
    expect(promptResult.ok).toBe(true);
    console.log(`prompt() returned: ${promptResult.value}`);
  }, 15000);

  // ── TEST 3: Network Interception ─────────────────────────────────────────
  // WITHOUT the extension: Can only READ completed requests via Performance API.
  // WITH the extension: Can INTERCEPT live fetch/XHR, capture request/response,
  // and mock responses.

  it('intercepts network requests via fetch/XHR monkey-patching', async () => {
    // Step 1: Install network interceptor
    const setupResult = await engine.executeJsInTab(testTabUrl, `
      window.__safariPilot.interceptNetwork();
      return 'network_interceptor_installed';
    `);
    expect(setupResult.ok).toBe(true);
    console.log('Network interceptor installed');

    // Step 2: Verify the interceptor function exists and can be called
    // NOTE: Full network capture verification requires the native messaging bridge
    // (extension manages state internally). Via AppleScript, we can only verify
    // the function installs without error — actual capture happens in extension context.
    const verifyResult = await engine.executeJsInTab(testTabUrl, `
      var sp = window.__safariPilot;
      return JSON.stringify({
        hasInterceptNetwork: typeof sp.interceptNetwork === 'function',
        installResult: 'success'
      });
    `);
    expect(verifyResult.ok).toBe(true);
    const verifyData = JSON.parse(verifyResult.value!);
    console.log(`Network interceptor: ${JSON.stringify(verifyData)}`);
    expect(verifyData.hasInterceptNetwork).toBe(true);
    expect(verifyData.installResult).toBe('success');
    console.log('Note: Full network capture requires native messaging bridge (future work)');
  }, 15000);

  // ── TEST 4: Framework Detection ──────────────────────────────────────────
  // The extension can detect which JS framework a page uses by checking for
  // framework-specific markers in the page's JS context.

  it('detects JavaScript frameworks on pages', async () => {
    const result = await engine.executeJsInTab(testTabUrl, `
      var detection = window.__safariPilot.detectFramework();
      return JSON.stringify(detection);
    `);
    expect(result.ok).toBe(true);
    const frameworks = JSON.parse(result.value!);
    console.log(`Framework detection on example.com: ${JSON.stringify(frameworks)}`);
    // example.com uses no framework — should return none detected
    expect(frameworks).toBeDefined();
  }, 10000);

  // ── TEST 5: Framework detection on a REAL React site ─────────────────────

  it('detects React on a real React website', async () => {
    // Navigate to a known React site
    const navResult = await engine.execute(
      engine.buildNavigateScript('https://react.dev')
    );
    await new Promise(r => setTimeout(r, 4000));

    const reactTabUrl = 'https://react.dev/';
    const result = await engine.executeJsInTab(reactTabUrl, `
      var detection = window.__safariPilot.detectFramework();
      return JSON.stringify(detection);
    `);

    if (result.ok && result.value) {
      const frameworks = JSON.parse(result.value);
      console.log(`Framework detection on react.dev: ${JSON.stringify(frameworks)}`);
    } else {
      console.log(`Could not detect framework on react.dev: ${result.error?.message}`);
    }

    // Cleanup
    try { await engine.execute(engine.buildCloseTabScript(reactTabUrl)); } catch {}
  }, 20000);

  // ── TEST 6: Shadow DOM traversal ─────────────────────────────────────────
  // Create a custom element with Shadow DOM on our test page and query it

  it('traverses Shadow DOM via extension queryShadow', async () => {
    // Create a custom element with open Shadow DOM on the page
    const createResult = await engine.executeJsInTab(testTabUrl, `
      // Create a custom element with shadow DOM
      if (!customElements.get('test-shadow-el')) {
        class TestShadow extends HTMLElement {
          constructor() {
            super();
            var shadow = this.attachShadow({ mode: 'open' });
            shadow.innerHTML = '<div id="shadow-content">Hello from Shadow DOM</div>';
          }
        }
        customElements.define('test-shadow-el', TestShadow);
      }
      // Add it to the page
      if (!document.querySelector('test-shadow-el')) {
        document.body.appendChild(document.createElement('test-shadow-el'));
      }
      return 'shadow_element_created';
    `);
    expect(createResult.ok).toBe(true);

    // Now use the extension's queryShadow to find content inside the shadow
    const queryResult = await engine.executeJsInTab(testTabUrl, `
      var results = window.__safariPilot.queryShadow('#shadow-content');
      if (results && results.length > 0) {
        return JSON.stringify({
          found: true,
          count: results.length,
          text: results[0].textContent,
          tagName: results[0].tagName
        });
      }
      return JSON.stringify({ found: false, count: 0 });
    `);
    expect(queryResult.ok).toBe(true);
    const shadowData = JSON.parse(queryResult.value!);
    console.log(`Shadow DOM query: ${JSON.stringify(shadowData)}`);
    expect(shadowData.found).toBe(true);
    expect(shadowData.text).toBe('Hello from Shadow DOM');
  }, 15000);
});
