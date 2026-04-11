import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtensionEngine } from '../../src/engines/extension.js';
import type { DaemonEngine } from '../../src/engines/daemon.js';
import type { EngineResult } from '../../src/types.js';

// ── Mock DaemonEngine ───────────────────────────────────────────────────────
// We never spawn a real daemon process in these tests. A typed partial mock
// is enough because ExtensionEngine only calls daemon.execute().

function makeMockDaemon(
  impl?: (script: string, timeout?: number) => Promise<EngineResult>,
): DaemonEngine {
  return {
    name: 'daemon',
    isAvailable: vi.fn().mockResolvedValue(true),
    execute: vi.fn(impl ?? (() => Promise.resolve({ ok: true, value: 'pong', elapsed_ms: 1 }))),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as DaemonEngine;
}

const INTERNAL_PREFIX = '__SAFARI_PILOT_INTERNAL__';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ExtensionEngine', () => {

  // ── Test 1: engine name ────────────────────────────────────────────────────
  it('has name "extension"', () => {
    const daemon = makeMockDaemon();
    const engine = new ExtensionEngine(daemon);
    expect(engine.name).toBe('extension');
  });

  // ── Test 2: isAvailable — daemon reports disconnected ────────────────────
  it('isAvailable returns false when daemon reports disconnected', async () => {
    const daemon = makeMockDaemon(async () => ({
      ok: true,
      value: 'disconnected',
      elapsed_ms: 1,
    }));
    const engine = new ExtensionEngine(daemon);

    const available = await engine.isAvailable();

    expect(available).toBe(false);
    expect(daemon.execute).toHaveBeenCalledWith(
      `${INTERNAL_PREFIX} extension_status`,
    );
  });

  // ── Test 3: isAvailable — daemon reports connected ────────────────────────
  it('isAvailable returns true when daemon reports connected', async () => {
    const daemon = makeMockDaemon(async () => ({
      ok: true,
      value: 'connected',
      elapsed_ms: 1,
    }));
    const engine = new ExtensionEngine(daemon);

    const available = await engine.isAvailable();

    expect(available).toBe(true);
  });

  // ── Test 4: isAvailable — daemon throws ──────────────────────────────────
  it('isAvailable returns false when daemon throws', async () => {
    const daemon = makeMockDaemon(async () => {
      throw new Error('Daemon not running');
    });
    const engine = new ExtensionEngine(daemon);

    const available = await engine.isAvailable();
    expect(available).toBe(false);
  });

  // ── Test 5: execute routes through daemon ─────────────────────────────────
  it('execute routes through daemon with correct payload', async () => {
    const expectedResult: EngineResult = { ok: true, value: 'result-value', elapsed_ms: 5 };
    const daemon = makeMockDaemon(async () => expectedResult);
    const engine = new ExtensionEngine(daemon);

    const script = 'return document.title';
    const result = await engine.execute(script);

    expect(result.ok).toBe(true);
    // elapsed_ms should be at least 0
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);

    // Verify the daemon received the correct internal command
    expect(daemon.execute).toHaveBeenCalledOnce();
    const [calledScript] = (daemon.execute as ReturnType<typeof vi.fn>).mock.calls[0] as [string, number?];
    expect(calledScript).toMatch(new RegExp(`^${INTERNAL_PREFIX} extension_execute `));

    // The JSON payload should contain the script
    const jsonPart = calledScript.replace(`${INTERNAL_PREFIX} extension_execute `, '');
    const parsed = JSON.parse(jsonPart) as { script: string };
    expect(parsed.script).toBe(script);
  });

  // ── Test 6: execute passes timeout to daemon ──────────────────────────────
  it('execute passes timeout to daemon', async () => {
    const daemon = makeMockDaemon(async () => ({ ok: true, value: 'ok', elapsed_ms: 1 }));
    const engine = new ExtensionEngine(daemon);

    await engine.execute('return 1', 5000);

    const calls = (daemon.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![1]).toBe(5000);
  });

  // ── Test 7: execute handles daemon error gracefully ───────────────────────
  it('execute returns EXTENSION_ERROR when daemon returns failure', async () => {
    const daemon = makeMockDaemon(async () => ({
      ok: false,
      error: { code: 'DAEMON_ERROR', message: 'something failed', retryable: true },
      elapsed_ms: 2,
    }));
    const engine = new ExtensionEngine(daemon);

    const result = await engine.execute('return 1');

    // The daemon returned ok:false, so execute should propagate the failure
    expect(result.ok).toBe(false);
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  // ── Test 8: execute handles thrown exception ──────────────────────────────
  it('execute wraps thrown exceptions into EXTENSION_ERROR', async () => {
    const daemon = makeMockDaemon(async () => {
      throw new Error('connection lost');
    });
    const engine = new ExtensionEngine(daemon);

    const result = await engine.execute('return 1');

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('EXTENSION_ERROR');
    expect(result.error?.message).toContain('connection lost');
    expect(result.error?.retryable).toBe(true);
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
  });
});
