import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { BaseEngine } from './engine.js';
import type { Engine, EngineResult } from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
let _idCounter = 0;

class DaemonTimeoutError extends Error {
  constructor(method: string, timeout: number) {
    super(`Daemon command "${method}" timed out after ${timeout}ms`);
    this.name = 'DaemonTimeoutError';
  }
}

function nextId(): string {
  return `req-${Date.now()}-${++_idCounter}`;
}

interface PendingRequest {
  resolve: (value: DaemonResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DaemonResponse {
  id?: string;
  ok: boolean;
  value?: string;
  error?: { code?: string; message?: string };
}

export class DaemonEngine extends BaseEngine {
  readonly name: Engine = 'daemon';

  private proc: ChildProcess | null = null;
  private pending: Map<string, PendingRequest> = new Map();
  private daemonPath: string;
  private reconnectAttempted = false;
  private shuttingDown = false;

  constructor(daemonPath?: string) {
    super();
    this.daemonPath = daemonPath
      ?? process.env['SAFARI_PILOT_DAEMON']
      ?? './bin/SafariPilotd';
  }

  // ── Public interface ────────────────────────────────────────────────────────

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureRunning();
      const response = await this.sendCommand('ping', {});
      return response.ok === true && response.value === 'pong';
    } catch {
      return false;
    }
  }

  async execute(script: string, timeout: number = DEFAULT_TIMEOUT_MS): Promise<EngineResult> {
    const start = Date.now();
    try {
      await this.ensureRunning();
      const response = await this.sendCommand('execute', { script }, timeout);
      if (response.ok) {
        return {
          ok: true,
          value: response.value,
          elapsed_ms: Date.now() - start,
        };
      }
      return {
        ok: false,
        error: {
          code: response.error?.code ?? 'DAEMON_ERROR',
          message: response.error?.message ?? 'Daemon returned an error',
          retryable: true,
        },
        elapsed_ms: Date.now() - start,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // DaemonTimeoutError is a tagged subclass so we can identify it precisely
      const isTimeout = err instanceof DaemonTimeoutError;
      return {
        ok: false,
        error: {
          code: isTimeout ? 'TIMEOUT' : 'DAEMON_ERROR',
          message: msg,
          retryable: true,
        },
        elapsed_ms: Date.now() - start,
      };
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.proc && !this.proc.killed) {
      // Best-effort graceful shutdown command
      try {
        if (this.proc.stdin?.writable) {
          this.proc.stdin.write(JSON.stringify({ method: 'shutdown' }) + '\n');
        }
      } catch {
        // ignore write errors during shutdown
      }
      this.proc.kill('SIGTERM');
    }
    this._rejectAllPending(new Error('DaemonEngine is shutting down'));
    this.proc = null;
  }

  // ── Private: process lifecycle ───────────────────────────────────────────

  private async ensureRunning(): Promise<void> {
    if (this.proc && !this.proc.killed) {
      return;
    }
    this.spawnDaemon();
  }

  private spawnDaemon(): void {
    const proc = spawn(this.daemonPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc = proc;
    this.reconnectAttempted = false;

    // Parse NDJSON lines from stdout using manual line buffering.
    // Using raw `data` events (not readline) so the code works with both
    // real Readable streams and the EventEmitter-based mocks used in tests.
    let lineBuffer = '';
    proc.stdout!.on('data', (chunk: Buffer | string) => {
      lineBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let newlineIdx: number;
      while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIdx).trim();
        lineBuffer = lineBuffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as DaemonResponse;
          this._dispatchResponse(msg);
        } catch {
          // Malformed JSON line — ignore
        }
      }
    });

    // Handle process exit: reject all pending requests
    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.shuttingDown) return;

      const reason = `Daemon exited with code=${code ?? 'null'} signal=${signal ?? 'none'}`;
      this._rejectAllPending(new Error(reason));

      // Auto-reconnect once
      if (!this.reconnectAttempted) {
        this.reconnectAttempted = true;
        this.proc = null;
        // Don't auto-spawn here — let the next ensureRunning() call do it
        // to avoid infinite respawn loops
      } else {
        this.proc = null;
      }
    });

    proc.on('error', (err: Error) => {
      this._rejectAllPending(err);
      this.proc = null;
    });
  }

  // ── Private: request/response ────────────────────────────────────────────

  private sendCommand(
    method: string,
    params: Record<string, unknown>,
    timeout: number = DEFAULT_TIMEOUT_MS,
  ): Promise<DaemonResponse> {
    const id = nextId();
    const payload = JSON.stringify({ id, method, params }) + '\n';

    return new Promise<DaemonResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonTimeoutError(method, timeout));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      if (!this.proc || !this.proc.stdin?.writable) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Daemon process is not running or stdin is closed'));
        return;
      }

      this.proc.stdin.write(payload);
    });
  }

  private _dispatchResponse(msg: DaemonResponse): void {
    if (!msg.id) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    pending.resolve(msg);
  }

  private _rejectAllPending(reason: Error): void {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(reason);
      this.pending.delete(id);
    }
  }
}
