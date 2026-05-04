/**
 * T43 — e2e coverage for page-observation tools.
 *
 * Covers (one tool per assertion, real Safari, real MCP):
 *   safari_extract_images
 *   safari_extract_tables
 *   safari_extract_links
 *   safari_extract_metadata    (already had partial coverage in extraction.test
 *                               via 4 e2e specs; this exercises the MCP tool name
 *                               directly to keep the coverage report honest)
 *   safari_get_page_metrics
 *   safari_get_console_messages
 *   safari_take_screenshot
 *
 * One tab on a fixture page that contains: an <img>, a <table>, several <a>,
 * a <meta description>, and a script that emits console.log/warn/error
 * messages. All tools target that tab.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T43 — observation tools (real Safari)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;

    const target = `http://127.0.0.1:${fixture.hostPort}/t43-observation?sp_t43=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: target }, nextId());
    tabUrl = tab.tabUrl as string;
    await new Promise((r) => setTimeout(r, 2000));
  }, 35_000);

  afterAll(async () => {
    if (client && tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  });

  it('safari_extract_images returns the seeded <img> elements', async () => {
    const result = await callTool(client, 'safari_extract_images', { tabUrl }, nextId(), 15_000);
    const images = result.images as Array<{ src?: string; alt?: string }> | undefined;
    expect(images, `extract_images result: ${JSON.stringify(result)}`).toBeDefined();
    expect(images!.length).toBeGreaterThanOrEqual(1);
    const alts = images!.map((i) => i.alt);
    expect(alts).toContain('t43-observation-image');
  }, 20_000);

  it('safari_extract_tables returns the seeded <table>', async () => {
    const result = await callTool(client, 'safari_extract_tables', { tabUrl }, nextId(), 15_000);
    const tables = result.tables as Array<{ headers?: unknown; rows?: unknown[] }> | undefined;
    expect(tables, `extract_tables result: ${JSON.stringify(result)}`).toBeDefined();
    expect(tables!.length).toBeGreaterThanOrEqual(1);
    expect(tables![0].rows).toBeDefined();
    expect((tables![0].rows as unknown[]).length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it('safari_extract_links returns the seeded <a> elements', async () => {
    const result = await callTool(client, 'safari_extract_links', { tabUrl }, nextId(), 15_000);
    const links = result.links as Array<{ href?: string; text?: string }> | undefined;
    expect(links, `extract_links result: ${JSON.stringify(result)}`).toBeDefined();
    expect(links!.length).toBeGreaterThanOrEqual(2);
    const texts = links!.map((l) => l.text);
    expect(texts).toContain('t43 anchor one');
  }, 20_000);

  it('safari_extract_metadata returns the seeded <meta> + <title>', async () => {
    const result = await callTool(client, 'safari_extract_metadata', { tabUrl }, nextId(), 15_000);
    // Result shape (from src/tools/structured-extraction.ts):
    //   { meta: { title, description, author, keywords, ... },
    //     openGraph, twitter, jsonLd, canonical, url }
    const meta = result.meta as { title?: string; description?: string; author?: string } | undefined;
    expect(meta, `extract_metadata result: ${JSON.stringify(result)}`).toBeDefined();
    expect(meta!.title).toBe('T43 observation fixture');
    expect(meta!.description).toBe('seeded for safari_extract_metadata');
    expect(meta!.author).toBe('T43');
  }, 20_000);

  it('safari_get_page_metrics returns timing fields for the page', async () => {
    const result = await callTool(client, 'safari_get_page_metrics', { tabUrl }, nextId(), 15_000);
    // The handler returns whatever the perf API exposes; the surface is tool-
    // shaped. We assert the result is an object with at least one numeric
    // field so a stub returning `{}` would fail.
    expect(result).toBeDefined();
    const numericKeys = Object.entries(result).filter(([, v]) => typeof v === 'number');
    expect(
      numericKeys.length,
      `expected get_page_metrics to return at least one numeric field. Got: ${JSON.stringify(result)}`,
    ).toBeGreaterThan(0);
  }, 20_000);

  it('safari_get_console_messages captures messages emitted AFTER the tool installs its hook', async () => {
    // The handler installs `window.__safariPilotConsole` on first call —
    // messages emitted BEFORE the first call are lost (extraction.ts:517).
    // Pattern: prime the hook with one call, emit a marker via
    // safari_evaluate, then retrieve.
    await callTool(client, 'safari_get_console_messages', { tabUrl }, nextId(), 15_000);
    const marker = `T43_console_post_hook_${Date.now()}`;
    await callTool(
      client,
      'safari_evaluate',
      { tabUrl, script: `console.log(${JSON.stringify(marker)}); return null;` },
      nextId(),
      15_000,
    );
    const result = await callTool(client, 'safari_get_console_messages', { tabUrl }, nextId(), 15_000);
    const messages = result.messages as Array<{ level?: string; text?: string }> | undefined;
    expect(messages, `get_console_messages result: ${JSON.stringify(result)}`).toBeDefined();
    const haystack = messages!.map((m) => m.text || '').join(' | ');
    expect(haystack).toContain(marker);
  }, 30_000);

  it('safari_take_screenshot returns a non-empty PNG', async () => {
    // safari_take_screenshot returns the image as MCP `content[].type=image`.
    // callTool() unwraps to result.content[0].text by default, but the
    // screenshot tool puts the base64 PNG in content[].data. Easiest path:
    // use rawCallTool to inspect the full MCP result shape.
    const { rawCallTool } = await import('../helpers/mcp-client.js');
    const raw = await rawCallTool(client, 'safari_take_screenshot', { tabUrl }, nextId(), 15_000);
    const content = (raw.result['content'] as Array<Record<string, unknown>>) ?? [];
    const imagePart = content.find((p) => p['type'] === 'image');
    expect(imagePart, `expected an image part in MCP content; got: ${JSON.stringify(content).slice(0, 200)}`).toBeDefined();
    const data = imagePart!['data'] as string;
    expect(typeof data).toBe('string');
    // PNG base64 starts with "iVBOR" (the signature 0x89 0x50 0x4e 0x47 in b64).
    expect(data.startsWith('iVBOR')).toBe(true);
    expect(data.length).toBeGreaterThan(500);
  }, 25_000);
});
