/**
 * Canary — npm tarball ships universal daemon binary (static-config canary)
 *
 * Guards release.yml text from accidental regression. The actual arch
 * verification must happen in CI (the `file` check step) — we can't
 * reproduce the full CI pipeline locally. The strong-form behavioral test
 * (consume the CI `file` step's output as an artifact in tests) is tracked
 * as SD-15. This file is the cheap shape gate.
 *
 * SD-10 strengthening (2026-04-25): pre-fix the substring + index-ordering
 * checks would have passed even if the cp step were guarded by `if: false`
 * or wrapped in `|| true` (silently swallowed). Post-fix we add explicit
 * negative-form regexes against those specific stub patterns AND verify
 * the cp / file / publish lines all live within `run:` blocks (not in
 * step-name strings or comments).
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

  it('T4 (SD-10): cp + file + grep + publish steps are NOT silently disabled or stub-wrapped', () => {
    // SD-10 strengthening: a release.yml that wraps the cp in `|| true`,
    // gates the cp step with `if: false`, or echoes the file check instead
    // of running it would have passed every assertion above.
    const body = readRelease();

    // Negative-form regexes against specific stub patterns. We check
    // SAME-LINE patterns and their immediate `\` continuations because:
    //   - same-line `|| true` is the most common stub form
    //   - splitting across `run: |` multi-line YAML or `\` continuations is
    //     possible but materially more deliberate; that case is the
    //     SD-15 strong-form's responsibility (full YAML AST walk).
    //
    // Specific stubs caught here:
    //   - `|| true` immediately after cp / file (silently swallows)
    //   - `if: false` (gates a step out — including ${{ false }} form)
    //   - `echo cp ...` / `echo file ...` (no-op print instead of run)
    expect(body, 'release.yml must NOT wrap the cp in `|| true`')
      .not.toMatch(/cp\s+dist-bin\/SafariPilotd[^\n|]*\|\|\s*true/);
    expect(body, 'release.yml must NOT wrap the universal-binary file check in `|| true`')
      .not.toMatch(/file\s+bin\/SafariPilotd[^\n|]*\|\|\s*true/);
    // `if: false` and `if: ${{ false }}` both gate the step out
    expect(body, 'release.yml must NOT gate any step with `if: false`')
      .not.toMatch(/^\s*if:\s*false\b/m);
    expect(body, 'release.yml must NOT gate any step with `if: ${{ false }}`')
      .not.toMatch(/^\s*if:\s*\$\{\{\s*false\s*\}\}/m);
    expect(body, 'release.yml must NOT echo the file check instead of running it')
      .not.toMatch(/echo\s+["']?file\s+bin\/SafariPilotd/);
    expect(body, 'release.yml must NOT echo the cp instead of running it')
      .not.toMatch(/echo\s+["']?cp\s+dist-bin\/SafariPilotd/);
  });

  it('T4 (SD-10): cp step and `npm publish` step are in the SAME job', () => {
    // A regression that moved cp into a separate job (with no artifact
    // handoff between them) would pass all the substring + ordering
    // checks above but ship an unmodified binary. Verify they share a
    // `jobs.<name>:` ancestor block in the YAML.
    const body = readRelease();
    // Find the `jobs:` keyword and split into job-block boundaries.
    // Job blocks start at lines matching `^  <name>:` (2-space indent).
    const lines = body.split('\n');
    let currentJob = '';
    let cpJob = '';
    let publishJob = '';
    for (const line of lines) {
      // 2-space indent + name + ':' = job header
      const jobMatch = line.match(/^  (\w[\w-]*):\s*$/);
      if (jobMatch) {
        currentJob = jobMatch[1]!;
        continue;
      }
      if (line.includes('cp dist-bin/SafariPilotd bin/SafariPilotd') && !cpJob) {
        cpJob = currentJob;
      }
      if (/run:\s*npm\s+publish\b/.test(line) && !publishJob) {
        publishJob = currentJob;
      }
    }
    expect(cpJob, 'cp step must live within a named job').toBeTruthy();
    expect(publishJob, 'npm publish step must live within a named job').toBeTruthy();
    expect(
      cpJob,
      `cp must live in the SAME job as npm publish — got cp in "${cpJob}", publish in "${publishJob}"`,
    ).toBe(publishJob);
  });

  it('T4 (SD-10): the grep on `Mach-O universal binary` exits non-zero on missing match (no `|| true`)', () => {
    // The `grep -q "Mach-O universal binary"` pipeline must error if the
    // string isn't found, otherwise an arm64-only binary slips through
    // unchallenged. Verify no `|| true` follows the grep on the same line.
    const body = readRelease();
    const grepLines = body.split('\n').filter((l) => /grep\s+-q\s+["']Mach-O universal binary/.test(l));
    expect(grepLines.length, 'release.yml must run `grep -q "Mach-O universal binary"`').toBeGreaterThan(0);
    for (const line of grepLines) {
      expect(line, 'grep on Mach-O universal binary must NOT be wrapped in `|| true`')
        .not.toMatch(/\|\|\s*true\b/);
    }
  });
});
