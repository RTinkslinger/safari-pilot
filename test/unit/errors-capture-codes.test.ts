// test/unit/errors-capture-codes.test.ts
import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '../../src/errors.js';

describe('error codes — capture additions (Task 5)', () => {
  it('WINDOW_CLOSED exists with retryable=false', () => {
    expect(ERROR_CODES.WINDOW_CLOSED).toBeDefined();
    expect(ERROR_CODES.WINDOW_CLOSED.retryable).toBe(false);
    expect(ERROR_CODES.WINDOW_CLOSED.hints?.length).toBeGreaterThan(0);
  });

  it('CAPTURE_RACE exists with retryable=true', () => {
    expect(ERROR_CODES.CAPTURE_RACE).toBeDefined();
    expect(ERROR_CODES.CAPTURE_RACE.retryable).toBe(true);
  });

  it('CAPTURE_FAILED exists with retryable=true', () => {
    expect(ERROR_CODES.CAPTURE_FAILED).toBeDefined();
    expect(ERROR_CODES.CAPTURE_FAILED.retryable).toBe(true);
  });

  it('TAB_NOT_FOUND already exists (regression check)', () => {
    expect(ERROR_CODES.TAB_NOT_FOUND).toBeDefined();
  });
});
