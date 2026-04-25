/**
 * SD-05 lifecycle workflow — prevents the URL-as-identity cascade bug class
 * that CLAUDE.md history explicitly warns about.
 *
 * Pre-SD-05: each phase test file exercises atomic operations in its own
 * tab and closes it. No single test walks the full journey open → navigate
 * → interact → extract → navigate-back → navigate-forward → close as one
 * trail, asserting that the tab-ownership registry stays coherent at every
 * transition. A regression that leaves the registry pointing at the wrong
 * URL after (say) safari_navigate would only surface on a subsequent tool
 * call — and in the current atomic-tests layout, that subsequent call is
 * in a DIFFERENT test with a DIFFERENT tab, so the regression escapes.
 *
 * This test drives the full sequence in a single `it()` block. The
 * discriminator is the cascade property: if the registry breaks at ANY
 * transition, the NEXT tool call (which uses the tabUrl returned by the
 * previous step) throws TabUrlNotRecognizedError — and the test fails at
 * that hop, not generically somewhere later.
 *
 * Discrimination recipes (each breaks a different invariant):
 *
 *   1. `server.ts:711-726` — T2's post-navigate URL refresh. Comment out
 *      the `ownership_url_refreshed` branch → the registry still tracks
 *      the ORIGINAL tabUrl after safari_navigate. Step 3 (safari_fill on
 *      the new URL) fails with TabUrlNotRecognizedError.
 *
 *   2. `server.ts:767-782` — T7's close-tab eviction. Comment out the
 *      `tabOwnership.removeTab` branch → the closed URL stays in the
 *      registry. The final `assertOwnershipCleared` below would fail
 *      because the registry still resolves the closed URL.
 *
 *   3. `server.ts:802-805` — post-execution URL refresh via extension
 *      engine meta. Comment out the `tabOwnership.updateUrl` call → any
 *      click/evaluate that navigates the tab (like SD-03's click test)
 *      would leave the registry stale and the next step fails.
 *
 * Trace assertions use the shared live trace file (same pattern as
 * `test/e2e/security-ownership.test.ts`).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const LIVE_SERVER_TRACE = join(homedir(), '.safari-pilot', 'trace.ndjson');

function readEventsSince(tsIso: string): Array<Record<string, unknown>> {
  if (!existsSync(LIVE_SERVER_TRACE)) return [];
  return readFileSync(LIVE_SERVER_TRACE, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } })
    .filter((e) => {
      const ts = (e as { ts?: string }).ts;
      return typeof ts === 'string' && ts >= tsIso;
    });
}

describe('Lifecycle workflow (SD-05)', () => {
  let client: McpTestClient;
  let nextId: () => number;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 30_000);

  it('full journey: open → navigate → interact → extract → back → forward → close — registry coherent at every hop', async () => {
    const testStarted = new Date().toISOString();
    const marker = `sd05_${Date.now()}`;
    let tabUrl = '';

    try {
      // ── Hop 1: open a new tab ────────────────────────────────────────
      const openUrl = `https://example.com/?sp_${marker}=open`;
      const tab = await callTool(client, 'safari_new_tab', { url: openUrl }, nextId(), 15_000);
      tabUrl = tab.tabUrl as string;
      expect(tabUrl).toContain('example.com');
      expect(tabUrl).toContain(marker);
      await new Promise(r => setTimeout(r, 3000));

      // Registry invariant: the tab IS listed AND is agent-owned (subsequent
      // calls with this tabUrl must succeed; list_tabs alone doesn't prove
      // ownership because it bypasses the ownership check).
      const listAfterOpen = await callTool(client, 'safari_list_tabs', {}, nextId());
      const tabsAfterOpen = (listAfterOpen.tabs ?? []) as Array<{ url?: string }>;
      expect(
        tabsAfterOpen.some((t) => (t.url ?? '').includes(marker)),
        `open: freshly-opened tab must appear in safari_list_tabs`,
      ).toBe(true);

      // ── Hop 2: navigate to a form page ───────────────────────────────
      const nav1 = await callTool(
        client, 'safari_navigate',
        { url: 'https://httpbin.org/forms/post', tabUrl },
        nextId(),
        30_000,
      );
      const urlAfterNav1 = nav1.url as string;
      expect(urlAfterNav1).toContain('httpbin.org/forms/post');
      tabUrl = urlAfterNav1;

      // Registry invariant (T2): after safari_navigate the registry updates
      // to the new URL. The proof that it did: a subsequent call using the
      // NEW tabUrl must succeed. Plus the `ownership_url_refreshed` trace
      // event is emitted — SD-05 asserts on that explicitly, filtered by
      // the SPECIFIC oldUrl → newUrl pair for THIS hop (not just any
      // post-test event, which would succumb to shared-client concurrency
      // from other tests).
      await new Promise(r => setTimeout(r, 300));
      const refreshEvents = readEventsSince(testStarted).filter((e) => {
        if ((e as { event?: string }).event !== 'ownership_url_refreshed') return false;
        const data = (e as { data?: Record<string, unknown> }).data;
        return data?.['oldUrl'] === openUrl && data?.['newUrl'] === urlAfterNav1;
      });
      expect(
        refreshEvents.length,
        `T2: ownership_url_refreshed trace must fire for ${openUrl} → ${urlAfterNav1}`,
      ).toBeGreaterThan(0);

      // ── Hop 3: interact — fill an input on the new page ──────────────
      const fill = await callTool(
        client, 'safari_fill',
        { tabUrl, selector: 'input[name="custname"]', value: `sd05-${marker}` },
        nextId(),
        15_000,
      );
      expect(fill.filled).toBe(true);

      // Registry invariant: if hop 2 had NOT refreshed the registry, this
      // safari_fill with the new tabUrl would throw TabUrlNotRecognizedError.

      // ── Hop 4: extract — read the value back (closes the loop) ──────
      const extract = await callTool(
        client, 'safari_evaluate',
        {
          tabUrl,
          script: `return document.querySelector('input[name="custname"]').value`,
        },
        nextId(),
        15_000,
      );
      const extractedValue = (extract as { value: string }).value;
      expect(extractedValue).toBe(`sd05-${marker}`);

      // ── Hop 5: navigate back (via history) ───────────────────────────
      const back = await callTool(
        client, 'safari_navigate_back',
        { tabUrl },
        nextId(),
        15_000,
      );
      const urlAfterBack = back.url as string;
      expect(urlAfterBack).toContain('example.com');
      tabUrl = urlAfterBack;

      // ── Hop 6: navigate forward ──────────────────────────────────────
      const fwd = await callTool(
        client, 'safari_navigate_forward',
        { tabUrl },
        nextId(),
        15_000,
      );
      const urlAfterFwd = fwd.url as string;
      expect(urlAfterFwd).toContain('httpbin.org');
      tabUrl = urlAfterFwd;

      // ── Hop 7: close the tab ─────────────────────────────────────────
      const close = await callTool(
        client, 'safari_close_tab',
        { tabUrl },
        nextId(),
        10_000,
      );
      expect(close.closed).toBe(true);

      // Registry invariant (T7): the URL must NOT remain in the registry
      // after close. Proof via trace event — server.ts:775 emits
      // `ownership_tab_removed` with this URL precisely when removeTab runs.
      await new Promise(r => setTimeout(r, 300));
      const removeEvents = readEventsSince(testStarted).filter(
        (e) =>
          (e as { event?: string }).event === 'ownership_tab_removed' &&
          ((e as { data?: Record<string, unknown> }).data?.['tabUrl'] as string | undefined) === tabUrl,
      );
      expect(
        removeEvents.length,
        `T7: ownership_tab_removed trace event must fire for closed tab ${tabUrl}`,
      ).toBeGreaterThan(0);

      tabUrl = ''; // signal to the finally block that cleanup is done
    } finally {
      // Best-effort cleanup if any step above failed mid-journey — every
      // hop reassigns tabUrl, so the last-known-good URL is what we try to
      // close. This is idempotent: if the tab is already closed the call
      // throws and we swallow.
      if (tabUrl) {
        try {
          await callTool(client, 'safari_close_tab', { tabUrl }, nextId());
        } catch { /* already closed / unknown */ }
      }
    }
  }, 120_000);
});
