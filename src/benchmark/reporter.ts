import { execFileSync } from 'child_process';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type {
  TaskResult,
  BenchmarkTask,
  RunReport,
  HistoryFile,
  CategoryResult,
  PerTaskSummary,
} from './types.js';

// ─── Internal Types ────────────────────────────────────────────────────────────

interface SkippedTask {
  task: BenchmarkTask;
  reason: string;
}

// ─── Math Helpers ─────────────────────────────────────────────────────────────

/**
 * Compute the p-th percentile of an already-sorted numeric array.
 * Uses nearest-rank method. Returns 0 for empty arrays.
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ─── Core Computation ─────────────────────────────────────────────────────────

/**
 * Aggregate raw TaskResults into a RunReport.
 *
 * - Counts passed/failed from non-skipped results
 * - Groups by category using a task lookup map
 * - Computes category rates, intelligence rate, competitive win rate
 * - Computes p50/p95 for duration across all eligible tasks
 * - Computes mean steps from successful tasks only
 * - Builds perTask summary map
 */
export function computeRunReport(
  runId: string,
  model: string,
  commit: string,
  branch: string,
  results: TaskResult[],
  tasks: BenchmarkTask[],
  skippedTasks: SkippedTask[]
): RunReport {
  // Build task lookup for category access
  const taskMap = new Map<string, BenchmarkTask>(tasks.map((t) => [t.id, t]));

  // Eligible = tasks that ran (not skipped)
  const eligible = results.filter((r) => !r.skipped);
  const passed = eligible.filter((r) => r.success).length;
  const failed = eligible.filter((r) => !r.success).length;
  const overallRate = eligible.length > 0 ? passed / eligible.length : 0;

  // Per-category aggregation
  const categoryBuckets = new Map<string, { passed: number; failed: number; skipped: number }>();
  for (const result of eligible) {
    const task = taskMap.get(result.taskId);
    const cat = task?.category ?? 'unknown';
    if (!categoryBuckets.has(cat)) {
      categoryBuckets.set(cat, { passed: 0, failed: 0, skipped: 0 });
    }
    const bucket = categoryBuckets.get(cat)!;
    if (result.success) {
      bucket.passed++;
    } else {
      bucket.failed++;
    }
  }
  // Also add skipped task categories
  for (const { task } of skippedTasks) {
    const cat = task.category;
    if (!categoryBuckets.has(cat)) {
      categoryBuckets.set(cat, { passed: 0, failed: 0, skipped: 0 });
    }
    categoryBuckets.get(cat)!.skipped++;
  }

  const byCategory: Record<string, CategoryResult> = {};
  for (const [cat, bucket] of categoryBuckets) {
    const total = bucket.passed + bucket.failed;
    byCategory[cat] = {
      passed: bucket.passed,
      failed: bucket.failed,
      skipped: bucket.skipped,
      rate: total > 0 ? bucket.passed / total : 0,
    };
  }

  // Intelligence rate (category 'intelligence' only)
  const intelligenceResults = eligible.filter((r) => taskMap.get(r.taskId)?.category === 'intelligence');
  const intelligenceRate =
    intelligenceResults.length > 0
      ? intelligenceResults.filter((r) => r.success).length / intelligenceResults.length
      : 0;

  // Competitive win rate — set to 0 here, runner overwrites with actual head-to-head results
  const competitiveWinRate = 0;

  // Duration percentiles
  const durations = eligible.map((r) => r.durationMs).sort((a, b) => a - b);
  const p50DurationMs = percentile(durations, 50);
  const p95DurationMs = percentile(durations, 95);

  // Mean steps from successful tasks
  const successfulResults = eligible.filter((r) => r.success);
  const meanSteps =
    successfulResults.length > 0
      ? successfulResults.reduce((sum, r) => sum + r.steps, 0) / successfulResults.length
      : 0;

  // Per-task summary
  const perTask: Record<string, PerTaskSummary> = {};
  for (const result of eligible) {
    perTask[result.taskId] = {
      passed: result.success,
      steps: result.steps,
      durationMs: result.durationMs,
    };
  }

  return {
    id: runId,
    model,
    commit,
    branch,
    timestamp: new Date().toISOString(),
    eligible: eligible.length,
    skipped: skippedTasks.length,
    passed,
    failed,
    overallRate,
    byCategory,
    intelligenceRate,
    competitiveWinRate,
    competitive: [],
    meanSteps,
    p50DurationMs,
    p95DurationMs,
    flakyCount: 0,
    perTask,
  };
}

// ─── Delta Formatting ─────────────────────────────────────────────────────────

/**
 * Format a rate delta between current and previous run.
 * Returns "+X.X%" / "-X.X%" for real deltas, "baseline" when no previous run,
 * or "--" when the category didn't exist in the previous run.
 */
