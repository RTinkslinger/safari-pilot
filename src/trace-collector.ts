// ─── TraceCollector ──────────────────────────────────────────────────────────
//
// Structured trace capture for every tool call during integration and e2e tests.
// Writes JSON trace files that seed the future recipe learning system.
//
// Completely separate from AuditLog — AuditLog is a security feature (in-memory,
// redacted, enforced retention). TraceCollector is a learning feature (rich context,
// writes to disk, accumulates over time).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────────

export interface TraceEvent {
  seq: number;
  timestamp: string;
  tool: string;
  params: Record<string, unknown>;
  targeting: {
    method: 'ref' | 'locator' | 'selector' | 'none';
    ref?: string;
    locator?: {
      role?: string;
      name?: string;
      text?: string;
      label?: string;
      testId?: string;
      placeholder?: string;
      exact?: boolean;
    };
    selector?: string;
  };
  success: boolean;
  result: {
    summary: string;
    data?: unknown;
    error?: { code: string; message: string; hints: string[] };
  };
  timing: {
    total_ms: number;
    auto_wait_ms?: number;
    engine_ms: number;
  };
  engine: 'applescript' | 'daemon' | 'extension';
  degraded: boolean;
  degradedReason?: string;
  domain: string;
  tabUrl?: string;
  pageTitle?: string;
  autoWait?: {
    checks: string[];
    allPassed: boolean;
    failedCheck?: string;
    waited_ms: number;
    force: boolean;
  };
  snapshot?: {
    elementCount: number;
    interactiveCount: number;
    refCount: number;
    format: 'yaml' | 'json';
    truncatedSnapshot: string;
  };
  recipeHintsInjected?: string[];
  recipeHintsUseful?: boolean;
}

export interface TraceSession {
  sessionId: string;
  runId: string;
  testId: string;
  suiteName: string;
  testFile: string;
  intent: string;
  success: boolean;
  failureReason?: string;
  failureStep?: number;
  events: TraceEvent[];
  startUrl?: string;
  endUrl?: string;
  metrics: {
    totalSteps: number;
    totalMs: number;
    successfulSteps: number;
    failedSteps: number;
    autoWaitTriggers: number;
    autoWaitTotalMs: number;
    autoWaitFailures: number;
    retriesOrFallbacks: number;
    enginesUsed: Record<string, number>;
    domainsVisited: string[];
    uniqueToolsUsed: string[];
    refTargetingCount: number;
    locatorTargetingCount: number;
    selectorTargetingCount: number;
  };
  domainObservations: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface TraceRun {
  runId: string;
  type: 'integration' | 'e2e';
  environment: {
    safariPilotVersion: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    gitCommit: string;
    gitBranch: string;
    timestamp: string;
  };
  testFile: string;
  sessions: TraceSession[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    totalMs: number;
    domainsTestedOnce: string[];
    toolsUsedAtLeastOnce: string[];
    avgStepsPerTest: number;
    avgMsPerTest: number;
    refTargetingUsage: number;
    locatorTargetingUsage: number;
    autoWaitUsage: number;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function randomHex(len: number): string {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * 16)];
  return out;
}

function emptyMetrics(): TraceSession['metrics'] {
  return {
    totalSteps: 0,
    totalMs: 0,
    successfulSteps: 0,
    failedSteps: 0,
    autoWaitTriggers: 0,
    autoWaitTotalMs: 0,
    autoWaitFailures: 0,
    retriesOrFallbacks: 0,
    enginesUsed: {},
    domainsVisited: [],
    uniqueToolsUsed: [],
    refTargetingCount: 0,
    locatorTargetingCount: 0,
    selectorTargetingCount: 0,
  };
}

// ── Constants ────────────────────────────────────────────────────────────────
// Aligned with AuditLog's redaction rules for consistency.

const REDACT_VALUE_TOOLS = new Set(['safari_fill', 'safari_set_cookie']);
const REDACT_CONTENT_TOOLS = new Set(['safari_clipboard_write']);
const TRUNCATE_SCRIPT_TOOLS = new Set(['safari_evaluate']);
const SCRIPT_MAX_LEN = 200;
const SNAPSHOT_MAX_LEN = 500;

// Locator keys that indicate a11y-based targeting — any of these present
// means the tool call used locator targeting rather than a raw CSS selector.
const LOCATOR_KEYS = ['role', 'name', 'text', 'label', 'testId', 'placeholder'] as const;

// ── Interfaces for monkey-patching ──────────────────────────────────────────
// These describe the minimal shape we need from tool modules and the server.
// Using interfaces rather than importing production types keeps the trace
// system decoupled from production code.

export interface ToolModuleLike {
  getHandler: (name: string) => ((...args: unknown[]) => Promise<unknown>) | undefined;
}

export interface ServerLike {
  executeToolWithSecurity: (name: string, params: Record<string, unknown>) => Promise<unknown>;
}

// Shape of the response we extract trace data from — matches ToolResponse
// in types.ts without creating a hard import dependency.
interface ResponseLike {
  content: Array<{ type: string; text?: string }>;
  metadata: {
    engine: string;
    degraded: boolean;
    degradedReason?: string;
    latencyMs: number;
    tabUrl?: string;
  };
}

// ── TraceCollector ──────────────────────────────────────────────────────────

export interface TraceCollectorOptions {
  runId: string;
  type: 'integration' | 'e2e';
  testFile: string;
}

export class TraceCollector {
  private readonly runId: string;
  private readonly type: 'integration' | 'e2e';
  private readonly testFile: string;
  private sessions: TraceSession[] = [];
  private currentSession: TraceSession | null = null;
  private seqCounter = 0;
  private unwrapFns: Array<() => void> = [];

