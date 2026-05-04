/**
 * T77 A-6 / T80 prerequisite: STRICTNESS_VIOLATION error code + concrete
 * subclass thrown by action tools (click/fill/etc) when locator resolution
 * yields multi-match without disambiguation (first/last/nth/testId/xpath
 * or flat nth). Read tools keep pick-first behavior. Matches Playwright's
 * strict-mode contract.
 *
 * The actual throw sites land in A-9 (T80 folded in). This file pins the
 * error-code surface so A-9 has a stable target.
 */
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, StrictnessViolationError, formatToolError } from '../../../src/errors.js';

describe('T77 A-6 — STRICTNESS_VIOLATION error code', () => {
  it('ERROR_CODES exposes STRICTNESS_VIOLATION', () => {
    expect(ERROR_CODES.STRICTNESS_VIOLATION).toBe('STRICTNESS_VIOLATION');
  });

  it('StrictnessViolationError is constructable with matchCount + locator description', () => {
    const err = new StrictnessViolationError(4, 'role=button');
    expect(err.code).toBe('STRICTNESS_VIOLATION');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('4');
    expect(err.message).toContain('expected exactly 1');
  });

  it('StrictnessViolationError exposes hints guiding disambiguation', () => {
    const err = new StrictnessViolationError(3, 'role=button');
    expect(err.hints.length).toBeGreaterThan(0);
    expect(err.hints.some((h: string) => /first|last|nth/i.test(h))).toBe(true);
  });

  it('StrictnessViolationError is not retryable (multi-match is a caller-side spec issue)', () => {
    const err = new StrictnessViolationError(2, 'testId=foo');
    expect(err.retryable).toBe(false);
  });

  it('formatToolError serializes a StrictnessViolationError to the standard ToolError shape', () => {
    const err = new StrictnessViolationError(5, 'role=button name=Submit');
    const formatted = formatToolError(err, 'extension', 12);
    expect(formatted.code).toBe('STRICTNESS_VIOLATION');
    expect(formatted.retryable).toBe(false);
    expect(formatted.context.engine).toBe('extension');
    expect(formatted.context.elapsed_ms).toBe(12);
    expect(Array.isArray(formatted.hints)).toBe(true);
  });
});
