/**
 * T29 — `executeToolWithSecurity()`'s catch block must call
 * `killSwitch.recordError()` so the kill switch's auto-activation
 * threshold actually fires when N tool failures land in the configured
 * rolling window.
 *
 * Pre-T29: KillSwitch.recordError was wired to threshold tracking
 * (kill-switch.ts:132-150) but no production code path called it.
 * The autoActivation config field flowed into the KillSwitch constructor
 * (server.ts:196-197) but the `recordError` symbol appeared in zero
 * production files. Three failures could not trip the gate.
 *
 * Test pattern (matches `record-tool-failure.test.ts` SD-08 refactor):
 * observable-state assertion — call the public `executeToolWithSecurity`
 * via type-cast access, throw inside the registered tool handler, then
 * assert on `server.killSwitch.isActive()` and on the
 * `KillSwitchActiveError` thrown by the next call. Asserts the user-
 * observable end state, not the call-shape of `recordError`.
 *
 * Boundary mocks (per CLAUDE.md "Unit Tests" hard rules — only Node
 * stdlib, never internal modules):
 *   - `node:child_process.execSync` — drives `checkWindowExists()`
 *   - global `fetch` — drives `checkExtensionStatus()`
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'node:child_process';
import { SafariPilotServer } from '../../../src/server.js';
import { DEFAULT_CONFIG } from '../../../src/config.js';
import { KillSwitchActiveError, TabUrlNotRecognizedError } from '../../../src/errors.js';
import type { Engine } from '../../../src/types.js';

interface ServerInternals {
  _sessionWindowId?: number;
  executeToolWithSecurity: (name: string, params: Record<string, unknown>) => Promise<unknown>;
}

function setSessionWindowId(server: SafariPilotServer, id: number): void {
  (server as unknown as ServerInternals)._sessionWindowId = id;
}

function callExecuteToolWithSecurity(
  server: SafariPilotServer,
  name: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return (server as unknown as ServerInternals).executeToolWithSecurity(name, params);
}

describe('SafariPilotServer kill-switch auto-activation (T29)', () => {
  const mockExec = execSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExec.mockReset();
    vi.unstubAllGlobals();
    // Window present, extension present — gate must NOT fire recovery so the
    // tool handler actually runs and throws.
    mockExec.mockReturnValue('true\n');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ext: true,
          mcp: true,
          sessionTab: true,
          lastPingAge: 100,
          activeSessions: 1,
        }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('auto-activates after maxErrors failures within the rolling window AND blocks the next call with KillSwitchActiveError', async () => {
    // Configure auto-activation at 3 errors / 60s. With autoActivation:true
    // the SafariPilotServer ctor builds the threshold object and passes it
    // into the KillSwitch instance (server.ts:196-197).
    const config = {
      ...DEFAULT_CONFIG,
      killSwitch: { autoActivation: true, maxErrors: 3, windowSeconds: 60 },
    };
    const server = new SafariPilotServer(config);
    setSessionWindowId(server, 99999);

    // safari_list_tabs is in SKIP_OWNERSHIP_TOOLS so the call reaches the
    // handler without tripping ownership. Stub handler throws so the
    // executeToolWithSecurity catch path runs every time.
    server.registerTool({
      name: 'safari_list_tabs',
      description: 'test stub for kill-switch auto-activation',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: true },
      handler: async () => {
        throw new Error('intentional handler failure for T29');
      },
    });

    // Pre-condition: switch is closed at the start.
    expect(
      server.killSwitch.isActive(),
      'kill switch must start closed before any failures are recorded',
    ).toBe(false);

    // Drive maxErrors=3 failures through the catch block.
    for (let i = 0; i < 3; i++) {
      let thrown: unknown;
      try {
        await callExecuteToolWithSecurity(server, 'safari_list_tabs', {});
      } catch (e) {
        thrown = e;
      }
      // Each call must surface the handler's error (not be swallowed).
      expect(thrown, `call ${i + 1} must throw the handler's error`).toBeInstanceOf(Error);
    }

    // PRIMARY ORACLE: after maxErrors=3 failures, the switch must be active.
    // A regression where the catch block doesn't call recordError leaves the
    // switch closed and this assertion fails.
    expect(
      server.killSwitch.isActive(),
      'kill switch must auto-activate after maxErrors failures within the window',
    ).toBe(true);

    // SECONDARY ORACLE: the auto-activated state must surface to the caller
    // — the next call's checkBeforeAction throws KillSwitchActiveError.
    let blocked: unknown;
    try {
      await callExecuteToolWithSecurity(server, 'safari_list_tabs', {});
    } catch (e) {
      blocked = e;
    }
    expect(
      blocked,
      'subsequent call must be blocked by the auto-activated kill switch',
    ).toBeInstanceOf(KillSwitchActiveError);
  });

  // SD-31 — T29 added `this.killSwitch.recordError()` to the catch block but
  // did not filter by error class. Every thrown error counts toward the
  // auto-activation rolling window, including security-pipeline rejections
  // that aren't tool-execution failures (rate-limit, ownership, circuit-
  // breaker, kill-switch-already-active, blocked-domain). With
  // `autoActivation: { maxErrors: 3, windowSeconds: 60 }` configured, three
  // legitimate rejections — e.g. an agent looping over unowned URLs — trip
  // the switch and self-DoS the rest of the session.
  //
  // The companion call `recordEngineFailure` is filtered to extension-
  // lifecycle codes (`circuit-breaker.ts:175-181`); `recordError` should be
  // similarly filtered.
  it('does NOT count security-pipeline rejections (TabUrlNotRecognizedError) toward kill-switch auto-activation (SD-31)', async () => {
    const config = {
      ...DEFAULT_CONFIG,
      killSwitch: { autoActivation: true, maxErrors: 3, windowSeconds: 60 },
    };
    const server = new SafariPilotServer(config);
    setSessionWindowId(server, 99999);

    // safari_navigate is NOT in SKIP_OWNERSHIP_TOOLS, so the ownership
    // check fires (server.ts:600+). With `tabUrl` set to an unowned URL,
    // tabOwnership.assertOwnedByUrl throws TabUrlNotRecognizedError BEFORE
    // the handler runs — exercising the security-pipeline rejection path.
    server.registerTool({
      name: 'safari_navigate',
      description: 'test stub',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: false },
      handler: async () => ({
        content: [],
        metadata: { engine: 'applescript' as Engine, degraded: false, latencyMs: 0 },
      }),
    });

    expect(server.killSwitch.isActive()).toBe(false);

    for (let i = 0; i < 3; i++) {
      let thrown: unknown;
      try {
        await callExecuteToolWithSecurity(server, 'safari_navigate', {
          url: 'https://target.example/',
          tabUrl: `https://untrusted-${i}.example/`,
        });
      } catch (e) {
        thrown = e;
      }
      expect(
        thrown,
        `call ${i + 1} must throw TabUrlNotRecognizedError from ownership check`,
      ).toBeInstanceOf(TabUrlNotRecognizedError);
    }

    // PRIMARY ORACLE — switch must NOT have tripped.
    // Pre-SD-31: recordError() runs unconditionally → 3 rejections trip the
    // threshold → switch active → all subsequent calls fail.
    // Post-fix: recordError() filters security-pipeline errors → only
    // genuine tool-execution failures count → switch stays closed.
    expect(
      server.killSwitch.isActive(),
      'security-pipeline rejections must NOT count toward kill-switch auto-activation; '
        + 'counting them lets a legitimate burst of unowned-URL attempts self-DoS the agent.',
    ).toBe(false);

    // SECONDARY ORACLE — a subsequent legitimate call must NOT be blocked
    // by a phantom-active switch. Locks against the regression where the
    // primary oracle is "satisfied" by a switch that's almost-tripped but
    // hasn't quite crossed the threshold.
    let nextCallThrown: unknown;
    try {
      await callExecuteToolWithSecurity(server, 'safari_navigate', {
        url: 'https://target.example/',
        tabUrl: 'https://untrusted-final.example/',
      });
    } catch (e) {
      nextCallThrown = e;
    }
    expect(
      nextCallThrown,
      'next call must reject for OWNERSHIP reasons, not because the switch tripped',
    ).toBeInstanceOf(TabUrlNotRecognizedError);
    expect(
      nextCallThrown,
      'next call must NOT throw KillSwitchActiveError — threshold should not have engaged',
    ).not.toBeInstanceOf(KillSwitchActiveError);
  });
});
