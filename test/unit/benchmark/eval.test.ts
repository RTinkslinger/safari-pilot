import { describe, it, expect } from 'vitest';
import { evaluate } from '../../../src/benchmark/eval.js';
import type { TaskEval } from '../../../src/benchmark/types.js';

describe('evaluate', () => {
  describe('exact_match', () => {
    const evalDef: TaskEval = { type: 'exact_match', expected: 'Example Domain' };

    it('passes on exact match', () => {
      const r = evaluate(evalDef, 'Example Domain');
      expect(r.passed).toBe(true);
    });

    it('fails on mismatch', () => {
      const r = evaluate(evalDef, 'Wrong Title');
      expect(r.passed).toBe(false);
    });

    it('supports case-insensitive match', () => {
      const ci: TaskEval = { ...evalDef, case_insensitive: true };
      const r = evaluate(ci, 'example domain');
      expect(r.passed).toBe(true);
    });

    it('handles JSON output — extracts result field', () => {
      const r = evaluate(evalDef, JSON.stringify({ result: 'Example Domain' }));
      expect(r.passed).toBe(true);
    });
  });

  describe('contains', () => {
    const evalDef: TaskEval = { type: 'contains', must_include: ['Tokyo', '13'] };

    it('passes when all substrings present', () => {
      const r = evaluate(evalDef, 'The population of Tokyo is approximately 13.96 million');
      expect(r.passed).toBe(true);
    });

    it('fails when any substring missing', () => {
      const r = evaluate(evalDef, 'The population of Tokyo is large');
      expect(r.passed).toBe(false);
      expect(r.details).toHaveProperty('missing');
    });
  });

  describe('structured_output', () => {
    const evalDef: TaskEval = {
      type: 'structured_output',
      schema: {
        type: 'object',
        properties: { name: { type: 'string' }, count: { type: 'number' } },
        required: ['name', 'count'],
      },
    };

    it('passes valid JSON matching schema', () => {
      const r = evaluate(evalDef, JSON.stringify({ name: 'test', count: 5 }));
      expect(r.passed).toBe(true);
    });

    it('fails when required fields missing', () => {
      const r = evaluate(evalDef, JSON.stringify({ name: 'test' }));
      expect(r.passed).toBe(false);
    });

    it('fails on non-JSON input', () => {
      const r = evaluate(evalDef, 'not json');
      expect(r.passed).toBe(false);
    });

    it('validates array minItems', () => {
      const arrayEval: TaskEval = {
        type: 'structured_output',
        schema: {
          type: 'object',
          properties: { items: { type: 'array', minItems: 3 } },
          required: ['items'],
        },
      };
      const r = evaluate(arrayEval, JSON.stringify({ items: [1, 2] }));
      expect(r.passed).toBe(false);
    });
  });

  describe('llm_judge', () => {
    it('returns pending for llm_judge — requires external call', () => {
      const evalDef: TaskEval = { type: 'llm_judge', criteria: 'Did it work?' };
      const r = evaluate(evalDef, 'Some output');
      expect(r.passed).toBe(false);
      expect(r.pending).toBe(true);
      expect(r.evalType).toBe('llm_judge');
    });
  });

  describe('edge cases', () => {
    it('handles empty output', () => {
      const r = evaluate({ type: 'exact_match', expected: 'x' }, '');
      expect(r.passed).toBe(false);
    });

    it('handles undefined eval fields gracefully', () => {
      const r = evaluate({ type: 'contains' }, 'output');
      expect(r.passed).toBe(false);
    });
  });
});
