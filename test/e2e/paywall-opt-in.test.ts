/**
 * Task 13 — paywall opt-in flag e2e (v0.1.31 R2 mitigation).
 *
 * Paywall patterns are OPT-IN. Without SAFARI_PILOT_ENABLE_PAYWALL_DISMISS=true
 * a paywall must NOT be dismissed (skipped with reason=paywall_opt_in_required).
 * With the flag set, the paywall IS dismissed.
 *
 * Each test spawns its OWN MCP server with a custom env (the shared client
 * locks env at first spawn). Tab cleanup in try/finally per
 * feedback-e2e-tests-must-close-tabs.
 */
import { describe, it, expect } from 'vitest';
import { initClient, callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { startPaywallNytMockFixture } from '../fixtures/paywall-nyt-mock.js';

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

describe('safari_dismiss_overlays paywall opt-in (v0.1.31 R2 mitigation)', () => {
  it('default (flag unset): paywall NOT dismissed, skipped reason=paywall_opt_in_required', async () => {
    const { client, nextId } = await spawnEnvClient({});
    const fixture = startPaywallNytMockFixture();
    let tabUrl: string | undefined;
    try {
      const target = `${fixture.url()}?sp_paywall_off=${Date.now()}`;
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
      expect(result.dismissed.every((d) => d.category !== 'paywall')).toBe(true);
      expect(result.skipped.some((s) => s.reason === 'paywall_opt_in_required')).toBe(true);
    } finally {
      if (tabUrl) {
        try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ }
      }
      await new Promise<void>((r) => fixture.server.close(() => r()));
      await client.close();
    }
  }, 90_000);

  it('with SAFARI_PILOT_ENABLE_PAYWALL_DISMISS=true: paywall IS dismissed', async () => {
    const { client, nextId } = await spawnEnvClient({ SAFARI_PILOT_ENABLE_PAYWALL_DISMISS: 'true' });
    const fixture = startPaywallNytMockFixture();
    let tabUrl: string | undefined;
    try {
      const target = `${fixture.url()}?sp_paywall_on=${Date.now()}`;
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
      expect(result.dismissed.some((d) => d.category === 'paywall')).toBe(true);
    } finally {
      if (tabUrl) {
        try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ }
      }
      await new Promise<void>((r) => fixture.server.close(() => r()));
      await client.close();
    }
  }, 90_000);
});
