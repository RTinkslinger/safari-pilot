import { describe, expect, test } from 'vitest';
import { generateQueryAllJs } from '../../../src/locator.js';

describe('T78 generateQueryAllJs', () => {
  test('emits IIFE that returns array under "items" key', () => {
    const js = generateQueryAllJs({ role: 'listitem' }, { limit: 100 });
    expect(js).toContain('items');
    expect(js).toContain('return JSON.stringify');
  });

  test('respects limit by slicing matched array', () => {
    const js = generateQueryAllJs({ role: 'listitem' }, { limit: 5 });
    expect(js).toContain('var __limit = 5');
    expect(js).toContain('matched.slice(0, __limit)');
  });

  test('reuses chain ops from T77 (filter/nth/etc apply pre-payload)', () => {
    const js = generateQueryAllJs(
      { role: 'listitem', chain: [{ op: 'filter', hasText: 'X' }] },
      { limit: 100 },
    );
    expect(js).toContain('__chainOps');
  });

  test('payload entry includes ref, text, tagName, attrs, boundingBox, visible', () => {
    const js = generateQueryAllJs({ role: 'button' }, { limit: 100 });
    expect(js).toContain('ref');
    expect(js).toContain('tagName');
    expect(js).toContain('attrs');
    expect(js).toContain('boundingBox');
    expect(js).toContain('visible');
  });

  test('stamps each matched element with sp-xxxxxx ref', () => {
    const js = generateQueryAllJs({ role: 'button' }, { limit: 100 });
    expect(js).toContain('data-sp-ref');
    expect(js).toContain("'sp-' + Math.random()");
  });
});
