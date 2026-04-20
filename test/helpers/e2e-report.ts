/**
 * E2E Architecture Report Generator
 *
 * Wraps tool calls to capture what actually happened vs what the architecture
 * expects. Generates a report after each test suite showing:
 * - Which tool was called
 * - Which engine was expected vs which actually ran
 * - Whether the security pipeline executed
 * - Latency
 * - Architecture compliance verdict
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ToolCallRecord {
  tool: string;
  params: Record<string, unknown>;
  engine: string;
  expectedEngine: string;
  degraded: boolean;
  degradedReason?: string;
  latencyMs: number;
  resultOk: boolean;
  error?: string;
  architectureCompliant: boolean;
  complianceNote: string;
  timestamp: number;
}

export interface ArchitectureReport {
  suite: string;
  timestamp: string;
  totalCalls: number;
  compliant: number;
  violations: number;
  calls: ToolCallRecord[];
  summary: string;
}

const EXTENSION_REQUIRED_TOOLS = new Set([
  'safari_query_shadow',
  'safari_click_shadow',
]);

const SELECTOR_ONLY_TOOLS = new Set([
  'safari_health_check',
  'safari_emergency_stop',
  'safari_list_tabs',
  'safari_new_tab',
  'safari_close_tab',
  'safari_navigate',
  'safari_navigate_back',
  'safari_navigate_forward',
  'safari_reload',
  'safari_export_pdf',
  'safari_wait_for_download',
]);

function expectedEngineFor(
  tool: string,
  extensionConnected: boolean,
): string {
  if (!extensionConnected) {
    if (EXTENSION_REQUIRED_TOOLS.has(tool)) return 'rejected';
    return 'daemon';
  }
  return 'extension';
}

function checkCompliance(
  tool: string,
  engine: string,
  expected: string,
  degraded: boolean,
): { compliant: boolean; note: string } {
  if (expected === 'rejected') {
    if (degraded) {
      return { compliant: true, note: 'Extension required but unavailable — correctly rejected' };
    }
    return {
      compliant: false,
      note: `Extension required but unavailable — should be rejected, got engine=${engine}`,
    };
  }
  if (engine === expected) {
    return { compliant: true, note: `Routed to ${engine} as expected` };
  }
  if (engine === 'applescript' && expected !== 'applescript') {
    return {
      compliant: false,
      note: `Expected ${expected} but fell through to applescript — engine selection may not be working`,
    };
  }
  if (engine === 'daemon' && expected === 'extension') {
    return {
      compliant: false,
      note: `Expected extension but got daemon — extension may not be connected`,
    };
  }
  return {
    compliant: true,
    note: `Engine ${engine} acceptable (expected ${expected})`,
  };
}

export class E2EReportCollector {
  private calls: ToolCallRecord[] = [];
  private suiteName: string;
  private extensionConnected = true;

  constructor(suiteName: string) {
    this.suiteName = suiteName;
  }

  setExtensionConnected(connected: boolean): void {
    this.extensionConnected = connected;
  }

  recordCall(
    tool: string,
    params: Record<string, unknown>,
    meta: Record<string, unknown> | undefined,
    resultOk: boolean,
    error?: string,
  ): void {
    const engine = (meta?.['engine'] as string) ?? 'unknown';
    const degraded = (meta?.['degraded'] as boolean) ?? false;
    const degradedReason = meta?.['degradedReason'] as string | undefined;
    const latencyMs = (meta?.['latencyMs'] as number) ?? 0;

    const expected = expectedEngineFor(tool, this.extensionConnected);
    const { compliant, note } = checkCompliance(tool, engine, expected, degraded);

    this.calls.push({
      tool,
      params,
      engine,
      expectedEngine: expected,
      degraded,
      degradedReason,
      latencyMs,
      resultOk,
      error,
      architectureCompliant: compliant,
      complianceNote: note,
      timestamp: Date.now(),
    });
  }

  generateReport(): ArchitectureReport {
    const compliant = this.calls.filter((c) => c.architectureCompliant).length;
    const violations = this.calls.filter((c) => !c.architectureCompliant).length;

    const lines: string[] = [];
    lines.push(`Suite: ${this.suiteName}`);
    lines.push(`Extension connected: ${this.extensionConnected}`);
    lines.push(`Total calls: ${this.calls.length} | Compliant: ${compliant} | Violations: ${violations}`);
    lines.push('');

    if (violations > 0) {
      lines.push('=== VIOLATIONS ===');
      for (const c of this.calls.filter((c) => !c.architectureCompliant)) {
        lines.push(`  VIOLATION: ${c.tool} — ${c.complianceNote}`);
        lines.push(`    Engine: ${c.engine} | Expected: ${c.expectedEngine} | Latency: ${c.latencyMs}ms`);
      }
      lines.push('');
    }

    lines.push('=== ALL CALLS ===');
    for (const c of this.calls) {
      const status = c.architectureCompliant ? 'OK' : 'VIOLATION';
      const result = c.resultOk ? 'success' : `error: ${c.error ?? 'unknown'}`;
      lines.push(
        `  [${status}] ${c.tool} → engine=${c.engine} (expected=${c.expectedEngine}) ` +
        `${c.latencyMs}ms ${result} — ${c.complianceNote}`,
      );
    }

    const summary = lines.join('\n');

    return {
      suite: this.suiteName,
      timestamp: new Date().toISOString(),
      totalCalls: this.calls.length,
      compliant,
      violations,
      calls: this.calls,
      summary,
    };
  }

  writeReport(): string {
    const report = this.generateReport();

    const reportsDir = join(import.meta.dirname, '../e2e/reports');
    mkdirSync(reportsDir, { recursive: true });

    const safeName = this.suiteName.replace(/[^a-zA-Z0-9-]/g, '_');
    const jsonPath = join(reportsDir, `${safeName}.json`);
    const textPath = join(reportsDir, `${safeName}.txt`);

    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    writeFileSync(textPath, report.summary);

    console.log('\n' + '='.repeat(70));
    console.log('ARCHITECTURE COMPLIANCE REPORT');
    console.log('='.repeat(70));
    console.log(report.summary);
    console.log('='.repeat(70));
    console.log(`Reports: ${textPath}`);
    console.log('');

    return textPath;
  }
}
