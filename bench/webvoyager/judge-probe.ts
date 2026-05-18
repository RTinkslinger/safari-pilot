// Parameterized judge runner for any 50-task probe directory.
//
// Usage:
//   WV_RUNS_DIR=/private/tmp/wv-v0136-perwin-2340 \
//   WV_TASKS_PATH=bench-runs/v0136-probes/probe-tasks.jsonl \
//     npx tsx bench/webvoyager/judge-probe.ts
//
// Mirrors judge-inline-runs.ts but reads paths from env so it works
// against any probe directory (per-version, per-baseline, per-SOTA-runner).
// Writes verdict + reasoning back into each score.json and produces a
// scoreboard.json + a flat SUCCESS/FAIL summary on stdout.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { runJudge } from './judge.js';
import { aggregateScoreboard } from './score.js';
import type { WebVoyagerScore } from './types.js';

const RUNS_DIR = process.env['WV_RUNS_DIR'];
const TASKS_PATH = process.env['WV_TASKS_PATH'];
if (!RUNS_DIR || !TASKS_PATH) {
  console.error('error: set WV_RUNS_DIR + WV_TASKS_PATH env vars');
  process.exit(2);
}

interface TaskInfo { id: string; site: string; url: string; question: string }

const tasks = new Map<string, TaskInfo>();
for (const line of readFileSync(TASKS_PATH, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  const t = JSON.parse(line) as { id: string; web_name: string; web: string; ques: string };
  tasks.set(t.id, { id: t.id, site: t.web_name, url: t.web, question: t.ques });
}

const scoreFiles = readdirSync(RUNS_DIR).filter((f) => f.endsWith('.score.json'));
const canonicalScores: { path: string; score: WebVoyagerScore }[] = [];
for (const f of scoreFiles) {
  const score = JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf-8')) as WebVoyagerScore;
  if (!tasks.has(score.task_id)) continue;
  canonicalScores.push({ path: join(RUNS_DIR, f), score });
}
console.log(`[judge-probe] ${canonicalScores.length}/${tasks.size} task scores found in ${RUNS_DIR}`);

const client = new OpenAI();
// 'PENDING_JUDGE' is written by the bench harness as a transient state
// but not in the JudgeVerdict union; cast through string for the runtime
// filter — matches the established pattern in judge-inline-runs.ts.
const toJudge = canonicalScores.filter((s) => (s.score.verdict as string) === 'PENDING_JUDGE');
console.log(`[judge-probe] ${toJudge.length} PENDING_JUDGE to evaluate`);

let idx = 0;
for (const { path, score } of toJudge) {
  idx++;
  const t = tasks.get(score.task_id)!;
  if (!score.screenshot_path || !existsSync(score.screenshot_path)) {
    score.verdict = 'UNKNOWN';
    score.judge_reasoning = 'screenshot capture failed';
    writeFileSync(path, JSON.stringify(score, null, 2));
    console.log(`[judge-probe] ${idx}/${toJudge.length} ${score.task_id} -> UNKNOWN (no screenshot)`);
    continue;
  }
  try {
    const j = await runJudge(t.question, score.agent_final_text, score.screenshot_path, client);
    score.verdict = j.verdict;
    score.judge_reasoning = j.reasoning;
    writeFileSync(path, JSON.stringify(score, null, 2));
    console.log(`[judge-probe] ${idx}/${toJudge.length} ${score.task_id} -> ${j.verdict}`);
  } catch (e) {
    score.verdict = 'FAILURE';
    score.judge_reasoning = `judge error: ${e instanceof Error ? e.message : String(e)}`;
    writeFileSync(path, JSON.stringify(score, null, 2));
    console.log(`[judge-probe] ${idx}/${toJudge.length} ${score.task_id} -> FAILURE (${e instanceof Error ? e.message : String(e)})`);
  }
}

const allScores: WebVoyagerScore[] = canonicalScores.map(({ score }) => score);
const scoreboard = aggregateScoreboard(allScores);
writeFileSync(join(RUNS_DIR, 'scoreboard.json'), JSON.stringify(scoreboard, null, 2));

// Flat summary
const counts: Record<string, number> = {};
for (const s of allScores) counts[s.verdict] = (counts[s.verdict] || 0) + 1;
console.log('');
console.log(`[judge-probe] DONE — scoreboard written to ${RUNS_DIR}/scoreboard.json`);
console.log(`[judge-probe] verdict distribution:`);
for (const [v, n] of Object.entries(counts).sort()) {
  console.log(`   ${v}: ${n}`);
}
console.log(`[judge-probe] SUCCESS rate: ${scoreboard.overall.tasks_success}/${scoreboard.overall.tasks_total} = ${(scoreboard.overall.success_rate * 100).toFixed(1)}%`);
console.log(`[judge-probe] per-site:`);
for (const [site, agg] of Object.entries(scoreboard.per_site)) {
  console.log(`   ${site}: ${agg.tasks_success}/${agg.tasks_total} (${(agg.success_rate * 100).toFixed(0)}%) · capture_fail=${(agg.capture_failure_rate * 100).toFixed(1)}%`);
}
