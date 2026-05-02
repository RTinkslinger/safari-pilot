/**
 * T55a Task 26 — safari_query_shadow with frameId pierces shadow inside
 * cross-origin iframe.
 *
 * The shadow.html fixture defines `<div id="shadow-host">` whose shadowRoot
 * contains `<p id="shadow-marker">SHADOW_INSIDE_FRAME_OK</p>`. With
 * frameId targeting the shadow.html iframe, the query must run inside the
 * iframe's document and pierce the shadow boundary there.
 *
 * Litmus: drop the frameId routing in shadow.ts handleQueryShadow — the
 * query runs in the host top frame which has no `#shadow-host`, so it
 * throws ELEMENT_NOT_FOUND.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T55a — query shadow inside cross-origin frame', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  const openedTabs: string[] = [];

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 60_000);

  afterAll(async () => {
    for (const url of openedTabs) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  }, 30_000);

  it('finds shadow content inside the shadow.html iframe', async () => {
    const tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t26=1`;
    openedTabs.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 2500));

    const list = await rawCallTool(client, 'safari_list_frames', { tabUrl }, nextId(), 15_000);
    const frames = list.payload['frames'] as Array<Record<string, unknown>>;
    const shadowFrame = frames.find((f) => typeof f['url'] === 'string' && (f['url'] as string).endsWith('/shadow.html'));
    expect(shadowFrame, `frames=${JSON.stringify(frames)}`).toBeDefined();

    const r = await rawCallTool(client, 'safari_query_shadow', {
      tabUrl,
      frameId: shadowFrame!['frameId'],
      hostSelector: '#shadow-host',
      shadowSelector: '#shadow-marker',
    }, nextId(), 15_000);

    const text = JSON.stringify(r.payload);
    expect(text, `payload=${text}`).toMatch(/SHADOW_INSIDE_FRAME_OK|"found":true/);
  }, 45_000);
});
