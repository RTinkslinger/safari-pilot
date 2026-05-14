import { describe, it, expect } from 'vitest';
import { aggregateMajorityVerdict } from '../../../bench/webvoyager/judge.js';
import type { JudgeVerdict } from '../../../bench/webvoyager/types.js';

describe('aggregateMajorityVerdict', () => {
  it('returns SUCCESS when 2 of 3 runs are SUCCESS', () => {
    const result = aggregateMajorityVerdict<JudgeVerdict>(['SUCCESS', 'SUCCESS', 'FAILURE']);
    expect(result).toBe('SUCCESS');
  });

  it('returns FAILURE when 2 of 3 runs are FAILURE', () => {
    expect(aggregateMajorityVerdict<JudgeVerdict>(['FAILURE', 'FAILURE', 'SUCCESS'])).toBe('FAILURE');
  });

  it('returns UNKNOWN when no majority', () => {
    expect(aggregateMajorityVerdict<JudgeVerdict>(['SUCCESS', 'FAILURE', 'UNKNOWN'])).toBe('UNKNOWN');
  });

  it('handles single-run input by returning the only verdict', () => {
    expect(aggregateMajorityVerdict<JudgeVerdict>(['SUCCESS'])).toBe('SUCCESS');
  });

  it('handles 5-run input with 3 SUCCESS', () => {
    expect(aggregateMajorityVerdict<JudgeVerdict>(['SUCCESS', 'SUCCESS', 'SUCCESS', 'FAILURE', 'FAILURE'])).toBe('SUCCESS');
  });
});
