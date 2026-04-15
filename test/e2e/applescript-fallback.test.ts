/**
 * AppleScript Fallback E2E Tests
 *
 * Verifies basic Safari automation tools work end-to-end through the MCP
 * protocol. These tools use AppleScript as the always-available engine.
 *
 * Tests the full user journey: create tab -> navigate -> extract -> evaluate -> close.
 *
 * Zero mocks. Zero source imports. Real process over stdio, real Safari interaction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('AppleScript Fallback — Basic Tool Lifecycle', () => {
  let client: McpTestClient;
  let nextId: number;
  let agentTabUrl: string | undefined;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
  }, 30000);

  afterAll(async () => {
    // Safety net: close any tab we opened if individual test didn't
    if (agentTabUrl && client) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: agentTabUrl }, nextId++, 10000);
      } catch { /* tab may already be closed */ }
    }
    if (client) await client.close();
  });

  it('safari_new_tab creates a tab with URL', async () => {
    const result = await callTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      20000,
    );

    expect(result['tabUrl']).toBeDefined();
    expect(typeof result['tabUrl']).toBe('string');
    agentTabUrl = result['tabUrl'] as string;

    // Wait for page load
    await new Promise((r) => setTimeout(r, 3000));
  }, 25000);

  it('safari_navigate loads a URL', async () => {
    expect(agentTabUrl).toBeDefined();

    const tabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';
    const result = await callTool(
      client,
      'safari_navigate',
      { tabUrl, url: 'https://example.com/' },
      nextId++,
      20000,
    );

    // Navigate should succeed — verify the response indicates the navigation happened
    expect(result).toBeDefined();

    // Wait for navigation to complete
    await new Promise((r) => setTimeout(r, 2000));
  }, 25000);

  it('safari_get_text extracts text from page', async () => {
    expect(agentTabUrl).toBeDefined();

    const tabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';
    const result = await callTool(
      client,
      'safari_get_text',
      { tabUrl },
      nextId++,
      20000,
    );

    expect(result['text']).toBeDefined();
    expect(typeof result['text']).toBe('string');

    const text = result['text'] as string;
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('Example Domain');
  }, 25000);

  it('safari_evaluate returns JS result', async () => {
    expect(agentTabUrl).toBeDefined();

    const tabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';
    const result = await callTool(
      client,
      'safari_evaluate',
      { tabUrl, script: 'return document.title' },
      nextId++,
      20000,
    );

    expect(result['value']).toBeDefined();
    expect(typeof result['value']).toBe('string');
    expect((result['value'] as string)).toContain('Example Domain');
  }, 25000);

  it('safari_close_tab closes the tab', async () => {
    expect(agentTabUrl).toBeDefined();

    // Try both with and without trailing slash since Safari normalizes URLs
    const urlVariants = [
      agentTabUrl!,
      agentTabUrl!.endsWith('/') ? agentTabUrl!.slice(0, -1) : agentTabUrl! + '/',
    ];

    let closed = false;
    for (const url of urlVariants) {
      try {
        const result = await callTool(
          client,
          'safari_close_tab',
          { tabUrl: url },
          nextId++,
          15000,
        );
        if (result['closed']) {
          closed = true;
          break;
        }
      } catch {
        // Try next URL variant
      }
    }

    expect(closed).toBe(true);
    agentTabUrl = undefined; // Prevent afterAll from trying to close again
  }, 20000);
});
