/**
 * T55a Task 22 — bogus frameId fails fast with FRAME_NOT_FOUND.
 *
 * background.js validates frameId against webNavigation.getAllFrames before
 * dispatching the command to a content script. A bogus frameId must short-
 * circuit at validation time (sub-second), not wait for the 90s extension
 * timeout.
 *
 * Litmus: remove the frameId-in-frames check in background.js's command
 * dispatch — the bogus call queues forever and times out at 90s instead of
 * <2s.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T55a — frame not found is fast', () => {
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

  it('eval_in_frame with bogus frameId returns FRAME_NOT_FOUND fast', async () => {
    const tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t22=1`;
    openedTabs.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 2500));

    const start = Date.now();
    let caught: unknown = null;
    let payload: Record<string, unknown> | null = null;
    try {
      const r = await rawCallTool(client, 'safari_eval_in_frame', {
        tabUrl,
        frameId: 9999,
        script: 'return 1',
      }, nextId(), 15_000);
      payload = r.payload;
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;

    // The error may surface as a thrown Error (handler throws) OR as a
    // structured tool error in payload. Accept either; require the error
    // shape to mention FRAME_NOT_FOUND or the bogus frame number.
    const errStr = caught
      ? (caught instanceof Error ? caught.message : JSON.stringify(caught))
      : JSON.stringify(payload);
    expect(errStr, `elapsed=${elapsed}ms payload=${JSON.stringify(payload)} caught=${String(caught)}`).toMatch(/FRAME_NOT_FOUND|Frame 9999/);
    // Validation must be fast — < 3s rules out the 90s extension timeout.
    expect(elapsed, `validation took ${elapsed}ms`).toBeLessThan(3000);
  }, 45_000);
});
