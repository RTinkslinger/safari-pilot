/**
 * Canary — npm tarball ships universal daemon binary
 *
 * Verifies release.yml wires the universal binary into the npm tarball.
 * Without this, `npm ci`'s postinstall in CI populates bin/SafariPilotd with
 * an arm64-only swift build, and `npm publish` ships that — Intel Mac users
 * get a binary that won't run.
 *
 * The actual arch verification must happen in CI (the `file` check step) —
 * we can't reproduce the full CI pipeline locally. This canary guards the
 * release.yml config from accidental regression.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dir, '..', '..');
const RELEASE_YML = join(REPO_ROOT, '.github', 'workflows', 'release.yml');

function readRelease(): string {
  return readFileSync(RELEASE_YML, 'utf-8');
}

describe('Canary: release pipeline ships universal binary', () => {
  // The actual `run: npm publish` line — distinct from step-name / comment
  // mentions of "npm publish" which don't execute anything.
  const PUBLISH_EXEC_RE = /run:\s*npm\s+publish\b/;

  it('T4: release.yml copies dist-bin/SafariPilotd into bin/ before npm publish', () => {
    const body = readRelease();

    const copyMatch = body.match(/cp\s+dist-bin\/SafariPilotd\s+bin\/SafariPilotd/);
    expect(copyMatch, 'release.yml must copy the universal binary from dist-bin/ to bin/ before publishing').not.toBeNull();

    const copyIdx = body.indexOf('cp dist-bin/SafariPilotd bin/SafariPilotd');
    const publishMatch = PUBLISH_EXEC_RE.exec(body);
    expect(publishMatch, 'release.yml must contain an `npm publish` execution line').not.toBeNull();
    expect(copyIdx).toBeGreaterThan(-1);
    expect(copyIdx).toBeLessThan(publishMatch!.index);
  });

  it('T4: release.yml verifies bin/SafariPilotd is a universal Mach-O binary before publishing', () => {
    const body = readRelease();

    // Must run `file` against bin/SafariPilotd
    expect(body).toMatch(/file\s+bin\/SafariPilotd/);
    // Must assert universal binary and 2 architectures (so neither arm64-only
    // nor x86_64-only slips through)
    expect(body).toMatch(/Mach-O universal binary/);
    expect(body).toMatch(/2 architectures/);

    // The verification `grep` must appear before the actual publish execution
    const grepIdx = body.indexOf('grep -q "Mach-O universal binary"');
    const publishMatch = PUBLISH_EXEC_RE.exec(body);
    expect(grepIdx).toBeGreaterThan(-1);
    expect(publishMatch).not.toBeNull();
    expect(grepIdx).toBeLessThan(publishMatch!.index);
  });

  it('T4: release.yml still uploads the universal tarball to GitHub Release', () => {
    // postinstall's tier-3 fallback downloads from this URL for git-clone users.
    // Regressions that remove the tarball would silently break the fallback.
    const body = readRelease();
    expect(body).toMatch(/SafariPilotd-universal\.tar\.gz/);
  });
});
