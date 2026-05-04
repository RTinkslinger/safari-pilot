/**
 * T78 — safari_query_all (e2e against real Safari)
 *
 * Verifies the multi-element extraction tool end-to-end:
 *   - Selector path returns rich payload {ref, tagName, text, attrs, boundingBox, visible}
 *   - Locator path returns all elements matching the locator
 *   - limit caps results and sets truncated:true
 *   - Refs returned (sp-xxxxxx scheme) are usable in safari_get_text and safari_click
 *   - Chain ops compose with query_all (filter)
 *
 * Fixture: /t78-grid — 4 cells, each containing a Buy button.
 *
 * Tab lifecycle: opened in beforeAll, closed in afterAll
 * (per feedback-e2e-tests-must-close-tabs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T78 — safari_query_all (e2e)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const target = `http://127.0.0.1:${fixture.hostPort}/t78-grid?sp_t78=${Date.now()}`;
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

  // ── selector path ─────────────────────────────────────────────────────────

  it('selector path: returns 4 cells with rich payload', async () => {
    const r = await callTool(client, 'safari_query_all', {
      tabUrl: tabUrl!,
      selector: '.cell',
    }, nextId(), 20_000);
    expect(r['count']).toBe(4);
    const items = r['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(4);
    expect(items[0]!['ref']).toMatch(/^sp-/);
    expect(items[0]!['tagName']).toBe('DIV');
    const attrs = items[0]!['attrs'] as Record<string, string>;
    expect(attrs['data-id']).toBe('c1');
    const bbox = items[0]!['boundingBox'] as { width: number };
    expect(bbox.width).toBeGreaterThan(0);
    expect(items[0]!['visible']).toBe(true);
  }, 60_000);

  // ── locator path ──────────────────────────────────────────────────────────

  it('locator path: returns all 4 button elements', async () => {
    const r = await callTool(client, 'safari_query_all', {
      tabUrl: tabUrl!,
      role: 'button',
    }, nextId(), 20_000);
    expect(r['count']).toBe(4);
    const items = r['items'] as Array<{ tagName: string }>;
    expect(items.every((i) => i.tagName === 'BUTTON')).toBe(true);
  }, 60_000);

  // ── limit ─────────────────────────────────────────────────────────────────

  it('limit caps results at 2 of 4 and sets truncated:true', async () => {
    const r = await callTool(client, 'safari_query_all', {
      tabUrl: tabUrl!,
      selector: '.cell',
      limit: 2,
    }, nextId(), 20_000);
    const items = r['items'] as unknown[];
    expect(items).toHaveLength(2);
    expect(r['count']).toBe(4);
    expect(r['truncated']).toBe(true);
  }, 60_000);

  // ── ref flow into existing tools ──────────────────────────────────────────

  it('ref from query_all is usable in safari_get_text', async () => {
    const q = await callTool(client, 'safari_query_all', {
      tabUrl: tabUrl!,
      selector: '.cell',
      limit: 1,
    }, nextId(), 20_000);
    const ref = ((q['items'] as Array<{ ref: string }>)[0]!).ref;
    expect(ref).toMatch(/^sp-/);
    const t = await callTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      ref,
    }, nextId(), 20_000);
    expect((t['text'] as string)).toContain('Alpha');
  }, 60_000);

  it('ref from query_all is usable in safari_click', async () => {
    const q = await callTool(client, 'safari_query_all', {
      tabUrl: tabUrl!,
      role: 'button',
      limit: 4,
    }, nextId(), 20_000);
    const buttons = q['items'] as Array<{ ref: string }>;
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    const secondRef = buttons[1]!.ref;
    // Clicking returns success (no STRICTNESS_VIOLATION since we're targeting by ref,
    // and ref selectors are exact-match by definition).
    const r = await rawCallTool(client, 'safari_click', {
      tabUrl: tabUrl!,
      ref: secondRef,
    }, nextId(), 20_000);
    expect(r.result['isError'], `expected success; payload=${JSON.stringify(r.payload)}`).not.toBe(true);
  }, 60_000);

  // ── chain composition ─────────────────────────────────────────────────────

  it('chain composes with query_all (filter narrows by hasText)', async () => {
    // All 4 buttons have text "Buy", so filter:hasText:"Buy" should keep all 4.
    const r = await callTool(client, 'safari_query_all', {
      tabUrl: tabUrl!,
      role: 'button',
      chain: [{ op: 'filter', hasText: 'Buy' }],
    }, nextId(), 20_000);
    expect(r['count']).toBe(4);
  }, 60_000);
});
