import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter } from '../../../src/security/rate-limiter.js';
import { RateLimitedError } from '../../../src/errors.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Basic allowance ─────────────────────────────────────────────────────────

  it('allows actions under the global limit', () => {
    // Default global limit is 120; record 10 and still be allowed
    for (let i = 0; i < 10; i++) {
      limiter.recordAction('example.com');
    }
    const check = limiter.checkLimit('example.com');
    expect(check.allowed).toBe(true);
    expect(check.remaining).toBe(110);
  });

  it('blocks the next action when limit is reached', () => {
    limiter.setDomainLimit('tight.com', 3);
    limiter.recordAction('tight.com');
    limiter.recordAction('tight.com');
    limiter.recordAction('tight.com');

    const check = limiter.checkLimit('tight.com');
    expect(check.allowed).toBe(false);
    expect(check.remaining).toBe(0);
  });

  it('recordAction throws RateLimitedError when limit is exceeded', () => {
    limiter.setDomainLimit('tight.com', 2);
    limiter.recordAction('tight.com');
    limiter.recordAction('tight.com');
    expect(() => limiter.recordAction('tight.com')).toThrow(RateLimitedError);
  });

  // ── Remaining count ─────────────────────────────────────────────────────────

  it('reports remaining count correctly after several actions', () => {
    limiter.setDomainLimit('counted.com', 10);
    for (let i = 0; i < 4; i++) limiter.recordAction('counted.com');
    const check = limiter.checkLimit('counted.com');
    expect(check.remaining).toBe(6);
  });

  // ── Sliding window ──────────────────────────────────────────────────────────

  it('sliding window clears entries older than 60 seconds', () => {
    limiter.setDomainLimit('sliding.com', 5);

    // Fill to limit
    for (let i = 0; i < 5; i++) limiter.recordAction('sliding.com');
    expect(limiter.checkLimit('sliding.com').allowed).toBe(false);

    // Advance clock past the 60-second window
    vi.advanceTimersByTime(61_000);

    // Old entries should have expired — limit resets
    expect(limiter.checkLimit('sliding.com').allowed).toBe(true);
    expect(limiter.checkLimit('sliding.com').remaining).toBe(5);
  });

  it('resetMs reflects time until the oldest entry expires', () => {
    limiter.setDomainLimit('reset.com', 5);
    limiter.recordAction('reset.com');

    // Advance 30 seconds — entry is 30s old, 30s remain
    vi.advanceTimersByTime(30_000);
    const check = limiter.checkLimit('reset.com');
    // resetMs should be roughly 30 000 ms (within a small tolerance)
    expect(check.resetMs).toBeGreaterThan(29_000);
    expect(check.resetMs).toBeLessThanOrEqual(30_000);
  });

  // ── Per-domain limits ───────────────────────────────────────────────────────

  it('per-domain limit is independent of other domains', () => {
    limiter.setDomainLimit('a.com', 2);
    limiter.setDomainLimit('b.com', 10);

    limiter.recordAction('a.com');
    limiter.recordAction('a.com');

    // a.com is now at limit
    expect(limiter.checkLimit('a.com').allowed).toBe(false);
    // b.com is unaffected
    expect(limiter.checkLimit('b.com').allowed).toBe(true);
  });

  // ── Global default limit ────────────────────────────────────────────────────

  it('applies the global default limit (120) for unknown domains', () => {
    const check = limiter.checkLimit('new-domain.com');
    expect(check.remaining).toBe(120);
  });
});
