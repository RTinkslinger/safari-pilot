/**
 * Task 12 — safari_dismiss_overlays e2e (v0.1.31).
 *
 * Validates the Tasks 10+11 dismiss-overlays pipeline through the full shipped
 * stack: MCP server → engine selector → ExtensionEngine →
 * __SP_DISMISS_OVERLAYS__:<json> sentinel → content-main.js intercept →
 * locator.js dismissPattern() → sanitized response → IdpiAnnotator scan.
 *
 * Six assertions:
 *   1. OneTrust cookie banner dismisses with verified=true.
 *   2. Shadow-DOM cookie banner dismisses (penetration check).
 *   3. Newsletter registration wall dismisses.
 *   4. No-overlay control returns dismissed=[] and overlaysAtStart=0.
 *   5. DANGER fixture: legitimate confirm dialog NOT dismissed.
 *   6. Paywall on default install (no opt-in flag) NOT dismissed → skipped.
 *
 * Conventions follow test/e2e/scroll-to-element.test.ts:
 *   - getSharedClient() singleton (teardown by setupFile).
 *   - URL marker `?sp_dismiss=<test-id>` per opened tab for sweepability.
 *   - Every opened tab is recorded and closed in afterAll
 *     (per feedback-e2e-tests-must-close-tabs).
 *
 * v0.1.31 KNOWN ISSUE — boolean coercion of integer 0/1 in extension result.
 * The storage-bus → daemon → server encoding pipeline coerces integer 0 → false
 * and 1 → true. Numeric fields like `overlaysAtStart` arrive as `false`/`true`.
 * The asInt() normalizer below handles this; fix is deferred to a future release per
 * project-v0132-bool-coercion-carryforward.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startOneTrustFixture } from '../fixtures/cookie-consent-onetrust.js';
import { startShadowCookieFixture } from '../fixtures/cookie-consent-shadow.js';
import { startNewsletterFixture } from '../fixtures/registration-wall-newsletter.js';
import { startPaywallNytMockFixture } from '../fixtures/paywall-nyt-mock.js';
import { startNoOverlayFixture } from '../fixtures/no-overlay-control.js';
import { startLegitimateConfirmFixture } from '../fixtures/legitimate-confirm-dialog.js';

function asInt(v: unknown): number {
  if (typeof v === 'number') return v;
  // v0.1.31 known issue: daemon Models.swift coerces 0/1 → false/true (deferred to a future release).
  if (v === false) return 0;
  if (v === true) return 1;
  return Number(v);
}

interface DismissedEntry {
  category: string;
  id: string;
  selector: string;
  action: string;
  site: string;
  verified: boolean;
}

interface SkippedEntry {
  reason: string;
  candidate?: { selector?: string; category?: string; hint?: string };
}

interface DismissResult {
  dismissed: DismissedEntry[];
  skipped: SkippedEntry[];
  overlaysAtStart: number | boolean;
  overlaysAtEnd: number | boolean;
}

describe('safari_dismiss_overlays e2e (v0.1.31 Task 12)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 35_000);

  afterAll(async () => {
    if (client) {
      for (const tabUrl of openedTabUrls) {
        try {
          await callTool(client, 'safari_close_tab', { tabUrl }, nextId());
        } catch { /* best-effort cleanup */ }
      }
    }
  });

  /**
   * Open a tab on a fixture URL with a per-test marker, wait for ready, then
   * dispatch safari_dismiss_overlays. Records tabUrl in openedTabUrls so
   * afterAll sweeps it.
   */
  async function openTabAndDismiss(
    baseUrl: string,
    marker: string,
  ): Promise<{ tabUrl: string; result: DismissResult }> {
    const target = `${baseUrl}?sp_dismiss=${marker}-${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = tab.tabUrl as string;
    openedTabUrls.push(tabUrl);
    await callTool(
      client,
      'safari_wait_for',
      {
        tabUrl,
        condition: 'function',
        value: 'return document.readyState === "complete"',
        timeout: 10_000,
      },
      nextId(),
      15_000,
    );
    // Brief settle window so any deferred overlay scripts can attach.
    await new Promise((r) => setTimeout(r, 800));
    const result = (await callTool(
      client,
      'safari_dismiss_overlays',
      { tabUrl },
      nextId(),
      30_000,
    )) as unknown as DismissResult;
    return { tabUrl, result };
  }

  it('dismisses OneTrust cookie banner with verified=true', async () => {
    const fixture = startOneTrustFixture();
    try {
      const { result } = await openTabAndDismiss(fixture.url(), 'onetrust');
      expect(result.dismissed.length).toBeGreaterThan(0);
      expect(result.dismissed[0].id).toBe('onetrust-banner');
      // v0.1.31 known issue: bool coercion deferred to a future release.
      // verified is a true bool in source, so this should be true regardless.
      expect(result.dismissed[0].verified).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);

  it('penetrates open shadow root for cookie banner', async () => {
    const fixture = startShadowCookieFixture();
    try {
      const { result } = await openTabAndDismiss(fixture.url(), 'shadow');
      expect(result.dismissed.length).toBeGreaterThan(0);
      expect(result.dismissed[0].category).toBe('cookie-consent');
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);

  it('dismisses generic newsletter registration wall', async () => {
    const fixture = startNewsletterFixture();
    try {
      const { result } = await openTabAndDismiss(fixture.url(), 'newsletter');
      expect(result.dismissed.some((d) => d.category === 'registration-wall')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);

  it('on no-overlay page, returns dismissed=[] and overlaysAtStart=0', async () => {
    const fixture = startNoOverlayFixture();
    try {
      const { result } = await openTabAndDismiss(fixture.url(), 'control');
      expect(result.dismissed).toEqual([]);
      // v0.1.31 known issue: bool coercion deferred to a future release.
      expect(asInt(result.overlaysAtStart)).toBe(0);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);

  it('DANGER: legitimate confirm dialog is NOT dismissed', async () => {
    // Highest-risk safety regression: a legit "discard your unsaved changes?"
    // dialog must never be auto-dismissed. dismissed[] must be empty.
    const fixture = startLegitimateConfirmFixture();
    try {
      const { result } = await openTabAndDismiss(fixture.url(), 'danger');
      expect(result.dismissed).toEqual([]);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);

  it('paywall on default install (opt-in flag NOT set) is NOT dismissed; goes to skipped', async () => {
    const fixture = startPaywallNytMockFixture();
    try {
      const { result } = await openTabAndDismiss(fixture.url(), 'paywall-default');
      expect(result.dismissed.every((d) => d.category !== 'paywall')).toBe(true);
      expect(result.skipped.some((s) => s.reason === 'paywall_opt_in_required')).toBe(true);
    } finally {
      await new Promise<void>((r) => fixture.server.close(() => r()));
    }
  }, 60_000);
});
