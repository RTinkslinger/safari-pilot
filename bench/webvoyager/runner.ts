// bench/webvoyager/runner.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseWebVoyagerTask, type WebVoyagerScore, type WebVoyagerTask } from './types.js';
import { runWebVoyagerTask } from './adapter.js';
import { runJudge } from './judge.js';
import { aggregateScoreboard } from './score.js';

interface CliArgs {
  tasksFile: string;
  variant: string;
  outDir: string;
  runs: number;
  concurrency: number;
  skipJudge: boolean;
  resume: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  for (const req of ['tasks-file', 'variant', 'out-dir']) {
    if (!args[req]) throw new Error(`--${req} required`);
  }
  return {
    tasksFile: args['tasks-file'] as string,
    variant: args['variant'] as string,
    outDir: args['out-dir'] as string,
    runs: parseInt((args['runs'] as string) ?? '1', 10),
    concurrency: parseInt((args['concurrency'] as string) ?? '8', 10),
    skipJudge: args['skip-judge'] === true,
    resume: args['resume'] === true,
  };
}

function sanitize(id: string): string { return id.replace(/[^A-Za-z0-9_-]/g, '_'); }

function scorePath(outDir: string, task: WebVoyagerTask, runSeq: number): string {
  return join(outDir, `${sanitize(task.id)}-r${runSeq}.score.json`);
}

async function workerLoop<I, O>(items: I[], concurrency: number, fn: (i: I) => Promise<O>): Promise<O[]> {
  const results: O[] = [];
  let cursor = 0;
  async function take(): Promise<void> {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await fn(items[idx]!);
      } catch (e) {
        // Per-item error isolation: log but don't kill the whole run
        process.stderr.write(`[wv-runner] task ${idx} threw: ${e instanceof Error ? e.message : String(e)}\n`);
        results[idx] = undefined as unknown as O;
      }
    }
  }
  await Promise.all(Array(Math.min(concurrency, items.length)).fill(0).map(() => take()));
  return results.filter((r) => r !== undefined);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.outDir, { recursive: true });

  const tasks = readFileSync(args.tasksFile, 'utf-8')
    .split('\n').filter((l) => l.trim()).map(parseWebVoyagerTask);

  const allScores: WebVoyagerScore[] = [];
  let resumedCount = 0;

  for (let runSeq = 1; runSeq <= args.runs; runSeq++) {
    process.stdout.write(`[wv-runner] run ${runSeq}/${args.runs} starting (${tasks.length} tasks, c=${args.concurrency})\n`);

    // RESUME: load pre-existing score.json files for this run
    const todo: WebVoyagerTask[] = [];
    for (const task of tasks) {
      const sp = scorePath(args.outDir, task, runSeq);
      if (args.resume && existsSync(sp)) {
        try {
          const existing = JSON.parse(readFileSync(sp, 'utf-8')) as WebVoyagerScore;
          allScores.push(existing);
          resumedCount++;
          process.stdout.write(`[wv-runner] resume — skipping ${task.id} r${runSeq} (already scored: ${existing.verdict})\n`);
          continue;
        } catch { /* corrupt, re-run */ }
      }
      todo.push(task);
    }

    const runResults = await workerLoop(todo, args.concurrency, async (task) => {
      const adapterResult = await runWebVoyagerTask(task, {
        variant: args.variant,
        outDir: args.outDir,
        runSeq,
        timeoutMs: 240_000,
      });

      let verdict: 'SUCCESS' | 'FAILURE' | 'UNKNOWN' = 'UNKNOWN';
      let reasoning = '(judge skipped)';
      if (adapterResult.screenshot_path === null) {
        // Capture failed — skip judge entirely. Don't try to call OpenAI without a screenshot;
        // the upstream WebVoyager prompt is screenshot-mandatory and would either crash or
        // produce a conservative NOT SUCCESS that's unrelated to agent capability.
        verdict = 'UNKNOWN';
        reasoning = `screenshot capture failed: ${adapterResult.capture_error_code ?? 'unknown'}`;
      } else if (!args.skipJudge) {
        try {
          const j = await runJudge(task.question, adapterResult.agent_final_text, adapterResult.screenshot_path);
          verdict = j.verdict;
          reasoning = j.reasoning;
        } catch (e) {
          reasoning = `judge error: ${e instanceof Error ? e.message : String(e)}`;
          verdict = 'FAILURE';  // conservative — judge failure → conservative score
        }
      }

      const score: WebVoyagerScore = {
        task_id: task.id,
        variant: args.variant,
        verdict,
        judge_reasoning: reasoning,
        agent_final_text: adapterResult.agent_final_text,
        run_seq: runSeq,
        wall_ms: adapterResult.wall_ms,
        screenshot_path: adapterResult.screenshot_path,
      };

      // Write score immediately for crash-resume safety
      writeFileSync(scorePath(args.outDir, task, runSeq), JSON.stringify(score, null, 2));
      process.stdout.write(`[wv-runner] ${task.id} r${runSeq} ${verdict} ${score.wall_ms}ms\n`);
      return score;
    });

    allScores.push(...runResults);
  }

  const scoreboard = aggregateScoreboard(allScores);
  writeFileSync(join(args.outDir, 'scoreboard.json'), JSON.stringify(scoreboard, null, 2));
  process.stdout.write(`[wv-runner] done — ${scoreboard.overall.tasks_success}/${scoreboard.overall.tasks_total} success (${resumedCount} resumed)\n`);
}

main().catch((err) => {
  process.stderr.write(`[wv-runner] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
