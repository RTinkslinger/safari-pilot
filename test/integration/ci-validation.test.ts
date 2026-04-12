/**
 * CI Validation — Infrastructure file completeness
 *
 * Verifies that all required CI/CD and packaging infrastructure files exist
 * and are correctly configured:
 *
 *  1. .npmignore exists and excludes expected directories
 *  2. scripts/preuninstall.sh exists and is executable
 *  3. .github/workflows/test.yml exists with correct job names
 *  4. .github/workflows/release.yml exists with npm publish step
 *  5. npm pack dry-run excludes test/ and daemon/Sources/
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function rootPath(...parts: string[]): string {
  return resolve(ROOT, ...parts);
}

// ── 1. .npmignore ─────────────────────────────────────────────────────────────

describe('.npmignore', () => {
  it('exists at project root', () => {
    expect(existsSync(rootPath('.npmignore'))).toBe(true);
  });

  it('excludes test/', () => {
    const content = readFileSync(rootPath('.npmignore'), 'utf8');
    expect(content).toContain('test/');
  });

  it('excludes daemon/Sources/', () => {
    const content = readFileSync(rootPath('.npmignore'), 'utf8');
    expect(content).toContain('daemon/Sources/');
  });

  it('excludes daemon/Tests/', () => {
    const content = readFileSync(rootPath('.npmignore'), 'utf8');
    expect(content).toContain('daemon/Tests/');
  });

  it('excludes .github/', () => {
    const content = readFileSync(rootPath('.npmignore'), 'utf8');
    expect(content).toContain('.github/');
  });

  it('excludes coverage/', () => {
    const content = readFileSync(rootPath('.npmignore'), 'utf8');
    expect(content).toContain('coverage/');
  });

  it('excludes app/', () => {
    const content = readFileSync(rootPath('.npmignore'), 'utf8');
    expect(content).toContain('app/');
  });
});

// ── 2. preuninstall.sh ────────────────────────────────────────────────────────

describe('scripts/preuninstall.sh', () => {
  it('exists', () => {
    expect(existsSync(rootPath('scripts/preuninstall.sh'))).toBe(true);
  });

  it('is executable', () => {
    const stat = statSync(rootPath('scripts/preuninstall.sh'));
    // Check owner execute bit (0o100)
    const isExecutable = (stat.mode & 0o100) !== 0;
    expect(isExecutable).toBe(true);
  });

  it('starts with a shebang', () => {
    const content = readFileSync(rootPath('scripts/preuninstall.sh'), 'utf8');
    expect(content.startsWith('#!/bin/bash')).toBe(true);
  });

  it('handles the LaunchAgent label', () => {
    const content = readFileSync(rootPath('scripts/preuninstall.sh'), 'utf8');
    expect(content).toContain('com.safari-pilot.daemon');
  });

  it('calls launchctl bootout to unload the daemon', () => {
    const content = readFileSync(rootPath('scripts/preuninstall.sh'), 'utf8');
    expect(content).toContain('launchctl bootout');
  });

  it('removes the plist file', () => {
    const content = readFileSync(rootPath('scripts/preuninstall.sh'), 'utf8');
    expect(content).toContain('rm -f "$PLIST"');
  });

  it('skips gracefully on non-macOS', () => {
    const content = readFileSync(rootPath('scripts/preuninstall.sh'), 'utf8');
    expect(content).toContain('Darwin');
    expect(content).toContain('exit 0');
  });
});

// ── 3. .github/workflows/test.yml ────────────────────────────────────────────

describe('.github/workflows/test.yml', () => {
  it('exists', () => {
    expect(existsSync(rootPath('.github/workflows/test.yml'))).toBe(true);
  });

  it('contains unit-tests job', () => {
    const content = readFileSync(rootPath('.github/workflows/test.yml'), 'utf8');
    expect(content).toContain('unit-tests');
  });

  it('contains integration-tests job', () => {
    const content = readFileSync(rootPath('.github/workflows/test.yml'), 'utf8');
    expect(content).toContain('integration-tests');
  });

  it('contains e2e-tests job', () => {
    const content = readFileSync(rootPath('.github/workflows/test.yml'), 'utf8');
    expect(content).toContain('e2e-tests');
  });

  it('runs unit-tests on macos-15 (macOS-only package)', () => {
    const content = readFileSync(rootPath('.github/workflows/test.yml'), 'utf8');
    // unit-tests and integration-tests both run on macOS since package has "os": ["darwin"]
    const unitSection = content.split('unit-tests:')[1]?.split('integration-tests:')[0] ?? '';
    expect(unitSection).toContain('macos-15');
  });

  it('runs integration-tests on macos-15', () => {
    const content = readFileSync(rootPath('.github/workflows/test.yml'), 'utf8');
    expect(content).toContain('macos-15');
  });

  it('builds swift daemon in integration job', () => {
    const content = readFileSync(rootPath('.github/workflows/test.yml'), 'utf8');
    expect(content).toContain('swift build');
  });

  it('triggers on push to main and pull_request', () => {
    const content = readFileSync(rootPath('.github/workflows/test.yml'), 'utf8');
    expect(content).toContain('push');
    expect(content).toContain('pull_request');
  });
});

// ── 4. .github/workflows/release.yml ─────────────────────────────────────────

describe('.github/workflows/release.yml', () => {
  it('exists', () => {
    expect(existsSync(rootPath('.github/workflows/release.yml'))).toBe(true);
  });

  it('triggers on v* tag push', () => {
    const content = readFileSync(rootPath('.github/workflows/release.yml'), 'utf8');
    expect(content).toContain("'v*'");
  });

  it('contains npm publish step', () => {
    const content = readFileSync(rootPath('.github/workflows/release.yml'), 'utf8');
    expect(content).toContain('npm publish');
  });

  it('builds universal binary with lipo', () => {
    const content = readFileSync(rootPath('.github/workflows/release.yml'), 'utf8');
    expect(content).toContain('lipo');
  });

  it('builds both arm64 and x86_64 architectures', () => {
    const content = readFileSync(rootPath('.github/workflows/release.yml'), 'utf8');
    expect(content).toContain('arm64');
    expect(content).toContain('x86_64');
  });

  it('signs with codesign', () => {
    const content = readFileSync(rootPath('.github/workflows/release.yml'), 'utf8');
    expect(content).toContain('codesign');
  });

  it('notarizes with notarytool', () => {
    const content = readFileSync(rootPath('.github/workflows/release.yml'), 'utf8');
    expect(content).toContain('notarytool');
  });

  it('creates a GitHub Release', () => {
    const content = readFileSync(rootPath('.github/workflows/release.yml'), 'utf8');
    expect(content).toContain('action-gh-release');
  });

  it('uses NPM_TOKEN secret for npm publish', () => {
    const content = readFileSync(rootPath('.github/workflows/release.yml'), 'utf8');
    expect(content).toContain('NPM_TOKEN');
  });
});

// ── 5. npm pack dry-run ───────────────────────────────────────────────────────

describe('npm pack --dry-run', () => {
  it('produces a tarball without test/ contents', () => {
    let output: string;
    try {
      output = execSync('npm pack --dry-run 2>&1', {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 30_000,
      });
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      output = (error.stdout ?? '') + (error.stderr ?? '');
      if (!output) throw err;
    }

    // Should not include test/ source files
    expect(output).not.toMatch(/npm notice.*test\/.*\.test\.(ts|js)/);
  });

  it('produces a tarball without daemon/Sources/', () => {
    let output: string;
    try {
      output = execSync('npm pack --dry-run 2>&1', {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 30_000,
      });
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; message?: string };
      output = (error.stdout ?? '') + (error.stderr ?? '');
      if (!output) throw err;
    }

    expect(output).not.toContain('daemon/Sources/');
  });

  it('includes dist/ in the tarball', () => {
    // dist/ may not exist pre-build, so we check .npmignore doesn't exclude it
    const npmignore = readFileSync(rootPath('.npmignore'), 'utf8');
    expect(npmignore).not.toContain('dist/');
  });
});
