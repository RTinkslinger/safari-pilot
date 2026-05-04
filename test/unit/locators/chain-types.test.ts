/**
 * T77 A-1: ChainOp type definition + chain field on LocatorDescriptor +
 * extractLocatorFromParams chain extraction.
 *
 * Pre-fix: no chain support — multi-step locator composition impossible.
 * Post-fix: chain[] of {filter, nth, first, last, and, or, descendant} ops
 * round-trips through extractLocatorFromParams with malformed-entry filtering.
 *
 * Tests A-2 through A-5 (in this file or sibling files) cover the chain
 * RESOLUTION JS in generateLocatorJs. This file covers ONLY the type
 * definitions and the param extractor.
 */
import { describe, expect, it } from 'vitest';
import { extractLocatorFromParams } from '../../../src/locator.js';

describe('T77 chain types', () => {
  describe('ChainOp roundtrip through extractLocatorFromParams', () => {
    it('extracts filter op with hasText through params', () => {
      const desc = extractLocatorFromParams({
        role: 'button',
        chain: [{ op: 'filter', hasText: 'Submit' }],
      });
      expect(desc?.chain).toEqual([{ op: 'filter', hasText: 'Submit' }]);
    });

    it('extracts positional ops (nth/first/last) including zero-n edge case', () => {
      const desc = extractLocatorFromParams({
        role: 'button',
        chain: [{ op: 'nth', n: 0 }, { op: 'first' }, { op: 'last' }],
      });
      expect(desc?.chain).toHaveLength(3);
      expect(desc?.chain?.[0]).toEqual({ op: 'nth', n: 0 });
      expect(desc?.chain?.[1]).toEqual({ op: 'first' });
      expect(desc?.chain?.[2]).toEqual({ op: 'last' });
    });

    it('extracts descendant op with nested locator descriptor', () => {
      const desc = extractLocatorFromParams({
        role: 'listitem',
        chain: [{ op: 'descendant', locator: { role: 'button', name: 'Add' } }],
      });
      expect(desc?.chain?.[0]).toEqual({ op: 'descendant', locator: { role: 'button', name: 'Add' } });
    });

    it('extracts and/or ops with nested locator descriptors', () => {
      const desc = extractLocatorFromParams({
        role: 'button',
        chain: [
          { op: 'and', locator: { testId: 'important' } },
          { op: 'or', locator: { role: 'link', name: 'Cancel' } },
        ],
      });
      expect(desc?.chain).toHaveLength(2);
      expect(desc?.chain?.[0]).toEqual({ op: 'and', locator: { testId: 'important' } });
      expect(desc?.chain?.[1]).toEqual({ op: 'or', locator: { role: 'link', name: 'Cancel' } });
    });
  });

  describe('extractLocatorFromParams chain extraction', () => {
    it('pulls chain array from params', () => {
      const desc = extractLocatorFromParams({
        role: 'listitem',
        chain: [
          { op: 'filter', hasText: 'Product 2' },
          { op: 'descendant', locator: { role: 'button', name: 'Add' } },
        ],
      });
      expect(desc?.chain).toHaveLength(2);
      expect(desc?.chain?.[0]).toEqual({ op: 'filter', hasText: 'Product 2' });
    });

    it('returns undefined chain when chain param is absent', () => {
      const desc = extractLocatorFromParams({ role: 'button' });
      expect(desc?.chain).toBeUndefined();
    });

    it('ignores malformed chain entries (keeps valid ones)', () => {
      const desc = extractLocatorFromParams({
        role: 'button',
        chain: [{ op: 'filter', hasText: 'X' }, 'not-an-op', null, { bogus: true }],
      });
      expect(desc?.chain).toHaveLength(1);
      expect(desc?.chain?.[0]).toEqual({ op: 'filter', hasText: 'X' });
    });

    it('returns undefined chain when all entries are invalid (chain.length=0 guard)', () => {
      const desc = extractLocatorFromParams({
        role: 'button',
        chain: [null, { bogus: true }, 42, 'string'],
      });
      expect(desc?.chain).toBeUndefined();
    });

    it('returns null when chain is the only field (chain is a modifier, not a base locator key)', () => {
      const desc = extractLocatorFromParams({
        chain: [{ op: 'first' }],
      });
      expect(desc).toBeNull();
    });
  });

  describe('filter ChainOp variant coverage', () => {
    it('extracts filter op with hasNotText', () => {
      const desc = extractLocatorFromParams({
        role: 'row',
        chain: [{ op: 'filter', hasNotText: 'Draft' }],
      });
      expect(desc?.chain?.[0]).toEqual({ op: 'filter', hasNotText: 'Draft' });
    });

    it('extracts filter op with nested has/hasNot locator descriptors', () => {
      const desc = extractLocatorFromParams({
        role: 'listitem',
        chain: [
          { op: 'filter', has: { role: 'checkbox' }, hasNot: { role: 'banner' } },
        ],
      });
      expect(desc?.chain?.[0]).toEqual({
        op: 'filter',
        has: { role: 'checkbox' },
        hasNot: { role: 'banner' },
      });
    });
  });
});
