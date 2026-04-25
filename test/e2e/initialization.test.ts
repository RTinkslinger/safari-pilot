import { describe, it, expect, beforeAll } from 'vitest';
import { initClient, callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('Initialization system', () => {
  let client: McpTestClient;
  let nextId: () => number;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 30000);

  it('MCP initialize blocks until session window opens and extension connects', async () => {
    // This test owns its own spawn so it can measure first-spawn init
    // latency regardless of whether the shared client is already up.
    // It creates one extra Safari window (cleaned by T10 on SIGTERM).
    const startMs = Date.now();
    const own = await initClient('dist/index.js');
    const elapsed = Date.now() - startMs;
    try {
      expect(elapsed).toBeGreaterThan(1000);
      expect(elapsed).toBeLessThan(20000);
    } finally {
      await own.client.close();
    }
  }, 25000);

  it('safari_health_check returns init metadata with all systems green', async () => {
    const result = await callTool(client, 'safari_health_check', { verbose: true }, nextId());

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
    const unique = `https://example.com/?sp_init_new=${Date.now()}`;
    const raw = await rawCallTool(
      client, 'safari_new_tab',
      { url: unique },
      nextId(),
      15000,
    );
    try {
      expect(raw.payload.tabUrl).toContain('example.com');
      // new_tab goes through extension engine (not AppleScript fallback)
      expect(raw.meta?.engine).toBe('extension');
    } finally {
      try { await callTool(client, 'safari_close_tab', { tabUrl: raw.payload.tabUrl as string }, nextId()); } catch { /* ignore */ }
    }
  }, 20000);

  it('safari_evaluate routes through extension engine in new tab', async () => {
    const unique = `https://example.com/?sp_init_eval=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: unique }, nextId(), 15000);
    const tabUrl = tab.tabUrl as string;
    try {
      // Bug 6 fix: content-isolated.js now reads current sp_cmd on init,
      // catching commands written before the content script loaded.
      // Wait 3s after new_tab for content script to inject (document_idle).
      await new Promise(r => setTimeout(r, 3000));
      const raw = await rawCallTool(
        client, 'safari_evaluate',
        { tabUrl, script: 'return document.title' },
        nextId(),
        30000,
      );
      expect(raw.payload).toBeDefined();
      expect(raw.meta?.engine).toBe('extension');
    } finally {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ }
    }
  }, 40000);

  // SD-03: the prior "pre-call gate detects and reports system status" test
  // was deleted. The pre-call gate emits no observable signal on the healthy
  // path (only `recovery_*` events fire on the broken path), and its negative
  // path is unreachable from e2e: `checkWindowExists` uses `exists window id`
  // which Safari leaves permanently true after a close (ghost-window quirk),
  // and breaking the daemon would tear down the shared client. The rich
  // `safari_health_check` test above is the substantive systems-status oracle.
  // SD-20 in docs/FOLLOW-UPS.md tracks the proper negative-path test design.
});
