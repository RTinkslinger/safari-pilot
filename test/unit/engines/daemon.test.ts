/**
 * T9 — DaemonEngine must reset `useTcp` on TCP timeout and TCP parse failure.
 *
 * Pre-T9: `sendCommandViaTcp()` only reset `useTcp = false` on socket 'error'.
 * Timeouts and JSON parse failures left useTcp=true, so every subsequent
 * command routed through the same dead TCP endpoint and hit the same
 * failure mode — no fallback to a spawned local daemon was possible.
 *
 * This test pattern is the first `vi.mock('node:net', ...)` in the codebase.
 * It establishes the Node-boundary mock shape for T11/T12's future unit
 * tests: mock the external Node API (net, child_process, fs), leave every
 * internal module untouched, assert against real DaemonEngine behavior.
 *
 * Per CLAUDE.md "Unit Tests (HARD RULES)": mocking `node:net` is allowed;
 * mocking `DaemonEngine` or any other internal module is not.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:net', () => ({
  createConnection: vi.fn(),
}));

import { createConnection } from 'node:net';
import { DaemonEngine } from '../../../src/engines/daemon.js';

type MockSocket = EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  setTimeout: ReturnType<typeof vi.fn>;
};

function makeSocket(): MockSocket {
  const sock = new EventEmitter() as MockSocket;
  sock.write = vi.fn();
  sock.destroy = vi.fn();
  sock.setTimeout = vi.fn();
  return sock;
}

/** Peek at the private useTcp flag. Reading internal state is allowed by
 *  the boundary policy (only mocking internals is forbidden). */
function peekUseTcp(engine: DaemonEngine): boolean {
  return (engine as unknown as { useTcp: boolean }).useTcp;
}

/**
 * Drive the probe + command flow. Returns the command's Promise alongside
 * the two sockets it used, so tests can inspect state between the two
 * phases.
 *
 *   probe   — tryTcpConnection's socket. Fires 'connect' via the callback
 *             arg and responds `{ok:true}`.
 *   command — sendCommandViaTcp's socket. The test controls its lifecycle
 *             (timeout, parse error, socket error) by choosing what to
 *             emit on it.
 */
function mockNetTwoPhase(
  onCommandSocket: (sock: MockSocket) => void,
): { probe: MockSocket; commandFromMock: Promise<MockSocket> } {
  const probe = makeSocket();
  let cmdResolve!: (s: MockSocket) => void;
  const commandFromMock = new Promise<MockSocket>((r) => { cmdResolve = r; });

  let call = 0;
  (createConnection as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (_opts: unknown, onConnect?: () => void) => {
      call++;
      if (call === 1) {
        // Phase 1: probe. tryTcpConnection passes an onConnect callback.
        queueMicrotask(() => {
          if (onConnect) onConnect();
          // onConnect registers the 'data' listener synchronously inside its
          // body. Now we can safely emit data on the next microtask.
          queueMicrotask(() => {
            probe.emit('data', Buffer.from(JSON.stringify({ id: 'tcp-probe', ok: true }) + '\n'));
          });
        });
        return probe;
      }
      // Phase 2: command socket. sendCommandViaTcp uses a 'connect' event,
      // not a callback — fire it async and let the test drive what happens
      // next by inspecting or emitting on the returned socket.
      const cmd = makeSocket();
      queueMicrotask(() => onCommandSocket(cmd));
      cmdResolve(cmd);
      return cmd;
    },
  );

  return { probe, commandFromMock };
}

describe('DaemonEngine (T9): useTcp reset on TCP failures', () => {
  beforeEach(() => {
    (createConnection as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it('enters TCP mode when the initial probe succeeds', async () => {
    // Command socket: never resolves — we'll time out intentionally so the
    // command rejects, but the useTcp=true observation happens FIRST.
    mockNetTwoPhase(() => { /* leave hanging */ });

    const engine = new DaemonEngine({ daemonPath: '/nonexistent', tcpPort: 19474 });
    // Short timeout — the command will fail after 100ms, but we observe
    // useTcp=true before the timeout fires.
    const cmdPromise = engine.command('ping', {}, 100).catch(() => undefined);

    // Wait long enough for the probe to complete (microtask chain) but
    // shorter than the command timeout.
    await new Promise((r) => setTimeout(r, 50));
    expect(peekUseTcp(engine), 'useTcp must be true after successful TCP probe').toBe(true);
    await cmdPromise;
  }, 10000);

  it('resets useTcp=false when a TCP command times out (T9 timeout path)', async () => {
    // Command socket: connect but never emit data → engine hits its own
    // setTimeout and the timeout branch runs.
    mockNetTwoPhase((cmd) => { cmd.emit('connect'); /* no data, ever */ });

    const engine = new DaemonEngine({ daemonPath: '/nonexistent', tcpPort: 19474 });
    const result = await engine.command('slowMethod', {}, 150);
    expect(result.ok, 'command must report failure after timeout').toBe(false);
    // Before the fix this was still true; the whole point of T9.
    expect(peekUseTcp(engine), 'useTcp must be reset to false after a TCP timeout').toBe(false);
  }, 10000);

  it('resets useTcp=false when the TCP response is unparseable (T9 parse path)', async () => {
    mockNetTwoPhase((cmd) => {
      cmd.emit('connect');
      queueMicrotask(() => cmd.emit('data', Buffer.from('garbage-not-json\n')));
    });

    const engine = new DaemonEngine({ daemonPath: '/nonexistent', tcpPort: 19474 });
    const result = await engine.command('anyMethod', {}, 1000);
    expect(result.ok, 'command must report failure on invalid JSON').toBe(false);
    expect(peekUseTcp(engine), 'useTcp must be reset to false after a TCP parse failure').toBe(false);
  });

  it('still resets useTcp=false on socket error (pre-T9 behavior preserved)', async () => {
    mockNetTwoPhase((cmd) => cmd.emit('error', new Error('ECONNRESET')));

    const engine = new DaemonEngine({ daemonPath: '/nonexistent', tcpPort: 19474 });
    const result = await engine.command('anyMethod', {}, 1000);
    expect(result.ok).toBe(false);
    expect(peekUseTcp(engine)).toBe(false);
  });
});
