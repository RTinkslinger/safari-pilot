import { spawn } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { BaseEngine } from './engine.js';
import type { Engine, EngineResult } from '../types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DAEMON_TCP_PORT = 19474;
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
  value?: string | Record<string, unknown>;
  error?: { code?: string; message?: string };
}

export interface DaemonEngineOptions {
  daemonPath?: string;
  timeoutMs?: number;
  tcpPort?: number;
}

export class DaemonEngine extends BaseEngine {
  readonly name: Engine = 'daemon';

  private proc: ChildProcess | null = null;
  private pending: Map<string, PendingRequest> = new Map();
  private daemonPath: string;
  private readonly defaultTimeoutMs: number;
  private readonly tcpPort: number;
  private reconnectAttempted = false;
  private shuttingDown = false;
  private useTcp = false;

  constructor(options?: DaemonEngineOptions | string) {
    super();
    if (typeof options === 'string') {
      this.daemonPath = options;
      this.defaultTimeoutMs = DEFAULT_TIMEOUT_MS;
      this.tcpPort = DAEMON_TCP_PORT;
    } else {
      this.daemonPath = options?.daemonPath
        ?? process.env['SAFARI_PILOT_DAEMON']
        ?? './bin/SafariPilotd';
      this.defaultTimeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      this.tcpPort = options?.tcpPort ?? DAEMON_TCP_PORT;
    }
  }

  // ── Public interface ────────────────────────────────────────────────────────

  /**
   * Send an arbitrary command to the daemon.
   * Unlike `execute()` which always sends `method: "execute"`, this lets
   * callers invoke any daemon method (e.g. `watch_download`, `ping`).
   */
  async command(
    method: string,
    params: Record<string, unknown>,
    timeout?: number,
  ): Promise<EngineResult> {
    const start = Date.now();
    try {
      await this.ensureRunning();
      const response = await this.sendCommand(method, params, timeout);
      if (response.ok) {
        return {
          ok: true,
          value: typeof response.value === 'string'
            ? response.value.trimEnd()
            : JSON.stringify(response.value),
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

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureRunning();
      const response = await this.sendCommand('ping', {});
      return response.ok === true && response.value === 'pong';
    } catch {
      return false;
    }
  }

  async execute(script: string, timeout?: number): Promise<EngineResult> {
    const start = Date.now();
    try {
      await this.ensureRunning();
      const response = await this.sendCommand('execute', { script }, timeout);
      if (response.ok) {
        // Normalize: trim trailing whitespace (daemon may include trailing newline)
        // execute always returns a string value, but guard for type safety
        const value = typeof response.value === 'string'
          ? response.value.trimEnd()
          : typeof response.value === 'object' && response.value !== null
            ? JSON.stringify(response.value)
            : undefined;
        return {
          ok: true,
          value,
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

  async executeJsInTab(tabUrl: string, jsCode: string, timeout?: number): Promise<EngineResult> {
    const wrapped = `(function(){try{var __r=(function(){${jsCode}})();return JSON.stringify({ok:true,value:__r});}catch(e){return JSON.stringify({ok:false,error:{message:e.message,name:e.name}});}})()`;
    const safeUrl = (tabUrl ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedJs = wrapped.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = `tell application "Safari"\n  set _result to ""\n  repeat with _window in every window\n    repeat with _tab in every tab of _window\n      set _tabUrl to URL of _tab\n      if _tabUrl is "${safeUrl}" or _tabUrl is ("${safeUrl}" & "/") or ("${safeUrl}" is (_tabUrl & "/")) then\n        set _result to do JavaScript "${escapedJs}" in _tab\n        return _result\n      end if\n    end repeat\n  end repeat\n  return _result\nend tell`;
    const result = await this.execute(script, timeout);
    if (result.ok && result.value) {
      try {
        const parsed = JSON.parse(result.value);
        return {
          ok: parsed.ok,
          value: parsed.ok ? (typeof parsed.value === 'string' ? parsed.value : JSON.stringify(parsed.value)) : undefined,
          error: parsed.ok ? undefined : { code: parsed.error?.name || 'JS_ERROR', message: parsed.error?.message || 'Unknown error', retryable: false },
          elapsed_ms: result.elapsed_ms,
        };
      } catch {
        return { ok: true, value: result.value, elapsed_ms: result.elapsed_ms };
      }
    }
    return result;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.useTcp) {
      this.useTcp = false;
      return;
    }
    if (this.proc && !this.proc.killed) {
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
    if (this.useTcp || (this.proc && !this.proc.killed)) return;

    if (this.tcpPort > 0 && await this.tryTcpConnection()) {
      this.useTcp = true;
      return;
    }
    if (!this.proc || this.proc.killed) {
      this.spawnDaemon();
    }
  }

  private tryTcpConnection(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = createConnection({ host: '127.0.0.1', port: this.tcpPort }, () => {
        const pingPayload = JSON.stringify({ id: 'tcp-probe', method: 'ping' }) + '\n';
        sock.write(pingPayload);

        let buf = '';
        sock.on('data', (chunk) => {
          buf += chunk.toString();
          if (buf.includes('\n')) {
            try {
              const resp = JSON.parse(buf.split('\n')[0]) as DaemonResponse;
              sock.destroy();
              resolve(resp.ok === true);
            } catch {
              sock.destroy();
              resolve(false);
            }
          }
        });
      });
      sock.on('error', () => resolve(false));
      sock.setTimeout(200, () => { sock.destroy(); resolve(false); });
    });
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
    timeout?: number,
  ): Promise<DaemonResponse> {
    if (this.useTcp) {
      return this.sendCommandViaTcp(method, params, timeout);
    }

    const effectiveTimeout = timeout ?? this.defaultTimeoutMs;
    const id = nextId();
    const payload = JSON.stringify({ id, method, params }) + '\n';

    return new Promise<DaemonResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new DaemonTimeoutError(method, effectiveTimeout));
      }, effectiveTimeout);

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

  private sendCommandViaTcp(
    method: string,
    params: Record<string, unknown>,
    timeout?: number,
  ): Promise<DaemonResponse> {
    const effectiveTimeout = timeout ?? this.defaultTimeoutMs;
    const id = nextId();
    const payload = JSON.stringify({ id, method, params }) + '\n';

    return new Promise<DaemonResponse>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

      const sock = createConnection({ host: '127.0.0.1', port: this.tcpPort });

      const timer = setTimeout(() => {
        sock.destroy();
        settle(() => reject(new DaemonTimeoutError(method, effectiveTimeout)));
      }, effectiveTimeout);

      sock.on('connect', () => {
        sock.write(payload);
      });

      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString();
        if (buf.includes('\n')) {
          clearTimeout(timer);
          sock.destroy();
          try {
            const resp = JSON.parse(buf.split('\n')[0]) as DaemonResponse;
            settle(() => resolve(resp));
          } catch {
            settle(() => reject(new Error('Invalid JSON response from daemon TCP')));
          }
        }
      });

      sock.on('error', (err) => {
        clearTimeout(timer);
        sock.destroy();
        this.useTcp = false;
        settle(() => reject(new Error(`Daemon TCP connection failed: ${err.message}`)));
      });
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
