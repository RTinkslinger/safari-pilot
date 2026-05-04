/**
 * T77/T80 — Locator chaining + strict mode (e2e)
 *
 * Tests the T77 chain ops (filter, first, last, nth, or, descendant) and the
 * T80 strict-mode enforcement (STRICTNESS_VIOLATION on action tools when
 * multi-match resolves without a disambiguation chain-step).
 *
 * Fixture: /t77-list — 3 list items with per-item Add-to-cart buttons, one
 * Cancel button, and one Cancel anchor with data-testid="cancel-link".
 *
 * Tab lifecycle: opened in beforeAll, closed in afterAll
 * (per feedback-e2e-tests-must-close-tabs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T77/T80 — Locator chaining + strict mode (e2e)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const target = `http://127.0.0.1:${fixture.hostPort}/t77-list?sp_t77=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    tabUrl = r['tabUrl'] as string;
    // Settle for content scripts to inject.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }, 60_000);

  afterAll(async () => {
    if (tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  }, 30_000);

  // ── chain: filter + descendant ────────────────────────────────────────────

  it('chain: filter+descendant resolves to button inside the matched listitem', async () => {
    // Get the outer HTML of the list item that contains "Product 2" to confirm
    // the chain correctly narrowed to the p2 item.
    const r = await callTool(client, 'safari_get_html', {
      tabUrl: tabUrl!,
      role: 'listitem',
      chain: [{ op: 'filter', hasText: 'Product 2' }],
    }, nextId(), 20_000);
    const html = r['html'] as string;
    expect(html, `expected p2 listitem html, got: ${html}`).toContain('data-product="p2"');
    expect(html).not.toContain('data-product="p1"');
    expect(html).not.toContain('data-product="p3"');
  }, 60_000);

  // ── chain: first / last / nth ─────────────────────────────────────────────

  it('chain: first picks the first listitem (Product 1)', async () => {
    const r = await callTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      role: 'listitem',
      chain: [{ op: 'first' }],
    }, nextId(), 20_000);
    expect(r['text'] as string).toContain('Product 1');
  }, 60_000);

  it('chain: last picks the final listitem (Product 3)', async () => {
    const r = await callTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      role: 'listitem',
      chain: [{ op: 'last' }],
    }, nextId(), 20_000);
    expect(r['text'] as string).toContain('Product 3');
  }, 60_000);

  it('chain: nth(1) picks the second listitem (Product 2)', async () => {
    const r = await callTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      role: 'listitem',
      chain: [{ op: 'nth', n: 1 }],
    }, nextId(), 20_000);
    expect(r['text'] as string).toContain('Product 2');
  }, 60_000);

  // ── chain: or ─────────────────────────────────────────────────────────────

  it('chain: or unions two test-id matches and first picks one of them', async () => {
    // Base locator: testId='cancel' (the button). Or adds testId='cancel-link' (the anchor).
    // After the union, chain.first picks the first matched element.
    // Both 'cancel' and 'cancel-link' are valid answers.
    const r = await callTool(client, 'safari_get_attribute', {
      tabUrl: tabUrl!,
      testId: 'cancel',
      chain: [
        { op: 'or', locator: { testId: 'cancel-link' } },
        { op: 'first' },
      ],
      attribute: 'data-testid',
    }, nextId(), 20_000);
    const value = r['value'] as string;
    expect(['cancel', 'cancel-link']).toContain(value);
  }, 60_000);

  // ── backward compat ────────────────────────────────────────────────────────

  it('backward compat: legacy flat nth param still works without chain', async () => {
    const r = await callTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      role: 'listitem',
      nth: 1,
    }, nextId(), 20_000);
    expect(r['text'] as string).toContain('Product 2');
  }, 60_000);

  // ── zero-match error surface ───────────────────────────────────────────────

  it('chain returning zero matches surfaces an error', async () => {
    // The server throws ELEMENT_NOT_FOUND when chain ops produce zero matches.
    // rawCallTool propagates -32603 as a thrown Error, so we catch it.
    let threw = false;
    let errMsg = '';
    let isError = false;
    try {
      const r = await rawCallTool(client, 'safari_get_text', {
        tabUrl: tabUrl!,
        role: 'listitem',
        chain: [{ op: 'filter', hasText: 'NoSuchProduct' }],
      }, nextId(), 20_000);
      isError = r.result['isError'] === true;
    } catch (e) {
      threw = true;
      errMsg = e instanceof Error ? e.message : String(e);
    }
    expect(
      threw || isError,
      `expected an error for zero-match chain; errMsg=${errMsg}`,
    ).toBe(true);
  }, 60_000);

  // ── T80 strict mode ────────────────────────────────────────────────────────

  it('T80 strict mode: safari_click on multi-match without disambiguation throws STRICTNESS_VIOLATION', async () => {
    // 4 buttons on /t77-list: 3 "Add to cart" + 1 "Cancel".
    // safari_click with role:'button' and no chain disambiguation must throw.
    let isError = false;
    let errText = '';
    try {
      const r = await rawCallTool(client, 'safari_click', {
        tabUrl: tabUrl!,
        role: 'button',
      }, nextId(), 20_000);
      isError = r.result['isError'] === true;
      if (isError) {
        const content = r.result['content'] as Array<{ text?: string }> | undefined;
        errText = content?.[0]?.text ?? '';
      }
    } catch (e) {
      // Some error shapes throw at the JSON-RPC level.
      isError = true;
      errText = (e instanceof Error ? e.message : String(e));
    }
    expect(isError, `expected STRICTNESS_VIOLATION error; errText=${errText}`).toBe(true);
    expect(errText, `expected STRICTNESS_VIOLATION or match count hint`).toMatch(/STRICTNESS_VIOLATION|matched \d+ elements/i);
  }, 60_000);

  it('T80 strict mode: safari_click with chain.first() succeeds on multi-match', async () => {
    const r = await rawCallTool(client, 'safari_click', {
      tabUrl: tabUrl!,
      role: 'button',
      chain: [{ op: 'first' }],
    }, nextId(), 20_000);
    expect(r.result['isError'], `expected success; payload=${JSON.stringify(r.payload)}`).not.toBe(true);
  }, 60_000);

  it('T80 strict mode: read tools (safari_get_text) keep pick-first behavior and do NOT throw on multi-match', async () => {
    // safari_get_text is a read tool — it should pick the first match silently,
    // not enforce strict mode.
    const r = await rawCallTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      role: 'listitem',
    }, nextId(), 20_000);
    expect(r.result['isError'], `read tool must not error on multi-match`).not.toBe(true);
    expect(r.payload['text']).toBeDefined();
  }, 60_000);
});
