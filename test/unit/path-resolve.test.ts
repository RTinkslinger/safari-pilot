import { describe, it, expect } from 'vitest';
import { resolveUploadPath, findClosestSibling } from '../../src/path-resolve.js';
import {
  FileUploadPathNotAbsoluteError,
  FileUploadPathNotReadableError,
} from '../../src/errors.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Project root, derived from this test file's location — portable across machines/CI.
const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '../../../');

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
    // PROJECT_ROOT often contains spaces (e.g., "Claude Projects/Skills Factory").
    // Rejecting spaces would break every macOS user. Spec mandates NUL rejection only.
    const r = resolveUploadPath(join(PROJECT_ROOT, 'package.json'));
    expect(r.absolute).toContain('package.json');
  });

  it('rejects ~user form with FileUploadPathNotAbsoluteError', () => {
    expect(() => resolveUploadPath('~someuser/docs')).toThrow(FileUploadPathNotAbsoluteError);
  });

  it('emits a symlink warning when realpath diverges from input', () => {
    // /tmp on macOS is a symlink to /private/tmp — a reliable real case.
    const r = resolveUploadPath('/tmp');
    // If /tmp is a symlink, the warning must contain BOTH the original input
    // and the resolved path — that's the forensic-trail contract per spec.
    if (r.absolute !== '/tmp') {
      const w = r.warnings.find((w) => w.includes('symlink resolved'));
      expect(w).toBeDefined();
      expect(w).toContain('/tmp');
      expect(w).toContain(r.absolute);
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
    const result = findClosestSibling(join(PROJECT_ROOT, 'pacakge.json'));
    expect(result).toBeDefined();
    expect(result).toContain('package.json');
  });

  it('returns undefined when closest match distance > 3', () => {
    // A filename with no close siblings — many edits away from any real file
    const result = findClosestSibling(join(PROJECT_ROOT, 'zzzzzzzzzzzzzzzzzzzzzzz.xyz'));
    expect(result).toBeUndefined();
  });
});
