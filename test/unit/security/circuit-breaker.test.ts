/**
 * SD-04 unit coverage for the per-domain CircuitBreaker.
 *
 * The CircuitBreaker has TWO scopes (per ARCHITECTURE.md):
 *   - Per-domain: failureThreshold consecutive failures within windowMs trip
 *     the breaker for cooldownMs. State machine: closed → open → half-open.
 *   - Per-engine: 5 EXTENSION_* errors in 120s trip the engine breaker. T12's
 *     `record-tool-failure.test.ts` covers this scope already.
 *
 * This file covers ONLY the per-domain scope. SD-04 explicitly distinguishes
 * "per-domain CircuitBreaker (distinct from T12's engine breaker)".
 *
 * Discrimination:
 *   - Comment out the threshold check at recordFailure → test 2 fails.
 *   - Comment out the throw inside assertClosed when state === 'open' → test
 *     3 fails.
 *   - Change cooldown semantics (e.g. always return 'open' regardless of
 *     elapsed) → test 5 fails.
 */
import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../../../src/security/circuit-breaker.js';
import { CircuitBreakerOpenError } from '../../../src/errors.js';

describe('CircuitBreaker per-domain (SD-04)', () => {
  it('starts in closed state with no failures recorded', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState('example.com')).toBe('closed');
    expect(cb.isOpen('example.com')).toBe(false);
    expect(() => cb.assertClosed('example.com')).not.toThrow();
  });

  it('trips to open after failureThreshold consecutive failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 120_000 });
    for (let i = 0; i < 4; i++) {
      cb.recordFailure('flaky.test');
      expect(cb.getState('flaky.test')).toBe('closed');
    }
    cb.recordFailure('flaky.test'); // 5th failure trips
    expect(cb.getState('flaky.test')).toBe('open');
    expect(cb.isOpen('flaky.test')).toBe(true);
  });

  it('assertClosed in open state throws CircuitBreakerOpenError with cooldown', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure('broken.test');
    cb.recordFailure('broken.test');
    expect(cb.isOpen('broken.test')).toBe(true);

    try {
      cb.assertClosed('broken.test');
      expect.fail('expected CircuitBreakerOpenError');
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitBreakerOpenError);
      expect((err as CircuitBreakerOpenError).code).toBe('CIRCUIT_BREAKER_OPEN');
      expect((err as CircuitBreakerOpenError).message).toContain('broken.test');
    }
  });

  it('recordSuccess resets the failure counter and closes the circuit', () => {
    const cb = new CircuitBreaker({ failureThreshold: 5 });
    cb.recordFailure('intermittent.test');
    cb.recordFailure('intermittent.test');
    cb.recordSuccess('intermittent.test');

    // Counter is back to zero — must take 5 fresh failures to trip
    for (let i = 0; i < 4; i++) cb.recordFailure('intermittent.test');
    expect(cb.getState('intermittent.test')).toBe('closed');
  });

  it('after cooldown elapses the state transitions to half-open', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 50 });
    cb.recordFailure('cooldown.test');
    cb.recordFailure('cooldown.test');
    expect(cb.getState('cooldown.test')).toBe('open');

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cb.getState('cooldown.test')).toBe('half-open');
        // The single half-open probe is allowed through
        expect(() => cb.assertClosed('cooldown.test')).not.toThrow();
        resolve();
      }, 75);
    });
  });

  it('half-open probe failure re-opens the circuit immediately', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 30 });
    cb.recordFailure('probe.test');
    cb.recordFailure('probe.test');

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cb.getState('probe.test')).toBe('half-open');
        cb.assertClosed('probe.test'); // probe issued
        cb.recordFailure('probe.test'); // probe failed
        expect(cb.getState('probe.test')).toBe('open');
        expect(() => cb.assertClosed('probe.test')).toThrow(CircuitBreakerOpenError);
        resolve();
      }, 60);
    });
  });

  it('per-domain isolation — failures on one domain do not affect another', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure('a.test');
    cb.recordFailure('a.test');
    expect(cb.isOpen('a.test')).toBe(true);
    expect(cb.isOpen('b.test')).toBe(false);
    expect(() => cb.assertClosed('b.test')).not.toThrow();
  });
});
