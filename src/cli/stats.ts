#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatTable, p, pct, warnPercentile } from './format.js';

interface TraceRecord {
  ts?: string;
  tool: string;
  ok?: boolean;
  elapsed_ms?: number;
  error?: { code?: string; name?: string };
  domain?: string;
}

interface Args {
  since: string;
  json: boolean;
  byTool: boolean;
  byError: boolean;
  byDomain: boolean;
  byCsp: boolean;
  tail: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    since: '7d',
    json: false,
    byTool: false,
    byError: false,
    byDomain: false,
    byCsp: false,
    tail: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') a.since = argv[++i] || '7d';
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--by-tool') a.byTool = true;
    else if (argv[i] === '--by-error') a.byError = true;
    else if (argv[i] === '--by-domain') a.byDomain = true;
    else if (argv[i] === '--by-csp') a.byCsp = true;
    else if (argv[i] === '--tail') a.tail = true;
  }
  if (!a.byTool && !a.byError && !a.byDomain && !a.byCsp && !a.tail) {
    a.byTool = a.byError = a.byDomain = a.byCsp = true; // default: all sections
  }
  return a;
}

function parseSince(since: string): number {
  if (since === 'all') return 0;
  const m = since.match(/^(\d+)([dh])$/);
  if (!m) throw new Error(`invalid --since: ${since}`);
  const n = parseInt(m[1] ?? '0', 10);
  const ms = m[2] === 'h' ? n * 3600_000 : n * 86400_000;
  return Date.now() - ms;
}

function loadRecords(path: string, sinceMs: number): TraceRecord[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim());
  const out: TraceRecord[] = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as TraceRecord;
      if (sinceMs === 0 || (r.ts && new Date(r.ts).getTime() >= sinceMs)) {
        out.push(r);
      }
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function mode<T>(arr: T[]): T | string {
  const counts = new Map<T, number>();
  for (const x of arr) counts.set(x, (counts.get(x) || 0) + 1);
  let best: T | undefined;
  let max = 0;
  for (const [k, v] of counts) {
    if (v > max) {
      max = v;
      best = k;
    }
  }
  return best === undefined ? '-' : best;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const path =
    process.env['SAFARI_PILOT_TRACE_OVERRIDE'] ||
    join(homedir(), '.safari-pilot', 'trace.ndjson');
  const sinceMs = parseSince(args.since);
  const records = loadRecords(path, sinceMs);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          since: args.since,
          recordCount: records.length,
          records: args.tail ? records.slice(-20) : undefined,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (args.tail) {
    console.log(`Last 20 records (since ${args.since}):`);
    for (const r of records.slice(-20)) {
      console.log(
        `${r.ts}  ${r.tool}  ${r.ok ? 'ok' : 'err'}  ${r.elapsed_ms ?? '-'}ms  ${r.domain ?? ''}`,
      );
    }
    return;
  }

  console.log(`Safari Pilot — local metrics, ${args.since}`);
  console.log(`Source: ${path}  (${records.length} records)\n`);

  if (args.byTool) {
    const groups = new Map<string, TraceRecord[]>();
    for (const r of records) {
      const list = groups.get(r.tool) || [];
      list.push(r);
      groups.set(r.tool, list);
    }
    const rows = Array.from(groups.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .map(([tool, list]) => {
        const errors = list.filter((r) => !r.ok).length;
        const latencies = list
          .filter((r) => typeof r.elapsed_ms === 'number')
          .map((r) => r.elapsed_ms!);
        const p50 = `${p(latencies, 0.5)}ms`;
        const p95v = p(latencies, 0.95);
        const p95 = `${p95v}ms ${warnPercentile(tool, p95v)}`.trim();
        return [
          tool,
          String(list.length),
          String(errors),
          pct(errors, list.length),
          p50,
          p95,
        ];
      });
    console.log('Per-tool summary');
    console.log(
      formatTable(['Tool', 'Count', 'Err', 'Err%', 'p50', 'p95'], rows),
    );
    console.log();
  }

  if (args.byError) {
    const groups = new Map<string, TraceRecord[]>();
    for (const r of records) {
      if (r.ok || !r.error) continue;
      const code = r.error.code || r.error.name || 'UNKNOWN';
      const list = groups.get(code) || [];
      list.push(r);
      groups.set(code, list);
    }
    const rows = Array.from(groups.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .map(([code, list]) => {
        const topTool = String(mode(list.map((r) => r.tool)));
        const topDomain = String(mode(list.map((r) => r.domain || '')));
        return [code, String(list.length), topTool, topDomain];
      });
    console.log('Top errors');
    console.log(
      formatTable(['Code', 'Count', 'Top tool', 'Top domain'], rows),
    );
    console.log();
  }

  if (args.byDomain) {
    const groups = new Map<string, TraceRecord[]>();
    for (const r of records) {
      const domain = r.domain || '(no-domain)';
      const list = groups.get(domain) || [];
      list.push(r);
      groups.set(domain, list);
    }
    const rows = Array.from(groups.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 20)
      .map(([domain, list]) => {
        const errors = list.filter((r) => !r.ok).length;
        return [
          domain,
          String(list.length),
          String(errors),
          pct(errors, list.length),
        ];
      });
    console.log('Top domains');
    console.log(formatTable(['Domain', 'Count', 'Err', 'Err%'], rows));
    console.log();
  }

  if (args.byCsp) {
    let cspBlockedTotal = 0;
    let cspHardBlockTotal = 0;
    const cspBlockedBySite = new Map<string, number>();
    const cspHardBlockBySite = new Map<string, number>();
    for (const r of records) {
      if (r.ok || !r.error) continue;
      const code = r.error.code;
      if (code !== 'CSP_BLOCKED' && code !== 'CSP_HARD_BLOCK') continue;
      const site = (r.domain || '(no-domain)').replace(/^www\./, '');
      if (code === 'CSP_HARD_BLOCK') {
        cspHardBlockTotal++;
        cspHardBlockBySite.set(site, (cspHardBlockBySite.get(site) || 0) + 1);
      } else {
        cspBlockedTotal++;
        cspBlockedBySite.set(site, (cspBlockedBySite.get(site) || 0) + 1);
      }
    }
    if (cspBlockedTotal > 0 || cspHardBlockTotal > 0) {
      console.log('CSP / Trusted Types blocks');
      console.log(`  CSP_BLOCKED:    ${cspBlockedTotal}`);
      console.log(`  CSP_HARD_BLOCK: ${cspHardBlockTotal}`);
      const sites = new Set<string>([
        ...cspBlockedBySite.keys(),
        ...cspHardBlockBySite.keys(),
      ]);
      if (sites.size > 0) {
        const rows = [...sites].sort().map((site) => [
          site,
          String(cspBlockedBySite.get(site) || 0),
          String(cspHardBlockBySite.get(site) || 0),
        ]);
        console.log(
          formatTable(['Site', 'CSP_BLOCKED', 'CSP_HARD_BLOCK'], rows),
        );
      }
    }
  }
}

main();
