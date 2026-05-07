// bench/webvoyager/adapter.ts
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebVoyagerTask } from './types.js';
import {
  captureScreenshotPostHoc,
  cleanupNewTabs,
  snapshotExistingTabs,
} from './mcp-direct.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

export interface RunOptions {
  variant: string;
  outDir: string;
  runSeq: number;
  timeoutMs?: number;
}

export interface RawAdapterResult {
  task_id: string;
  agent_final_text: string;
  screenshot_path: string | null;
  capture_error_code?: string;
  wall_ms: number;
  exit_code: number;
  stderr_tail: string;
}

const FINAL_ANSWER_MARKER = 'FINAL_ANSWER:';

function buildPrompt(task: WebVoyagerTask): string {
  return [
    `You are an autonomous browser agent driven by the safari-pilot MCP plugin.`,
    ``,
    `Task: ${task.question}`,
    `Starting URL: ${task.url}`,
    ``,
    `Steps:`,
    `1. Open a new tab to the starting URL using safari_new_tab.`,
    `2. Use safari_snapshot to orient on the page.`,
    `3. Use safari_tool_search if you need a capability not in your default tool list.`,
    `4. Solve the task. Use the simplest tool sequence that works.`,
    `5. End your response with: "${FINAL_ANSWER_MARKER} <your concise answer>"`,
    ``,
    `Do not ask for clarification — make your best attempt and answer.`,
    `Do not switch user-owned tabs. Operate only on tabs you opened.`,
    `Do NOT close your tab — the harness will clean up after evaluation.`,
  ].join('\n');
}

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

function extractFinalAnswer(out: string): string {
  const idx = out.lastIndexOf(FINAL_ANSWER_MARKER);
  if (idx === -1) {
    return out.slice(-500).trim();
  }
  return out.slice(idx + FINAL_ANSWER_MARKER.length).trim();
}

export async function runWebVoyagerTask(
  task: WebVoyagerTask,
  opts: RunOptions,
): Promise<RawAdapterResult> {
  const screenshotPath = `/tmp/wv-${sanitizeId(task.id)}-r${opts.runSeq}.png`;
  const prompt = buildPrompt(task);

  // Pre-spawn snapshot — anything new after exit is the agent's
  const tabSnapshot = await snapshotExistingTabs();
  const startedAt = Date.now();

  let stderrBuf = '';
  let stdoutBuf = '';

  const child = spawn(
    'claude',
    ['--dangerously-skip-permissions', '-p', prompt],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: REPO_ROOT,                    // REQUIRED so claude -p picks up project .mcp.json
      env: {
        ...process.env,
        // Skip session-window creation in agent MCP server (claude -p inherits this env);
        // the agent only opens its task tab, no extra UX window to leak.
        SAFARI_PILOT_NO_SESSION_WINDOW: '1',
      },
    },
  );
  child.stdout.on('data', (b: Buffer) => { stdoutBuf += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { stderrBuf += b.toString(); });

  let timedOut = false;
  const exitCode: number = await new Promise((resolveExit) => {
    const t = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, opts.timeoutMs ?? 240_000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolveExit(code ?? -1);
    });
  });

  const wallMs = Date.now() - startedAt;
  const finalText = extractFinalAnswer(stdoutBuf);

  writeFileSync(
    join(opts.outDir, `${sanitizeId(task.id)}-r${opts.runSeq}.transcript.txt`),
    `EXIT=${exitCode}\nTIMED_OUT=${timedOut}\nWALL_MS=${wallMs}\n=== STDOUT ===\n${stdoutBuf}\n=== STDERR ===\n${stderrBuf}`,
  );

  // Post-hoc screenshot (independent of agent compliance) — uses the diff set.
  // Wrap in try/catch + existsSync so capture failures surface as null screenshot_path
  // rather than throwing through the harness or producing a phantom path that the
  // judge would later try to read.
  let screenshotPathOrNull: string | null = screenshotPath;
  let captureErrorCode: string | undefined;
  // Delete any stale file at the screenshot path BEFORE capture. The path is
  // deterministic per (task_id, run_seq), so a prior run (e.g. the halted
  // 2026-05-07 broken-screenshot partial run) may have left a file at this
  // exact path. Without the unlink, captureScreenshotPostHoc not firing (e.g.
  // empty diff because the agent closed its own tab) leaves the stale file in
  // place; existsSync passes, screenshot_path resolves to garbage from the
  // previous run, and the judge gets fed unrelated content. Unlink ensures
  // the existsSync check correctly reflects whether THIS run wrote a file.
  try { unlinkSync(screenshotPath); } catch { /* not present — fine */ }
  try {
    await captureScreenshotPostHoc(tabSnapshot, screenshotPath);
    if (!existsSync(screenshotPath)) {
      screenshotPathOrNull = null;
      captureErrorCode = 'CAPTURE_NO_FILE';
    }
  } catch (e) {
    screenshotPathOrNull = null;
    captureErrorCode = (e as Error & { code?: string }).code ?? 'CAPTURE_FAILED';
  }

  // Clean up only tabs that appeared during this run
  await cleanupNewTabs(tabSnapshot);

  return {
    task_id: task.id,
    agent_final_text: finalText,
    screenshot_path: screenshotPathOrNull,
    capture_error_code: captureErrorCode,
    wall_ms: wallMs,
    exit_code: exitCode,
    stderr_tail: stderrBuf.slice(-2000),
  };
}
