/**
 * Phase 5A · 5A.1 — mimeFromExtension: pure helper.
 *
 * Coverage policy (per spec): web-common types only. Long-tail uncommon
 * types fall back to application/octet-stream with mimeFallback: true,
 * letting the agent override via mimeOverrides.
 */
import { describe, it, expect } from 'vitest';
import { mimeFromExtension } from '../../../src/tools/mime.js';

describe('5A.1 — mimeFromExtension', () => {
  it('returns canonical types for common web extensions', () => {
    expect(mimeFromExtension('resume.pdf')).toEqual({ mimeType: 'application/pdf', fallback: false });
    expect(mimeFromExtension('photo.png')).toEqual({ mimeType: 'image/png', fallback: false });
    expect(mimeFromExtension('photo.jpg')).toEqual({ mimeType: 'image/jpeg', fallback: false });
    expect(mimeFromExtension('photo.jpeg')).toEqual({ mimeType: 'image/jpeg', fallback: false });
    expect(mimeFromExtension('data.json')).toEqual({ mimeType: 'application/json', fallback: false });
    expect(mimeFromExtension('data.csv')).toEqual({ mimeType: 'text/csv', fallback: false });
    expect(mimeFromExtension('archive.zip')).toEqual({ mimeType: 'application/zip', fallback: false });
    expect(mimeFromExtension('page.html')).toEqual({ mimeType: 'text/html', fallback: false });
    expect(mimeFromExtension('notes.txt')).toEqual({ mimeType: 'text/plain', fallback: false });
  });

  it('is case-insensitive on the extension', () => {
    expect(mimeFromExtension('REPORT.PDF')).toEqual({ mimeType: 'application/pdf', fallback: false });
    expect(mimeFromExtension('PHOTO.JPG')).toEqual({ mimeType: 'image/jpeg', fallback: false });
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(mimeFromExtension('foo.parquet')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
    expect(mimeFromExtension('foo.heic')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
  });

  it('falls back for files with no extension', () => {
    expect(mimeFromExtension('Makefile')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
    expect(mimeFromExtension('README')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
  });

  it('falls back for dotfiles (no real extension)', () => {
    expect(mimeFromExtension('.bashrc')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
    expect(mimeFromExtension('.gitignore')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
  });

  it('handles UTF-8 file names (extension lookup operates on the dot-suffix only)', () => {
    expect(mimeFromExtension('简历.pdf')).toEqual({ mimeType: 'application/pdf', fallback: false });
    expect(mimeFromExtension('résumé.PDF')).toEqual({ mimeType: 'application/pdf', fallback: false });
  });

  it('handles paths with directories — only the basename matters', () => {
    expect(mimeFromExtension('/Users/me/Downloads/x.pdf')).toEqual({ mimeType: 'application/pdf', fallback: false });
    expect(mimeFromExtension('relative/foo.png')).toEqual({ mimeType: 'image/png', fallback: false });
  });

  it('handles double-extension files (uses the LAST extension)', () => {
    expect(mimeFromExtension('archive.tar.gz')).toEqual({ mimeType: 'application/gzip', fallback: false });
    expect(mimeFromExtension('foo.json.bak')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
  });
});
