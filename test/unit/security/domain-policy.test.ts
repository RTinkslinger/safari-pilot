import { describe, it, expect, beforeEach } from 'vitest';
import { DomainPolicy } from '../../../src/security/domain-policy.js';

describe('DomainPolicy', () => {
  let policy: DomainPolicy;

  beforeEach(() => {
    policy = new DomainPolicy();
  });

  // ── Default behaviour ───────────────────────────────────────────────────────

  it('returns default policy for unknown domain', () => {
    const result = policy.evaluate('https://unknown-domain-xyz.com');
    expect(result.trust).toBe('unknown');
    expect(result.privateWindow).toBe(false);
    expect(result.extensionAllowed).toBe(false);
    expect(result.maxActionsPerMinute).toBe(60);
  });

  // ── Rule management ─────────────────────────────────────────────────────────

  it('applies a trusted-domain rule', () => {
    policy.addRule('example.com', {
      trust: 'trusted',
      extensionAllowed: true,
      maxActionsPerMinute: 200,
    });
    const result = policy.evaluate('https://example.com/path');
    expect(result.trust).toBe('trusted');
    expect(result.extensionAllowed).toBe(true);
    expect(result.maxActionsPerMinute).toBe(200);
  });

  it('addRule merges with defaults — unset fields stay at default', () => {
    policy.addRule('partial.com', { trust: 'trusted' });
    const result = policy.evaluate('https://partial.com');
    expect(result.trust).toBe('trusted');
    expect(result.privateWindow).toBe(false); // default
    expect(result.maxActionsPerMinute).toBe(60); // default
  });

  it('removeRule restores default policy for that domain', () => {
    policy.addRule('example.com', { trust: 'trusted' });
    policy.removeRule('example.com');
    const result = policy.evaluate('https://example.com');
    expect(result.trust).toBe('unknown');
  });

  // ── Untrusted forces private window ─────────────────────────────────────────

  it('untrusted domain rule sets privateWindow', () => {
    policy.addRule('shady.com', { trust: 'untrusted', privateWindow: true });
    const result = policy.evaluate('https://shady.com');
    expect(result.trust).toBe('untrusted');
    expect(result.privateWindow).toBe(true);
  });

  // ── Glob matching ────────────────────────────────────────────────────────────

  it('glob *.example.com matches sub.example.com', () => {
    policy.addRule('*.example.com', { trust: 'trusted', maxActionsPerMinute: 150 });
    const result = policy.evaluate('https://sub.example.com/page');
    expect(result.trust).toBe('trusted');
    expect(result.maxActionsPerMinute).toBe(150);
  });

  it('glob *.example.com does NOT match example.com itself', () => {
    policy.addRule('*.example.com', { trust: 'trusted' });
    const result = policy.evaluate('https://example.com');
    expect(result.trust).toBe('unknown');
  });

  // ── Built-in banking rules ───────────────────────────────────────────────────

  it('paypal.com is untrusted with private window by default', () => {
    const result = policy.evaluate('https://paypal.com/checkout');
    expect(result.trust).toBe('untrusted');
    expect(result.privateWindow).toBe(true);
  });

  it('sub.paypal.com is untrusted with private window by default', () => {
    const result = policy.evaluate('https://www.paypal.com/myaccount');
    expect(result.trust).toBe('untrusted');
    expect(result.privateWindow).toBe(true);
  });

  it('chase.com is treated as sensitive (untrusted, private)', () => {
    const result = policy.evaluate('https://chase.com/login');
    expect(result.trust).toBe('untrusted');
    expect(result.privateWindow).toBe(true);
  });
});
