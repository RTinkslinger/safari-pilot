/**
 * T27 — `extension/background.js findTargetTab` must fail closed when the
 * caller passes a `tabUrl` and neither `browser.tabs.query({})` nor the
 * persistent `tabCacheMap` can resolve it. Pre-fix the function falls
 * through to `browser.tabs.query({active: true, currentWindow: true})[0]`
 * — silently delivering the agent's command to whichever Safari tab
 * happens to be frontmost. That violates the tab-isolation invariant
 * (`feedback-never-switch-user-tabs` memory) and breaks the contract that
 * the daemon-side `TabOwnership.findByUrl` enforces in layer 2.
 *
 * The bug only fires in the configuration where:
 *   1. the caller-supplied `tabUrl` exists in the daemon's `TabOwnership`
 *      registry (so layer-2 passes), AND
 *   2. `browser.tabs.query({})` returns either `[]` or no URL match (the
 *      Safari alarm-wake quirk — see `Architecture` section in CLAUDE.md
 *      and `reference-safari-extension-learnings`), AND
 *   3. `tabCacheMap` is empty or stale on that URL.
 *
 * In awake context the bug is invisible: `tabs.query({})` reports each
 * tab's REAL URL, so even a stale cache doesn't matter. We force the bug
 * deterministically using the DEBUG_HARNESS test bridge:
 *   - `__sp_test_skip_tabs_query__` storage flag → simulates the alarm-wake
 *     state where `tabs.query({})` returns `[]`.
 *   - `clearTabCache` op → wipes both `tabCacheMap` (in-memory in
 *     background.js) and the persisted `safari_pilot_tab_cache` key.
 *
 * Discrimination:
 *   - PRE-FIX:  fall-through to active-tab → command runs in the OTHER tab
 *     we opened (tab B), the script `return location.href` returns B's URL.
 *   - POST-FIX: `findTargetTab` returns `null`, caller emits
 *     `{ok:false, error:{name:'TAB_NOT_FOUND'}}`, MCP surfaces an error.
 *
 * Litmus: if `return null` is reverted to the active-tab fallback, the
 * assertion below flips from "error contains TAB_NOT_FOUND" to "value is
 * tab B's URL" — exactly the silent-cross-tab failure mode T27 prevents.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rawCallTool, callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

// Test-bridge wrapper: the bridge intercepts any `safari_evaluate` whose
// script starts with `__SP_TEST_HARNESS__:` and runs the encoded action in
// background.js (DEBUG_HARNESS-gated; stripped from release builds).
async function harness(
  client: McpTestClient,
  nextId: () => number,
  tabUrl: string,
  op: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const r = await rawCallTool(
    client,
    'safari_evaluate',
    { tabUrl, script: `__SP_TEST_HARNESS__:${JSON.stringify(op)}` },
    nextId(),
    10000,
  );
  return r.payload;
}

describe('T27 — findTargetTab fails closed on tabUrl + cache miss', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let tabA: string | null = null;
  let tabB: string | null = null;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 30000);

  afterAll(async () => {
    // Reset the test flag so subsequent tests aren't poisoned.
    // We can't go through findTargetTab (it's broken-by-test-flag), so use
    // either tab. Whichever tab exists is fine — once the flag is removed,
    // findTargetTab works normally again on the next call.
    const cleanupTarget = tabA || tabB;
    if (cleanupTarget) {
      try {
        // The flag is set, cache may be empty — but the bridge runs in
        // content-isolated, which doesn't depend on findTargetTab being
        // correct. The DAEMON-side path to deliver the command DOES depend
        // on it, however: post-fix, the cleanup eval to remove the flag
        // would itself fail with TAB_NOT_FOUND. Workaround: open a fresh
        // tab first to repopulate cache via tabs.onCreated, THEN remove
        // the flag.
        const refresh = await callTool(
          client,
          'safari_new_tab',
          { url: `https://example.com/?sp_t27_refresh=${Date.now()}` },
          nextId(),
        );
        const refreshUrl = refresh.tabUrl as string;
        await new Promise((r) => setTimeout(r, 500));
        await harness(client, nextId, refreshUrl, {
          action: 'removeStorageFlag',
          key: '__sp_test_skip_tabs_query__',
        });
        await callTool(client, 'safari_close_tab', { tabUrl: refreshUrl }, nextId());
      } catch {
        /* best effort */
      }
    }
    if (tabA) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: tabA }, nextId());
      } catch { /* best effort */ }
    }
    if (tabB) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: tabB }, nextId());
      } catch { /* best effort */ }
    }
  }, 30000);

  it('safari_evaluate against an owned tabUrl whose cache is missed returns TAB_NOT_FOUND (does NOT silently run on the active tab)', async () => {
    // 1) Open tab A — the agent's intended target.
    const aMarker = `https://example.com/?sp_t27a=${Date.now()}`;
    const a = await callTool(client, 'safari_new_tab', { url: aMarker }, nextId());
    tabA = a.tabUrl as string;

    // 2) Open tab B — becomes the active tab. If the bug fires, the eval
    //    will silently run here instead of in tab A.
    const bMarker = `https://example.org/?sp_t27b=${Date.now()}`;
    const b = await callTool(client, 'safari_new_tab', { url: bMarker }, nextId());
    tabB = b.tabUrl as string;

    // Brief settle so tabs.onCreated/onUpdated populate cache for both.
    await new Promise((r) => setTimeout(r, 1500));

    // 3) Set the test flag → findTargetTab will skip its tabs.query branch
    //    on subsequent calls (simulating Safari's alarm-wake quirk).
    const setFlag = await harness(client, nextId, tabA!, {
      action: 'setStorageFlag',
      key: '__sp_test_skip_tabs_query__',
      value: true,
    });
    expect(setFlag, 'bridge setStorageFlag must succeed').toBeDefined();
    expect((setFlag.value as Record<string, unknown> | undefined)?.set).toBe('__sp_test_skip_tabs_query__');

    // 4) Clear the cache (in-memory tabCacheMap + persisted storage key).
    //    After this, findTargetTab(tabA_url) cannot resolve through either
    //    primary or fallback path.
    const clearCache = await harness(client, nextId, tabA!, { action: 'clearTabCache' });
    expect(clearCache, 'bridge clearTabCache must succeed').toBeDefined();
    expect((clearCache.value as Record<string, unknown> | undefined)?.cleared).toBe('tabCacheMap+storage');

    // 5) The bug-trigger: ask the extension engine to run a script in tab A.
    //    The daemon's TabOwnership still has tabA (we never closed it), so
    //    layer-2 passes and the command flows to the extension. There:
    //      - skipTabsQuery=true → tabs.query({}) branch skipped
    //      - tabCacheMap.size === 0 → cache miss
    //    Pre-fix: falls through to active-tab → command runs in tab B,
    //             the script `return location.href` returns B's URL.
    //    Post-fix: returns null → MCP surfaces TAB_NOT_FOUND error.
    const bug = await rawCallTool(
      client,
      'safari_evaluate',
      { tabUrl: tabA!, script: 'return location.href;' },
      nextId(),
      10000,
    );

    // ─── Discriminating assertions ─────────────────────────────────────
    // Assertion A (the load-bearing one): the call must NOT have silently
    // executed in tab B. If it did, location.href would equal tab B's URL
    // (something resembling https://example.org/?sp_t27b=...).
    const value = (bug.payload as { value?: unknown }).value;
    expect(
      typeof value === 'string' && value.includes('sp_t27b='),
      `Pre-fix bug indicator: command silently ran in tab B (got value=${JSON.stringify(value)}). T27's fix must prevent this.`,
    ).toBe(false);

    // Assertion B: the failure mode must be the documented one — a structured
    // error with name 'TAB_NOT_FOUND'. Anything else (e.g. an unrelated
    // error code or a successful return for tab A) means the fix wasn't
    // exercised by this test path and the discriminator is invalid.
    const errorPayload =
      (bug.payload as { error?: { name?: string; message?: string } }).error;
    const errorNameOk = errorPayload?.name === 'TAB_NOT_FOUND';
    const errorMessageOk = typeof errorPayload?.message === 'string'
      && errorPayload.message.length > 0;
    expect(
      errorNameOk && errorMessageOk,
      `Expected structured TAB_NOT_FOUND error, got payload=${JSON.stringify(bug.payload)}`,
    ).toBe(true);
  }, 60000);
});
