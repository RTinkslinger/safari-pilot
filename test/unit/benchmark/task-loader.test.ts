import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadTasks, filterTasks } from '../../../src/benchmark/task-loader.js';
import type { BenchmarkTask, PreflightResult } from '../../../src/benchmark/types.js';

const TMP = join(import.meta.dirname, '../../../.test-tasks');

const sampleTask: BenchmarkTask = {
  id: 'nav-001',
  category: 'navigation',
  difficulty: 'easy',
  intent: 'Navigate to example.com',
  start_url: 'https://example.com',
  requires: { tools: [], engines: [], auth_domains: [], features: [], competitive: false },
  eval: { type: 'exact_match', expected: 'Example Domain' },
  timeout_ms: 30000,
  max_budget_usd: 0.25,
  tags: ['navigation'],
};

const authTask: BenchmarkTask = {
  ...sampleTask,
  id: 'auth-001',
  category: 'auth-flows',
  requires: { ...sampleTask.requires, auth_domains: ['x.com'] },
};

const downloadTask: BenchmarkTask = {
  ...sampleTask,
  id: 'dl-001',
  category: 'extraction',
  requires: { ...sampleTask.requires, tools: ['safari_wait_for_download'] },
  roadmap_gate: 'file-downloads',
};

beforeAll(() => {
  mkdirSync(join(TMP, 'navigation'), { recursive: true });
  mkdirSync(join(TMP, 'auth-flows'), { recursive: true });
  mkdirSync(join(TMP, 'extraction'), { recursive: true });
  writeFileSync(join(TMP, 'navigation/nav-001.json'), JSON.stringify(sampleTask));
  writeFileSync(join(TMP, 'auth-flows/auth-001.json'), JSON.stringify(authTask));
  writeFileSync(join(TMP, 'extraction/dl-001.json'), JSON.stringify(downloadTask));
  writeFileSync(join(TMP, 'navigation/bad.json'), '{ broken json');
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('loadTasks', () => {
  it('loads all valid tasks from directory', async () => {
    const { tasks, errors } = await loadTasks(TMP);
    expect(tasks).toHaveLength(3);
    expect(errors).toHaveLength(1);
  });

  it('reports parse errors with file paths', async () => {
    const { errors } = await loadTasks(TMP);
    expect(errors[0]).toContain('bad.json');
  });
});

describe('filterTasks', () => {
  const preflight: PreflightResult = {
    availableTools: ['safari_navigate', 'safari_click', 'safari_snapshot'],
    healthyEngines: ['applescript'],
    authenticatedDomains: [],
    competitiveReady: false,
    fixtureServerRunning: true,
  };

  it('passes tasks with no requirements', () => {
    const results = filterTasks([sampleTask], preflight, null, null);
    expect(results.eligible).toHaveLength(1);
    expect(results.skipped).toHaveLength(0);
  });

  it('skips tasks requiring unavailable auth domains', () => {
    const results = filterTasks([authTask], preflight, null, null);
    expect(results.eligible).toHaveLength(0);
    expect(results.skipped).toHaveLength(1);
    expect(results.skipped[0].reason).toContain('auth');
  });

  it('skips tasks requiring unavailable tools', () => {
    const results = filterTasks([downloadTask], preflight, null, null);
    expect(results.eligible).toHaveLength(0);
    expect(results.skipped[0].reason).toContain('safari_wait_for_download');
  });

  it('filters by category when specified', () => {
    const results = filterTasks([sampleTask, authTask], preflight, ['navigation'], null);
    expect(results.eligible).toHaveLength(1);
    expect(results.eligible[0].id).toBe('nav-001');
  });

  it('filters by task ID when specified', () => {
    const results = filterTasks([sampleTask, authTask], preflight, null, ['auth-001']);
    expect(results.skipped).toHaveLength(1);
  });

  it('skips tasks with unmet roadmap_gate', () => {
    const gatedTask: BenchmarkTask = {
      ...sampleTask,
      id: 'dl-002',
      roadmap_gate: 'file-downloads',
    };
    const results = filterTasks([gatedTask], preflight, null, null);
    expect(results.skipped).toHaveLength(1);
    expect(results.skipped[0].reason).toContain('roadmap gate');
  });
});
