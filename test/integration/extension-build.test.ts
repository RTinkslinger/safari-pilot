/**
 * Extension Build Integration Test (Task 3.6)
 *
 * Verifies the prerequisites and artifacts for packaging the Safari extension
 * into a distributable macOS app via the Xcode build pipeline.
 *
 * NOTE: The full Xcode build (xcodebuild) is NOT run here — it takes 2-5 minutes
 * and is unsuitable for CI. This test verifies all prerequisites so the build
 * script can run successfully in a separate packaging step.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, accessSync, readFileSync, constants } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const EXT_DIR = path.join(PROJECT_ROOT, 'extension');
const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');

// ── Test 1: Extension source files ───────────────────────────────────────────

describe('Extension Build — Source files exist', () => {
  it('manifest.json exists in extension/', () => {
    expect(existsSync(path.join(EXT_DIR, 'manifest.json'))).toBe(true);
  });

  it('content-main.js exists in extension/', () => {
    expect(existsSync(path.join(EXT_DIR, 'content-main.js'))).toBe(true);
  });

  it('content-isolated.js exists in extension/', () => {
    expect(existsSync(path.join(EXT_DIR, 'content-isolated.js'))).toBe(true);
  });

  it('background.js exists in extension/', () => {
    expect(existsSync(path.join(EXT_DIR, 'background.js'))).toBe(true);
  });
});

// ── Test 2: Build script ──────────────────────────────────────────────────────

describe('Extension Build — Build script', () => {
  it('build-extension.sh exists in scripts/', () => {
    expect(existsSync(path.join(SCRIPTS_DIR, 'build-extension.sh'))).toBe(true);
  });

  it('build-extension.sh is executable', () => {
    const scriptPath = path.join(SCRIPTS_DIR, 'build-extension.sh');
    expect(() => accessSync(scriptPath, constants.X_OK)).not.toThrow();
  });
});

// ── Test 3: Packager availability ────────────────────────────────────────────

describe('Extension Build — Toolchain prerequisites', () => {
  it('xcrun is available on PATH', () => {
    expect(() => execSync('xcrun --version', { stdio: 'pipe' })).not.toThrow();
  });

  it('safari-web-extension-packager is available via xcrun', () => {
    // --help exits with code 64 (by design), but the tool is found and invoked
    let found = false;
    try {
      execSync('xcrun safari-web-extension-packager --help', { stdio: 'pipe' });
      found = true;
    } catch (err: unknown) {
      // Exit code 64 means the tool ran and printed help — it's available
      const spawnError = err as { status?: number; stderr?: Buffer };
      if (spawnError.status === 64) {
        found = true;
      } else if (spawnError.stderr) {
        // Tool ran but exited non-zero for another reason — check output contains usage text
        const stderr = spawnError.stderr.toString();
        found = stderr.includes('safari-web-extension-packager') ||
                stderr.includes('Usage:');
      }
    }
    expect(found, 'safari-web-extension-packager must be available via xcrun').toBe(true);
  });

  it('xcodebuild is available', () => {
    expect(() => execSync('xcodebuild -version', { stdio: 'pipe' })).not.toThrow();
  });
});

// ── Test 4: manifest.json validity ───────────────────────────────────────────

describe('Extension Build — manifest.json is valid', () => {
  let manifest: Record<string, unknown>;

  // Parse once; individual tests are data assertions not I/O
  try {
    manifest = JSON.parse(
      readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf-8'),
    ) as Record<string, unknown>;
  } catch {
    manifest = {};
  }

  it('manifest.json is valid JSON', () => {
    expect(() =>
      JSON.parse(readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf-8')),
    ).not.toThrow();
  });

  it('manifest has manifest_version 3', () => {
    expect(manifest['manifest_version']).toBe(3);
  });

  it('manifest has a name field', () => {
    expect(typeof manifest['name']).toBe('string');
    expect((manifest['name'] as string).length).toBeGreaterThan(0);
  });

  it('manifest has a version field matching semver pattern', () => {
    expect(typeof manifest['version']).toBe('string');
    expect(manifest['version']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('manifest has required permissions', () => {
    const perms = manifest['permissions'] as string[];
    expect(Array.isArray(perms)).toBe(true);
    for (const p of ['activeTab', 'scripting', 'nativeMessaging', 'tabs']) {
      expect(perms, `Missing permission: ${p}`).toContain(p);
    }
  });

  it('manifest has background service_worker', () => {
    const bg = manifest['background'] as Record<string, unknown>;
    expect(bg).toBeDefined();
    expect(typeof bg['service_worker']).toBe('string');
    expect((bg['service_worker'] as string).length).toBeGreaterThan(0);
  });
});
