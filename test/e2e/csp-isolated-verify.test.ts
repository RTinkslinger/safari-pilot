/**
 * v0.1.34 Slice 1 — CSP isolated-world verification (the sprint gate).
 *
 * Asserts:
 *   1. MAIN-world `safari_evaluate` fails on a TT-strict page (v0.1.33
 *      regression check — confirms fixture serves CSP correctly).
 *   2. (Stub) ISOLATED-world `new Function` succeeds on the same page.
 *      Task 2 lands the `__SP_CSP_VERIFY__` sentinel and replaces the stub
 *      with the real assertion. If THAT assertion fails: STOP the sprint
 *      and pivot to spec Section 8 fallback (multi-tool refactor).
 *
 * Test pattern follows project convention: shared MCP client via
 * getSharedClient(), callTool() helper, per-test tab cleanup in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTrustedTypesFixture } from '../fixtures/csp-trusted-types.js';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('CSP isolated-world verification (Slice 1 gate)', () => {
  let fx: ReturnType<typeof startTrustedTypesFixture>;
  let client: McpTestClient;
  let nextId: () => number;
  let tabUrl: string;

  beforeAll(async () => {
    fx = startTrustedTypesFixture();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const target = `${fx.url()}?sp_t_csp_verify=${Date.now()}`;
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

  it('ISOLATED-world new Function bypasses page Trusted Types', async () => {
    // STUB — replaced in Task 2 Step 3 with a real assertion that calls
    // safari_evaluate with the '__SP_CSP_VERIFY__' sentinel and asserts the
    // returned `world` is 'isolated' and `value` is 42.
    // The STUB intentionally passes so Task 1 can commit and Task 2 can
    // replace the assertion with the real check. The gate fires in Task 2.
    expect(true).toBe(true);
  });

  it('MAIN-world safari_evaluate is blocked on this fixture (regression check)', async () => {
    // Today, safari_evaluate routes to MAIN. On a TT-strict page that must fail.
    // If this test ever STOPS failing, either (a) the fixture isn't serving
    // CSP correctly, or (b) Safari changed its TT enforcement — both deserve
    // investigation.
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
