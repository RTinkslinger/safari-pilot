/**
 * v0.1.34 Tasks 4-6 — e2e tests for ISOLATED-world page-info tools.
 *
 * Verifies the three new sentinel-based tools succeed on a TT-strict page
 * (where safari_evaluate fails per csp-baseline-tt-strict.test.ts). The
 * win condition for the sprint architecture: ISOLATED world is CSP-immune.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startTrustedTypesFixture } from '../fixtures/csp-trusted-types.js';

describe('safari_get_page_info (v0.1.34 Task 4)', () => {
  let fx: ReturnType<typeof startTrustedTypesFixture>;
  let client: McpTestClient;
  let nextId: () => number;
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    fx = startTrustedTypesFixture();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 60_000);

  afterAll(async () => {
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId()); } catch { /* best-effort */ }
    }
    fx?.server.close();
  }, 30_000);

  it('returns title, url, body_snippet, meta_description on a TT-strict page', async () => {
    const target = `${fx.url()}?sp_t4_a=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const parsed = await callTool(client, 'safari_get_page_info', { tabUrl }, nextId(), 15_000);
    expect(parsed['title']).toBe('TT-strict fixture');
    expect(String(parsed['url'])).toContain('sp_t4_a=');
    expect(String(parsed['body_snippet'])).toContain('TT-strict fixture body');
    expect(parsed['meta_description']).toBe('Trusted Types strict fixture');
    expect(parsed['lang']).toBeDefined();
  }, 30_000);

  it('caps body_snippet at the requested bodyMaxChars', async () => {
    const target = `${fx.url()}?sp_t4_b=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const parsed = await callTool(client, 'safari_get_page_info', { tabUrl, bodyMaxChars: 10 }, nextId(), 15_000);
    expect(String(parsed['body_snippet']).length).toBeLessThanOrEqual(10);
    expect(parsed['body_truncated']).toBe(true);
  }, 30_000);
});

describe('safari_get_meta_tags (v0.1.34 Task 5)', () => {
  let fx: ReturnType<typeof startTrustedTypesFixture>;
  let client: McpTestClient;
  let nextId: () => number;
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    fx = startTrustedTypesFixture();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 60_000);

  afterAll(async () => {
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId()); } catch { /* best-effort */ }
    }
    fx?.server.close();
  }, 30_000);

  it('returns all meta tags by default', async () => {
    const target = `${fx.url()}?sp_t5_a=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const parsed = await callTool(client, 'safari_get_meta_tags', { tabUrl }, nextId(), 15_000);
    const tags = parsed['tags'] as Array<{ name: string; content: string; attr_source: string }>;
    expect(Array.isArray(tags)).toBe(true);
    const desc = tags.find((t) => t.name === 'description');
    expect(desc).toBeDefined();
    expect(desc?.content).toBe('Trusted Types strict fixture');
    expect(desc?.attr_source).toBe('name');
  }, 30_000);

  it('filters by names when whitelist provided', async () => {
    const target = `${fx.url()}?sp_t5_b=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const parsed = await callTool(client, 'safari_get_meta_tags', { tabUrl, names: ['description', 'og:title'] }, nextId(), 15_000);
    const tags = parsed['tags'] as Array<{ name: string }>;
    for (const tag of tags) {
      expect(['description', 'og:title']).toContain(tag.name);
    }
  }, 30_000);
});

/**
 * Local fixture for T6 — page with multiple selectable elements and a long
 * paragraph for truncation testing. Also serves with TT-strict CSP so the
 * test also confirms the ISOLATED-world CSP bypass on a non-shared fixture.
 */
function startExtractTextFixture(port = 0): { server: HttpServer; url: () => string } {
  const page = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>extract-text fixture</title>
</head><body>
<h1 id="hero">Hero heading</h1>
<ul id="items"><li class="item">Item one</li><li class="item">Item two</li><li class="item">Item three</li></ul>
<p id="long">This is a long paragraph used to verify truncation in extract_text_window.</p>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "require-trusted-types-for 'script'",
    });
    res.end(page);
  });
  server.listen(port);
  return {
    server,
    url: () => {
      const addr = server.address() as AddressInfo;
      return `http://127.0.0.1:${addr.port}/`;
    },
  };
}

describe('safari_extract_text_window (v0.1.34 Task 6)', () => {
  let fx: { server: HttpServer; url: () => string };
  let client: McpTestClient;
  let nextId: () => number;
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    fx = startExtractTextFixture();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 60_000);

  afterAll(async () => {
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId()); } catch { /* best-effort */ }
    }
    await new Promise<void>((r) => fx.server.close(() => r()));
  }, 30_000);

  it('returns text of subtree matching selector', async () => {
    const target = `${fx.url()}?sp_t6_a=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const parsed = await callTool(client, 'safari_extract_text_window', { tabUrl, selector: '#hero' }, nextId(), 15_000);
    expect(String(parsed['text'])).toContain('Hero heading');
    expect(parsed['selector_matched_count']).toBe(1);
    expect(parsed['truncated']).toBe(false);
  }, 30_000);

  it('caps text at max_chars and reports truncated', async () => {
    const target = `${fx.url()}?sp_t6_b=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const parsed = await callTool(client, 'safari_extract_text_window', { tabUrl, selector: '#long', max_chars: 10 }, nextId(), 15_000);
    expect(String(parsed['text']).length).toBeLessThanOrEqual(10);
    expect(parsed['truncated']).toBe(true);
  }, 30_000);

  it('returns 0 matches when selector does not match', async () => {
    const target = `${fx.url()}?sp_t6_c=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const parsed = await callTool(client, 'safari_extract_text_window', { tabUrl, selector: '#nope' }, nextId(), 15_000);
    expect(parsed['selector_matched_count']).toBe(0);
    expect(parsed['text']).toBe('');
  }, 30_000);
});
