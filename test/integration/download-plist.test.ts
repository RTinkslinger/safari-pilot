import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const HOME = process.env['HOME'] ?? '';

describe.skipIf(process.env.CI === 'true')('Downloads.plist integration', () => {
  const plistPath = join(HOME, 'Library/Safari/Downloads.plist');

  it('reads Downloads.plist via python3 plistlib', async () => {
    const { stdout } = await execFileAsync('python3', [
      '-c',
      `import plistlib,json,sys
with open(sys.argv[1],'rb') as f:d=plistlib.load(f)
h=d.get('DownloadHistory',[])
for e in h:
 for k in list(e):
  if isinstance(e[k],(bytes,bytearray)):del e[k]
print(json.dumps(h,default=str))`,
      plistPath,
    ]);
    const data = JSON.parse(stdout);
    expect(Array.isArray(data)).toBe(true);
  });

  it('reads plist file mtime for change detection', async () => {
    const s = await stat(plistPath);
    expect(s.mtimeMs).toBeGreaterThan(0);
  });

  it('resolves download directory from Safari prefs', async () => {
    let dir: string;
    try {
      const { stdout } = await execFileAsync('defaults', ['read', 'com.apple.Safari', 'DownloadsPath']);
      dir = stdout.trim().replace(/^~/, HOME);
    } catch {
      dir = join(HOME, 'Downloads');
    }
    const dirStat = await stat(dir);
    expect(dirStat.isDirectory()).toBe(true);
  });
});

describe.skipIf(process.env.CI === 'true')('File metadata integration', () => {
  it('reads MIME type via file command', async () => {
    // Use a fixture file we know exists
    const testFile = join(process.cwd(), 'benchmark/fixtures/downloads/small-file.txt');
    const { stdout } = await execFileAsync('file', ['--mime-type', '-b', testFile]);
    expect(stdout.trim()).toContain('text/');
  });

  it('reads MIME type for binary file', async () => {
    const testFile = join(process.cwd(), 'benchmark/fixtures/downloads/medium-file.bin');
    const { stdout } = await execFileAsync('file', ['--mime-type', '-b', testFile]);
    expect(stdout.trim()).toBeTruthy();
  });
});
