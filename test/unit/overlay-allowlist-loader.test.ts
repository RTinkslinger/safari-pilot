import { describe, it, expect } from 'vitest';
import { loadAllowlistFile, buildRegistry } from '../../src/overlays/index.js';
import { join } from 'node:path';

const FIXTURES = join(__dirname, '..', 'fixtures', 'allowlist');

describe('overlay allowlist loader', () => {
  it('loads a valid two-signal pattern file', () => {
    const file = loadAllowlistFile(join(FIXTURES, 'valid.json'));
    expect(file.version).toBe(1);
    expect(file.category).toBe('cookie-consent');
    expect(file.patterns).toHaveLength(1);
    expect(file.patterns[0].id).toBe('test-pattern');
  });

  it('rejects single-signal patterns at load time', () => {
    expect(() => loadAllowlistFile(join(FIXTURES, 'single-signal-invalid.json')))
      .toThrow(/two-signal|at least 2 signals/i);
  });

  it('buildRegistry merges patterns from multiple files with category + fileVersion', () => {
    const registry = buildRegistry([
      loadAllowlistFile(join(FIXTURES, 'valid.json')),
    ]);
    expect(registry).toHaveLength(1);
    expect(registry[0].category).toBe('cookie-consent');
    expect(registry[0].fileVersion).toBe(1);
    expect(registry[0].id).toBe('test-pattern');
  });

  it('buildRegistry detects duplicate pattern IDs across categories', () => {
    const file = loadAllowlistFile(join(FIXTURES, 'valid.json'));
    expect(() => buildRegistry([file, file])).toThrow(/duplicate.*test-pattern/i);
  });
});
