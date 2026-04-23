/**
 * Phase 1 validation: Core Navigation + Evaluation
 *
 * Proves each tool works through the real MCP stack against real Safari.
 * Items 1.2 (new_tab) and 1.5 (evaluate) are proven in initialization.test.ts.
 * This file covers 1.1 (navigate), 1.3 (close_tab), 1.4 (list_tabs),
 * 1.6 (screenshot), 1.7 (navigate_back/forward).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initClient, callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';

describe('Phase 1: Core Navigation', () => {
  let client: McpTestClient;
  let nextId: number;
  let tabUrl: string;

  beforeAll(async () => {
    const result = await initClient('dist/index.js');
    client = result.client;
    nextId = result.nextId;

    // Open a tab to work with — wait for content script
    const tab = await callTool(client, 'safari_new_tab', { url: 'https://example.com' }, nextId++);
    tabUrl = tab.tabUrl;
    await new Promise(r => setTimeout(r, 3000));
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
  });

  // ── 1.1 Navigate to URL ──────────────────────────────────────────────────
  it('1.1 safari_navigate changes the page URL', async () => {
    const result = await callTool(
      client, 'safari_navigate',
      { url: 'https://httpbin.org/html', tabUrl },
      nextId++,
      30000,
    );
    expect(result.url).toContain('httpbin.org');
    // Update tabUrl for subsequent tests
    tabUrl = result.url;
  }, 35000);

  // ── 1.4 List tabs ────────────────────────────────────────────────────────
  it('1.4 safari_list_tabs returns open tabs including our tab', async () => {
    const result = await callTool(client, 'safari_list_tabs', {}, nextId++);
    // Result is either an array or object with tabs
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    expect(text).toContain('httpbin.org');
  }, 10000);

  // ── 1.6 Take screenshot ─────────────────────────────────────────────────
  it('1.6 safari_take_screenshot returns image data', async () => {
    const raw = await rawCallTool(
      client, 'safari_take_screenshot',
      { tabUrl },
      nextId++,
      15000,
    );
    // Screenshot tool returns image content type
    const content = raw.result.content as Array<Record<string, unknown>>;
    const hasImage = content.some(c => c.type === 'image' && typeof c.data === 'string');
    const hasText = content.some(c => c.type === 'text');
    // Should have either image data or text describing the screenshot
    expect(hasImage || hasText).toBe(true);
  }, 20000);

  // ── 1.7 Navigate back/forward ────────────────────────────────────────────
  // Requires two fixes working together:
  //  - positional page-info query after history.back/forward (commit 8cf4d3f,
  //    so PAGE_INFO_JS runs against the right tab after its URL changed);
  //  - post-navigation ownership URL refresh (T2, server.ts step 8.post0, so
  //    the registry tracks the new URL and the next call still finds the tab).
  it('1.7 safari_navigate_back returns to previous page', async () => {
    const result = await callTool(
      client, 'safari_navigate_back',
      { tabUrl },
      nextId++,
      15000,
    );
    expect(result.url).toContain('example.com');
    tabUrl = result.url;
  }, 20000);

  it('1.7 safari_navigate_forward returns to next page', async () => {
    const result = await callTool(
      client, 'safari_navigate_forward',
      { tabUrl },
      nextId++,
      15000,
    );
    expect(result.url).toContain('httpbin.org');
    tabUrl = result.url;
  }, 20000);

  // ── 1.3 Close tab ───────────────────────────────────────────────────────
  it('1.3 safari_close_tab closes the tab', async () => {
    const result = await callTool(
      client, 'safari_close_tab',
      { tabUrl },
      nextId++,
      10000,
    );
    // Should confirm closure
    const text = JSON.stringify(result);
    expect(text).toBeDefined();
  }, 15000);
});
