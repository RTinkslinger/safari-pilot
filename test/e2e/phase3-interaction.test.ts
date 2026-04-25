/**
 * Phase 3 validation: Interaction (Click, Fill, Type)
 *
 * Proves interaction tools work with both CSS selectors and ref-based targeting.
 * Uses httpbin.org/forms/post (has text inputs, textarea, selects, buttons).
 *
 * Uses the shared MCP client (see test/helpers/shared-client.ts) — one
 * server spawn per test run, tab-level isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('Phase 3: Interaction', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let tabUrl: string;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;

    // httpbin.org doesn't support arbitrary query strings for sp_p3 marker
    // on every path (the /forms/post endpoint ignores them but keeps them
    // in the URL), so this is safe. Using ?sp_p3=<ts> for sweepability.
    const unique = `https://httpbin.org/forms/post?sp_p3=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: unique }, nextId());
    tabUrl = tab.tabUrl;
    await new Promise(r => setTimeout(r, 4000));
  }, 35000);

  afterAll(async () => {
    if (client && tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ }
    }
  });

  // ── 3.2 Fill input ──────────────────────────────────────────────────────
  it('3.2 safari_fill puts text into an input field', async () => {
    const result = await callTool(
      client, 'safari_fill',
      { tabUrl, selector: 'input[name="custname"]', value: 'Safari Pilot Test' },
      nextId(),
      15000,
    );
    const text = JSON.stringify(result);
    expect(text).toBeDefined();

    // Verify the value was actually set
    const verify = await callTool(
      client, 'safari_evaluate',
      { tabUrl, script: 'return document.querySelector("input[name=\\"custname\\"]").value' },
      nextId(),
      15000,
    );
    const val = typeof verify === 'string' ? verify : verify.value;
    expect(val).toBe('Safari Pilot Test');
  }, 30000);

  // ── 3.1 Click element ──────────────────────────────────────────────────
  it('3.1 safari_click triggers form submission, navigating /forms/post → /post', async () => {
    // SD-03 strict oracle. Original asserted JSON.stringify(result).toContain('clicked')
    // — any envelope containing the substring 'clicked' satisfied it. The
    // production click handler dispatches MouseEvent('click'); on httpbin's
    // submit button this triggers WebKit's native form-submission default
    // action, navigating /forms/post → /post. We discriminate on that URL
    // change: a stub that fabricates {clicked:true} without dispatching the
    // event cannot navigate the tab.
    const clickResult = await callTool(
      client, 'safari_click',
      { tabUrl, selector: '[type="submit"], button' },
      nextId(),
      15000,
    );
    expect(clickResult['clicked']).toBe(true);
    const element = clickResult['element'] as { tagName: string } | undefined;
    expect(element).toBeDefined();
    expect(element!.tagName).toMatch(/^(BUTTON|INPUT)$/);

    // Allow form submission + page load to settle.
    await new Promise(r => setTimeout(r, 2000));

    // Discriminator: pathname must be /post after the form submits. The
    // post-execution path of this safari_evaluate also refreshes the ownership
    // registry from `?sp_p3=...` to the new URL (server.ts:802-805 — extension
    // engine reports `_meta.tabUrl`, server calls tabOwnership.updateUrl).
    const verify = await callTool(
      client, 'safari_evaluate',
      { tabUrl, script: 'return document.location.pathname' },
      nextId(),
      15000,
    );
    const pathname = (verify as { value: string }).value;
    expect(pathname).toBe('/post');

    // Update test-scope tabUrl: the registry now tracks the post-submission
    // URL (httpbin.org/post is deterministic), so subsequent tests in this
    // file must use it. Without this line, 3.9 below would pass `?sp_p3=...`
    // to safari_navigate and hit TabUrlNotRecognizedError.
    tabUrl = 'https://httpbin.org/post';
  }, 30000);

  // ── 3.9 Wait for condition ──────────────────────────────────────────────
  it('3.9 safari_wait_for waits for an element', async () => {
    // Navigate to a fresh page first
    const nav = await callTool(
      client, 'safari_navigate',
      { url: 'https://example.com', tabUrl },
      nextId(),
      15000,
    );
    tabUrl = nav.url;
    await new Promise(r => setTimeout(r, 2000));

    // Wait for h1 to exist (should be immediate on example.com).
    // SD-07 bug-fix: pre-SD-07 the call used `selector`+`state` param names
    // that safari_wait_for does NOT read (handler expects `condition`+`value`
    // per src/tools/wait.ts:88-116). The old `expect(text).toBeDefined()`
    // oracle admitted the timeout-path envelope `{met: false, timedOut:
    // true}` as a pass. Fixed: correct param names + assert met=true.
    const result = await callTool(
      client, 'safari_wait_for',
      { tabUrl, condition: 'selector', value: 'h1', timeout: 5000 },
      nextId(),
      10000,
    );
    expect(result.met).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 25000);

  // ── Engine verification ─────────────────────────────────────────────────
  it('interaction tools route through extension engine', async () => {
    const raw = await rawCallTool(
      client, 'safari_click',
      { tabUrl, selector: 'h1' },
      nextId(),
      15000,
    );
    expect(raw.meta?.engine).toBe('extension');
  }, 20000);
});
