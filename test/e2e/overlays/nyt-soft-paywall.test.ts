/**
 * Task 14 — per-pattern: nyt-soft-paywall (paywall).
 *
 * POSITIVE: shipped fixture in test/fixtures/paywall-nyt-mock.ts (action is
 *   `remove-node`, no click handler needed). Requires
 *   SAFARI_PILOT_ENABLE_PAYWALL_DISMISS=true (paywall opt-in gate). Spawns
 *   per-test client with env injection (mirrors test/e2e/paywall-opt-in.test.ts).
 * NEGATIVE: shipped fixture in test/fixtures/overlays-negative/nyt-soft-paywall.negative.ts.
 *   Negative test runs without the opt-in flag — same as the default-install
 *   case in T13, but additionally asserts pattern id is not in dismissed[].
 */
import { describe, it, expect } from 'vitest';
import { initClient, callTool, type McpTestClient } from '../../helpers/mcp-client.js';
import { startPaywallNytMockFixture } from '../../fixtures/paywall-nyt-mock.js';
import { startNytSoftPaywallNegativeFixture } from '../../fixtures/overlays-negative/nyt-soft-paywall.negative.js';

interface DismissedEntry { category: string; id: string; selector: string; action: string; site: string; verified: boolean }
interface SkippedEntry { reason: string; candidate?: Record<string, unknown> }
interface DismissResult { dismissed: DismissedEntry[]; skipped: SkippedEntry[] }

async function spawnEnvClient(env: Record<string, string>): Promise<{ client: McpTestClient; nextId: () => number }> {
  let id: number;
  const initRes = await initClient('dist/index.js', 1, { env });
  id = initRes.nextId;
  return { client: initRes.client, nextId: () => id++ };
}

async function dismissOnSpawnedClient(
  client: McpTestClient,
  nextId: () => number,
  url: string,
  marker: string,
): Promise<{ tabUrl: string; result: DismissResult }> {
  const tab = await callTool(client, 'safari_new_tab', { url: `${url}?sp_pat=${marker}-${Date.now()}` }, nextId(), 15_000);
  const tabUrl = tab.tabUrl as string;
  await callTool(client, 'safari_wait_for', {
    tabUrl, condition: 'function', value: 'return document.readyState === "complete"', timeout: 10_000,
  }, nextId(), 15_000);
  await new Promise((r) => setTimeout(r, 800));
  const result = (await callTool(client, 'safari_dismiss_overlays', { tabUrl, categories: ['paywall'] }, nextId(), 30_000)) as unknown as DismissResult;
  return { tabUrl, result };
}

describe('pattern: nyt-soft-paywall — positive + negative pair', () => {
  it('POSITIVE: dismisses nyt-soft-paywall (with SAFARI_PILOT_ENABLE_PAYWALL_DISMISS=true)', async () => {
    const { client, nextId } = await spawnEnvClient({ SAFARI_PILOT_ENABLE_PAYWALL_DISMISS: 'true' });
    const fixture = startPaywallNytMockFixture();
    let tabUrl: string | undefined;
    try {
      const r = await dismissOnSpawnedClient(client, nextId, fixture.url(), 'nyt-pos');
      tabUrl = r.tabUrl;
      expect(r.result.dismissed.some((d) => d.id === 'nyt-soft-paywall')).toBe(true);
    } finally {
      if (tabUrl) { try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ } }
      await new Promise<void>((r) => fixture.server.close(() => r()));
      await client.close();
    }
  }, 90_000);

  it('NEGATIVE: does NOT dismiss legitimate non-paywall content reusing #gateway-content', async () => {
    // Even with paywall enabled, the negative fixture's signals shouldn't match.
    // Use opt-in env so we don't conflate "skipped due to opt-in" with "didn't match".
    const { client, nextId } = await spawnEnvClient({ SAFARI_PILOT_ENABLE_PAYWALL_DISMISS: 'true' });
    const fixture = startNytSoftPaywallNegativeFixture();
    let tabUrl: string | undefined;
    try {
      const r = await dismissOnSpawnedClient(client, nextId, fixture.url(), 'nyt-neg');
      tabUrl = r.tabUrl;
      expect(r.result.dismissed.every((d) => d.id !== 'nyt-soft-paywall')).toBe(true);
    } finally {
      if (tabUrl) { try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ } }
      await new Promise<void>((r) => fixture.server.close(() => r()));
      await client.close();
    }
  }, 90_000);
});
