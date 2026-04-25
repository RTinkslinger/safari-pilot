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
import { KillSwitchActiveError } from '../../../src/errors.js';

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
});
