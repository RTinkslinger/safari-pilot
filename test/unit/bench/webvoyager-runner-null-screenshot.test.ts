// test/unit/bench/webvoyager-runner-null-screenshot.test.ts
import { describe, it, expect } from 'vitest';
import { aggregateScoreboard } from '../../../bench/webvoyager/score.js';
import type { WebVoyagerScore } from '../../../bench/webvoyager/types.js';

describe('webvoyager scoreboard — capture_failure_rate (Task 9)', () => {
  it('counts UNKNOWN verdicts with capture-failed reasoning toward capture_failure_rate', () => {
    const scores: WebVoyagerScore[] = [
      { task_id: 'A--1', variant: 'v', verdict: 'SUCCESS',  judge_reasoning: 'ok',  agent_final_text: 'x', run_seq: 1, wall_ms: 1, screenshot_path: '/tmp/a.png' },
      { task_id: 'A--2', variant: 'v', verdict: 'FAILURE',  judge_reasoning: 'no',  agent_final_text: 'y', run_seq: 1, wall_ms: 1, screenshot_path: '/tmp/b.png' },
      { task_id: 'A--3', variant: 'v', verdict: 'UNKNOWN',  judge_reasoning: 'screenshot capture failed: TAB_NOT_FOUND', agent_final_text: 'z', run_seq: 1, wall_ms: 1, screenshot_path: null },
      { task_id: 'A--4', variant: 'v', verdict: 'UNKNOWN',  judge_reasoning: 'screenshot capture failed: CAPTURE_FAILED', agent_final_text: 'w', run_seq: 1, wall_ms: 1, screenshot_path: null },
    ];
    const board = aggregateScoreboard(scores);
    expect(board.overall.tasks_total).toBe(4);
    expect(board.overall.tasks_success).toBe(1);
    expect(board.overall.success_rate).toBeCloseTo(0.25);
    expect(board.overall.capture_failure_rate).toBeCloseTo(0.5);
  });

  it('capture_failure_rate is 0 when no UNKNOWN-with-capture-failed scores', () => {
    const scores: WebVoyagerScore[] = [
      { task_id: 'A--1', variant: 'v', verdict: 'SUCCESS', judge_reasoning: 'ok', agent_final_text: 'x', run_seq: 1, wall_ms: 1, screenshot_path: '/tmp/a.png' },
    ];
    const board = aggregateScoreboard(scores);
    expect(board.overall.capture_failure_rate).toBe(0);
  });
});
