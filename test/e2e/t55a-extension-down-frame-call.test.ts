/**
 * T55a Task 24 — frame-targeted call when extension is unreachable returns
 * FRAME_NOT_SUPPORTED, not silent fallback.
 *
 * Uses SAFARI_PILOT_FORCE_NO_EXTENSION=1 (added in this branch) to make
 * ExtensionEngine.isAvailable() report false without unloading the
 * extension in Safari. Frame-aware tools (requiresFramesCrossOrigin) must
 * then refuse cleanly with FRAME_NOT_SUPPORTED — they must NOT silently
 * fall through to AppleScript and emit a SecurityError DOMException when
 * the same-origin assumption breaks for cross-origin frames.
 *
 * This test spawns its own MCP client because the env var must be set
 * BEFORE the daemon process spawns ExtensionEngine — the shared client
 * captures env at first spawn and would see the var unset.
 *
 * Litmus: revert routeFrameAware's `engine.name !== 'extension' →
 * FrameNotSupportedError` branch and the call falls into AppleScript,
 * surfacing a cross-origin SecurityError instead.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initClient, callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

describe('T55a — extension-down frame call', () => {
  let ownClient: McpTestClient | null = null;
  let ownNextId: () => number = () => 0;
  let fixture: FixtureServer;
  const openedTabs: string[] = [];

  beforeAll(async () => {
    fixture = await startFixtureServer();
    // SEPARATE MCP server with SAFARI_PILOT_FORCE_NO_EXTENSION=1.
    // getSharedClient is unsuitable: env var must be present when the
    // daemon initially spawns ExtensionEngine. mcp-client.ts spawns
    // node without an explicit env override, so process.env propagates
    // to the child.
    process.env['SAFARI_PILOT_FORCE_NO_EXTENSION'] = '1';
    const own = await initClient('dist/index.js');
    ownClient = own.client;
    let counter = own.nextId;
    ownNextId = () => counter++;
  }, 60_000);

  afterAll(async () => {
    if (ownClient) {
      for (const url of openedTabs) {
        try { await callTool(ownClient, 'safari_close_tab', { tabUrl: url }, ownNextId()); } catch { /* best-effort */ }
      }
      try { await ownClient.close(); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
    delete process.env['SAFARI_PILOT_FORCE_NO_EXTENSION'];
  }, 60_000);

  it('returns FRAME_NOT_SUPPORTED, not a SecurityError fallback', async () => {
    expect(ownClient).not.toBeNull();
    const tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t24=1`;
    openedTabs.push(tabUrl);
    await callTool(ownClient!, 'safari_new_tab', { url: tabUrl }, ownNextId(), 15_000);
    await new Promise((r) => setTimeout(r, 2500));

    let caught: unknown = null;
    let payload: Record<string, unknown> | null = null;
    try {
      const r = await rawCallTool(ownClient!, 'safari_eval_in_frame', {
        tabUrl,
        frameId: 5,
        script: 'return 1',
      }, ownNextId(), 15_000);
      payload = r.payload;
    } catch (e) {
      caught = e;
    }

    const errStr = caught
      ? (caught instanceof Error ? caught.message : JSON.stringify(caught))
      : JSON.stringify(payload);
    expect(errStr, `payload=${JSON.stringify(payload)} caught=${String(caught)}`).toMatch(/FRAME_NOT_SUPPORTED|extension is not available|EngineUnavailable|EXTENSION_REQUIRED/i);
    expect(errStr).not.toMatch(/SecurityError|DOMException/);
  }, 45_000);
});
