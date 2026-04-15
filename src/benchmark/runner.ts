#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BenchmarkTask,
  RunConfig,
  TaskResult,
  CompetitiveResult,
  PreflightResult,
} from './types.js';
import { loadTasks, filterTasks } from './task-loader.js';
import { executeTask, getDefaultMcpConfig, cleanupMcpConfig } from './worker.js';
import {
  computeRunReport,
  generateDeltaReport,
  loadHistory,
  saveHistory,
  saveReport,
  getGitInfo,
} from './reporter.js';
import { FixtureServer } from './fixture-server.js';

// ─── Path Constants ───────────────────────────────────────────────────────────
// import.meta.dirname resolves to dist/benchmark/ when compiled — two levels up
// reaches the project root.

const PROJECT_ROOT = join(import.meta.dirname, '../..');
const BENCHMARK_DIR = join(PROJECT_ROOT, 'benchmark');
const TASKS_DIR = join(BENCHMARK_DIR, 'tasks');
const FIXTURES_DIR = join(BENCHMARK_DIR, 'fixtures');
const TRACES_DIR = join(BENCHMARK_DIR, 'traces');
const REPORTS_DIR = join(BENCHMARK_DIR, 'reports');
const HISTORY_PATH = join(BENCHMARK_DIR, 'history.json');
const SAFARI_MCP = join(BENCHMARK_DIR, 'mcp-configs/safari-only.json');
const PLAYWRIGHT_MCP = join(BENCHMARK_DIR, 'mcp-configs/playwright-only.json');

// ─── Hardcoded Tool Inventory (v1 Preflight) ──────────────────────────────────
// All tools currently shipped in src/tools/ plus safari_health_check from server.ts.
// This list is used for the simplified v1 preflight check.

const ALL_SAFARI_TOOLS: string[] = [
  'safari_health_check',
  'safari_navigate',
  'safari_navigate_back',
  'safari_navigate_forward',
  'safari_reload',
  'safari_new_tab',
  'safari_close_tab',
  'safari_list_tabs',
  'safari_click',
  'safari_double_click',
  'safari_hover',
  'safari_drag',
  'safari_fill',
  'safari_type',
  'safari_press_key',
  'safari_scroll',
  'safari_select_option',
  'safari_get_text',
  'safari_get_html',
  'safari_get_attribute',
  'safari_snapshot',
  'safari_take_screenshot',
  'safari_extract_links',
  'safari_extract_images',
  'safari_extract_metadata',
  'safari_extract_tables',
  'safari_smart_scrape',
  'safari_paginate_scrape',
  'safari_evaluate',
  'safari_handle_dialog',
  'safari_wait_for',
  'safari_monitor_page',
  'safari_get_network_request',
  'safari_list_network_requests',
  'safari_intercept_requests',
  'safari_mock_request',
  'safari_websocket_listen',
  'safari_websocket_filter',
  'safari_network_offline',
  'safari_network_throttle',
  'safari_get_cookies',
  'safari_set_cookie',
  'safari_delete_cookie',
  'safari_local_storage_get',
  'safari_local_storage_set',
  'safari_session_storage_get',
  'safari_session_storage_set',
  'safari_storage_state_export',
  'safari_storage_state_import',
  'safari_idb_get',
  'safari_idb_list',
  'safari_get_page_metrics',
  'safari_begin_trace',
  'safari_end_trace',
  'safari_get_console_messages',
  'safari_list_frames',
  'safari_switch_frame',
  'safari_eval_in_frame',
  'safari_query_shadow',
  'safari_click_shadow',
  'safari_permission_get',
  'safari_permission_set',
  'safari_override_geolocation',
  'safari_override_timezone',
  'safari_override_locale',
  'safari_override_useragent',
  'safari_clipboard_read',
  'safari_clipboard_write',
  'safari_media_control',
  'safari_sw_list',
  'safari_sw_unregister',
  'safari_check',
  'safari_test_flow',
];

// ─── Local Types ──────────────────────────────────────────────────────────────

export interface WorkerSlot {
  windowIndex: number;
  queue: BenchmarkTask[];
}

// ─── parseArgs ────────────────────────────────────────────────────────────────

