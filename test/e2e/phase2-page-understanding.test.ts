/**
 * Phase 2 validation: Page Understanding
 *
 * The Playwright gap closer. Proves safari_snapshot returns ARIA tree with refs,
 * and all extraction tools return real content from real pages.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initClient, callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';

describe('Phase 2: Page Understanding', () => {
  let client: McpTestClient;
  let nextId: number;
  let tabUrl: string;

  beforeAll(async () => {
    const result = await initClient('dist/index.js');
    client = result.client;
    nextId = result.nextId;

    // Open a content-rich page
    const tab = await callTool(client, 'safari_new_tab', { url: 'https://example.com' }, nextId++);
    tabUrl = tab.tabUrl;
    await new Promise(r => setTimeout(r, 3000));
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
  });

  // ── 2.1 ARIA tree snapshot with refs ─────────────────────────────────────
  it('2.1 safari_snapshot returns ARIA tree with element refs', async () => {
    const result = await callTool(
      client, 'safari_snapshot',
      { tabUrl },
      nextId++,
      15000,
    );
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    // Snapshot should contain ARIA roles and ref attributes
    // Example.com has at least a heading and a link
    expect(text).toContain('ref=');
  }, 20000);

  // ── 2.2 Get page text ───────────────────────────────────────────────────
  it('2.2 safari_get_text returns visible page text', async () => {
    const result = await callTool(
      client, 'safari_get_text',
      { tabUrl },
      nextId++,
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
      nextId++,
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
      nextId++,
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
      nextId++,
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
      nextId++,
      15000,
    );
    expect(raw.meta?.engine).toBe('extension');
  }, 20000);
});
