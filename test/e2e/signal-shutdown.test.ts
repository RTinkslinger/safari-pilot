/**
 * T10 — SIGTERM/SIGINT handler closes session window before exit
 *
 * DISCRIMINATING ASSERTION:
 *   Pre-T10: `process.on('SIGTERM')` unregistered. Node's default handler
 *   terminated the process without running any cleanup. `_sessionWindowId`
 *   remained a live Safari window — every MCP server death (vitest, Claude
 *   Code session end, `kill`) orphaned one. User ended up with hundreds.
 *
 *   Post-T10: SIGTERM/SIGINT run `safariPilot.shutdown()` → `closeSessionWindow()`
 *   → AppleScript `close window id ${wid}`. The window is gone by process exit.
 *
 * Standalone by design — does NOT use McpTestClient because this test exists
 * precisely to validate the process-lifecycle path the harness currently
 * exercises N times (once per test file). No harness changes depend on this.
 *
 * Uses isolated SAFARI_PILOT_TRACE_DIR so we read only this spawn's
 * `session_window_created` event to discover the window id.
 */
import { describe, it, expect } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVER_PATH = resolve(__dirname, '../../dist/index.js');

/**
 * Report whether a Safari window is user-visible. Quirk: after `close window id X`
 * Safari keeps the AppleScript window reference alive (its dictionary entry
 * persists), so `exists window id X` continues returning `true`. The truthful
 * "is the user seeing this window" signal is `visible of window id X` — which
 * flips to `false` when the window is actually closed.
 *
 * Returns false when either the window doesn't exist OR exists-but-invisible.
 * Both mean "the user is NOT seeing this window," which is what T10 must guarantee.
 */
function safariWindowVisible(wid: number): boolean {
  const script =
    `tell application "Safari"\n` +
    `  if not (exists window id ${wid}) then return "missing"\n` +
    `  return (visible of window id ${wid}) as string\n` +
    `end tell`;
  const out = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
    encoding: 'utf-8', timeout: 5000,
  }).trim();
  return out === 'true';
}

function waitForSessionWindowCreated(traceFile: string, timeoutMs: number): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (existsSync(traceFile)) {
        const lines = readFileSync(traceFile, 'utf-8').split('\n').filter(Boolean);
        for (const l of lines) {
          try {
            const ev = JSON.parse(l) as { event?: string; data?: { windowId?: unknown } };
            if (ev.event === 'session_window_created' && typeof ev.data?.windowId === 'number') {
              resolveP(ev.data.windowId);
              return;
            }
          } catch { /* skip malformed */ }
        }
      }
      if (Date.now() > deadline) {
        rejectP(new Error(`session_window_created not seen within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      rejectP(new Error(`Process ${proc.pid} did not exit within ${timeoutMs}ms after SIGTERM`));
    }, timeoutMs);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolveP({ code, signal });
    });
  });
}

describe('T10: SIGTERM/SIGINT signal handlers close session window', () => {
  it('sends SIGTERM → process exits → session window no longer visible in Safari', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'sp-t10-sigterm-'));
    const traceFile = join(traceDir, 'trace.ndjson');
    let proc: ChildProcess | null = null;
    let sessionWid: number | undefined;

    try {
      proc = spawn('node', [SERVER_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, SAFARI_PILOT_TRACE_DIR: traceDir },
      });
      // Swallow stderr/stdout so the server doesn't block on full pipe buffers.
      proc.stdout!.on('data', () => { /* drain */ });
      proc.stderr!.on('data', () => { /* drain */ });

      sessionWid = await waitForSessionWindowCreated(traceFile, 20000);
      expect(sessionWid).toBeGreaterThan(0);
      expect(safariWindowVisible(sessionWid), `window ${sessionWid} should be visible AFTER server start`).toBe(true);

      proc.kill('SIGTERM');
      const { code, signal } = await waitForExit(proc, 10000);
      // Exit code 143 = 128+SIGTERM, which our graceful handler sets. Accept
      // both 143 (handler ran) and signal=SIGTERM (in case Node reports via
      // signal rather than code on this platform).
      expect(code === 143 || signal === 'SIGTERM' || code === 0).toBe(true);

      // Post-shutdown: window must be gone. This is the assertion that fails
      // if the SIGTERM handler is reverted — Node's default SIGTERM handler
      // kills the process before our AppleScript close runs.
      expect(safariWindowVisible(sessionWid), `window ${sessionWid} must be INVISIBLE (closed) AFTER SIGTERM`).toBe(false);
      proc = null;
    } finally {
      // Defensive cleanup: if the test failed before SIGTERM completed, kill
      // the server and close the stray window so we don't leave orphans behind.
      if (proc && proc.exitCode === null) {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
      if (sessionWid !== undefined) {
        try {
          execSync(
            `osascript -e 'tell application "Safari" to if (exists window id ${sessionWid}) then close window id ${sessionWid}'`,
            { timeout: 3000 },
          );
        } catch { /* best effort */ }
      }
      rmSync(traceDir, { recursive: true, force: true });
    }
  }, 45000);

  it('sends SIGINT → process exits → session window no longer visible in Safari', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'sp-t10-sigint-'));
    const traceFile = join(traceDir, 'trace.ndjson');
    let proc: ChildProcess | null = null;
    let sessionWid: number | undefined;

    try {
      proc = spawn('node', [SERVER_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, SAFARI_PILOT_TRACE_DIR: traceDir },
      });
      proc.stdout!.on('data', () => {});
      proc.stderr!.on('data', () => {});

      sessionWid = await waitForSessionWindowCreated(traceFile, 20000);
      expect(safariWindowVisible(sessionWid)).toBe(true);

      proc.kill('SIGINT');
      const { code, signal } = await waitForExit(proc, 10000);
      expect(code === 130 || signal === 'SIGINT' || code === 0).toBe(true);

      expect(safariWindowVisible(sessionWid), `window ${sessionWid} must be INVISIBLE (closed) AFTER SIGINT`).toBe(false);
      proc = null;
    } finally {
      if (proc && proc.exitCode === null) { try { proc.kill('SIGKILL'); } catch {} }
      if (sessionWid !== undefined) {
        try {
          execSync(
            `osascript -e 'tell application "Safari" to if (exists window id ${sessionWid}) then close window id ${sessionWid}'`,
            { timeout: 3000 },
          );
        } catch {}
      }
      rmSync(traceDir, { recursive: true, force: true });
    }
  }, 45000);
});
