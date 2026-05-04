/**
 * T77 A-2: chain ops nth/first/last — JS-string generation in generateLocatorJs.
 *
 * Pre-fix: generateLocatorJs emits no chain-op loop; `locator.chain` is ignored
 * during resolution. The flat `nth` param and `filter.hasText` work but nothing
 * composes on top.
 *
 * Post-fix: the result section of generateLocatorJs emits:
 *   1. The flat nth picker (backward-compat, applies BEFORE chain).
 *   2. A T77 chain-op loop (only when locator.chain.length > 0) that iterates
 *      __chainOps (JSON.parse'd from the serialized descriptor) and applies
 *      first/last/nth positional picks in declared order.
 *   3. An early-break on matched.length === 0.
 *   4. The single-element result envelope (matchCount, selector, element).
 *
 * This file covers ONLY JS-string generation — no in-browser execution.
 * Runtime behaviour is covered in test/e2e (T77).
 */
import { describe, expect, it } from 'vitest';
import { generateLocatorJs } from '../../../src/locator.js';

describe('T77 A-2 — chain ops: nth/first/last (JS generation)', () => {
  describe('first op', () => {
    it('emits index-0 picker', () => {
      const js = generateLocatorJs({ role: 'button', chain: [{ op: 'first' }] });
      expect(js).toContain('matched[0]');
      expect(js).toContain("__cop.op === 'first'");
      expect(js).toContain('__chainOps');
    });
  });

  describe('last op', () => {
    it('emits last-element picker', () => {
      const js = generateLocatorJs({ role: 'button', chain: [{ op: 'last' }] });
      expect(js).toContain('matched[matched.length - 1]');
      expect(js).toContain("__cop.op === 'last'");
      expect(js).toContain('__chainOps');
    });
  });

  describe('nth op', () => {
    it('emits picker with the n value', () => {
      const js = generateLocatorJs({ role: 'button', chain: [{ op: 'nth', n: 3 }] });
      expect(js).toContain('__chainOps');
      // escapeForJs encodes " as \", so the JSON.parse blob contains \"n\":3
      expect(js).toContain('\\"n\\":3');
      expect(js).toContain("__cop.op === 'nth'");
    });

    it('handles negative n (from-end indexing)', () => {
      const js = generateLocatorJs({ role: 'button', chain: [{ op: 'nth', n: -2 }] });
      // escapeForJs encodes " as \", so the JSON.parse blob contains \"n\":-2
      expect(js).toContain('\\"n\\":-2');
      // The runtime resolves negative via matched.length + n
      expect(js).toContain('matched.length + __chainIdx');
    });

    it('emits zero-n picker (n: 0 is a valid distinct case from missing nth)', () => {
      const js = generateLocatorJs({ role: 'button', chain: [{ op: 'nth', n: 0 }] });
      // escapeForJs encodes " as \", so the JSON.parse blob contains \"n\":0
      expect(js).toContain('\\"n\\":0');
    });

    it('emits __resolvedIdx bounds check to produce empty array on out-of-range', () => {
      const js = generateLocatorJs({ role: 'button', chain: [{ op: 'nth', n: 99 }] });
      expect(js).toContain('__resolvedIdx');
      expect(js).toContain('__resolvedIdx >= 0 && __resolvedIdx < matched.length');
    });
  });

  describe('chain composition', () => {
    it('chain ops emit AFTER existing flat nth/filter scaffolding', () => {
      const js = generateLocatorJs({
        role: 'button',
        filter: { hasText: 'Submit' },
        nth: 0,
        chain: [{ op: 'last' }],
      });
      // Flat scaffolding still emits (backward compat)
      expect(js).toContain('hasTextQuery');
      // Chain block also emits
      expect(js).toContain('__chainOps');
    });

    it('multiple chain ops emit in declared order in the same JSON.parse blob', () => {
      const js = generateLocatorJs({
        role: 'button',
        chain: [{ op: 'first' }, { op: 'nth', n: 0 }],
      });
      // Both ops serialized; escapeForJs turns " into \" inside the JSON.parse blob
      const opsBlob = js.match(/var __chainOps = JSON\.parse\('([^']+)'\)/);
      expect(opsBlob).toBeTruthy();
      // Decode: unescape \\ and \" back to their raw characters
      const decoded = opsBlob![1].replace(/\\\\/g, '\\').replace(/\\"/g, '"').replace(/\\'/g, "'");
      const parsed = JSON.parse(decoded) as Array<{ op: string }>;
      expect(parsed[0].op).toBe('first');
      expect(parsed[1].op).toBe('nth');
    });

    it('chain ops break early when matched is empty', () => {
      const js = generateLocatorJs({ role: 'button', chain: [{ op: 'first' }] });
      expect(js).toContain('if (matched.length === 0) break;');
    });

    it('chain-op loop iterates with __ci counter', () => {
      const js = generateLocatorJs({ role: 'button', chain: [{ op: 'last' }] });
      expect(js).toContain('for (var __ci = 0; __ci < __chainOps.length; __ci++)');
    });
  });

  describe('backward compatibility', () => {
    it('no-chain emits the legacy result section without __chainOps', () => {
      const js = generateLocatorJs({ role: 'button' });
      expect(js).not.toContain('__chainOps');
      expect(js).not.toContain('__chainIdx');
    });

    it('flat nth alone (no chain) still emits the legacy nth picker', () => {
      const js = generateLocatorJs({ role: 'button', nth: 2 });
      expect(js).toContain('var nth = 2');
      expect(js).not.toContain('__chainOps');
    });

    it('flat filter.hasText still emits independent of chain', () => {
      const js = generateLocatorJs({ role: 'button', filter: { hasText: 'Submit' } });
      expect(js).toContain('hasTextQuery');
      expect(js).not.toContain('__chainOps');
    });

    it('result envelope still has matchCount field for actions to inspect (T80 prerequisite)', () => {
      const js = generateLocatorJs({ role: 'button' });
      expect(js).toContain('matchCount');
    });
  });

  describe('zero-result handling', () => {
    it('empty matched after chain emits no-match envelope with hint', () => {
      const js = generateLocatorJs({ role: 'button', chain: [{ op: 'last' }] });
      expect(js).toContain('No elements matched after chain ops');
    });
  });
});
