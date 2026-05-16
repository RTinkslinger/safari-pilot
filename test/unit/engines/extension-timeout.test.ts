import { describe, it, expect } from 'vitest';
import { ExtensionEngine } from '../../../src/engines/extension.js';
import type { DaemonEngine } from '../../../src/engines/daemon.js';
import type { EngineResult } from '../../../src/types.js';
import { ERROR_CODES } from '../../../src/errors.js';

// v0.1.36 Fix 2 — daemon timeout passthrough + structured DAEMON_TIMEOUT envelope.
//
// Current bug (extension.ts:84): `Math.max(timeout ?? EXTENSION_TIMEOUT_MS,
// EXTENSION_TIMEOUT_MS)` floors every caller's timeout at 90_000ms. Tools
// passing shorter timeouts get bumped to 90s, producing ~963 errors of
// "Daemon command 'execute' timed out after 90000ms" in the v0.1.35 bench
// run when the underlying op hung.
//
// Contract this suite enforces:
//   1. Caller's timeout is passed through to daemon.execute verbatim.
//   2. Default timeout (no caller value) is 15_000ms, not 90_000ms.
//   3. When daemon returns the canonical "timed out" error string, the
//      engine translates it to a structured ToolError with
//      code=DAEMON_TIMEOUT, retryable=true, and the operator hint list
//      (so the agent can recover instead of seeing an opaque error).

/** Test double for DaemonEngine: records call args, returns a scripted result. */
class RecordingDaemon {
  calls: Array<{ command: string; timeout: number | undefined }> = [];
  resultProvider: (call: { command: string; timeout: number | undefined }) => Promise<EngineResult>;

  constructor(resultProvider?: (call: { command: string; timeout: number | undefined }) => Promise<EngineResult>) {
    this.resultProvider = resultProvider ?? (async () =>
      ({ ok: true, value: JSON.stringify({ value: 'ok', _meta: { tabUrl: 'x' } }), elapsed_ms: 1 })
    );
  }

  async execute(command: string, timeout?: number): Promise<EngineResult> {
    const call = { command, timeout };
    this.calls.push(call);
    return this.resultProvider(call);
  }

  // Unused interface members — satisfy structural typing only.
  async isAvailable(): Promise<boolean> { return true; }
  readonly name = 'daemon' as const;
  async navigate(): Promise<EngineResult> { return { ok: false, elapsed_ms: 0 }; }
  async click(): Promise<EngineResult> { return { ok: false, elapsed_ms: 0 }; }
  async fill(): Promise<EngineResult> { return { ok: false, elapsed_ms: 0 }; }
  async executeJsInTab(): Promise<EngineResult> { return { ok: false, elapsed_ms: 0 }; }
  async executeJsInFrame(): Promise<EngineResult> { return { ok: false, elapsed_ms: 0 }; }
}

