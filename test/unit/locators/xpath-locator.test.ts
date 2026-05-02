/**
 * Phase 5A · 5A.4 — XPath as a first-class locator across every interaction
 * and extraction tool.
 *
 * Pre-fix: agents needing XPath fall back to `safari_evaluate` and lose
 * ref-style stamping, frame-aware routing, and consistent error shapes.
 * The parity matrix marks Cluster 3 XPath as ◆ Partial for this reason.
 *
 * Post-fix: the `xpath` param sits alongside `role` / `text` / `label` /
 * `testId` / `placeholder` on every interaction + extraction tool.
 *   - hasLocatorParams returns true when xpath is the only locator key
 *   - extractLocatorFromParams reads xpath into LocatorDescriptor.xpath
 *   - generateLocatorJs uses document.evaluate(xpath, document, null,
 *     XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue, stamps
 *     the matched element with data-sp-ref (same envelope as every other
 *     locator), and returns the standard {found, selector, element} shape
 *
 * Test strategy: same recording / substring approach as 5A.3 / 5A.6.
 * Companion e2e at test/e2e/5A4-xpath-locator.test.ts drives real Safari
 * against fixture pages and verifies element stamping + interaction.
 */
import { describe, it, expect } from 'vitest';
import {
  hasLocatorParams,
  extractLocatorFromParams,
  generateLocatorJs,
} from '../../../src/locator.js';

