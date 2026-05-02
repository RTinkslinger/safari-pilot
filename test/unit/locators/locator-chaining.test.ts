/**
 * Phase 5A · 5A.5 — Locator chaining: `nth` and `filter` modifiers.
 *
 * Pre-fix: every locator resolves to `matched[0]` — the first match. Agents
 * needing "the third button" or "the link whose text contains 'home'" fall
 * back to safari_evaluate. Cluster 3 chaining was ✗ Gap in the parity matrix.
 *
 * Post-fix: locator descriptors accept two POST-RESOLUTION modifiers:
 *   - `nth: number` — index into matched array. Negative = from end (-1 = last).
 *     Out-of-range → standard {found:false} envelope, not a throw.
 *   - `filter: { hasText?: string }` — narrows matched to elements whose
 *     text contains the query (case-insensitive substring; matches
 *     `getByText`-equivalent semantics). Empty result → {found:false}.
 *
 * Composition: filter applies BEFORE nth — `{role:'link', filter:{hasText:'home'}, nth:0}`
 * picks the FIRST link containing 'home', not "the first link, then check
 * if it has home." Same composition order as Playwright.
 *
 * Test strategy: same recording / substring approach as 5A.3 / 5A.6 / 5A.4.
 * Companion e2e at test/e2e/5A5-locator-chaining.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  hasLocatorParams,
  extractLocatorFromParams,
  generateLocatorJs,
} from '../../../src/locator.js';

describe('5A.5 — locator chaining: nth and filter modifiers', () => {
  describe('extractLocatorFromParams', () => {
    it('reads nth into the descriptor', () => {
      const desc = extractLocatorFromParams({ role: 'button', nth: 2 });
      expect(desc).not.toBeNull();
      expect(desc!.nth, 'nth must flow into descriptor').toBe(2);
    });

    it('reads negative nth (-1 = last) into the descriptor', () => {
      const desc = extractLocatorFromParams({ role: 'link', nth: -1 });
      expect(desc!.nth).toBe(-1);
    });

    it('reads filter.hasText into the descriptor', () => {
      const desc = extractLocatorFromParams({ role: 'link', filter: { hasText: 'home' } });
      expect(desc!.filter).toEqual({ hasText: 'home' });
    });

    it('ignores non-number nth', () => {
      const desc = extractLocatorFromParams({ role: 'button', nth: 'two' as unknown as number });
      expect(desc!.nth, 'non-number nth must not flow into descriptor').toBeUndefined();
    });

    it('hasLocatorParams: nth alone is NOT enough — needs a base locator key', () => {
      // nth is a modifier, not a standalone locator. Without role/text/etc.
      // the agent has nothing to nth-into.
      expect(hasLocatorParams({ nth: 0 })).toBe(false);
    });
  });

  describe('generateLocatorJs — nth modifier', () => {
    it('emits index-into-matched logic that uses the nth value (positive index)', () => {
      const js = generateLocatorJs({ role: 'button', nth: 2 });
      // The picker must access matched by some indexed form (literal 2 OR
      // a normalized identifier like idx/nth/targetIdx). Accept any.
      expect(js, 'expected indexed access into matched').toMatch(/matched\[(?:2|idx|nth|[a-zA-Z_]\w*)\]/);
      // The literal nth value MUST appear somewhere in the emitted JS — so
      // an "ignore-nth" impl can't pass by emitting `matched[idx]` with idx=0.
      expect(js, 'literal nth value 2 must flow into the JS').toMatch(/\b2\b/);
    });

    it('emits negative-nth normalization (last element for -1)', () => {
      const js = generateLocatorJs({ role: 'link', nth: -1 });
      // Accept any semantically-equivalent emission of "last element":
      //   matched[matched.length - 1]                — inlined offset
      //   matched.length - 1                          — bare offset somewhere
      //   matched.length + nth (nth bound to -1)     — additive normalize
      //   matched.length + (-1)                       — parenthesized literal
      //   nth = -1                                    — variable assignment
      expect(
        /matched\.length\s*-\s*1|matched\.length\s*\+\s*nth|matched\.length\s*\+\s*\(?\s*-\s*1\s*\)?|nth\s*=\s*-1/.test(js),
        'expected negative-nth handling in generated JS (last-element via length-1 or length+nth or nth=-1)',
      ).toBe(true);
    });

    it('emits an explicit out-of-range guard that compares nth against matched.length', () => {
      const js = generateLocatorJs({ role: 'button', nth: 99 });
      // The guard must EXPLICITLY compare nth to matched.length. A trivially
      // wrong impl that ignores nth and returns matched[0] would still
      // contain `matched.length` (line 475 envelope) — that's not enough.
      // Looking for any of the natural idioms a generator might emit.
      expect(
        /nth\s*>=\s*matched\.length|nth\s*>\s*matched\.length\s*-\s*1|matched\.length\s*<=\s*nth|idx\s*>=\s*matched\.length/.test(js),
        'expected explicit nth-vs-length guard (e.g. `nth >= matched.length`)',
      ).toBe(true);
      expect(js, 'expected found:false branch reachable').toMatch(/found\s*:\s*false/);
    });

    it('default (no nth) — picker picks the first match (matched[0] or normalized index 0)', () => {
      const js = generateLocatorJs({ role: 'button' });
      // Backward compat: any of these forms is acceptable as long as index 0
      // is picked. A correct GREEN may normalize nth into a var first
      // (`var idx = nth < 0 ? len + nth : nth; matched[idx]`) — that's fine
      // when nth defaults to 0.
      expect(
        /matched\[0\]|var target\s*=\s*matched\[idx\]|var target\s*=\s*matched\[nth\]/.test(js),
        'default picker must select index-0 element (matched[0] / matched[idx] / matched[nth])',
      ).toBe(true);
    });
  });

  describe('generateLocatorJs — filter modifier', () => {
    it('emits filter.hasText narrowing logic before the picker', () => {
      const js = generateLocatorJs({ role: 'link', filter: { hasText: 'home' } });
      // The hasText query must flow into the JS — not hardcoded.
      expect(js, 'hasText query must flow into JS').toContain('home');
      // The filter step must reduce the matched array — looking for a
      // .filter(...) call OR a manual narrowing loop with text-containment check.
      expect(
        /matched\s*=\s*matched\.filter\(|matched\s*=\s*[a-zA-Z_]+;\s*\/\/\s*filter/.test(js),
        'expected matched-array narrowing for filter.hasText',
      ).toBe(true);
    });

    it('emits {found:false} when filter narrows matched to empty', () => {
      const js = generateLocatorJs({ role: 'link', filter: { hasText: 'nomatch' } });
      // After filtering, if matched is empty, the standard found:false envelope fires.
      expect(js).toMatch(/found\s*:\s*false/);
    });

    it('filter applies BEFORE nth (composition order matches Playwright)', () => {
      const js = generateLocatorJs({ role: 'link', filter: { hasText: 'home' }, nth: 0 });
      // Both modifiers must be present in the emitted JS. Order matters:
      // narrowing first (so nth indexes into the narrowed set), pick second.
      expect(js, 'filter step emitted').toContain('home');
      // Picker must access an indexed element of `matched` — accept the
      // literal `matched[0]` OR a normalized form via a variable (`matched[idx]`,
      // `matched[nth]`). A correct general impl that normalizes nth first
      // is not penalized.
      expect(js, 'nth picker emitted').toMatch(/matched\[(?:0|idx|nth|[a-zA-Z_]\w*)\]/);
      // Composition order: filter narrowing must appear before the picker.
      const filterIdx = js.search(/matched\s*=\s*matched\.filter\(/);
      const pickerIdx = js.search(/var\s+target\s*=\s*matched\[/);
      expect(filterIdx, 'filter narrowing must appear in JS').toBeGreaterThan(-1);
      expect(pickerIdx, 'picker must appear in JS').toBeGreaterThan(-1);
      expect(pickerIdx, 'picker must appear AFTER filter').toBeGreaterThan(filterIdx);
    });
  });

  describe('5A.5 — additional contract guards', () => {
    it('extractLocatorFromParams reads nth=0 (must not be coerced to undefined as falsy)', () => {
      const desc = extractLocatorFromParams({ role: 'button', nth: 0 });
      expect(desc!.nth, 'nth=0 must flow through — typeof check, not truthiness check').toBe(0);
    });

    it('hasLocatorParams: filter alone is NOT enough — needs a base locator key', () => {
      // Symmetric with the nth-alone test: filter is a modifier.
      expect(hasLocatorParams({ filter: { hasText: 'x' } })).toBe(false);
    });

    it('nth modifier composes with the xpath base locator (proves it wraps every resolution body)', () => {
      const js = generateLocatorJs({ xpath: '//a', nth: 2 });
      // xpath path emitted (5A.4 contract).
      expect(js, 'xpath path emitted').toMatch(/document\.evaluate\(/);
      // Picker emitted at the wrapper layer — any indexed form accepted.
      expect(js, 'picker emitted via wrapper').toMatch(/matched\[(?:2|idx|nth|[a-zA-Z_]\w*)\]/);
      // Literal nth value flows through.
      expect(js, 'literal nth value 2 must flow into the JS').toMatch(/\b2\b/);
    });

    it('filter modifier composes with the text base locator (proves it wraps every resolution body)', () => {
      const js = generateLocatorJs({ text: 'hello', filter: { hasText: 'world' } });
      // Text base resolution emitted (var allEls is its body-unique marker).
      expect(js, 'text resolution body emitted').toMatch(/var allEls\s*=/);
      // Filter narrowing layered on top.
      expect(js, 'filter hasText query flows through').toContain('world');
      expect(js, 'matched-array narrowing emitted').toMatch(/matched\s*=\s*matched\.filter\(/);
    });
  });
});
