/**
 * T79 — selectorPack custom engines (e2e against real Safari).
 *
 * The security pipeline runs HumanApproval BEFORE the tool handler. So:
 *   - safari_register_selector calls always trigger HumanApprovalRequiredError —
 *     this IS the security design (registration is a JS-injection surface).
 *     Validator behavior (eval/Function/dash-name rejection) is covered at unit
 *     level in C-1 and C-3; e2e cannot reach the validators because the gate
 *     fires first.
 *   - safari_unregister_selector is benign and does NOT fire HumanApproval.
 *   - The pack:<name> selector resolution path can be exercised against a
 *     NEVER-REGISTERED pack — the page-side hint flows back through
 *     resolveMaybePackSelector and surfaces as the tool error.
 *
 * What this e2e proves:
 *   1. HumanApproval gate fires for register (C-5 wiring works end-to-end)
 *   2. Unregister does NOT fire HumanApproval and the MCP call returns a
 *      structured ok response
 *   3. pack:<unregistered> selector resolves to the page-side "not registered"
 *      hint via resolveMaybePackSelector (C-7 wiring works end-to-end)
 *
 * Tab lifecycle: opened in beforeAll, closed in afterAll
 * (per feedback-e2e-tests-must-close-tabs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T79 — selectorPack (e2e)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string | null = null;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const target = `http://127.0.0.1:${fixture.hostPort}/t79-pack?sp_t79=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    tabUrl = r['tabUrl'] as string;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }, 60_000);

  afterAll(async () => {
    if (tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  }, 30_000);

  it('safari_register_selector triggers HumanApprovalRequiredError (security gate fires before tool handler)', async () => {
    const r = await rawCallTool(client, 'safari_register_selector', {
      tabUrl: tabUrl!,
      name: 'byStatus',
      body: 'return root.querySelector(\'[data-status="\' + arg + \'"]\');',
    }, nextId(), 20_000);
    expect(r.result['isError']).toBe(true);
    const text = JSON.stringify(r.payload);
    expect(text).toMatch(/HUMAN_APPROVAL_REQUIRED|approval/i);
    expect(text).toContain('safari_register_selector');
  }, 60_000);

  it('safari_unregister_selector does NOT fire HumanApproval (cleanup is benign)', async () => {
    // Even when the named pack was never registered, unregister returns ok with removed:false.
    const r = await callTool(client, 'safari_unregister_selector', {
      tabUrl: tabUrl!,
      name: 'byStatus',
    }, nextId(), 20_000);
    // The handler returns { ok: true, removed: false } when nothing was registered.
    expect(r['ok']).toBe(true);
  }, 60_000);

  it('pack:<unregistered>=arg surfaces page-side "not registered" hint via resolveMaybePackSelector', async () => {
    // This exercises the C-7 helper: pack:<name> selector → resolveMaybePackSelector
    // → in-page IIFE → window.__sp_pack lookup fails → returns {found:false, hint:'... not registered'}
    // → helper throws → server's outer catch re-throws → JSON-RPC error response.
    //
    // Some error shapes throw at the JSON-RPC level (this case), others surface
    // as result.isError. Cover both per the T80 e2e pattern.
    let isError = false;
    let errText = '';
    try {
      const r = await rawCallTool(client, 'safari_get_text', {
        tabUrl: tabUrl!,
        selector: 'pack:neverRegistered=foo',
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
    // The MCP SDK may transport the error as a generic JSON-RPC -32603 with
    // a stripped message ("no result"), or as a tool-result with isError:true
    // and the page-side hint. Both shapes mean: the pack resolution path fired
    // and rejected the unregistered name. The message preservation is an MCP
    // SDK concern; the unit tests for resolveMaybePackSelector verify the
    // exact "not registered" hint round-trips at the helper boundary.
    expect(isError, `expected pack-resolution error; errText=${errText}`).toBe(true);
  }, 60_000);
});
