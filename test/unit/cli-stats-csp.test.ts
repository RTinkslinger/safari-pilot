import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', '..', 'dist', 'cli', 'stats.js');

function runCli(traceContent: string, args: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp-stats-csp-'));
  const tracePath = join(dir, 'trace.ndjson');
  writeFileSync(tracePath, traceContent);
  return execSync(
    `HOME="${dir}" SAFARI_PILOT_TRACE_OVERRIDE="${tracePath}" node "${CLI}" ${args}`,
    { encoding: 'utf-8' },
  );
}

describe('stats CLI CSP error code aggregation', () => {
  const sampleTrace = [
    JSON.stringify({
      ts: new Date().toISOString(),
      tool: 'safari_evaluate',
      ok: false,
      error: { code: 'CSP_BLOCKED' },
      domain: 'example.com',
    }),
    JSON.stringify({
      ts: new Date().toISOString(),
      tool: 'safari_evaluate',
      ok: false,
      error: { code: 'CSP_BLOCKED' },
      domain: 'example.com',
    }),
    JSON.stringify({
      ts: new Date().toISOString(),
      tool: 'safari_evaluate',
      ok: false,
      error: { code: 'CSP_HARD_BLOCK' },
      domain: 'google.com',
    }),
    JSON.stringify({
      ts: new Date().toISOString(),
      tool: 'safari_click',
      ok: true,
      domain: 'example.com',
    }),
  ].join('\n');

  it('counts CSP_BLOCKED occurrences and displays the total', () => {
    const out = runCli(sampleTrace, '--by-csp --since all');
    expect(out).toContain('CSP / Trusted Types blocks');
    expect(out).toMatch(/CSP_BLOCKED:\s+2/);
  });

  it('counts CSP_HARD_BLOCK occurrences and displays the total', () => {
    const out = runCli(sampleTrace, '--by-csp --since all');
    expect(out).toMatch(/CSP_HARD_BLOCK:\s+1/);
  });

  it('breaks down CSP_BLOCKED by site', () => {
    const out = runCli(sampleTrace, '--by-csp --since all');
    expect(out).toContain('example.com');
    // example.com row should show 2 in CSP_BLOCKED column and 0 in CSP_HARD_BLOCK
    expect(out).toMatch(/example\.com\s+2\s+0/);
  });

  it('breaks down CSP_HARD_BLOCK by site separately from blocked', () => {
    const out = runCli(sampleTrace, '--by-csp --since all');
    // google.com row should show 0 in CSP_BLOCKED column and 1 in CSP_HARD_BLOCK
    expect(out).toMatch(/google\.com\s+0\s+1/);
  });

  it('strips www. prefix when grouping by site', () => {
    const trace = [
      JSON.stringify({
        ts: new Date().toISOString(),
        tool: 'safari_evaluate',
        ok: false,
        error: { code: 'CSP_BLOCKED' },
        domain: 'www.foo.com',
      }),
      JSON.stringify({
        ts: new Date().toISOString(),
        tool: 'safari_evaluate',
        ok: false,
        error: { code: 'CSP_BLOCKED' },
        domain: 'foo.com',
      }),
    ].join('\n');
    const out = runCli(trace, '--by-csp --since all');
    // Both rows should collapse to foo.com with count 2
    expect(out).toMatch(/foo\.com\s+2\s+0/);
    expect(out).not.toMatch(/www\.foo\.com/);
  });

  it('does not crash on missing domain field', () => {
    const trace = JSON.stringify({
      ts: new Date().toISOString(),
      tool: 'safari_evaluate',
      ok: false,
      error: { code: 'CSP_BLOCKED' },
    });
    expect(() => runCli(trace, '--by-csp --since all')).not.toThrow();
  });

  it('omits the CSP section when no CSP errors are present', () => {
    const trace = JSON.stringify({
      ts: new Date().toISOString(),
      tool: 'safari_navigate',
      ok: true,
      domain: 'example.com',
    });
    const out = runCli(trace, '--by-csp --since all');
    expect(out).not.toContain('CSP / Trusted Types blocks');
  });
});
