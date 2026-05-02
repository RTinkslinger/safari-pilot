/**
 * T55a Task 20 — safari_list_frames returns cross-origin iframe topology.
 *
 * Architectural coverage: webNavigation.getAllFrames in background.js sees the
 * cross-origin iframe (different port = different origin). Pre-T55a the only
 * frame topology came from same-origin DOM enumeration in the AppleScript
 * path, where cross-origin iframes appeared with frameId=null. With the
 * extension cap `framesCrossOrigin` flipped on, `safari_list_frames` routes
 * through the extension and returns the authoritative frameId.
 *
 * Litmus: revert the `__SP_LIST_FRAMES__` sentinel handling in background.js
 * — this test goes red because frameId stays null.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T55a — list frames cross-origin', () => {
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

  it('returns cross-origin frame with non-zero frameId, parentFrameId=0, src on inner port', async () => {
    const tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t20=1`;
    openedTabs.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl }, nextId(), 15_000);
    // Iframes need time to load before getAllFrames sees them.
    await new Promise((r) => setTimeout(r, 2500));

    const r = await rawCallTool(client, 'safari_list_frames', { tabUrl }, nextId(), 15_000);
    const frames = r.payload['frames'] as Array<Record<string, unknown>>;
    const count = r.payload['count'] as number;

    // host.html embeds 4 iframes (inner, inner-a, inner-b, shadow). The top
    // frame may or may not appear depending on the engine; assert at least
    // the inner iframe is present.
    expect(count, `frames=${JSON.stringify(frames)}`).toBeGreaterThanOrEqual(1);

    const innerFrame = frames.find(
      (f) => typeof f['url'] === 'string' && (f['url'] as string).includes(`:${fixture.innerPort}/inner.html`),
    );
    expect(innerFrame, `expected to find inner.html iframe; frames=${JSON.stringify(frames)}`).toBeDefined();
    // frameId from webNavigation is a positive integer; pre-T55a the AppleScript
    // path returned null. The whole point of T55a is that this is now a number.
    expect(typeof innerFrame!['frameId']).toBe('number');
    expect(innerFrame!['frameId']).not.toBe(0);
    expect(innerFrame!['parentFrameId']).toBe(0);
  }, 45_000);
});
