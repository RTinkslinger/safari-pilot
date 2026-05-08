import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli', 'stats.js');

describe('stats CLI end-to-end (text output)', () => {
  it('produces expected text output for a sample trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-stats-'));
    const tracePath = join(dir, 'trace.ndjson');
    writeFileSync(
      tracePath,
      [
        JSON.stringify({ ts: new Date().toISOString(), tool: 'safari_navigate', ok: true, elapsed_ms: 100, domain: 'example.com' }),
        JSON.stringify({ ts: new Date().toISOString(), tool: 'safari_navigate', ok: false, error: { code: 'TIMEOUT' }, elapsed_ms: 30000, domain: 'example.com' }),
      ].join('\n'),
    );
    const out = execSync(
      `SAFARI_PILOT_TRACE_OVERRIDE="${tracePath}" node "${CLI}" --since all`,
      { encoding: 'utf-8' },
    );
    expect(out).toContain('Per-tool summary');
    expect(out).toContain('safari_navigate');
    expect(out).toContain('Top errors');
    expect(out).toContain('TIMEOUT');
    expect(out).toContain('Top domains');
    expect(out).toContain('example.com');
  });
});
