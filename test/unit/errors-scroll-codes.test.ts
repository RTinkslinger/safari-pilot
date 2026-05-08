import { describe, it, expect } from 'vitest';
import { ERROR_CODES, ERROR_METADATA } from '../../src/errors.js';

describe('error codes — scroll additions (v0.1.31 Task 1)', () => {
  it('TARGET_NOT_FOUND is registered as a string code', () => {
    expect(ERROR_CODES.TARGET_NOT_FOUND).toBe('TARGET_NOT_FOUND');
  });

  it('TARGET_NOT_FOUND metadata: retryable=false, has hints', () => {
    const meta = ERROR_METADATA.TARGET_NOT_FOUND;
    expect(meta?.retryable).toBe(false);
    expect((meta?.hints?.length ?? 0)).toBeGreaterThan(0);
    expect(meta?.hints?.[0]).toMatch(/locator|cross-origin/i);
  });

  it('TARGET_HIDDEN: code + retryable=false', () => {
    expect(ERROR_CODES.TARGET_HIDDEN).toBe('TARGET_HIDDEN');
    expect(ERROR_METADATA.TARGET_HIDDEN?.retryable).toBe(false);
    expect(ERROR_METADATA.TARGET_HIDDEN?.hints?.[0]).toMatch(/display:none|details|expand/i);
  });

  it('CROSS_ORIGIN_FRAME is NOT re-added (per SD-22 deletion precedent)', () => {
    expect((ERROR_CODES as Record<string, unknown>).CROSS_ORIGIN_FRAME).toBeUndefined();
  });

  it('INVALID_PARAMS already exists (regression check)', () => {
    expect(ERROR_CODES.INVALID_PARAMS).toBe('INVALID_PARAMS');
  });
});