  constructor(options: TraceCollectorOptions) {
    this.runId = options.runId;
    this.type = options.type;
    this.testFile = options.testFile;
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  startSession(testId: string, suiteName: string, intent?: string): void {
    if (this.currentSession) {
      throw new Error(
        `TraceCollector: session "${this.currentSession.testId}" is still active. Call endSession() first.`,
      );
    }
    // Reset seq counter per session — seq numbers are monotonic within a
    // session but restart at 1 for each new test.
    this.seqCounter = 0;
    this.currentSession = {
      sessionId: `trace-${Date.now()}-${randomHex(6)}`,
      runId: this.runId,
      testId,
      suiteName,
      testFile: this.testFile,
      intent: intent ?? testId, // default intent to test name if not provided
      success: false,
      events: [],
      metrics: emptyMetrics(),
      domainObservations: [],
      startedAt: new Date().toISOString(),
      endedAt: '',
      durationMs: 0,
    };
  }

  endSession(success: boolean, failureReason?: string): void {
    if (!this.currentSession) return;

    this.currentSession.success = success;
    this.currentSession.failureReason = failureReason;
    this.currentSession.endedAt = new Date().toISOString();
    this.currentSession.durationMs =
      new Date(this.currentSession.endedAt).getTime() -
      new Date(this.currentSession.startedAt).getTime();

    // Compute aggregate metrics from the event stream
    this.computeSessionMetrics(this.currentSession);

    // Tag the failure step — find the last failed event, which is most likely
    // the one that caused the test to fail.
    if (!success && this.currentSession.events.length > 0) {
      const lastFailed = [...this.currentSession.events].reverse().find((e) => !e.success);
      if (lastFailed) this.currentSession.failureStep = lastFailed.seq;
    }

    this.sessions.push(this.currentSession);
    this.currentSession = null;
  }

  // ── Manual annotations ────────────────────────────────────────────────────

  addObservation(observation: string): void {
    if (this.currentSession) {
      this.currentSession.domainObservations.push(observation);
    }
  }

  setSessionStartUrl(url: string): void {
    if (this.currentSession) this.currentSession.startUrl = url;
  }

  setSessionEndUrl(url: string): void {
    if (this.currentSession) this.currentSession.endUrl = url;
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  getRunId(): string {
    return this.runId;
  }

  getCurrentSession(): TraceSession | null {
    return this.currentSession;
  }

  getSessionCount(): number {
    return this.sessions.length;
  }

  getSessions(): TraceSession[] {
    return this.sessions;
  }

  getEventCount(): number {
    // Count events in both completed sessions and the active session
    return (
      this.sessions.reduce((n, s) => n + s.events.length, 0) +
      (this.currentSession?.events.length ?? 0)
    );
  }

  // ── Event recording ───────────────────────────────────────────────────────

  recordEvent(event: TraceEvent): void {
    if (this.currentSession) {
      this.currentSession.events.push(event);
    }
  }

  nextSeq(): number {
    return ++this.seqCounter;
  }

  // ── Static helpers for event construction ─────────────────────────────────

  /**
   * Detect how an element was targeted from tool params.
   * Priority: ref > locator > selector > none
   * This ordering reflects the a11y targeting hierarchy — refs are the most
   * reliable, locators are semantic, selectors are fragile.
   */
  static extractTargeting(params: Record<string, unknown>): TraceEvent['targeting'] {
    // Ref takes highest priority — it's the most reliable targeting method
    if (params['ref'] && typeof params['ref'] === 'string') {
      return {
        method: 'ref',
        ref: params['ref'] as string,
        selector: params['selector'] as string | undefined,
      };
    }

    // Check for locator-style params (a11y attributes)
    const locator: Record<string, unknown> = {};
    let hasLocator = false;
    for (const key of LOCATOR_KEYS) {
      if (params[key] !== undefined && params[key] !== null) {
        locator[key] = params[key];
        hasLocator = true;
      }
    }
    if (params['exact'] !== undefined) locator['exact'] = params['exact'];

    if (hasLocator) {
      return {
        method: 'locator',
        locator: locator as TraceEvent['targeting']['locator'],
        selector: params['selector'] as string | undefined,
      };
    }

    // Raw CSS selector — most fragile but still explicit targeting
    if (params['selector'] && typeof params['selector'] === 'string') {
      return { method: 'selector', selector: params['selector'] as string };
    }

    return { method: 'none' };
  }

  /**
   * Redact sensitive values from tool params before recording.
   * Mirrors AuditLog's redaction rules for consistency.
   */
  static redactParams(tool: string, params: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...params };

    // Redact cleartext value fields (passwords, cookie values)
    if (REDACT_VALUE_TOOLS.has(tool) && 'value' in copy) {
      copy['value'] = '[REDACTED]';
    }

    // Redact clipboard content
    if (REDACT_CONTENT_TOOLS.has(tool) && 'content' in copy) {
      copy['content'] = '[REDACTED]';
    }

    // Truncate long script payloads — they can be megabytes
    if (TRUNCATE_SCRIPT_TOOLS.has(tool) && typeof copy['script'] === 'string') {
      const script = copy['script'] as string;
      if (script.length > SCRIPT_MAX_LEN) {
        copy['script'] = script.substring(0, SCRIPT_MAX_LEN) + '...';
      }
    }

    return copy;
  }

  /**
   * Create a human-readable summary and optional snapshot metadata from tool results.
   * Snapshot results get special handling — we extract element counts and truncate
   * the YAML/JSON to keep trace files manageable.
   */
  static summarizeResult(
    tool: string,
    data: Record<string, unknown>,
  ): {
    summary: string;
    data?: unknown;
    snapshot?: TraceEvent['snapshot'];
  } {
    if (tool === 'safari_snapshot') {
      const snap = data['snapshot'] as string | undefined;
      const elCount = (data['elementCount'] as number | undefined) ?? 0;
      const intCount = (data['interactiveCount'] as number | undefined) ?? 0;
      const refMap = data['refMap'] as Record<string, string> | undefined;
      const refCount = refMap ? Object.keys(refMap).length : 0;
      // Detect format by checking if the snapshot starts with '{' (JSON) vs YAML
      const format: 'yaml' | 'json' = snap && snap.startsWith('{') ? 'json' : 'yaml';

      return {
        summary: `${elCount} elements, ${intCount} interactive, ${refCount} refs`,
        data: undefined, // full snapshot omitted — truncated version in snapshot field
        snapshot: {
          elementCount: elCount,
          interactiveCount: intCount,
          refCount,
          format,
          truncatedSnapshot: (snap ?? '').substring(0, SNAPSHOT_MAX_LEN),
        },
      };
    }

    // Generic summary — stringify and truncate for readability
    const summary = JSON.stringify(data).substring(0, 200);
    return { summary, data };
  }

  /**
   * Extract error information into a structured format.
   * Handles both SafariPilotError (with code + hints) and plain Error objects.
   */
  static summarizeError(error: unknown): {
    summary: string;
    error: { code: string; message: string; hints: string[] };
  } {
    const msg = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code ?? 'ERROR';
    // Extract hints from SafariPilotError if available
    const hints = (error as { hints?: string[] })?.hints ?? [];

    return {
      summary: `error: ${msg.substring(0, 200)}`,
      error: { code, message: msg, hints },
    };
  }

  /**
   * Extract the hostname from tabUrl or url param.
   * Returns empty string for invalid/missing URLs rather than throwing.
   */
  static extractDomain(params: Record<string, unknown>): string {
    const url = (params['tabUrl'] ?? params['url'] ?? '') as string;
    try {
      return new URL(url || 'about:blank').hostname;
    } catch {
      return '';
    }
  }

  // ── Monkey-patch wrapping ─────────────────────────────────────────────────
  //
  // Two wrapping strategies:
  // 1. wrapToolModule — for integration tests, wraps individual tool module handlers
  // 2. wrapServer — for e2e tests, wraps the server's executeToolWithSecurity
  //
  // Both capture identical TraceEvent data. The server path additionally captures
  // security pipeline context (domain policy, rate limiter state) in the response.

  /**
   * Wraps a tool module's getHandler so every returned handler is intercepted.
   * The original handler is preserved and called normally — the wrapper only
   * observes, it never modifies tool behavior.
   */
  wrapToolModule(module: ToolModuleLike, _moduleName: string): void {
    // Store raw reference (not .bind()) so unwrap restores exact identity
    const originalGetHandler = module.getHandler;
    const self = this;

    module.getHandler = function wrappedGetHandler(toolName: string) {
      const originalHandler = originalGetHandler.call(module, toolName);
      if (!originalHandler) return undefined;

      return async function tracedHandler(params: Record<string, unknown>) {
        const start = Date.now();
        const seq = self.nextSeq();

        try {
          const result = (await originalHandler(params)) as ResponseLike;
          let resultData: Record<string, unknown> = {};
          try {
            if (result.content[0]?.text) {
              resultData = JSON.parse(result.content[0].text) as Record<string, unknown>;
            }
          } catch {
            // Non-JSON text content (screenshots, plain strings) — trace records opaque result
          }
          const { summary, data, snapshot } = TraceCollector.summarizeResult(toolName, resultData);

          const event: TraceEvent = {
            seq,
            timestamp: new Date().toISOString(),
            tool: toolName,
            params: TraceCollector.redactParams(toolName, params),
            targeting: TraceCollector.extractTargeting(params),
            success: true,
            result: { summary, data },
            timing: { total_ms: Date.now() - start, engine_ms: result.metadata.latencyMs },
            engine: result.metadata.engine as TraceEvent['engine'],
            degraded: result.metadata.degraded,
            degradedReason: result.metadata.degradedReason,
            domain: TraceCollector.extractDomain(params),
            tabUrl: params['tabUrl'] as string | undefined,
            ...(snapshot ? { snapshot } : {}),
          };
          self.recordEvent(event);
          return result;
        } catch (error) {
          const { summary, error: errInfo } = TraceCollector.summarizeError(error);
          const event: TraceEvent = {
            seq,
            timestamp: new Date().toISOString(),
            tool: toolName,
            params: TraceCollector.redactParams(toolName, params),
            targeting: TraceCollector.extractTargeting(params),
            success: false,
            result: { summary, error: errInfo },
            timing: { total_ms: Date.now() - start, engine_ms: 0 },
            engine: 'applescript', // default — we can't know the engine on error
            degraded: false,
            domain: TraceCollector.extractDomain(params),
            tabUrl: params['tabUrl'] as string | undefined,
          };
          self.recordEvent(event);
          throw error;
        }
      } as unknown as (...args: unknown[]) => Promise<unknown>;
    } as typeof module.getHandler;

    // Store the unwrap function so we can restore the exact original reference
    self.unwrapFns.push(() => {
      module.getHandler = originalGetHandler;
    });
  }

  /**
   * Wraps the server's executeToolWithSecurity method.
   * Same trace capture as wrapToolModule, but the server path includes
   * security pipeline overhead in the timing.
   */
  wrapServer(server: ServerLike): void {
    // Store raw reference (not .bind()) so unwrap restores exact identity
    const original = server.executeToolWithSecurity;
    const self = this;

    server.executeToolWithSecurity = async function tracedExecute(
      name: string,
      params: Record<string, unknown>,
    ) {
      const start = Date.now();
      const seq = self.nextSeq();

      try {
        const result = (await original.call(server, name, params)) as ResponseLike;
        let resultData: Record<string, unknown> = {};
        try {
          if (result.content[0]?.text) {
            resultData = JSON.parse(result.content[0].text) as Record<string, unknown>;
          }
        } catch {
          // Non-JSON text content (screenshots, plain strings) — trace records opaque result
        }
        const { summary, data, snapshot } = TraceCollector.summarizeResult(name, resultData);

        const event: TraceEvent = {
          seq,
          timestamp: new Date().toISOString(),
          tool: name,
          params: TraceCollector.redactParams(name, params),
          targeting: TraceCollector.extractTargeting(params),
          success: true,
          result: { summary, data },
          timing: { total_ms: Date.now() - start, engine_ms: result.metadata.latencyMs },
          engine: result.metadata.engine as TraceEvent['engine'],
          degraded: result.metadata.degraded,
          degradedReason: result.metadata.degradedReason,
          domain: TraceCollector.extractDomain(params),
          tabUrl: params['tabUrl'] as string | undefined,
          ...(snapshot ? { snapshot } : {}),
        };
        self.recordEvent(event);
        return result;
      } catch (error) {
        const { summary, error: errInfo } = TraceCollector.summarizeError(error);
        const event: TraceEvent = {
          seq,
          timestamp: new Date().toISOString(),
          tool: name,
          params: TraceCollector.redactParams(name, params),
          targeting: TraceCollector.extractTargeting(params),
          success: false,
          result: { summary, error: errInfo },
          timing: { total_ms: Date.now() - start, engine_ms: 0 },
          engine: 'applescript', // default — no response to read engine from on error
          degraded: false,
          domain: TraceCollector.extractDomain(params),
          tabUrl: params['tabUrl'] as string | undefined,
        };
        self.recordEvent(event);
        throw error;
      }
    } as typeof server.executeToolWithSecurity;

    self.unwrapFns.push(() => {
      server.executeToolWithSecurity = original;
    });
  }

  /**
   * Restore all original methods that were monkey-patched.
   * Must be called in afterAll() to avoid test pollution.
   */
  unwrap(): void {
    for (const fn of this.unwrapFns) fn();
    this.unwrapFns = [];
  }

  // ── Flush to disk ─────────────────────────────────────────────────────────

  /**
   * Write all collected sessions to a TraceRun JSON file on disk.
   * Returns the file path written, or empty string if there were no sessions.
   * Creates the output directory if it doesn't exist.
   */
  async flush(outputDir: string): Promise<string> {
    if (this.sessions.length === 0) return '';

    const env = TraceCollector.getEnvironment();
    const run: TraceRun = {
      runId: this.runId,
      type: this.type,
      environment: env,
      testFile: this.testFile,
      sessions: this.sessions,
      summary: this.computeRunSummary(),
    };

    await mkdir(outputDir, { recursive: true });

    // File name: ISO timestamp (colons replaced with dashes) + git commit hash
    const ts = env.timestamp.replace(/:/g, '-').replace(/\.\d+Z$/, '');
    const fileName = `${ts}-${env.gitCommit}.json`;
    const filePath = join(outputDir, fileName);
    await writeFile(filePath, JSON.stringify(run, null, 2), 'utf-8');
    return filePath;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Collect environment metadata for the trace file.
   * Git info is best-effort — gracefully falls back to 'unknown' in CI or
   * shallow clones where git commands might fail.
   */
  private static getEnvironment(): TraceRun['environment'] {
    let gitCommit = 'unknown';
    let gitBranch = 'unknown';
    try {
      gitCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { timeout: 3000 })
        .toString()
        .trim();
    } catch {
      // Git not available or not in a repo — fine, use 'unknown'
    }
    try {
      gitBranch = execFileSync('git', ['branch', '--show-current'], { timeout: 3000 })
        .toString()
        .trim();
    } catch {
      // Same graceful fallback
    }

    // Read version from package.json without require() since this is ESM
    let safariPilotVersion = 'unknown';
    try {
      const pkgPath = join(process.cwd(), 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
      safariPilotVersion = pkg.version ?? 'unknown';
    } catch {
      // Not in project root or package.json missing — fine
    }

    return {
      safariPilotVersion,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      gitCommit,
      gitBranch,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Compute aggregate metrics from a session's event stream.
   * Called at endSession() time so the metrics are available immediately.
   */
  private computeSessionMetrics(session: TraceSession): void {
    const m = session.metrics;
    m.totalSteps = session.events.length;
    m.totalMs = session.events.reduce((sum, e) => sum + e.timing.total_ms, 0);
    m.successfulSteps = session.events.filter((e) => e.success).length;
    m.failedSteps = session.events.filter((e) => !e.success).length;

    const engines: Record<string, number> = {};
    const domains = new Set<string>();
    const tools = new Set<string>();
    let refCount = 0;
    let locatorCount = 0;
    let selectorCount = 0;
    let awTriggers = 0;
    let awMs = 0;
    let awFails = 0;

    for (const e of session.events) {
      engines[e.engine] = (engines[e.engine] ?? 0) + 1;
      if (e.domain) domains.add(e.domain);
      tools.add(e.tool);

      if (e.targeting.method === 'ref') refCount++;
      if (e.targeting.method === 'locator') locatorCount++;
      if (e.targeting.method === 'selector') selectorCount++;

      if (e.autoWait) {
        awTriggers++;
        awMs += e.autoWait.waited_ms;
        if (!e.autoWait.allPassed) awFails++;
      }
    }

    m.enginesUsed = engines;
    m.domainsVisited = [...domains];
    m.uniqueToolsUsed = [...tools];
    m.refTargetingCount = refCount;
    m.locatorTargetingCount = locatorCount;
    m.selectorTargetingCount = selectorCount;
    m.autoWaitTriggers = awTriggers;
    m.autoWaitTotalMs = awMs;
    m.autoWaitFailures = awFails;
  }

  /**
   * Compute run-level summary statistics across all sessions.
   * Used by flush() to populate the TraceRun.summary field.
   */
  private computeRunSummary(): TraceRun['summary'] {
    const passed = this.sessions.filter((s) => s.success).length;
    const failed = this.sessions.filter((s) => !s.success).length;
    const totalMs = this.sessions.reduce((sum, s) => sum + s.durationMs, 0);
    const allDomains = new Set<string>();
    const allTools = new Set<string>();
    let totalEvents = 0;
    let refEvents = 0;
    let locatorEvents = 0;
    let awEvents = 0;

    for (const s of this.sessions) {
      for (const d of s.metrics.domainsVisited) allDomains.add(d);
      for (const t of s.metrics.uniqueToolsUsed) allTools.add(t);
      totalEvents += s.events.length;
      refEvents += s.metrics.refTargetingCount;
      locatorEvents += s.metrics.locatorTargetingCount;
      awEvents += s.metrics.autoWaitTriggers;
    }

    return {
      total: this.sessions.length,
      passed,
      failed,
      skipped: 0, // vitest skipped tests never reach beforeEach, so they're invisible to us
      totalMs,
      domainsTestedOnce: [...allDomains],
      toolsUsedAtLeastOnce: [...allTools],
      avgStepsPerTest: this.sessions.length > 0 ? totalEvents / this.sessions.length : 0,
      avgMsPerTest: this.sessions.length > 0 ? totalMs / this.sessions.length : 0,
      // Usage percentages — what fraction of tool calls used each targeting method
      refTargetingUsage: totalEvents > 0 ? refEvents / totalEvents : 0,
      locatorTargetingUsage: totalEvents > 0 ? locatorEvents / totalEvents : 0,
      autoWaitUsage: totalEvents > 0 ? awEvents / totalEvents : 0,
    };
  }
}
