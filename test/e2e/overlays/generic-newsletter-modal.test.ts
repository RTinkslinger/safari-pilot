/**
 * Task 14 — per-pattern: generic-newsletter-modal (registration-wall).
 *
 * POSITIVE: shipped fixture in test/fixtures/registration-wall-newsletter.ts
 *   (has click-removes-self handler on Close button).
 * NEGATIVE: shipped fixture in test/fixtures/overlays-negative/generic-newsletter-modal.negative.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../../helpers/mcp-client.js';
import { getSharedClient } from '../../helpers/shared-client.js';
import { startNewsletterFixture } from '../../fixtures/registration-wall-newsletter.js';
import { startGenericNewsletterModalNegativeFixture } from '../../fixtures/overlays-negative/generic-newsletter-modal.negative.js';

interface DismissedEntry { category: string; id: string; selector: string; action: string; site: string; verified: boolean }
interface SkippedEntry { reason: string; candidate?: Record<string, unknown> }
interface DismissResult { dismissed: DismissedEntry[]; skipped: SkippedEntry[] }

describe('pattern: generic-newsletter-modal — positive + negative pair', () => {
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
    return (await callTool(client, 'safari_dismiss_overlays', { tabUrl, categories: ['registration-wall'] }, nextId(), 30_000)) as unknown as DismissResult;
  }

  it('POSITIVE: dismisses generic-newsletter-modal', async () => {
    const fixture = startNewsletterFixture();
    try {
      const result = await dismiss(fixture.url(), 'newsletter-pos');
      expect(result.dismissed.some((d) => d.id === 'generic-newsletter-modal')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);

  it('NEGATIVE: does NOT dismiss legitimate non-subscribe dialog', async () => {
    const fixture = startGenericNewsletterModalNegativeFixture();
    try {
      const result = await dismiss(fixture.url(), 'newsletter-neg');
      expect(result.dismissed.every((d) => d.id !== 'generic-newsletter-modal')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);
});
