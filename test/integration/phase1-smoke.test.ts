/**
 * Phase 1 E2E Smoke Test — Real Safari
 *
 * This test actually talks to Safari via AppleScript.
 * It opens a tab, navigates, reads content, and cleans up.
 *
 * Prerequisites:
 * - Safari running
 * - "Allow JavaScript from Apple Events" enabled in Safari > Develop
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AppleScriptEngine } from '../../src/engines/applescript.js';
import { NavigationTools } from '../../src/tools/navigation.js';
import { ExtractionTools } from '../../src/tools/extraction.js';
import { InteractionTools } from '../../src/tools/interaction.js';
import { TabOwnership } from '../../src/security/tab-ownership.js';

describe('Phase 1 E2E Smoke Test — Real Safari', () => {
  const engine = new AppleScriptEngine();
  const nav = new NavigationTools(engine);
  const extract = new ExtractionTools(engine);
  const interact = new InteractionTools(engine);
  const tabOwnership = new TabOwnership();
  let agentTabUrl: string | undefined;

  afterAll(async () => {
    // Clean up: close the tab we opened
    if (agentTabUrl) {
      try {
        const closeHandler = nav.getHandler('safari_close_tab');
        if (closeHandler) await closeHandler({ tabUrl: agentTabUrl });
      } catch {
        // Tab may already be closed
      }
    }
  });

  it('can list existing Safari tabs', async () => {
    const handler = nav.getHandler('safari_list_tabs')!;
    const result = await handler({});
    const data = JSON.parse(result.content[0].text!);

    expect(data.tabs).toBeInstanceOf(Array);
    expect(data.tabs.length).toBeGreaterThan(0);

    // Each tab has url and title
    for (const tab of data.tabs) {
      expect(tab).toHaveProperty('url');
      expect(tab).toHaveProperty('title');
    }

    console.log(`Found ${data.tabs.length} tabs`);
  }, 15000);

  it('can open a new tab and navigate to a URL', async () => {
    const handler = nav.getHandler('safari_new_tab')!;
    const result = await handler({ url: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.tabUrl).toBeDefined();
    agentTabUrl = data.tabUrl;

    // Register as agent-owned
    tabOwnership.registerTab(1001, agentTabUrl!);
    expect(tabOwnership.isOwned(1001)).toBe(true);

    console.log(`Opened tab: ${agentTabUrl}`);
  }, 15000);

  it('can read page text from the opened tab', async () => {
    // Wait for page to load
    await new Promise(r => setTimeout(r, 2000));

    // Use the actual tab URL (Safari may normalize with trailing slash)
    const actualTabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';

    const handler = extract.getHandler('safari_get_text')!;
    const result = await handler({ tabUrl: actualTabUrl });
    const data = JSON.parse(result.content[0].text!);

    expect(data.text).toBeDefined();
    expect(data.text.length).toBeGreaterThan(0);
    // example.com has "Example Domain" text
    expect(data.text).toContain('Example Domain');

    console.log(`Page text (first 100 chars): ${data.text.substring(0, 100)}`);
  }, 30000);

  it('can execute JavaScript in the tab', async () => {
    const actualTabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';
    const handler = extract.getHandler('safari_evaluate')!;
    const result = await handler({
      tabUrl: actualTabUrl,
      script: 'return document.title',
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.value).toBeDefined();
    expect(data.value).toContain('Example Domain');

    console.log(`document.title = "${data.value}"`);
  }, 15000);

  it('can get page HTML', async () => {
    const actualTabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';
    const handler = extract.getHandler('safari_get_html')!;
    const result = await handler({
      tabUrl: actualTabUrl,
      selector: 'h1',
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.html).toBeDefined();
    expect(data.html).toContain('Example Domain');

    console.log(`h1 HTML: ${data.html}`);
  }, 15000);

  it('can take a screenshot', async () => {
    const handler = extract.getHandler('safari_take_screenshot')!;
    const result = await handler({});

    // Screenshot returns either text (path) or image (base64)
    expect(result.content[0]).toBeDefined();
    console.log(`Screenshot result type: ${result.content[0].type}`);
  }, 15000);

  it('can get cookies for the domain', async () => {
    // Import storage tools
    const { StorageTools } = await import('../../src/tools/storage.js');
    const storage = new StorageTools(engine);

    const actualTabUrl = agentTabUrl!.endsWith('/') ? agentTabUrl! : agentTabUrl! + '/';
    const handler = storage.getHandler('safari_get_cookies')!;
    const result = await handler({ tabUrl: actualTabUrl });
    const data = JSON.parse(result.content[0].text!);

    // example.com may or may not have cookies, but the call shouldn't error
    expect(data).toHaveProperty('cookies');
    expect(data.cookies).toBeInstanceOf(Array);

    console.log(`Cookies found: ${data.cookies.length}`);
  }, 15000);

  it('tab ownership prevents access to user tabs', () => {
    // Tab 9999 was not registered by the agent
    expect(tabOwnership.isOwned(9999)).toBe(false);
    expect(() => tabOwnership.assertOwnership(9999)).toThrow();
  });

  it('can close the agent-owned tab', async () => {
    if (!agentTabUrl) return;

    // The URL may have been normalized (e.g., trailing slash added)
    // Try the current URL first, then common variations
    const closeHandler = nav.getHandler('safari_close_tab')!;
    const urlsToTry = [
      agentTabUrl,
      agentTabUrl.endsWith('/') ? agentTabUrl.slice(0, -1) : agentTabUrl + '/',
      'https://example.com/',
      'https://example.com',
    ];

    let closed = false;
    for (const url of urlsToTry) {
      try {
        const result = await closeHandler({ tabUrl: url });
        const data = JSON.parse(result.content[0].text!);
        if (data.closed) {
          closed = true;
          break;
        }
      } catch {
        // Try next URL
      }
    }

    expect(closed).toBe(true);
    agentTabUrl = undefined;
    console.log('Tab closed successfully');
  }, 15000);
});
