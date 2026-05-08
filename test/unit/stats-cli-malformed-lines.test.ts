import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli', 'stats.js');

describe('stats CLI malformed-line resilience', () => {
  it('skips malformed JSON lines without crashing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sp-stats-'));
    const tracePath = join(dir, 'trace.ndjson');
    writeFileSync(
      tracePath,
      [
        JSON.stringify({ ts: new Date().toISOString(), tool: 'safari_navigate', ok: true, elapsed_ms: 100 }),
        '{ this is not valid json',
        '',
        JSON.stringify({ ts: new Date().toISOString(), tool: 'safari_get_text', ok: true, elapsed_ms: 50 }),
      ].join('\n'),
    );
    const out = execSync(
      `SAFARI_PILOT_TRACE_OVERRIDE="${tracePath}" node "${CLI}" --since all --json`,
      { encoding: 'utf-8' },
    );
    const parsed = JSON.parse(out);
    expect(parsed.recordCount).toBe(2); // 2 valid, 1 malformed skipped, 1 empty skipped
  });
});
