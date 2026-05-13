// One-shot judge orchestrator for /tmp/wv-inline-runs/.
// Not part of the canonical bench pipeline — used for v0.1.33 inline-bench validation only.
// Reads each score.json, calls runJudge() for PENDING_JUDGE+screenshot tasks,
// rewrites the file with verdict + reasoning, then aggregates scoreboard.json.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { runJudge } from './judge.js';
import { aggregateScoreboard } from './score.js';
import type { WebVoyagerScore } from './types.js';

const RUNS_DIR = '/tmp/wv-inline-runs';
const TASKS_PATH = '/tmp/wv-175-tasks.jsonl';

interface TaskInfo { id: string; site: string; url: string; question: string }

const tasks = new Map<string, TaskInfo>();
for (const line of readFileSync(TASKS_PATH, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  const t = JSON.parse(line) as { id: string; web_name: string; web: string; ques: string };
  tasks.set(t.id, { id: t.id, site: t.web_name, url: t.web, question: t.ques });
}

const scoreFiles = readdirSync(RUNS_DIR).filter((f: string) => f.endsWith('-r1.score.json'));
const canonicalScores: { path: string; score: WebVoyagerScore }[] = [];
for (const f of scoreFiles) {
  const score = JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf-8')) as WebVoyagerScore;
  if (!tasks.has(score.task_id)) continue;
  canonicalScores.push({ path: join(RUNS_DIR, f), score });
}
console.log(`[judge] ${canonicalScores.length}/${tasks.size} canonical score files found`);

const client = new OpenAI();
const toJudge = canonicalScores.filter((s) => s.score.verdict === 'PENDING_JUDGE');
console.log(`[judge] ${toJudge.length} tasks to judge`);

let idx = 0;
for (const { path, score } of toJudge) {
  idx++;
  const t = tasks.get(score.task_id)!;
  if (!score.screenshot_path || !existsSync(score.screenshot_path)) {
    score.verdict = 'UNKNOWN';
    score.judge_reasoning = 'screenshot capture failed';
    writeFileSync(path, JSON.stringify(score, null, 2));
    console.log(`[judge] ${idx}/${toJudge.length} ${score.task_id} -> UNKNOWN (no screenshot)`);
    continue;
  }
  try {
    const j = await runJudge(t.question, score.agent_final_text, score.screenshot_path, client);
    score.verdict = j.verdict;
    score.judge_reasoning = j.reasoning;
    writeFileSync(path, JSON.stringify(score, null, 2));
    console.log(`[judge] ${idx}/${toJudge.length} ${score.task_id} -> ${j.verdict}`);
  } catch (e) {
    score.verdict = 'FAILURE';
    score.judge_reasoning = `judge error: ${e instanceof Error ? e.message : String(e)}`;
    writeFileSync(path, JSON.stringify(score, null, 2));
    console.log(`[judge] ${idx}/${toJudge.length} ${score.task_id} -> FAILURE (${e instanceof Error ? e.message : String(e)})`);
  }
}

const allScores: WebVoyagerScore[] = canonicalScores.map(({ score }) => score);
const scoreboard = aggregateScoreboard(allScores);
writeFileSync(join(RUNS_DIR, 'scoreboard.json'), JSON.stringify(scoreboard, null, 2));
console.log(`\n[judge] DONE — scoreboard at ${RUNS_DIR}/scoreboard.json`);
console.log(`[judge] overall: ${scoreboard.overall.tasks_success}/${scoreboard.overall.tasks_total} success (${(scoreboard.overall.success_rate * 100).toFixed(1)}%)`);
for (const [site, agg] of Object.entries(scoreboard.per_site)) {
  console.log(`  ${site}: ${agg.tasks_success}/${agg.tasks_total} (${(agg.success_rate * 100).toFixed(0)}%) · capture_fail=${(agg.capture_failure_rate * 100).toFixed(1)}%`);
}
