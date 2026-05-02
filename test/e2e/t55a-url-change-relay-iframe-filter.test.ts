/**
 * T55a Task 28 — URL-change relay iframe filter regression litmus.
 *
 * `extension/background.js:715` filters relayed `sp_url_changed` messages
 * by `sender.frameId !== 0`, dropping non-top-frame events. With
 * `all_frames: true` content script injection (T55a), every iframe also
 * fires `SAFARI_PILOT_URL_CHANGE` on pushState — without this filter, an
 * iframe's pushState would clobber the top-frame URL in tabCacheMap.
 *
 * The discriminating observation requires the alarm-context cache-only
 * lookup path (where tabs.query returns []) — same harness flag as t21
 * uses (`__sp_test_skip_tabs_query__`):
 *   1) Open host tab; cache populated by tabs.onCreated
 *   2) Top-frame pushState → cache updates to URL_HOST_NEW (T21 path)
 *   3) Set skip-tabs-query flag → cache becomes the only lookup
 *   4) Iframe pushState (cross-origin via eval_in_frame)
 *   5) Issue tool call against URL_HOST_NEW
 *
 * Post-fix (filter holds): tabCacheMap still contains URL_HOST_NEW; the
 * eval lands and returns the value. Pre-fix (filter dropped): the iframe
 * pushState clobbers URL_HOST_NEW in tabCacheMap with the iframe URL, so
 * the URL_HOST_NEW lookup misses → T27 fail-closed → TAB_NOT_FOUND.
 *
 * Litmus: comment out the `sender.frameId !== 0` check at background.js:715
 * — this test goes red with TAB_NOT_FOUND.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

async function harness(
  client: McpTestClient,
  nextId: () => number,
  tabUrl: string,
  op: Record<string, unknown>,
  timeoutMs = 10_000,
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

describe('T55a — url-change relay drops non-top-frame events', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  const openedTabs: string[] = [];
  let tabUrlAfterPush: string | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 60_000);

  afterAll(async () => {
    // Mirror t21's cleanup: clear the skip-tabs-query flag via a fresh tab
    // (cache may be in inconsistent state otherwise).
    try {
      const refresh = await callTool(
        client,
        'safari_new_tab',
        { url: `https://example.com/?sp_t28_refresh=${Date.now()}` },
        nextId(),
        15_000,
      );
      const refreshUrl = refresh['tabUrl'] as string;
      await new Promise((r) => setTimeout(r, 500));
      await harness(client, nextId, refreshUrl, {
        action: 'removeStorageFlag',
        key: '__sp_test_skip_tabs_query__',
      });
      try { await callTool(client, 'safari_close_tab', { tabUrl: refreshUrl }, nextId()); } catch { /* */ }
    } catch { /* best-effort */ }

    // Close the post-pushState URL (the original tab URL has drifted).
    if (tabUrlAfterPush) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: tabUrlAfterPush }, nextId()); } catch { /* */ }
    }
    for (const url of openedTabs) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId()); } catch { /* */ }
    }
    if (fixture) await fixture.close();
  }, 60_000);

  it('iframe pushState does NOT pollute tabCacheMap (top-frame URL still routable)', async () => {
    // 1) Open host tab.
    const tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t28=1`;
    openedTabs.push(tabUrl);
    await callTool(client, 'safari_new_tab', { url: tabUrl }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 2500));

    // 2) Plant a top-frame-only marker so we can prove the eval lands in
    //    the host top frame later. Marker is inaccessible from any iframe.
    const marker = `T28_MARKER_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await rawCallTool(client, 'safari_evaluate', {
      tabUrl,
      script: `window.__sp_t28_marker = ${JSON.stringify(marker)}; return "marker_set";`,
    }, nextId(), 10_000);

    // 3) Top-frame pushState → cache updates via the T21 relay (sender.frameId=0).
    const newPath = `/spa-route-T28-${Date.now()}`;
    const pushRes = await rawCallTool(client, 'safari_evaluate', {
      tabUrl,
      script: `history.pushState({}, "", "${newPath}"); return location.href;`,
    }, nextId(), 10_000);
    tabUrlAfterPush = String(pushRes.payload['value']);
    expect(tabUrlAfterPush, `pushState eval should return new href; got ${tabUrlAfterPush}`).toContain(newPath);

    // 4) Force the alarm-context cache-only lookup path.
    await harness(client, nextId, tabUrlAfterPush!, {
      action: 'setStorageFlag',
      key: '__sp_test_skip_tabs_query__',
      value: true,
    });

    // 5) Trigger an iframe pushState — this is the regression vector.
    //    The relay must drop it (sender.frameId !== 0).
    const list = await rawCallTool(client, 'safari_list_frames', { tabUrl: tabUrlAfterPush! }, nextId(), 15_000);
    const frames = list.payload['frames'] as Array<Record<string, unknown>>;
    const innerFrame = frames.find((f) => typeof f['url'] === 'string' && (f['url'] as string).endsWith('/inner.html'));
    if (innerFrame) {
      try {
        await rawCallTool(client, 'safari_eval_in_frame', {
          tabUrl: tabUrlAfterPush!,
          frameId: innerFrame['frameId'],
          script: "history.pushState({}, '', location.pathname + '?iframe_pushed=1'); return location.href;",
        }, nextId(), 15_000);
      } catch { /* iframe pushState may surface odd errors; the discriminating step is below */ }
    }

    // 6) Wait for any relay messages to drain.
    await new Promise((r) => setTimeout(r, 800));

    // 7) Issue a tool call against the post-host-pushState URL. Under
    //    the cache-only path, this works iff tabCacheMap still has
    //    URL_HOST_NEW. If the iframe pushState clobbered it (regression),
    //    findTargetTab misses and T27 fail-closes with TAB_NOT_FOUND.
    let payload: Record<string, unknown> | null = null;
    let toolErrorText: string | null = null;
    let rpcErrorMsg: string | null = null;
    try {
      const result = await rawCallTool(client, 'safari_evaluate', {
        tabUrl: tabUrlAfterPush!,
        script: 'return { href: location.href, marker: window.__sp_t28_marker || null };',
      }, nextId(), 10_000);
      payload = result.payload;
      if (result.result['isError'] === true) {
        const content = result.result['content'] as Array<{ text?: string }> | undefined;
        toolErrorText = content?.[0]?.text ?? '<empty>';
      }
    } catch (e) {
      rpcErrorMsg = (e as Error).message;
    }

    // Discriminating assertion: the eval landed in the host top frame
    // (marker present) and the cache routing succeeded.
    if (rpcErrorMsg !== null || toolErrorText !== null) {
      const ev = rpcErrorMsg ?? toolErrorText ?? '<unknown>';
      throw new Error(
        `Regression: post-pushState URL was unroutable under cache-only path. ` +
        `This is the iframe-pushState-clobbers-tabCacheMap signature — ` +
        `verify the sender.frameId !== 0 filter at background.js:715. ` +
        `Observed: ${ev}`,
      );
    }

    expect(payload, 'expected payload from cache-routed tool call').toBeTruthy();
    const value = (payload as { value?: { href?: string; marker?: string } } | null)?.value;
    expect(value, `value=${JSON.stringify(value)}`).toEqual({ href: tabUrlAfterPush, marker });
  }, 90_000);
});
