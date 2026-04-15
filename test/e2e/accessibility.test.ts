/**
 * Accessibility (Snapshot) E2E Tests
 *
 * Verifies safari_snapshot returns a well-formed ARIA tree with correct structure,
 * heading roles, and link elements through the real MCP protocol.
 *
 * Zero mocks. Zero source imports. Real Safari interaction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('Accessibility E2E', () => {
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

    // Wait for page to fully load
    await new Promise((r) => setTimeout(r, 3000));

    // Resolve the actual tab URL
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
    // Clean up tab
    for (const url of [tabUrl, 'https://example.com/', 'https://example.com']) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId++, 10000);
      } catch {
        // Ignore
      }
    }
    if (client) await client.close();
  });

  it('safari_snapshot returns tree with correct structure (has role in output)', async () => {
    const result = await callTool(
      client,
      'safari_snapshot',
      { tabUrl },
      nextId++,
      20000,
    );

    // The snapshot returns data that represents the ARIA tree.
    // Convert to string to inspect the content regardless of format.
    const snapshotStr = JSON.stringify(result);

    expect(snapshotStr.length).toBeGreaterThan(0);

    // ARIA tree uses role names inline (e.g. "- heading", "- link", "- generic")
    // Verify the snapshot contains recognized ARIA role keywords
    expect(snapshotStr).toMatch(/heading|link|generic|paragraph/i);
  }, 25000);

  it('safari_snapshot on example.com includes heading role', async () => {
    const result = await callTool(
      client,
      'safari_snapshot',
      { tabUrl },
      nextId++,
      20000,
    );

    const snapshotStr = JSON.stringify(result);

    // example.com has an <h1> which should produce a heading role
    expect(snapshotStr).toMatch(/heading/i);
  }, 25000);

  it('safari_snapshot includes link elements with names', async () => {
    const result = await callTool(
      client,
      'safari_snapshot',
      { tabUrl },
      nextId++,
      20000,
    );

    const snapshotStr = JSON.stringify(result);

    // example.com has a link which should appear as a link role
    expect(snapshotStr).toMatch(/link/i);

    // The link should have a name/text associated with it.
    // In the JSON-stringified snapshot, quotes are escaped as \" so the pattern
    // is: link \\"Name\\" or link "Name" depending on serialization depth.
    expect(snapshotStr).toMatch(/link\s+(\\\\)?\\?"[^"\\]+(\\\\)?\\?"/i);
  }, 25000);
});
