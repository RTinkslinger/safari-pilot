/**
 * T55a Task 27 — concurrent frame commands return uncrossed results.
 *
 * D6 (decision 6 in the T55a plan) keys storage-bus messages by commandId
 * — `sp_cmd_<commandId>` and `sp_result_<commandId>` instead of a single
 * shared `sp_cmd` / `sp_result` key. Without commandId scoping, two
 * concurrent in-flight commands race on the same storage key and the
 * second clobbers the first; results may be returned to the wrong caller.
 *
 * This test fires Promise.all of two safari_eval_in_frame calls targeting
 * different iframes (inner-a.html with FRAME_A_MARKER, inner-b.html with
 * FRAME_B_MARKER) and asserts results are not crossed.
 *
 * Litmus: revert the commandId-keyed storage and the test goes red because
 * one result will contain the other's marker (or one will time out).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T55a — concurrent frame commands', () => {
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

  it('Promise.all of two eval_in_frame to distinct frames returns non-crossed results', async () => {
    const tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t27=1`;
    openedTabs.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 2500));

    const list = await rawCallTool(client, 'safari_list_frames', { tabUrl }, nextId(), 15_000);
    const frames = list.payload['frames'] as Array<Record<string, unknown>>;
    const a = frames.find((f) => typeof f['url'] === 'string' && (f['url'] as string).endsWith('/inner-a.html'));
    const b = frames.find((f) => typeof f['url'] === 'string' && (f['url'] as string).endsWith('/inner-b.html'));
    expect(a, `inner-a.html frame missing; frames=${JSON.stringify(frames)}`).toBeDefined();
    expect(b, `inner-b.html frame missing; frames=${JSON.stringify(frames)}`).toBeDefined();

    // Wrap returns as objects — safari_eval_in_frame's response path
    // JSON.parses result.value, so a bare string return fails parse.
    const [resA, resB] = await Promise.all([
      rawCallTool(client, 'safari_eval_in_frame', {
        tabUrl, frameId: a!['frameId'], script: "return { text: document.querySelector('h1').textContent }",
      }, nextId(), 20_000),
      rawCallTool(client, 'safari_eval_in_frame', {
        tabUrl, frameId: b!['frameId'], script: "return { text: document.querySelector('h1').textContent }",
      }, nextId(), 20_000),
    ]);

    const textA = JSON.stringify(resA.payload);
    const textB = JSON.stringify(resB.payload);
    expect(textA, `resA=${textA}`).toContain('FRAME_A_MARKER');
    expect(textB, `resB=${textB}`).toContain('FRAME_B_MARKER');
    // Cross-clobbering check: D6 ensures neither result contains the other's marker.
    expect(textA).not.toContain('FRAME_B_MARKER');
    expect(textB).not.toContain('FRAME_A_MARKER');
  }, 60_000);
});
