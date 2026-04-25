/**
 * SD-20 — Pre-call gate negative-path coverage. Filed during SD-03 Phase 1
 * when that test was deleted (its oracle was tautological from the e2e side
 * of the boundary). This test exercises the gate at the unit level by
 * mocking the two probe boundaries:
 *
 *   - `node:child_process.execSync` — drives `checkWindowExists()` via the
 *     `osascript -e 'exists window id N'` shell invocation
 *   - global `fetch` — drives `checkExtensionStatus()` via HTTP GET
 *     `127.0.0.1:19475/status`
 *
 * Both probes are private. The gate is at `server.ts:423-442`. Recovery
 * loops 10× with 1s sleep between (`server.ts:1132-1142`); we use vi's
 * fake timers to skip the wait.
 *
 * Discriminator (per FOLLOW-UPS SD-20): revert the gate at server.ts:431
 * (drop the `if (!preStatus.ext || !windowOk)` branch) — the negative-path
 * test must fail because no recovery runs and no `SessionRecoveryError`
 * is thrown when the system is broken.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Partial mock: only override execSync (matches ensure-session-window.test.ts
// precedent so spawn/execFile stay real for unrelated SUT code paths).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'node:child_process';
import { SafariPilotServer } from '../../../src/server.js';
import { SessionRecoveryError } from '../../../src/errors.js';
import { DEFAULT_CONFIG } from '../../../src/config.js';

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

/**
 * Register a stub tool so the gate can see its declared requirements.
 * In production the server's `initialize()` registers all 76 tools; these
 * unit tests bypass `initialize()` (which would do real I/O for daemon
 * availability) and register only the specific tool the test exercises.
 *
 * T28 — the gate consults `requiresExtension(toolDef.requirements)` to
 * decide whether to fire extension recovery, so the registered
 * `requirements` block must match the production tool's declaration.
 */
function registerStubTool(
  server: SafariPilotServer,
  name: string,
  requirements: { idempotent: boolean; requiresShadowDom?: boolean },
): void {
  server.registerTool({
    name,
    description: 'test stub for pre-call gate',
    inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
    requirements,
    handler: async () => {
      throw new Error(`stub handler for ${name}: should not be reached when the gate fires`);
    },
  });
}

