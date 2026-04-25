/**
 * SD-04 unit coverage for the DomainPolicy security layer (layer 4).
 *
 * The e2e test in `test/e2e/security-layers.test.ts` proves the layer is
 * wired into the pipeline (trace event fires for example.com with
 * trustLevel='unknown'). This unit suite covers the rule branches that
 * would be too disruptive to exercise via real Safari:
 *
 *   - SENSITIVE_PATTERNS — paypal, banks, etc. → untrusted + privateWindow
 *   - Operator-supplied `blocked` list → blocked: true, audit-rejected at
 *     server.ts:465-471
 *   - Operator-supplied `trusted` list → trust: trusted
 *   - Glob matching for `*.example.com` subdomains
 *   - Default fallback → unknown
 *
 * Discrimination: remove SENSITIVE_PATTERNS → test 1 fails. Comment out
 * the blockedPatterns.add(domain) → test 2 fails. Remove the rule.set
 * for trusted → test 3 fails.
 */
import { describe, it, expect } from 'vitest';
import { DomainPolicy } from '../../../src/security/domain-policy.js';

describe('DomainPolicy (SD-04)', () => {
  it('built-in SENSITIVE_PATTERNS mark paypal as untrusted with privateWindow', () => {
    const dp = new DomainPolicy();
    const result = dp.evaluate('https://paypal.com/checkout/test');
    expect(result.trust).toBe('untrusted');
    expect(result.privateWindow).toBe(true);
    expect(result.blocked).toBe(false); // untrusted ≠ blocked
  });

  it('operator-supplied blocked list flips evaluate().blocked', () => {
    const dp = new DomainPolicy({ blocked: ['evil.test'] });
    const result = dp.evaluate('https://evil.test/path');
    expect(result.blocked).toBe(true);
    expect(result.trust).toBe('untrusted');
  });

  it('operator-supplied trusted list flips evaluate().trust', () => {
    const dp = new DomainPolicy({ trusted: ['internal.test'] });
    const result = dp.evaluate('https://internal.test/path');
    expect(result.trust).toBe('trusted');
  });

  it('default policy for unknown domains is "unknown" trust, not blocked', () => {
    const dp = new DomainPolicy();
    const result = dp.evaluate('https://example.com/');
    expect(result.trust).toBe('unknown');
    expect(result.privateWindow).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it('glob `*.bank.*` pattern matches sub.bank.example but not bank.com', () => {
    const dp = new DomainPolicy();
    expect(dp.evaluate('https://sub.bank.example/').trust).toBe('untrusted');
    // Per globToRegex (split on '*' → join '[^.]+'), `*.bank.*` should not
    // match `bank.com` directly because the leading `*.` requires a
    // subdomain segment.
    const bare = dp.evaluate('https://bank.com/');
    // bare bank.com should fall through to default 'unknown' since
    // `*.bank.*` requires both leading and trailing wildcard segments.
    expect(bare.trust).toBe('unknown');
  });

  it('addRule() adds a per-domain override at runtime', () => {
    const dp = new DomainPolicy();
    dp.addRule('runtime.test', { trust: 'trusted', maxActionsPerMinute: 600 });
    const result = dp.evaluate('https://runtime.test/');
    expect(result.trust).toBe('trusted');
    expect(result.maxActionsPerMinute).toBe(600);
  });

  it('config-supplied blocked domain does not override hardcoded SENSITIVE_PATTERNS', () => {
    // The constructor adds blocked entries only if the rule isn't already
    // set by SENSITIVE_PATTERNS. Trying to "block" paypal.com via config
    // should still resolve to the SENSITIVE_POLICY shape (untrusted +
    // privateWindow), with `blocked: true` because it's also in the
    // operator's blocked set.
    const dp = new DomainPolicy({ blocked: ['paypal.com'] });
    const result = dp.evaluate('https://paypal.com/');
    expect(result.privateWindow).toBe(true);
    expect(result.trust).toBe('untrusted');
    expect(result.blocked).toBe(true);
  });
});
