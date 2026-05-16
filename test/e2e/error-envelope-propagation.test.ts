/**
 * F3.1 — engine error envelope propagation through the real MCP stack.
 *
 * Pre-F3.1 every `if (!result.ok) throw new Error(result.error?.message ??
 * '<fallback>');` at ~70 tool-handler sites collapsed the structured
 * EngineResult.error envelope (`code/retryable/hints`) to plain text before
 * reaching the MCP response. The agent saw opaque strings like
 *   "Daemon command 'execute' timed out after 90000ms"
 * instead of recoverable structure:
 *   { error: "DAEMON_TIMEOUT", retryable: false, hints: [...] }
 *
 * This test fires a real DAEMON_TIMEOUT through the full MCP stack (real
 * spawned server, real daemon, real Safari, real extension) and asserts the
 * structured payload arrives at the MCP client as `isError: true` content[0].text
 * JSON. If F3.1's catch-block conversion in src/server.ts:1240+ regresses or a
 * tool handler is added that throws bare Error instead of wrapEngineError, the
 * payload.error assertion fails.
 *
 * Per CLAUDE.md HARD RULES: real spawn, real MCP protocol, real daemon, zero
 * stubs (no mocks anywhere — the pre-commit hook enforces that contract).
 *
 * Requires:
 *   - Dev.10 (or later) binary installed in Safari with F3.1's bare-Error ->
 *     wrapEngineError rewrites and the catch-block isError conversion.
 *   - Daemon on TCP:19474 / HTTP:19475 (provisioned by global setup).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rawCallTool, callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('F3.1 — engine error envelope propagation', () => {
  let client: McpTestClient;
  let nextId: () => number;
  const openedTabs: string[] = [];

  beforeAll(async () => {
    const shared = await getSharedClient();
    client = shared.client;
    nextId = shared.nextId;
  }, 30000);

  afterAll(async () => {
    for (const url of openedTabs) {
      try { await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId()); } catch { /* swept */ }
    }
  });

  it('DAEMON_TIMEOUT surfaces as MCP isError with structured code/retryable/hints', async () => {
    // Open a tab so the call has a real target. The 20s setTimeout in the
    // injected script forces the daemon's 90s default to NOT be hit — but
    // ANY tool call that injects synchronous-looking code that never
    // completes within the timeout produces DAEMON_TIMEOUT. We use a
    // short-circuit: SP_EXTENSION_DEFAULT_TIMEOUT_MS env override is
    // process-global, set by McpTestClient on its own server spawn so the
    // shared client doesn't have it. Instead, lean on the script doing
    // explicit work that exceeds the agent's specified timeout.
    const url = `data:text/html,<html><body><h1>F31_ENVELOPE</h1></body></html>`;
    const tabResult = await callTool(client, 'safari_new_tab', { url }, nextId(), 30000);
    const tabUrl = tabResult.tabUrl as string;
    openedTabs.push(tabUrl);
    expect(tabUrl).toBeDefined();

    // Force the envelope path by passing an explicit short timeout to
    // safari_evaluate with a script that exceeds it. The daemon timeout
    // landed at 90s default in dev.9 — we override via the tool's per-call
    // timeout param so the test doesn't take 90 seconds.
    const r = await rawCallTool(
      client,
      'safari_evaluate',
      {
        tabUrl,
        script: 'await new Promise(r => setTimeout(r, 8000));',
        timeout: 2000,  // forces DAEMON_TIMEOUT in ~2s
      },
      nextId(),
      20000,
    );

    // PRIMARY ORACLE — isError true, payload carries structured fields.
    expect(
      r.result['isError'],
      'F3.1: a tool-handler throw of EngineExecutionError must surface as ' +
      'MCP isError:true. If false/undefined, src/server.ts catch-block ' +
      'conversion regressed.',
    ).toBe(true);

    // SECONDARY ORACLE — content[0].text parsed as JSON contains code +
    // retryable + hints (the full envelope).
    expect(r.payload.error).toBeDefined();
    expect(
      r.payload.error,
      'F3.1: structured envelope content[0].text must carry the engine ' +
      'error code, not an opaque message string. If undefined, a tool ' +
      'handler is still doing `throw new Error(result.error?.message)`.',
    ).toBe('DAEMON_TIMEOUT');
    expect(typeof r.payload.message).toBe('string');
    expect((r.payload.message as string).toLowerCase()).toContain('timed out');
    expect(typeof r.payload.retryable).toBe('boolean');
    expect(Array.isArray(r.payload.hints)).toBe(true);
    expect((r.payload.hints as unknown[]).length).toBeGreaterThan(0);
  }, 30000);

  it('TabUrlNotRecognizedError still throws (narrow scope: only EngineExecutionError converts to isError)', async () => {
    // F3.1's catch-block scope is intentionally narrow: only
    // EngineExecutionError converts to isError. Other SafariPilotError
    // subclasses (RateLimitedError, KillSwitchActiveError, ownership errors)
    // continue throwing — pre-F3.1 callers and SD-31 tests depend on that
    // contract. This test pins the scope decision.
    let thrown: unknown;
    try {
      await callTool(
        client,
        'safari_get_text',
        {
          tabUrl: 'https://this-tab-was-never-opened.example.com/',
          selector: 'body',
        },
        nextId(),
        10000,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    // The thrown error message should still mention the URL — confirms the
    // tab-ownership layer rejected (TabUrlNotRecognizedError throws through
    // the JSON-RPC -32603 path, message preserved).
    expect(msg.toLowerCase()).toContain('this-tab-was-never-opened');
  }, 20000);
});