describe('SafariPilotServer pre-call gate (SD-20): SessionRecoveryError on broken system', () => {
  const mockExec = execSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExec.mockReset();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('throws SessionRecoveryError when extension is unreachable AND recovery times out', async () => {
    // Window exists (skip the re-open path inside recoverSession). This
    // isolates the test to the extension-recovery branch.
    mockExec.mockReturnValue('true\n');
    // Extension probe always returns ext=false.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ext: false,
        mcp: false,
        sessionTab: false,
        lastPingAge: null,
        activeSessions: 0,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 99999);
    registerStubTool(server, 'safari_query_shadow', {
      idempotent: true,
      requiresShadowDom: true,
    });

    vi.useFakeTimers();
    // Register the rejection handler BEFORE advancing timers — otherwise the
    // recovery loop's rejection lands in an unhandled-rejection window.
    //
    // Tool choice: `safari_query_shadow` declares
    // `requirements: { idempotent: true, requiresShadowDom: true }`. T28
    // made the gate engine-aware — extension recovery only fires when the
    // tool's requirements include extension capabilities, so this test must
    // use an extension-requiring tool to keep exercising the
    // recovery-times-out branch.
    const callPromise = callExecuteToolWithSecurity(server, 'safari_query_shadow', {
      tabUrl: 'https://example.com',
      hostSelector: 'app-root',
      shadowSelector: 'div',
    });
    const expectation = expect(callPromise).rejects.toBeInstanceOf(SessionRecoveryError);

    // Recovery loops 10× with 1s sleep between iterations.
    await vi.advanceTimersByTimeAsync(15_000);
    await expectation;

    // Re-await the same promise to extract the error for further assertions.
    // Already rejected and handled — no second unhandled-rejection window.
    let thrown: unknown;
    try {
      await callPromise;
    } catch (e) {
      thrown = e;
    }
    const err = thrown as SessionRecoveryError;
    expect(err.message).toContain('Session recovery failed');
    expect(err.message).toContain('extension not connected');
    expect(err.retryable, 'caller must know to retry').toBe(true);
    expect(err.hints, 'hints array must guide user toward repair').toContain(
      'Check extension is enabled in Safari > Settings > Extensions',
    );

    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      calls.some((u) => u.includes('127.0.0.1:19475/status')),
      'gate must hit the production /status endpoint, not a different URL',
    ).toBe(true);
  });

  it('throws SessionRecoveryError with window=false in the message when window starts closed and extension fails to recover', async () => {
    // Reviewer MAJOR fix (SD-20): sequenced execSync mock so the test ACTUALLY
    // exercises the SessionRecoveryError window-failure branch
    // (errors.ts:326 — `if (!details.window) down.push('session window closed')`).
    // Earlier version short-circuited on SessionWindowInitError before the
    // recovery loop ever ran.
    //
    //   call 1 — gate's checkWindowExists → 'false' (initial windowOk=false)
    //   call 2 — recoverSession's checkWindowExists → 'true' (skip
    //            ensureSessionWindow re-open path; the SUT only re-opens
    //            when this also returns false)
    //   call 3+ — any subsequent execSync → 'true' (defensive)
    mockExec.mockReturnValueOnce('false\n').mockReturnValue('true\n');
    // Extension fails for the entire recovery loop so recovery times out
    // → SessionRecoveryError thrown with window=initial=false.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ext: false,
        mcp: false,
        sessionTab: false,
        lastPingAge: null,
        activeSessions: 0,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 99999);
    registerStubTool(server, 'safari_query_shadow', {
      idempotent: true,
      requiresShadowDom: true,
    });

    vi.useFakeTimers();
    // T28 — gate is engine-aware, so the test must use an extension-requiring
    // tool to keep exercising the recovery-times-out branch.
    const callPromise = callExecuteToolWithSecurity(server, 'safari_query_shadow', {
      tabUrl: 'https://example.com',
      hostSelector: 'app-root',
      shadowSelector: 'div',
    });
    const expectation = expect(callPromise).rejects.toBeInstanceOf(SessionRecoveryError);
    await vi.advanceTimersByTimeAsync(15_000);
    await expectation;

    let thrown: unknown;
    try {
      await callPromise;
    } catch (e) {
      thrown = e;
    }
    const err = thrown as SessionRecoveryError;
    expect(err.message).toContain('Session recovery failed');
    expect(err.message).toContain('session window closed',
                                 'window-down branch in SessionRecoveryError ctor must surface');
    expect(err.retryable).toBe(true);
  });

  it('skips extension recovery when extension is down but the tool does not require it (T28)', async () => {
    // T28 — the pre-call gate previously fired 10s extension-recovery
    // polling on EVERY tool call when extension was unavailable, even for
    // tools the engine selector would route to AppleScript. `safari_list_tabs`
    // declares `requirements: { idempotent: true }` (no extension flags), so
    // the gate must skip extension polling and let engine selection route
    // the call to AppleScript.
    //
    // Discriminator: a regression where the gate ignores tool requirements
    // makes /status fire 11× (1 initial probe + 10× recovery polling). With
    // the engine-aware gate the call hits /status exactly ONCE.
    mockExec.mockReturnValue('true\n'); // window OK throughout
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ext: false, // extension UNAVAILABLE
        mcp: false,
        sessionTab: false,
        lastPingAge: null,
        activeSessions: 0,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 99999);
    registerStubTool(server, 'safari_list_tabs', { idempotent: true });

    let thrown: unknown;
    try {
      await callExecuteToolWithSecurity(server, 'safari_list_tabs', {});
    } catch (e) {
      thrown = e;
    }

    // Tool may fail downstream (no real engines wired), but it must NOT
    // fail with SessionRecoveryError — that would mean recovery fired.
    expect(
      thrown,
      'gate must NOT throw SessionRecoveryError for an extension-unrelated tool '
        + 'when the extension is unavailable',
    ).not.toBeInstanceOf(SessionRecoveryError);

    expect(
      fetchMock.mock.calls.length,
      'gate must call /status exactly once (initial probe) when the tool does '
        + 'not need the extension; 11 means extension-recovery polling fired '
        + 'unnecessarily',
    ).toBe(1);
  });

  it('gate does NOT throw SessionRecoveryError when probes are healthy AND does NOT trigger the recovery loop', async () => {
    // Reviewer ADVISORY fix (SD-20): renamed to match what's asserted (negative
    // form), AND added a fetch-call-count assertion to discriminate against
    // a regression where the gate predicate is replaced with `if (true)` so
    // recovery ALWAYS fires. With healthy probes, the gate must call /status
    // EXACTLY ONCE (the initial probe, before the if-branch) — not 11× (1
    // probe + 10× recovery polling).
    mockExec.mockReturnValue('true\n');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ext: true,
        mcp: true,
        sessionTab: true,
        lastPingAge: 100,
        activeSessions: 1,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 99999);
    // T28 — production tool requirements; gate is engine-aware so the
    // tool must be registered with its real declared requirements.
    registerStubTool(server, 'safari_navigate', { idempotent: false });

    let thrown: unknown;
    try {
      await callExecuteToolWithSecurity(server, 'safari_navigate', {
        url: 'https://example.com',
        tabId: 1,
      });
    } catch (e) {
      thrown = e;
    }

    expect(
      thrown,
      'something must throw — no real engines wired in this unit test',
    ).toBeDefined();
    expect(
      thrown,
      'gate must NOT throw SessionRecoveryError when probes are healthy',
    ).not.toBeInstanceOf(SessionRecoveryError);

    // Discriminator: a regression replacing `if (!preStatus.ext || !windowOk)`
    // with `if (true)` would always trigger recovery → fetch called 11× (1
    // initial + 10 polling). Asserting exactly 1 call locks the gate predicate.
    expect(
      fetchMock.mock.calls.length,
      'gate must call /status exactly once (initial probe) when probes are healthy; '
        + `> 1 means recovery loop fired unnecessarily, < 1 means gate didn't probe`,
    ).toBe(1);
  });
});
