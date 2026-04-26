/**
 * T59 unit coverage for ScreenshotPolicy — the class that decides whether a
 * given URL's hostname falls inside the blocked-domain set.
 *
 * SCOPE: Policy-logic only (class in isolation). Handler wiring is covered in
 * test/unit/tools/take-screenshot-policy.test.ts (Task 4, 4 tests). Full
 * pipeline wiring is covered in test/e2e/security-layers.test.ts (Task 6,
 * 1 e2e litmus). Both land in the same PR.
 *
 * These 10 tests cover the code paths in checkDomain():
 *   1. Seed list blocks a matched banking subdomain; .domain = request hostname;
 *      .code === 'SCREENSHOT_BLOCKED'; error instanceof SafariPilotError.
 *   2. Seed list passes an unmatched hostname (no throw).
 *   3. Anchored patterns — "notchase.com" (prefix match) is not blocked.
 *   4. Anchored patterns — "chase.com.evil.com" (suffix match) is not blocked.
 *   5. Operator override with [] disables all blocking (empty replace).
 *   6. Non-empty override replaces seed — chase.com unblocked, custom domain
 *      blocked; .domain is the parsed hostname, not the pattern string.
 *   7. Seed list is active by default (no config) — blocks chase.com.
 *   8. Seed list blocks paypal.com in default mode (breadth check).
 *   9. Malformed URL → fail open; parseable non-HTTP URL is still blocked if
 *      hostname matches seed (ftp://paypal.com → hostname paypal.com → BLOCKED).
 *  10. Generic bank. pattern — blocks bank.io; does not over-block openbank.com.
 *
 * Discrimination:
 *   - Delete `find(p => p.test(hostname))` → tests 1, 7, 10 fail.
 *   - Delete `if (config?.blockedPatterns !== undefined)` → test 5 fails.
 *   - Use unanchored/substring pattern → tests 3 and 4 fail.
 *   - Use merge instead of replace for override → test 6 fails.
 *   - Extend Error instead of SafariPilotError → test 1 fails (instanceof check).
 *   - Wrong ERROR_CODE on ScreenshotBlockedError → test 1 fails (.code check).
 *   - Use /bank\.com$/i instead of /(^|\.)bank\./i → test 10 fails (bank.io).
 *   - Use /bank/i (unanchored) instead of /(^|\.)bank\./i → test 10 fails (openbank.com).
 */
import { describe, it, expect } from 'vitest';
import { ScreenshotPolicy } from '../../../src/security/screenshot-policy.js';
import { ScreenshotBlockedError } from '../../../src/errors.js';
import { SafariPilotError } from '../../../src/errors.js';

function catchFrom(fn: () => void): unknown {
  try { fn(); return null; } catch (e) { return e; }
}

describe('ScreenshotPolicy (T59)', () => {
  it('blocks a banking subdomain; .domain is the request hostname; error extends SafariPilotError', () => {
    const policy = new ScreenshotPolicy();
    const err = catchFrom(() => policy.checkDomain('https://online.chase.com/accounts'));
    expect(err).toBeInstanceOf(ScreenshotBlockedError);
    expect(err).toBeInstanceOf(SafariPilotError);
    expect((err as ScreenshotBlockedError).code).toBe('SCREENSHOT_BLOCKED');
    expect((err as ScreenshotBlockedError).domain).toBe('online.chase.com');
  });

  it('passes a non-banking URL without throwing', () => {
    const policy = new ScreenshotPolicy();
    expect(() => policy.checkDomain('https://example.com/page')).not.toThrow();
  });

  it('anchored patterns — prefix: notchase.com is not blocked', () => {
    // "notchase.com" contains "chase.com" as a suffix substring.
    // An unanchored implementation over-blocks it.
    const policy = new ScreenshotPolicy();
    expect(() => policy.checkDomain('https://notchase.com/')).not.toThrow();
  });

  it('anchored patterns — suffix: chase.com.evil.com is not blocked', () => {
    // "chase.com.evil.com" contains "chase.com" as a prefix substring.
    // A pattern without trailing $ over-blocks it.
    const policy = new ScreenshotPolicy();
    expect(() => policy.checkDomain('https://chase.com.evil.com/')).not.toThrow();
  });

  it('operator override with blockedPatterns:[] disables all blocking', () => {
    const policy = new ScreenshotPolicy({ blockedPatterns: [] });
    expect(() => policy.checkDomain('https://online.chase.com/accounts')).not.toThrow();
    expect(() => policy.checkDomain('https://paypal.com/checkout')).not.toThrow();
  });

  it('non-empty override replaces seed — chase.com unblocked, custom domain blocked; .domain is hostname not pattern', () => {
    // Verifies replace-vs-merge: if merge, chase.com would still be blocked.
    // The pattern string "^evil\\.com$" differs from the hostname "evil.com",
    // so .domain assertion distinguishes hostname from pattern copy.
    const policy = new ScreenshotPolicy({ blockedPatterns: ['^evil\\.com$'] });
    expect(() => policy.checkDomain('https://chase.com/')).not.toThrow();
    const err = catchFrom(() => policy.checkDomain('https://evil.com/'));
    expect(err).toBeInstanceOf(ScreenshotBlockedError);
    expect((err as ScreenshotBlockedError).domain).toBe('evil.com');
  });

  it('seed list is active by default (no config arg) — blocks chase.com; .domain is chase.com', () => {
    const policy = new ScreenshotPolicy();
    const err = catchFrom(() => policy.checkDomain('https://chase.com/'));
    expect(err).toBeInstanceOf(ScreenshotBlockedError);
    expect((err as ScreenshotBlockedError).domain).toBe('chase.com');
  });

  it('seed list blocks paypal.com in default mode (triangulates seed breadth beyond chase.com)', () => {
    const policy = new ScreenshotPolicy();
    expect(() => policy.checkDomain('https://paypal.com/checkout')).toThrow(ScreenshotBlockedError);
  });

  it('malformed URL → fail open; parseable non-HTTP URL is still blocked if hostname matches seed', () => {
    const policy = new ScreenshotPolicy();
    expect(() => policy.checkDomain('not-a-url')).not.toThrow();
    expect(() => policy.checkDomain('')).not.toThrow();
    // ftp://paypal.com parses (hostname = paypal.com); impl checks hostname only, not protocol
    expect(() => policy.checkDomain('ftp://paypal.com/')).toThrow(ScreenshotBlockedError);
  });

  it('generic bank. pattern — blocks bank.io; does not over-block openbank.com', () => {
    // The seed uses /(^|\.)bank\./i which is TLD-agnostic (matches bank.io, bank.co.uk)
    // but anchored to prevent substring matches inside names like "openbank.com".
    const policy = new ScreenshotPolicy();
    expect(() => policy.checkDomain('https://bank.io/')).toThrow(ScreenshotBlockedError);
    expect(() => policy.checkDomain('https://openbank.com/')).not.toThrow();
  });
});
