/**
 * T79 C-2: selectorPack feature flag wiring.
 *
 * The selectorPack feature is gated behind `selectorPack.enabled`. Default is
 * `false` (off) — the SafariPilotServer must NOT register `safari_register_selector` /
 * `safari_unregister_selector` unless the flag is explicitly enabled.
 *
 * The actual config loader (`loadConfig(path?: string)`) reads from
 * `safari-pilot.config.json` or a path passed in directly. The plan's prescribed
 * test signature `loadConfig(input: object)` does NOT match the actual API; we
 * exercise the real path-based loader by writing a tmp file.
 */
import { describe, expect, test, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, DEFAULT_CONFIG } from '../../../src/config.js';

describe('T79 selectorPack feature flag', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sp-config-c2-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('selectorPack.enabled defaults to false in DEFAULT_CONFIG', () => {
    expect(DEFAULT_CONFIG.selectorPack).toBeDefined();
    expect(DEFAULT_CONFIG.selectorPack.enabled).toBe(false);
  });

  test('loadConfig with no override yields selectorPack.enabled === false', () => {
    const path = join(tmpDir, 'empty.json');
    writeFileSync(path, JSON.stringify({}));
    const cfg = loadConfig(path);
    expect(cfg.selectorPack.enabled).toBe(false);
  });

  test('loadConfig honors explicit selectorPack.enabled === true', () => {
    const path = join(tmpDir, 'enabled.json');
    writeFileSync(path, JSON.stringify({ selectorPack: { enabled: true } }));
    const cfg = loadConfig(path);
    expect(cfg.selectorPack.enabled).toBe(true);
  });

  test('loadConfig coerces non-boolean truthy values to false (strict bool check)', () => {
    // Defensive: attacker-controlled config should not enable a feature via truthy
    // non-boolean values like the string "true" or numeric 1. The flag must be a
    // strict boolean.
    const path = join(tmpDir, 'string-true.json');
    writeFileSync(path, JSON.stringify({ selectorPack: { enabled: 'true' } }));
    const cfg = loadConfig(path);
    expect(cfg.selectorPack.enabled).toBe(false);
  });
});
