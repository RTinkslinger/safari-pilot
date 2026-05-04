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
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('Phase 3: Interaction', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let tabUrl: string;
  let fixture: FixtureServer;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;

    // T65 (2026-05-04): switched from httpbin.org/forms/post to local fixture.
    // Pre-T65 used httpbin.org which (a) is external + flaky, (b) exhibited an
    // unidentified browser-side behaviour where filling `input[name=custname]`
    // caused the tab to navigate before 3.1's explicit click, dropping the
    // original tabUrl from the extension cache and surfacing TAB_NOT_FOUND.
    // Local fixture (test/helpers/fixture-server.ts → /t65-form) serves the
    // same surface (text input + submit button) but does NOT navigate on fill —
    // only on the explicit click. Deterministic.
    const unique = `http://127.0.0.1:${fixture.hostPort}/t65-form?sp_p3=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: unique }, nextId());
    tabUrl = tab.tabUrl as string;
    await new Promise(r => setTimeout(r, 2000));
  }, 35000);

  afterAll(async () => {
    if (client && tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ }
    }
    if (fixture) await fixture.close();
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
  it('3.1 safari_click dispatches a real MouseEvent that reaches the page handler', async () => {
    // SD-03 strict oracle, T65 update. Original asserted on `pathname` change
    // post-form-submission, which depended on the page navigating from
    // /forms/post → /post. That setup hit a navigation race (filed as T74 —
    // safari_fill on a text input causes the tab to navigate before this test
    // runs, dropping the tabUrl from the extension cache).
    //
    // T65 fix: discriminate on a state variable set ONLY by a real MouseEvent
    // reaching the page-side click handler. The fixture (test/helpers/
    // fixture-server.ts → /t65-form) registers an explicit `click` listener
    // on the submit button that writes `window.__t65_clicked = { ... }` and
    // preventDefaults the form's submit so the tab does not navigate. A stub
    // safari_click that fabricates `{clicked: true}` without dispatching the
    // real MouseEvent leaves __t65_clicked undefined and fails the test.
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

    // Settle so the page-side click handler has run.
    await new Promise(r => setTimeout(r, 200));

    // Discriminator: a real MouseEvent reached the page-side handler.
    const verify = await callTool(
      client, 'safari_evaluate',
      { tabUrl, script: 'return JSON.stringify(window.__t65_clicked || null);' },
      nextId(),
      15000,
    );
    const raw = (verify as { value?: string; _rawText?: string }).value
      ?? (verify as { _rawText?: string })._rawText;
    expect(raw, 'verify call returned no value').toBeDefined();
    const parsed = JSON.parse(raw as string) as
      | null
      | { ts: number; button: number; isTrusted: boolean };
    expect(parsed, 'page-side __t65_clicked must be set — proves a real ' +
      'MouseEvent was dispatched, not a stubbed envelope').not.toBeNull();
    // button=0 = primary; isTrusted=false because synthetic events from
    // dispatchEvent are never trusted (only true user input is). Both
    // values prove the click came from JS-dispatched MouseEvent, exactly
    // matching the production handler's behaviour.
    expect(parsed!.button).toBe(0);
    expect(typeof parsed!.ts).toBe('number');
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
    tabUrl = nav.url as string;
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
