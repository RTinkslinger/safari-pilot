/**
 * T11 — `SafariPilotServer.ensureSessionWindow()` must throw
 * `SessionWindowInitError` when the AppleScript window-creation call fails
 * or returns an unparseable window id. Pre-T11 both failure modes were
 * silently swallowed, leaving `_sessionWindowId` undefined and surfacing
 * 15 seconds later as a misleading "extension not connected" error.
 *
 * Mocks `node:child_process` at the Node boundary (allowed by boundary
 * policy). Does NOT mock `SafariPilotServer`, `ensureSessionWindow`, or
 * any internal — the whole point is to exercise the real method's
 * failure-propagation behavior.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Partial mock: only override execSync. The rest of node:child_process
// (execFile, spawn, …) stays real because server.ts → applescript.ts →
// daemon.ts transitively depend on them.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'node:child_process';
import { SafariPilotServer } from '../../../src/server.js';
import { SessionWindowInitError } from '../../../src/errors.js';
import { DEFAULT_CONFIG } from '../../../src/config.js';

/**
 * Invoke the private ensureSessionWindow in a type-safe cast. The method
 * cast stays because SD-09's scope was specifically about READING private
 * state fields via `as unknown as`; test-only entry-point method calls
 * are a separate concern.
 */
async function callEnsureSessionWindow(server: SafariPilotServer): Promise<void> {
  await (server as unknown as { ensureSessionWindow: (id: string) => Promise<void> })
    .ensureSessionWindow('test-trace');
}

describe('SafariPilotServer.ensureSessionWindow (T11): failure propagation', () => {
  const mockExec = execSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExec.mockReset();
  });

  it('resolves with _sessionWindowId set when osascript returns a valid number', async () => {
    mockExec.mockReturnValue('12345\n');
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    await callEnsureSessionWindow(server);
    expect(server.getSessionWindowId()).toBe(12345);
  });

  it('throws SessionWindowInitError when execSync itself fails', async () => {
    mockExec.mockImplementation(() => {
      throw new Error('osascript: execution error: -1743');
    });
    const server = new SafariPilotServer(DEFAULT_CONFIG);

    let thrown: unknown;
    try {
      await callEnsureSessionWindow(server);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'must throw instead of silently passing').toBeInstanceOf(SessionWindowInitError);
    const err = thrown as SessionWindowInitError;
    expect(err.message).toContain('AppleScript');
    expect(err.message).toContain('-1743'); // original cause surfaced
    expect(err.retryable).toBe(false);
    expect(server.getSessionWindowId(), '_sessionWindowId must stay undefined on failure').toBeUndefined();
  });

  it('throws SessionWindowInitError when osascript returns unparseable output', async () => {
    // Simulates the case where Safari answered but with a string instead of
    // a numeric window id (e.g. an error message the osascript wrapper
    // didn't fail on).
    mockExec.mockReturnValue('not-a-number\n');
    const server = new SafariPilotServer(DEFAULT_CONFIG);

    let thrown: unknown;
    try {
      await callEnsureSessionWindow(server);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SessionWindowInitError);
    const err = thrown as SessionWindowInitError;
    expect(err.message).toContain('unparseable');
    expect(err.message).toContain('not-a-number');
    expect(server.getSessionWindowId()).toBeUndefined();
  });

  it('no-ops (does not re-throw) when _sessionWindowId is already set', async () => {
    // Pre-condition: window already created in a prior call. ensureSessionWindow
    // must return without touching execSync.
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    (server as unknown as { _sessionWindowId: number })._sessionWindowId = 999;
    await callEnsureSessionWindow(server);
    expect(mockExec).not.toHaveBeenCalled();
    expect(server.getSessionWindowId()).toBe(999);
  });

  // SD-21 — flake-resistance against leaked session windows + tight 5s timeout.

  it('SD-21 (b): closes orphaned "Safari Pilot — Active Session" windows BEFORE creating a new one', async () => {
    // First execSync call must be the orphan-cleanup AppleScript (recognizable
    // by `every window whose name is "Safari Pilot — Active Session"`).
    // Second call must be the `make new document` invocation.
    // Both are required, in order. A regression that drops the cleanup call
    // would let pre-crash leaked windows accumulate, contributing to the
    // timeout flake on subsequent starts.
    mockExec.mockReturnValueOnce('').mockReturnValueOnce('12345\n');

    const server = new SafariPilotServer(DEFAULT_CONFIG);
    await callEnsureSessionWindow(server);

    expect(
      mockExec.mock.calls.length,
      'must call execSync exactly twice: orphan cleanup then window creation',
    ).toBe(2);
    const firstCmd = String(mockExec.mock.calls[0]![0]);
    const secondCmd = String(mockExec.mock.calls[1]![0]);
    expect(
      firstCmd,
      'first execSync must be the orphan-cleanup AppleScript matching by window name',
    ).toContain('every window whose name is "Safari Pilot — Active Session"');
    expect(
      firstCmd,
      'cleanup must explicitly close matched windows',
    ).toContain('close w');
    expect(
      secondCmd,
      'second execSync must be the make-new-document call (post-cleanup)',
    ).toContain('make new document');
    expect(server.getSessionWindowId()).toBe(12345);
  });

  it('SD-21 (a): make-new-document timeout is bumped from 5s to 15s for moderate Safari load', async () => {
    // The 5s budget was tight under load (multiple windows, recent extension
    // activity). Bumped to 15s gives 3× headroom. Locks the fix: a regression
    // dropping it back to 5000ms would fail this test.
    mockExec.mockReturnValueOnce('').mockReturnValueOnce('77777\n');

    const server = new SafariPilotServer(DEFAULT_CONFIG);
    await callEnsureSessionWindow(server);

    // Second call (make new document) — inspect the options object.
    const secondCallOpts = mockExec.mock.calls[1]![1] as { timeout?: number };
    expect(
      secondCallOpts?.timeout,
      'make new document timeout must be 15s (SD-21); ' +
        `got ${secondCallOpts?.timeout}ms`,
    ).toBe(15_000);
  });

  it('SD-21 (b): cleanup failure does NOT block new-window creation (best-effort)', async () => {
    // First call (cleanup) throws → the SUT swallows it and proceeds.
    // Second call (make new document) succeeds with a valid id.
    mockExec
      .mockImplementationOnce(() => {
        throw new Error('osascript: cleanup failed');
      })
      .mockReturnValueOnce('88888\n');

    const server = new SafariPilotServer(DEFAULT_CONFIG);
    await callEnsureSessionWindow(server);

    expect(
      server.getSessionWindowId(),
      'cleanup failure must NOT block new-window creation; ' +
        'the next start would then fail with no window id',
    ).toBe(88888);
    expect(mockExec.mock.calls.length).toBe(2);
  });
});
