/**
 * v0.1.34 T16: legacyMainWorld rollback flag wiring.
 *
 * The flag is a rollback safety net: when set to `true` in
 * safari-pilot.config.json, the 14 v0.1.34-refactored handlers
 * (4 interaction + 5 extraction + 5 structured-extraction) dispatch through
 * their verbatim v0.1.33 JS-string `*Legacy` companions instead of the
 * new __SP_*__ sentinels.
 *
 * This test exercises only the config-loader wiring — the runtime dispatch
 * effect requires a server restart to pick up the flag and is verified
 * manually by toggling the flag in safari-pilot.config.json and running an
 * existing e2e tool test. See the test for `selectorPack.enabled` as the
 * parallel pattern for a fail-safe boolean flag.
 */
import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { loadConfig, DEFAULT_CONFIG } from '../../../src/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('T16 legacyMainWorld rollback flag', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sp-config-t16-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('legacyMainWorld defaults to false in DEFAULT_CONFIG', () => {
    expect(DEFAULT_CONFIG.legacyMainWorld).toBe(false);
  });

  test('loadConfig with no override yields legacyMainWorld === false', () => {
    const path = join(tmpDir, 'empty.json');
    // Include selectorPack so deepMerge produces a fresh writable nested object
    // (pre-existing selectorPack coercion writes into the merged object;
    // omitting it inherits DEFAULT_CONFIG.selectorPack by reference, which is
    // frozen after first loadConfig() call. Match the pattern used by
    // selector-pack-flag.test.ts.)
    writeFileSync(path, JSON.stringify({ schemaVersion: '1.0', selectorPack: { enabled: false } }));
    const cfg = loadConfig(path);
    expect(cfg.legacyMainWorld).toBe(false);
  });

  test('loadConfig honors explicit legacyMainWorld === true', () => {
    const path = join(tmpDir, 'enabled.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: '1.0', selectorPack: { enabled: false }, legacyMainWorld: true }));
    const cfg = loadConfig(path);
    expect(cfg.legacyMainWorld).toBe(true);
  });

  test('loadConfig coerces non-boolean truthy values to false (strict bool check)', () => {
    // Same fail-safe contract as selectorPack.enabled: attacker-controlled config
    // should not flip the flag via truthy non-boolean values like the string "true"
    // or numeric 1. The flag must be a strict boolean.
    const path = join(tmpDir, 'string-true.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: '1.0', selectorPack: { enabled: false }, legacyMainWorld: 'true' }));
    const cfg = loadConfig(path);
    expect(cfg.legacyMainWorld).toBe(false);
  });

  test('the shipped safari-pilot.config.json defaults legacyMainWorld to false', () => {
    // Guard against a future commit that flips the shipped default unintentionally
    // — would silently regress every user to the v0.1.33 JS-string code path.
    const shippedConfigPath = resolve(__dirname, '../../../safari-pilot.config.json');
    const shippedRaw = readFileSync(shippedConfigPath, 'utf-8');
    const shipped = JSON.parse(shippedRaw);
    expect(shipped).toHaveProperty('legacyMainWorld');
    expect(shipped.legacyMainWorld).toBe(false);
  });
});
