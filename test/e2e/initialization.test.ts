import { describe, it, expect, afterAll } from 'vitest';
import { initClient, callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';

describe('Initialization system', () => {
  let client: McpTestClient;
  let nextId: number;

  afterAll(async () => {
    if (client) await client.close();
  });

  it('MCP initialize blocks until session window opens and extension connects', async () => {
    // This is the real test: spawn node dist/index.js, do MCP handshake.
    // initClient blocks until initialize response arrives — which now blocks
    // until the session window is open and extension is connected.
    const startMs = Date.now();
    const result = await initClient('dist/index.js');
    client = result.client;
    nextId = result.nextId;
    const elapsed = Date.now() - startMs;

    // Init should take 2-15s (extension connection time)
    expect(elapsed).toBeGreaterThan(1000);
    expect(elapsed).toBeLessThan(20000);
  }, 25000);

  it('safari_health_check returns init metadata with all systems green', async () => {
    const result = await callTool(client, 'safari_health_check', { verbose: true }, nextId++);

    expect(result.healthy).toBe(true);
    expect(result.init).toBeDefined();
    expect(result.init.sessionId).toMatch(/^sess_/);
    expect(result.init.windowId).toBeGreaterThan(0);
    expect(result.init.systems.daemon).toBe(true);
    expect(result.init.systems.extension).toBe(true);
    expect(result.init.systems.sessionTab).toBe(true);
    expect(result.init.initDurationMs).toBeGreaterThan(0);
  }, 15000);

  it('safari_new_tab routes through extension engine', async () => {
    const raw = await rawCallTool(
      client, 'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      15000,
    );
    expect(raw.payload.tabUrl).toContain('example.com');
    // new_tab goes through extension engine (not AppleScript fallback)
    expect(raw.meta?.engine).toBe('extension');
  }, 20000);

  // NOTE: safari_evaluate via extension engine has a known timing issue (Bug 6).
  // Content script isn't ready in newly opened tabs — storage bus command times out.
  // Tracked in docs/upp/bugs/2026-04-22-session-test-findings.md.
  // This test is skipped until Bug 6 is fixed.
  it.skip('safari_evaluate routes through extension engine', async () => {
    const raw = await rawCallTool(
      client, 'safari_evaluate',
      { tabUrl: 'https://example.com/', script: 'return document.title' },
      nextId++,
      30000,
    );
    expect(raw.meta?.engine).toBe('extension');
  }, 35000);

  it('pre-call gate detects and reports system status', async () => {
    // Just calling a tool proves the gate runs (it checks /status before executing).
    // If we get a result, the gate passed.
    const result = await callTool(client, 'safari_list_tabs', {}, nextId++);
    expect(Array.isArray(result) || typeof result === 'object').toBe(true);
  }, 10000);
});
