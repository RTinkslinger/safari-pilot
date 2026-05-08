import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli', 'stats.js');

describe('stats CLI time window', () => {
  it('--since 7d filters out records older than 7 days', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-stats-'));
    const tracePath = join(dir, 'trace.ndjson');
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    const recent = new Date().toISOString();
    writeFileSync(
      tracePath,
      [
        JSON.stringify({ ts: old, tool: 'safari_navigate', ok: true, elapsed_ms: 100 }),
        JSON.stringify({ ts: recent, tool: 'safari_navigate', ok: true, elapsed_ms: 100 }),
      ].join('\n'),
    );
    const out = execSync(
      `SAFARI_PILOT_TRACE_OVERRIDE="${tracePath}" node "${CLI}" --since 7d --json`,
      { encoding: 'utf-8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.recordCount).toBe(1);
  });

  it('--since all returns all records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-stats-'));
    const tracePath = join(dir, 'trace.ndjson');
    const old = new Date(Date.now() - 30 * 86400_000).toISOString();
    writeFileSync(
      tracePath,
      JSON.stringify({ ts: old, tool: 'safari_navigate', ok: true, elapsed_ms: 100 }),
    );
    const out = execSync(
      `SAFARI_PILOT_TRACE_OVERRIDE="${tracePath}" node "${CLI}" --since all --json`,
      { encoding: 'utf-8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.recordCount).toBe(1);
  });
});
