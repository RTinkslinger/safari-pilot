import type { WebVoyagerScore, JudgeVerdict } from './types.js';
import { aggregateMajorityVerdict } from './judge.js';

export interface RunScore {
  task_id: string;
  run_seq: number;
  verdict: JudgeVerdict;
  wall_ms: number;
  cost_usd?: number;
  step_count?: number;
}

export interface CollapsedRun {
  task_id: string;
  verdict: JudgeVerdict | 'UNKNOWN';
  median_wall_ms: number;
  median_steps: number;
  total_cost_usd: number;
}

/**
 * Collapse multi-run scores per task using the generic majority aggregator,
 * computing median wall_ms / step_count and total cost across runs.
 * Used for dual-metric reporting alongside the legacy aggregateScoreboard path.
 */
export function collapseMajority(runs: RunScore[]): CollapsedRun[] {
  const byTask = new Map<string, RunScore[]>();
  for (const r of runs) {
    const arr = byTask.get(r.task_id) ?? [];
    arr.push(r);
    byTask.set(r.task_id, arr);
  }
  const med = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const sorted = [...xs].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  return Array.from(byTask.entries()).map(([task_id, rs]) => ({
    task_id,
    verdict: aggregateMajorityVerdict<JudgeVerdict>(rs.map((r) => r.verdict)),
    median_wall_ms: med(rs.map((r) => r.wall_ms)),
    median_steps: med(rs.map((r) => r.step_count ?? 0)),
    total_cost_usd: rs.reduce((s, r) => s + (r.cost_usd ?? 0), 0),
  }));
}

export interface SiteAggregate {
  tasks_total: number;
  tasks_success: number;
  success_rate: number;
  capture_failure_rate: number;
  /**
   * Per-site abstention rate = (number of runs whose verdict is ABSTAIN)
   * / (total runs for the site). Tracked separately from success/failure so
   * abstentions are not penalized in success_rate (which is task-majority based)
   * and not conflated with capture failures (which are UNKNOWN-with-sentinel).
   */
  abstention_rate: number;
  wall_ms_median: number;
}

export interface TaskAggregate {
  task_id: string;
  site: string;
  runs: number;
  successes: number;
  failures: number;
  unknowns: number;
  abstentions: number;
  median_verdict: JudgeVerdict;
  wall_ms_median: number;
}

