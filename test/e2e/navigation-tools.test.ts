/**
 * Navigation Tools E2E Tests
 *
 * Verifies safari_new_tab, safari_navigate, safari_list_tabs, and safari_close_tab
 * through the real MCP protocol over stdin/stdout.
 *
 * Zero mocks. Zero source imports. Real Safari interaction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('Navigation Tools E2E', () => {
  let client: McpTestClient;
  let nextId: number;
  const tabUrls: string[] = [];

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
  }, 30000);

  afterAll(async () => {
    // Clean up all tabs we created
    for (const url of tabUrls) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId++, 10000);
      } catch {
        // Tab may already be closed or URL may have changed
      }
    }
    // Also try closing by known URLs in case navigation changed them
    for (const url of ['https://example.com/', 'https://example.com', 'https://www.iana.org/help/example-domains']) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId++, 10000);
      } catch {
        // Ignore
      }
    }
    if (client) await client.close();
  });

  it('safari_new_tab creates a tab and returns tabUrl', async () => {
    const result = await callTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      20000,
    );

    expect(result['tabUrl']).toBeDefined();
    expect(typeof result['tabUrl']).toBe('string');
    tabUrls.push(result['tabUrl'] as string);
  }, 25000);

  it('safari_navigate changes the tab URL', async () => {
    // Navigate the tab we just created to a different URL
    const result = await callTool(
      client,
      'safari_navigate',
      { url: 'https://www.iana.org/help/example-domains' },
      nextId++,
      20000,
    );

    expect(result['url']).toBeDefined();
    const newUrl = result['url'] as string;
    expect(newUrl).toContain('iana.org');
  }, 25000);

  it('safari_list_tabs returns the created tabs', async () => {
    const result = await callTool(
      client,
      'safari_list_tabs',
      {},
      nextId++,
      15000,
    );

    expect(result['tabs']).toBeInstanceOf(Array);
    const tabs = result['tabs'] as Array<Record<string, unknown>>;
    expect(tabs.length).toBeGreaterThan(0);

    // Each tab should have url and title
    for (const tab of tabs) {
      expect(tab).toHaveProperty('url');
      expect(tab).toHaveProperty('title');
    }
  }, 20000);

  it('safari_close_tab removes tab from list', async () => {
    // Open a second tab that we will close
    const newTab = await callTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      20000,
    );
    const newTabUrl = newTab['tabUrl'] as string;
    expect(newTabUrl).toBeDefined();

    // Wait for the page to load
    await new Promise((r) => setTimeout(r, 2000));

    // Get tabs before close
    const beforeResult = await callTool(client, 'safari_list_tabs', {}, nextId++, 15000);
    const beforeTabs = beforeResult['tabs'] as Array<Record<string, unknown>>;
    const beforeCount = beforeTabs.length;

    // Close the tab — try the returned URL and common variants
    const urlsToTry = [
      newTabUrl,
      'https://example.com/',
      'https://example.com',
    ];

    let closed = false;
    for (const url of urlsToTry) {
      try {
        const closeResult = await callTool(
          client,
          'safari_close_tab',
          { tabUrl: url },
          nextId++,
          10000,
        );
        if (closeResult['closed']) {
          closed = true;
          break;
        }
      } catch {
        // Try next variant
      }
    }

    expect(closed).toBe(true);

    // Verify tab count decreased
    const afterResult = await callTool(client, 'safari_list_tabs', {}, nextId++, 15000);
    const afterTabs = afterResult['tabs'] as Array<Record<string, unknown>>;
    expect(afterTabs.length).toBeLessThan(beforeCount);
  }, 40000);
});
