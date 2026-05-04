/**
 * T79 Cluster D: pack persistence — extension-side wiring.
 *
 * Cluster C shipped registration into window.__sp_pack only (page-scope, lost
 * on navigation). The plan promised tab-scoped persistent storage; Cluster D
 * delivers it. Three pieces wire on the extension side:
 *
 *   D-2: __SP_PACK_REGISTER__ / __SP_PACK_UNREGISTER__ sentinel handlers in
 *        background.js. Register writes sp_pack_<tabId>_<name>=body to
 *        browser.storage.local AND injects window.__sp_pack[name] = new
 *        Function(...). Unregister removes both.
 *
 *   D-3: tabs.onUpdated listener re-injects from storage on status:complete.
 *
 *   (already shipped in C-8) tabs.onRemoved cleans up on tab close.
 *
 * Source-grep tested per established T60/T67 extension pattern; live behavior
 * tested at e2e (D-6 against rebuilt v0.1.27 extension).
 */
import { describe, expect, test, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('T79 Cluster D — pack persistence wiring in extension', () => {
  let bg: string;

  beforeAll(async () => {
    bg = await readFile('extension/background.js', 'utf8');
  });

  // ── D-2: register/unregister sentinel handlers ─────────────────────────

  test('background.js handles __SP_PACK_REGISTER__ sentinel', () => {
    expect(bg).toMatch(/__SP_PACK_REGISTER__/);
  });

  test('background.js handles __SP_PACK_UNREGISTER__ sentinel', () => {
    expect(bg).toMatch(/__SP_PACK_UNREGISTER__/);
  });

  test('register sentinel writes sp_pack_ key to storage.local.set', () => {
    // Match the broader pack handler region, anchored on the startsWith check
    // through to the UNKNOWN sentinel guard (always present in the same block).
    const packBlock = bg.match(/cmd\.script\.startsWith\('__SP_PACK_'\)[\s\S]*?UNKNOWN_PACK_SENTINEL/);
    expect(packBlock, 'expected pack sentinel handler block').toBeTruthy();
    expect(packBlock![0]).toMatch(/storageKey\s*=\s*['"]sp_pack_/);
    expect(packBlock![0]).toMatch(/storage\.local\.set\([\s\S]*?storageKey/);
  });

  test('unregister sentinel calls storage.local.remove on sp_pack_ key', () => {
    const packBlock = bg.match(/cmd\.script\.startsWith\('__SP_PACK_'\)[\s\S]*?UNKNOWN_PACK_SENTINEL/);
    expect(packBlock, 'expected pack handler region up to UNKNOWN sentinel guard').toBeTruthy();
    expect(packBlock![0]).toMatch(/__SP_PACK_UNREGISTER__[\s\S]*?storage\.local\.remove\([\s\S]*?storageKey/);
  });

  test('register sentinel injects window.__sp_pack[name] = new Function(...)', () => {
    // The page-side injection must use new Function (not eval) per security stance.
    const packBlock = bg.match(/__SP_PACK_REGISTER__[\s\S]*?__SP_PACK_UNREGISTER__/);
    expect(packBlock![0]).toMatch(/new Function/);
    expect(packBlock![0]).toMatch(/window\.__sp_pack/);
    expect(packBlock![0]).not.toMatch(/\beval\s*\(/);
  });

  test('register/unregister bodies pass through name+body via JSON.stringify (escape-safe)', () => {
    // JSON.stringify is the round-trip-safe escape for embedding name and body
    // into a JS string literal. Bare quote-replacement would miss backslashes.
    const packBlock = bg.match(/__SP_PACK_REGISTER__[\s\S]*?__SP_PACK_UNREGISTER__/);
    expect(packBlock![0]).toMatch(/JSON\.stringify\(name\)/);
    expect(packBlock![0]).toMatch(/JSON\.stringify\(body\)/);
  });

  // ── D-3: tabs.onUpdated re-injection listener ──────────────────────────

  test('background.js declares a tabs.onUpdated listener', () => {
    expect(bg).toMatch(/browser\.tabs\.onUpdated\.addListener/);
  });

  test('the onUpdated listener gates on status === "complete"', () => {
    expect(bg).toMatch(/changeInfo\.status\s*!==?\s*['"]complete['"]/);
  });

  test('the onUpdated listener filters keys by sp_pack_<tabId>_ prefix', () => {
    // Looks for the prefix construction with the tabId interpolated.
    expect(bg).toMatch(/sp_pack_['"\s]\s*\+\s*tabId/);
  });

  test('the onUpdated listener re-injects via execute_script storage-bus command', () => {
    // Re-injection uses the same content-isolated.js storage-bus path other
    // commands use — establishes that the page-side write path goes through
    // the existing security and execution surface, not a bypass.
    const updatedBlock = bg.match(/tabs\.onUpdated\.addListener[\s\S]*?pack_rehydrated[\s\S]*?\}\);/);
    expect(updatedBlock, 'expected onUpdated listener body through pack_rehydrated').toBeTruthy();
    expect(updatedBlock![0]).toMatch(/execute_script/);
    expect(updatedBlock![0]).toMatch(/sp_cmd_/);
    expect(updatedBlock![0]).toMatch(/new Function/);
  });

  test('onUpdated listener emits pack_rehydrated trace events', () => {
    expect(bg).toMatch(/pack_rehydrated/);
  });
});
