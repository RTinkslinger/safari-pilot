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
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';
import { E2EReportCollector } from '../helpers/e2e-report.js';
import { ensureExtensionAwake } from '../helpers/ensure-extension-awake.js';
import { callToolExpectingEngine } from '../helpers/assert-engine.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe('Navigation Tools E2E', () => {
  let client: McpTestClient;
  let nextId: number;
  let agentTabUrl: string;
  const report = new E2EReportCollector('navigation-tools');

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    report.setExtensionConnected(true);
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=navigation' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);

  afterAll(async () => {
    try {
      report.writeReport();
      if (agentTabUrl && client) {
        await rawCallTool(client, 'safari_close_tab', { tabUrl: agentTabUrl }, nextId++, 10_000)
          .catch(() => {});
      }
    } finally {
      await client?.close().catch(() => {});
    }
  });

  it('safari_new_tab creates a tab and returns tabUrl', async () => {
    const { payload, meta } = await rawCallTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      60_000,
    );
    report.recordCall('safari_new_tab', { url: 'https://example.com' }, meta, !!payload['tabUrl']);

    expect(payload['tabUrl']).toBeDefined();
    expect(typeof payload['tabUrl']).toBe('string');

    // Close the extra tab to avoid accumulating open tabs
    const extraTabUrl = payload['tabUrl'] as string;
    await rawCallTool(client, 'safari_close_tab', { tabUrl: extraTabUrl }, nextId++, 10_000)
      .catch(() => {});
  }, 120_000);

  it('safari_navigate changes the tab URL', async () => {
    const { payload, meta } = await rawCallTool(
      client,
      'safari_navigate',
      { url: 'https://www.iana.org/help/example-domains', tabUrl: agentTabUrl },
      nextId++,
      60_000,
    );
    report.recordCall('safari_navigate', { url: 'https://www.iana.org/help/example-domains' }, meta, !!payload['url']);

    expect(meta!['engine']).toBe('extension');
    expect(payload['url']).toBeDefined();
    const newUrl = payload['url'] as string;
    expect(newUrl).toContain('iana.org');

    // Navigate back to example.com so subsequent tests have a consistent base
    await callTool(
      client,
      'safari_navigate',
      { url: 'https://example.com/?e2e=navigation', tabUrl: agentTabUrl },
      nextId++,
      60_000,
    );
    await new Promise(r => setTimeout(r, 1500));
  }, 120_000);

  it('safari_list_tabs returns the agent tab', async () => {
    const { payload, meta } = await rawCallTool(
      client,
      'safari_list_tabs',
      {},
      nextId++,
      60_000,
    );
    report.recordCall('safari_list_tabs', {}, meta, !!payload['tabs']);

    expect(payload['tabs']).toBeInstanceOf(Array);
    const tabs = payload['tabs'] as Array<Record<string, unknown>>;
    expect(tabs.length).toBeGreaterThan(0);

    // Each tab should have url and title
    for (const tab of tabs) {
      expect(tab).toHaveProperty('url');
      expect(tab).toHaveProperty('title');
    }

    // The agent tab should appear in the list
    const agentTab = tabs.find((t) => (t['url'] as string).includes('example.com'));
    expect(agentTab).toBeDefined();
  }, 120_000);

  it('safari_close_tab removes tab from list', async () => {
    // Open a second tab that we will close
    const { payload: newTab, meta: newTabMeta } = await rawCallTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      60_000,
    );
    report.recordCall('safari_new_tab', { url: 'https://example.com' }, newTabMeta, !!newTab['tabUrl']);
    const newTabUrl = newTab['tabUrl'] as string;
    expect(newTabUrl).toBeDefined();

    // Wait for the page to load
    await new Promise((r) => setTimeout(r, 2000));

    // Get tabs before close
    const beforeResult = await callTool(client, 'safari_list_tabs', {}, nextId++, 60_000);
    const beforeTabs = beforeResult['tabs'] as Array<Record<string, unknown>>;
    const beforeCount = beforeTabs.length;

    // Close the newly created tab — try the returned URL and common normalized variants
    const urlsToTry = [
      newTabUrl,
      'https://example.com/',
      'https://example.com',
    ];

    let closed = false;
    for (const url of urlsToTry) {
      const { payload: closePayload } = await rawCallTool(
        client,
        'safari_close_tab',
        { tabUrl: url },
        nextId++,
        60_000,
      );
      if (closePayload['closed']) {
        closed = true;
        break;
      }
    }
    expect(closed).toBe(true);

    // Verify tab count decreased
    const afterResult = await callTool(client, 'safari_list_tabs', {}, nextId++, 60_000);
    const afterTabs = afterResult['tabs'] as Array<Record<string, unknown>>;
    expect(afterTabs.length).toBeLessThan(beforeCount);
  }, 120_000);
});
