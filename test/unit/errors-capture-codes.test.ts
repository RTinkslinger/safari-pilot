import { describe, it, expect } from 'vitest';
import { ERROR_CODES, ERROR_METADATA } from '../../src/errors.js';

describe('error codes — capture additions (Task 5)', () => {
  it('WINDOW_CLOSED is registered as a string code', () => {
    expect(ERROR_CODES.WINDOW_CLOSED).toBe('WINDOW_CLOSED');
  });

  it('WINDOW_CLOSED metadata: retryable=false, has hints', () => {
    const meta = ERROR_METADATA.WINDOW_CLOSED;
    expect(meta?.retryable).toBe(false);
    expect((meta?.hints?.length ?? 0)).toBeGreaterThan(0);
  });

  it('CAPTURE_RACE: code + retryable=true', () => {
    expect(ERROR_CODES.CAPTURE_RACE).toBe('CAPTURE_RACE');
    expect(ERROR_METADATA.CAPTURE_RACE?.retryable).toBe(true);
  });

  it('CAPTURE_FAILED: code + retryable=true', () => {
    expect(ERROR_CODES.CAPTURE_FAILED).toBe('CAPTURE_FAILED');
    expect(ERROR_METADATA.CAPTURE_FAILED?.retryable).toBe(true);
  });

  it('INVALID_PARAMS: code + retryable=false', () => {
    expect(ERROR_CODES.INVALID_PARAMS).toBe('INVALID_PARAMS');
    expect(ERROR_METADATA.INVALID_PARAMS?.retryable).toBe(false);
  });

  it('TAB_NOT_FOUND already exists (regression check)', () => {
    expect(ERROR_CODES.TAB_NOT_FOUND).toBe('TAB_NOT_FOUND');
  });
});
