/**
 * SD-04 unit coverage for the RateLimiter security layer.
 *
 * The RateLimiter is layer 5 of the 9-layer pipeline. It enforces a sliding
 * window per domain — global default 120/min, per-domain overrides allowed.
 * Server.ts calls `checkLimit` then `recordAction` for every tool call.
 *
 * Coverage previously: zero. The failure mode (the 121st call to one domain)
 * had no test guarding it.
 *
 * Discrimination: comment out the throw in `recordAction` (lines 67-69 of
 * src/security/rate-limiter.ts) → test 2 fails (no throw on overflow).
 * Revert `setDomainLimit` lookup in `limitFor` → test 3 fails (per-domain
 * override ignored, falls back to global).
 */
import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../../src/security/rate-limiter.js';
import { RateLimitedError } from '../../../src/errors.js';

describe('RateLimiter (SD-04)', () => {
  it('checkLimit reports allowed=true while under the configured limit', () => {
    const rl = new RateLimiter({ globalLimit: 5 });
    expect(rl.checkLimit('example.com').allowed).toBe(true);
    rl.recordAction('example.com');
    rl.recordAction('example.com');
    const result = rl.checkLimit('example.com');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(3);
  });

  it('recordAction throws RateLimitedError on the (limit+1)th call', () => {
    const rl = new RateLimiter({ globalLimit: 3 });
    rl.recordAction('example.com');
    rl.recordAction('example.com');
    rl.recordAction('example.com');

    expect(() => rl.recordAction('example.com')).toThrow(RateLimitedError);
    try {
      rl.recordAction('example.com');
      expect.fail('expected RateLimitedError');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).code).toBe('RATE_LIMITED');
      expect((err as RateLimitedError).message).toContain('example.com');
    }
  });

  it('per-domain limit overrides the global default', () => {
    const rl = new RateLimiter({ globalLimit: 100 });
    rl.setDomainLimit('strict.test', 2);
    rl.recordAction('strict.test');
    rl.recordAction('strict.test');
    // 3rd call exceeds the per-domain limit even though it's under the global
    expect(() => rl.recordAction('strict.test')).toThrow(RateLimitedError);
    // Other domains are unaffected
    expect(() => rl.recordAction('other.test')).not.toThrow();
  });

  it('checkLimit reports zero remaining when at the limit', () => {
    const rl = new RateLimiter({ globalLimit: 2 });
    rl.recordAction('a.test');
    rl.recordAction('a.test');
    const result = rl.checkLimit('a.test');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('window expiry releases capacity (sliding window semantics)', () => {
    // 50ms window — far smaller than the 60s production window, but the
    // semantics are identical.
    const rl = new RateLimiter({ globalLimit: 2, windowMs: 50 });
    rl.recordAction('w.test');
    rl.recordAction('w.test');
    expect(() => rl.recordAction('w.test')).toThrow(RateLimitedError);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // Window has elapsed — old entries pruned, new action permitted
        expect(() => rl.recordAction('w.test')).not.toThrow();
        resolve();
      }, 75);
    });
  });
});
