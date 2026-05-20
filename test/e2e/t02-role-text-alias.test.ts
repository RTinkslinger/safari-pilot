/**
 * v0.1.37 T02 — production verification: safari_click with `role+text`
 * resolves to the correct element via the role+name aliasing path.
 *
 * Pre-fix (extractLocatorFromParams ignored `text` when `role` present):
 * any page with >1 element matching `role` returned strict-mode error
 * "Locator matched N elements". Allrecipes--1 hit 221.
 *
 * Post-fix (text aliased into name): safari_click({role:"link", text:"X"})
 * filters candidates by accessible-name and clicks the unique match.
 *
 * Fixture: test/fixtures/cross-frame/t02-role-text.html — one link with
 * accessible name "Pick me" surrounded by 20 decoy/trail links. Pre-fix
 * this fails with "matched N links" or clicks the wrong link with
 * chain:[first]. Post-fix it clicks the unique "Pick me" link and the
 * navigatedTo URL contains #target.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T02 — safari_click resolves role+text via role+name alias', () => {
  let server: FixtureServer;
  let client: McpTestClient;
  let nextId: () => number;
  let tabUrl: string;

  beforeAll(async () => {
    server = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const url = `http://127.0.0.1:${server.hostPort}/t02-role-text.html?sp_t02=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url }, nextId());
    tabUrl = tab.tabUrl as string;
    await new Promise((r) => setTimeout(r, 2000));
  }, 30000);

  afterAll(async () => {
    if (client && tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* noop */ }
    }
    if (server) await server.close();
  });

  it('clicks the unique link by role+text without strict-mode failure', async () => {
    // Pre-fix: safari_click({role:"link", text:"Pick me"}) throws strict-mode
    // error because text is ignored and all 21 links match.
    // Post-fix: text is aliased to name, role+name filters to the one link
    // with accessible-name "Pick me", and the click succeeds.
    const result = await callTool(client, 'safari_click', {
      tabUrl,
      role: 'link',
      text: 'Pick me',
      waitForNavigation: true,
    }, nextId());

    expect(result.clicked).toBe(true);
    const el = result.element as { textContent?: string; id?: string } | undefined;
    expect(el?.textContent?.trim()).toBe('Pick me');
    expect(el?.id).toBe('target-link');
    const navTo = result.navigatedTo as string;
    expect(navTo).toContain('#target');
  });
});
