/**
 * T55a Task 23 — frame-targeted calls respect the security pipeline.
 *
 * Tab ownership is layer 2 of server.ts:executeToolWithSecurity, which
 * means a frame-targeted call against a tab the agent never opened must
 * fail at TabUrlNotRecognized — before any frame-specific validation runs.
 *
 * Litmus: if a future regression hoists frameId validation in front of
 * tab ownership, we'd see FRAME_NOT_FOUND here instead of
 * TabUrlNotRecognized — security boundary violated.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T55a — frame call respects security pipeline ordering', () => {
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

  it('unowned tab + frame-targeted call returns TabUrlNotRecognized, NOT FRAME_NOT_FOUND', async () => {
    // Intentionally never call safari_new_tab on this URL — the agent
    // does not own it. The security pipeline must reject it at layer 2.
    const unownedUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t23_unowned=1`;

    let caught: unknown = null;
    let payload: Record<string, unknown> | null = null;
    try {
      const r = await rawCallTool(client, 'safari_eval_in_frame', {
        tabUrl: unownedUrl,
        frameId: 5,
        script: 'return 1',
      }, nextId(), 15_000);
      payload = r.payload;
    } catch (e) {
      caught = e;
    }

    const errStr = caught
      ? (caught instanceof Error ? caught.message : JSON.stringify(caught))
      : JSON.stringify(payload);

    // Security/ownership must fire first — error must reference tab ownership,
    // not frame validation. Accept any of:
    //   - TabUrlNotRecognizedError from server.ts ownership layer (TS path)
    //   - TAB_NOT_OWNED error code
    //   - TAB_NOT_FOUND from extension findTargetTab (cache miss; "No agent-owned tab matches url=...")
    expect(errStr, `payload=${JSON.stringify(payload)} caught=${String(caught)}`)
      .toMatch(/TabUrlNotRecognized|TAB_NOT_OWNED|TAB_NOT_FOUND|not recognized|agent-owned tab/i);
    expect(errStr).not.toMatch(/FRAME_NOT_FOUND/);
  }, 45_000);
});