export function parseArgs(argv: string[]): RunConfig {
  const models: string[] = ['sonnet'];
  let parallel = 3;
  const categories: string[] = [];
  const taskIds: string[] = [];
  let competitive = false;
  let dryRun = false;
  let timeoutMultiplier = 1;
  const fixturePort = 9876;

  const args = argv.slice(2); // strip node + script path
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--model':
        i++;
        if (i < args.length) {
          models.splice(0, models.length, ...args[i].split(',').map((m) => m.trim()));
        }
        break;
      case '--parallel':
        i++;
        if (i < args.length) {
          const n = parseInt(args[i], 10);
          if (!isNaN(n) && n > 0) parallel = n;
        }
        break;
      case '--category':
        i++;
        if (i < args.length) {
          categories.push(...args[i].split(',').map((c) => c.trim()));
        }
        break;
      case '--task':
        i++;
        if (i < args.length) {
          taskIds.push(...args[i].split(',').map((t) => t.trim()));
        }
        break;
      case '--competitive':
        competitive = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--timeout-multiplier':
        i++;
        if (i < args.length) {
          const n = parseFloat(args[i]);
          if (!isNaN(n) && n > 0) timeoutMultiplier = n;
        }
        break;
      default:
        // ignore unknown flags
        break;
    }
    i++;
  }

  return {
    models,
    parallel,
    categories: categories as RunConfig['categories'],
    taskIds,
    competitive,
    dryRun,
    timeoutMultiplier,
    fixturePort,
  };
}

// ─── distributeTasksToWorkers ─────────────────────────────────────────────────

/**
 * Groups tasks by domain (hostname from start_url, or 'local' for fixture/localhost
 * tasks), then distributes domain groups across N WorkerSlots using a least-loaded
 * strategy. Each slot gets a windowIndex and a sequential task queue.
 */
export function distributeTasksToWorkers(
  tasks: BenchmarkTask[],
  parallel: number
): WorkerSlot[] {
  const count = Math.max(1, parallel);

  // Group tasks by domain
  const byDomain = new Map<string, BenchmarkTask[]>();
  for (const task of tasks) {
    let domain = 'local';
    if (task.start_url) {
      try {
        const url = new URL(task.start_url);
        const hostname = url.hostname;
        // Treat localhost/127.0.0.1 as local
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
          domain = 'local';
        } else {
          domain = hostname;
        }
      } catch {
        domain = 'local';
      }
    }
    const existing = byDomain.get(domain) ?? [];
    existing.push(task);
    byDomain.set(domain, existing);
  }

  // Initialise N slots
  const slots: WorkerSlot[] = Array.from({ length: count }, (_, i) => ({
    windowIndex: i + 1,
    queue: [],
  }));

  // Distribute each domain group to the least-loaded slot
  for (const domainTasks of byDomain.values()) {
    // Find the slot with the fewest queued tasks
    const target = slots.reduce((min, slot) =>
      slot.queue.length < min.queue.length ? slot : min
    );
    target.queue.push(...domainTasks);
  }

  return slots;
}

// ─── replaceFixturePort ───────────────────────────────────────────────────────

/**
 * Replace the default fixture port (9876) in a start_url with the actual
 * port assigned by the FixtureServer. Returns the url unchanged if it doesn't
 * reference localhost:9876.
 */
function replaceFixturePort(url: string, actualPort: number): string {
  return url.replace(/localhost:9876/g, `localhost:${actualPort}`);
}

// ─── runModel ─────────────────────────────────────────────────────────────────

interface ModelRunResult {
  results: TaskResult[];
  competitive: CompetitiveResult[];
}

