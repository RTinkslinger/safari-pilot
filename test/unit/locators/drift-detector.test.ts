/**
 * v0.1.34 T7b drift detector.
 *
 * src/locator.ts `generateLocatorJs` (AppleScript-fallback IIFE form) and
 * extension/locator.js `window.__SP_LOCATOR__.resolveLocator` (Extension-engine
 * sentinel form) are two implementations of the same resolution algorithm.
 * They must stay in lockstep — drift between them produces an Extension-only
 * vs AppleScript-only behavioral divergence that is hell to debug at the
 * benchmark gate.
 *
 * The "real" drift detector would run both implementations against a jsdom
 * DOM and compare envelopes. We don't have jsdom in the unit-test deps, and
 * pulling it in for one test is heavyweight. This file does the next best
 * thing: structural assertions that both files declare the same locator
 * strategies, the same chain ops, the same role-selectors map keys, and the
 * same strictness-satisfied rules. A branch added to one file but not the
 * other trips this test.
 *
 * If you intentionally change behavior in ONE file, update BOTH then update
 * this test. Don't disable it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_SELECTORS, buildLocatorSentinel } from '../../../src/locator.js';

const TS_LOCATOR = readFileSync(
  join(__dirname, '../../../src/locator.ts'),
  'utf8',
);
const EXT_LOCATOR = readFileSync(
  join(__dirname, '../../../extension/locator.js'),
  'utf8',
);

describe('T7b drift detector — src/locator.ts ↔ extension/locator.js', () => {
  describe('ROLE_SELECTORS map parity', () => {
    it('every src/locator.ts ROLE_SELECTORS key exists in extension/locator.js', () => {
      for (const role of Object.keys(ROLE_SELECTORS)) {
        // Match the literal key followed by `:` (declaration shape in extension file).
        // CSS.escape isn't needed — all role keys are ASCII identifiers.
        const pattern = new RegExp(`\\b${role}:`);
        expect(EXT_LOCATOR, `role '${role}' missing from extension/locator.js ROLE_SELECTORS`).toMatch(pattern);
      }
    });

    it('every CSS selector value matches between the two files', () => {
      for (const [role, selector] of Object.entries(ROLE_SELECTORS)) {
        // The extension file declares `<role>: '<selector>'`. Grab the exact
        // value and assert equality.
        const m = EXT_LOCATOR.match(new RegExp(`${role}:\\s*\\n?\\s*'([^']+)'`));
        expect(m, `role '${role}' selector pattern not found in extension/locator.js`).toBeTruthy();
        expect(m![1], `role '${role}' selector value mismatch`).toBe(selector);
      }
    });
  });

  describe('locator-strategy parity (6 base strategies)', () => {
    const strategies = ['xpath', 'testId', 'role', 'label', 'placeholder', 'text'];
    it('extension/locator.js declares every strategy generateLocatorJs handles', () => {
      // src/locator.ts has dedicated builders per strategy:
      //   buildXpathResolutionJs, buildTestIdResolutionJs, etc.
      // extension/locator.js has dedicated functions:
      //   resolveByXpath, resolveByTestId, etc.
      for (const s of strategies) {
        const cap = s.charAt(0).toUpperCase() + s.slice(1);
        const tsName = `build${cap}ResolutionJs`;
        const extName = `resolveBy${cap}`;
        expect(TS_LOCATOR, `src/locator.ts missing ${tsName}`).toContain(tsName);
        expect(EXT_LOCATOR, `extension/locator.js missing ${extName}`).toContain(extName);
      }
    });
  });

  describe('chain-op parity (T77)', () => {
    const ops = ['first', 'last', 'nth', 'filter', 'descendant', 'or', 'and'];
    it('every chain op handled in both files', () => {
      for (const op of ops) {
        // src/locator.ts uses string comparisons like `__cop.op === 'first'`
        const tsPattern = `'${op}'`;
        expect(TS_LOCATOR, `src/locator.ts chain-op '${op}' not referenced`).toContain(tsPattern);
        expect(EXT_LOCATOR, `extension/locator.js chain-op '${op}' not referenced`).toContain(tsPattern);
      }
    });
  });

  describe('strictnessSatisfied rules (T80)', () => {
    it('both files compute strictness from testId, xpath, nth, and chain-terminator (first/last/nth)', () => {
      // src/locator.ts at ~lines 750-770:
      //   matched.length === 1
      //   || locatorDesc.testId || locatorDesc.xpath
      //   || typeof locatorDesc.nth === 'number'
      //   || lastOp.op in {first, last, nth}
      expect(TS_LOCATOR).toContain('__strictnessSatisfied');
      expect(EXT_LOCATOR).toContain('strictnessSatisfied');
      // testId/xpath shape promotion
      expect(TS_LOCATOR).toMatch(/testId.*xpath/s);
      expect(EXT_LOCATOR).toMatch(/testId.*xpath/s);
      // chain terminator check
      expect(TS_LOCATOR).toMatch(/'first'.*'last'.*'nth'/s);
      expect(EXT_LOCATOR).toMatch(/'first'.*'last'.*'nth'/s);
    });
  });

  describe('result envelope parity', () => {
    it('both files include the full envelope fields', () => {
      // The TS IIFE emits a JSON.stringify({...}); the extension function
      // returns an object literal. Both must include these keys.
      for (const field of ['found', 'selector', 'element', 'matchCount', 'strictnessSatisfied', 'hint']) {
        expect(TS_LOCATOR, `src/locator.ts envelope missing '${field}'`).toContain(field);
        expect(EXT_LOCATOR, `extension/locator.js envelope missing '${field}'`).toContain(field);
      }
    });

    it('both files stamp data-sp-ref + sp-<hash> ref id', () => {
      expect(TS_LOCATOR).toContain('data-sp-ref');
      expect(EXT_LOCATOR).toContain('data-sp-ref');
      expect(TS_LOCATOR).toContain("'sp-' + Math.random()");
      expect(EXT_LOCATOR).toContain("'sp-' + Math.random()");
    });
  });

  describe('sentinel wiring', () => {
    it('content-main.js routes __SP_RESOLVE_LOCATOR__ to resolveLocator', () => {
      const contentMain = readFileSync(
        join(__dirname, '../../../extension/content-main.js'),
        'utf8',
      );
      expect(contentMain).toContain('__SP_RESOLVE_LOCATOR__:');
      expect(contentMain).toContain('L.resolveLocator');
    });

    it('extension/locator.js exposes resolveLocator on window.__SP_LOCATOR__', () => {
      expect(EXT_LOCATOR).toMatch(/window\.__SP_LOCATOR__\s*=\s*\{[\s\S]*resolveLocator/);
    });

    it('buildLocatorSentinel emits the expected prefix + JSON shape', () => {
      const out = buildLocatorSentinel({ role: 'button', name: 'Submit' });
      expect(out.startsWith('__SP_RESOLVE_LOCATOR__:')).toBe(true);
      const payload = JSON.parse(out.slice('__SP_RESOLVE_LOCATOR__:'.length));
      expect(payload.locator.role).toBe('button');
      expect(payload.locator.name).toBe('Submit');
      expect(payload.options).toEqual({});
    });
  });
});
