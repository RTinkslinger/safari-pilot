/**
 * v0.1.34 Task 15 (a-e) — e2e tests for sentinel-routed structured-extraction
 * tools on a TT-strict (`require-trusted-types-for 'script'`) page.
 *
 * Verifies safari_smart_scrape, safari_extract_tables, safari_extract_links,
 * safari_extract_images, safari_extract_metadata succeed after their
 * JS-string leaf-read transports were replaced with __SP_<TOOL>__:<json>
 * sentinels in extension/content-main.js (and the smartScrape helper in
 * extension/locator.js).
 *
 * NOTE: tests will FAIL when run against an installed extension that predates
 * T15 — expected per the batched-rebuild design (rebuild owned by T20).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

function startStructuredFixture(): { server: HttpServer; url: () => string } {
  const page = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>TT-strict structured-extraction fixture</title>
<meta name="description" content="Page for testing structured extraction on TT-strict">
<meta name="author" content="Safari Pilot">
<meta property="og:title" content="Article title">
<meta property="og:image" content="https://example.com/og.png">
<meta name="twitter:card" content="summary">
<link rel="canonical" href="https://example.com/canonical">
</head><body>
<article id="article">
  <h1>Article title</h1>
  <p>Sample article body for smart_scrape.</p>
  <a href="https://example.com/page1">Link one</a>
  <a href="/internal-page">Internal link</a>
  <img src="https://example.com/img1.png" alt="Image one" width="200" height="100">
  <img src="https://example.com/img2.png" alt="Image two" width="200" height="100">
  <table id="data">
    <thead><tr><th>Col A</th><th>Col B</th></tr></thead>
    <tbody><tr><td>1</td><td>x</td></tr><tr><td>2</td><td>y</td></tr></tbody>
  </table>
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

describe('CSP structured-extraction sentinels (v0.1.34 Task 15)', () => {
  let fx: ReturnType<typeof startStructuredFixture>;
  let client: McpTestClient;
  let nextId: () => number;
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    fx = startStructuredFixture();
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

  it('safari_smart_scrape works on tt-strict pages (T15a)', async () => {
    const target = `${fx.url()}?sp_t15a=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const result = await callTool(
      client,
      'safari_smart_scrape',
      { tabUrl, schema: { properties: { description: {}, author: {} } } },
      nextId(),
      15_000,
    );
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.data).toBeDefined();
    expect(parsed.fieldsExtracted).toBe(2);
    // description is sourced from meta name="description"
    expect(parsed.data.description).toContain('structured extraction');
  }, 60_000);

  it('safari_extract_tables works on tt-strict pages (T15b)', async () => {
    const target = `${fx.url()}?sp_t15b=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const result = await callTool(client, 'safari_extract_tables', { tabUrl }, nextId(), 15_000);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(1);
    expect(parsed.tables[0].headers).toEqual(['Col A', 'Col B']);
    expect(parsed.tables[0].rows.length).toBe(2);
  }, 60_000);

  it('safari_extract_links works on tt-strict pages (T15c)', async () => {
    const target = `${fx.url()}?sp_t15c=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const result = await callTool(client, 'safari_extract_links', { tabUrl }, nextId(), 15_000);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.count).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(parsed.links)).toBe(true);
  }, 60_000);

  it('safari_extract_images works on tt-strict pages (T15d)', async () => {
    const target = `${fx.url()}?sp_t15d=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const result = await callTool(client, 'safari_extract_images', { tabUrl }, nextId(), 15_000);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.count).toBe(2);
    expect(parsed.images[0].alt).toBe('Image one');
  }, 60_000);

  it('safari_extract_metadata works on tt-strict pages (T15e)', async () => {
    const target = `${fx.url()}?sp_t15e=${Date.now()}`;
    const newTab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = newTab['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((r) => setTimeout(r, 1500));

    const result = await callTool(client, 'safari_extract_metadata', { tabUrl }, nextId(), 15_000);
    const text = (result as { content: Array<{ text: string }> }).content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.meta).toBeDefined();
    expect(parsed.meta.description).toContain('structured extraction');
    expect(parsed.canonical).toBe('https://example.com/canonical');
    expect(parsed.openGraph.title).toBe('Article title');
  }, 60_000);
});
