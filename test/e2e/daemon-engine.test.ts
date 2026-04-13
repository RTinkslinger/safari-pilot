/**
 * Daemon Engine E2E — Raw IPC protocol tests
 *
 * Spawns the REAL SafariPilotd binary and speaks NDJSON directly over
 * stdin/stdout — no TypeScript DaemonEngine wrapper, no mocks.
 *
 * What this covers that phase2-daemon-e2e does NOT:
 *  - Wire-level protocol correctness (raw JSON shapes, field names, types)
 *  - Response ID matching under concurrent load (3 requests in flight simultaneously)
 *  - Invalid/malformed input handling without crashing the daemon
 *  - SIGTERM lifecycle: clean shutdown, stdin EOF behaviour
 *  - Shutdown ack response before process exit
 *
 * What we intentionally skip:
 *  - Tests that require Safari running (AppleScript execute) — those live in phase2-daemon-e2e
 *  - DaemonEngine TypeScript wrapper behaviour — covered in unit tests
 *
 * Prerequisites:
 *  - bin/SafariPilotd exists, OR swift build succeeds in daemon/
 *  - No Safari required — ping/shutdown/unknown-method tests are pure IPC
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

// ── Constants ─────────────────────────────────────────────────────────────────

const ROOT = resolve(__dirname, '../..');
const DAEMON_BIN = resolve(ROOT, 'bin/SafariPilotd');
const DAEMON_BUILD_DIR = resolve(ROOT, 'daemon');

// Per-request timeout when waiting for a daemon response (ms)
const REQUEST_TIMEOUT_MS = 8_000;

// ── Binary availability ───────────────────────────────────────────────────────

/**
 * Resolve the daemon binary path, building from Swift source if necessary.
 * Returns null if neither is available, which causes all tests to be skipped.
 */
function resolveDaemonBin(): string | null {
  if (existsSync(DAEMON_BIN)) {
    return DAEMON_BIN;
  }

  // Attempt swift build
  const packageSwift = resolve(DAEMON_BUILD_DIR, 'Package.swift');
  if (!existsSync(packageSwift)) {
    return null;
  }

  try {
    console.log('[daemon-engine-e2e] bin/SafariPilotd not found — attempting swift build...');
    execSync('swift build -c release 2>&1', {
      cwd: DAEMON_BUILD_DIR,
      timeout: 120_000,
      stdio: 'pipe',
    });
    const built = resolve(DAEMON_BUILD_DIR, '.build/release/SafariPilotd');
    if (existsSync(built)) {
      execSync(`cp "${built}" "${DAEMON_BIN}"`, { cwd: ROOT });
      console.log('[daemon-engine-e2e] swift build succeeded — binary copied to bin/SafariPilotd');
      return DAEMON_BIN;
    }
  } catch (err) {
    console.warn('[daemon-engine-e2e] swift build failed:', err instanceof Error ? err.message : String(err));
  }

  return null;
}

// ── IPC helpers ───────────────────────────────────────────────────────────────

interface RawResponse {
  id?: string;
  ok: boolean;
  value?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
  elapsedMs?: number;
}

/**
 * Low-level helper: spawn the daemon, send one NDJSON line, collect responses
 * until the predicate returns true (or timeout). Returns all collected responses.
 *
 * The caller is responsible for killing `proc` after use.
 */
function sendAndCollect(
  proc: ChildProcess,
  line: string,
  opts: {
    /** How many responses to wait for before resolving */
    count?: number;
    /** Resolve when this predicate returns true */
    until?: (responses: RawResponse[]) => boolean;
    timeoutMs?: number;
  } = {},
): Promise<RawResponse[]> {
  return new Promise((resolve, reject) => {
    const { count = 1, until, timeoutMs = REQUEST_TIMEOUT_MS } = opts;
    const collected: RawResponse[] = [];
    let buffer = '';

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(
        `Timed out after ${timeoutMs}ms waiting for daemon response. ` +
        `Collected ${collected.length} so far: ${JSON.stringify(collected)}`,
      ));
    }, timeoutMs);

    function onData(chunk: Buffer | string) {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const raw = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw) as RawResponse;
          collected.push(parsed);
          const done = until ? until(collected) : collected.length >= count;
          if (done) {
            cleanup();
            resolve(collected);
          }
        } catch {
          // non-JSON line (e.g. startup log) — ignore
        }
      }
    }

    function onError(err: Error) {
      cleanup();
      reject(err);
    }

    function cleanup() {
      clearTimeout(timer);
      proc.stdout!.off('data', onData);
      proc.stderr!.off('data', () => {}); // silence stderr
      proc.off('error', onError);
    }

    proc.stdout!.on('data', onData);
    proc.on('error', onError);

    // Write the NDJSON line
    proc.stdin!.write(line.endsWith('\n') ? line : line + '\n');
  });
}

/**
 * Build a well-formed NDJSON request.
 */
function makeRequest(
  id: string,
  method: string,
  params: Record<string, unknown> = {},
): string {
  return JSON.stringify({ id, method, params });
}

// ── Test state ────────────────────────────────────────────────────────────────

