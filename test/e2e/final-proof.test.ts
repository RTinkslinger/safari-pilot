/**
 * v0.1.35 Task 7 — safari_compose_final_evidence e2e
 *
 * NOTE: This test is INTENTIONALLY DEFERRED at write-time. It exercises the
 * new `__SP_COMPOSE_FINAL_EVIDENCE__` extension sentinel which is only built
 * into the Safari Pilot extension by the batched rebuild scheduled at the end
 * of v0.1.35 Task 10. Running the file before that rebuild will fail with
 * "Unknown method"-style errors from the installed extension binary.
 *
 * The file ships now so it compiles under `npm run lint` / `npm run build`,
 * proving the wiring on the TS side. Real e2e verification happens after
 * Task 10's batched build-extension.sh + open Safari Pilot.app.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('v0.1.35 T7 — safari_compose_final_evidence', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 60_000);

  afterAll(async () => {
    if (fixture) await fixture.close();
  });

  it('captures screenshot + DOM snippet for a claim grounded in page content', async () => {
    const url = `http://127.0.0.1:${fixture.hostPort}/with-claim?sp_tT7a=${Date.now()}`;
    const tab = (await callTool(client, 'safari_new_tab', { url }, nextId(), 15_000)) as {
      tab_id?: number;
    };
    const tabId = tab.tab_id;
    try {
      const result = (await callTool(
        client,
        'safari_compose_final_evidence',
        {
          tabUrl: url,
          claim: 'The recipe has 4.5 stars and 563 ratings',
          evidence_locator: { selector: '#rating-block' },
        },
        nextId(),
        30_000,
      )) as { screenshot_path?: string; dom_snippet?: string; claim_grounded?: boolean };

      expect(result.screenshot_path).toBeTruthy();
      if (result.screenshot_path) {
        expect(existsSync(result.screenshot_path)).toBe(true);
      }
      expect(result.dom_snippet).toMatch(/4\.5/);
      expect(result.claim_grounded).toBe(true);
    } finally {
      if (typeof tabId === 'number') {
        await callTool(client, 'safari_close_tab', { tabId }, nextId(), 10_000).catch(() => {});
      }
    }
  }, 60_000);

  it('reports claim_grounded:false when claim text not found in DOM', async () => {
    const url = `http://127.0.0.1:${fixture.hostPort}/with-claim?sp_tT7b=${Date.now()}`;
    const tab = (await callTool(client, 'safari_new_tab', { url }, nextId(), 15_000)) as {
      tab_id?: number;
    };
    const tabId = tab.tab_id;
    try {
      const result = (await callTool(
        client,
        'safari_compose_final_evidence',
        {
          tabUrl: url,
          claim: 'The recipe has 9.9 stars',
          evidence_locator: { selector: '#rating-block' },
        },
        nextId(),
        30_000,
      )) as { claim_grounded?: boolean };

      expect(result.claim_grounded).toBe(false);
    } finally {
      if (typeof tabId === 'number') {
        await callTool(client, 'safari_close_tab', { tabId }, nextId(), 10_000).catch(() => {});
      }
    }
  }, 60_000);
});
