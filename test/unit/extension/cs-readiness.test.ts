import { describe, it, expect } from 'vitest';
import {
  recordCsReady,
  isCsReady,
  decideStorageBusTimeout,
  CS_READY_MAX_AGE_MS,
} from '../../../extension/lib/cs-readiness.js';

// v0.1.36 Track A Fix 3 — content-script readiness gate for the storage bus.
//
// Bug being fixed: extension/background.js dispatches storage-bus commands
// (sp_cmd_<id>) and waits up to 30 s for sp_result_<id>. On a fresh or
// just-navigated tab the content script may take 0.5–3 s to register its
// storage.onChanged listener — during that window, bus writes succeed but
// nothing consumes them, and the daemon eventually errors with
// "Storage bus timeout (30000ms) — content script may not be loaded on
// target tab". 499 errors of this class in the v0.1.35 single-run bench
// (16% of all errors).
//
// This module is the pure-logic core: a per-tab readiness map (content
// script writes a heartbeat on load; background.js records it) and a
// timeout-selection helper (use a short timeout when the script is NOT
// known ready; use the normal 30 s when it IS).
//
// The integration in background.js wires this up: heartbeat listener
// updates the map; pre-dispatch check decides the timeout.

describe('cs-readiness map', () => {
  it('records a ready event for a tab', () => {
    const map = new Map();
    recordCsReady(map, 7, 1_000);
    expect(map.has(7)).toBe(true);
  });

  it('isCsReady true within max-age window', () => {
    const map = new Map();
    recordCsReady(map, 7, 1_000);
    expect(isCsReady(map, 7, 1_000 + CS_READY_MAX_AGE_MS - 1)).toBe(true);
  });

  it('isCsReady false after max-age expiry', () => {
    const map = new Map();
    recordCsReady(map, 7, 1_000);
    expect(isCsReady(map, 7, 1_000 + CS_READY_MAX_AGE_MS + 1)).toBe(false);
  });

  it('isCsReady false for unknown tab', () => {
    const map = new Map();
    expect(isCsReady(map, 999, 1_000)).toBe(false);
  });

  it('recordCsReady updates the timestamp (later ready beats earlier)', () => {
    const map = new Map();
    recordCsReady(map, 7, 1_000);
    recordCsReady(map, 7, 2_000);
    expect(map.get(7).timestamp).toBe(2_000);
  });
});

describe('decideStorageBusTimeout — fast-fail gate', () => {
  it('returns SHORT timeout (5000ms) for first call after load (no heartbeat)', () => {
    const map = new Map();
    const { timeoutMs, reason } = decideStorageBusTimeout(map, 7, 1_000, /* default */ 30_000);
    expect(timeoutMs).toBe(5_000);
    expect(reason).toBe('cs_not_ready');
  });

  it('returns DEFAULT timeout (30000ms) when content script is known ready', () => {
    const map = new Map();
    recordCsReady(map, 7, 999);
    const { timeoutMs, reason } = decideStorageBusTimeout(map, 7, 1_000, 30_000);
    expect(timeoutMs).toBe(30_000);
    expect(reason).toBe('cs_ready');
  });

  it('returns SHORT timeout when heartbeat is too stale', () => {
    const map = new Map();
    recordCsReady(map, 7, 1_000);
    const { timeoutMs, reason } = decideStorageBusTimeout(
      map, 7, 1_000 + CS_READY_MAX_AGE_MS + 1, 30_000,
    );
    expect(timeoutMs).toBe(5_000);
    expect(reason).toBe('cs_not_ready');
  });

  it('honours caller-provided default (e.g. 10s for frame-targeted commands)', () => {
    const map = new Map();
    recordCsReady(map, 7, 999);
    const { timeoutMs } = decideStorageBusTimeout(map, 7, 1_000, 10_000);
    expect(timeoutMs).toBe(10_000);
  });

  it('short timeout overrides caller default when CS not ready (fast-fail floor)', () => {
    const map = new Map();
    // Caller default is 30s; CS not ready → use 5s, not 30s.
    const { timeoutMs } = decideStorageBusTimeout(map, 999, 1_000, 30_000);
    expect(timeoutMs).toBe(5_000);
    // Caller default is 3s (smaller than 5s); use the smaller, do not raise.
    const { timeoutMs: t2 } = decideStorageBusTimeout(map, 999, 1_000, 3_000);
    expect(t2).toBe(3_000);
  });
});
