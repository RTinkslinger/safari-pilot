/**
 * T21 — `extension/content-main.js` must patch `history.pushState` /
 * `replaceState` (and emit on `popstate`) so SPA URL changes propagate
 * to the extension's `tabCacheMap`. Pre-fix: SPA navigations via the
 * History API don't fire `tabs.onUpdated` reliably (Safari quirk), so
 * the cache holds the old URL. In awake context the bug is invisible
 * (the daemon's tabs.query lookup uses the real Safari URL), but in
 * alarm-wake context where `tabs.query({})` returns `[]`, the stale
 * cache is the only signal — and finding `findTargetTab` falls through
 * (T27 then makes that fail-closed).
 *
 * Discriminating scenario: simulate the alarm-wake quirk via the
 * DEBUG_HARNESS test bridge (`__sp_test_skip_tabs_query__` flag),
 * trigger an SPA URL change via `history.replaceState`, then issue a
 * tool call against the NEW URL. The daemon's TabOwnership has the
 * new URL (refreshed via `_meta.tabUrl` enrichment by the previous
 * eval), so layer-2 passes and the call reaches the extension's
 * cache-only lookup.
 *
 *   - PRE-FIX:  cache still holds the OLD URL (replaceState didn't
 *     fire tabs.onUpdated). findTargetTab cache-miss → T27's fail-
 *     closed → `TAB_NOT_FOUND` error surfaces.
 *   - POST-FIX: pushState/replaceState wrapper in MAIN world fires
 *     a `SAFARI_PILOT_URL_CHANGE` postMessage; content-isolated.js
 *     relays via `runtime.sendMessage({type:'sp_url_changed', url})`;
 *     background.js updates `tabCacheMap`. Cache holds the NEW URL
 *     → findTargetTab match → eval runs in tab A → returns the new
 *     `location.href`.
 *
 * Litmus: revert the MAIN-world wrapper and the assertion flips back
 * to `TAB_NOT_FOUND` — exactly the cache-staleness failure mode.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rawCallTool, callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

async function harness(
  client: McpTestClient,
  nextId: () => number,
  tabUrl: string,
  op: Record<string, unknown>,
  timeoutMs = 10000,
): Promise<Record<string, unknown>> {
  const r = await rawCallTool(
    client,
    'safari_evaluate',
    { tabUrl, script: `__SP_TEST_HARNESS__:${JSON.stringify(op)}` },
    nextId(),
    timeoutMs,
  );
  return r.payload;
}

describe('T21 — SPA history.replaceState refreshes extension tabCacheMap', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let tabA: string | null = null;
  let tabB: string | null = null;
  let tabANewUrl: string | null = null;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 30000);

  afterAll(async () => {
    // Repopulate cache by opening a fresh tab so the post-test flag
    // removal can route via findTargetTab (cache may be in an
    // inconsistent state otherwise — see T27 cleanup pattern).
    const cleanupTarget = tabA || tabB;
    if (cleanupTarget) {
      try {
        const refresh = await callTool(
          client,
          'safari_new_tab',
          { url: `https://example.com/?sp_t21_refresh=${Date.now()}` },
          nextId(),
        );
        const refreshUrl = refresh.tabUrl as string;
        await new Promise((r) => setTimeout(r, 500));
        await harness(client, nextId, refreshUrl, {
          action: 'removeStorageFlag',
          key: '__sp_test_skip_tabs_query__',
        });
        await callTool(client, 'safari_close_tab', { tabUrl: refreshUrl }, nextId());
      } catch { /* best effort */ }
    }
    // Close tab A — note we may not be able to use tabA's original URL
    // to close it (URL drifted via replaceState). Fall back to the
    // post-pushState URL if recorded.
    const tabACloseTarget = tabANewUrl || tabA;
    if (tabACloseTarget) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: tabACloseTarget }, nextId());
      } catch { /* best effort */ }
    }
    if (tabB) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: tabB }, nextId());
      } catch { /* best effort */ }
    }
  }, 30000);

  it('replaceState in tab A updates the extension cache → subsequent tool call against the new URL hits tab A (cache-only path)', async () => {
    // 1) Open tab A — agent's intended target.
    const aMarker = `https://example.com/?sp_t21a=${Date.now()}`;
    const a = await callTool(client, 'safari_new_tab', { url: aMarker }, nextId());
    tabA = a.tabUrl as string;

    // 2) Open tab B — becomes active. If the cache-refresh fix isn't
    //    in place, we'd want to confirm the eval doesn't silently run
    //    here. Post-T27 it would fail TAB_NOT_FOUND; pre-T27 it would
    //    run in B.
    const bMarker = `https://example.org/?sp_t21b=${Date.now()}`;
    const b = await callTool(client, 'safari_new_tab', { url: bMarker }, nextId());
    tabB = b.tabUrl as string;

    // Settle so tabs.onCreated populates cache for both.
    await new Promise((r) => setTimeout(r, 1500));

    // 3) Plant a tab-A-only marker. Asserting on this in step 6
    //    eliminates the "right URL by coincidence" loophole: if the
    //    eval somehow lands in any tab other than A, the marker won't
    //    be there.
    const uniqueMarker = `T21_MARKER_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await rawCallTool(
      client,
      'safari_evaluate',
      {
        tabUrl: tabA!,
        script: `window.__sp_t21_marker = ${JSON.stringify(uniqueMarker)}; return "marker_set";`,
      },
      nextId(),
      8000,
    );

    // 4) Force the cache-only path in findTargetTab. With this flag
    //    set, `tabs.query({})` is skipped and only the cache decides.
    //    This is what makes pre-T21 cache-staleness observable.
    await harness(client, nextId, tabA!, {
      action: 'setStorageFlag',
      key: '__sp_test_skip_tabs_query__',
      value: true,
    });

    // 5) Trigger the SPA URL change via replaceState. The eval runs in
    //    tab A's MAIN world. Pre-fix: history.replaceState updates
    //    location but doesn't fire tabs.onUpdated reliably. Post-fix:
    //    the MAIN-world wrapper fires `SAFARI_PILOT_URL_CHANGE`,
    //    content-isolated relays, background updates tabCacheMap.
    const newPath = `/spa-route-T21-${Date.now()}`;
    const replaceRes = await rawCallTool(
      client,
      'safari_evaluate',
      {
        tabUrl: tabA!,
        script: `history.replaceState({}, "", "${newPath}"); return location.href;`,
      },
      nextId(),
      8000,
    );
    tabANewUrl = String(replaceRes.payload.value);
    expect(
      tabANewUrl,
      'replaceState eval must return the post-replace location.href',
    ).toContain(newPath);

    // 6) Allow time for the postMessage → runtime → background relay.
    //    The chain is fully in-process within the extension; ~500 ms is
    //    plenty headroom over typical sub-50 ms hop latency.
    await new Promise((r) => setTimeout(r, 500));

    // 7) Issue a tool call against the NEW URL. The daemon's
    //    TabOwnership was already refreshed via _meta.tabUrl during
    //    step 5 (server.ts:878), so layer-2 passes. The call reaches
    //    the extension's findTargetTab, which — under the skip flag
    //    set in step 4 — falls through tabs.query and consults the
    //    cache only.
    //
    //    The eval returns BOTH location.href AND the tab-A-only marker.
    //    Post-fix expects href=tabANewUrl AND marker=uniqueMarker (only
    //    tab A has the marker). Pre-fix the call surfaces a tool error
    //    (TAB_NOT_FOUND from T27's cache-miss fail-closed).
    let payload: Record<string, unknown> | null = null;
    let toolErrorText: string | null = null;
    let rpcErrorMsg: string | null = null;
    try {
      const result = await rawCallTool(
        client,
        'safari_evaluate',
        {
          tabUrl: tabANewUrl!,
          script: 'return { href: location.href, marker: window.__sp_t21_marker || null };',
        },
        nextId(),
        10000,
      );
      payload = result.payload;
      if (result.result.isError === true) {
        const content = result.result.content as Array<{ text?: string }> | undefined;
        toolErrorText = content?.[0]?.text ?? '<empty>';
      }
    } catch (e) {
      rpcErrorMsg = (e as Error).message;
    }

    // ─── Discriminating assertions (load-bearing) ──────────────────────
    // Pre-fix expected failure mode: TAB_NOT_FOUND from T27's fail-
    // closed. If we got that, the test correctly demonstrates the bug
    // surface. Any OTHER error mode means the test is failing for an
    // unrelated reason and the discrimination is invalid.
    if (rpcErrorMsg !== null || toolErrorText !== null) {
      const errEvidence = rpcErrorMsg ?? toolErrorText ?? '<unknown>';
      expect(
        errEvidence,
        `Pre-fix path detected. The expected failure mode is TAB_NOT_FOUND ` +
        `(from T27's fail-closed on cache miss). Any other error means the ` +
        `discrimination is invalid — investigate. Captured: ${errEvidence}`,
      ).toMatch(/TAB_NOT_FOUND/);
      // Then explicitly fail with the cache-staleness diagnostic so the
      // RED phase test failure is clearly attributable to T21.
      expect(
        errEvidence,
        `Pre-fix bug indicator: T21's fix is missing — replaceState in tab A ` +
        `did NOT refresh the extension's tabCacheMap, so the post-pushState ` +
        `URL is unknown to findTargetTab and T27 fails closed. Apply the ` +
        `MAIN-world history-API wrapper + relay to fix.`,
      ).toBeNull();
    }

    // Post-fix path: the eval landed in tab A and returned both the
    // post-replaceState URL and the tab-A-only marker. The marker
    // assertion eliminates "right URL by coincidence" — only tab A
    // has it.
    expect(payload, 'post-fix payload should be present').toBeTruthy();
    expect(
      (payload as { value?: { href?: string; marker?: string } } | null)?.value,
      `Post-fix expectation: eval ran in tab A (marker present) and ` +
      `returned tabANewUrl=${tabANewUrl}. A different value (or missing ` +
      `marker) means the cache wasn't refreshed by the replaceState ` +
      `wrapper, OR the eval landed in a different tab.`,
    ).toEqual({ href: tabANewUrl, marker: uniqueMarker });
  }, 60000);
});
