/**
 * Global E2E report aggregator.
 *
 * vitest setup file that collects all per-suite reports and generates
 * a final combined architecture compliance report after all e2e tests.
 */
import { afterAll } from 'vitest';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ArchitectureReport } from './e2e-report.js';

const REPORTS_DIR = join(import.meta.dirname, '../e2e/reports');

afterAll(() => {
  mkdirSync(REPORTS_DIR, { recursive: true });

  let reports: ArchitectureReport[];
  try {
    const files = readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.json'));
    reports = files.map((f) => JSON.parse(readFileSync(join(REPORTS_DIR, f), 'utf-8')) as ArchitectureReport);
  } catch {
    return;
  }

  if (reports.length === 0) return;

  const totalCalls = reports.reduce((s, r) => s + r.totalCalls, 0);
  const totalCompliant = reports.reduce((s, r) => s + r.compliant, 0);
  const totalViolations = reports.reduce((s, r) => s + r.violations, 0);

  const lines: string[] = [];
  lines.push('╔══════════════════════════════════════════════════════════════════════╗');
  lines.push('║           SAFARI PILOT — E2E ARCHITECTURE COMPLIANCE               ║');
  lines.push('╚══════════════════════════════════════════════════════════════════════╝');
  lines.push('');
  lines.push(`Suites: ${reports.length} | Calls: ${totalCalls} | Compliant: ${totalCompliant} | Violations: ${totalViolations}`);
  lines.push(`Compliance rate: ${totalCalls > 0 ? ((totalCompliant / totalCalls) * 100).toFixed(1) : 0}%`);
  lines.push('');

  for (const r of reports) {
    const status = r.violations > 0 ? 'VIOLATIONS' : 'CLEAN';
    lines.push(`  [${status}] ${r.suite}: ${r.totalCalls} calls, ${r.compliant} compliant, ${r.violations} violations`);
  }

  if (totalViolations > 0) {
    lines.push('');
    lines.push('=== ARCHITECTURE VIOLATIONS ===');
    for (const r of reports) {
      for (const c of r.calls.filter((c) => !c.architectureCompliant)) {
        lines.push(`  ${r.suite} > ${c.tool}: ${c.complianceNote}`);
      }
    }
  }

  lines.push('');
  lines.push(`Report generated: ${new Date().toISOString()}`);

  const combined = lines.join('\n');
  console.log('\n' + combined);

  writeFileSync(join(REPORTS_DIR, '_combined.txt'), combined);
  writeFileSync(
    join(REPORTS_DIR, '_combined.json'),
    JSON.stringify({ generated: new Date().toISOString(), totalCalls, totalCompliant, totalViolations, suites: reports }, null, 2),
  );
});
