/**
 * Phase 8 E2E — Performance Benchmark
 *
 * Compares latency of the 3 engine tiers on a simple "get window name"
 * AppleScript across 20 consecutive commands each:
 *
 *   1. DaemonEngine  — persistent Swift process, JSON-over-stdin/stdout
 *   2. AppleScriptEngine — spawns osascript each time
 *
 * Metrics reported: p50, p95, p99, avg for each tier.
 *
 * Pass criteria:
 *   - daemon p50 < 50ms
 *   - daemon p50 at least 5× faster than applescript p50
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DaemonEngine } from '../../src/engines/daemon.js';
import { AppleScriptEngine } from '../../src/engines/applescript.js';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DAEMON_PATH = resolve(ROOT, 'bin/SafariPilotd');
const SAMPLE_SCRIPT = `tell application "Safari" to return name`;
const N = 20;

// ── Helpers ───────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

function stats(raw: number[]): { p50: number; p95: number; p99: number; avg: number } {
  const sorted = [...raw].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    avg: Math.round(raw.reduce((a, b) => a + b, 0) / raw.length),
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

let daemon: DaemonEngine;
let applescript: AppleScriptEngine;

beforeAll(async () => {
  // Ensure daemon binary is present
  if (!existsSync(DAEMON_PATH)) {
    console.log('[benchmark] Building daemon binary (this may take ~60s)…');
    execSync('swift build -c release', {
      cwd: resolve(ROOT, 'daemon'),
      timeout: 180_000,
      stdio: 'pipe',
    });
    execSync(`cp daemon/.build/release/SafariPilotd bin/SafariPilotd`, {
      cwd: ROOT,
      stdio: 'pipe',
    });
  }

  daemon = new DaemonEngine(DAEMON_PATH);
  applescript = new AppleScriptEngine();

  // Warm up — ensure daemon is running and first-command latency is excluded
  await daemon.isAvailable();
}, 200_000);

afterAll(async () => {
  if (daemon) await daemon.shutdown();
});

// ── Benchmark 1: DaemonEngine ─────────────────────────────────────────────────

describe('Performance Benchmark — DaemonEngine', () => {
  let daemonStats: ReturnType<typeof stats>;
  const daemonLatencies: number[] = [];

  it(`daemon is available before benchmarking`, async () => {
    const available = await daemon.isAvailable();
    expect(available, 'Daemon must be available to run benchmark').toBe(true);
  }, 15_000);

  it(`runs ${N} consecutive commands and collects latencies`, async () => {
    for (let i = 0; i < N; i++) {
      const start = Date.now();
      const result = await daemon.execute(SAMPLE_SCRIPT);
      daemonLatencies.push(Date.now() - start);
      expect(result.ok, `Daemon command ${i + 1} failed: ${result.error?.message}`).toBe(true);
    }

    daemonStats = stats(daemonLatencies);

    console.log('\n[DaemonEngine] Latency over', N, 'commands:');
    console.log(`  p50:  ${daemonStats.p50}ms`);
    console.log(`  p95:  ${daemonStats.p95}ms`);
    console.log(`  p99:  ${daemonStats.p99}ms`);
    console.log(`  avg:  ${daemonStats.avg}ms`);
    console.log(`  all:  [${daemonLatencies.join(', ')}]ms`);

    expect(daemonLatencies.length).toBe(N);
  }, 60_000);

  it('daemon p50 is under 50ms (warm path)', () => {
    const s = stats(daemonLatencies);
    expect(
      s.p50,
      `Daemon p50 ${s.p50}ms exceeds 50ms threshold`,
    ).toBeLessThan(50);
  });

  it('daemon p95 is under 200ms', () => {
    const s = stats(daemonLatencies);
    expect(
      s.p95,
      `Daemon p95 ${s.p95}ms exceeds 200ms threshold`,
    ).toBeLessThan(200);
  });
});

// ── Benchmark 2: AppleScriptEngine ────────────────────────────────────────────

describe('Performance Benchmark — AppleScriptEngine', () => {
  const asLatencies: number[] = [];

  it(`applescript is available before benchmarking`, async () => {
    const available = await applescript.isAvailable();
    expect(available, 'AppleScript must be available to run benchmark').toBe(true);
  }, 15_000);

  it(`runs ${N} consecutive commands and collects latencies`, async () => {
    for (let i = 0; i < N; i++) {
      const start = Date.now();
      const result = await applescript.execute(SAMPLE_SCRIPT);
      asLatencies.push(Date.now() - start);
      expect(result.ok, `AppleScript command ${i + 1} failed: ${result.error?.message}`).toBe(true);
    }

    const s = stats(asLatencies);

    console.log('\n[AppleScriptEngine] Latency over', N, 'commands:');
    console.log(`  p50:  ${s.p50}ms`);
    console.log(`  p95:  ${s.p95}ms`);
    console.log(`  p99:  ${s.p99}ms`);
    console.log(`  avg:  ${s.avg}ms`);
    console.log(`  all:  [${asLatencies.join(', ')}]ms`);

    expect(asLatencies.length).toBe(N);
  }, 120_000);
});

// ── Cross-engine comparison ───────────────────────────────────────────────────

describe('Performance Benchmark — Cross-Engine Comparison', () => {
  const daemonLatencies2: number[] = [];
  const asLatencies2: number[] = [];

  beforeAll(async () => {
    // Collect fresh samples so the comparison is done from the same beforeAll scope
    for (let i = 0; i < N; i++) {
      const ds = Date.now();
      const dr = await daemon.execute(SAMPLE_SCRIPT);
      daemonLatencies2.push(Date.now() - ds);
      expect(dr.ok).toBe(true);

      const as2 = Date.now();
      const ar = await applescript.execute(SAMPLE_SCRIPT);
      asLatencies2.push(Date.now() - as2);
      expect(ar.ok).toBe(true);
    }
  }, 120_000);

  it('daemon is at least 5× faster than AppleScript (p50 comparison)', () => {
    const ds = stats(daemonLatencies2);
    const as2 = stats(asLatencies2);

    const speedup = as2.p50 / Math.max(ds.p50, 1);
    console.log(`\n[Comparison] Daemon p50: ${ds.p50}ms | AppleScript p50: ${as2.p50}ms | speedup: ${speedup.toFixed(1)}x`);

    expect(
      speedup,
      `Expected daemon to be ≥5× faster than AppleScript at p50 (got ${speedup.toFixed(1)}×). Daemon p50=${ds.p50}ms, AS p50=${as2.p50}ms`,
    ).toBeGreaterThanOrEqual(5);
  });

  it('daemon avg is less than AppleScript avg', () => {
    const ds = stats(daemonLatencies2);
    const as2 = stats(asLatencies2);
    expect(ds.avg).toBeLessThan(as2.avg);
  });
});
