/**
 * T78 B-2: `buildRefSelector` accepts the new `sp-xxxxxx` ref scheme returned by
 * `safari_query_all` AND passes through fully-qualified `[data-sp-ref="..."]`
 * selectors unchanged. Legacy `eN` scheme remains unchanged.
 *
 * The function was already permissive (any string flowed into the data-sp-ref
 * attribute selector). The new requirement is the passthrough case so callers
 * can hand in either the bare ref OR the resolved selector and get a stable
 * single-form output downstream.
 */
import { describe, expect, test } from 'vitest';
import { buildRefSelector } from '../../../src/aria.js';

describe('T78 buildRefSelector accepts sp- refs', () => {
  test('legacy eN ref resolves to existing scheme', () => {
    expect(buildRefSelector('e5')).toBe('[data-sp-ref="e5"]');
  });

  test('sp-xxxxxx ref resolves to data-sp-ref selector', () => {
    expect(buildRefSelector('sp-abc123')).toBe('[data-sp-ref="sp-abc123"]');
  });

  test('full data-sp-ref selector passes through unchanged', () => {
    expect(buildRefSelector('[data-sp-ref="sp-abc123"]')).toBe('[data-sp-ref="sp-abc123"]');
  });
});
