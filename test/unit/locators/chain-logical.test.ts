/**
 * T77 A-5: and/or chain ops (logical combinators).
 *
 * Pre-fix: chain ops support positional/filter/descendant.
 * Post-fix: `or` unions current matched with secondary locator's set
 * (deduped); `and` intersects. v1 supports nested keys: testId, role
 * (with optional name).
 */
import { describe, expect, it } from 'vitest';
import { generateLocatorJs } from '../../../src/locator.js';

describe('T77 A-5 — chain ops: and / or (JS generation)', () => {
  describe('or op', () => {
    it('emits union with secondary testId locator', () => {
      const js = generateLocatorJs({
        testId: 'cancel',
        chain: [{ op: 'or', locator: { testId: 'cancel-link' } }],
      });
      expect(js).toContain("__cop.op === 'or'");
      expect(js).toContain('__orMatches');
      expect(js).toContain('\\"locator\\":{\\"testId\\":\\"cancel-link\\"}');
    });

    it('emits union with secondary role locator', () => {
      const js = generateLocatorJs({
        role: 'button',
        chain: [{ op: 'or', locator: { role: 'link', name: 'Cancel' } }],
      });
      expect(js).toContain("__cop.op === 'or'");
      expect(js).toContain('\\"role\\":\\"link\\"');
      expect(js).toContain('\\"name\\":\\"Cancel\\"');
    });

    it('dedupes union via indexOf check', () => {
      const js = generateLocatorJs({
        role: 'button',
        chain: [{ op: 'or', locator: { role: 'link' } }],
      });
      expect(js).toContain('__orSet.indexOf');
      expect(js).toContain('__orSet.push');
    });
  });

  describe('and op', () => {
    it('emits intersection with secondary testId', () => {
      const js = generateLocatorJs({
        role: 'button',
        chain: [{ op: 'and', locator: { testId: 'important' } }],
      });
      expect(js).toContain("__cop.op === 'and'");
      expect(js).toContain('__andMatches');
      expect(js).toContain('\\"testId\\":\\"important\\"');
    });

    it('emits intersection with secondary role', () => {
      const js = generateLocatorJs({
        role: 'button',
        chain: [{ op: 'and', locator: { role: 'menuitem' } }],
      });
      expect(js).toContain("__cop.op === 'and'");
      expect(js).toContain('\\"role\\":\\"menuitem\\"');
    });

    it('emits filter via indexOf intersection', () => {
      const js = generateLocatorJs({
        role: 'button',
        chain: [{ op: 'and', locator: { testId: 'x' } }],
      });
      expect(js).toContain('matched.filter');
      expect(js).toContain('__andMatches.indexOf');
    });

    it('emits intersection with role+name filter (parity with or branch)', () => {
      const js = generateLocatorJs({
        role: 'button',
        chain: [{ op: 'and', locator: { role: 'menuitem', name: 'Save' } }],
      });
      expect(js).toContain('__andCands');
      expect(js).toContain('\\"role\\":\\"menuitem\\"');
      expect(js).toContain('\\"name\\":\\"Save\\"');
      expect(js).toContain('computedName');
    });
  });

  describe('chain composition', () => {
    it('or then and chains in declared order', () => {
      const js = generateLocatorJs({
        role: 'button',
        chain: [
          { op: 'or', locator: { role: 'link' } },
          { op: 'and', locator: { testId: 'visible' } },
        ],
      });
      const opsBlob = js.match(/var __chainOps = JSON\.parse\('([^']+)'\)/);
      expect(opsBlob).toBeTruthy();
      const decoded = opsBlob![1]
        .replace(/\\\\/g, '\\')
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"');
      expect(decoded.indexOf('"or"')).toBeLessThan(decoded.indexOf('"and"'));
    });
  });

  describe('preserves prior chain branches', () => {
    it('first/last/nth still emit (A-2 untouched)', () => {
      const js = generateLocatorJs({ role: 'button', chain: [{ op: 'first' }] });
      expect(js).toContain("__cop.op === 'first'");
    });

    it('filter still emits (A-3 untouched)', () => {
      const js = generateLocatorJs({ role: 'button', chain: [{ op: 'filter', hasText: 'X' }] });
      expect(js).toContain("__cop.op === 'filter'");
    });

    it('descendant still emits (A-4 untouched)', () => {
      const js = generateLocatorJs({
        role: 'button',
        chain: [{ op: 'descendant', locator: { role: 'icon' } }],
      });
      expect(js).toContain("__cop.op === 'descendant'");
    });
  });
});