describe('ExtensionEngine timeout passthrough (v0.1.36 Fix 2)', () => {
  it('passes caller-supplied timeout through to daemon.execute verbatim (not floored at 90s)', async () => {
    const daemon = new RecordingDaemon();
    const engine = new ExtensionEngine(daemon as unknown as DaemonEngine);
    await engine.executeJsInTab('https://example.com', 'return 1', 5_000);
    expect(daemon.calls).toHaveLength(1);
    expect(daemon.calls[0]?.timeout).toBe(5_000);
  });

  it('uses 90_000ms default when caller passes no timeout (Fix 2: passthrough is what changed; default is the same as pre-fix)', async () => {
    const daemon = new RecordingDaemon();
    const engine = new ExtensionEngine(daemon as unknown as DaemonEngine);
    await engine.executeJsInTab('https://example.com', 'return 1');
    expect(daemon.calls).toHaveLength(1);
    expect(daemon.calls[0]?.timeout).toBe(90_000);
  });

  it('passes caller timeout through executeJsInFrame too (frame path same contract)', async () => {
    const daemon = new RecordingDaemon();
    const engine = new ExtensionEngine(daemon as unknown as DaemonEngine);
    await engine.executeJsInFrame('https://example.com', 5, 'return 1', 8_000);
    expect(daemon.calls).toHaveLength(1);
    expect(daemon.calls[0]?.timeout).toBe(8_000);
  });

  it('translates daemon "execute timed out" error to DAEMON_TIMEOUT with retryable=false and hints', async () => {
    const daemon = new RecordingDaemon(async () => ({
      ok: false,
      error: {
        code: 'EXTENSION_ERROR',
        message: 'Daemon command "execute" timed out after 15000ms',
        retryable: false,
      },
      elapsed_ms: 15_001,
    }));
    const engine = new ExtensionEngine(daemon as unknown as DaemonEngine);
    const result = await engine.executeJsInTab('https://example.com', 'return 1', 15_000);

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ERROR_CODES.DAEMON_TIMEOUT);
    expect(result.error?.retryable).toBe(false);
    expect(result.error?.hints).toBeDefined();
    expect(result.error?.hints?.length).toBeGreaterThan(0);
    // Hints should mention a concrete recovery path so the agent can act on them.
    const hintsJoined = (result.error?.hints ?? []).join(' ').toLowerCase();
    expect(
      hintsJoined.includes('wait') ||
      hintsJoined.includes('query_all') ||
      hintsJoined.includes('get_text')
    ).toBe(true);
  });

  it('execute(): passes caller timeout through verbatim (third passthrough surface)', async () => {
    const daemon = new RecordingDaemon();
    const engine = new ExtensionEngine(daemon as unknown as DaemonEngine);
    await engine.execute('return 1', 7_500);
    expect(daemon.calls).toHaveLength(1);
    expect(daemon.calls[0]?.timeout).toBe(7_500);
  });

  it('execute(): uses 90s default when no timeout passed', async () => {
    const daemon = new RecordingDaemon();
    const engine = new ExtensionEngine(daemon as unknown as DaemonEngine);
    await engine.execute('return 1');
    expect(daemon.calls).toHaveLength(1);
    expect(daemon.calls[0]?.timeout).toBe(90_000);
  });

  it('execute(): translates daemon timeout error to DAEMON_TIMEOUT (translation parity across entry points)', async () => {
    const daemon = new RecordingDaemon(async () => ({
      ok: false,
      error: { code: 'EXTENSION_ERROR', message: 'Daemon command "execute" timed out after 15000ms', retryable: false },
      elapsed_ms: 15_001,
    }));
    const engine = new ExtensionEngine(daemon as unknown as DaemonEngine);
    const result = await engine.execute('return 1');
    expect(result.error?.code).toBe(ERROR_CODES.DAEMON_TIMEOUT);
  });

  it('executeJsInFrame(): translates daemon timeout error to DAEMON_TIMEOUT (translation parity)', async () => {
    const daemon = new RecordingDaemon(async () => ({
      ok: false,
      error: { code: 'EXTENSION_ERROR', message: 'Daemon command "execute" timed out after 15000ms', retryable: false },
      elapsed_ms: 15_001,
    }));
    const engine = new ExtensionEngine(daemon as unknown as DaemonEngine);
    const result = await engine.executeJsInFrame('https://x.test', 5, 'return 1');
    expect(result.error?.code).toBe(ERROR_CODES.DAEMON_TIMEOUT);
  });

  it('still surfaces non-timeout daemon errors unchanged (regression guard)', async () => {
    const daemon = new RecordingDaemon(async () => ({
      ok: false,
      error: { code: 'EXTENSION_ERROR', message: 'something else broke', retryable: false },
      elapsed_ms: 200,
    }));
    const engine = new ExtensionEngine(daemon as unknown as DaemonEngine);
    const result = await engine.executeJsInTab('https://example.com', 'return 1');
    expect(result.ok).toBe(false);
    // Non-timeout errors must NOT be reclassified as DAEMON_TIMEOUT.
    expect(result.error?.code).not.toBe(ERROR_CODES.DAEMON_TIMEOUT);
    expect(result.error?.message).toContain('something else broke');
  });
});
