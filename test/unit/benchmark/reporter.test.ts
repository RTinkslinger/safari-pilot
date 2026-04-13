import { describe, it, expect } from 'vitest';
import { computeRunReport, generateDeltaReport, computeFlakiness } from '../../../src/benchmark/reporter.js';
import type { TaskResult, BenchmarkTask, RunReport, Category } from '../../../src/benchmark/types.js';

function makeTask(id: string, category: Category): BenchmarkTask {
  return {
    id, category, difficulty: 'easy', intent: 'test',
    requires: { tools: [], engines: [], auth_domains: [], features: [], competitive: false },
    eval: { type: 'exact_match', expected: 'x' },
    timeout_ms: 30000, max_budget_usd: 0.25, tags: [],
  };
}

function makeResult(id: string, success: boolean, steps = 3): TaskResult {
  return {
    taskId: id, model: 'sonnet', success, evalMethod: 'exact_match',
    evalDetails: {}, fallbackUsed: false, skipped: false,
    steps, durationMs: 5000, toolsUsed: ['safari_navigate'],
    enginesUsed: { applescript: steps }, reasoningExcerpts: [],
  };
}

describe('computeRunReport', () => {
  it('computes overall and per-category rates', () => {
    const tasks = [makeTask('nav-001', 'navigation'), makeTask('nav-002', 'navigation'), makeTask('form-001', 'forms')];
    const results = [makeResult('nav-001', true), makeResult('nav-002', false), makeResult('form-001', true)];
    const report = computeRunReport('run-1', 'sonnet', 'abc123', 'main', results, tasks, []);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.overallRate).toBeCloseTo(0.667, 2);
    expect(report.byCategory['navigation'].rate).toBe(0.5);
    expect(report.byCategory['forms'].rate).toBe(1);
  });

  it('computes mean steps from successful tasks', () => {
    const tasks = [makeTask('nav-001', 'navigation'), makeTask('nav-002', 'navigation')];
    const results = [makeResult('nav-001', true, 4), makeResult('nav-002', true, 6)];
    const report = computeRunReport('run-1', 'sonnet', 'abc', 'main', results, tasks, []);
    expect(report.meanSteps).toBe(5);
  });

  it('computes intelligence rate separately', () => {
    const tasks = [makeTask('intel-001', 'intelligence'), makeTask('intel-002', 'intelligence'), makeTask('nav-001', 'navigation')];
    const results = [makeResult('intel-001', true), makeResult('intel-002', false), makeResult('nav-001', true)];
    const report = computeRunReport('run-1', 'sonnet', 'abc', 'main', results, tasks, []);
    expect(report.intelligenceRate).toBe(0.5);
    expect(report.overallRate).toBeCloseTo(0.667, 2);
  });

  it('tracks per-task results', () => {
    const tasks = [makeTask('nav-001', 'navigation')];
    const results = [makeResult('nav-001', true, 5)];
    const report = computeRunReport('run-1', 'sonnet', 'abc', 'main', results, tasks, []);
    expect(report.perTask['nav-001']).toEqual({ passed: true, steps: 5, durationMs: 5000 });
  });

  it('includes skipped count', () => {
    const tasks = [makeTask('nav-001', 'navigation')];
    const results = [makeResult('nav-001', true)];
    const skipped = [{ task: makeTask('dl-001', 'extraction'), reason: 'missing tool' }];
    const report = computeRunReport('run-1', 'sonnet', 'abc', 'main', results, tasks, skipped);
    expect(report.skipped).toBe(1);
    expect(report.eligible).toBe(1);
  });
});

describe('generateDeltaReport', () => {
  it('generates markdown with category table', () => {
    const tasks = [makeTask('nav-001', 'navigation')];
    const results = [makeResult('nav-001', true)];
    const current = computeRunReport('run-1', 'sonnet', 'abc', 'main', results, tasks, []);
    const md = generateDeltaReport(current, null, []);
    expect(md).toContain('# Safari Pilot Benchmark Report');
    expect(md).toContain('navigation');
    expect(md).toContain('baseline');
  });

  it('shows deltas when previous run exists', () => {
    const tasks = [makeTask('nav-001', 'navigation')];
    const prev = computeRunReport('run-0', 'sonnet', 'prev', 'main', [makeResult('nav-001', false)], tasks, []);
    const current = computeRunReport('run-1', 'sonnet', 'abc', 'feat/x', [makeResult('nav-001', true)], tasks, []);
    const md = generateDeltaReport(current, prev, []);
    expect(md).toContain('100.0%');
    expect(md).toContain('+');
  });

  it('includes skipped tasks section', () => {
    const tasks = [makeTask('nav-001', 'navigation')];
    const results = [makeResult('nav-001', true)];
    const current = computeRunReport('run-1', 'sonnet', 'abc', 'main', results, tasks, []);
    const skipped = [{ task: makeTask('dl-001', 'extraction'), reason: 'missing safari_wait_for_download' }];
    const md = generateDeltaReport(current, null, skipped);
    expect(md).toContain('Skipped');
    expect(md).toContain('dl-001');
  });
});

describe('computeFlakiness', () => {
  const makeRun = (id: string, taskPassed: boolean): RunReport => ({
    id, model: 'sonnet', commit: id, branch: 'main', timestamp: '',
    eligible: 1, skipped: 0, passed: taskPassed ? 1 : 0, failed: taskPassed ? 0 : 1,
    overallRate: taskPassed ? 1 : 0, byCategory: {} as any,
    intelligenceRate: 0, competitiveWinRate: 0, competitive: [],
    meanSteps: 3, p50DurationMs: 5000, p95DurationMs: 5000, flakyCount: 0,
    perTask: { 'nav-001': { passed: taskPassed, steps: 3, durationMs: 5000 } },
  });

  it('detects flaky tasks from run history', () => {
    const runs = [makeRun('r1', true), makeRun('r2', false)];
    expect(computeFlakiness(runs, 'nav-001')).toBe(true);
  });

  it('returns false for consistent tasks', () => {
    const runs = [makeRun('r1', true), makeRun('r2', true)];
    expect(computeFlakiness(runs, 'nav-001')).toBe(false);
  });

  it('returns false with insufficient data', () => {
    expect(computeFlakiness([makeRun('r1', true)], 'nav-001')).toBe(false);
  });

  it('returns false for task not in history', () => {
    expect(computeFlakiness([makeRun('r1', true)], 'missing-001')).toBe(false);
  });
});
