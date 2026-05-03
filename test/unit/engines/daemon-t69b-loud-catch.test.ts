/**
 * T69b — DaemonEngine must log (not silently drop) two diagnostic-blind paths:
 *
 *   1. stdout JSON.parse failure — pre-fix `catch {}` swallowed malformed
 *      daemon output (process noise, stderr→stdout leak, partial chunks
 *      under load). The matching pending request would silently time out
 *      with no log line to triage.
 *
 *   2. _dispatchResponse receiving a response whose id has no matching
 *      pending entry. The daemon emits `id: "unknown"` for parse errors
 *      (CommandDispatcher.swift:117) — pre-fix this was silently returned
 *      from _dispatchResponse, so the originating pending request waited
 *      until its timeout with no signal that the daemon had explicitly
 *      reported a parse failure.
 *
 * The corresponding daemon-side TCP truncation that triggers (2) in
 * production is fixed separately as T69a.
 *
 * Per CLAUDE.md "Unit Tests (HARD RULES)": mocks node:net and node:child_process
 * (Node boundaries) — leaves DaemonEngine itself untouched.
 *
 * Same vi.doMock + resetModules + dynamic-import pattern as
 * test/unit/engines/daemon.test.ts (singleFork shared cache).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

let createConnection: ReturnType<typeof vi.fn>;
let spawn: ReturnType<typeof vi.fn>;
type DaemonEngineCtor = new (opts: { daemonPath: string; tcpPort: number; timeoutMs?: number }) => {
  command: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<{ ok: boolean }>;
  isTcpMode: () => boolean;
};
let DaemonEngine: DaemonEngineCtor;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock('node:net', () => ({
    createConnection: vi.fn(),
  }));
  vi.doMock('node:child_process', () => ({
    spawn: vi.fn(),
  }));
  const netMod = await import('node:net');
  const cpMod = await import('node:child_process');
  createConnection = netMod.createConnection as unknown as ReturnType<typeof vi.fn>;
  spawn = cpMod.spawn as unknown as ReturnType<typeof vi.fn>;
  const daemonMod = await import('../../../src/engines/daemon.js');
  DaemonEngine = daemonMod.DaemonEngine as unknown as DaemonEngineCtor;
});

type MockSocket = EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
};

type MockProc = EventEmitter & {
  stdin: { writable: boolean; write: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  pid: number;
  kill: ReturnType<typeof vi.fn>;
};

function makeProc(): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdin = { writable: true, write: vi.fn() };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.pid = 12345;
  proc.kill = vi.fn();
  return proc;
}

function makeFailingProbeSocket(): MockSocket {
  const sock = new EventEmitter() as MockSocket;
  sock.write = vi.fn();
  sock.destroy = vi.fn();
  sock.setTimeout = vi.fn();
  // Fail TCP probe so DaemonEngine falls back to stdio (the path under test).
  queueMicrotask(() => sock.emit('error', new Error('TCP unreachable in test')));
  return sock;
}

describe('T69b — DaemonEngine logs diagnostic info instead of silently dropping', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let proc: MockProc;

  beforeEach(() => {
    createConnection.mockReset();
    spawn.mockReset();
    createConnection.mockImplementation(() => makeFailingProbeSocket());
    proc = makeProc();
    spawn.mockReturnValue(proc);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /**
   * Drives DaemonEngine into stdio mode, lets the engine register stdout
   * listeners, then returns the proc and the still-pending command promise.
   */
  async function pendingStdioCommand(): Promise<{ cmdPromise: Promise<{ ok: boolean }>; proc: MockProc }> {
    const engine = new DaemonEngine({ daemonPath: '/nonexistent', tcpPort: 19474, timeoutMs: 1000 });
    const cmdPromise = engine.command('test', {}, 800);
    // Wait for the TCP probe to fail and spawnDaemon() to register stdout handler.
    await new Promise((r) => setTimeout(r, 50));
    return { cmdPromise, proc };
  }

  it('logs warning with byte length and truncated content when stdout emits malformed JSON', async () => {
    const { cmdPromise } = await pendingStdioCommand();

    // Emit a malformed line (truncated JSON like the production T69a flake produces).
    const malformed = '{"id":"req-123","method":"execute","params":{"script":"document.querySelector';
    proc.stdout.emit('data', Buffer.from(malformed + '\n'));

    // Behavior under test: console.warn was called with the prescribed shape.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('malformed JSON line dropped');
    expect(message).toContain(`${malformed.length} bytes`);
    expect(message).toContain('reason="');
    // Truncation marker is only added when length > 200; this line is shorter.
    expect(message).toContain(malformed);

    // Don't leave the command hanging — fail it explicitly.
    proc.emit('exit', 1, null);
    const failed = await cmdPromise;
    expect(failed.ok).toBe(false);
  });

  it('truncates very long malformed lines to ≤200 chars + ellipsis in the warning', async () => {
    const { cmdPromise } = await pendingStdioCommand();

    // 500-char malformed line — should be truncated in the log.
    const longMalformed = '{"x":"' + 'a'.repeat(500) + '<<NEVER_LOGGED>>';
    proc.stdout.emit('data', Buffer.from(longMalformed + '\n'));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('truncated');
    expect(message).not.toContain('<<NEVER_LOGGED>>');
    // Byte-count is still the full length (so operators see real size).
    expect(message).toContain(`${longMalformed.length} bytes`);

    proc.emit('exit', 1, null);
    const failed = await cmdPromise;
    expect(failed.ok).toBe(false);
  });

  it('logs warning when daemon emits a response with id="unknown" (parse-error sentinel)', async () => {
    const { cmdPromise } = await pendingStdioCommand();

    // The daemon's CommandDispatcher.swift:117 emits this exact shape on parse failure.
    const orphan = JSON.stringify({
      id: 'unknown',
      ok: false,
      error: { code: 'PARSE_ERROR', message: 'Failed to parse command: invalidJSON' },
    });
    proc.stdout.emit('data', Buffer.from(orphan + '\n'));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toContain('id="unknown"');
    expect(message).toContain('matches no pending request');
    expect(message).toContain('PARSE_ERROR');

    proc.emit('exit', 1, null);
    const failed = await cmdPromise;
    expect(failed.ok).toBe(false);
  });

  it('does NOT log when stdout emits a valid response that resolves a pending request', async () => {
    const engine = new DaemonEngine({ daemonPath: '/nonexistent', tcpPort: 19474, timeoutMs: 1000 });
    const cmdPromise = engine.command('test', {}, 800);
    await new Promise((r) => setTimeout(r, 50));

    // Recover the id the engine wrote to stdin so we can match it.
    const stdinWriteCall = proc.stdin.write.mock.calls[0]?.[0] as string | undefined;
    expect(stdinWriteCall, 'engine should have written a command to stdin').toBeDefined();
    const sent = JSON.parse(stdinWriteCall!.trim()) as { id: string };

    // Emit the matching valid response.
    const valid = JSON.stringify({ id: sent.id, ok: true, value: 'pong', elapsedMs: 1 });
    proc.stdout.emit('data', Buffer.from(valid + '\n'));

    const result = await cmdPromise;
    expect(result.ok).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('handles malformed line followed by valid line — logs once, then dispatches valid', async () => {
    const engine = new DaemonEngine({ daemonPath: '/nonexistent', tcpPort: 19474, timeoutMs: 1000 });
    const cmdPromise = engine.command('test', {}, 800);
    await new Promise((r) => setTimeout(r, 50));

    const stdinWriteCall = proc.stdin.write.mock.calls[0]?.[0] as string | undefined;
    const sent = JSON.parse(stdinWriteCall!.trim()) as { id: string };

    // First emit malformed (should warn). Then emit the matching valid response.
    const malformed = '{"id":"unrelated","method":"oops","params":';
    const valid = JSON.stringify({ id: sent.id, ok: true, value: 'pong', elapsedMs: 1 });
    proc.stdout.emit('data', Buffer.from(malformed + '\n' + valid + '\n'));

    const result = await cmdPromise;
    expect(result.ok).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0] as string).toContain('malformed JSON line dropped');
  });
});
