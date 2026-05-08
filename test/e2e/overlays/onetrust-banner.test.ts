/**
 * Task 14 — per-pattern: onetrust-banner (cookie-consent).
 *
 * POSITIVE: shipped fixture in test/fixtures/cookie-consent-onetrust.ts (has
 *   click-removes-self handler).
 * NEGATIVE: shipped fixture in test/fixtures/overlays-negative/onetrust-banner.negative.ts
 *   — same #onetrust-banner-sdk id but aria-label is a $49.99 purchase confirm,
 *   NOT containing "cookie". Auto-dismissing would silently confirm the charge.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../../helpers/mcp-client.js';
import { getSharedClient } from '../../helpers/shared-client.js';
import { startOneTrustFixture } from '../../fixtures/cookie-consent-onetrust.js';
import { startOnetrustBannerNegativeFixture } from '../../fixtures/overlays-negative/onetrust-banner.negative.js';

interface DismissedEntry { category: string; id: string; selector: string; action: string; site: string; verified: boolean }
interface SkippedEntry { reason: string; candidate?: Record<string, unknown> }
interface DismissResult { dismissed: DismissedEntry[]; skipped: SkippedEntry[] }

describe('pattern: onetrust-banner — positive + negative pair', () => {
  let client: McpTestClient;
  let nextId: () => number;
  const opened: string[] = [];

  beforeAll(async () => { const s = await getSharedClient(); client = s.client; nextId = s.nextId; }, 35_000);

  afterAll(async () => {
    if (!client) return;
    for (const u of opened) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: u }, nextId()); } catch { /* ignore */ }
    }
  });

  async function dismiss(url: string, marker: string): Promise<DismissResult> {
    const tab = await callTool(client, 'safari_new_tab', { url: `${url}?sp_pat=${marker}-${Date.now()}` }, nextId(), 15_000);
    const tabUrl = tab.tabUrl as string;
    opened.push(tabUrl);
    await callTool(client, 'safari_wait_for', {
      tabUrl, condition: 'function', value: 'return document.readyState === "complete"', timeout: 10_000,
    }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 800));
    return (await callTool(client, 'safari_dismiss_overlays', { tabUrl, categories: ['cookie-consent'] }, nextId(), 30_000)) as unknown as DismissResult;
  }

  it('POSITIVE: dismisses onetrust-banner', async () => {
    const fixture = startOneTrustFixture();
    try {
      const result = await dismiss(fixture.url(), 'onetrust-pos');
      expect(result.dismissed.some((d) => d.id === 'onetrust-banner')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);

  it('NEGATIVE: does NOT dismiss legitimate $49.99 purchase confirm reusing the OneTrust id', async () => {
    const fixture = startOnetrustBannerNegativeFixture();
    try {
      const result = await dismiss(fixture.url(), 'onetrust-neg');
      expect(result.dismissed.every((d) => d.id !== 'onetrust-banner')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);
});
