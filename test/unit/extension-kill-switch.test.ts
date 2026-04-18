import { describe, it, expect } from 'vitest';
import { selectEngine, EngineUnavailableError } from '../../src/engine-selector.js';
import { loadConfig } from '../../src/config.js';

describe('Extension kill-switch (Task 13)', () => {
  describe('engine-selector honors extension.enabled=false', () => {
    it('returns daemon (not extension) when kill-switch on + tool has no hard requirement', () => {
      const result = selectEngine(
        { idempotent: true },
        { daemon: true, extension: true },
        undefined,
        { extension: { enabled: false } }
      );
      expect(result).toBe('daemon');
    });

    it('throws EngineUnavailableError when kill-switch on + tool requires extension', () => {
      expect(() => selectEngine(
        { idempotent: true, requiresShadowDom: true },
        { daemon: true, extension: true },
        undefined,
        { extension: { enabled: false } }
      )).toThrow(EngineUnavailableError);
    });

    it('respects extension when kill-switch is true (default)', () => {
      const result = selectEngine(
        { idempotent: true },
        { daemon: true, extension: true },
        undefined,
        { extension: { enabled: true } }
      );
      expect(result).toBe('extension');
    });

    it('respects extension when config is undefined (backwards compatible)', () => {
      const result = selectEngine(
        { idempotent: true },
        { daemon: true, extension: true }
      );
      expect(result).toBe('extension');
    });

    it('returns applescript when kill-switch on AND daemon unavailable', () => {
      const result = selectEngine(
        { idempotent: true },
        { daemon: false, extension: true },
        undefined,
        { extension: { enabled: false } }
      );
      expect(result).toBe('applescript');
    });
  });

  describe('loadConfig validates extension section', () => {
    it('default config has extension.enabled=true', () => {
      // Load the real config (safari-pilot.config.json at repo root)
      const cfg = loadConfig();
      expect(cfg.extension.enabled).toBe(true);
      expect(cfg.extension.killSwitchVersion).toBe('0.1.5');
    });

    it('loadConfig rejects non-boolean extension.enabled', () => {
      // Write a temp config with bad shape
      const { writeFileSync, mkdtempSync } = require('node:fs');
      const { tmpdir } = require('node:os');
      const { join } = require('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'sp-cfg-'));
      const badPath = join(dir, 'bad.config.json');
      writeFileSync(badPath, JSON.stringify({
        schemaVersion: '1.0',
        extension: { enabled: 'true', killSwitchVersion: '0.1.5' },
      }));
      expect(() => loadConfig(badPath)).toThrow(/extension.enabled must be a boolean/);
    });

    it('loadConfig rejects missing extension.killSwitchVersion', () => {
      const { writeFileSync, mkdtempSync } = require('node:fs');
      const { tmpdir } = require('node:os');
      const { join } = require('node:path');
      const dir = mkdtempSync(join(tmpdir(), 'sp-cfg-'));
      const badPath = join(dir, 'bad.config.json');
      writeFileSync(badPath, JSON.stringify({
        schemaVersion: '1.0',
        extension: { enabled: true, killSwitchVersion: '' },
      }));
      expect(() => loadConfig(badPath)).toThrow(/killSwitchVersion must be a non-empty string/);
    });
  });
});