export async function runModel(
  model: string,
  eligible: BenchmarkTask[],
  skipped: Array<{ task: BenchmarkTask; reason: string }>,
  config: RunConfig,
  fixturePort: number
): Promise<ModelRunResult> {
  const allResults: TaskResult[] = [];
  const competitiveResults: CompetitiveResult[] = [];

  // Map tasks replacing fixture ports
  const resolvedTasks: BenchmarkTask[] = eligible.map((task) => {
    if (!task.start_url) return task;
    return { ...task, start_url: replaceFixturePort(task.start_url, fixturePort) };
  });

  const total = resolvedTasks.length;
  let completed = 0;
  let passed = 0;
  let failed = 0;

  const slots = distributeTasksToWorkers(resolvedTasks, config.parallel);

  // Build a shared progress counter (mutation safe in single-threaded Node.js)
  const printProgress = (label: string, success: boolean, taskId: string): void => {
    completed++;
    if (success) passed++;
    else failed++;
    const status = success ? 'PASS' : 'FAIL';
    process.stdout.write(
      `[${model}] ${completed}/${total} tasks (${status}: ${taskId})\n`
    );
  };

  // Process all slots in parallel; within each slot tasks run sequentially
  await Promise.all(
    slots.map(async (slot) => {
      for (const task of slot.queue) {
        const result = await executeTask(
          task,
          model,
          slot.windowIndex,
          getDefaultMcpConfig(),
          config.timeoutMultiplier
        );
        allResults.push(result);
        printProgress(model, result.success, task.id);

        // Competitive: also run with Playwright config if task requires it and
        // config has competitive mode enabled
        if (config.competitive && task.requires.competitive) {
          const pwResult = await executeTask(
            task,
            model,
            slot.windowIndex,
            PLAYWRIGHT_MCP,
            config.timeoutMultiplier
          );

          const spOk = result.success;
          const pwOk = pwResult.success;

          let winner: CompetitiveResult['winner'];
          if (spOk && !pwOk) {
            winner = 'safari-pilot';
          } else if (!spOk && pwOk) {
            winner = 'playwright';
          } else if (spOk && pwOk) {
            winner = 'tie';
          } else {
            winner = 'both-failed';
          }

          competitiveResults.push({
            taskId: task.id,
            safariPilotSuccess: spOk,
            safariPilotSteps: result.steps,
            safariPilotDurationMs: result.durationMs,
            playwrightSuccess: pwOk,
            playwrightSteps: pwResult.steps,
            playwrightDurationMs: pwResult.durationMs,
            winner,
          });
        }
      }
    })
  );

  // Print per-model summary line
  const rate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';
  process.stdout.write(
    `[${model}] Done — ${passed}/${total} passed (${rate}%), ${skipped.length} skipped\n`
  );

  return { results: allResults, competitive: competitiveResults };
}

// ─── generateRunId ────────────────────────────────────────────────────────────

