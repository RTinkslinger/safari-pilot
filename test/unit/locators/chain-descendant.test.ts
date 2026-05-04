/**
 * T77 A-4: descendant chain op (re-rooting nested locator).
 *
 * Pre-fix: chain ops only support positional + filter narrowing.
 * Post-fix: descendant re-roots — replaces `matched` with elements found
 * INSIDE each current match satisfying a nested locator descriptor.
 *
 * v1 supports nested keys: testId (priority), role+name, text. Other keys
 * produce empty match (safe degrade — A-5 will add and/or; remaining
 * descriptor keys not in scope here).
 *
 * NOTE on escaping: chain ops are embedded via JSON.parse('${escapeForJs(...)}').
 * escapeForJs converts " → \" so all JSON key/value double-quotes appear as \"
 * in the generated string. Assertions must use \\" (escaped backslash + quote)
 * to match them. This mirrors the established pattern from A-3 (chain-filter.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { generateLocatorJs } from '../../../src/locator.js';

describe('T77 A-4 — chain op: descendant (JS generation)', () => {
  describe('descriptor key precedence', () => {
    it('testId takes priority — emits data-testid query', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'descendant', locator: { testId: 'cta' } }],
      });
      expect(js).toContain("__cop.op === 'descendant'");
      // escapeForJs encodes " as \", so the JSON.parse blob contains \"testId\":\"cta\"
      expect(js).toContain('\\"testId\\":\\"cta\\"');
      expect(js).toContain('data-testid');
    });

    it('role + name emits role-selector + accessible-name match', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'descendant', locator: { role: 'button', name: 'Add to cart' } }],
      });
      // escapeForJs encodes " as \", so the JSON.parse blob contains \"role\":\"button\"
      expect(js).toContain('\\"role\\":\\"button\\"');
      expect(js).toContain('\\"name\\":\\"Add to cart\\"');
      expect(js).toContain('computedName');
      expect(js).toContain('aria-label');
    });

    it('role alone (no name) emits role-only descendant query', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'descendant', locator: { role: 'button' } }],
      });
      // escapeForJs encodes " as \", so the JSON.parse blob contains \"role\":\"button\"
      expect(js).toContain('\\"role\\":\\"button\\"');
      // No name → fall through; element is pushed without computedName check
    });

    it('text alone emits descendant text scan', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'descendant', locator: { text: 'Buy' } }],
      });
      // escapeForJs encodes " as \", so the JSON.parse blob contains \"text\":\"Buy\"
      expect(js).toContain('\\"text\\":\\"Buy\\"');
      expect(js).toContain('querySelectorAll');
    });
  });

  describe('safe degrade for unsupported keys', () => {
    it('empty descriptor produces empty match (no branch fires)', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'descendant', locator: {} }],
      });
      // matched = __next where __next stays empty, then break-on-empty triggers
      expect(js).toContain("__cop.op === 'descendant'");
      expect(js).toContain('matched = __next');
    });

    it('unsupported key (e.g. label) produces empty match', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'descendant', locator: { label: 'Submit' } }],
      });
      // label is a base locator key but not supported in descendant v1 — silent empty match
      expect(js).toContain("__cop.op === 'descendant'");
    });
  });

  describe('chain composition', () => {
    it('filter then descendant emits both branches in declared order', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [
          { op: 'filter', hasText: 'Product 2' },
          { op: 'descendant', locator: { role: 'button', name: 'Add' } },
        ],
      });
      expect(js).toContain("__cop.op === 'filter'");
      expect(js).toContain("__cop.op === 'descendant'");
      // Both ops in the same JSON.parse blob in declared order.
      // escapeForJs encodes " as \" so "filter" appears as \"filter\" in the blob.
      const opsBlob = js.match(/var __chainOps = JSON\.parse\('([^'\\]|\\.)+'\)/);
      expect(opsBlob).toBeTruthy();
      const blob = opsBlob![0];
      expect(blob.indexOf('\\"filter\\"')).toBeLessThan(blob.indexOf('\\"descendant\\"'));
    });

    it('descendant followed by first picks one of the descendants', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [
          { op: 'descendant', locator: { role: 'button' } },
          { op: 'first' },
        ],
      });
      expect(js).toContain("__cop.op === 'descendant'");
      expect(js).toContain("__cop.op === 'first'");
    });
  });

  describe('escaping safety', () => {
    it('testId with special chars survives escaping', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'descendant', locator: { testId: 'btn-with"quote' } }],
      });
      // testId payload sits inside JSON.parse('${escapeForJs(...)}') — must round-trip
      expect(js).toMatch(/btn-with.*quote/);
    });

    it('text with apostrophe survives escaping', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'descendant', locator: { text: "user's choice" } }],
      });
      expect(js).toContain("user\\'s");
    });
  });

  describe('preserves prior chain branches', () => {
    it('filter branch still emits (A-3 untouched)', () => {
      const js = generateLocatorJs({
        role: 'button',
        chain: [{ op: 'filter', hasText: 'X' }],
      });
      expect(js).toContain("__cop.op === 'filter'");
    });

    it('first/last/nth branches still emit (A-2 untouched)', () => {
      const js = generateLocatorJs({ role: 'button', chain: [{ op: 'first' }] });
      expect(js).toContain("__cop.op === 'first'");
    });
  });
});
