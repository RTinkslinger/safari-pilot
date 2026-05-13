/**
 * v0.1.34 Task 2 — Layer 3 (Trusted Types policy registration) e2e.
 *
 * Verifies content-main.js's top-of-file IIFE that runs at content-script
 * load time and registers a TT policy named 'safari-pilot'. Two cases:
 *
 *   (a) TT-strict page with NO policy allowlist
 *       → trustedTypes.createPolicy('safari-pilot', {...}) succeeds
 *       → window.__SP_TT_POLICY__ exists; __SP_TT_HARD_BLOCK is not set
 *
 *   (b) TT-strict page WITH an allowlist that excludes 'safari-pilot'
 *       → createPolicy throws TypeError
 *       → window.__SP_TT_HARD_BLOCK = true; policy is not registered
 *
 * Probe channel: `safari_evaluate` with script = `__SP_TT_PROBE__:{}`.
 * The trailing `{}` JSON is required only to satisfy the prefix-then-colon
 * convention shared with __SP_SCROLL_TO_ELEMENT__ / __SP_DISMISS_OVERLAYS__.
 * The IIFE wrapping in src/tools/extraction.ts.handleEvaluate is bypassed
 * for this prefix so the raw sentinel reaches content-main.js intact.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startTrustedTypesFixture } from '../fixtures/csp-trusted-types.js';
import { startTrustedTypesAllowlistFixture } from '../fixtures/csp-trusted-types-allowlist.js';

describe('Layer 3: Trusted Types policy registration', () => {
  let ttFx: ReturnType<typeof startTrustedTypesFixture>;
  let allowlistFx: ReturnType<typeof startTrustedTypesAllowlistFixture>;
  let client: McpTestClient;
  let nextId: () => number;
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    ttFx = startTrustedTypesFixture();
    allowlistFx = startTrustedTypesAllowlistFixture();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 60_000);

  afterAll(async () => {
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId()); } catch { /* best-effort */ }
    }
    ttFx?.server.close();
    allowlistFx?.server.close();
  }, 30_000);

  it('registers __SP_TT_POLICY__ on tt-strict pages without an allowlist', async () => {
    const target = `${ttFx.url()}?sp_t2_a=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = r['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    // Settle so content scripts inject and the IIFE runs.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = await callTool(
      client,
      'safari_evaluate',
      { tabUrl, script: '__SP_TT_PROBE__:{}' },
      nextId(),
    );
    // handleEvaluate returns JSON.parse(result.value). For the bypass path the
    // engine returns the raw sentinel result; assert against the actual shape.
    // Expected: { hardBlock: false, policyRegistered: true }.
    const probe = (result as Record<string, unknown>);
    expect(probe['policyRegistered']).toBe(true);
    expect(probe['hardBlock']).toBe(false);
  }, 60_000);

  it('sets __SP_TT_HARD_BLOCK on tt-strict pages with an allowlist excluding safari-pilot', async () => {
    const target = `${allowlistFx.url()}?sp_t2_b=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = r['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const result = await callTool(
      client,
      'safari_evaluate',
      { tabUrl, script: '__SP_TT_PROBE__:{}' },
      nextId(),
    );
    const probe = (result as Record<string, unknown>);
    expect(probe['hardBlock']).toBe(true);
    expect(probe['policyRegistered']).toBe(false);
  }, 60_000);
});
