/**
 * v0.1.34 Task 3 — CSP_BLOCKED / CSP_HARD_BLOCK error UX for safari_evaluate.
 *
 * Verifies the failure-path wrapper in src/tools/extraction.ts.handleEvaluate
 * translates Safari's raw Trusted-Types / CSP-eval errors into structured
 * `CSP_BLOCKED` (recoverable) or `CSP_HARD_BLOCK` (hard-block) errors with
 * an informational hint (`fallback_available`, `note`, `cspMode`).
 *
 * v0.1.35 Task 6 update — the prescriptive `alternative_tools` array was
 * removed (one of the four nudges that halved safari_evaluate usage). The
 * assertion now verifies the softened hint shape: error code preserved,
 * cspMode preserved, no named tool list. The cross-shape verifier lives in
 * test/e2e/csp-error-softened.test.ts.
 *
 * Three modes:
 *   (a) tt-strict + Layer 3 policy registered → CSP_BLOCKED (probe.hardBlock = false)
 *   (b) tt-strict + allowlist excludes 'safari-pilot' → CSP_HARD_BLOCK (probe.hardBlock = true)
 *   (c) script-src 'self' (no Trusted Types, no unsafe-eval) → CSP_BLOCKED
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startTrustedTypesFixture } from '../fixtures/csp-trusted-types.js';
import { startTrustedTypesAllowlistFixture } from '../fixtures/csp-trusted-types-allowlist.js';
import { startScriptSrcNoEvalFixture } from '../fixtures/csp-script-src-no-eval.js';

describe('safari_evaluate CSP_BLOCKED error UX', () => {
  let ttFx: ReturnType<typeof startTrustedTypesFixture>;
  let allowlistFx: ReturnType<typeof startTrustedTypesAllowlistFixture>;
  let noEvalFx: ReturnType<typeof startScriptSrcNoEvalFixture>;
  let client: McpTestClient;
  let nextId: () => number;
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    ttFx = startTrustedTypesFixture();
    allowlistFx = startTrustedTypesAllowlistFixture();
    noEvalFx = startScriptSrcNoEvalFixture();
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
    noEvalFx?.server.close();
  }, 30_000);

  it('returns CSP_BLOCKED on tt-strict pages with policy registration intact', async () => {
    const target = `${ttFx.url()}?sp_t3_a=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = r['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    // Settle so content scripts inject and Layer 3 IIFE runs.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    let thrown: unknown;
    try {
      await callTool(client, 'safari_evaluate', { tabUrl, script: 'return 1+1' }, nextId(), 20_000);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const msg = String((thrown as { message?: string })?.message ?? thrown);
    expect(msg).toMatch(/CSP_BLOCKED/);
    // Hard-block must NOT appear for the soft-block case.
    expect(msg).not.toMatch(/CSP_HARD_BLOCK/);
    // v0.1.35 Task 6 — hint is informational; the named alternative_tools list
    // was removed. The cspMode field is preserved (callers can route on it).
    expect(msg).not.toMatch(/alternative_tools/);
    expect(msg).toMatch(/cspMode/);
    expect(msg).toMatch(/fallback_available/);
  }, 60_000);

  it('returns CSP_HARD_BLOCK on tt-strict pages with allowlist excluding safari-pilot', async () => {
    const target = `${allowlistFx.url()}?sp_t3_b=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = r['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    let thrown: unknown;
    try {
      await callTool(client, 'safari_evaluate', { tabUrl, script: 'return 1' }, nextId(), 20_000);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const msg = String((thrown as { message?: string })?.message ?? thrown);
    expect(msg).toMatch(/CSP_HARD_BLOCK/);
  }, 60_000);

  it('returns CSP_BLOCKED on script-src no-eval pages', async () => {
    const target = `${noEvalFx.url()}?sp_t3_c=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    const tabUrl = r['tabUrl'] as string;
    openedTabUrls.push(tabUrl);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    let thrown: unknown;
    try {
      await callTool(client, 'safari_evaluate', { tabUrl, script: 'return 1' }, nextId(), 20_000);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const msg = String((thrown as { message?: string })?.message ?? thrown);
    expect(msg).toMatch(/CSP_BLOCKED/);
    expect(msg).not.toMatch(/CSP_HARD_BLOCK/);
  }, 60_000);
});
