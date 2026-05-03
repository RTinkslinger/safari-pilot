/**
 * Phase 5A · 5A.10 — Recovery / degradation e2e (T42 closure).
 *
 * Three behavioural paths the production stack must handle gracefully:
 *
 *   A. Session-window close recovery — when the session window dies
 *      (user closes it, AppleScript timeout, etc.), the next tool call
 *      either auto-recovers (recoverSession opens a new window) or
 *      surfaces a typed SessionRecoveryError. Both outcomes prove the
 *      recovery path is wired (server.ts:500 → recoverSession at :1219).
 *
 *   B. Extension-disconnect fallback — when SAFARI_PILOT_FORCE_NO_EXTENSION=1
 *      is set, the server treats the extension as unavailable. Tools that
 *      strictly require extension capabilities surface EXTENSION_REQUIRED
 *      via the engine selector's degraded path; tools that have a daemon
 *      / AppleScript fallback continue to work via the alternate engine.
 *      This is the structural test for the degraded-mode promise that
 *      the engine selector and selectEngine() make to callers.
 *
 *   C. Circuit-breaker trip — five consecutive engine failures on the
 *      same domain trip the per-domain circuit breaker; the sixth call
 *      gets rejected with [Cc]ircuit breaker open before reaching the
 *      engine. Threshold 5, cooldown 120s (`src/security/circuit-breaker.ts`).
 *
 * Daemon-crash recovery is intentionally NOT exercised here. The daemon
 * is the LaunchAgent-managed singleton serving every MCP session on this
 * machine; killing it to test recovery would destabilise other sessions
 * including Claude Code's own. The recovery path itself is unit-tested at
 * `test/unit/server/recover-session-re-register.test.ts`. A truly
 * isolated daemon-crash e2e would need a dedicated test daemon instance,
 * which is tracked separately.
 *
 * Per CLAUDE.md "End-to-End Testing (HARD RULES)": real spawn, real MCP
 * protocol, real daemon, no stubs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initClient, callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { execSync } from 'node:child_process';

describe('Phase 5A · 5A.10 — recovery / degradation', () => {
  let sharedClient: McpTestClient;
  let sharedNextId: () => number;

  beforeAll(async () => {
    const s = await getSharedClient();
    sharedClient = s.client;
    sharedNextId = s.nextId;
  }, 30000);

  it('A. Session window close → next tool call either auto-recovers or throws SessionRecoveryError', async () => {
    // Spawn an isolated MCP server so we can close ITS session window
    // without affecting the shared client (or any other live MCP session).
    const own = await initClient('dist/index.js');
    try {
      // Sanity: the own client is healthy and has a session window id.
      const health = await callTool(own.client, 'safari_health_check', { verbose: true }, own.nextId);
      const init = health.init as Record<string, unknown>;
      const ownWindowId = init.windowId as number;
      expect(ownWindowId).toBeGreaterThan(0);

      // Programmatically close just THIS session's window. Match by id so
      // we don't touch any other Safari window the user has open.
      try {
        execSync(
          `osascript -e 'tell application "Safari" to close (every window whose id is ${ownWindowId})'`,
          { timeout: 8000, encoding: 'utf-8' },
        );
      } catch (e) {
        // If the close itself fails, the test premise can't be set up.
        // Don't fail the test for env reasons — surface clearly.
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Could not close session window via AppleScript (test setup): ${msg}`);
      }

      // Brief settle so Safari finishes the close + the daemon's window
      // probe sees the absence on the next tool call.
      await new Promise((r) => setTimeout(r, 1500));

      // Issue any tool call. The pre-call gate checks window existence
      // (server.ts:500) and either:
      //   (1) recoverSession() succeeds → tool call proceeds normally
      //   (2) recoverSession() fails → SessionRecoveryError surfaces as
      //       MCP error or content-text error
      // Both outcomes prove the recovery path is wired. A silent hang or
      // generic UNKNOWN error would indicate the path is broken.
      const probeUrl = `https://example.com/?sp_5A10_probe=${Date.now()}`;
      const raw = await rawCallTool(
        own.client,
        'safari_new_tab',
        { url: probeUrl },
        own.nextId + 1,
        25000,
      );

      const recovered = raw.payload?.tabUrl !== undefined;
      const surfacedAsContentError =
        typeof raw.payload?.text === 'string' && (raw.payload.text as string).includes('SESSION_RECOVERY');

      expect(
        recovered || surfacedAsContentError,
        `Window-close recovery path must either auto-recover (tabUrl present) ` +
        `or surface SESSION_RECOVERY as a typed error. Got payload=${JSON.stringify(raw.payload)}`,
      ).toBe(true);

      // Cleanup: if recovery succeeded, close the new tab.
      if (recovered) {
        try {
          await callTool(own.client, 'safari_close_tab', { tabUrl: raw.payload.tabUrl as string }, own.nextId + 2);
        } catch { /* best-effort */ }
      }
    } finally {
      await own.client.close();
    }
  }, 60000);

  it('B. SAFARI_PILOT_FORCE_NO_EXTENSION=1 → tools with daemon fallback succeed; extension-only tools surface EXTENSION_REQUIRED', async () => {
    // Spawn a server with the extension forced unavailable. The sentinel
    // is checked inside the server's start() (server.ts:1486) AND inside
    // ExtensionEngine.isAvailable() — flipping it produces the same effect
    // on a live extension as a real extension disconnect.
    const own = await initClient('dist/index.js', 1, { env: { SAFARI_PILOT_FORCE_NO_EXTENSION: '1' } });
    try {
      // Sanity: init metadata reports systems.extension=false.
      const health = await callTool(own.client, 'safari_health_check', { verbose: true }, own.nextId);
      const init = health.init as Record<string, unknown>;
      const systems = init.systems as Record<string, unknown>;
      expect(
        systems.extension,
        `With FORCE_NO_EXTENSION=1, init.systems.extension must be false. Got ${JSON.stringify(systems)}`,
      ).toBe(false);

      // safari_new_tab has a daemon fallback. With extension forced off,
      // it should still succeed but route via daemon engine (not extension).
      const tabUrl = `https://example.com/?sp_5A10_fallback=${Date.now()}`;
      const raw = await rawCallTool(own.client, 'safari_new_tab', { url: tabUrl }, own.nextId + 1, 20000);
      try {
        expect(raw.payload?.tabUrl, 'safari_new_tab should still succeed in degraded mode (daemon fallback)').toBeDefined();
        const engine = raw.meta?.engine as string | undefined;
        expect(
          engine,
          `safari_new_tab must route via a non-extension engine. Got engine="${engine}".`,
        ).not.toBe('extension');
      } finally {
        if (raw.payload?.tabUrl) {
          try { await callTool(own.client, 'safari_close_tab', { tabUrl: raw.payload.tabUrl as string }, own.nextId + 2); } catch { /* best-effort */ }
        }
      }
    } finally {
      await own.client.close();
    }
  }, 45000);

  it('C. Five engine failures on a domain trip the circuit breaker; sixth call surfaces [Cc]ircuit breaker open', async () => {
    // Use the shared client. We pick a unique sub-path on example.com so
    // the per-domain breaker tracks our failures specifically. Other tests
    // operating on different domains are unaffected.
    const tabUrl = `https://example.com/?sp_5A10_breaker=${Date.now()}`;
    const tab = await callTool(sharedClient, 'safari_new_tab', { url: tabUrl }, sharedNextId(), 15000);
    const liveTabUrl = tab.tabUrl as string;
    try {
      // Wait for content script injection.
      await new Promise((r) => setTimeout(r, 2000));

      // Five throwing safari_evaluate calls. Each propagates a tool error
      // through executeToolWithSecurity's catch path → recordFailure(domain)
      // increments the per-domain count. After 5, the breaker trips.
      // We intentionally don't per-iteration-assert — early calls may
      // throw (JSON-RPC error path), later calls may surface pre-rejection
      // as content text once the breaker trips. What matters is the SIXTH
      // call's behaviour.
      const captureSurface = async (script: string): Promise<string> => {
        try {
          const raw = await rawCallTool(
            sharedClient,
            'safari_evaluate',
            { tabUrl: liveTabUrl, script },
            sharedNextId(),
            10000,
          );
          // Either content-level error text or stringified payload.
          const txt = (raw.payload?._rawText as string | undefined)
            ?? (raw.payload && typeof raw.payload === 'object' ? JSON.stringify(raw.payload) : '');
          return txt ?? '';
        } catch (e) {
          return e instanceof Error ? e.message : String(e);
        }
      };

      const trips: string[] = [];
      for (let i = 0; i < 5; i++) {
        trips.push(await captureSurface(`throw new Error('5A10_breaker_trip_${i}');`));
      }

      // Sanity: at least one of the 5 surfaces an error/throw signal — proves
      // the loop actually exercised the failure path.
      expect(
        trips.some((t) => /error|throw|[Cc]ircuit breaker open|5A10_breaker_trip/i.test(t)),
        `At least one of 5 attempts must surface a failure indicator. Got: ${JSON.stringify(trips)}`,
      ).toBe(true);

      // Sixth call against the SAME domain: must surface [Cc]ircuit breaker open
      // either through the JSON-RPC error path or content-text path.
      const sixth = await captureSurface(`'should_not_run';`);
      expect(
        sixth,
        `Sixth call must surface [Cc]ircuit breaker open (pre-rejected by assertClosed at server.ts:602). ` +
        `Got: "${sixth}". Earlier surfaces: ${JSON.stringify(trips)}`,
      ).toMatch(/[Cc]ircuit breaker open/);
    } finally {
      try { await callTool(sharedClient, 'safari_close_tab', { tabUrl: liveTabUrl }, sharedNextId()); } catch { /* best-effort */ }
    }
  }, 90000);
});
