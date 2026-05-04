/**
 * T77 A-3: filter chain op (hasText, hasNotText, has, hasNot).
 *
 * Pre-fix: chain ops only support first/last/nth (positional).
 * Post-fix: filter narrows matched in-place via 4 predicates.
 *
 * Nested has/hasNot supports v1 keys: role, testId, text. Other keys
 * fall through (no-op against this branch). A-4 (descendant) is a
 * separate op and a separate task.
 */
import { describe, expect, it } from 'vitest';
import { generateLocatorJs } from '../../../src/locator.js';

describe('T77 A-3 — chain op: filter (JS generation)', () => {
  describe('hasText', () => {
    it('emits substring match against element innerText', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'filter', hasText: 'Product 2' }],
      });
      expect(js).toContain("__cop.op === 'filter'");
      expect(js).toContain('Product 2');
      expect(js).toContain('toLowerCase');
    });

    it('survives apostrophe escaping in hasText', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'filter', hasText: "user's choice" }],
      });
      // The hasText payload sits inside JSON.parse('${escapeForJs(JSON.stringify(...))}'),
      // so the apostrophe must be escaped within the outer single-quoted string.
      expect(js).toContain("user\\'s");
    });

    it('handles unicode in hasText', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'filter', hasText: 'café' }],
      });
      expect(js).toContain('café');
    });
  });

  describe('hasNotText', () => {
    it('emits exclusion predicate', () => {
      const js = generateLocatorJs({
        role: 'row',
        chain: [{ op: 'filter', hasNotText: 'sponsored' }],
      });
      expect(js).toContain('hasNotText');
      expect(js).toContain('sponsored');
    });
  });

  describe('has (nested locator)', () => {
    it('emits role-based descendant probe', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'filter', has: { role: 'button' } }],
      });
      expect(js).toContain('__cop.has');
      // escapeForJs encodes " as \", so the JSON.parse blob contains \"has\":{\"role\":\"button\"}
      expect(js).toContain('\\"has\\":{\\"role\\":\\"button\\"}');
      expect(js).toContain('querySelectorAll');
    });

    it('emits text-based descendant probe', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'filter', has: { text: 'Buy' } }],
      });
      // escapeForJs encodes " as \", so the JSON.parse blob contains \"has\":{\"text\":\"Buy\"}
      expect(js).toContain('\\"has\\":{\\"text\\":\\"Buy\\"}');
    });

    it('emits testId-based descendant probe', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'filter', has: { testId: 'cta' } }],
      });
      // escapeForJs encodes " as \", so the JSON.parse blob contains \"has\":{\"testId\":\"cta\"}
      expect(js).toContain('\\"has\\":{\\"testId\\":\\"cta\\"}');
      expect(js).toContain('data-testid');
    });
  });

  describe('hasNot (nested locator)', () => {
    it('emits exclusion based on role', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'filter', hasNot: { role: 'banner' } }],
      });
      // escapeForJs encodes " as \", so the JSON.parse blob contains \"hasNot\":{\"role\":\"banner\"}
      expect(js).toContain('\\"hasNot\\":{\\"role\\":\\"banner\\"}');
      expect(js).toContain('hasNotMatch');
    });
  });

  describe('combined predicates', () => {
    it('hasText + has compose in the same filter op', () => {
      const js = generateLocatorJs({
        role: 'listitem',
        chain: [{ op: 'filter', hasText: 'Product', has: { role: 'button' } }],
      });
      expect(js).toContain('Product');
      // escapeForJs encodes " as \", so the JSON.parse blob contains \"has\":{\"role\":\"button\"}
      expect(js).toContain('\\"has\\":{\\"role\\":\\"button\\"}');
    });
  });

  describe('preserves prior chain branches', () => {
    it('first/last/nth still emit (A-2 untouched)', () => {
      const js = generateLocatorJs({ role: 'button', chain: [{ op: 'first' }] });
      expect(js).toContain("__cop.op === 'first'");
    });
  });
});
