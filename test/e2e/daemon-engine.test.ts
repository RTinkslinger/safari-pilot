/**
 * Daemon Engine E2E Tests
 *
 * Tests the daemon NDJSON protocol DIRECTLY — not through MCP.
 * Spawns bin/SafariPilotd, sends JSON lines on stdin, reads JSON lines from stdout.
 *
 * Zero mocks. Zero source imports. Real process, real NDJSON.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const DAEMON_PATH = join(import.meta.dirname, '../../bin/SafariPilotd');

/** Minimal NDJSON client for the daemon — no source imports, just raw stdio. */
class DaemonTestClient {
  private proc: ChildProcess;
  private buffer = '';
  private pending = new Map<string, {
    resolve: (data: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private idCounter = 0;

  constructor(daemonPath: string) {
    this.proc = spawn(daemonPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg['id'] as string | undefined;
          if (id && this.pending.has(id)) {
            const entry = this.pending.get(id)!;
            clearTimeout(entry.timer);
            this.pending.delete(id);
            entry.resolve(msg);
          }
        } catch { /* skip non-JSON */ }
      }
    });
  }

  nextId(): string {
    return `test-${++this.idCounter}`;
  }

  send(msg: Record<string, unknown>, timeoutMs = 15000): Promise<Record<string, unknown>> {
    const id = msg['id'] as string;
    if (!id) throw new Error('Message must have an id');

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Daemon response timeout (${timeoutMs}ms) for id=${id}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  async close(): Promise<void> {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Client closed'));
    }
    this.pending.clear();

    // Send shutdown command before killing
    try {
      this.proc.stdin!.write(JSON.stringify({ method: 'shutdown' }) + '\n');
    } catch { /* ignore */ }

    this.proc.kill('SIGTERM');
    return new Promise((resolve) => {
      this.proc.on('close', () => resolve());
      setTimeout(resolve, 3000);
    });
  }
}

describe.skipIf(!existsSync(DAEMON_PATH))('Daemon Engine — NDJSON Protocol', () => {
  let daemon: DaemonTestClient;

  beforeAll(() => {
    daemon = new DaemonTestClient(DAEMON_PATH);
  }, 15000);

  afterAll(async () => {
    if (daemon) await daemon.close();
  });

  it('daemon responds to ping with pong', async () => {
    const id = daemon.nextId();
    const resp = await daemon.send({ id, method: 'ping', params: {} });

    expect(resp['ok']).toBe(true);
    expect(resp['value']).toBe('pong');
    expect(resp['id']).toBe(id);
  }, 15000);

  it('daemon executes simple AppleScript', async () => {
    const id = daemon.nextId();
    const resp = await daemon.send({
      id,
      method: 'execute',
      params: { script: 'tell application "Safari" to return name' },
    });

    expect(resp['ok']).toBe(true);
    expect(resp['id']).toBe(id);
    // Safari's application name is "Safari"
    expect(typeof resp['value']).toBe('string');
    expect((resp['value'] as string)).toContain('Safari');
  }, 15000);

  it('daemon returns error for invalid script', async () => {
    const id = daemon.nextId();
    const resp = await daemon.send({
      id,
      method: 'execute',
      params: { script: 'this is not valid applescript at all' },
    });

    expect(resp['ok']).toBe(false);
    expect(resp['id']).toBe(id);
    expect(resp['error']).toBeDefined();
    const error = resp['error'] as Record<string, unknown>;
    expect(error['message']).toBeDefined();
    expect(typeof error['message']).toBe('string');
  }, 15000);

  it('daemon handles concurrent requests', async () => {
    const id1 = daemon.nextId();
    const id2 = daemon.nextId();
    const id3 = daemon.nextId();

    // Send 3 pings simultaneously
    const [resp1, resp2, resp3] = await Promise.all([
      daemon.send({ id: id1, method: 'ping', params: {} }),
      daemon.send({ id: id2, method: 'ping', params: {} }),
      daemon.send({ id: id3, method: 'ping', params: {} }),
    ]);

    // All three should succeed and be routed to the correct request by ID
    expect(resp1['ok']).toBe(true);
    expect(resp1['value']).toBe('pong');
    expect(resp1['id']).toBe(id1);

    expect(resp2['ok']).toBe(true);
    expect(resp2['value']).toBe('pong');
    expect(resp2['id']).toBe(id2);

    expect(resp3['ok']).toBe(true);
    expect(resp3['value']).toBe('pong');
    expect(resp3['id']).toBe(id3);
  }, 15000);
});
