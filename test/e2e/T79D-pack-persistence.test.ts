/**
 * T79 Cluster D — pack persistence (e2e against real Safari, v0.1.27+).
 *
 * Cluster C shipped pack registration into window.__sp_pack only — page-scope,
 * lost on navigation. Cluster D delivers the spec'd persistence: extension
 * writes sp_pack_<tabId>_<name> to browser.storage.local and re-injects on
 * every tabs.onUpdated:complete.
 *
 * What this e2e proves end-to-end against real Safari:
 *   1. The __SP_PACK_REGISTER__ sentinel registers a pack and the page-side
 *      injection (window.__sp_pack[name] = new Function(...)) lands.
 *   2. pack:<name>=<arg> selector resolves through the registered pack on the
 *      same page (proves resolveMaybePackSelector + the actual pack body
 *      execute against real DOM).
 *   3. After safari_navigate to a fresh URL in the same tab, the pack is
 *      auto-rehydrated by the tabs.onUpdated listener and pack:<name>=<arg>
 *      STILL resolves on the new page. **This is the persistence guarantee.**
 *   4. The __SP_PACK_UNREGISTER__ sentinel removes both the storage key and
 *      the page-side __sp_pack[name], and subsequent pack:<name> calls fail.
 *
 * Bypass: the MCP-level safari_register_selector tool is gated by
 * HumanApproval (C-5 — verified by T79-selector-pack.test.ts). For e2e of
 * the storage/rehydrate path we send the sentinel via safari_evaluate, which
 * isn't sensitive-action-listed. The validators (C-1, C-3) are unit-tested
 * — bypassing them at e2e is intentional for this layer.
 *
 * Tab lifecycle: opened in beforeAll, closed in afterAll
 * (per feedback-e2e-tests-must-close-tabs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T79 Cluster D — pack persistence (e2e)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string | null = null;
  const packName = 'd6Pack';
  // Body: returns the FIRST element matching [data-status="<arg>"]. The fixture
  // serves three rows with data-status; the test asserts on visible text.
  const packBody = "return root.querySelector('[data-status=\"' + arg + '\"]');";

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const initialUrl = `http://127.0.0.1:${fixture.hostPort}/t79-pack?sp_t79d=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: initialUrl }, nextId(), 15_000);
    tabUrl = r['tabUrl'] as string;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }, 60_000);

  afterAll(async () => {
    if (tabUrl) {
      // Best-effort unregister via sentinel.
      try {
        await callTool(client, 'safari_evaluate', {
          tabUrl,
          script: '__SP_PACK_UNREGISTER__:' + JSON.stringify({ name: packName }),
        }, nextId(), 10_000);
      } catch { /* best-effort */ }
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  }, 30_000);

  // ── 1. Register via sentinel works ─────────────────────────────────────

  it('register sentinel via safari_evaluate writes storage AND injects window.__sp_pack', async () => {
    const sentinel = '__SP_PACK_REGISTER__:' + JSON.stringify({ name: packName, body: packBody });
    const r = await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: sentinel,
    }, nextId(), 20_000);
    // The sentinel handler in background.js (D-2) writes storage then falls
    // through to the regular execute path which runs the page-side injection.
    // The page-side script returns the parsed JSON via top-level return; the
    // bypass path in handleEvaluate keeps it intact, so `r['ok']` is at the
    // top level alongside the harness-added `__engine` / `__latencyMs` keys.
    expect(r['ok'], `expected page-side ok payload, got: ${JSON.stringify(r)}`).toBe(true);
    expect(r['name']).toBe(packName);

    // Verify the page actually has window.__sp_pack[packName] now. The probe
    // is a non-sentinel script — handleEvaluate wraps it in an async IIFE,
    // so the script body needs an explicit `return`.
    const probe = await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: 'return JSON.stringify({ has: !!(window.__sp_pack && window.__sp_pack[' + JSON.stringify(packName) + ']) })',
    }, nextId(), 10_000);
    const probeValue = (probe['value'] ?? probe['result']) as unknown;
    const probeParsed = typeof probeValue === 'string' ? JSON.parse(probeValue) : probeValue;
    expect(probeParsed, `probe response: ${JSON.stringify(probe)}`).toMatchObject({ has: true });
  }, 60_000);

  // ── 2. pack:<name>=<arg> resolves on the current page ────────────────

  it('pack:<name>=<arg> resolves through the registered pack on initial page', async () => {
    const r = await callTool(client, 'safari_get_text', {
      tabUrl: tabUrl!,
      selector: 'pack:' + packName + '=approved',
    }, nextId(), 20_000);
    expect((r['text'] as string)).toContain('Row A');
  }, 60_000);

  // ── 3. THE persistence guarantee: after navigation, pack still works ──

  it('after safari_navigate within the same tab, pack auto-rehydrates and pack:<name>=<arg> still resolves', async () => {
    // Navigate to a different URL in the same tab. The fixture is the same
    // shape (3 data-status rows) but the URL changes — Safari fires a real
    // navigation, the page reloads, window.__sp_pack is cleared.
    // tabs.onUpdated:complete fires → D-3 listener reads sp_pack_<tabId>_*
    // and re-injects each pack into the new window.__sp_pack.
    const navUrl = `http://127.0.0.1:${fixture.hostPort}/t79-pack?after_nav=${Date.now()}`;
    const navResult = await callTool(client, 'safari_navigate', {
      tabUrl: tabUrl!,
      url: navUrl,
    }, nextId(), 30_000);
    // safari_navigate updates the tab URL — reflect that in subsequent calls.
    const newTabUrl = (navResult['url'] as string) ?? navUrl;
    tabUrl = newTabUrl;

    // Settle for tabs.onUpdated:complete + content scripts reloading + the
    // rehydrate sentinel storage-bus round trip.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    // Probe: window.__sp_pack should contain the pack again.
    const probe = await callTool(client, 'safari_evaluate', {
      tabUrl: newTabUrl,
      script: 'return JSON.stringify({ has: !!(window.__sp_pack && window.__sp_pack[' + JSON.stringify(packName) + ']) })',
    }, nextId(), 10_000);
    const probeValue = (probe['value'] ?? probe['result']) as unknown;
    const probeParsed = typeof probeValue === 'string' ? JSON.parse(probeValue) : probeValue;
    expect(probeParsed, `pack should be rehydrated after navigation; probe: ${JSON.stringify(probe)}`).toMatchObject({ has: true });

    // And the resolver path still works end-to-end.
    const r = await callTool(client, 'safari_get_text', {
      tabUrl: newTabUrl,
      selector: 'pack:' + packName + '=approved',
    }, nextId(), 20_000);
    expect((r['text'] as string)).toContain('Row A');
  }, 90_000);

  // ── 4. Unregister via sentinel removes both storage AND page entry ────

  it('unregister sentinel removes storage key and page-side __sp_pack entry', async () => {
    const sentinel = '__SP_PACK_UNREGISTER__:' + JSON.stringify({ name: packName });
    await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: sentinel,
    }, nextId(), 10_000);

    // Page-side: window.__sp_pack[name] should be gone.
    const probe = await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: 'return JSON.stringify({ has: !!(window.__sp_pack && window.__sp_pack[' + JSON.stringify(packName) + ']) })',
    }, nextId(), 10_000);
    const probeValue = (probe['value'] ?? probe['result']) as unknown;
    const probeParsed = typeof probeValue === 'string' ? JSON.parse(probeValue) : probeValue;
    expect(probeParsed, `unregister probe: ${JSON.stringify(probe)}`).toMatchObject({ has: false });

    // Resolver: pack:<name>=<arg> should now fail with the page-side hint.
    let isError = false;
    let errText = '';
    try {
      const r = await rawCallTool(client, 'safari_get_text', {
        tabUrl: tabUrl!,
        selector: 'pack:' + packName + '=approved',
      }, nextId(), 20_000);
      isError = r.result['isError'] === true;
      if (isError) {
        const content = r.result['content'] as Array<{ text?: string }> | undefined;
        errText = content?.[0]?.text ?? '';
      }
    } catch (e) {
      isError = true;
      errText = e instanceof Error ? e.message : String(e);
    }
    expect(isError, `expected pack-resolution error post-unregister; errText=${errText}`).toBe(true);
  }, 60_000);
});
