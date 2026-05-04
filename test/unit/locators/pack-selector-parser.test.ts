/**
 * T79 C-6: pack:<name>=arg selector parser.
 *
 * Lets callers reference a registered selectorPack by name in any locator-using
 * tool's `selector` param. The parser is pure (no DOM, no engine), gives the
 * extraction tools a stable contract for routing pack: prefixed selectors
 * through the C-7 resolution path.
 */
import { describe, expect, test } from 'vitest';
import { parsePackSelector } from '../../../src/locator.js';

describe('T79 pack: selector parsing', () => {
  test('parses pack:name', () => {
    expect(parsePackSelector('pack:myEngine')).toEqual({ name: 'myEngine', arg: '' });
  });

  test('parses pack:name=arg', () => {
    expect(parsePackSelector('pack:myEngine=foo bar')).toEqual({ name: 'myEngine', arg: 'foo bar' });
  });

  test('returns null for non-pack selector', () => {
    expect(parsePackSelector('.css-class')).toBeNull();
    expect(parsePackSelector('#id')).toBeNull();
  });
});