describe('5A.4 — xpath is a first-class locator key', () => {
  describe('hasLocatorParams', () => {
    it('returns true when xpath is the only locator key', () => {
      expect(hasLocatorParams({ xpath: '//button' })).toBe(true);
    });
    it('still returns false when no locator keys are present', () => {
      expect(hasLocatorParams({})).toBe(false);
      expect(hasLocatorParams({ tabUrl: 'https://x' })).toBe(false);
    });
    it('returns true when xpath is mixed with other locator keys', () => {
      expect(hasLocatorParams({ xpath: '//a', role: 'link' })).toBe(true);
    });
  });

  describe('extractLocatorFromParams', () => {
    it('reads xpath into the descriptor', () => {
      const desc = extractLocatorFromParams({ xpath: '//div[@id="x"]' });
      expect(desc).not.toBeNull();
      expect(desc!.xpath, 'xpath must be carried into the descriptor').toBe('//div[@id="x"]');
    });
    it('ignores non-string xpath values', () => {
      const desc = extractLocatorFromParams({ xpath: 42 as unknown as string, role: 'button' });
      // Should still return a descriptor (role is set), but xpath is not propagated.
      expect(desc).not.toBeNull();
      expect(desc!.xpath, 'non-string xpath must not flow into descriptor').toBeUndefined();
    });
  });

  describe('generateLocatorJs', () => {
    it('produces JS that resolves via document.evaluate when xpath is set', () => {
      const js = generateLocatorJs({ xpath: '//button[@id="submit"]' });
      // The resolution must use the W3C DOM XPath API. A trivially wrong impl
      // that builds a CSS selector string would not satisfy this.
      expect(js, 'expected document.evaluate call').toMatch(/document\.evaluate\(/);
      // FIRST_ORDERED_NODE_TYPE is the correct XPathResult for "single match
      // in document order" — what the locator contract promises.
      expect(js, 'expected XPathResult.FIRST_ORDERED_NODE_TYPE').toMatch(/FIRST_ORDERED_NODE_TYPE/);
      // The xpath itself must flow into the call, not a hardcoded value.
      expect(js, 'xpath string must flow into the JS').toContain('//button[@id=\\"submit\\"]');
    });

    it('preserves the standard data-sp-ref stamping envelope used by every other locator', () => {
      const js = generateLocatorJs({ xpath: '//a' });
      // Stamping is the contract that downstream tools rely on: the resolved
      // element gets data-sp-ref, and the response carries selector +
      // element fields. Identical envelope to role/text/testId locators.
      expect(js, 'expected data-sp-ref stamping').toMatch(/setAttribute\(['"]data-sp-ref['"]/);
      expect(js, 'expected selector field in response').toMatch(/selector\s*:/);
      expect(js, 'expected found field in response').toMatch(/found\s*:/);
    });

    // ── Priority tests ─────────────────────────────────────────────────
    // xpath is the most explicit locator (the agent literally points at the
    // node). It must sit at the TOP of the priority chain — above the
    // existing testId > role+name > label > placeholder > text order.
    // Each test pairs xpath with another key and asserts the xpath path
    // is emitted AND none of the discriminating markers from the other
    // resolution paths appear. Markers chosen unique per src/locator.ts.

    it('xpath wins over testId (highest pre-5A.4 priority)', () => {
      const js = generateLocatorJs({ xpath: '//div', testId: 'submit-btn' });
      expect(js, 'xpath path emitted').toMatch(/document\.evaluate\(/);
      // testId resolution emits a `[data-testid="..."]` lookup. If absent, xpath wins.
      expect(
        /\[data-testid=/.test(js),
        'xpath must win over testId — testId resolution body must not be emitted',
      ).toBe(false);
    });

    it('xpath wins over role+name', () => {
      const js = generateLocatorJs({ xpath: '//a', role: 'link', name: 'Home' });
      expect(js, 'xpath path emitted').toMatch(/document\.evaluate\(/);
      // Role resolution body declares `var roleTarget = ...` — body-unique.
      // (getAccessibleName/matchText are wrapper helpers shared across paths.)
      expect(
        /var roleTarget\s*=/.test(js),
        'xpath must win over role+name — role resolution body (var roleTarget) must not be emitted',
      ).toBe(false);
    });

    it('xpath wins over label', () => {
      const js = generateLocatorJs({ xpath: '//input', label: 'Email' });
      expect(js, 'xpath path emitted').toMatch(/document\.evaluate\(/);
      // Label resolution body declares `var labelable = ...` and queries
      // `input,select,textarea,button,meter,output,progress` — body-unique.
      expect(
        /var labelable\s*=/.test(js),
        'xpath must win over label — label resolution body (var labelable) must not be emitted',
      ).toBe(false);
    });

    it('xpath wins over placeholder', () => {
      const js = generateLocatorJs({ xpath: '//input', placeholder: 'Search' });
      expect(js, 'xpath path emitted').toMatch(/document\.evaluate\(/);
      // Placeholder resolution emits a `[placeholder` selector lookup.
      expect(
        /\[placeholder/.test(js),
        'xpath must win over placeholder — placeholder resolution body must not be emitted',
      ).toBe(false);
    });

    it('xpath wins over text (least-priority pre-5A.4 key)', () => {
      const js = generateLocatorJs({ xpath: '//button', text: 'click me' });
      expect(js, 'xpath path emitted').toMatch(/document\.evaluate\(/);
      // Text resolution body declares `var allEls = ...querySelectorAll('*')`
      // and skipTags map — body-unique to text.
      expect(
        /var allEls\s*=/.test(js),
        'xpath must win over text — text resolution body (var allEls) must not be emitted',
      ).toBe(false);
    });

    it('returns the standard success envelope: found, selector, element fields all present', () => {
      const js = generateLocatorJs({ xpath: '//button' });
      // Full success envelope per LocatorResult: { found, selector, element: {tagName, ...} }.
      expect(js, 'expected found field').toMatch(/found\s*:/);
      expect(js, 'expected selector field').toMatch(/selector\s*:/);
      expect(js, 'expected element field carrying tagName/id/textContent').toMatch(/element\s*:/);
      expect(js, 'expected tagName in element envelope').toMatch(/tagName/);
    });

    it('returns the standard "no locator" failure envelope when no key (incl. xpath) is present', () => {
      const js = generateLocatorJs({});
      // The empty-locator failure is unchanged by 5A.4. xpath being added to
      // the recognized keys does not weaken this guard.
      expect(js).toMatch(/found:\s*false/);
      expect(js).toMatch(/No locator key provided/);
    });
  });
});
