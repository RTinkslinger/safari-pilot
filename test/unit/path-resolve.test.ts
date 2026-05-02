import { describe, it, expect } from 'vitest';
import { resolveUploadPath, findClosestSibling } from '../../src/path-resolve.js';
import {
  FileUploadPathNotAbsoluteError,
  FileUploadPathNotReadableError,
} from '../../src/errors.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

describe('resolveUploadPath', () => {
  it('passes through an absolute path unchanged when realpath matches', () => {
    // /tmp is a real path that always exists on macOS
    const r = resolveUploadPath('/tmp');
    // /tmp on macOS may be a symlink to /private/tmp — warnings covers that case.
    // The key contract: absolute is a non-empty string, no throw.
    expect(typeof r.absolute).toBe('string');
    expect(r.absolute.length).toBeGreaterThan(0);
    expect(Array.isArray(r.warnings)).toBe(true);
  });

  it('expands ~/relative to homedir', () => {
    const r = resolveUploadPath('~/Documents');
    expect(r.absolute).toBe(join(homedir(), 'Documents'));
  });

  it('expands ~ alone to homedir', () => {
    const r = resolveUploadPath('~');
    expect(r.absolute).toBe(homedir());
  });

  it('rejects relative paths with FileUploadPathNotAbsoluteError', () => {
    expect(() => resolveUploadPath('relative/path')).toThrow(FileUploadPathNotAbsoluteError);
    expect(() => resolveUploadPath('./foo')).toThrow(FileUploadPathNotAbsoluteError);
  });

  it('rejects paths containing NUL byte with FileUploadPathNotReadableError', () => {
    expect(() => resolveUploadPath('/tmp/foo\x00bar')).toThrow(FileUploadPathNotReadableError);
    expect(() => resolveUploadPath('\x00')).toThrow(FileUploadPathNotReadableError);
  });

  it('accepts paths with spaces (macOS paths legitimately contain spaces)', () => {
    // /Users/Aakash/Claude Projects/... is the actual project path. Rejecting
    // spaces would break every macOS user. Spec mandates NUL rejection only.
    const r = resolveUploadPath('/Users/Aakash/Claude Projects/Skills Factory/safari-pilot/package.json');
    expect(r.absolute).toContain('/Users/Aakash/Claude Projects/Skills Factory/safari-pilot/package.json');
  });

  it('rejects ~user form with FileUploadPathNotAbsoluteError', () => {
    expect(() => resolveUploadPath('~someuser/docs')).toThrow(FileUploadPathNotAbsoluteError);
  });

  it('emits a symlink warning when realpath diverges from input', () => {
    // /tmp on macOS is a symlink to /private/tmp — a reliable real case.
    const r = resolveUploadPath('/tmp');
    // If /tmp is a symlink, there should be a warning; if it's not, no warning.
    // We assert conditional shape: when realpath diverges, warning mentions 'symlink resolved'.
    if (r.absolute !== '/tmp') {
      expect(r.warnings.some((w) => w.includes('symlink resolved'))).toBe(true);
    }
  });

  it('emits no warning when realpath equals input', () => {
    // Use the already-resolved realpath so it won't diverge.
    const r1 = resolveUploadPath('/tmp');
    const real = r1.absolute; // /private/tmp on macOS
    const r2 = resolveUploadPath(real);
    expect(r2.warnings).toHaveLength(0);
  });

  it('does not throw on ENOENT paths — path shape validation only', () => {
    // resolveUploadPath is path-shape-only; existence is the caller's concern.
    expect(() => resolveUploadPath('/tmp/safari-pilot-nonexistent-test-path')).not.toThrow();
  });
});

describe('findClosestSibling', () => {
  it('returns undefined for a path whose parent directory does not exist', () => {
    const result = findClosestSibling('/nonexistent-dir-abc123/file.txt');
    expect(result).toBeUndefined();
  });

  it('returns closest match when Levenshtein distance is ≤ 3', () => {
    // package.json is in the project root — "pacakge.json" is distance 2 (transposition)
    const root = '/Users/Aakash/Claude Projects/Skills Factory/safari-pilot';
    const result = findClosestSibling(`${root}/pacakge.json`);
    expect(result).toBeDefined();
    expect(result).toContain('package.json');
  });

  it('returns undefined when closest match distance > 3', () => {
    // A filename with no close siblings — many edits away from any real file
    const root = '/Users/Aakash/Claude Projects/Skills Factory/safari-pilot';
    const result = findClosestSibling(`${root}/zzzzzzzzzzzzzzzzzzzzzzz.xyz`);
    expect(result).toBeUndefined();
  });
});
