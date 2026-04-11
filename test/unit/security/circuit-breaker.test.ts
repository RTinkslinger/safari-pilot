import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircuitBreaker } from '../../../src/security/circuit-breaker.js';
import { CircuitBreakerOpenError } from '../../../src/errors.js';

describe('CircuitBreaker', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Initial state ────────────────────────────────────────────────────────────

  it('starts in closed state for any domain', () => {
    expect(cb.getState('example.com')).toBe('closed');
    expect(cb.isOpen('example.com')).toBe(false);
  });

  it('assertClosed does not throw when circuit is closed', () => {
    expect(() => cb.assertClosed('example.com')).not.toThrow();
  });

  // ── Opening the circuit ──────────────────────────────────────────────────────

  it('opens after 5 consecutive failures', () => {
    for (let i = 0; i < 5; i++) cb.recordFailure('example.com');
    expect(cb.getState('example.com')).toBe('open');
    expect(cb.isOpen('example.com')).toBe(true);
  });

  it('does not open before reaching threshold (4 failures)', () => {
    for (let i = 0; i < 4; i++) cb.recordFailure('example.com');
    expect(cb.getState('example.com')).toBe('closed');
  });

  it('throws CircuitBreakerOpenError when circuit is open', () => {
    for (let i = 0; i < 5; i++) cb.recordFailure('example.com');
    expect(() => cb.assertClosed('example.com')).toThrow(CircuitBreakerOpenError);
  });

  // ── Success resets the circuit ───────────────────────────────────────────────

  it('recordSuccess resets failure count and closes circuit', () => {
    for (let i = 0; i < 4; i++) cb.recordFailure('example.com');
    cb.recordSuccess('example.com');
    expect(cb.getState('example.com')).toBe('closed');
    // One more failure should not open (counter was reset)
    cb.recordFailure('example.com');
    expect(cb.getState('example.com')).toBe('closed');
  });

  it('recordSuccess on an open circuit closes it immediately', () => {
    for (let i = 0; i < 5; i++) cb.recordFailure('tripped.com');
    expect(cb.getState('tripped.com')).toBe('open');
    cb.recordSuccess('tripped.com');
    expect(cb.getState('tripped.com')).toBe('closed');
  });

  // ── Half-open transition ─────────────────────────────────────────────────────

  it('transitions to half-open after 120-second cooldown', () => {
    for (let i = 0; i < 5; i++) cb.recordFailure('example.com');
    expect(cb.getState('example.com')).toBe('open');

    vi.advanceTimersByTime(120_001);
    expect(cb.getState('example.com')).toBe('half-open');
    expect(cb.isOpen('example.com')).toBe(false);
  });

  it('allows exactly one probe call in half-open state', () => {
    for (let i = 0; i < 5; i++) cb.recordFailure('example.com');
    vi.advanceTimersByTime(120_001);

    // First probe call goes through
    expect(() => cb.assertClosed('example.com')).not.toThrow();

    // Second call is rejected until success or failure is recorded
    expect(() => cb.assertClosed('example.com')).toThrow(CircuitBreakerOpenError);
  });

  it('closes circuit when probe succeeds in half-open state', () => {
    for (let i = 0; i < 5; i++) cb.recordFailure('example.com');
    vi.advanceTimersByTime(120_001);

    cb.assertClosed('example.com'); // issue probe
    cb.recordSuccess('example.com');

    expect(cb.getState('example.com')).toBe('closed');
    expect(() => cb.assertClosed('example.com')).not.toThrow();
  });

  it('re-opens circuit when probe fails in half-open state', () => {
    for (let i = 0; i < 5; i++) cb.recordFailure('example.com');
    vi.advanceTimersByTime(120_001);

    cb.assertClosed('example.com'); // issue probe
    cb.recordFailure('example.com'); // probe fails → circuit re-opens

    expect(cb.getState('example.com')).toBe('open');
  });

  // ── Per-domain isolation ─────────────────────────────────────────────────────

  it('circuit state is independent per domain', () => {
    for (let i = 0; i < 5; i++) cb.recordFailure('bad.com');
    expect(cb.getState('bad.com')).toBe('open');
    expect(cb.getState('good.com')).toBe('closed');
  });
});
