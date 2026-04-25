/**
 * Phase 1 validation: Core Navigation + Evaluation
 *
 * Proves each tool works through the real MCP stack against real Safari.
 * Items 1.2 (new_tab) and 1.5 (evaluate) are proven in initialization.test.ts.
 * This file covers 1.1 (navigate), 1.3 (close_tab), 1.4 (list_tabs),
 * 1.6 (screenshot), 1.7 (navigate_back/forward).
 *
 * Uses the shared MCP client (see test/helpers/shared-client.ts) — one
 * server spawn per test run, tab-level isolation with unique URL markers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('Phase 1: Core Navigation', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let tabUrl: string;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;

    // Open a tab to work with — wait for content script
    const unique = `https://example.com/?sp_p1=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: unique }, nextId());
    tabUrl = tab.tabUrl;
    await new Promise(r => setTimeout(r, 3000));
  }, 30000);

  afterAll(async () => {
    // Best-effort cleanup of the final tab URL (the sequence below updates
    // `tabUrl` as the tests navigate). If the 1.3 close_tab test already
    // ran successfully, this no-op-fails.
    if (client && tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* already closed */ }
    }
  });

  // ── 1.1 Navigate to URL ──────────────────────────────────────────────────
  it('1.1 safari_navigate changes the page URL', async () => {
    const result = await callTool(
      client, 'safari_navigate',
      { url: 'https://httpbin.org/html', tabUrl },
      nextId(),
      30000,
    );
    expect(result.url).toContain('httpbin.org');
    // Update tabUrl for subsequent tests
    tabUrl = result.url;
  }, 35000);

  // ── 1.4 List tabs ────────────────────────────────────────────────────────
  it('1.4 safari_list_tabs returns open tabs including our tab', async () => {
    const result = await callTool(client, 'safari_list_tabs', {}, nextId());
    // Result is either an array or object with tabs
    const text = typeof result === 'string' ? result : JSON.stringify(result);
    expect(text).toContain('httpbin.org');
  }, 10000);

  // ── 1.6 Take screenshot ─────────────────────────────────────────────────
  it('1.6 safari_take_screenshot returns a real PNG image, not a text envelope', async () => {
    const raw = await rawCallTool(
      client, 'safari_take_screenshot',
      { tabUrl },
      nextId(),
      15000,
    );
    // SD-03 strict oracle. The previous `hasImage || hasText` admitted any
    // stub returning {content: [{type:'text', text:'error'}]}. We require:
    //   - an image content block (not text)
    //   - mimeType === 'image/png'
    //   - base64 data string with a non-trivial byte floor
    // A real Safari window screenshot is ~50KB+ base64; 1000-char floor
    // excludes any plausible stub (error strings, empty buffers, etc.).
    const content = raw.result.content as Array<Record<string, unknown>>;
    const imageBlock = content.find(c => c.type === 'image');
    expect(imageBlock, `Expected an image content block, got: ${JSON.stringify(content)}`).toBeDefined();
    expect(imageBlock!['mimeType']).toBe('image/png');
    expect(typeof imageBlock!['data']).toBe('string');
    expect((imageBlock!['data'] as string).length).toBeGreaterThan(1000);
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
      nextId(),
      15000,
    );
    expect(result.url).toContain('example.com');
    tabUrl = result.url;
  }, 20000);

  it('1.7 safari_navigate_forward returns to next page', async () => {
    const result = await callTool(
      client, 'safari_navigate_forward',
      { tabUrl },
      nextId(),
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
      nextId(),
      10000,
    );
    // SD-07 strict oracle: close_tab returns `{closed: true, ...}` when the
    // tab was actually closed (same oracle as T7 in security-ownership). The
    // pre-SD-07 `expect(text).toBeDefined()` accepted any JSON.stringify
    // result, including `{error: 'closed nothing'}` from a stub.
    expect(result.closed).toBe(true);
    tabUrl = ''; // afterAll will no-op
  }, 15000);
});