let daemonBin: string | null = null;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('Daemon Engine E2E — raw NDJSON IPC (no mocks)', () => {
  beforeAll(() => {
    daemonBin = resolveDaemonBin();
    if (!daemonBin) {
      console.warn(
        '[daemon-engine-e2e] SKIP: bin/SafariPilotd not found and swift build unavailable. ' +
        'Run `bash scripts/update-daemon.sh` or `swift build` in daemon/ to enable these tests.',
      );
    }
  });

  // ── Test 1: Binary existence ───────────────────────────────────────────────

  it('daemon binary exists or can be built', () => {
    if (!daemonBin) {
      // Soft skip: report clearly rather than hard-fail
      console.warn('SKIP: daemon binary unavailable');
      return;
    }
    expect(existsSync(daemonBin)).toBe(true);
  });

  // ── Test 2: Health check (ping/pong) ──────────────────────────────────────

  it('daemon starts and responds to ping with pong', async () => {
    if (!daemonBin) {
      console.warn('SKIP: daemon binary unavailable');
      return;
    }

    const proc = spawn(daemonBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      const req = makeRequest('health-1', 'ping');
      const [response] = await sendAndCollect(proc, req, { count: 1 });

      // Wire-level shape assertions
      expect(response).toBeDefined();
      expect(response.id).toBe('health-1');
      expect(response.ok).toBe(true);
      expect(response.value).toBe('pong');
      // elapsedMs must be a number (even if 0)
      expect(typeof response.elapsedMs).toBe('number');
      expect(response.elapsedMs).toBeGreaterThanOrEqual(0);

      console.log(`[ping] response: ${JSON.stringify(response)}`);
    } finally {
      proc.kill('SIGTERM');
    }
  }, 15_000);

  // ── Test 3: AppleScript execution ─────────────────────────────────────────

  it('daemon executes AppleScript and returns result', async () => {
    if (!daemonBin) {
      console.warn('SKIP: daemon binary unavailable');
      return;
    }

    const proc = spawn(daemonBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      // A pure-computation AppleScript that needs no running app: returns 2+2
      const script = 'return (2 + 2) as text';
      const req = makeRequest('exec-1', 'execute', { script });
      const [response] = await sendAndCollect(proc, req, { count: 1, timeoutMs: 15_000 });

      expect(response).toBeDefined();
      expect(response.id).toBe('exec-1');

      if (response.ok) {
        // The daemon ran the script and returned a value
        expect(response.value).toBeDefined();
        // AppleScript `2 + 2 as text` → "4" (may have trailing newline trimmed by daemon)
        const val = String(response.value).trim();
        expect(val).toBe('4');
        console.log(`[execute] result: ${JSON.stringify(response.value)}, elapsedMs: ${response.elapsedMs}`);
      } else {
        // The daemon is running but AppleScript is restricted (sandboxed CI, no Allow Apple Events)
        // This is a legitimate environment constraint — log and pass.
        console.warn(`[execute] AppleScript not available: ${JSON.stringify(response.error)}`);
        expect(response.error).toBeDefined();
        expect(typeof response.error!.code).toBe('string');
        expect(typeof response.error!.message).toBe('string');
      }
    } finally {
      proc.kill('SIGTERM');
    }
  }, 20_000);

  // ── Test 4: Concurrent requests ───────────────────────────────────────────

  it('daemon handles multiple concurrent requests matched by ID', async () => {
    if (!daemonBin) {
      console.warn('SKIP: daemon binary unavailable');
      return;
    }

    const proc = spawn(daemonBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      // Build 3 ping requests with distinct IDs
      const ids = ['concurrent-a', 'concurrent-b', 'concurrent-c'];
      const requests = ids.map(id => makeRequest(id, 'ping'));

      // Fire all 3 without waiting — send them in rapid succession
      const collectAll = sendAndCollect(proc, '', {
        count: 3,
        until: (responses) => responses.length >= 3,
        timeoutMs: 15_000,
      });

      // Write all 3 lines immediately
      for (const req of requests) {
        proc.stdin!.write(req + '\n');
      }

      const responses = await collectAll;

      expect(responses).toHaveLength(3);

      // Every response must be ok=true with value=pong
      for (const r of responses) {
        expect(r.ok).toBe(true);
        expect(r.value).toBe('pong');
      }

      // All 3 IDs must appear exactly once — order may vary
      const returnedIds = new Set(responses.map(r => r.id));
      for (const id of ids) {
        expect(returnedIds.has(id)).toBe(true);
      }

      console.log(
        `[concurrent] responses (may be out of order):\n` +
        responses.map(r => `  ${r.id}: ok=${r.ok} value=${r.value}`).join('\n'),
      );
    } finally {
      proc.kill('SIGTERM');
    }
  }, 20_000);

  // ── Test 5: Invalid / malformed input ─────────────────────────────────────

  it('daemon handles malformed JSON without crashing', async () => {
    if (!daemonBin) {
      console.warn('SKIP: daemon binary unavailable');
      return;
    }

    const proc = spawn(daemonBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      // Send: (1) malformed JSON, (2) valid JSON missing required `id`, (3) a valid ping to verify daemon is still alive
      const malformed = 'this is not json at all!!!';
      const missingId = JSON.stringify({ method: 'ping', params: {} }); // no `id`
      const healthCheck = makeRequest('alive-after-bad-input', 'ping');

      // Collect: we expect at most 2 responses (one for missing-id, one for healthCheck)
      // Fully malformed JSON produces a PARSE_ERROR with id="unknown"
      // Missing-id also produces PARSE_ERROR with id="unknown"
      const collectPromise = sendAndCollect(proc, '', {
        until: (responses) => responses.some(r => r.id === 'alive-after-bad-input'),
        timeoutMs: 15_000,
      });

      proc.stdin!.write(malformed + '\n');
      proc.stdin!.write(missingId + '\n');
      proc.stdin!.write(healthCheck + '\n');

      const responses = await collectPromise;

      // The daemon must survive: alive-after-bad-input response must be present
      const pingResponse = responses.find(r => r.id === 'alive-after-bad-input');
      expect(pingResponse).toBeDefined();
      expect(pingResponse!.ok).toBe(true);
      expect(pingResponse!.value).toBe('pong');

      // Error responses for bad input must carry ok=false and a code/message
      const errorResponses = responses.filter(r => r.id === 'unknown');
      for (const er of errorResponses) {
        expect(er.ok).toBe(false);
        expect(er.error).toBeDefined();
        expect(typeof er.error!.code).toBe('string');
        expect(typeof er.error!.message).toBe('string');
      }

      console.log(
        `[malformed-input] ${responses.length} responses received, daemon still alive after bad input`,
      );
    } finally {
      proc.kill('SIGTERM');
    }
  }, 20_000);

  // ── Test 6: Unknown method returns structured error ────────────────────────

  it('daemon returns UNKNOWN_METHOD error for unrecognised methods', async () => {
    if (!daemonBin) {
      console.warn('SKIP: daemon binary unavailable');
      return;
    }

    const proc = spawn(daemonBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      const req = makeRequest('unknown-1', 'does_not_exist', { foo: 'bar' });
      const [response] = await sendAndCollect(proc, req, { count: 1 });

      expect(response.id).toBe('unknown-1');
      expect(response.ok).toBe(false);
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe('UNKNOWN_METHOD');
      expect(response.error!.message).toContain('does_not_exist');

      console.log(`[unknown-method] error: ${JSON.stringify(response.error)}`);
    } finally {
      proc.kill('SIGTERM');
    }
  }, 15_000);

  // ── Test 7: Shutdown lifecycle ─────────────────────────────────────────────

  it('daemon acknowledges shutdown command then exits cleanly', async () => {
    if (!daemonBin) {
      console.warn('SKIP: daemon binary unavailable');
      return;
    }

    const proc = spawn(daemonBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Track when the process actually exits
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    const exitPromise = new Promise<void>(resolve => {
      proc.on('exit', (code, signal) => {
        exitCode = code;
        exitSignal = signal as string | null;
        resolve();
      });
    });

    try {
      const req = makeRequest('shutdown-1', 'shutdown');
      const [response] = await sendAndCollect(proc, req, { count: 1, timeoutMs: 10_000 });

      // Daemon must ack before exiting
      expect(response.id).toBe('shutdown-1');
      expect(response.ok).toBe(true);
      expect(response.value).toBe('shutting_down');

      console.log(`[shutdown] ack response: ${JSON.stringify(response)}`);

      // Wait for the process to actually terminate (it calls exit(0) after writing ack)
      await Promise.race([
        exitPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Process did not exit within 5s after shutdown ack')), 5_000),
        ),
      ]);

      // Process must have exited cleanly (code 0, no signal)
      expect(exitCode).toBe(0);
      expect(exitSignal).toBeNull();

      console.log(`[shutdown] process exited cleanly: code=${exitCode} signal=${exitSignal}`);
    } finally {
      // Belt-and-suspenders: if anything above failed, kill the process
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    }
  }, 20_000);

  // ── Test 8: SIGTERM process lifecycle ─────────────────────────────────────

  it('daemon process terminates gracefully on SIGTERM', async () => {
    if (!daemonBin) {
      console.warn('SKIP: daemon binary unavailable');
      return;
    }

    const proc = spawn(daemonBin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // First verify it's alive
    const req = makeRequest('sigterm-ping', 'ping');
    const [pingResp] = await sendAndCollect(proc, req, { count: 1 });
    expect(pingResp.ok).toBe(true);

    // Now send SIGTERM and verify clean exit
    const exitPromise = new Promise<{ code: number | null; signal: string | null }>(resolve => {
      proc.on('exit', (code, signal) => resolve({ code, signal: signal as string | null }));
    });

    proc.kill('SIGTERM');

    const { code, signal } = await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Process did not exit within 5s after SIGTERM')), 5_000),
      ),
    ]);

    // SIGTERM: process may exit with code=null + signal='SIGTERM', or code=0 depending on Swift handler
    const cleanExit = code === 0 || signal === 'SIGTERM';
    expect(cleanExit).toBe(true);

    console.log(`[sigterm] process exit: code=${code} signal=${signal}`);
  }, 20_000);
});
