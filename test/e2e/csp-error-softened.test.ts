/**
 * v0.1.35 Task 6 — softened CSP_BLOCKED / CSP_HARD_BLOCK error UX.
 *
 * After Task 6 the `hint` payload that handleEvaluate emits on a CSP-blocked
 * safari_evaluate call is informational, not prescriptive. Specifically:
 *   - `alternative_tools` (the array of named tools) is REMOVED.
 *   - `fallback_available: true` and a CSP-mention `note` are added.
 *   - `cspMode` (hard-block / eval-blocked / tt-strict) is preserved.
 *
 * The hint reaches the caller serialized into the thrown Error.message
 * (extraction.ts: `code + ': ' + rawMsg + ' | hint: ' + JSON.stringify(hint)`),
 * so the test follows the `csp-evaluate-blocked-error.test.ts` throw-and-
 * string-match pattern instead of inspecting `result.metadata`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startTrustedTypesFixture } from '../fixtures/csp-trusted-types.js';

describe('CSP_BLOCKED softened error UX', () => {
  let ttFx: ReturnType<typeof startTrustedTypesFixture>;
  let client: McpTestClient;
  let nextId: () => number;
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    ttFx = startTrustedTypesFixture();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 60_000);

  afterAll(async () => {
    for (const url of openedTabUrls) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId()); } catch { /* best-effort */ }
    }
    ttFx?.server.close();
  }, 30_000);

  it('returns CSP_BLOCKED with informational hint (no alternative_tools list)', async () => {
    const target = `${ttFx.url()}?sp_t6_softened=${Date.now()}`;
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

    // Still surfaces a CSP error code (CSP_BLOCKED for tt-strict; CSP_HARD_BLOCK
    // for the allowlist-excludes-safari-pilot variant — both acceptable).
    expect(msg).toMatch(/CSP_BLOCKED|CSP_HARD_BLOCK/);

    // Softened: the prescriptive alternative_tools list is gone, and no named
    // tool appears in the message.
    expect(msg).not.toMatch(/alternative_tools/);
    expect(msg).not.toMatch(/safari_get_page_info/);
    expect(msg).not.toMatch(/safari_click/);

    // The new hint shape is informational. Parse the JSON tail emitted as
    // `hint: {...}` and verify the new fields exist.
    const hintMatch = msg.match(/hint:\s*(\{.*\})\s*$/);
    expect(hintMatch).not.toBeNull();
    const hint = JSON.parse(hintMatch![1]) as Record<string, unknown>;
    expect(hint['fallback_available']).toBe(true);
    expect(String(hint['note'] ?? '')).toMatch(/CSP/);
    expect(hint['cspMode']).toBeDefined(); // preserved
    expect(hint['alternative_tools']).toBeUndefined();
  }, 60_000);
});
