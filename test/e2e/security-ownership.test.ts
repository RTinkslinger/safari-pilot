/**
 * Security — Tab Ownership Enforcement
 *
 * Proves that navigation/interaction tools cannot be exploited to touch
 * user-owned Safari tabs. These tests target the shipped security
 * architecture (schema-declared contracts + server-side ownership checks +
 * handler-level validation), not internal APIs.
 *
 * T1 coverage: `safari_navigate` rejects missing / empty-string / non-string
 * tabUrl so that the ownership check at server.ts cannot be bypassed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initClient, rawCallTool, callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Server writes trace events in real-time to ~/.safari-pilot/trace.ndjson.
// McpTestClient only COPIES this file into its per-test trace dir on close(),
// so mid-test assertions must read from the live location.
const LIVE_SERVER_TRACE = join(homedir(), '.safari-pilot', 'trace.ndjson');

function readServerTraceEvents(): Array<Record<string, unknown>> {
  if (!existsSync(LIVE_SERVER_TRACE)) return [];
  return readFileSync(LIVE_SERVER_TRACE, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } });
}

describe('Security: Tab ownership enforcement', () => {
  let client: McpTestClient;
  let nextId: number;

  beforeAll(async () => {
    const result = await initClient('dist/index.js');
    client = result.client;
    nextId = result.nextId;
  }, 30000);

  afterAll(async () => {
    if (client) await client.close();
  });

  // ── T1: safari_navigate requires tabUrl ───────────────────────────────────

  it('T1: safari_navigate advertises tabUrl as required in its schema', async () => {
    const resp = (await client.send({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/list',
      params: {},
    })) as Record<string, unknown>;
    const result = resp['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<Record<string, unknown>>;
    const navTool = tools.find((t) => t['name'] === 'safari_navigate');
    expect(navTool, 'safari_navigate tool should be registered').toBeDefined();
    const schema = navTool!['inputSchema'] as Record<string, unknown>;
    const required = schema['required'] as string[];
    expect(required).toContain('url');
    expect(required).toContain('tabUrl');
  }, 10000);

  it('T1: safari_navigate rejects missing tabUrl (no front-tab fallback)', async () => {
    // No tabUrl → must be rejected before any AppleScript runs.
    await expect(
      rawCallTool(
        client,
        'safari_navigate',
        { url: 'https://example.com' },
        nextId++,
        10000,
      ),
    ).rejects.toThrow(/tabUrl/);
  }, 15000);

  it('T1: safari_navigate rejects empty-string tabUrl', async () => {
    // Empty string is falsy — previously slipped through the ownership gate.
    // Handler-level validation must treat it as missing.
    await expect(
      rawCallTool(
        client,
        'safari_navigate',
        { url: 'https://example.com', tabUrl: '' },
        nextId++,
        10000,
      ),
    ).rejects.toThrow(/tabUrl/);
  }, 15000);

  it('T1: safari_navigate rejects non-string tabUrl', async () => {
    // Schema says string; without runtime enforcement, agents could pass
    // any type. Handler must reject non-strings explicitly.
    await expect(
      rawCallTool(
        client,
        'safari_navigate',
        { url: 'https://example.com', tabUrl: null as unknown as string },
        nextId++,
        10000,
      ),
    ).rejects.toThrow(/tabUrl/);
  }, 15000);

  // ── T7: registry evicts tabs on safari_close_tab ─────────────────────────

  it('T7: closing an owned tab removes it from the ownership registry', async () => {
    // Open a tab — agent owns it at a unique URL (unique-per-run to avoid
    // collisions with tabs left behind by earlier test runs).
    const unique = `https://example.org/?sp_t7=${Date.now()}`;
    const tab = await callTool(
      client, 'safari_new_tab', { url: unique }, nextId++,
    );
    const closedUrl = tab.tabUrl as string;
    await new Promise((r) => setTimeout(r, 1500));

    // Close it — T7's fix fires `tabOwnership.removeTab()` in step 8.post1
    // and emits `ownership_tab_removed` into server-trace.ndjson precisely
    // when the registry entry is dropped.
    const closeRes = await callTool(
      client, 'safari_close_tab', { tabUrl: closedUrl }, nextId++,
    );
    expect(closeRes.closed).toBe(true);

    // Give the server tracer a beat to flush.
    await new Promise((r) => setTimeout(r, 500));

    // Direct evidence: trace file contains the eviction event with this URL.
    // Pre-T7: no event was ever emitted because removeTab() was never called.
    // The deferred-ownership path (T8) would silently absorb missing-registry
    // calls anyway, so "try stale tool and expect throw" wouldn't discriminate.
    // The trace-level check IS the discriminating assertion for T7.
    const events = readServerTraceEvents();
    const removeEvent = events.find((e) =>
      (e as { event?: string }).event === 'ownership_tab_removed' &&
      ((e as { data?: Record<string, unknown> }).data?.['tabUrl'] as string | undefined) === closedUrl,
    );
    expect(removeEvent, `server-trace.ndjson must contain ownership_tab_removed for ${closedUrl}`).toBeDefined();
  }, 30000);

  // ── T5: safari_switch_frame deleted — was a no-op tool ───────────────────

  it('T5: safari_switch_frame is NOT advertised in tools/list (removed as no-op)', async () => {
    // T5 audit: handler stored no frame context; description lied about
    // "records the frame selector so future tool calls are scoped".
    // Real frame scoping is via safari_eval_in_frame — the no-op was deleted.
    const resp = (await client.send({
      jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {},
    })) as Record<string, unknown>;
    const result = resp['result'] as Record<string, unknown>;
    const tools = result['tools'] as Array<Record<string, unknown>>;
    const names = tools.map((t) => t['name'] as string);
    expect(names).not.toContain('safari_switch_frame');
    // safari_eval_in_frame is the replacement and MUST remain advertised
    expect(names).toContain('safari_eval_in_frame');
    expect(names).toContain('safari_list_frames');
  }, 10000);

  it('T5: calling safari_switch_frame fails rather than silently returning {switched: true}', async () => {
    // Pre-fix behavior: handler returned {switched: true} without storing any
    // frame context — a lie to the agent. Post-fix: the tool isn't registered
    // at all, so any attempt fails at the security pipeline or handler dispatch.
    // (Here, the ownership check fires first and rejects the unowned tabUrl —
    // which is ALSO evidence that the no-op path is gone.)
    await expect(
      rawCallTool(
        client,
        'safari_switch_frame',
        { tabUrl: 'https://example.com', frameSelector: 'iframe' },
        nextId++,
        5000,
      ),
    ).rejects.toThrow(); // any error is acceptable — the silent {switched:true} is not
  }, 10000);

  // ── T2: registry URL refreshed after AppleScript navigation ──────────────

  it('T2: registry URL updates after safari_navigate — subsequent call with new URL succeeds', async () => {
    // Open a tab owned by the agent. Initial URL is the registry's tracked URL.
    const tab = await callTool(
      client, 'safari_new_tab', { url: 'https://example.com' }, nextId++,
    );
    const startUrl = tab.tabUrl as string;
    await new Promise(r => setTimeout(r, 2000));

    try {
      // Navigate the owned tab to a different URL. Pre-T2, the registry kept
      // startUrl, so the next call below would throw TabUrlNotRecognizedError.
      const nav = await callTool(
        client, 'safari_navigate',
        { url: 'https://httpbin.org/html', tabUrl: startUrl },
        nextId++,
        30000,
      );
      const newUrl = nav.url as string;
      expect(newUrl).toContain('httpbin.org');

      // Post-T2: ownership registry now has newUrl. A subsequent tool call
      // with the NEW url must pass the ownership check.
      const followUp = await callTool(
        client, 'safari_navigate',
        { url: 'https://example.org', tabUrl: newUrl },
        nextId++,
        30000,
      );
      expect(followUp.url).toContain('example.org');

      // Close via the latest URL to confirm the registry still tracks correctly.
      await callTool(
        client, 'safari_close_tab', { tabUrl: followUp.url as string }, nextId++,
      );
    } catch (err) {
      // Best-effort cleanup if the flow failed
      try { await callTool(client, 'safari_close_tab', { tabUrl: startUrl }, nextId++); } catch { /* ignore */ }
      throw err;
    }
  }, 90000);
});