function generateRunId(model: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  // Base36 timestamp for compactness
  const ts = Date.now().toString(36);
  // Normalise model name: strip vendor prefix and version tags for brevity
  const shortModel = model.split('-').slice(-2).join('-').replace(/[^a-z0-9]/gi, '');
  return `bench-${date}-${shortModel}-${ts}`;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = parseArgs(process.argv);

  console.log('╔══════════════════════════════════════════╗');
  console.log('║        Safari Pilot Benchmark Suite       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Models:   ${config.models.join(', ')}`);
  console.log(`Parallel: ${config.parallel} workers`);
  if (config.categories.length > 0) {
    console.log(`Categories: ${config.categories.join(', ')}`);
  }
  if (config.taskIds.length > 0) {
    console.log(`Tasks: ${config.taskIds.join(', ')}`);
  }
  console.log(`Competitive: ${config.competitive}`);
  console.log(`Dry-run: ${config.dryRun}`);
  console.log('');

  // Load tasks
  const { tasks, errors } = await loadTasks(TASKS_DIR);
  if (errors.length > 0) {
    console.warn(`Task load warnings (${errors.length}):`);
    for (const e of errors) {
      console.warn(`  ${e}`);
    }
  }
  console.log(`Loaded ${tasks.length} tasks from ${TASKS_DIR}`);

  // Build v1 preflight — hardcoded: all basic tools available, applescript+daemon healthy,
  // no auth domains needed, competitiveReady from config flag.
  const preflight: PreflightResult = {
    availableTools: ALL_SAFARI_TOOLS,
    healthyEngines: ['applescript', 'daemon'],
    authenticatedDomains: [],
    competitiveReady: config.competitive,
    fixtureServerRunning: false, // will be updated after fixture server starts
  };

  // Filter tasks
  const { eligible, skipped } = filterTasks(
    tasks,
    preflight,
    config.categories.length > 0 ? config.categories : null,
    config.taskIds.length > 0 ? config.taskIds : null
  );

  console.log(`Eligible: ${eligible.length}  Skipped: ${skipped.length}`);
  console.log('');

  // Dry-run mode — print and exit
  if (config.dryRun) {
    console.log('=== DRY RUN ===');
    console.log('');
    if (eligible.length > 0) {
      console.log('Eligible tasks:');
      for (const task of eligible) {
        console.log(`  [${task.category}] ${task.id} — ${task.intent}`);
      }
      console.log('');
    }
    if (skipped.length > 0) {
      console.log('Skipped tasks:');
      for (const { task, reason } of skipped) {
        console.log(`  [${task.category}] ${task.id} — ${reason}`);
      }
      console.log('');
    }
    return;
  }

  if (eligible.length === 0) {
    console.log('No eligible tasks. Exiting.');
    return;
  }

  // Generate MCP config with absolute paths for Safari Pilot server
  const safariMcpConfig = getDefaultMcpConfig();
  console.log(`MCP config: ${safariMcpConfig}`);

  // Start fixture server if any eligible task uses localhost
  let fixtureServer: FixtureServer | null = null;
  let fixturePort = config.fixturePort;

  const needsFixture = eligible.some(
    (t) => t.start_url && t.start_url.includes('localhost')
  );
  if (needsFixture) {
    fixtureServer = new FixtureServer(FIXTURES_DIR, config.fixturePort);
    fixturePort = await fixtureServer.start();
    console.log(`Fixture server started on port ${fixturePort}`);
  }

  const { commit, branch } = getGitInfo();
  const history = await loadHistory(HISTORY_PATH);

  try {
    for (const model of config.models) {
      console.log(`\n─── Model: ${model} ───────────────────────────────────`);

      const runId = generateRunId(model);

      const { results, competitive } = await runModel(
        model,
        eligible,
        skipped,
        config,
        fixturePort
      );

      const report = computeRunReport(
        runId,
        model,
        commit,
        branch,
        results,
        eligible,
        skipped
      );

      // Attach competitive results
      if (competitive.length > 0) {
        report.competitive = competitive;
        // Compute competitive win rate from head-to-head results
        const spWins = competitive.filter((c) => c.winner === 'safari-pilot').length;
        report.competitiveWinRate =
          competitive.length > 0 ? spWins / competitive.length : 0;
      }

      // Find last run for this model in history for delta comparison
      const previousRun =
        history.runs
          .filter((r) => r.model === model)
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0] ??
        null;

      const markdown = generateDeltaReport(report, previousRun, skipped, results);

      const reportPath = await saveReport(REPORTS_DIR, report, markdown);
      console.log(`Report saved: ${reportPath}`);

      // Append to history and persist
      history.runs.push(report);
      await saveHistory(HISTORY_PATH, history);

      // Write per-task trace files
      const tracesRunDir = join(TRACES_DIR, runId);
      await mkdir(tracesRunDir, { recursive: true });

      for (const result of results) {
        const traceFile = join(tracesRunDir, `${result.taskId}.json`);
        await writeFile(traceFile, JSON.stringify(result, null, 2), 'utf-8');
      }

      // Print summary
      const rate = (report.overallRate * 100).toFixed(1);
      const deltaPart =
        previousRun !== null
          ? ` (prev: ${(previousRun.overallRate * 100).toFixed(1)}%)`
          : ' (baseline)';
      console.log('');
      console.log(`Summary [${model}]:`);
      console.log(
        `  Pass rate: ${rate}%${deltaPart}  Passed: ${report.passed}  Failed: ${report.failed}  Skipped: ${report.skipped}`
      );
      console.log(`  Intelligence tier: ${(report.intelligenceRate * 100).toFixed(1)}%`);
      if (report.competitive.length > 0) {
        console.log(`  Competitive win rate: ${(report.competitiveWinRate * 100).toFixed(1)}%`);
      }
      console.log(`  Mean steps: ${report.meanSteps.toFixed(1)}  p50: ${report.p50DurationMs}ms  p95: ${report.p95DurationMs}ms`);
      console.log(`  Run ID: ${runId}`);
    }
  } finally {
    if (fixtureServer) {
      await fixtureServer.stop();
      console.log('\nFixture server stopped.');
    }
    cleanupMcpConfig(safariMcpConfig);
  }

  console.log('\nBenchmark complete.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
