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

/** Invoke the private ensureSessionWindow in a type-safe cast. */
async function callEnsureSessionWindow(server: SafariPilotServer): Promise<void> {
  await (server as unknown as { ensureSessionWindow: (id: string) => Promise<void> })
    .ensureSessionWindow('test-trace');
}

/** Peek at the private _sessionWindowId field. */
function peekWindowId(server: SafariPilotServer): number | undefined {
  return (server as unknown as { _sessionWindowId: number | undefined })._sessionWindowId;
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
    expect(peekWindowId(server)).toBe(12345);
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
    expect(peekWindowId(server), '_sessionWindowId must stay undefined on failure').toBeUndefined();
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
    expect(peekWindowId(server)).toBeUndefined();
  });

  it('no-ops (does not re-throw) when _sessionWindowId is already set', async () => {
    // Pre-condition: window already created in a prior call. ensureSessionWindow
    // must return without touching execSync.
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    (server as unknown as { _sessionWindowId: number })._sessionWindowId = 999;
    await callEnsureSessionWindow(server);
    expect(mockExec).not.toHaveBeenCalled();
    expect(peekWindowId(server)).toBe(999);
  });
});
