/**
 * SD-32 — `closeOrphanedSessionWindows` must NOT close windows when
 * other live MCP sessions are present. The orphan-cleanup AppleScript
 * filters by the constant title "Safari Pilot — Active Session" — a
 * string shared across every live session's dashboard tab. Pre-SD-32
 * a fresh Session B started while Session A was alive would have its
 * `closeOrphanedSessionWindows` call CLOSE Session A's window, leading
 * Session A's keepalive to fail and `SessionRecoveryError` to surface
 * mid-flow. The multi-session contract that `HealthStore.activeSessionCount`
 * + the per-session `?id=<sessionId>` query parameter were designed to
 * support is broken by this one constant-title filter.
 *
 * Fix: when `start()` learns from `registerWithDaemon()` that other
 * sessions are already live, store the count and have
 * `closeOrphanedSessionWindows` early-return on it. Single-session
 * orphan cleanup (the legitimate use case from SD-21 — recovering
 * after a crash) still runs.
 *
 * SD-29 pattern (vi.resetModules + vi.doMock + dynamic import) so
 * the boundary mock binds correctly even when other test files in
 * the same vitest run pre-load `src/server.ts`.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';

let execSync: ReturnType<typeof vi.fn>;
type SafariPilotServerCtor = new (config: unknown) => {
  killSwitch: { isActive: () => boolean };
  tabOwnership: unknown;
};
let SafariPilotServer: SafariPilotServerCtor;
let DEFAULT_CONFIG: unknown;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return { ...actual, execSync: vi.fn() };
  });
  const cp = await import('node:child_process');
  execSync = cp.execSync as unknown as ReturnType<typeof vi.fn>;

  const serverMod = await import('../../../src/server.js');
  SafariPilotServer = serverMod.SafariPilotServer as unknown as SafariPilotServerCtor;
  const cfgMod = await import('../../../src/config.js');
  DEFAULT_CONFIG = cfgMod.DEFAULT_CONFIG;
});

interface ServerInternals {
  _otherSessionsAtStart?: number;
  closeOrphanedSessionWindows: (traceId: string) => Promise<void>;
}

describe('closeOrphanedSessionWindows multi-session safety (SD-32)', () => {
  beforeEach(() => {
    execSync.mockReset();
    execSync.mockReturnValue('');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips the orphan-cleanup AppleScript when other live sessions are present at start', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    // Simulate `start()` having learned from `registerWithDaemon()` that
    // another session was already live when this session began. Pre-fix
    // there is no such field — closeOrphanedSessionWindows runs blind.
    (server as unknown as ServerInternals)._otherSessionsAtStart = 1;

    await (server as unknown as ServerInternals).closeOrphanedSessionWindows('test-trace');

    // PRIMARY ORACLE — the AppleScript that closes session-titled windows
    // must NOT execute. Pre-SD-32 it ran unconditionally and closed any
    // window with the constant title — including the LIVE other session's
    // window. Post-fix the early-return on `_otherSessionsAtStart > 0`
    // makes execSync untouched.
    //
    // Rationale: `closeOrphanedSessionWindows` is the only place this
    // codepath issues `osascript -e 'tell application "Safari" ...
    // every window whose name is "Safari Pilot — Active Session"'`. With
    // _otherSessionsAtStart=1, no execSync call should happen — the
    // function returns before the dynamic-import even resolves.
    expect(
      execSync,
      'orphan-cleanup AppleScript must not fire when other live sessions are present; '
        + 'doing so would close their session windows and trigger their recovery loops',
    ).not.toHaveBeenCalled();
  });

  it('still runs the orphan-cleanup AppleScript when this is the only live session (single-session crash-recovery preserved)', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    // _otherSessionsAtStart=0 (or absent) → cleanup runs normally so the
    // SD-21 crash-recovery path keeps working when no concurrent session
    // is at risk. This pins the negative form: SD-32 fix must not over-
    // suppress. A regression that always-skips would fail this assertion.
    (server as unknown as ServerInternals)._otherSessionsAtStart = 0;

    await (server as unknown as ServerInternals).closeOrphanedSessionWindows('test-trace');

    expect(
      execSync,
      'orphan-cleanup must still run in single-session mode — SD-21 crash recovery '
        + 'depends on it. Over-suppressing here would re-introduce the orphan-window bug.',
    ).toHaveBeenCalledTimes(1);
    const call = execSync.mock.calls[0];
    const cmd = String(call?.[0] ?? '');
    expect(
      cmd,
      'cleanup invocation must call osascript with the "Safari Pilot — Active Session" filter',
    ).toContain('Safari Pilot — Active Session');
  });
});
