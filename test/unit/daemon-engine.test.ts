import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// ── Mock node:child_process before importing DaemonEngine ──────────────────

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// ── Fake process factory ────────────────────────────────────────────────────

interface FakeStdin extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  writable: boolean;
}

interface FakeProcess extends EventEmitter {
  stdin: FakeStdin;
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid: number;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
}

function makeFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.pid = 12345;
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
    proc.emit('exit', 0, null);
  });

  const stdin = new EventEmitter() as FakeStdin;
  stdin.write = vi.fn();
  stdin.end = vi.fn();
  stdin.writable = true;
  proc.stdin = stdin;

  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

// ── Helper: emit a response line on proc.stdout ─────────────────────────────

function emitLine(proc: FakeProcess, obj: unknown): void {
  proc.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('DaemonEngine', () => {
  let spawnMock: ReturnType<typeof vi.fn>;
  let fakeProc: FakeProcess;

  beforeEach(async () => {
    vi.resetAllMocks();
    fakeProc = makeFakeProcess();

    const mod = await import('node:child_process');
    spawnMock = mod.spawn as ReturnType<typeof vi.fn>;
    spawnMock.mockReturnValue(fakeProc as unknown as ChildProcess);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: name ──────────────────────────────────────────────────────────
  it('has name "daemon"', async () => {
    const { DaemonEngine } = await import('../../src/engines/daemon.js');
    const engine = new DaemonEngine('/fake/path/SafariPilotd');
    expect(engine.name).toBe('daemon');
  });

  // ── Test 2: sends NDJSON command and parses response ──────────────────────
  it('sends NDJSON command and parses response', async () => {
    const { DaemonEngine } = await import('../../src/engines/daemon.js');
    const engine = new DaemonEngine('/fake/path/SafariPilotd');

    // Intercept stdin.write so we can capture the request and reply
    fakeProc.stdin.write.mockImplementation((data: string) => {
      const req = JSON.parse(data.trim());
      // Echo back a success response matching the request ID
      setImmediate(() => emitLine(fakeProc, { id: req.id, ok: true, value: 'result-value' }));
      return true;
    });

    const result = await engine.execute('tell application "Safari" to return 1');

    expect(result.ok).toBe(true);
    expect(result.value).toBe('result-value');
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    // Verify the written payload is valid NDJSON with the right method
    const [writtenData] = fakeProc.stdin.write.mock.calls[0] as [string];
    const parsed = JSON.parse(writtenData.trim());
    expect(parsed.method).toBe('execute');
    expect(parsed.params.script).toBe('tell application "Safari" to return 1');
  });

  // ── Test 3: handles timeout when daemon doesn't respond ───────────────────
  it('handles timeout when daemon does not respond', async () => {
    const { DaemonEngine } = await import('../../src/engines/daemon.js');
    const engine = new DaemonEngine('/fake/path/SafariPilotd');

    // stdin.write does nothing — response never arrives
    fakeProc.stdin.write.mockReturnValue(true);

    const result = await engine.execute('some script', 50); // 50ms timeout

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TIMEOUT');
    expect(result.error?.retryable).toBe(true);
  }, 2000);

  // ── Test 4: isAvailable returns false when spawn fails ────────────────────
  it('isAvailable returns false when spawn throws', async () => {
    const { DaemonEngine } = await import('../../src/engines/daemon.js');
    spawnMock.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });

    const engine = new DaemonEngine('/nonexistent/SafariPilotd');
    const available = await engine.isAvailable();
    expect(available).toBe(false);
  });

  // ── Test 5: matches responses to requests by ID ───────────────────────────
  it('matches responses to the correct request by ID', async () => {
    const { DaemonEngine } = await import('../../src/engines/daemon.js');
    const engine = new DaemonEngine('/fake/path/SafariPilotd');

    // Capture all written requests so we can match IDs, then reply in reverse order
    const written: Array<{ id: string; method: string; params: { script: string } }> = [];

    fakeProc.stdin.write.mockImplementation((data: string) => {
      const req = JSON.parse(data.trim()) as { id: string; method: string; params: { script: string } };
      written.push(req);

      // When both requests have arrived, respond in reverse order (cross-match test)
      if (written.length === 2) {
        setImmediate(() => {
          emitLine(fakeProc, { id: written[1]!.id, ok: true, value: 'second' });
          emitLine(fakeProc, { id: written[0]!.id, ok: true, value: 'first' });
        });
      }
      return true;
    });

    // Fire two concurrent executions — they share the same process
    const [r1, r2] = await Promise.all([
      engine.execute('script one'),
      engine.execute('script two'),
    ]);

    expect(r1.ok).toBe(true);
    expect(r1.value).toBe('first');
    expect(r2.ok).toBe(true);
    expect(r2.value).toBe('second');
  }, 10_000);

  // ── Test 6: handles daemon process exit ───────────────────────────────────
  it('handles daemon process exit and marks pending requests as failed', async () => {
    const { DaemonEngine } = await import('../../src/engines/daemon.js');
    const engine = new DaemonEngine('/fake/path/SafariPilotd');

    // stdin.write triggers process exit without responding
    fakeProc.stdin.write.mockImplementation(() => {
      setImmediate(() => fakeProc.emit('exit', 1, null));
      return true;
    });

    const result = await engine.execute('some script', 5000);
    expect(result.ok).toBe(false);
    // Process exit should result in an error (daemon crashed or was killed)
    expect(result.error).toBeDefined();
  });

  // ── Test 7: isAvailable returns true when ping succeeds ───────────────────
  it('isAvailable returns true when ping returns pong', async () => {
    const { DaemonEngine } = await import('../../src/engines/daemon.js');
    const engine = new DaemonEngine('/fake/path/SafariPilotd');

    fakeProc.stdin.write.mockImplementation((data: string) => {
      const req = JSON.parse(data.trim());
      if (req.method === 'ping') {
        setImmediate(() => emitLine(fakeProc, { id: req.id, ok: true, value: 'pong' }));
      }
      return true;
    });

    const available = await engine.isAvailable();
    expect(available).toBe(true);
  });

  // ── Test 8: shutdown sends shutdown command and kills process ─────────────
  it('shutdown sends shutdown command and cleans up process', async () => {
    const { DaemonEngine } = await import('../../src/engines/daemon.js');
    const engine = new DaemonEngine('/fake/path/SafariPilotd');

    // First trigger ensureRunning by starting any operation
    fakeProc.stdin.write.mockReturnValue(true);

    // Force the engine to spawn by calling ensureRunning via isAvailable (with no response — timeout)
    // Instead, let's call execute with a very short timeout just to get the process spawned
    // We intercept write for the ping in isAvailable context
    let pinged = false;
    fakeProc.stdin.write.mockImplementation((data: string) => {
      const req = JSON.parse(data.trim());
      if (req.method === 'ping' && !pinged) {
        pinged = true;
        setImmediate(() => emitLine(fakeProc, { id: req.id, ok: true, value: 'pong' }));
      }
      return true;
    });

    await engine.isAvailable(); // spawns process
    await engine.shutdown();

    // After shutdown the process should be killed
    expect(fakeProc.kill).toHaveBeenCalled();
  });
});
