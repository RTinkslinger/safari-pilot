/**
 * Extraction Tools E2E Tests
 *
 * Verifies safari_get_text, safari_get_html, safari_evaluate, and safari_snapshot
 * through the real MCP protocol over stdin/stdout.
 *
 * Zero mocks. Zero source imports. Real Safari interaction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('Extraction Tools E2E', () => {
  let client: McpTestClient;
  let nextId: number;
  let tabUrl: string;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;

    // Open a tab to example.com
    const newTab = await callTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      20000,
    );
    tabUrl = newTab['tabUrl'] as string;

    // Wait for page load
    await new Promise((r) => setTimeout(r, 3000));

    // Resolve the actual tab URL (Safari normalizes URLs)
    const tabsResult = await callTool(client, 'safari_list_tabs', {}, nextId++, 10000);
    const tabs = tabsResult['tabs'] as Array<Record<string, unknown>>;
    const exampleTab = tabs.find(
      (t) => (t['url'] as string).includes('example.com'),
    );
    if (exampleTab) {
      tabUrl = exampleTab['url'] as string;
    }
  }, 40000);

  afterAll(async () => {
    // Clean up the tab
    for (const url of [tabUrl, 'https://example.com/', 'https://example.com']) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId++, 10000);
      } catch {
        // Ignore
      }
    }
    if (client) await client.close();
  });

  it('safari_get_text returns visible text from example.com', async () => {
    const result = await callTool(
      client,
      'safari_get_text',
      { tabUrl },
      nextId++,
      15000,
    );

    expect(result['text']).toBeDefined();
    expect(typeof result['text']).toBe('string');
    expect(result['text'] as string).toContain('Example Domain');
    expect(result['length']).toBeGreaterThan(0);
  }, 20000);

  it('safari_get_html returns HTML containing expected elements', async () => {
    const result = await callTool(
      client,
      'safari_get_html',
      { tabUrl, selector: 'body' },
      nextId++,
      15000,
    );

    expect(result['html']).toBeDefined();
    const html = result['html'] as string;

    // example.com body should contain an h1 and a paragraph
    expect(html).toContain('Example Domain');
    expect(html).toContain('<h1>');
    expect(html).toContain('<p>');
  }, 20000);

  it('safari_evaluate executes JS and returns result', async () => {
    const result = await callTool(
      client,
      'safari_evaluate',
      {
        tabUrl,
        script: `
          return {
            title: document.title,
            h1Text: document.querySelector('h1').textContent,
            linkCount: document.querySelectorAll('a').length,
          };
        `,
      },
      nextId++,
      10000,
    );

    expect(result['value']).toBeDefined();
    const value = result['value'] as Record<string, unknown>;
    expect(value['title']).toContain('Example Domain');
    expect(value['h1Text']).toBe('Example Domain');
    expect(typeof value['linkCount']).toBe('number');
  }, 15000);

  it('safari_snapshot returns ARIA tree with roles', async () => {
    const result = await callTool(
      client,
      'safari_snapshot',
      { tabUrl },
      nextId++,
      20000,
    );

    // The snapshot returns an ARIA tree — check that it has role-related content
    // The snapshot format is YAML by default, returned as a text string
    const snapshot = result as Record<string, unknown>;

    // The snapshot result should contain role information.
    // It could be in various formats — check that the stringified content has 'role' mentions.
    const snapshotStr = JSON.stringify(snapshot);
    expect(snapshotStr.length).toBeGreaterThan(0);

    // ARIA snapshot should include common roles: heading, link
    // The exact format depends on the YAML/JSON output, but it should reference roles
    expect(snapshotStr).toMatch(/heading|link|document|generic|main/i);
  }, 25000);
});
