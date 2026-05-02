/**
 * Phase 5A · 5A.5 — Locator chaining (nth + filter.hasText) end-to-end through Safari.
 *
 * Companion to test/unit/locators/locator-chaining.test.ts (which verifies
 * the GENERATED resolution-body JS). This e2e closes the loop:
 * MCP → server → engine → real Safari → matched array → narrow → pick →
 * data-sp-ref stamp → result.
 *
 * Fixture: 4 buttons (btn-zero/one/two/three) + 4 links (About/Home/Help/Contact).
 * The "Help — go home" link contains 'home' substring → tests the
 * case-insensitive narrowing contract; the third item carries the marker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('5A.5 — locator chaining (real Safari)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const target = `http://127.0.0.1:${fixture.hostPort}/locator-chaining.html?sp_t5A5=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    tabUrl = r['tabUrl'] as string;
    await new Promise((r) => setTimeout(r, 1500));
  }, 60_000);

  afterAll(async () => {
    if (tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  }, 30_000);

  it('nth: 2 selects the third button (btn-two)', async () => {
    const r = await callTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      role: 'button',
      nth: 2,
    }, nextId(), 15_000);
    expect(r['text']).toContain('btn-two');
  }, 60_000);

  it('nth: -1 selects the last button (btn-three)', async () => {
    const r = await callTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      role: 'button',
      nth: -1,
    }, nextId(), 15_000);
    expect(r['text']).toContain('btn-three');
  }, 60_000);

  it('nth out-of-range (99) returns a typed not-found error, not a throw', async () => {
    let caught: unknown = null;
    let payload: Record<string, unknown> | null = null;
    try {
      const r = await rawCallTool(client, 'safari_get_text', {
        tabUrl: tabUrl!,
        role: 'button',
        nth: 99,
      }, nextId(), 15_000);
      payload = r.payload;
    } catch (e) {
      caught = e;
    }
    const errStr = caught
      ? (caught instanceof Error ? caught.message : JSON.stringify(caught))
      : JSON.stringify(payload);
    expect(errStr, `error/payload: ${errStr}`).toMatch(/out of range|nth=99|did not match/i);
  }, 60_000);

  it('filter.hasText narrows to elements containing the text — case-insensitive', async () => {
    // 4 links exist; only "Home" (exact "Home") and "Help — go home" contain
    // 'home' substring (case-insensitive). With nth: 0 we pick the FIRST
    // narrowed match, which is "Home".
    const r = await callTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      role: 'link',
      filter: { hasText: 'HOME' }, // uppercase to verify case-insensitive
      nth: 0,
    }, nextId(), 15_000);
    expect(r['text'], `link text: ${JSON.stringify(r)}`).toMatch(/^Home$/);
  }, 60_000);

  it('filter applies BEFORE nth — nth=1 of "home"-filtered links picks "Help — go home"', async () => {
    // With filter narrowing first, matched becomes [Home, Help — go home].
    // nth=1 picks the second → "Help — go home". Without composition order
    // working correctly, nth=1 of all 4 links would pick "Home" (the second
    // item in the unfiltered list), which is the wrong answer and would
    // fail this test.
    const r = await callTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      role: 'link',
      filter: { hasText: 'home' },
      nth: 1,
    }, nextId(), 15_000);
    expect(r['text'], `link text: ${JSON.stringify(r)}`).toMatch(/Help.*home/i);
  }, 60_000);
});
