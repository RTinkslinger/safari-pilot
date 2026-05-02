/**
 * Phase 5A · 5A.2 — Download API parity: saveAs post-process.
 *
 * Playwright's Download surface includes `download.saveAs(path)`. Safari Pilot's
 * `safari_wait_for_download` currently returns metadata pointing into ~/Downloads
 * with no way to redirect or rename. This test pins the contract for the new
 * `saveAs` parameter:
 *
 *   - When provided, the completed download is COPIED to the target path.
 *   - The returned metadata reflects the new location (path, filename).
 *   - Source file is NOT moved (kept in ~/Downloads — Safari may still be
 *     tracking it; moving could destabilize Safari's download list).
 *   - Parent directories are created if missing.
 *   - Source-missing is a typed error, not a silent no-op.
 *
 * Pure fs/path logic — Chicago-school: real filesystem, real paths, no mocks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySaveAs } from '../../../src/tools/downloads.js';
import { ERROR_CODES, SafariPilotError } from '../../../src/errors.js';

describe('5A.2 — applySaveAs (download saveAs post-process)', () => {
  let workDir: string;
  let sourceFile: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sp-5a2-'));
    sourceFile = join(workDir, 'incoming.bin');
    writeFileSync(sourceFile, 'binary-payload-bytes');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns metadata unchanged when saveAs is undefined', async () => {
    const metadata = {
      filename: 'incoming.bin',
      path: sourceFile,
      url: 'https://example.com/incoming.bin',
      size: 20,
      mimeType: 'application/octet-stream' as const,
      source: 'plist_poll' as const,
    };
    const result = await applySaveAs(metadata, undefined);
    expect(result).toBe(metadata);
    // File still at original location, not duplicated
    expect(existsSync(sourceFile)).toBe(true);
  });

  it('copies the file to saveAs target path and updates metadata.path', async () => {
    const target = join(workDir, 'renamed.bin');
    const metadata = {
      filename: 'incoming.bin', path: sourceFile,
      url: 'https://example.com/incoming.bin', size: 20,
      mimeType: undefined, source: 'plist_poll' as const,
    };

    const result = await applySaveAs(metadata, target);

    // File now at target — copied, not moved (source still exists)
    expect(existsSync(target)).toBe(true);
    expect(existsSync(sourceFile)).toBe(true);
    // Bytes match — not just an empty file
    expect(readFileSync(target, 'utf-8')).toBe('binary-payload-bytes');
    // Metadata reflects new location
    expect(result.path).toBe(target);
    expect(result.filename).toBe('renamed.bin');
  });

  it('creates parent directories if they do not exist', async () => {
    const target = join(workDir, 'nested', 'subdir', 'output.bin');
    const metadata = {
      filename: 'incoming.bin', path: sourceFile, url: undefined,
      size: 20, mimeType: undefined, source: 'plist_poll' as const,
    };

    await applySaveAs(metadata, target);

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('binary-payload-bytes');
  });

  it('preserves byte-equality for binary content (not just text)', async () => {
    // A real download could be PDF/PNG/zip with non-UTF8 bytes. The copy must
    // be byte-faithful — a bug that round-trips through UTF-8 would corrupt
    // binaries silently. Use a byte sequence that's invalid UTF-8 to detect.
    const binaryPayload = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28]);
    writeFileSync(sourceFile, binaryPayload);
    const target = join(workDir, 'binary.dat');
    const metadata = {
      filename: 'incoming.bin', path: sourceFile, url: undefined,
      size: 6, mimeType: undefined, source: 'plist_poll' as const,
    };

    await applySaveAs(metadata, target);

    const copied = readFileSync(target);
    expect(copied.equals(binaryPayload)).toBe(true);
  });

  it('throws DOWNLOAD_SOURCE_MISSING (typed SafariPilotError, not generic) when source file is missing', async () => {
    const metadata = {
      filename: 'incoming.bin',
      path: join(workDir, 'does-not-exist.bin'),
      url: undefined, size: 0, mimeType: undefined,
      source: 'plist_poll' as const,
    };
    const target = join(workDir, 'target.bin');

    let caught: unknown = null;
    try { await applySaveAs(metadata, target); } catch (e) { caught = e; }

    // The codebase's error contract (src/errors.ts) requires SafariPilotError
    // subclasses with a `code` property pulled from ERROR_CODES — that's what
    // formatToolError() lifts into the MCP error shape callers consume.
    // A bare `throw new Error('not exist')` would satisfy a message regex but
    // gives MCP callers no programmatic hook to distinguish source-missing
    // from a copy-permission failure (EACCES on the target dir, e.g.).
    expect(caught).toBeInstanceOf(SafariPilotError);
    expect((caught as SafariPilotError).code).toBe(ERROR_CODES.DOWNLOAD_SOURCE_MISSING);
  });

  it('does not delete the source file (Safari may still reference it)', async () => {
    // Litmus: a misimpl using rename() instead of copyFile() would unhook the
    // file from ~/Downloads, breaking Safari's UI tracking. The contract is COPY.
    const target = join(workDir, 'kept-original.bin');
    const metadata = {
      filename: 'incoming.bin', path: sourceFile, url: undefined,
      size: 20, mimeType: undefined, source: 'plist_poll' as const,
    };

    await applySaveAs(metadata, target);
    expect(existsSync(sourceFile)).toBe(true);
  });

  it('overwrites an existing target file rather than failing', async () => {
    // Without overwrite semantics, an agent retrying a flow gets a confusing
    // EEXIST. Playwright's saveAs overwrites. Match that surface.
    const target = join(workDir, 'preexisting.bin');
    writeFileSync(target, 'OLD CONTENT');
    const metadata = {
      filename: 'incoming.bin', path: sourceFile, url: undefined,
      size: 20, mimeType: undefined, source: 'plist_poll' as const,
    };

    await applySaveAs(metadata, target);

    expect(readFileSync(target, 'utf-8')).toBe('binary-payload-bytes');
  });
});
