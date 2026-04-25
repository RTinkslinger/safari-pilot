/**
 * Phase 2 validation: Page Understanding
 *
 * The Playwright gap closer. Proves safari_snapshot returns ARIA tree with refs,
 * and all extraction tools return real content from real pages.
 *
 * Uses the shared MCP client (see test/helpers/shared-client.ts) — one
 * server spawn per test run, tab-level isolation with unique URL markers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('Phase 2: Page Understanding', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let tabUrl: string;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;

    // Open a content-rich page
    const unique = `https://example.com/?sp_p2=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: unique }, nextId());
    tabUrl = tab.tabUrl;
    await new Promise(r => setTimeout(r, 3000));
  }, 30000);

  afterAll(async () => {
    if (client && tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ }
    }
  });

  // ── 2.1 ARIA tree snapshot with refs ─────────────────────────────────────
  it('2.1 safari_snapshot returns ARIA tree with element refs', async () => {
    const result = await callTool(
      client, 'safari_snapshot',
      { tabUrl },
      nextId(),
      15000,
    );
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    // SD-07 strengthened oracle: ref= anywhere in the payload could be
    // satisfied by an error envelope or a stub returning {hint:'ref=eN'}.
    // A real ARIA snapshot of example.com has a heading, a link, and
    // multiple refs — at minimum >200 chars of YAML/JSON. Add a length
    // guard AND the ref-pattern match AND an expected page-specific
    // landmark (the <h1>Example Domain heading).
    expect(text).toContain('ref=');
    expect(text.length).toBeGreaterThan(200);
    expect(text.toLowerCase()).toContain('example');
  }, 20000);

  // ── 2.2 Get page text ───────────────────────────────────────────────────
  it('2.2 safari_get_text returns visible page text', async () => {
    const result = await callTool(
      client, 'safari_get_text',
      { tabUrl },
      nextId(),
      15000,
    );
    const text = typeof result === 'string' ? result : (result.text ?? JSON.stringify(result));
    // example.com has "Example Domain" as heading
    expect(text).toContain('Example Domain');
  }, 20000);

  // ── 2.3 Get page HTML ──────────────────────────────────────────────────
  it('2.3 safari_get_html returns page HTML', async () => {
    const result = await callTool(
      client, 'safari_get_html',
      { tabUrl },
      nextId(),
      15000,
    );
    const html = typeof result === 'string' ? result : (result.html ?? JSON.stringify(result));
    expect(html).toContain('<h1>');
    expect(html).toContain('Example Domain');
  }, 20000);

  // ── 2.5 Extract links ──────────────────────────────────────────────────
  it('2.5 safari_extract_links returns page links', async () => {
    const result = await callTool(
      client, 'safari_extract_links',
      { tabUrl },
      nextId(),
      15000,
    );
    const text = JSON.stringify(result);
    // example.com has a link to iana.org
    expect(text).toContain('iana.org');
  }, 20000);

  // ── 2.7 Extract metadata ───────────────────────────────────────────────
  it('2.7 safari_extract_metadata returns page metadata', async () => {
    const result = await callTool(
      client, 'safari_extract_metadata',
      { tabUrl },
      nextId(),
      15000,
    );
    const text = JSON.stringify(result);
    expect(text).toContain('Example Domain');
  }, 20000);

  // ── Engine verification ─────────────────────────────────────────────────
  it('extraction tools route through extension engine', async () => {
    const raw = await rawCallTool(
      client, 'safari_get_text',
      { tabUrl },
      nextId(),
      15000,
    );
    expect(raw.meta?.engine).toBe('extension');
  }, 20000);
});
