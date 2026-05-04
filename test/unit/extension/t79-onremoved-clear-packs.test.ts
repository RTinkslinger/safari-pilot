/**
 * T79 C-8: tabs.onRemoved clears tab-scoped selectorPack storage.
 *
 * Storage keys are written under prefix `sp_pack_<tabId>_<name>` (registered
 * by background script — surface contract enforced via source-grep below per
 * established pattern, see T60/T67 extension-source tests).
 *
 * The listener is additive — there's already a tabs.onRemoved listener for
 * the tab-cache that runs first; adding a second listener is fine because
 * MV3 supports multiple listeners and they fire independently.
 */
import { describe, expect, test, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('T79 C-8 — tabs.onRemoved clears tab-scoped pack storage', () => {
  let bg: string;

  beforeAll(async () => {
    bg = await readFile('extension/background.js', 'utf8');
  });

  test('background.js declares a tabs.onRemoved listener', () => {
    expect(bg).toMatch(/browser\.tabs\.onRemoved\.addListener/);
  });

  test('background.js references the sp_pack_ key prefix', () => {
    expect(bg).toMatch(/sp_pack_/);
  });

  test('background.js calls storage.local.remove with sp_pack_ keys (or get-then-remove pattern)', () => {
    // Either: explicit storage.local.remove call referencing sp_pack_ keys, OR
    // a get-all + filter-by-prefix pattern that subsequently removes them.
    expect(bg).toMatch(/storage\.local\.remove[\s\S]*sp_pack_|storage\.local\.get[\s\S]*?sp_pack_[\s\S]*?storage\.local\.remove/);
  });
});
