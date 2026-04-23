/**
 * Canary — npm uninstall lifecycle
 *
 * Verifies the shipped npm package cleans up after itself. Without a
 * `preuninstall` hook, `npm uninstall safari-pilot` leaves the LaunchAgent
 * loaded and the daemon continuously restarting via KeepAlive — forever.
 *
 * These tests check the distribution artifacts, not running state, so they
 * don't actually uninstall the developer's own daemon.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dir, '..', '..');

interface PackageJson {
  scripts?: Record<string, string>;
  files?: string[];
}

describe('Canary: npm uninstall lifecycle', () => {
  it('T3: package.json wires preuninstall to scripts/preuninstall.sh', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as PackageJson;
    expect(pkg.scripts, 'package.json must declare scripts').toBeDefined();
    expect(pkg.scripts!['preuninstall'], 'preuninstall hook must be declared so `npm uninstall` runs cleanup').toBeDefined();
    expect(pkg.scripts!['preuninstall']).toMatch(/scripts\/preuninstall\.sh/);
  });

  it('T3: scripts/preuninstall.sh exists and is executable', () => {
    const scriptPath = join(REPO_ROOT, 'scripts', 'preuninstall.sh');
    expect(existsSync(scriptPath), 'preuninstall.sh must exist in the repo').toBe(true);
    const mode = statSync(scriptPath).mode & 0o777;
    // Owner-executable bit — required for `bash scripts/preuninstall.sh` to work via the
    // shebang (npm runs the script via `bash` so exec bit isn't strictly required by npm,
    // but a non-executable shipped script is a code smell and fails `sh` invocation).
    expect(mode & 0o100, `preuninstall.sh mode is ${mode.toString(8)} — must be owner-executable`).toBeTruthy();
  });

  it('T3: scripts/preuninstall.sh unloads the daemon LaunchAgent', () => {
    // Static content check — the script must handle the LaunchAgent unload.
    // Heavier canary (actual uninstall + verify launchctl) would be destructive
    // to the developer's machine, so this is the safe surrogate.
    const body = readFileSync(join(REPO_ROOT, 'scripts', 'preuninstall.sh'), 'utf-8');
    expect(body).toMatch(/launchctl\s+(bootout|unload)/);
    expect(body).toContain('com.safari-pilot.daemon');
  });

  it('T3: scripts/preuninstall.sh is shipped in the npm package `files` list', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as PackageJson;
    // Either `files` includes scripts/, or no `files` field is used (everything ships).
    // When `files` IS used, scripts/ must be covered or `npm uninstall` has nothing to run.
    if (pkg.files && pkg.files.length > 0) {
      const covered = pkg.files.some((entry) =>
        entry === 'scripts' || entry === 'scripts/' || entry.startsWith('scripts/') || entry === '**/*',
      );
      expect(covered, `package.json "files" must include "scripts/" so preuninstall.sh ships. Got: ${JSON.stringify(pkg.files)}`).toBe(true);
    }
  });
});
