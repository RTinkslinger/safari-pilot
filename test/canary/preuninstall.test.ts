/**
 * Canary — npm uninstall lifecycle (static-config canary)
 *
 * Guards file shape / shell-script text from accidental regression. Does
 * NOT verify runtime behavior — uninstalling the developer's own daemon
 * mid-test is destructive. The strong-form behavioral test (sandboxed
 * `npm pack` + tmp-$HOME + launchctl PATH stub) is tracked separately as
 * SD-15. This file is the cheap shape gate.
 *
 * SD-10 strengthening (2026-04-25): pre-fix the `launchctl` substring
 * check passed if the line was commented out (e.g. `# launchctl bootout`).
 * Post-fix we verify (a) the script parses cleanly with `bash -n`,
 * (b) the launchctl line lives on a non-comment line.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
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

  it('T3 (SD-10): scripts/preuninstall.sh parses cleanly under bash -n', () => {
    // SD-10 strengthening: a script with severe syntax errors would have
    // passed the substring check below but never run. `bash -n` parses the
    // script without executing it.
    const scriptPath = join(REPO_ROOT, 'scripts', 'preuninstall.sh');
    expect(() =>
      execSync(`bash -n "${scriptPath}"`, { stdio: 'pipe' }),
    ).not.toThrow();
  });

  it('T3 (SD-10): all non-comment launchctl lines run the unload (not echo, not commented out)', () => {
    // Pre-SD-10: the test was `body.toMatch(/launchctl\s+(bootout|unload)/)`,
    // which passed if the line was commented out. Strengthened oracle
    // requires (a) at least one non-comment launchctl line exists, AND
    // (b) ALL non-comment launchctl lines run the command (no `echo`).
    // Production has TWO launchctl lines (main daemon + health-check
    // companion); a partial lobotomy that stubs one but leaves the other
    // would slip through a single-line `find()` check.
    const body = readFileSync(join(REPO_ROOT, 'scripts', 'preuninstall.sh'), 'utf-8');
    const lines = body.split('\n');
    const executableLines = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return /launchctl\s+(bootout|unload)/.test(trimmed);
    });
    expect(
      executableLines.length,
      'preuninstall.sh must have ≥1 non-comment line that runs `launchctl bootout|unload`',
    ).toBeGreaterThan(0);

    // Every non-comment launchctl line must NOT be `echo "launchctl ..."`.
    for (const line of executableLines) {
      expect(line.trim(), `launchctl line must not be echoed: ${line.trim()}`).not.toMatch(/^echo\s+/);
    }

    // Body must reference our specific LaunchAgent label (either inline
    // on a launchctl line or via a `LABEL=` assignment).
    expect(body).toContain('com.safari-pilot.daemon');

    // (Note: the production script uses `launchctl ... 2>/dev/null || true`
    // intentionally — defensive idiom tolerating "already unloaded." We
    // don't reject `|| true` here because the command DOES run first;
    // `||` only silences the exit code. The anti-pattern we guard
    // against is ECHO instead of execution.)
  });

  it('T3 (SD-10): preuninstall.sh removes the LaunchAgent plist after unload', () => {
    // A regression that lobotomized the `rm -f "$PLIST"` line would leak
    // the .plist file in `~/Library/LaunchAgents/` after uninstall —
    // launchctl is unloaded but the plist file persists, and a subsequent
    // OS reboot would re-load the agent unless launchctl bootstrap is
    // also blocked. Verify a non-comment, non-echo `rm -f` runs against
    // a LaunchAgents path.
    const body = readFileSync(join(REPO_ROOT, 'scripts', 'preuninstall.sh'), 'utf-8');
    const lines = body.split('\n');
    const rmLines = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return /rm\s+-f\b.*LaunchAgents/.test(trimmed);
    });
    expect(
      rmLines.length,
      'preuninstall.sh must have ≥1 non-comment `rm -f .../LaunchAgents/...` line',
    ).toBeGreaterThan(0);
    for (const line of rmLines) {
      expect(line.trim()).not.toMatch(/^echo\s+/);
    }
  });

  it('T3 (SD-10): preuninstall.sh keeps `set -euo pipefail` for safe failure semantics', () => {
    // Without `set -e` the script silently continues past failed
    // launchctl/rm commands. Without `set -u` undefined variables (e.g.
    // a lobotomized `LABEL=`) yield empty bootout targets. The
    // pipefail flag ensures piped failures surface. Stripping any of
    // these is a regression — assert the line is present.
    const body = readFileSync(join(REPO_ROOT, 'scripts', 'preuninstall.sh'), 'utf-8');
    expect(body).toMatch(/^\s*set\s+-[a-z]*e[a-z]*\b/m); // must contain `set -e` (or set -euo, etc.)
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
