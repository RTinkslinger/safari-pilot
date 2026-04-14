/**
 * Integration tests for PDF generation — real daemon binary, real PDF files.
 *
 * Spawns the actual SafariPilotd binary via DaemonEngine, sends `generate_pdf`
 * commands, and verifies real PDF files on disk. NO MOCKS.
 *
 * Skip condition: daemon binary must exist at bin/SafariPilotd.
 *
 * KNOWN BUG: The daemon's NSPrintOperation.run() for WKWebView enters an
 * infinite page spool loop when generating PDFs from HTML. The print operation
 * never terminates, producing a continuously growing output file. Tests 1 and 2
 * will fail with TIMEOUT until PdfGenerator.swift is fixed — likely by
 * replacing NSPrintOperation with WKWebView.createPDF(configuration:).
 * The error-path test (test 3) works correctly because it fails at init
 * validation before reaching the print operation.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { DaemonEngine } from '../../src/engines/daemon.js';
import { existsSync } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const DAEMON_PATH = resolve(ROOT, 'bin/SafariPilotd');
const DAEMON_AVAILABLE = existsSync(DAEMON_PATH);

/** Unique temp file path for a test PDF, avoiding collisions. */
function tempPdfPath(label: string): string {
  return join(tmpdir(), `sp-test-pdf-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
}

// ── Error path tests (daemon init-time validation) ──────────────────────────
// These tests pass because the errors are caught before NSPrintOperation runs.

describe.skipIf(!DAEMON_AVAILABLE)('PDF generation — error paths', () => {
  let daemon: DaemonEngine;

  afterAll(async () => {
    if (daemon) await daemon.shutdown();
  });

  it('returns error for invalid output path', async () => {
    daemon = new DaemonEngine({ daemonPath: DAEMON_PATH, timeoutMs: 15_000 });
    const available = await daemon.isAvailable();
    expect(available).toBe(true);

    const result = await daemon.command('generate_pdf', {
      html: '<html><body><p>Should fail</p></body></html>',
      outputPath: '/nonexistent/dir/output.pdf',
      paperWidth: 612,
      paperHeight: 792,
      marginTop: 72,
      marginRight: 72,
      marginBottom: 72,
      marginLeft: 72,
      scale: 1.0,
      landscape: false,
      printBackground: false,
      fontWaitTimeout: 3000,
    }, 10_000);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error!.code).toBe('INVALID_OUTPUT_PATH');
    expect(result.error!.message).toContain('does not exist');
  }, 20_000);

  it('returns error when missing both html and url', async () => {
    // Reuse daemon from previous test (it should still be healthy)
    const result = await daemon.command('generate_pdf', {
      outputPath: '/tmp/sp-test-missing-content.pdf',
      paperWidth: 612,
      paperHeight: 792,
    }, 10_000);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error!.code).toBe('INVALID_OUTPUT_PATH');
    expect(result.error!.message).toContain('html');
  }, 15_000);

  it('returns error when missing outputPath', async () => {
    const result = await daemon.command('generate_pdf', {
      html: '<html><body>test</body></html>',
      paperWidth: 612,
      paperHeight: 792,
    }, 10_000);

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error!.code).toBe('INVALID_OUTPUT_PATH');
    expect(result.error!.message).toContain('outputPath');
  }, 15_000);
});

// ── Happy path tests (actual PDF generation) ────────────────────────────────
// Each test gets its own daemon instance because NSPrintOperation.run() hangs
// (infinite spool bug), leaving the daemon unresponsive. Isolating each test
// ensures one stuck daemon doesn't cascade-fail subsequent tests.

describe.skipIf(!DAEMON_AVAILABLE)('PDF generation — happy path', () => {
  const outputFiles: string[] = [];
  let daemon: DaemonEngine | null = null;

  afterEach(async () => {
    // Force-shutdown daemon after each test to prevent stuck processes
    if (daemon) {
      await daemon.shutdown();
      daemon = null;
    }
  });

  afterAll(async () => {
    // Clean up any generated PDF files
    for (const f of outputFiles) {
      try { await unlink(f); } catch { /* ignore */ }
    }
  });

  it('generates PDF from HTML string with correct output', async () => {
    const outputPath = tempPdfPath('html-basic');
    outputFiles.push(outputPath);

    daemon = new DaemonEngine({ daemonPath: DAEMON_PATH, timeoutMs: 60_000 });
    const available = await daemon.isAvailable();
    expect(available).toBe(true);

    const result = await daemon.command('generate_pdf', {
      html: '<html><head><title>Test PDF</title></head><body><h1>Hello, Safari Pilot</h1><p>This is a test PDF generated from an HTML string.</p></body></html>',
      outputPath,
      paperWidth: 612,    // Letter width in points
      paperHeight: 792,   // Letter height in points
      marginTop: 72,
      marginRight: 72,
      marginBottom: 72,
      marginLeft: 72,
      scale: 1.0,
      landscape: false,
      printBackground: false,
      fontWaitTimeout: 3000,
    }, 60_000);

    // Response structure
    expect(result.ok).toBe(true);
    expect(result.value).toBeTruthy();

    const parsed = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;

    // value.path matches what we requested
    expect(parsed.path).toBe(outputPath);

    // Page count must be positive
    expect(parsed.pageCount).toBeGreaterThan(0);

    // File size must be positive
    expect(parsed.fileSize).toBeGreaterThan(0);

    // File actually exists on disk
    const fileStat = await stat(outputPath);
    expect(fileStat.size).toBeGreaterThan(0);

    // First 5 bytes are %PDF- (the PDF magic bytes)
    const buffer = await readFile(outputPath);
    const magic = buffer.subarray(0, 5).toString('ascii');
    expect(magic).toBe('%PDF-');
  }, 90_000);

  it('A4 produces different dimensions than Letter for same HTML', async () => {
    const html = '<html><body><h1>Paper Size Test</h1><p>Comparing Letter vs A4 output.</p></body></html>';

    // We need two sequential daemon invocations.
    // Due to the infinite spool bug, if the first one hangs, we can't
    // reuse the daemon for the second. Use a fresh daemon for each.
    daemon = new DaemonEngine({ daemonPath: DAEMON_PATH, timeoutMs: 60_000 });
    const available = await daemon.isAvailable();
    expect(available).toBe(true);

    // Letter: 612 x 792 points (8.5 x 11 inches)
    const letterPath = tempPdfPath('letter');
    outputFiles.push(letterPath);

    const letterResult = await daemon.command('generate_pdf', {
      html,
      outputPath: letterPath,
      paperWidth: 612,
      paperHeight: 792,
      marginTop: 72,
      marginRight: 72,
      marginBottom: 72,
      marginLeft: 72,
      scale: 1.0,
      landscape: false,
      printBackground: false,
      fontWaitTimeout: 3000,
    }, 60_000);

    expect(letterResult.ok).toBe(true);

    // Shut down and start a fresh daemon for the A4 test
    await daemon.shutdown();
    daemon = new DaemonEngine({ daemonPath: DAEMON_PATH, timeoutMs: 60_000 });
    const avail2 = await daemon.isAvailable();
    expect(avail2).toBe(true);

    // A4: 595.28 x 841.89 points (210 x 297 mm)
    const a4Path = tempPdfPath('a4');
    outputFiles.push(a4Path);

    const a4Result = await daemon.command('generate_pdf', {
      html,
      outputPath: a4Path,
      paperWidth: 595.28,
      paperHeight: 841.89,
      marginTop: 72,
      marginRight: 72,
      marginBottom: 72,
      marginLeft: 72,
      scale: 1.0,
      landscape: false,
      printBackground: false,
      fontWaitTimeout: 3000,
    }, 60_000);

    expect(a4Result.ok).toBe(true);

    // Both must be valid PDFs
    const letterStat = await stat(letterPath);
    const a4Stat = await stat(a4Path);

    expect(letterStat.size).toBeGreaterThan(0);
    expect(a4Stat.size).toBeGreaterThan(0);

    // Both must have %PDF- magic
    const letterBuf = await readFile(letterPath);
    const a4Buf = await readFile(a4Path);
    expect(letterBuf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(a4Buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    // Parse responses to verify page counts
    const letterParsed = typeof letterResult.value === 'string'
      ? JSON.parse(letterResult.value)
      : letterResult.value;
    const a4Parsed = typeof a4Result.value === 'string'
      ? JSON.parse(a4Result.value)
      : a4Result.value;

    expect(letterParsed.pageCount).toBeGreaterThan(0);
    expect(a4Parsed.pageCount).toBeGreaterThan(0);

    // File sizes should differ because different paper dimensions produce
    // different PDF page media boxes and content layout
    expect(letterStat.size).not.toBe(a4Stat.size);

    console.log(`Letter: ${letterStat.size} bytes, ${letterParsed.pageCount} page(s)`);
    console.log(`A4:     ${a4Stat.size} bytes, ${a4Parsed.pageCount} page(s)`);
  }, 180_000);
});
