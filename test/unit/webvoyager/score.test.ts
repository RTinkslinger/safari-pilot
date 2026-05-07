import { describe, it, expect } from 'vitest';
import { aggregateScoreboard } from '../../../bench/webvoyager/score.js';
import type { WebVoyagerScore } from '../../../bench/webvoyager/types.js';

function s(taskId: string, verdict: 'SUCCESS' | 'FAILURE' | 'UNKNOWN', wall: number, run = 1): WebVoyagerScore {
  return {
    task_id: taskId, variant: 'v0.1.29', verdict, judge_reasoning: 'r',
    agent_final_text: 'a', run_seq: run, wall_ms: wall, screenshot_path: '/tmp/x.png',
  };
}

describe('aggregateScoreboard', () => {
  it('majority verdict per task — 2 SUCCESS 1 FAILURE → SUCCESS', () => {
    const scores = [s('A--1', 'SUCCESS', 5000, 1), s('A--1', 'SUCCESS', 5500, 2), s('A--1', 'FAILURE', 6000, 3)];
    const sb = aggregateScoreboard(scores);
    expect(sb.per_task['A--1']!.median_verdict).toBe('SUCCESS');
  });

  it('FAILURE on ties (conservative tiebreak)', () => {
    const scores = [s('B--1', 'SUCCESS', 5000, 1), s('B--1', 'FAILURE', 5000, 2)];
    const sb = aggregateScoreboard(scores);
    expect(sb.per_task['B--1']!.median_verdict).toBe('FAILURE');
  });

  it('per-site wall_ms_median computed over ALL runs in that site (not median of medians)', () => {
    const scores = [
      // Site A: 4 runs total — wall values 1000, 2000, 3000, 4000 → true median 2500
      s('A--1', 'SUCCESS', 1000, 1), s('A--1', 'SUCCESS', 4000, 2),
      s('A--2', 'SUCCESS', 2000, 1), s('A--2', 'SUCCESS', 3000, 2),
    ];
    const sb = aggregateScoreboard(scores);
    expect(sb.per_site['A']!.wall_ms_median).toBe(2500);
  });

  it('per-site success_rate uses task-level majority verdict', () => {
    const scores = [
      s('S--1', 'SUCCESS', 1000), s('S--1', 'SUCCESS', 1000),  // task 1: SUCCESS
      s('S--2', 'FAILURE', 1000), s('S--2', 'FAILURE', 1000),  // task 2: FAILURE
    ];
    const sb = aggregateScoreboard(scores);
    expect(sb.per_site['S']!.tasks_total).toBe(2);
    expect(sb.per_site['S']!.tasks_success).toBe(1);
    expect(sb.per_site['S']!.success_rate).toBeCloseTo(0.5);
  });

  it('overall aggregates correctly across sites', () => {
    const scores = [
      s('A--1', 'SUCCESS', 1000), s('B--1', 'FAILURE', 2000),
    ];
    const sb = aggregateScoreboard(scores);
    expect(sb.overall.tasks_total).toBe(2);
    expect(sb.overall.tasks_success).toBe(1);
    expect(sb.overall.success_rate).toBe(0.5);
  });
});
