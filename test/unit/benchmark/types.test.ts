import { describe, it, expect } from 'vitest';
import {
  type BenchmarkTask,
  type TaskResult,
  type RunConfig,
  type RunReport,
  type StreamEvent,
  type TaskEval,
  type TaskRequires,
  CATEGORIES,
  DIFFICULTIES,
  EVAL_TYPES,
  validateTask,
} from '../../../src/benchmark/types.js';

describe('benchmark types', () => {
  const validTask: BenchmarkTask = {
    id: 'nav-001',
    category: 'navigation',
    difficulty: 'easy',
    intent: 'Navigate to https://example.com and extract the page title',
    start_url: 'https://example.com',
    requires: {
      tools: [],
      engines: [],
      auth_domains: [],
      features: [],
      competitive: false,
    },
    eval: { type: 'exact_match', expected: 'Example Domain' },
    timeout_ms: 30000,
    max_budget_usd: 0.25,
    tags: ['navigation', 'basic'],
  };

  it('validates a well-formed task', () => {
    const errors = validateTask(validTask);
    expect(errors).toEqual([]);
  });

  it('rejects task with missing id', () => {
    const bad = { ...validTask, id: '' };
    const errors = validateTask(bad);
    expect(errors).toContain('id is required');
  });

  it('rejects task with invalid category', () => {
    const bad = { ...validTask, category: 'bogus' as any };
    const errors = validateTask(bad);
    expect(errors[0]).toContain('category');
  });

  it('rejects task with invalid eval type', () => {
    const bad = { ...validTask, eval: { type: 'bogus' as any } };
    const errors = validateTask(bad);
    expect(errors[0]).toContain('eval.type');
  });

  it('rejects task with negative timeout', () => {
    const bad = { ...validTask, timeout_ms: -1 };
    const errors = validateTask(bad);
    expect(errors[0]).toContain('timeout_ms');
  });

  it('accepts task with optional fields', () => {
    const full: BenchmarkTask = {
      ...validTask,
      intent_template: 'Navigate to {{url}} and extract the page title',
      instantiation_dict: { url: 'https://example.com' },
      reference_answers: { exact_match: 'Example Domain', must_include: ['Example'] },
      eval_fallback: { type: 'llm_judge', criteria: 'Did it get the title?' },
      roadmap_gate: null,
      enabled_after: null,
    };
    const errors = validateTask(full);
    expect(errors).toEqual([]);
  });

  it('exports correct category list', () => {
    expect(CATEGORIES).toContain('navigation');
    expect(CATEGORIES).toContain('intelligence');
    expect(CATEGORIES).toContain('competitive');
    expect(CATEGORIES).toHaveLength(11);
  });

  it('exports correct difficulty list', () => {
    expect(DIFFICULTIES).toContain('easy');
    expect(DIFFICULTIES).toContain('intelligence');
    expect(DIFFICULTIES).toHaveLength(4);
  });

  it('rejects task with zero timeout', () => {
    const bad = { ...validTask, timeout_ms: 0 };
    const errors = validateTask(bad);
    expect(errors[0]).toContain('timeout_ms');
  });

  it('rejects task with negative budget', () => {
    const bad = { ...validTask, max_budget_usd: -0.01 };
    const errors = validateTask(bad);
    expect(errors[0]).toContain('max_budget_usd');
  });

  it('handles null input gracefully', () => {
    const errors = validateTask(null as any);
    expect(errors).toContain('task must be a non-null object');
  });

  it('rejects task with missing requires.tools', () => {
    const bad = { ...validTask, requires: { ...validTask.requires, tools: 'not-array' as any } };
    const errors = validateTask(bad);
    expect(errors[0]).toContain('requires.tools');
  });
});
