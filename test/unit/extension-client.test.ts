import { describe, it, expect, vi } from 'vitest';
import { ExtensionEngine } from '../../src/engines/extension.js';
import type { DaemonEngine } from '../../src/engines/daemon.js';
import type { EngineResult } from '../../src/types.js';

// ── Mock DaemonEngine ───────────────────────────────────────────────────────
// Minimal mock that records what ExtensionEngine sends to the daemon.
// Each test controls the daemon's response to verify the PROTOCOL,
// not just that a value flows through.

const INTERNAL_PREFIX = '__SAFARI_PILOT_INTERNAL__';

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

/** Extract the raw string passed to daemon.execute() on the Nth call (0-based). */
function getDaemonCall(daemon: DaemonEngine, index = 0): string {
  const calls = (daemon.execute as ReturnType<typeof vi.fn>).mock.calls;
  return calls[index]![0] as string;
}

/** Parse the JSON payload from an `extension_execute` sentinel. */
function parseExecutePayload(sentinelStr: string): Record<string, unknown> {
  const prefix = `${INTERNAL_PREFIX} extension_execute `;
  expect(sentinelStr.startsWith(prefix)).toBe(true);
  return JSON.parse(sentinelStr.slice(prefix.length));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ExtensionEngine', () => {

  // ── Identity ──────────────────────────────────────────────────────────────

  it('has name "extension"', () => {
    const daemon = makeMockDaemon();
    const engine = new ExtensionEngine(daemon);
    expect(engine.name).toBe('extension');
  });

  // ── isAvailable: extension_health sentinel ────────────────────────────────

  describe('isAvailable — extension_health sentinel (commit 2: checks ipcMechanism)', () => {

    it('sends the exact sentinel "__SAFARI_PILOT_INTERNAL__ extension_health"', async () => {
      const daemon = makeMockDaemon(async () => ({
        ok: true,
        value: JSON.stringify({ ipcMechanism: 'http', isConnected: true }),
        elapsed_ms: 1,
      }));
      const engine = new ExtensionEngine(daemon);

      await engine.isAvailable();

      expect(daemon.execute).toHaveBeenCalledWith(
        `${INTERNAL_PREFIX} extension_health`,
      );
    });

    it('returns true when ipcMechanism is "http" (extension has connected)', async () => {
      const daemon = makeMockDaemon(async () => ({
        ok: true,
        value: JSON.stringify({ ipcMechanism: 'http', isConnected: true }),
        elapsed_ms: 1,
      }));
      const engine = new ExtensionEngine(daemon);

      expect(await engine.isAvailable()).toBe(true);
    });

    it('returns true when ipcMechanism is "tcp" (legacy path)', async () => {
      const daemon = makeMockDaemon(async () => ({
        ok: true,
        value: JSON.stringify({ ipcMechanism: 'tcp', isConnected: false }),
        elapsed_ms: 1,
      }));
      const engine = new ExtensionEngine(daemon);

      expect(await engine.isAvailable()).toBe(true);
    });

    it('returns false when ipcMechanism is "none" (no extension ever connected)', async () => {
      const daemon = makeMockDaemon(async () => ({
        ok: true,
        value: JSON.stringify({ ipcMechanism: 'none', isConnected: false }),
        elapsed_ms: 1,
      }));
      const engine = new ExtensionEngine(daemon);

      expect(await engine.isAvailable()).toBe(false);
    });

    it('returns false when daemon returns ok:false (daemon error)', async () => {
      const daemon = makeMockDaemon(async () => ({
        ok: false,
        error: { code: 'DAEMON_ERROR', message: 'not running', retryable: true },
        elapsed_ms: 1,
      }));
      const engine = new ExtensionEngine(daemon);

      expect(await engine.isAvailable()).toBe(false);
    });

    it('returns false when daemon throws (process not spawned)', async () => {
      const daemon = makeMockDaemon(async () => {
        throw new Error('Daemon not running');
      });
      const engine = new ExtensionEngine(daemon);

      expect(await engine.isAvailable()).toBe(false);
    });
  });

  // ── execute: extension_execute sentinel ───────────────────────────────────

  describe('execute — extension_execute sentinel and payload', () => {

    it('sends sentinel with JSON payload containing {script}', async () => {
      const daemon = makeMockDaemon(async () => ({ ok: true, value: 'title', elapsed_ms: 1 }));
      const engine = new ExtensionEngine(daemon);

      await engine.execute('return document.title');

      const sent = getDaemonCall(daemon);
      expect(sent).toMatch(new RegExp(`^${INTERNAL_PREFIX} extension_execute `));

      const payload = parseExecutePayload(sent);
      expect(payload).toHaveProperty('script', 'return document.title');
    });

    it('enforces 90s minimum timeout for event-page wake cycle', async () => {
      const daemon = makeMockDaemon(async () => ({ ok: true, value: 'ok', elapsed_ms: 1 }));
      const engine = new ExtensionEngine(daemon);

      await engine.execute('return 1', 7500);

      const calls = (daemon.execute as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![1]).toBe(90_000);
    });

    it('propagates ok:true result from daemon', async () => {
      const daemon = makeMockDaemon(async () => ({
        ok: true,
        value: 'Example Domain',
        elapsed_ms: 3,
      }));
      const engine = new ExtensionEngine(daemon);

      const result = await engine.execute('return document.title');

      expect(result.ok).toBe(true);
      expect(result.value).toBe('Example Domain');
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it('propagates ok:false from daemon as failure', async () => {
      const daemon = makeMockDaemon(async () => ({
        ok: false,
        error: { code: 'DAEMON_ERROR', message: 'script failed', retryable: true },
        elapsed_ms: 2,
      }));
      const engine = new ExtensionEngine(daemon);

      const result = await engine.execute('return 1');

      expect(result.ok).toBe(false);
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it('wraps daemon exceptions into EXTENSION_ERROR', async () => {
      const daemon = makeMockDaemon(async () => {
        throw new Error('connection lost');
      });
      const engine = new ExtensionEngine(daemon);

      const result = await engine.execute('return 1');

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('EXTENSION_ERROR');
      expect(result.error?.message).toContain('connection lost');
      expect(result.error?.retryable).toBe(true);
    });
  });

  // ── executeJsInTab: tabUrl routing ────────────────────────────────────────

  describe('executeJsInTab — sends {script, tabUrl} payload', () => {

    it('includes both script and tabUrl in the JSON payload', async () => {
      const daemon = makeMockDaemon(async () => ({
        ok: true,
        value: 'clicked',
        elapsed_ms: 2,
      }));
      const engine = new ExtensionEngine(daemon);

      await engine.executeJsInTab(
        'https://example.com/page',
        'document.querySelector("button").click()',
      );

      const sent = getDaemonCall(daemon);
      const payload = parseExecutePayload(sent);
      expect(payload).toHaveProperty('script', 'document.querySelector("button").click()');
      expect(payload).toHaveProperty('tabUrl', 'https://example.com/page');
    });

    it('enforces 90s minimum timeout for event-page wake cycle', async () => {
      const daemon = makeMockDaemon(async () => ({ ok: true, value: 'ok', elapsed_ms: 1 }));
      const engine = new ExtensionEngine(daemon);

      await engine.executeJsInTab('https://example.com', 'return 1', 3000);

      const calls = (daemon.execute as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]![1]).toBe(90_000);
    });

    it('wraps daemon exceptions into EXTENSION_ERROR', async () => {
      const daemon = makeMockDaemon(async () => {
        throw new Error('tab crashed');
      });
      const engine = new ExtensionEngine(daemon);

      const result = await engine.executeJsInTab('https://example.com', 'return 1');

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('EXTENSION_ERROR');
      expect(result.error?.message).toContain('tab crashed');
      expect(result.error?.retryable).toBe(true);
    });
  });

  // ── Payload structure: protocol contract ──────────────────────────────────

  describe('protocol contract — sentinel format and JSON structure', () => {

    it('extension_health sentinel has no trailing payload', async () => {
      const daemon = makeMockDaemon(async () => ({
        ok: true,
        value: JSON.stringify({ ipcMechanism: 'http' }),
        elapsed_ms: 1,
      }));
      const engine = new ExtensionEngine(daemon);

      await engine.isAvailable();

      const sent = getDaemonCall(daemon);
      // Must be exactly this string, no extra content
      expect(sent).toBe(`${INTERNAL_PREFIX} extension_health`);
    });

    it('extension_execute payload is valid JSON', async () => {
      const daemon = makeMockDaemon(async () => ({ ok: true, value: 'ok', elapsed_ms: 1 }));
      const engine = new ExtensionEngine(daemon);

      await engine.execute('return JSON.stringify({a: 1})');

      const sent = getDaemonCall(daemon);
      const jsonStr = sent.replace(`${INTERNAL_PREFIX} extension_execute `, '');
      expect(() => JSON.parse(jsonStr)).not.toThrow();
    });

    it('execute() payload has "script" key but no "tabUrl" key', async () => {
      const daemon = makeMockDaemon(async () => ({ ok: true, value: 'ok', elapsed_ms: 1 }));
      const engine = new ExtensionEngine(daemon);

      await engine.execute('return 1');

      const payload = parseExecutePayload(getDaemonCall(daemon));
      expect(payload).toHaveProperty('script');
      expect(payload).not.toHaveProperty('tabUrl');
    });

    it('executeJsInTab() payload has both "script" and "tabUrl" keys', async () => {
      const daemon = makeMockDaemon(async () => ({ ok: true, value: 'ok', elapsed_ms: 1 }));
      const engine = new ExtensionEngine(daemon);

      await engine.executeJsInTab('https://example.com', 'return 1');

      const payload = parseExecutePayload(getDaemonCall(daemon));
      expect(payload).toHaveProperty('script');
      expect(payload).toHaveProperty('tabUrl');
    });
  });
});
