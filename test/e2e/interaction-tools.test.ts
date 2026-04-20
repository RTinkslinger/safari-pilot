/**
 * Interaction Tools E2E Tests
 *
 * Verifies safari_click, safari_fill, and safari_evaluate for DOM interaction
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

describe('Interaction Tools E2E', () => {
  let client: McpTestClient;
  let nextId: number;
  let agentTabUrl: string;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=interaction' }, nextId++, 20_000);
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

  it('safari_click on a link navigates to its href', async () => {
    // example.com has a link with text "More information..." pointing to iana.org
    const { payload, meta } = await callToolExpectingEngine(
      client,
      'safari_click',
      {
        tabUrl: agentTabUrl,
        selector: 'a',
        waitForNavigation: true,
      },
      'extension',
      nextId++,
      60_000,
    );

    // The click should succeed
    expect(payload).toBeDefined();
    expect(meta['engine']).toBe('extension');

    // Wait for navigation
    await new Promise((r) => setTimeout(r, 3000));

    // Verify the page navigated by checking the current URL via list_tabs
    const tabsResult = await callTool(client, 'safari_list_tabs', {}, nextId++, 15_000);
    const tabs = tabsResult['tabs'] as Array<Record<string, unknown>>;

    // Look for a tab that navigated away from example.com (to iana.org)
    const ianaTab = tabs.find(
      (t) => (t['url'] as string).includes('iana.org'),
    );
    expect(ianaTab).toBeDefined();

    // Update agentTabUrl to the navigated URL for subsequent tests
    if (ianaTab) {
      agentTabUrl = ianaTab['url'] as string;
    }
  }, 120_000);

  it('safari_fill types text into an input field', async () => {
    // Navigate back to example.com for a clean state
    await callTool(
      client,
      'safari_navigate',
      { url: 'https://example.com/?e2e=interaction-fill', tabUrl: agentTabUrl },
      nextId++,
      60_000,
    );
    // Update agentTabUrl after navigation — old URL (iana.org) no longer matches
    agentTabUrl = 'https://example.com/?e2e=interaction-fill';
    await new Promise((r) => setTimeout(r, 3000));

    // Inject a text input into the page via evaluate
    const { payload: injectPayload } = await callToolExpectingEngine(
      client,
      'safari_evaluate',
      {
        tabUrl: agentTabUrl,
        script: `
          var input = document.createElement('input');
          input.type = 'text';
          input.id = 'test-input';
          input.name = 'test-input';
          document.body.appendChild(input);
          return { injected: true };
        `,
      },
      'extension',
      nextId++,
      60_000,
    );
    expect(injectPayload['value']).toEqual({ injected: true });

    // Fill the input
    const { payload: fillPayload, meta: fillMeta } = await callToolExpectingEngine(
      client,
      'safari_fill',
      {
        tabUrl: agentTabUrl,
        selector: '#test-input',
        value: 'Hello Safari Pilot',
      },
      'extension',
      nextId++,
      60_000,
    );
    expect(fillPayload).toBeDefined();
    expect(fillMeta['engine']).toBe('extension');

    // Verify the value was set via evaluate
    const { payload: checkPayload } = await callToolExpectingEngine(
      client,
      'safari_evaluate',
      {
        tabUrl: agentTabUrl,
        script: `return document.getElementById('test-input').value;`,
      },
      'extension',
      nextId++,
      60_000,
    );

    expect(checkPayload['value']).toBe('Hello Safari Pilot');
  }, 120_000);

  it('safari_evaluate can check DOM state after interaction', async () => {
    // Use evaluate to inspect the page state
    const { payload, meta } = await callToolExpectingEngine(
      client,
      'safari_evaluate',
      {
        tabUrl: agentTabUrl,
        script: `
          return {
            title: document.title,
            hasInput: !!document.getElementById('test-input'),
            inputValue: document.getElementById('test-input')?.value || null,
            bodyChildCount: document.body.children.length,
          };
        `,
      },
      'extension',
      nextId++,
      60_000,
    );

    expect(payload['value']).toBeDefined();
    const state = payload['value'] as Record<string, unknown>;
    expect(state['title']).toContain('Example Domain');
    expect(state['hasInput']).toBe(true);
    expect(state['inputValue']).toBe('Hello Safari Pilot');
    expect(typeof state['bodyChildCount']).toBe('number');
    expect(meta['engine']).toBe('extension');
  }, 120_000);
});
