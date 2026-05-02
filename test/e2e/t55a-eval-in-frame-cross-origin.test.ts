/**
 * T55a Task 21 — safari_eval_in_frame executes inside a cross-origin iframe.
 *
 * The script must run with the iframe's document as `document` (so
 * document.title returns the iframe's title, not the host page's). This
 * proves the storage-bus relay routed the command to the right
 * frame-context content script — not just executed at top frame.
 *
 * Litmus: drop the frameId from background.js's command dispatch — the
 * MAIN-world script lands in the top frame and document.title returns
 * "Host Page", failing this test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T55a — eval in cross-origin frame', () => {
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

  it('returns the iframe document.title, not the host title', async () => {
    const tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t21=1`;
    openedTabs.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 2500));

    const list = await rawCallTool(client, 'safari_list_frames', { tabUrl }, nextId(), 15_000);
    const frames = list.payload['frames'] as Array<Record<string, unknown>>;
    const innerFrame = frames.find((f) => typeof f['url'] === 'string' && (f['url'] as string).endsWith('/inner.html'));
    expect(innerFrame, `inner.html iframe must be discoverable; frames=${JSON.stringify(frames)}`).toBeDefined();

    // Wrap return as an object — safari_eval_in_frame doesn't apply
    // safari_evaluate's auto-{value,type} wrapper, and the response
    // path JSON.parses the result.value, so a bare string fails parse.
    // Returning a JSON-serializable object is the contract here.
    const r = await rawCallTool(client, 'safari_eval_in_frame', {
      tabUrl,
      frameId: innerFrame!['frameId'],
      script: 'return { title: document.title }',
    }, nextId(), 15_000);

    const text = JSON.stringify(r.payload);
    // host.html title = "Host Page", inner.html title = "Inner Frame Document"
    expect(text, `payload=${text}`).toContain('Inner Frame Document');
    expect(text).not.toContain('Host Page');
  }, 45_000);
});
