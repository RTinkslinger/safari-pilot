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
import { ensureExtensionAwake } from '../helpers/ensure-extension-awake.js';
import { callToolExpectingEngine } from '../helpers/assert-engine.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe('Accessibility E2E', () => {
  let client: McpTestClient;
  let nextId: number;
  let tabUrl: string;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=accessibility' }, nextId++, 20_000);
    tabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, tabUrl, nextId);
  }, 180_000);

  afterAll(async () => {
    try {
      if (tabUrl && client) {
        try {
          await callTool(client, 'safari_close_tab', { tabUrl }, nextId++, 10000);
        } catch {
          // Best-effort cleanup
        }
      }
    } finally {
      if (client) await client.close();
    }
  });

  it('safari_snapshot returns tree with correct structure (has role in output)', async () => {
    const result = await callTool(
      client,
      'safari_snapshot',
      { tabUrl },
      nextId++,
      60_000,
    );

    // The snapshot returns data that represents the ARIA tree.
    // Convert to string to inspect the content regardless of format.
    const snapshotStr = JSON.stringify(result);

    expect(snapshotStr.length).toBeGreaterThan(0);

    // ARIA tree uses role names inline (e.g. "- heading", "- link", "- generic")
    // Verify the snapshot contains recognized ARIA role keywords
    expect(snapshotStr).toMatch(/heading|link|generic|paragraph/i);
  }, 120_000);

  it('safari_snapshot on example.com includes heading role', async () => {
    const result = await callTool(
      client,
      'safari_snapshot',
      { tabUrl },
      nextId++,
      60_000,
    );

    const snapshotStr = JSON.stringify(result);

    // example.com has an <h1> which should produce a heading role
    expect(snapshotStr).toMatch(/heading/i);
  }, 120_000);

  it('safari_snapshot includes link elements with names', async () => {
    const result = await callTool(
      client,
      'safari_snapshot',
      { tabUrl },
      nextId++,
      60_000,
    );

    const snapshotStr = JSON.stringify(result);

    // example.com has a link which should appear as a link role
    expect(snapshotStr).toMatch(/link/i);

    // The link should have a name/text associated with it.
    // In the JSON-stringified snapshot, quotes are escaped as \" so the pattern
    // is: link \\"Name\\" or link "Name" depending on serialization depth.
    expect(snapshotStr).toMatch(/link\s+(\\\\)?\\?"[^"\\]+(\\\\)?\\?"/i);
  }, 120_000);
});
