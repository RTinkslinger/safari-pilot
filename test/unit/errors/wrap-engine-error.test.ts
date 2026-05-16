import { describe, expect, it } from 'vitest';
import {
  wrapEngineError,
  EngineExecutionError,
  SafariPilotError,
  ERROR_CODES,
} from '../../../src/errors.js';
import type { EngineError } from '../../../src/types.js';

describe('wrapEngineError (F3.1)', () => {
  it('lifts code/message/retryable/hints from EngineError into EngineExecutionError', () => {
    const engineErr: EngineError = {
      code: 'DAEMON_TIMEOUT',
      message: "Daemon command 'execute' timed out after 30000ms",
      retryable: false,
      hints: ['Switch tools', 'Call safari_wait_for first'],
    };

    const wrapped = wrapEngineError(engineErr, 'fallback should not show');

    expect(wrapped).toBeInstanceOf(SafariPilotError);
    expect(wrapped).toBeInstanceOf(EngineExecutionError);
    expect(wrapped.code).toBe('DAEMON_TIMEOUT');
    expect(wrapped.message).toBe("Daemon command 'execute' timed out after 30000ms");
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.hints).toEqual(['Switch tools', 'Call safari_wait_for first']);
  });

  it('returns EngineExecutionError with INTERNAL_ERROR code when engineErr is undefined', () => {
    // Single return-type design: even the "no engine error" case is an
    // EngineExecutionError so callers / catch blocks see a uniform shape.
    // The fallback message survives verbatim (no "Internal error:" prefix
    // that the legacy InternalError class adds).
    const wrapped = wrapEngineError(undefined, 'Shadow query failed');
    expect(wrapped).toBeInstanceOf(SafariPilotError);
    expect(wrapped).toBeInstanceOf(EngineExecutionError);
    expect(wrapped.code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect(wrapped.message).toBe('Shadow query failed');
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.hints).toEqual([]);
  });

  it('defaults retryable to false and hints to [] when EngineError omits them', () => {
    const minimalErr = {
      code: 'CSP_BLOCKED',
      message: 'CSP rejected the script',
    } as EngineError;
    const wrapped = wrapEngineError(minimalErr, 'fallback');
    expect(wrapped.code).toBe('CSP_BLOCKED');
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.hints).toEqual([]);
  });

  it('preserves an unknown code string verbatim (no enum coercion)', () => {
    const futureErr: EngineError = {
      code: 'SOME_FUTURE_CODE',
      message: 'm',
      retryable: true,
      hints: [],
    };
    const wrapped = wrapEngineError(futureErr, 'fb');
    expect(wrapped.code).toBe('SOME_FUTURE_CODE');
    expect(wrapped.retryable).toBe(true);
  });

  it('copies hints by value (mutating the input array does not affect the wrapped error)', () => {
    const hints = ['a', 'b'];
    const wrapped = wrapEngineError(
      { code: 'X', message: 'm', retryable: false, hints },
      'fb',
    );
    hints.push('c');
    expect(wrapped.hints).toEqual(['a', 'b']);
  });
});
