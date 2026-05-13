/**
 * v0.1.34 Tasks 12-14 — e2e tests for sentinel-routed extraction tools on a
 * TT-strict (`require-trusted-types-for 'script'`) page.
 *
 * Verifies safari_get_text / safari_query_all / safari_snapshot succeed after
 * their JS-string leaf-read transports were replaced with __SP_<TOOL>__:<json>
 * sentinels in extension/content-main.js (and helper functions in
 * extension/locator.js). On a TT-strict page, the previous
 * `new Function(params.script)` path is rejected by the browser; the sentinel
 * path bypasses that gate.
 *
 * NOTE: tests will FAIL when run against an installed extension that predates
 * T12-T14 — expected per the batched-rebuild design (rebuild owned by T20).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

function startExtractionFixture(): { server: HttpServer; url: () => string } {
  const page = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>TT-strict extraction fixture</title>
</head><body>
<h1 id="hero">Hero text content</h1>
<ul id="items">
  <li class="item">Item one</li>
  <li class="item">Item two</li>
  <li class="item">Item three</li>
</ul>
<article id="article">
  <h2>Article title</h2>
  <p>First paragraph of article body.</p>
  <p>Second paragraph here.</p>
</article>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "require-trusted-types-for 'script'",
    });
    res.end(page);
  });
  server.listen(0);
  const addr = server.address() as AddressInfo;
  return { server, url: () => `http://127.0.0.1:${addr.port}/` };
}

describe('CSP extraction sentinels (v0.1.34 Tasks 12-14)', () => {
  let fx: ReturnType<typeof startExtractionFixture>;
  let client: McpTestClient;
  let nextId: () => number;
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    fx = startExtractionFixture();
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

  it('safari_get_text reads textContent on tt-strict pages (T12)', async () => {
    const target = `${fx.url()}?sp_t12=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const result = await callTool(client, 'safari_get_text', { tabUrl, selector: '#hero' }, nextId(), 15_000);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.text).toBe('Hero text content');
    expect(parsed.truncated).toBe(false);
  }, 60_000);

  it('safari_query_all returns all matching items on tt-strict pages (T13)', async () => {
    const target = `${fx.url()}?sp_t13=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const result = await callTool(client, 'safari_query_all', { tabUrl, selector: '.item' }, nextId(), 15_000);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed.items.length).toBe(3);
    expect(parsed.count).toBe(3);
  }, 60_000);

  it('safari_snapshot captures DOM on tt-strict pages (T14)', async () => {
    const target = `${fx.url()}?sp_t14=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const result = await callTool(client, 'safari_snapshot', { tabUrl }, nextId(), 15_000);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    const serialized = JSON.stringify(parsed);
    expect(serialized).toContain('Hero text content');
  }, 60_000);
});
