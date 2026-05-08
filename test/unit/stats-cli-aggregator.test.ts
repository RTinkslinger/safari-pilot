import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli', 'stats.js');

function runCli(traceContent: string, args: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp-stats-'));
  const tracePath = join(dir, 'trace.ndjson');
  writeFileSync(tracePath, traceContent);
  return execSync(
    `HOME="${dir}" SAFARI_PILOT_TRACE_OVERRIDE="${tracePath}" node "${CLI}" ${args}`,
    { encoding: 'utf-8' },
  );
}

describe('stats CLI aggregator', () => {
  it('counts records by tool', () => {
    const trace = [
      JSON.stringify({ ts: new Date().toISOString(), tool: 'safari_navigate', ok: true, elapsed_ms: 100 }),
      JSON.stringify({ ts: new Date().toISOString(), tool: 'safari_navigate', ok: true, elapsed_ms: 200 }),
      JSON.stringify({ ts: new Date().toISOString(), tool: 'safari_get_text', ok: true, elapsed_ms: 50 }),
    ].join('\n');
    const out = runCli(trace, '--by-tool --json');
    const parsed = JSON.parse(out);
    expect(parsed.recordCount).toBe(3);
  });

  it('aggregates errors by code', () => {
    const trace = [
      JSON.stringify({ ts: new Date().toISOString(), tool: 'safari_scroll_to_element', ok: false, error: { code: 'TARGET_NOT_FOUND' } }),
      JSON.stringify({ ts: new Date().toISOString(), tool: 'safari_scroll_to_element', ok: false, error: { code: 'TARGET_NOT_FOUND' } }),
    ].join('\n');
    const out = runCli(trace, '--by-error --since all');
    expect(out).toContain('TARGET_NOT_FOUND');
    expect(out).toContain('safari_scroll_to_element');
  });
});
