/**
 * Extension Bridge Protocol Contract — TypeScript side
 *
 * The daemon's ExtensionBridge (Swift) uses an in-memory command queue.
 * That side is tested by 41 Swift tests in daemon/Tests/.
 *
 * This file tests the TypeScript side: the sentinel strings and JSON payloads
 * that ExtensionEngine constructs when communicating with the daemon.
 * If these sentinels don't match what the daemon expects, the bridge is dead.
 *
 * Old file-based IPC tests were removed — file I/O bridge was replaced by
 * in-memory queue in the daemon rewrite.
 */

import { describe, it, expect, vi } from 'vitest';
import { ExtensionEngine } from '../../../src/engines/extension.js';
import type { DaemonEngine } from '../../../src/engines/daemon.js';
import type { EngineResult } from '../../../src/types.js';

const INTERNAL_PREFIX = '__SAFARI_PILOT_INTERNAL__';

function makeMockDaemon(
  capturedCalls: string[] = [],
): DaemonEngine {
  return {
    name: 'daemon',
    isAvailable: vi.fn().mockResolvedValue(true),
    execute: vi.fn(async (script: string) => {
      capturedCalls.push(script);
      return { ok: true, value: 'connected', elapsed_ms: 1 } as EngineResult;
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as DaemonEngine;
}

// ── Sentinel Format ─────────────────────────────────────────────────────────

describe('Bridge Protocol — sentinel prefix format', () => {

  it('extension_status sentinel is: __SAFARI_PILOT_INTERNAL__ extension_status', async () => {
    const calls: string[] = [];
    const daemon = makeMockDaemon(calls);
    const engine = new ExtensionEngine(daemon);

    await engine.isAvailable();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`${INTERNAL_PREFIX} extension_status`);
  });

  it('extension_execute sentinel starts with: __SAFARI_PILOT_INTERNAL__ extension_execute', async () => {
    const calls: string[] = [];
    const daemon = makeMockDaemon(calls);
    const engine = new ExtensionEngine(daemon);

    await engine.execute('return 1');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.startsWith(`${INTERNAL_PREFIX} extension_execute `)).toBe(true);
  });

  it('sentinel prefix uses double underscores and spaces (not colons or slashes)', async () => {
    const calls: string[] = [];
    const daemon = makeMockDaemon(calls);
    const engine = new ExtensionEngine(daemon);

    await engine.execute('return 1');

    // The daemon splits on " " and checks for "__SAFARI_PILOT_INTERNAL__"
    // Any deviation (colons, slashes, single underscores) would break parsing
    const sentinel = calls[0]!;
    const parts = sentinel.split(' ');
    expect(parts[0]).toBe('__SAFARI_PILOT_INTERNAL__');
    expect(parts[1]).toBe('extension_execute');
    // Remaining parts form the JSON payload
    expect(parts.length).toBeGreaterThan(2);
  });
});

// ── JSON Payload Structure ──────────────────────────────────────────────────

describe('Bridge Protocol — JSON payload structure', () => {

  it('execute() sends JSON with "script" field', async () => {
    const calls: string[] = [];
    const daemon = makeMockDaemon(calls);
    const engine = new ExtensionEngine(daemon);

    await engine.execute('return document.title');

    const jsonStr = calls[0]!.replace(`${INTERNAL_PREFIX} extension_execute `, '');
    const payload = JSON.parse(jsonStr);

    expect(payload).toEqual({ script: 'return document.title' });
  });

  it('executeJsInTab() sends JSON with "script" and "tabUrl" fields', async () => {
    const calls: string[] = [];
    const daemon = makeMockDaemon(calls);
    const engine = new ExtensionEngine(daemon);

    await engine.executeJsInTab('https://example.com/page', 'return document.title');

    const jsonStr = calls[0]!.replace(`${INTERNAL_PREFIX} extension_execute `, '');
    const payload = JSON.parse(jsonStr);

    expect(payload).toEqual({
      script: 'return document.title',
      tabUrl: 'https://example.com/page',
    });
  });

  it('payload JSON is parseable (no truncation or encoding issues)', async () => {
    const calls: string[] = [];
    const daemon = makeMockDaemon(calls);
    const engine = new ExtensionEngine(daemon);

    // Script with special characters that could break JSON
    const tricky = 'return "hello \\"world\\"" + \'\\n\' + `${1+2}`';
    await engine.execute(tricky);

    const jsonStr = calls[0]!.replace(`${INTERNAL_PREFIX} extension_execute `, '');
    expect(() => JSON.parse(jsonStr)).not.toThrow();

    const payload = JSON.parse(jsonStr);
    expect(payload.script).toBe(tricky);
  });

  it('extension_status sentinel has NO JSON payload', async () => {
    const calls: string[] = [];
    const daemon = makeMockDaemon(calls);
    const engine = new ExtensionEngine(daemon);

    await engine.isAvailable();

    // Should be exactly the sentinel, no trailing content
    expect(calls[0]).toBe(`${INTERNAL_PREFIX} extension_status`);
    expect(calls[0]!.split(' ')).toHaveLength(2);
  });
});

// ── Response Contract ───────────────────────────────────────────────────────

describe('Bridge Protocol — daemon response interpretation', () => {

  it('isAvailable treats ONLY "connected" string as true', async () => {
    for (const value of ['connected']) {
      const daemon = {
        name: 'daemon',
        isAvailable: vi.fn().mockResolvedValue(true),
        execute: vi.fn(async () => ({ ok: true, value, elapsed_ms: 1 })),
        shutdown: vi.fn(),
      } as unknown as DaemonEngine;

      const engine = new ExtensionEngine(daemon);
      expect(await engine.isAvailable()).toBe(true);
    }

    for (const value of ['disconnected', '', 'true', 'yes', 'CONNECTED', undefined]) {
      const daemon = {
        name: 'daemon',
        isAvailable: vi.fn().mockResolvedValue(true),
        execute: vi.fn(async () => ({ ok: true, value, elapsed_ms: 1 })),
        shutdown: vi.fn(),
      } as unknown as DaemonEngine;

      const engine = new ExtensionEngine(daemon);
      expect(await engine.isAvailable()).toBe(false);
    }
  });

  it('isAvailable returns false when daemon response has ok:false (even if value is "connected")', async () => {
    const daemon = {
      name: 'daemon',
      isAvailable: vi.fn().mockResolvedValue(true),
      execute: vi.fn(async () => ({
        ok: false,
        value: 'connected',
        error: { code: 'ERR', message: 'fail', retryable: false },
        elapsed_ms: 1,
      })),
      shutdown: vi.fn(),
    } as unknown as DaemonEngine;

    const engine = new ExtensionEngine(daemon);
    expect(await engine.isAvailable()).toBe(false);
  });
});
