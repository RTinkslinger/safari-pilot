/**
 * v0.1.34 — CSP regression baseline on a localhost TT-strict fixture.
 *
 * Documents the v0.1.33 failure mode in a self-contained test:
 * safari_evaluate against a page that sets
 * `Content-Security-Policy: require-trusted-types-for 'script'` throws a
 * Trusted Types error from the `new _Function(params.script)` call site
 * at extension/content-main.js:714.
 *
 * This test was originally written as the Slice-1 architectural-pivot gate
 * for the "duplicate dispatcher into ISOLATED world" approach. Empirical
 * investigation (2026-05-13, see TRACES iter 80) showed that the safari_pilot
 * dispatch path doesn't route through content-isolated.js for our sentinels —
 * the command reaches content-main.js (MAIN world) directly, where TT
 * enforcement blocks `new Function`. The architectural-pivot path was
 * abandoned in favor of the multi-tool sentinel refactor in spec Section 8.
 *
 * This test now serves as the v0.1.33 regression baseline: post-v0.1.34
 * refactor, safari_evaluate should STILL fail here (it's a non-goal to fix
 * it on TT-strict pages — the agent uses the new sentinel-based tools
 * instead), but the new tools (safari_click, safari_get_page_info, etc.)
 * should succeed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTrustedTypesFixture } from '../fixtures/csp-trusted-types.js';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('CSP regression baseline — TT-strict fixture', () => {
  let fx: ReturnType<typeof startTrustedTypesFixture>;
  let client: McpTestClient;
  let nextId: () => number;
  let tabUrl: string;

  beforeAll(async () => {
    fx = startTrustedTypesFixture();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const target = `${fx.url()}?sp_t_csp_baseline=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    tabUrl = r['tabUrl'] as string;
    // Settle so content scripts inject.
    await new Promise((r) => setTimeout(r, 1500));
  }, 60_000);

  afterAll(async () => {
    if (tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    fx?.server.close();
  }, 30_000);

  it('safari_evaluate fails with Trusted Types error on require-trusted-types-for pages', async () => {
    // This is the failure mode v0.1.34's multi-tool refactor works AROUND
    // (not fixes — safari_evaluate itself stays broken on TT-strict pages).
    // The fix is that other tools (safari_click, safari_fill, safari_get_page_info,
    // safari_extract_text_window, etc.) route through dedicated sentinels in
    // content-main.js's switch and never call `new _Function`, so they succeed.
    let thrown: unknown;
    try {
      await callTool(client, 'safari_evaluate', { tabUrl, script: 'return 1+1' }, nextId());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(String(thrown)).toMatch(/Trusted Type|trusted-types-eval|unsafe-eval/i);
  });
});
