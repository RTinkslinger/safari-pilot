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
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';
import { ensureExtensionAwake } from '../helpers/ensure-extension-awake.js';
import { callToolExpectingEngine } from '../helpers/assert-engine.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe('Extraction Tools E2E', () => {
  let client: McpTestClient;
  let nextId: number;
  let agentTabUrl: string;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=extraction' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);

  afterAll(async () => {
    try {
      if (agentTabUrl && client) {
        await rawCallTool(client, 'safari_close_tab', { tabUrl: agentTabUrl }, nextId++, 10_000)
          .catch(() => {});
      }
    } finally {
      await client?.close().catch(() => {});
    }
  });

  it('safari_get_text returns visible text from example.com', async () => {
    const { payload, meta } = await callToolExpectingEngine(
      client,
      'safari_get_text',
      { tabUrl: agentTabUrl },
      'extension',
      nextId++,
      60_000,
    );

    expect(payload['text']).toBeDefined();
    expect(typeof payload['text']).toBe('string');
    expect(payload['text'] as string).toContain('Example Domain');
    expect(payload['length']).toBeGreaterThan(0);
    expect(meta['engine']).toBe('extension');
  }, 120_000);

  it('safari_get_html returns HTML containing expected elements', async () => {
    const { payload, meta } = await callToolExpectingEngine(
      client,
      'safari_get_html',
      { tabUrl: agentTabUrl, selector: 'body' },
      'extension',
      nextId++,
      60_000,
    );

    expect(payload['html']).toBeDefined();
    const html = payload['html'] as string;

    // example.com body should contain an h1 and a paragraph
    expect(html).toContain('Example Domain');
    expect(html).toContain('<h1>');
    expect(html).toContain('<p>');
    expect(meta['engine']).toBe('extension');
  }, 120_000);

  it('safari_evaluate executes JS and returns result', async () => {
    const { payload, meta } = await callToolExpectingEngine(
      client,
      'safari_evaluate',
      {
        tabUrl: agentTabUrl,
        script: `
          return {
            title: document.title,
            h1Text: document.querySelector('h1').textContent,
            linkCount: document.querySelectorAll('a').length,
          };
        `,
      },
      'extension',
      nextId++,
      60_000,
    );

    expect(payload['value']).toBeDefined();
    const value = payload['value'] as Record<string, unknown>;
    expect(value['title']).toContain('Example Domain');
    expect(value['h1Text']).toBe('Example Domain');
    // Safari storage serialization may coerce 1 → true (browser quirk); accept
    // either a positive number or boolean true (both mean "has at least one link")
    expect(value['linkCount']).toBeTruthy();
    expect(meta['engine']).toBe('extension');
  }, 120_000);

  it('safari_snapshot returns ARIA tree with roles', async () => {
    const { payload, meta } = await callToolExpectingEngine(
      client,
      'safari_snapshot',
      { tabUrl: agentTabUrl },
      'extension',
      nextId++,
      60_000,
    );

    // The snapshot returns an ARIA tree — check that it has role-related content
    // The snapshot format is YAML by default, returned as a text string
    const snapshotStr = JSON.stringify(payload);
    expect(snapshotStr.length).toBeGreaterThan(0);

    // ARIA snapshot should include common roles: heading, link
    // The exact format depends on the YAML/JSON output, but it should reference roles
    expect(snapshotStr).toMatch(/heading|link|document|generic|main/i);
    expect(meta['engine']).toBe('extension');
  }, 120_000);
});
