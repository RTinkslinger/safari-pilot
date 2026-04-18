import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker } from '../../../src/security/circuit-breaker.js';

describe('CircuitBreaker — engine scope (Task 9)', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker();
  });

  it('trips after 5 EXTENSION_TIMEOUT errors', () => {
    for (let i = 0; i < 4; i++) cb.recordEngineFailure('extension', 'EXTENSION_TIMEOUT');
    expect(cb.isEngineTripped('extension')).toBe(false);
    cb.recordEngineFailure('extension', 'EXTENSION_TIMEOUT');
    expect(cb.isEngineTripped('extension')).toBe(true);
  });

  it('EXTENSION_UNCERTAIN counts toward engine breaker', () => {
    for (let i = 0; i < 5; i++) cb.recordEngineFailure('extension', 'EXTENSION_UNCERTAIN');
    expect(cb.isEngineTripped('extension')).toBe(true);
  });

  it('EXTENSION_DISCONNECTED counts toward engine breaker', () => {
    for (let i = 0; i < 5; i++) cb.recordEngineFailure('extension', 'EXTENSION_DISCONNECTED');
    expect(cb.isEngineTripped('extension')).toBe(true);
  });

  it('unrelated error codes do not count', () => {
    for (let i = 0; i < 20; i++) cb.recordEngineFailure('extension', 'INTERNAL_ERROR');
    expect(cb.isEngineTripped('extension')).toBe(false);
  });

  it('per-engine breaker is separate from per-domain breaker', () => {
    for (let i = 0; i < 5; i++) cb.recordEngineFailure('extension', 'EXTENSION_TIMEOUT');
    expect(cb.isOpen('example.com')).toBe(false);
    expect(cb.isEngineTripped('extension')).toBe(true);
  });

  it('per-domain failures do not affect engine breaker', () => {
    for (let i = 0; i < 10; i++) cb.recordFailure('example.com');
    expect(cb.isEngineTripped('extension')).toBe(false);
  });

  describe('with fake timers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('engine breaker resets after 120s cooldown', () => {
      for (let i = 0; i < 5; i++) cb.recordEngineFailure('extension', 'EXTENSION_TIMEOUT');
      expect(cb.isEngineTripped('extension')).toBe(true);
      vi.advanceTimersByTime(121_000);
      expect(cb.isEngineTripped('extension')).toBe(false);
    });

    it('stale failures outside 120s window are dropped', () => {
      for (let i = 0; i < 4; i++) cb.recordEngineFailure('extension', 'EXTENSION_TIMEOUT');
      vi.advanceTimersByTime(121_000);
      // 4 old failures expire; 5 new do NOT accumulate past threshold until 5
      for (let i = 0; i < 4; i++) cb.recordEngineFailure('extension', 'EXTENSION_TIMEOUT');
      expect(cb.isEngineTripped('extension')).toBe(false);
      cb.recordEngineFailure('extension', 'EXTENSION_TIMEOUT');
      expect(cb.isEngineTripped('extension')).toBe(true);
    });
  });

  it('getEngineState returns closed/open correctly', () => {
    expect(cb.getEngineState('extension')).toBe('closed');
    for (let i = 0; i < 5; i++) cb.recordEngineFailure('extension', 'EXTENSION_TIMEOUT');
    expect(cb.getEngineState('extension')).toBe('open');
  });
});
