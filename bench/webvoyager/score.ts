import type { WebVoyagerScore, JudgeVerdict } from './types.js';

export interface SiteAggregate {
  tasks_total: number;
  tasks_success: number;
  success_rate: number;
  capture_failure_rate: number;
  wall_ms_median: number;
}

export interface TaskAggregate {
  task_id: string;
  site: string;
  runs: number;
  successes: number;
  failures: number;
  unknowns: number;
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
 */
function majorityVerdict(scores: WebVoyagerScore[]): JudgeVerdict {
  const counts = { SUCCESS: 0, FAILURE: 0, UNKNOWN: 0 };
  for (const s of scores) counts[s.verdict]++;
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
    taskAggs[id] = {
      task_id: id,
      site: siteFromTaskId(id),
      runs: runs.length,
      successes,
      failures,
      unknowns,
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
    perSite[site] = {
      tasks_total: ts.length,
      tasks_success: succ,
      success_rate: ts.length > 0 ? succ / ts.length : 0,
      capture_failure_rate: siteScores.length > 0 ? captureFails / siteScores.length : 0,
      wall_ms_median: median(allRunsBySite.get(site) ?? []),
    };
  }

  const allTasks = Object.values(taskAggs);
  const overallSucc = allTasks.filter((t) => t.median_verdict === 'SUCCESS').length;
  const overallCaptureFails = scores.filter(isCaptureFailure).length;
  const overall: SiteAggregate = {
    tasks_total: allTasks.length,
    tasks_success: overallSucc,
    success_rate: allTasks.length > 0 ? overallSucc / allTasks.length : 0,
    capture_failure_rate: scores.length > 0 ? overallCaptureFails / scores.length : 0,
    wall_ms_median: median(scores.map((s) => s.wall_ms)),
  };

  return { variant, generated_at: new Date().toISOString(), overall, per_site: perSite, per_task: taskAggs };
}