export interface Scoreboard {
  variant: string;
  generated_at: string;
  overall: SiteAggregate;
  per_site: Record<string, SiteAggregate>;
  per_task: Record<string, TaskAggregate>;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function siteFromTaskId(id: string): string {
  return id.split('--')[0] ?? 'Unknown';
}

/**
 * A score is a "capture failure" iff verdict is UNKNOWN AND the judge_reasoning
 * starts with the canonical sentinel that runner.ts writes when adapter returns
 * screenshot_path: null. This keeps capture failures separate from legitimate
 * UNKNOWN verdicts (judge couldn't decide, model hedged, etc.).
 */
function isCaptureFailure(s: WebVoyagerScore): boolean {
  return s.verdict === 'UNKNOWN' && /^screenshot capture failed:/.test(s.judge_reasoning);
}

/**
 * Conservative tiebreak: if SUCCESS and FAILURE counts are equal, return FAILURE.
 * Per engineering review — optimistic tiebreak inflates scores in noisy regimes.
 *
 * ABSTAIN is included in the count map for completeness but only wins the
 * majority vote when it strictly dominates SUCCESS, FAILURE, and UNKNOWN
 * (parallel rule to SUCCESS — ABSTAIN should not be inflated by ties).
 */
function majorityVerdict(scores: WebVoyagerScore[]): JudgeVerdict {
  const counts = { SUCCESS: 0, FAILURE: 0, UNKNOWN: 0, ABSTAIN: 0 };
  for (const s of scores) counts[s.verdict]++;
  if (
    counts.ABSTAIN > counts.SUCCESS &&
    counts.ABSTAIN > counts.FAILURE &&
    counts.ABSTAIN > counts.UNKNOWN
  ) {
    return 'ABSTAIN';
  }
  if (counts.SUCCESS > counts.FAILURE && counts.SUCCESS > counts.UNKNOWN) return 'SUCCESS';
  if (counts.FAILURE >= counts.SUCCESS && counts.FAILURE >= counts.UNKNOWN) return 'FAILURE';
  return 'UNKNOWN';
}

export function aggregateScoreboard(scores: WebVoyagerScore[]): Scoreboard {
  const variant = scores[0]?.variant ?? 'unknown';
  const byTask = new Map<string, WebVoyagerScore[]>();
  for (const s of scores) {
    const arr = byTask.get(s.task_id) ?? [];
    arr.push(s);
    byTask.set(s.task_id, arr);
  }

  const taskAggs: Record<string, TaskAggregate> = {};
  for (const [id, runs] of byTask) {
    const successes = runs.filter((r) => r.verdict === 'SUCCESS').length;
    const failures = runs.filter((r) => r.verdict === 'FAILURE').length;
    const unknowns = runs.filter((r) => r.verdict === 'UNKNOWN').length;
    const abstentions = runs.filter((r) => r.verdict === 'ABSTAIN').length;
    taskAggs[id] = {
      task_id: id,
      site: siteFromTaskId(id),
      runs: runs.length,
      successes,
      failures,
      unknowns,
      abstentions,
      median_verdict: majorityVerdict(runs),
      wall_ms_median: median(runs.map((r) => r.wall_ms)),
    };
  }

  // Per-site aggregates: success_rate from task-level majority verdict;
  // wall_ms_median from ALL runs in the site (not median of medians);
  // capture_failure_rate from ALL runs in the site (capture failures / total runs).
  const tasksBySite = new Map<string, TaskAggregate[]>();
  const allRunsBySite = new Map<string, number[]>();
  const allScoresBySite = new Map<string, WebVoyagerScore[]>();
  for (const t of Object.values(taskAggs)) {
    const arr = tasksBySite.get(t.site) ?? [];
    arr.push(t);
    tasksBySite.set(t.site, arr);
  }
  for (const s of scores) {
    const site = siteFromTaskId(s.task_id);
    const wallArr = allRunsBySite.get(site) ?? [];
    wallArr.push(s.wall_ms);
    allRunsBySite.set(site, wallArr);
    const scoreArr = allScoresBySite.get(site) ?? [];
    scoreArr.push(s);
    allScoresBySite.set(site, scoreArr);
  }

  const perSite: Record<string, SiteAggregate> = {};
  for (const [site, ts] of tasksBySite) {
    const succ = ts.filter((t) => t.median_verdict === 'SUCCESS').length;
    const siteScores = allScoresBySite.get(site) ?? [];
    const captureFails = siteScores.filter(isCaptureFailure).length;
    const abstained = siteScores.filter((s) => s.verdict === 'ABSTAIN').length;
    perSite[site] = {
      tasks_total: ts.length,
      tasks_success: succ,
      success_rate: ts.length > 0 ? succ / ts.length : 0,
      capture_failure_rate: siteScores.length > 0 ? captureFails / siteScores.length : 0,
      abstention_rate: siteScores.length > 0 ? abstained / siteScores.length : 0,
      wall_ms_median: median(allRunsBySite.get(site) ?? []),
    };
  }

  const allTasks = Object.values(taskAggs);
  const overallSucc = allTasks.filter((t) => t.median_verdict === 'SUCCESS').length;
  const overallCaptureFails = scores.filter(isCaptureFailure).length;
  const overallAbstained = scores.filter((s) => s.verdict === 'ABSTAIN').length;
  const overall: SiteAggregate = {
    tasks_total: allTasks.length,
    tasks_success: overallSucc,
    success_rate: allTasks.length > 0 ? overallSucc / allTasks.length : 0,
    capture_failure_rate: scores.length > 0 ? overallCaptureFails / scores.length : 0,
    abstention_rate: scores.length > 0 ? overallAbstained / scores.length : 0,
    wall_ms_median: median(scores.map((s) => s.wall_ms)),
  };

  return { variant, generated_at: new Date().toISOString(), overall, per_site: perSite, per_task: taskAggs };
}
