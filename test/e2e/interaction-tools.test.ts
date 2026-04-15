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
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('Interaction Tools E2E', () => {
  let client: McpTestClient;
  let nextId: number;
  let tabUrl: string;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;

    // Open a tab to example.com for interaction testing
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

    // Resolve the actual tab URL (Safari may normalize it)
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
    // Clean up tabs
    for (const url of [tabUrl, 'https://example.com/', 'https://example.com', 'https://www.iana.org/domains/reserved']) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId++, 10000);
      } catch {
        // Ignore
      }
    }
    if (client) await client.close();
  });

  it('safari_click on a link navigates to its href', async () => {
    // example.com has a link with text "More information..." pointing to iana.org
    const clickResult = await callTool(
      client,
      'safari_click',
      {
        tabUrl,
        selector: 'a',
        waitForNavigation: true,
      },
      nextId++,
      20000,
    );

    // The click should succeed
    expect(clickResult).toBeDefined();

    // Wait for navigation
    await new Promise((r) => setTimeout(r, 3000));

    // Verify the page navigated by checking the current URL via evaluate
    // We need to find the tab's new URL since it navigated
    const tabsResult = await callTool(client, 'safari_list_tabs', {}, nextId++, 10000);
    const tabs = tabsResult['tabs'] as Array<Record<string, unknown>>;

    // Look for a tab that navigated away from example.com (to iana.org)
    const ianaTab = tabs.find(
      (t) => (t['url'] as string).includes('iana.org'),
    );
    expect(ianaTab).toBeDefined();

    // Update tabUrl for subsequent tests
    if (ianaTab) {
      tabUrl = ianaTab['url'] as string;
    }
  }, 30000);

  it('safari_fill types text into an input field', async () => {
    // Open a fresh tab to example.com for this test
    const freshTab = await callTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      20000,
    );
    const freshTabUrl = freshTab['tabUrl'] as string;
    expect(freshTabUrl).toBeDefined();

    // Wait for page load
    await new Promise((r) => setTimeout(r, 3000));

    // Resolve the actual tab URL from the tab list
    const tabsResult = await callTool(client, 'safari_list_tabs', {}, nextId++, 10000);
    const tabs = tabsResult['tabs'] as Array<Record<string, unknown>>;
    const exTab = tabs.find((t) => (t['url'] as string).includes('example.com'));
    const resolvedUrl = exTab ? (exTab['url'] as string) : freshTabUrl;

    // Inject a text input into the page via evaluate
    const injectResult = await callTool(
      client,
      'safari_evaluate',
      {
        tabUrl: resolvedUrl,
        script: `
          var input = document.createElement('input');
          input.type = 'text';
          input.id = 'test-input';
          input.name = 'test-input';
          document.body.appendChild(input);
          return { injected: true };
        `,
      },
      nextId++,
      10000,
    );
    expect(injectResult['value']).toEqual({ injected: true });

    // Fill the input
    const fillResult = await callTool(
      client,
      'safari_fill',
      {
        tabUrl: resolvedUrl,
        selector: '#test-input',
        value: 'Hello Safari Pilot',
      },
      nextId++,
      15000,
    );
    expect(fillResult).toBeDefined();

    // Verify the value was set via evaluate
    const checkResult = await callTool(
      client,
      'safari_evaluate',
      {
        tabUrl: resolvedUrl,
        script: `return document.getElementById('test-input').value;`,
      },
      nextId++,
      10000,
    );

    expect(checkResult['value']).toBe('Hello Safari Pilot');

    // Update tabUrl for the next test
    tabUrl = resolvedUrl;
  }, 50000);

  it('safari_evaluate can check DOM state after interaction', async () => {
    // Use evaluate to inspect the page state
    const result = await callTool(
      client,
      'safari_evaluate',
      {
        tabUrl,
        script: `
          return {
            title: document.title,
            hasInput: !!document.getElementById('test-input'),
            inputValue: document.getElementById('test-input')?.value || null,
            bodyChildCount: document.body.children.length,
          };
        `,
      },
      nextId++,
      10000,
    );

    expect(result['value']).toBeDefined();
    const state = result['value'] as Record<string, unknown>;
    expect(state['title']).toContain('Example Domain');
    expect(state['hasInput']).toBe(true);
    expect(state['inputValue']).toBe('Hello Safari Pilot');
    expect(typeof state['bodyChildCount']).toBe('number');
  }, 15000);
});
