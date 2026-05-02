/**
 * Phase 5A · 5A.6 — multi-element extraction native API against real Safari.
 *
 * Companion to test/unit/tools/multi-element-extraction.test.ts (which verifies
 * the GENERATED action-JS string). This e2e closes the loop end-to-end:
 * MCP → server → engine → real Safari → real DOM array → JSON-serializable
 * primitive values back through the storage bus.
 *
 * Fixture: 3 <li class="item"> elements + 3 <a> tags (one without an href).
 * Tests assert the array shape and primitive-value contract spec'd in 5A.6.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('5A.6 — multi-element extraction (real Safari)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const target = `http://127.0.0.1:${fixture.hostPort}/multi-extract.html?sp_t5A6=${Date.now()}`;
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

  it('safari_get_text multi:true returns the text of every matching element', async () => {
    const r = await callTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      selector: 'li.item',
      multi: true,
    }, nextId(), 15_000);
    expect(r['count'], `count: ${JSON.stringify(r['count'])}`).toBe(3);
    const matches = r['matches'] as string[];
    expect(matches).toHaveLength(3);
    // Order must match DOM order. innerText/textContent gives the visible text.
    expect(matches[0]).toBe('alpha');
    expect(matches[1]).toBe('beta');
    expect(matches[2]).toBe('gamma');
    // Each match must be a string primitive — not a DOM node, not an object.
    for (const m of matches) expect(typeof m).toBe('string');
  }, 60_000);

  it('safari_get_text multi:false (default) still returns the single-element shape', async () => {
    const r = await callTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      selector: 'li.item',
    }, nextId(), 15_000);
    // Single mode response has top-level `text`, NOT `matches`.
    expect(r['text'], 'expected single text field').toBe('alpha');
    expect(r['matches'], 'multi:false must NOT return matches').toBeUndefined();
  }, 60_000);

  it('safari_get_html multi:true returns the outerHTML of every matching element', async () => {
    const r = await callTool(client, 'safari_get_html', {
      tabUrl: tabUrl!,
      selector: 'li.item',
      multi: true,
    }, nextId(), 15_000);
    expect(r['count']).toBe(3);
    const matches = r['matches'] as string[];
    expect(matches).toHaveLength(3);
    // outerHTML default — each entry should contain the <li> wrapping.
    expect(matches[0]).toMatch(/<li[^>]*>alpha<\/li>/);
    expect(matches[1]).toMatch(/<li[^>]*>beta<\/li>/);
    expect(matches[2]).toMatch(/<li[^>]*>gamma<\/li>/);
  }, 60_000);

  it('safari_get_attribute multi:true returns the attribute for every match, with null for missing', async () => {
    const r = await callTool(client, 'safari_get_attribute', {
      tabUrl: tabUrl!,
      selector: '#t5a6-links a',
      attribute: 'href',
      multi: true,
    }, nextId(), 15_000);
    expect(r['count']).toBe(3);
    const matches = r['matches'] as Array<string | null>;
    expect(matches).toHaveLength(3);
    expect(matches[0]).toBe('https://a.test/1');
    // The middle anchor has no href — must surface as null, not undefined or "".
    expect(matches[1], `middle anchor without href should be null; got ${JSON.stringify(matches[1])}`).toBeNull();
    expect(matches[2]).toBe('https://b.test/2');
  }, 60_000);
});
