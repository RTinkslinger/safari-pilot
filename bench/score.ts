/**
 * bench/score.ts — Aggregates per-task score.json files in a run directory.
 *
 * Usage:
 *   node --import tsx bench/score.ts --run-dir <path> [--out <scoreboard.json>]
 *
 * Reads every score.json under <run-dir>/<task-id>/score.json,
 * computes variant scoreboard with aggregate tt, and writes a summary.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchScore } from './types.js';

interface VariantSummary {
  variant: string;
  tasks_total: number;
  tasks_success: number;
  success_rate: number;
  total_tool_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_wall_ms: number;
  total_tt: number;
  scores: BenchScore[];
}

interface Scoreboard {
  run_dir: string;
  generated_at: string;
  variants: VariantSummary[];
}

function parseArgs(argv: string[]): { runDir: string; out: string | null } {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith('--') && i + 1 < argv.length) {
      args[a.slice(2)] = argv[i + 1] as string;
      i++;
    }
  }
  if (!args['run-dir']) throw new Error('Missing --run-dir argument');
  return {
    runDir: args['run-dir'] as string,
    out: args['out'] ?? null,
  };
}

function collectScores(runDir: string): BenchScore[] {
  const scores: BenchScore[] = [];
  if (!existsSync(runDir)) return scores;

  for (const entry of readdirSync(runDir)) {
    const taskDir = join(runDir, entry);
    if (!statSync(taskDir).isDirectory()) continue;
    const scorePath = join(taskDir, 'score.json');
    if (!existsSync(scorePath)) continue;
    try {
      const s = JSON.parse(readFileSync(scorePath, 'utf-8')) as BenchScore;
      scores.push(s);
    } catch { /* skip malformed */ }
  }
  return scores;
}

function aggregate(scores: BenchScore[]): Scoreboard {
  // Group by variant
  const byVariant = new Map<string, BenchScore[]>();
  for (const s of scores) {
    const list = byVariant.get(s.variant) ?? [];
    list.push(s);
    byVariant.set(s.variant, list);
  }

  const variants: VariantSummary[] = [];
  for (const [variant, vscores] of byVariant.entries()) {
    variants.push({
      variant,
      tasks_total: vscores.length,
      tasks_success: vscores.filter((s) => s.success).length,
      success_rate: vscores.filter((s) => s.success).length / vscores.length,
      total_tool_calls: vscores.reduce((a, s) => a + s.tool_calls, 0),
      total_input_tokens: vscores.reduce((a, s) => a + s.input_tokens, 0),
      total_output_tokens: vscores.reduce((a, s) => a + s.output_tokens, 0),
      total_wall_ms: vscores.reduce((a, s) => a + s.wall_ms, 0),
      total_tt: vscores.reduce((a, s) => a + s.tt, 0),
      scores: vscores,
    });
  }

  // Sort variants by total_tt ascending (lower is better)
  variants.sort((a, b) => a.total_tt - b.total_tt);

  return {
    run_dir: '',
    generated_at: new Date().toISOString(),
    variants,
  };
}

function main(): void {
  const { runDir, out } = parseArgs(process.argv.slice(2));
  const scores = collectScores(runDir);
  const board = aggregate(scores);
  board.run_dir = runDir;

  const json = JSON.stringify(board, null, 2);
  if (out) {
    writeFileSync(out, json);
    process.stdout.write(`Scoreboard written to ${out}\n`);
  } else {
    process.stdout.write(json + '\n');
  }
}

main();
