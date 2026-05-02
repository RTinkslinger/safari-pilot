/**
 * T55a Task 25 — safari_get_text with frameId returns iframe body, not host.
 *
 * The extraction tool accepts an optional frameId parameter (Task 14). When
 * the frameId points at a cross-origin iframe, the underlying selector
 * query must run inside that iframe's document — not the host's. This is
 * the structured-extraction equivalent of Task 21's eval-in-frame test.
 *
 * Litmus: drop the frameId-aware routeFrameAware call in extraction.ts
 * and the selector hits the host body, returning "Host page (port 19476)"
 * instead of the inner-frame text.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T55a — extract text from cross-origin frame', () => {
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

  it('safari_get_text(selector="body", frameId=inner) returns iframe body', async () => {
    const tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t25=1`;
    openedTabs.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 2500));

    const list = await rawCallTool(client, 'safari_list_frames', { tabUrl }, nextId(), 15_000);
    const frames = list.payload['frames'] as Array<Record<string, unknown>>;
    const innerFrame = frames.find((f) => typeof f['url'] === 'string' && (f['url'] as string).endsWith('/inner.html'));
    expect(innerFrame, `frames=${JSON.stringify(frames)}`).toBeDefined();

    const r = await rawCallTool(client, 'safari_get_text', {
      tabUrl,
      selector: 'body',
      frameId: innerFrame!['frameId'],
    }, nextId(), 15_000);

    const text = JSON.stringify(r.payload);
    // inner.html body contains "Inner frame body" (h1) and "cross-origin iframe"
    expect(text, `payload=${text}`).toMatch(/Inner frame body|cross-origin iframe/);
    // host.html top-frame h1 is "Host page (port 19476)" — must NOT appear
    expect(text).not.toMatch(/Host page \(port/);
  }, 45_000);
});
