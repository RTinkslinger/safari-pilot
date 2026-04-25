/**
 * Canary — release tarball ships every file the three install personas need.
 *
 * SD-15 lifecycle test (canary half): walk `npm pack --dry-run --json` to
 * enumerate exactly what npm would publish, then assert each persona's
 * critical paths are present. This is heavier than the static-config canaries
 * (T3 preuninstall.test.ts, T4 release-universal-binary.test.ts) but lighter
 * than a full sandboxed install — we exercise npm's real packing pipeline
 * (honors `files`, `.npmignore`, etc.) without writing the tarball to disk.
 *
 * Discrimination targets:
 *   - Drop `bin/` from `package.json` `files` → npm user (Path 1) would
 *     download a tarball without the pre-built daemon → postinstall would
 *     fall through to the GitHub Release fetch (slow + offline-fragile).
 *     This test fails immediately.
 *   - Drop `scripts/` → postinstall.sh missing → npm install can't wire the
 *     LaunchAgent at all.
 *   - Drop `dist/` → the actual MCP server source is missing → daemon stub
 *     starts but exposes nothing.
 *   - Drop the LaunchAgent plist → install path can't register the agent.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dir, '..', '..');

interface PackedFile {
  path: string;
  size: number;
  mode: number;
}
interface NpmPackOutput {
  name: string;
  version: string;
  filename: string;
  files: PackedFile[];
  entryCount: number;
}

function runNpmPackDryRun(): NpmPackOutput {
  // --dry-run + --json: npm enumerates every file it WOULD ship without
  // creating the tarball on disk. Honors `files` in package.json, plus
  // .npmignore. This is the source of truth for what `npm publish` will
  // upload.
  const out = execSync('npm pack --dry-run --json', {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const parsed = JSON.parse(out) as NpmPackOutput[];
  expect(parsed.length, 'npm pack --dry-run --json must return exactly one entry').toBe(1);
  return parsed[0]!;
}

describe('Canary: release tarball lifecycle (SD-15)', () => {
  // Reviewer ADVISORY (SD-15): cache the npm pack output across all 8 tests.
  // npm pack --dry-run is pure relative to source state — running it 8 times
  // produces identical output and burns ~14s. beforeAll runs it once;
  // per-test independence is preserved at the assertion level.
  let pkg: NpmPackOutput;
  let paths: string[];
  beforeAll(() => {
    pkg = runNpmPackDryRun();
    paths = pkg.files.map((f) => f.path);
  });

  it('npm pack ships the universal daemon binary at bin/SafariPilotd', () => {
    // Persona 1 (npm user): postinstall reads bin/SafariPilotd directly.
    // Without it, install falls through to the GitHub Release fetch path,
    // which fails when the network or the release asset is unavailable.
    expect(paths, 'bin/SafariPilotd must ship in the npm tarball').toContain('bin/SafariPilotd');

    const binary = pkg.files.find((f) => f.path === 'bin/SafariPilotd')!;
    // Defense in depth: the binary must actually have content. A 0-byte
    // file would technically satisfy "is included" but ships a broken
    // daemon. The universal binary is several MB; lock the lower bound
    // generously.
    expect(binary.size, 'bin/SafariPilotd must not be empty (zero-byte placeholder)')
      .toBeGreaterThan(1024 * 1024);
  });

  it('npm pack ships the postinstall + preuninstall scripts (Path 1 + Path 2 wiring)', () => {
    // postinstall.sh installs the LaunchAgent for npm users (Path 1) and
    // git-clone users (Path 2 — falls through to GitHub Release fetch when
    // the binary isn't in the npm tarball). preuninstall.sh tears it down.
    expect(paths, 'scripts/postinstall.sh must ship to wire the LaunchAgent').toContain(
      'scripts/postinstall.sh',
    );
    expect(paths, 'scripts/preuninstall.sh must ship to tear down the LaunchAgent').toContain(
      'scripts/preuninstall.sh',
    );
  });

  it('npm pack ships the LaunchAgent plist template', () => {
    // The plist is what postinstall.sh symlinks into ~/Library/LaunchAgents.
    // Missing → install completes silently with no daemon registration.
    expect(
      paths,
      'daemon/com.safari-pilot.daemon.plist must ship for LaunchAgent registration',
    ).toContain('daemon/com.safari-pilot.daemon.plist');
  });

  it('npm pack ships the compiled MCP server in dist/', () => {
    // The actual TypeScript compiles to dist/. Without dist/index.js, the
    // npm-installed package can't start the MCP server at all. README and
    // .mcp.json are no help if the JS isn't there.
    const distFiles = paths.filter((p) => p.startsWith('dist/'));
    expect(distFiles.length, 'dist/ must contain compiled artifacts').toBeGreaterThan(0);
    expect(paths, 'dist/index.js (entry point) must ship').toContain('dist/index.js');
    expect(paths, 'dist/server.js must ship').toContain('dist/server.js');
  });

  it('npm pack ships the .mcp.json + safari-pilot.config.json + plugin metadata', () => {
    // .mcp.json is what Claude Code reads to discover the MCP server.
    // safari-pilot.config.json is the runtime config. Plugin metadata is
    // what the Claude Code plugin loader expects.
    expect(paths).toContain('.mcp.json');
    expect(paths).toContain('safari-pilot.config.json');
    expect(paths).toContain('.claude-plugin/plugin.json');
  });

  it('npm pack ships the extension assets so Path 1 can install Safari Pilot.app', () => {
    // Path 1 (npm user): postinstall finds bin/Safari Pilot.app and opens it
    // to register with Safari. Without it, the extension doesn't get
    // installed even when the daemon does.
    // The .app is a directory tree; assert at least one file inside it.
    const appFiles = paths.filter((p) => p.startsWith('bin/Safari Pilot.app/'));
    expect(
      appFiles.length,
      'bin/Safari Pilot.app/* must ship for Path 1 extension installation; ' +
        'got 0 entries — the .app directory was excluded',
    ).toBeGreaterThan(0);
  });

  it('npm pack does NOT ship developer-only artifacts (test/, src/, daemon/Sources/)', () => {
    // Negative form: dev sources should NOT bloat the tarball. The build
    // outputs (dist/, bin/) are what users get.

    expect(
      paths.filter((p) => p.startsWith('test/')),
      'test/ must NOT ship to npm consumers',
    ).toEqual([]);
    expect(
      paths.filter((p) => p.startsWith('src/')),
      'src/ (TS sources) must NOT ship — dist/ is the artifact',
    ).toEqual([]);
    expect(
      paths.filter((p) => p.startsWith('daemon/Sources/')),
      'daemon/Sources/ (Swift sources) must NOT ship — bin/SafariPilotd is the artifact',
    ).toEqual([]);
    expect(
      paths.filter((p) => p.startsWith('daemon/Tests/')),
      'daemon/Tests/ must NOT ship',
    ).toEqual([]);
  });

  it('npm pack name + version match package.json (sanity check)', () => {
    // Locks the metadata that npm uses to generate the GitHub Release
    // tarball URL — postinstall.sh's tier-3 fallback for git-clone users
    // depends on this URL being stable.
    const pkgJson = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
    );
    expect(pkg.name).toBe(pkgJson.name);
    expect(pkg.version).toBe(pkgJson.version);
    // Filename convention: <name>-<version>.tgz, lowercase, no scope here.
    expect(pkg.filename).toBe(`safari-pilot-${pkgJson.version}.tgz`);
  });
});
