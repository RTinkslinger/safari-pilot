import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, DEFAULT_CONFIG, ConfigValidationError } from '../../src/config.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const TEST_DIR = join(tmpdir(), `safari-pilot-config-test-${Date.now()}`);
const TEST_CONFIG = join(TEST_DIR, 'safari-pilot.config.json');

describe('loadConfig', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns all defaults when config file does not exist', () => {
    const config = loadConfig(join(TEST_DIR, 'nonexistent.json'));
    expect(config.schemaVersion).toBe('1.0');
    expect(config.rateLimit.maxActionsPerMinute).toBe(120);
    expect(config.rateLimit.windowMs).toBe(60_000);
    expect(config.circuitBreaker.errorThreshold).toBe(5);
    expect(config.circuitBreaker.cooldownMs).toBe(120_000);
    expect(config.domainPolicy.blocked).toEqual([]);
    expect(config.domainPolicy.trusted).toEqual([]);
    expect(config.killSwitch.autoActivation).toBe(false);
    expect(config.audit.maxEntries).toBe(10_000);
    expect(config.daemon.timeoutMs).toBe(30_000);
    expect(config.healthCheck.timeoutMs).toBe(3_000);
  });

  it('merges partial config — only rateLimit overridden, rest defaults', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({
      schemaVersion: '1.0',
      rateLimit: { maxActionsPerMinute: 30 },
    }));
    const config = loadConfig(TEST_CONFIG);
    expect(config.rateLimit.maxActionsPerMinute).toBe(30);
    expect(config.rateLimit.windowMs).toBe(60_000);
    expect(config.circuitBreaker.errorThreshold).toBe(5);
  });

  it('merges nested partial config — only one circuitBreaker field overridden', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({
      schemaVersion: '1.0',
      circuitBreaker: { cooldownMs: 60_000 },
    }));
    const config = loadConfig(TEST_CONFIG);
    expect(config.circuitBreaker.cooldownMs).toBe(60_000);
    expect(config.circuitBreaker.errorThreshold).toBe(5);
    expect(config.circuitBreaker.windowMs).toBe(60_000);
  });

  it('accepts domain policy with blocked and trusted lists', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({
      schemaVersion: '1.0',
      domainPolicy: {
        blocked: ['evil.com', '*.spam.net'],
        trusted: ['myapp.dev'],
      },
    }));
    const config = loadConfig(TEST_CONFIG);
    expect(config.domainPolicy.blocked).toEqual(['evil.com', '*.spam.net']);
    expect(config.domainPolicy.trusted).toEqual(['myapp.dev']);
    expect(config.domainPolicy.defaultMaxActionsPerMinute).toBe(60);
  });

  it('resolves tilde in audit.logPath', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({
      schemaVersion: '1.0',
      audit: { logPath: '~/custom/audit.log' },
    }));
    const config = loadConfig(TEST_CONFIG);
    expect(config.audit.logPath).toBe(join(homedir(), 'custom/audit.log'));
    expect(config.audit.logPath).not.toContain('~');
  });

  it('returns frozen config object', () => {
    const config = loadConfig(join(TEST_DIR, 'nonexistent.json'));
    expect(Object.isFrozen(config)).toBe(true);
  });

  // ── Validation errors ────────────────────────────────────────────────────────

  it('throws on negative maxActionsPerMinute', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({
      schemaVersion: '1.0',
      rateLimit: { maxActionsPerMinute: -5 },
    }));
    expect(() => loadConfig(TEST_CONFIG)).toThrow(ConfigValidationError);
    expect(() => loadConfig(TEST_CONFIG)).toThrow('rateLimit.maxActionsPerMinute must be a positive number');
  });

  it('throws on zero errorThreshold', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({
      schemaVersion: '1.0',
      circuitBreaker: { errorThreshold: 0 },
    }));
    expect(() => loadConfig(TEST_CONFIG)).toThrow(ConfigValidationError);
  });

  it('throws on non-boolean autoActivation', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({
      schemaVersion: '1.0',
      killSwitch: { autoActivation: 'yes' },
    }));
    expect(() => loadConfig(TEST_CONFIG)).toThrow(ConfigValidationError);
    expect(() => loadConfig(TEST_CONFIG)).toThrow('killSwitch.autoActivation must be a boolean');
  });

  it('throws on non-array blocked domains', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({
      schemaVersion: '1.0',
      domainPolicy: { blocked: 'evil.com' },
    }));
    expect(() => loadConfig(TEST_CONFIG)).toThrow(ConfigValidationError);
    expect(() => loadConfig(TEST_CONFIG)).toThrow('domainPolicy.blocked must be an array of strings');
  });

  it('throws on unsupported schemaVersion', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({
      schemaVersion: '2.0',
    }));
    expect(() => loadConfig(TEST_CONFIG)).toThrow(ConfigValidationError);
    expect(() => loadConfig(TEST_CONFIG)).toThrow('Unsupported schemaVersion');
  });

  it('throws on invalid JSON', () => {
    writeFileSync(TEST_CONFIG, '{ bad json');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(ConfigValidationError);
    expect(() => loadConfig(TEST_CONFIG)).toThrow('Invalid JSON');
  });

  it('throws when config file is not a JSON object', () => {
    writeFileSync(TEST_CONFIG, '"just a string"');
    expect(() => loadConfig(TEST_CONFIG)).toThrow(ConfigValidationError);
    expect(() => loadConfig(TEST_CONFIG)).toThrow('must contain a JSON object');
  });

  it('throws on empty audit logPath', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({
      schemaVersion: '1.0',
      audit: { logPath: '' },
    }));
    expect(() => loadConfig(TEST_CONFIG)).toThrow(ConfigValidationError);
    expect(() => loadConfig(TEST_CONFIG)).toThrow('audit.logPath must be a non-empty string');
  });

  it('throws ConfigValidationError (not TypeError) when a section is null', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({
      schemaVersion: '1.0',
      rateLimit: null,
    }));
    expect(() => loadConfig(TEST_CONFIG)).toThrow(ConfigValidationError);
    expect(() => loadConfig(TEST_CONFIG)).toThrow('rateLimit must be an object');
  });

  it('handles unknown extra keys without crashing', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({
      schemaVersion: '1.0',
      unknownSection: { foo: 'bar' },
      rateLimit: { maxActionsPerMinute: 50 },
    }));
    const config = loadConfig(TEST_CONFIG);
    expect(config.rateLimit.maxActionsPerMinute).toBe(50);
    expect((config as Record<string, unknown>)['unknownSection']).toBeUndefined();
  });

  // ── Env var path ─────────────────────────────────────────────────────────────

  it('reads from SAFARI_PILOT_CONFIG env var', () => {
    writeFileSync(TEST_CONFIG, JSON.stringify({
      schemaVersion: '1.0',
      rateLimit: { maxActionsPerMinute: 42 },
    }));
    const original = process.env['SAFARI_PILOT_CONFIG'];
    process.env['SAFARI_PILOT_CONFIG'] = TEST_CONFIG;
    try {
      const config = loadConfig();
      expect(config.rateLimit.maxActionsPerMinute).toBe(42);
    } finally {
      if (original !== undefined) {
        process.env['SAFARI_PILOT_CONFIG'] = original;
      } else {
        delete process.env['SAFARI_PILOT_CONFIG'];
      }
    }
  });
});