function formatDelta(currentRate: number, previousRate: number | null): string {
  if (previousRate === null) return 'baseline';
  const diff = (currentRate - previousRate) * 100;
  if (diff === 0) return '±0.0%';
  const sign = diff > 0 ? '+' : '';
  return `${sign}${diff.toFixed(1)}%`;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/**
 * Generate a markdown benchmark report with optional delta against a previous run.
 *
 * Sections:
 * - Header (run ID, model, commit, branch, timestamp)
 * - Overall pass rate + delta
 * - Category table (Pass, Rate, Delta)
 * - Intelligence tier
 * - Efficiency (mean steps, p50, p95)
 * - Skipped tasks (if any)
 */
export function generateDeltaReport(
  current: RunReport,
  previous: RunReport | null,
  skipped: SkippedTask[],
  results?: TaskResult[],
): string {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────────
  lines.push('# Safari Pilot Benchmark Report');
  lines.push('');
  lines.push(`**Run:** ${current.id}`);
  lines.push(`**Model:** ${current.model}`);
  lines.push(`**Commit:** \`${current.commit}\``);
  lines.push(`**Branch:** ${current.branch}`);
  lines.push(`**Timestamp:** ${current.timestamp}`);
  lines.push('');

  // ── Overall ─────────────────────────────────────────────────────────────────
  const overallDelta = previous !== null
    ? formatDelta(current.overallRate, previous.overallRate)
    : 'baseline';
  const overallRateStr = formatRate(current.overallRate);
  lines.push(`## Overall: ${overallRateStr} (${overallDelta})`);
  lines.push('');
  lines.push(`- Eligible: **${current.eligible}**`);
  lines.push(`- Passed: **${current.passed}**`);
  lines.push(`- Failed: **${current.failed}**`);
  lines.push(`- Skipped: **${current.skipped}**`);
  lines.push('');

  // ── Category Table ───────────────────────────────────────────────────────────
  lines.push('## By Category');
  lines.push('');
  lines.push('| Category | Pass | Rate | Delta |');
  lines.push('|----------|------|------|-------|');

  const categories = Object.keys(current.byCategory).sort();
  for (const cat of categories) {
    const catResult = current.byCategory[cat];
    const prevRate = previous?.byCategory[cat]?.rate ?? null;
    const delta = formatDelta(catResult.rate, prevRate === null && previous !== null ? 0 : prevRate);
    lines.push(
      `| ${cat} | ${catResult.passed}/${catResult.passed + catResult.failed} | ${formatRate(catResult.rate)} | ${delta} |`
    );
  }
  lines.push('');

  // ── Intelligence Tier ────────────────────────────────────────────────────────
  if (current.intelligenceRate > 0 || current.byCategory['intelligence']) {
    const intelDelta = previous !== null
      ? formatDelta(current.intelligenceRate, previous.intelligenceRate)
      : 'baseline';
    lines.push('## Intelligence Tier');
    lines.push('');
    lines.push(`Pass rate: **${formatRate(current.intelligenceRate)}** (${intelDelta})`);
    lines.push('');
  }

  // ── Efficiency ───────────────────────────────────────────────────────────────
  lines.push('## Efficiency');
  lines.push('');
  lines.push(`- Mean steps (successful): **${current.meanSteps.toFixed(1)}**`);
  lines.push(`- p50 duration: **${formatMs(current.p50DurationMs)}**`);
  lines.push(`- p95 duration: **${formatMs(current.p95DurationMs)}**`);
  lines.push('');

  // ── Skipped Tasks ────────────────────────────────────────────────────────────
  if (skipped.length > 0) {
    lines.push('## Skipped Tasks');
    lines.push('');
    lines.push('| Task ID | Reason |');
    lines.push('|---------|--------|');
    for (const { task, reason } of skipped) {
      lines.push(`| ${task.id} | ${reason} |`);
    }
    lines.push('');
  }

  // ── Architecture Report ────────────────────────────────────────────────────
  if (results && results.length > 0) {
    lines.push('## Architecture Report');
    lines.push('');

    // Engine usage across all tasks
    const globalEngineUsage: Record<string, number> = {};
    for (const r of results) {
      for (const [engine, count] of Object.entries(r.enginesUsed)) {
        globalEngineUsage[engine] = (globalEngineUsage[engine] ?? 0) + count;
      }
    }

    const totalToolCalls = Object.values(globalEngineUsage).reduce((s, n) => s + n, 0);

    lines.push('### Engine Usage');
    lines.push('');
    lines.push('| Engine | Tool Calls | % of Total |');
    lines.push('|--------|-----------|------------|');
    for (const [engine, count] of Object.entries(globalEngineUsage).sort((a, b) => b[1] - a[1])) {
      const pct = totalToolCalls > 0 ? ((count / totalToolCalls) * 100).toFixed(1) : '0';
      lines.push(`| ${engine} | ${count} | ${pct}% |`);
    }
    lines.push(`| **Total** | **${totalToolCalls}** | |`);
    lines.push('');

    // Per-task architecture breakdown
    lines.push('### Per-Task Code Flow');
    lines.push('');
    lines.push('| Task | Result | Steps | Engines Used | Duration |');
    lines.push('|------|--------|-------|-------------|----------|');
    for (const r of results.filter(t => !t.skipped)) {
      const result = r.success ? 'PASS' : 'FAIL';
      const engines = Object.entries(r.enginesUsed)
        .map(([e, c]) => `${e}(${c})`)
        .join(', ') || 'none';
      lines.push(`| ${r.taskId} | ${result} | ${r.steps} | ${engines} | ${formatMs(r.durationMs)} |`);
    }
    lines.push('');

    // Architecture compliance summary
    const usedApplescriptOnly = results.filter(r =>
      !r.skipped && Object.keys(r.enginesUsed).length === 1 && r.enginesUsed['applescript'] > 0
    );
    const usedDaemon = results.filter(r => !r.skipped && (r.enginesUsed['daemon'] ?? 0) > 0);
    const usedExtension = results.filter(r => !r.skipped && (r.enginesUsed['extension'] ?? 0) > 0);

    lines.push('### Architecture Compliance');
    lines.push('');
    lines.push(`- Tasks using Extension engine: **${usedExtension.length}** / ${results.filter(r => !r.skipped).length}`);
    lines.push(`- Tasks using Daemon engine: **${usedDaemon.length}** / ${results.filter(r => !r.skipped).length}`);
    lines.push(`- Tasks using AppleScript only: **${usedApplescriptOnly.length}** / ${results.filter(r => !r.skipped).length}`);
    lines.push(`- Total tool calls tracked: **${totalToolCalls}**`);
    lines.push('');

    if (usedExtension.length === 0 && totalToolCalls > 0) {
      lines.push('> **WARNING:** No tasks used the Extension engine. The three-tier architecture is not being exercised.');
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Flakiness Detection ──────────────────────────────────────────────────────

/**
 * Determine if a task is flaky across run history.
 *
 * A task is flaky if its pass ratio across at least 2 data points falls
 * strictly between 0.2 and 0.8 (i.e., it neither consistently passes nor fails).
 */
export function computeFlakiness(runs: RunReport[], taskId: string): boolean {
  const dataPoints = runs
    .filter((r) => taskId in r.perTask)
    .map((r) => (r.perTask[taskId].passed ? 1 : 0));

  if (dataPoints.length < 2) return false;

  const passRatio = dataPoints.reduce((sum: number, v) => sum + v, 0) / dataPoints.length;
  return passRatio > 0.2 && passRatio < 0.8;
}

// ─── History I/O ──────────────────────────────────────────────────────────────

/**
 * Load the history JSON file. Returns { runs: [] } on any read/parse error.
 */
export async function loadHistory(historyPath: string): Promise<HistoryFile> {
  try {
    const raw = await readFile(historyPath, 'utf-8');
    const parsed = JSON.parse(raw) as HistoryFile;
    if (!Array.isArray(parsed.runs)) return { runs: [] };
    return parsed;
  } catch {
    return { runs: [] };
  }
}

/**
 * Persist the history file as formatted JSON.
 */
const MAX_HISTORY_RUNS = 20;

export async function saveHistory(historyPath: string, history: HistoryFile): Promise<void> {
  if (history.runs.length > MAX_HISTORY_RUNS) {
    history.runs = history.runs.slice(-MAX_HISTORY_RUNS);
  }
  await writeFile(historyPath, JSON.stringify(history, null, 2), 'utf-8');
}

/**
 * Write the markdown report to `reportsDir/<runId>.md` and return the full path.
 * Creates the directory if it doesn't exist.
 */
export async function saveReport(
  reportsDir: string,
  report: RunReport,
  markdown: string
): Promise<string> {
  await mkdir(reportsDir, { recursive: true });
  const filePath = join(reportsDir, `${report.id}.md`);
  await writeFile(filePath, markdown, 'utf-8');
  return filePath;
}

// ─── Git Info ─────────────────────────────────────────────────────────────────

/**
 * Read the current git commit hash and branch name.
 * Falls back to 'unknown' if git is unavailable or the directory is not a repo.
 */
export function getGitInfo(): { commit: string; branch: string } {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8' }).trim();
    return { commit, branch };
  } catch {
    return { commit: 'unknown', branch: 'unknown' };
  }
}
