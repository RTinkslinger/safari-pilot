// bench/webvoyager/adapter.ts
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
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

function buildPrompt(task: WebVoyagerTask, agentScreenshotPath: string): string {
  return [
    `You are an autonomous browser agent driven by the safari-pilot MCP plugin.`,
    ``,
    `Task: ${task.question}`,
    `Starting URL: ${task.url}`,
    ``,
    `Steps:`,
    `1. Open a new tab to the starting URL using safari_new_tab. Remember the URL of the tab you opened (you'll need it in step 5).`,
    `2. Use safari_snapshot to orient on the page.`,
    `3. Use safari_tool_search if you need a capability not in your default tool list.`,
    `4. Solve the task. Use the simplest tool sequence that works.`,
    `5. CRITICAL — REQUIRED EVIDENCE STEP. Before answering, call safari_take_screenshot with arguments:`,
    `     { "tabUrl": "<the URL currently in your tab>", "path": "${agentScreenshotPath}" }`,
    `   The eval judge needs this screenshot to verify your answer. If you skip this step, the task will be marked UNKNOWN regardless of how good your textual answer is — wasting the entire run. Take the screenshot AFTER your final navigation and BEFORE giving the final answer.`,
    `6. End your response with: "${FINAL_ANSWER_MARKER} <your concise answer>"`,
    ``,
    `Do not ask for clarification — make your best attempt and answer.`,
    `Do not switch user-owned tabs. Operate only on tabs you opened.`,
    `Do NOT call safari_close_tab or safari_close_window. Do NOT navigate away from your final answer page after taking the screenshot. The harness cleans up tabs.`,
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
  const agentScreenshotPath = `/tmp/wv-AGENT-${sanitizeId(task.id)}-r${opts.runSeq}.png`;
  const prompt = buildPrompt(task, agentScreenshotPath);

  // Pre-unlink both paths BEFORE spawn so existsSync after the run correctly
  // reflects only what THIS run produced (not a stale file from a prior run
  // at the same deterministic path).
  try { unlinkSync(screenshotPath); } catch { /* not present — fine */ }
  try { unlinkSync(agentScreenshotPath); } catch { /* not present — fine */ }

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
  // Transcript write deferred until after the capture flow so the
  // CAPTURE_SOURCE marker appended to stderrBuf actually lands in the file.

  // Two-tier screenshot strategy (added 2026-05-08 after first overnight rerun
  // showed ~50% post-hoc capture-failure due to agents closing their own tabs
  // despite the prompt instruction):
  //
  // Tier 1 (preferred — true WebVoyager protocol): the agent self-captures
  // BEFORE answering. Prompt instructs the agent to call safari_take_screenshot
  // with the canonical agentScreenshotPath. If the file exists post-spawn, the
  // agent followed instructions and we have authoritative evidence.
  //
  // Tier 2 (fallback): post-hoc diff capture from the harness MCP. Works if
  // the agent left its tab open after exiting (some agents do). Fails when
  // the agent closed its own tab.
  //
  // Both paths are unlinked BEFORE the run so existsSync correctly detects
  // whether THIS run produced a file (vs. a stale file from a prior run at
  // the same deterministic path).
  let screenshotPathOrNull: string | null = screenshotPath;
  let captureErrorCode: string | undefined;
  let captureSource: 'agent' | 'posthoc' | 'none' = 'none';

  if (existsSync(agentScreenshotPath)) {
    // Tier 1: agent followed instructions — promote to canonical screenshotPath.
    try {
      copyFileSync(agentScreenshotPath, screenshotPath);
      try { unlinkSync(agentScreenshotPath); } catch { /* best-effort cleanup */ }
      captureSource = 'agent';
    } catch (e) {
      // Copy failed for some filesystem reason — treat as capture failure.
      screenshotPathOrNull = null;
      captureErrorCode = `AGENT_CAPTURE_COPY_FAILED:${(e as Error).message}`;
    }
  } else {
    // Tier 2: agent didn't self-capture — try post-hoc diff.
    try {
      await captureScreenshotPostHoc(tabSnapshot, screenshotPath);
      if (!existsSync(screenshotPath)) {
        screenshotPathOrNull = null;
        captureErrorCode = 'CAPTURE_NO_FILE';
      } else {
        captureSource = 'posthoc';
      }
    } catch (e) {
      screenshotPathOrNull = null;
      captureErrorCode = (e as Error & { code?: string }).code ?? 'CAPTURE_FAILED';
    }
  }
  // Persist captureSource into the transcript so post-mortem analysis can tally
  // tier-1 vs tier-2 ratios without re-running.
  stderrBuf += `\n=== CAPTURE_SOURCE: ${captureSource}${captureErrorCode ? ` (${captureErrorCode})` : ''} ===\n`;

  // Now write the transcript with the CAPTURE_SOURCE marker baked in.
  writeFileSync(
    join(opts.outDir, `${sanitizeId(task.id)}-r${opts.runSeq}.transcript.txt`),
    `EXIT=${exitCode}\nTIMED_OUT=${timedOut}\nWALL_MS=${wallMs}\n=== STDOUT ===\n${stdoutBuf}\n=== STDERR ===\n${stderrBuf}`,
  );

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
