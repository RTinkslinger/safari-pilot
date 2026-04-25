/**
 * T38 — `recoverSession` must re-call `registerWithDaemon()` after a
 * successful recovery (BOTH branches: window-only and extension-recovery)
 * so the daemon's session registry stays consistent across daemon restarts.
 *
 * Scenario the audit flagged:
 *   1. Session A starts → POST /session/register → daemon: { A }
 *   2. Daemon restarts → daemon: { } (in-memory session registry resets)
 *   3. Session A's pre-call gate detects extension unreachable →
 *      `recoverSession()` runs → window re-opens, extension polled back
 *   4. Pre-fix: recovery returns true but daemon's session registry still
 *      empty. A new Session B starting now will register itself but see
 *      `otherSessions = 0`, which means SD-32's `closeOrphanedSessionWindows`
 *      will NOT skip cleanup → Session A's window gets closed by B.
 *   5. Post-fix: recovery also re-POSTs /session/register on every success
 *      branch, restoring A's row in the daemon's registry. B now sees
 *      `otherSessions ≥ 1`, preserves A's window.
 *
 * Three discriminating tests cover the contract:
 *   1. extension-recovery success → exactly 1 POST to /session/register
 *   2. window-only success        → exactly 1 POST to /session/register
 *   3. failed extension recovery  → 0 POSTs to /session/register
 *      (a session whose recovery failed must NOT be advertised as healthy)
 *
 * Each register-positive test also pins the URL exactly and asserts the
 * POST body carries this session's id — the daemon contract is not just
 * "POST happened" but "POST happened with sessionId".
 *
 * Mutation plan:
 *   - Comment out the new register call inside the extension-recovery
 *     branch → test 1 fails.
 *   - Comment out the new register call inside the window-only branch
 *     → test 2 fails.
 *   - Add an early register call BEFORE the recovery succeeds (wrong
 *     placement) → test 3 fails.
 *
 * Module-isolation pattern (SD-29): `node:child_process` is imported by
 * `SafariPilotServer` at module load time; under vitest's cross-file
 * isolate=false setting a top-level `vi.mock` arrives too late. Use
 * `vi.resetModules` + `vi.doMock` + dynamic `import()` in `beforeAll`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const REGISTER_URL = 'http://127.0.0.1:19475/session/register';

interface ServerInternals {
  _sessionWindowId?: number;
  sessionId: string;
  recoverSession: (
    traceId: string,
    options?: { extensionRecovery?: boolean },
  ) => Promise<boolean>;
}

let SafariPilotServer: typeof import('../../../src/server.js').SafariPilotServer;
let DEFAULT_CONFIG: typeof import('../../../src/config.js').DEFAULT_CONFIG;
let mockExecSync: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  vi.resetModules();
  mockExecSync = vi.fn().mockReturnValue('true\n');
  vi.doMock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, execSync: mockExecSync };
  });

  const serverModule = await import('../../../src/server.js');
  const configModule = await import('../../../src/config.js');
  SafariPilotServer = serverModule.SafariPilotServer;
  DEFAULT_CONFIG = configModule.DEFAULT_CONFIG;
});

function makeFetchMock(opts: { statusExt: boolean }): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/status')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          ext: opts.statusExt,
          mcp: true,
          sessionTab: true,
          lastPingAge: 0,
          activeSessions: 1,
        }),
      } as Response);
    }
    if (u.includes('/session/register')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ activeSessions: 1 }),
      } as Response);
    }
    return Promise.reject(new Error(`unexpected fetch URL: ${u}, init=${JSON.stringify(init)}`));
  });
}

function registerCallsOf(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((c: unknown[]) => {
    const url = String(c[0]);
    const method = ((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase();
    return url === REGISTER_URL && method === 'POST';
  });
}

function assertExactlyOneRegisterFor(
  fetchMock: ReturnType<typeof vi.fn>,
  expectedSessionId: string,
): void {
  const calls = registerCallsOf(fetchMock);
  expect(
    calls.length,
    'recoverSession must POST /session/register exactly once after a successful recovery',
  ).toBe(1);
  const init = calls[0][1] as RequestInit | undefined;
  const bodyStr = String(init?.body ?? '');
  const parsed = JSON.parse(bodyStr) as { sessionId?: string };
  expect(parsed.sessionId, 'register POST body must carry this session id').toBe(expectedSessionId);
}

describe('T38 — recoverSession re-registers with daemon', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockExecSync.mockReturnValue('true\n'); // window exists; skip re-open path
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('extension-recovery branch: POSTs /session/register exactly once after success', async () => {
    const fetchMock = makeFetchMock({ statusExt: true });
    vi.stubGlobal('fetch', fetchMock);

    const server = new SafariPilotServer(DEFAULT_CONFIG);
    const internals = server as unknown as ServerInternals;
    internals._sessionWindowId = 99999;

    const recovered = await internals.recoverSession('trace_t38_ext', {
      extensionRecovery: true,
    });

    expect(recovered).toBe(true);
    assertExactlyOneRegisterFor(fetchMock, internals.sessionId);
  });

  it('window-only branch: POSTs /session/register exactly once after success', async () => {
    const fetchMock = makeFetchMock({ statusExt: true });
    vi.stubGlobal('fetch', fetchMock);

    const server = new SafariPilotServer(DEFAULT_CONFIG);
    const internals = server as unknown as ServerInternals;
    internals._sessionWindowId = 99999;

    const recovered = await internals.recoverSession('trace_t38_window', {
      extensionRecovery: false,
    });

    expect(recovered).toBe(true);
    assertExactlyOneRegisterFor(fetchMock, internals.sessionId);
  });

  it('failed extension recovery: does NOT POST /session/register', async () => {
    const fetchMock = makeFetchMock({ statusExt: false });
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();

    const server = new SafariPilotServer(DEFAULT_CONFIG);
    const internals = server as unknown as ServerInternals;
    internals._sessionWindowId = 99999;

    const recoveryPromise = internals.recoverSession('trace_t38_fail', {
      extensionRecovery: true,
    });
    // Recovery loops 10× with 1s sleep between iterations.
    await vi.advanceTimersByTimeAsync(15_000);
    const recovered = await recoveryPromise;

    expect(recovered).toBe(false);
    expect(
      registerCallsOf(fetchMock).length,
      'failed recovery must NOT advertise this session as healthy to the daemon',
    ).toBe(0);
  });
});
