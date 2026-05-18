/**
 * Bug-2 (2026-05-18 evening) — stdio EOF closes session window before exit
 *
 * DISCRIMINATING ASSERTION:
 *   Pre-fix: `process.on('SIGTERM' | 'SIGINT')` are wired in src/index.ts,
 *   but the MCP stdio transport's close event is NOT. When claude exits
 *   normally, it closes its stdio pipe to this server — no signal is sent.
 *   Node drains the event loop and exits, bypassing `gracefulShutdown` →
 *   `closeSessionWindow()`. The session window leaks. Verified empirically
 *   in the 2026-05-18 22:53 IST per-window smoke (Allrecipes--0): after
 *   `claude` exited cleanly, `count windows` returned 1 with the
 *   dashboard tab still open.
 *
 *   Post-fix: src/index.ts wires StdioServerTransport's onclose event
 *   (or the underlying stdin 'end' event) to `gracefulShutdown('STDIO_EOF')`.
 *   The session window is closed before the process exits.
 *
 * Test mechanics mirror signal-shutdown.test.ts (the SIGTERM analogue):
 * spawn `node dist/index.js`, wait for session_window_created trace, close
 * stdin instead of sending a signal, then assert window invisibility.
 *
 * Standalone (no McpTestClient) because this test exercises a process
 * lifecycle event the harness never triggers cleanly. Uses isolated
 * SAFARI_PILOT_TRACE_DIR to read only this spawn's trace events.
 */
import { describe, it, expect } from 'vitest';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SERVER_PATH = resolve(__dirname, '../../dist/index.js');

/** Same helper as signal-shutdown.test.ts — see that file for the Safari
 * `visible of window` quirk. */
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
    const tick = (): void => {
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

function waitForExit(
  proc: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      rejectP(new Error(`Process ${proc.pid} did not exit within ${timeoutMs}ms after stdin close`));
    }, timeoutMs);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolveP({ code, signal });
    });
  });
}

describe('stdio EOF → graceful shutdown closes session window', () => {
  it('closes stdin → process exits → session window no longer visible in Safari', async () => {
    const traceDir = mkdtempSync(join(tmpdir(), 'sp-stdio-eof-'));
    const traceFile = join(traceDir, 'trace.ndjson');
    let proc: ChildProcess | null = null;
    let sessionWid: number | undefined;

    try {
      proc = spawn('node', [SERVER_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, SAFARI_PILOT_TRACE_DIR: traceDir },
      });
      proc.stdout!.on('data', () => { /* drain */ });
      proc.stderr!.on('data', () => { /* drain */ });

      sessionWid = await waitForSessionWindowCreated(traceFile, 20000);
      expect(sessionWid).toBeGreaterThan(0);
      expect(
        safariWindowVisible(sessionWid),
        `window ${sessionWid} should be visible AFTER server start`,
      ).toBe(true);

      // The behavior under test: closing stdin signals EOF to the MCP
      // stdio transport. Post-fix, this triggers gracefulShutdown.
      // Pre-fix, Node drains and exits without running shutdown.
      proc.stdin!.end();

      const { code, signal } = await waitForExit(proc, 10000);
      // Acceptable exit shapes: 143 (our graceful path), 0 (clean drain),
      // or platform-reported signal. The discriminating check is the
      // window state below, not the exit code.
      expect(code !== null || signal !== null).toBe(true);

      // The actual TDD discriminator. Pre-fix this fails — the window
      // remains visible because closeSessionWindow never ran.
      expect(
        safariWindowVisible(sessionWid),
        `window ${sessionWid} must be INVISIBLE (closed) AFTER stdin EOF`,
      ).toBe(false);
      proc = null;
    } finally {
      if (proc !== null) {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }
      if (sessionWid !== undefined && safariWindowVisible(sessionWid)) {
        // Belt-and-suspenders — never leave a session window behind from
        // a failed test run (would pollute the next spawn's orphan sweep).
        try {
          execSync(
            `osascript -e 'tell application "Safari" to if (exists window id ${sessionWid}) then close window id ${sessionWid}'`,
            { timeout: 3000 },
          );
        } catch { /* ignore */ }
      }
      try { rmSync(traceDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 60_000);
});
