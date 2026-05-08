/**
 * Task 13 — safari_dismiss_overlays kill switch e2e (v0.1.31 R1 mitigation).
 *
 * The kill switch (SAFARI_PILOT_DISABLE_OVERLAY_DISMISS=true) must short-
 * circuit the dismiss path even on a known overlay. Without the flag, the
 * same call dismisses normally — proving the flag is the gate, not some
 * other failure path.
 *
 * Each test spawns its OWN MCP server with a custom env, since the shared
 * client (test/helpers/shared-client.ts) locks env at first spawn. The
 * Safari extension and daemon stack stays shared — only the MCP server
 * (`node dist/index.js`) is per-test.
 *
 * Tab cleanup: every opened tab is closed in a try/finally block per
 * feedback-e2e-tests-must-close-tabs. URL markers `?sp_kill[_off]=<ts>`
 * tag tabs for sweepability.
 */
import { describe, it, expect } from 'vitest';
import { initClient, callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { startOneTrustFixture } from '../fixtures/cookie-consent-onetrust.js';

interface DismissedEntry {
  category: string;
  id: string;
  selector: string;
  action: string;
  site: string;
  verified: boolean;
}
interface SkippedEntry { reason: string; candidate?: Record<string, unknown> }
interface DismissResult { dismissed: DismissedEntry[]; skipped: SkippedEntry[] }

async function spawnEnvClient(env: Record<string, string>): Promise<{ client: McpTestClient; nextId: () => number }> {
  let id: number;
  const initRes = await initClient('dist/index.js', 1, { env });
  id = initRes.nextId;
  return { client: initRes.client, nextId: () => id++ };
}

describe('safari_dismiss_overlays kill switch (v0.1.31 R1 mitigation)', () => {
  it('with SAFARI_PILOT_DISABLE_OVERLAY_DISMISS=true, returns dismissed=[] even on a known overlay', async () => {
    const { client, nextId } = await spawnEnvClient({ SAFARI_PILOT_DISABLE_OVERLAY_DISMISS: 'true' });
    const fixture = startOneTrustFixture();
    let tabUrl: string | undefined;
    try {
      const target = `${fixture.url()}?sp_kill=${Date.now()}`;
      const tab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
      tabUrl = tab.tabUrl as string;
      await callTool(
        client,
        'safari_wait_for',
        { tabUrl, condition: 'function', value: 'return document.readyState === "complete"', timeout: 10_000 },
        nextId(),
        15_000,
      );
      await new Promise((r) => setTimeout(r, 800));
      const result = (await callTool(
        client,
        'safari_dismiss_overlays',
        { tabUrl },
        nextId(),
        30_000,
      )) as unknown as DismissResult;
      expect(result.dismissed).toEqual([]);
      expect(result.skipped.some((s) => s.reason === 'kill_switch_engaged')).toBe(true);
    } finally {
      if (tabUrl) {
        try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ }
      }
      await new Promise<void>((r) => fixture.server.close(() => r()));
      await client.close();
    }
  }, 90_000);

  it('with kill switch unset, same call dismisses the OneTrust banner normally', async () => {
    const { client, nextId } = await spawnEnvClient({});
    const fixture = startOneTrustFixture();
    let tabUrl: string | undefined;
    try {
      const target = `${fixture.url()}?sp_kill_off=${Date.now()}`;
      const tab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
      tabUrl = tab.tabUrl as string;
      await callTool(
        client,
        'safari_wait_for',
        { tabUrl, condition: 'function', value: 'return document.readyState === "complete"', timeout: 10_000 },
        nextId(),
        15_000,
      );
      await new Promise((r) => setTimeout(r, 800));
      const result = (await callTool(
        client,
        'safari_dismiss_overlays',
        { tabUrl },
        nextId(),
        30_000,
      )) as unknown as DismissResult;
      expect(result.dismissed.length).toBeGreaterThan(0);
    } finally {
      if (tabUrl) {
        try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ }
      }
      await new Promise<void>((r) => fixture.server.close(() => r()));
      await client.close();
    }
  }, 90_000);
});
