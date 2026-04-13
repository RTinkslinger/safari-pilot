# TraceCollector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture exhaustive structured traces of every tool call during integration and e2e tests, writing JSON trace files that seed the future recipe system.

**Architecture:** A standalone `TraceCollector` class that monkey-patches tool module handlers (integration tests) and `SafariPilotServer.executeToolWithSecurity` (e2e tests) to intercept tool calls, build `TraceEvent` records with targeting/timing/auto-wait/snapshot metadata, group them into `TraceSession` per test, and flush a complete `TraceRun` JSON to `benchmark/traces/` after all tests complete.

**Tech Stack:** TypeScript, vitest (beforeEach/afterEach hooks), Node.js fs/child_process for file I/O and git metadata.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/trace-collector.ts` | Create | TraceCollector class, all types, redaction, targeting extraction, summary computation, file I/O |
| `test/unit/trace-collector.test.ts` | Create | Unit tests for TraceCollector (no Safari needed) |
| `test/integration/a11y-targeting-integration.test.ts` | Modify | Wire TraceCollector via beforeAll/beforeEach/afterEach/afterAll |
| `test/e2e/a11y-targeting-e2e.test.ts` | Modify | Wire TraceCollector via beforeAll/beforeEach/afterEach/afterAll |
| `benchmark/traces/integration/.gitkeep` | Create | Directory structure |
| `benchmark/traces/e2e/.gitkeep` | Create | Directory structure |

---

### Task 1: Types and TraceCollector skeleton

**Files:**
- Create: `src/trace-collector.ts`
- Test: `test/unit/trace-collector.test.ts`

- [ ] **Step 1: Write failing tests for the type contracts and constructor**

```typescript
// test/unit/trace-collector.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TraceCollector } from '../../src/trace-collector.js';
import type { TraceEvent, TraceSession, TraceRun } from '../../src/trace-collector.js';

describe('TraceCollector', () => {
  let collector: TraceCollector;

  beforeEach(() => {
    collector = new TraceCollector({
      runId: 'test-run-001',
      type: 'integration',
      testFile: 'test/integration/example.test.ts',
    });
  });

  describe('constructor', () => {
    it('stores runId, type, and testFile', () => {
      expect(collector.getRunId()).toBe('test-run-001');
    });

    it('starts with zero sessions and zero events', () => {
      expect(collector.getSessionCount()).toBe(0);
      expect(collector.getEventCount()).toBe(0);
    });

    it('has no current session initially', () => {
      expect(collector.getCurrentSession()).toBeNull();
    });
  });

  describe('session lifecycle', () => {
    it('startSession creates a session with correct fields', () => {
      collector.startSession('test-1', 'Suite A', 'Verify snapshot works');
      const session = collector.getCurrentSession()!;
      expect(session).not.toBeNull();
      expect(session.testId).toBe('test-1');
      expect(session.suiteName).toBe('Suite A');
      expect(session.intent).toBe('Verify snapshot works');
      expect(session.runId).toBe('test-run-001');
      expect(session.events).toEqual([]);
      expect(session.domainObservations).toEqual([]);
      expect(session.startedAt).toBeTruthy();
    });

    it('endSession marks session complete with success', () => {
      collector.startSession('test-1', 'Suite A');
      collector.endSession(true);
      expect(collector.getCurrentSession()).toBeNull();
      expect(collector.getSessionCount()).toBe(1);
    });

    it('endSession marks session with failure reason', () => {
      collector.startSession('test-1', 'Suite A');
      collector.endSession(false, 'Element not found');
      const sessions = collector.getSessions();
      expect(sessions[0].success).toBe(false);
      expect(sessions[0].failureReason).toBe('Element not found');
    });

    it('throws when starting a session while one is active', () => {
      collector.startSession('test-1', 'Suite A');
      expect(() => collector.startSession('test-2', 'Suite A')).toThrow();
    });

    it('supports multiple sequential sessions', () => {
      collector.startSession('test-1', 'Suite A');
      collector.endSession(true);
      collector.startSession('test-2', 'Suite A');
      collector.endSession(false, 'timeout');
      expect(collector.getSessionCount()).toBe(2);
    });

    it('intent defaults to testId when not provided', () => {
      collector.startSession('my-test-name', 'Suite B');
      expect(collector.getCurrentSession()!.intent).toBe('my-test-name');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/trace-collector.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the TraceCollector with types and session lifecycle**

```typescript
// src/trace-collector.ts
import { execFileSync } from 'node:child_process';
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

// ── Helpers ─────────────────────────────────────────────────────────────────

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
      throw new Error(`TraceCollector: session "${this.currentSession.testId}" is still active. Call endSession() first.`);
    }
    this.seqCounter = 0;
    this.currentSession = {
      sessionId: `trace-${Date.now()}-${randomHex(6)}`,
      runId: this.runId,
      testId,
      suiteName,
      testFile: this.testFile,
      intent: intent ?? testId,
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
    this.computeSessionMetrics(this.currentSession);
    if (!success && this.currentSession.events.length > 0) {
      const lastFailed = [...this.currentSession.events].reverse().find(e => !e.success);
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

  getRunId(): string { return this.runId; }
  getCurrentSession(): TraceSession | null { return this.currentSession; }
  getSessionCount(): number { return this.sessions.length; }
  getSessions(): TraceSession[] { return this.sessions; }
  getEventCount(): number {
    return this.sessions.reduce((n, s) => n + s.events.length, 0) +
      (this.currentSession?.events.length ?? 0);
  }

  // ── Wrapping (implemented in Task 2) ──────────────────────────────────────

  wrapToolModule(_module: unknown, _moduleName: string): void {
    // Implemented in Task 2
  }

  wrapServer(_server: unknown): void {
    // Implemented in Task 2
  }

  unwrap(): void {
    for (const fn of this.unwrapFns) fn();
    this.unwrapFns = [];
  }

  // ── Flush (implemented in Task 3) ─────────────────────────────────────────

  async flush(_outputDir: string): Promise<string> {
    return ''; // Implemented in Task 3
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  recordEvent(event: TraceEvent): void {
    if (this.currentSession) {
      this.currentSession.events.push(event);
    }
  }

  nextSeq(): number {
    return ++this.seqCounter;
  }

  private computeSessionMetrics(session: TraceSession): void {
    const m = session.metrics;
    m.totalSteps = session.events.length;
    m.totalMs = session.events.reduce((sum, e) => sum + e.timing.total_ms, 0);
    m.successfulSteps = session.events.filter(e => e.success).length;
    m.failedSteps = session.events.filter(e => !e.success).length;

    const engines: Record<string, number> = {};
    const domains = new Set<string>();
    const tools = new Set<string>();
    let refCount = 0, locatorCount = 0, selectorCount = 0;
    let awTriggers = 0, awMs = 0, awFails = 0;

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
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/trace-collector.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/trace-collector.ts test/unit/trace-collector.test.ts
git commit -m "feat(trace): TraceCollector skeleton — types, session lifecycle, accessors"
```

---

### Task 2: Event creation, redaction, and monkey-patch wrapping

**Files:**
- Modify: `src/trace-collector.ts`
- Test: `test/unit/trace-collector.test.ts`

- [ ] **Step 1: Write failing tests for event creation, redaction, and wrapping**

Add to `test/unit/trace-collector.test.ts`:

```typescript
  describe('event creation helpers', () => {
    it('extractTargeting identifies ref', () => {
      const t = TraceCollector.extractTargeting({ ref: 'e42', selector: '#btn' });
      expect(t.method).toBe('ref');
      expect(t.ref).toBe('e42');
    });

    it('extractTargeting identifies locator', () => {
      const t = TraceCollector.extractTargeting({ role: 'button', name: 'Submit' });
      expect(t.method).toBe('locator');
      expect(t.locator).toEqual({ role: 'button', name: 'Submit' });
    });

    it('extractTargeting identifies selector', () => {
      const t = TraceCollector.extractTargeting({ selector: '#submit-btn' });
      expect(t.method).toBe('selector');
      expect(t.selector).toBe('#submit-btn');
    });

    it('extractTargeting returns none when no targeting params', () => {
      const t = TraceCollector.extractTargeting({ tabUrl: 'https://example.com' });
      expect(t.method).toBe('none');
    });
  });

  describe('redaction', () => {
    it('redacts safari_fill value param', () => {
      const redacted = TraceCollector.redactParams('safari_fill', { tabUrl: 'x', selector: '#in', value: 'secret123' });
      expect(redacted.value).toBe('[REDACTED]');
      expect(redacted.selector).toBe('#in');
    });

    it('redacts safari_set_cookie value param', () => {
      const redacted = TraceCollector.redactParams('safari_set_cookie', { name: 'tok', value: 'abc' });
      expect(redacted.value).toBe('[REDACTED]');
    });

    it('redacts safari_clipboard_write content param', () => {
      const redacted = TraceCollector.redactParams('safari_clipboard_write', { content: 'pwd' });
      expect(redacted.content).toBe('[REDACTED]');
    });

    it('truncates safari_evaluate script to 200 chars', () => {
      const longScript = 'x'.repeat(500);
      const redacted = TraceCollector.redactParams('safari_evaluate', { script: longScript });
      expect((redacted.script as string).length).toBeLessThanOrEqual(203); // 200 + "..."
    });

    it('does not redact params for other tools', () => {
      const redacted = TraceCollector.redactParams('safari_click', { selector: '#btn', timeout: 5000 });
      expect(redacted).toEqual({ selector: '#btn', timeout: 5000 });
    });
  });

  describe('result summarization', () => {
    it('summarizes snapshot results', () => {
      const data = { snapshot: 'y'.repeat(1000), elementCount: 42, interactiveCount: 10 };
      const summary = TraceCollector.summarizeResult('safari_snapshot', data);
      expect(summary.summary).toContain('42');
      expect(summary.summary).toContain('10');
      expect(summary.snapshot).toBeDefined();
      expect(summary.snapshot!.elementCount).toBe(42);
      expect(summary.snapshot!.truncatedSnapshot.length).toBeLessThanOrEqual(500);
    });

    it('summarizes click results', () => {
      const data = { clicked: true, element: { tagName: 'BUTTON', id: 'submit' } };
      const summary = TraceCollector.summarizeResult('safari_click', data);
      expect(summary.summary).toContain('clicked');
      expect(summary.summary).toContain('BUTTON');
    });

    it('summarizes error results', () => {
      const summary = TraceCollector.summarizeError(new Error('Element not found: #missing'));
      expect(summary.error).toBeDefined();
      expect(summary.error!.message).toContain('#missing');
    });
  });

  describe('wrapToolModule', () => {
    it('intercepts handler calls and records trace events', async () => {
      const mockModule = {
        getHandler: vi.fn((name: string) => {
          if (name === 'safari_get_text') {
            return async (params: Record<string, unknown>) => ({
              content: [{ type: 'text' as const, text: JSON.stringify({ text: 'Hello', length: 5 }) }],
              metadata: { engine: 'applescript' as const, degraded: false, latencyMs: 50 },
            });
          }
          return undefined;
        }),
      };

      collector.wrapToolModule(mockModule, 'extraction');
      collector.startSession('test-wrap', 'Suite');

      const handler = mockModule.getHandler('safari_get_text')!;
      await handler({ tabUrl: 'https://example.com/', selector: 'h1' });

      const session = collector.getCurrentSession()!;
      expect(session.events).toHaveLength(1);

      const event = session.events[0];
      expect(event.tool).toBe('safari_get_text');
      expect(event.success).toBe(true);
      expect(event.targeting.method).toBe('selector');
      expect(event.targeting.selector).toBe('h1');
      expect(event.engine).toBe('applescript');
      expect(event.domain).toBe('example.com');
      expect(event.timing.total_ms).toBeGreaterThanOrEqual(0);
      expect(event.timing.engine_ms).toBe(50);
      expect(event.seq).toBe(1);
    });

    it('records failure events', async () => {
      const mockModule = {
        getHandler: vi.fn(() => {
          return async () => { throw new Error('Element not found'); };
        }),
      };

      collector.wrapToolModule(mockModule, 'interaction');
      collector.startSession('test-fail', 'Suite');

      const handler = mockModule.getHandler('safari_click')!;
      await expect(handler({ tabUrl: 'https://x.com/', ref: 'e5' })).rejects.toThrow();

      const event = collector.getCurrentSession()!.events[0];
      expect(event.success).toBe(false);
      expect(event.result.error).toBeDefined();
      expect(event.targeting.method).toBe('ref');
      expect(event.targeting.ref).toBe('e5');
    });
  });

  describe('wrapServer', () => {
    it('intercepts executeToolWithSecurity and records events', async () => {
      const mockServer = {
        executeToolWithSecurity: vi.fn(async () => ({
          content: [{ type: 'text' as const, text: '{"tabs":[]}' }],
          metadata: { engine: 'daemon' as const, degraded: false, latencyMs: 5 },
        })),
      };

      collector.wrapServer(mockServer);
      collector.startSession('test-server', 'Suite');

      await mockServer.executeToolWithSecurity('safari_list_tabs', {});

      const event = collector.getCurrentSession()!.events[0];
      expect(event.tool).toBe('safari_list_tabs');
      expect(event.engine).toBe('daemon');
      expect(event.success).toBe(true);
    });
  });

  describe('unwrap', () => {
    it('restores original methods', () => {
      const original = vi.fn(() => async () => ({
        content: [{ type: 'text' as const, text: '{}' }],
        metadata: { engine: 'applescript' as const, degraded: false, latencyMs: 0 },
      }));
      const mockModule = { getHandler: original };

      collector.wrapToolModule(mockModule, 'test');
      expect(mockModule.getHandler).not.toBe(original);

      collector.unwrap();
      expect(mockModule.getHandler).toBe(original);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/trace-collector.test.ts`
Expected: FAIL — static methods not defined, wrapToolModule not implemented

- [ ] **Step 3: Implement event creation helpers, redaction, summarization, and wrapping**

Add to `src/trace-collector.ts` in the `TraceCollector` class — replace the stub `wrapToolModule`, `wrapServer`, and `unwrap` methods, and add static helpers:

```typescript
  // ── Static helpers for event construction ─────────────────────────────────

  static extractTargeting(params: Record<string, unknown>): TraceEvent['targeting'] {
    if (params['ref'] && typeof params['ref'] === 'string') {
      return { method: 'ref', ref: params['ref'] as string, selector: params['selector'] as string | undefined };
    }
    const locatorKeys = ['role', 'name', 'text', 'label', 'testId', 'placeholder'] as const;
    const locator: Record<string, unknown> = {};
    let hasLocator = false;
    for (const key of locatorKeys) {
      if (params[key] !== undefined && params[key] !== null) {
        locator[key] = params[key];
        hasLocator = true;
      }
    }
    if (params['exact'] !== undefined) locator['exact'] = params['exact'];
    if (hasLocator) {
      return { method: 'locator', locator: locator as TraceEvent['targeting']['locator'], selector: params['selector'] as string | undefined };
    }
    if (params['selector'] && typeof params['selector'] === 'string') {
      return { method: 'selector', selector: params['selector'] as string };
    }
    return { method: 'none' };
  }

  static redactParams(tool: string, params: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...params };
    if ((tool === 'safari_fill' || tool === 'safari_set_cookie') && 'value' in copy) {
      copy['value'] = '[REDACTED]';
    }
    if (tool === 'safari_clipboard_write' && 'content' in copy) {
      copy['content'] = '[REDACTED]';
    }
    if (tool === 'safari_evaluate' && typeof copy['script'] === 'string') {
      const script = copy['script'] as string;
      copy['script'] = script.length > 200 ? script.substring(0, 200) + '...' : script;
    }
    return copy;
  }

  static summarizeResult(tool: string, data: Record<string, unknown>): {
    summary: string;
    data?: unknown;
    snapshot?: TraceEvent['snapshot'];
  } {
    if (tool === 'safari_snapshot') {
      const snap = data['snapshot'] as string | undefined;
      const elCount = data['elementCount'] as number | undefined;
      const intCount = data['interactiveCount'] as number | undefined;
      const refMap = data['refMap'] as Record<string, string> | undefined;
      const refCount = refMap ? Object.keys(refMap).length : 0;
      const format = (snap && snap.startsWith('{')) ? 'json' : 'yaml';
      return {
        summary: `${elCount ?? 0} elements, ${intCount ?? 0} interactive, ${refCount} refs`,
        data: undefined,
        snapshot: {
          elementCount: elCount ?? 0,
          interactiveCount: intCount ?? 0,
          refCount,
          format: format as 'yaml' | 'json',
          truncatedSnapshot: (snap ?? '').substring(0, 500),
        },
      };
    }
    const summary = JSON.stringify(data).substring(0, 200);
    return { summary, data };
  }

  static summarizeError(error: unknown): {
    summary: string;
    error: { code: string; message: string; hints: string[] };
  } {
    const msg = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string })?.code ?? 'ERROR';
    return {
      summary: `error: ${msg.substring(0, 200)}`,
      error: { code, message: msg, hints: [] },
    };
  }

  static extractDomain(params: Record<string, unknown>): string {
    const url = (params['tabUrl'] ?? params['url'] ?? '') as string;
    try { return new URL(url || 'about:blank').hostname; } catch { return ''; }
  }

  // ── Wrapping ──────────────────────────────────────────────────────────────

  wrapToolModule(module: { getHandler: (name: string) => ((...args: unknown[]) => Promise<unknown>) | undefined }, _moduleName: string): void {
    const originalGetHandler = module.getHandler.bind(module);
    const self = this;

    module.getHandler = function wrappedGetHandler(toolName: string) {
      const originalHandler = originalGetHandler(toolName);
      if (!originalHandler) return undefined;

      return async function tracedHandler(params: Record<string, unknown>) {
        const start = Date.now();
        const seq = self.nextSeq();
        try {
          const result = await originalHandler(params) as { content: Array<{ type: string; text?: string }>; metadata: { engine: string; degraded: boolean; latencyMs: number; degradedReason?: string } };
          const resultData = result.content[0]?.text ? JSON.parse(result.content[0].text) : {};
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
            engine: 'applescript',
            degraded: false,
            domain: TraceCollector.extractDomain(params),
            tabUrl: params['tabUrl'] as string | undefined,
          };
          self.recordEvent(event);
          throw error;
        }
      } as unknown as (...args: unknown[]) => Promise<unknown>;
    } as typeof module.getHandler;

    self.unwrapFns.push(() => { module.getHandler = originalGetHandler as typeof module.getHandler; });
  }

  wrapServer(server: { executeToolWithSecurity: (name: string, params: Record<string, unknown>) => Promise<unknown> }): void {
    const original = server.executeToolWithSecurity.bind(server);
    const self = this;

    server.executeToolWithSecurity = async function tracedExecute(name: string, params: Record<string, unknown>) {
      const start = Date.now();
      const seq = self.nextSeq();
      try {
        const result = await original(name, params) as { content: Array<{ type: string; text?: string }>; metadata: { engine: string; degraded: boolean; latencyMs: number; degradedReason?: string } };
        const resultData = result.content[0]?.text ? JSON.parse(result.content[0].text) : {};
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
          engine: 'applescript',
          degraded: false,
          domain: TraceCollector.extractDomain(params),
          tabUrl: params['tabUrl'] as string | undefined,
        };
        self.recordEvent(event);
        throw error;
      }
    } as typeof server.executeToolWithSecurity;

    self.unwrapFns.push(() => { server.executeToolWithSecurity = original as typeof server.executeToolWithSecurity; });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/trace-collector.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/trace-collector.ts test/unit/trace-collector.test.ts
git commit -m "feat(trace): event creation, redaction, summarization, monkey-patch wrapping"
```

---

### Task 3: Flush to disk and environment metadata

**Files:**
- Modify: `src/trace-collector.ts`
- Test: `test/unit/trace-collector.test.ts`

- [ ] **Step 1: Write failing tests for flush and environment**

Add to `test/unit/trace-collector.test.ts`:

```typescript
  describe('flush', () => {
    it('is a no-op when there are zero sessions', async () => {
      const path = await collector.flush('/tmp/test-traces');
      expect(path).toBe('');
    });

    it('writes a valid TraceRun JSON file', async () => {
      const { readFile, rm } = await import('node:fs/promises');
      const outputDir = `/tmp/trace-test-${Date.now()}`;

      collector.startSession('test-1', 'Suite A');
      collector.endSession(true);

      const filePath = await collector.flush(outputDir);
      expect(filePath).toBeTruthy();
      expect(filePath).toMatch(/\.json$/);

      const content = await readFile(filePath, 'utf-8');
      const run: TraceRun = JSON.parse(content);

      expect(run.runId).toBe('test-run-001');
      expect(run.type).toBe('integration');
      expect(run.sessions).toHaveLength(1);
      expect(run.sessions[0].testId).toBe('test-1');
      expect(run.summary.total).toBe(1);
      expect(run.summary.passed).toBe(1);
      expect(run.environment.nodeVersion).toBeTruthy();
      expect(run.environment.platform).toBe(process.platform);

      await rm(outputDir, { recursive: true }).catch(() => {});
    });

    it('computes run summary statistics correctly', async () => {
      const { readFile, rm } = await import('node:fs/promises');
      const outputDir = `/tmp/trace-test-${Date.now()}`;

      collector.startSession('test-1', 'Suite');
      collector.endSession(true);
      collector.startSession('test-2', 'Suite');
      collector.endSession(false, 'timeout');
      collector.startSession('test-3', 'Suite');
      collector.endSession(true);

      const filePath = await collector.flush(outputDir);
      const run: TraceRun = JSON.parse(await readFile(filePath, 'utf-8'));

      expect(run.summary.total).toBe(3);
      expect(run.summary.passed).toBe(2);
      expect(run.summary.failed).toBe(1);

      await rm(outputDir, { recursive: true }).catch(() => {});
    });

    it('file name contains timestamp and git commit', async () => {
      const { rm } = await import('node:fs/promises');
      const outputDir = `/tmp/trace-test-${Date.now()}`;

      collector.startSession('test-1', 'Suite');
      collector.endSession(true);

      const filePath = await collector.flush(outputDir);
      const fileName = filePath.split('/').pop()!;
      expect(fileName).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9]+\.json$/);

      await rm(outputDir, { recursive: true }).catch(() => {});
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/trace-collector.test.ts`
Expected: FAIL — flush returns empty string

- [ ] **Step 3: Implement flush and environment metadata**

Replace the stub `flush` method in `src/trace-collector.ts`:

```typescript
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

    const ts = env.timestamp.replace(/:/g, '-').replace(/\.\d+Z$/, '');
    const fileName = `${ts}-${env.gitCommit}.json`;
    const filePath = join(outputDir, fileName);
    await writeFile(filePath, JSON.stringify(run, null, 2), 'utf-8');
    return filePath;
  }

  private static getEnvironment(): TraceRun['environment'] {
    let gitCommit = 'unknown';
    let gitBranch = 'unknown';
    try { gitCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { timeout: 3000 }).toString().trim(); } catch {}
    try { gitBranch = execFileSync('git', ['branch', '--show-current'], { timeout: 3000 }).toString().trim(); } catch {}

    let safariPilotVersion = 'unknown';
    try { safariPilotVersion = require(join(process.cwd(), 'package.json')).version; } catch {}

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

  private computeRunSummary(): TraceRun['summary'] {
    const passed = this.sessions.filter(s => s.success).length;
    const failed = this.sessions.filter(s => !s.success).length;
    const totalMs = this.sessions.reduce((sum, s) => sum + s.durationMs, 0);
    const allDomains = new Set<string>();
    const allTools = new Set<string>();
    let totalEvents = 0, refEvents = 0, locatorEvents = 0, awEvents = 0;

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
      skipped: 0,
      totalMs,
      domainsTestedOnce: [...allDomains],
      toolsUsedAtLeastOnce: [...allTools],
      avgStepsPerTest: this.sessions.length > 0 ? totalEvents / this.sessions.length : 0,
      avgMsPerTest: this.sessions.length > 0 ? totalMs / this.sessions.length : 0,
      refTargetingUsage: totalEvents > 0 ? refEvents / totalEvents : 0,
      locatorTargetingUsage: totalEvents > 0 ? locatorEvents / totalEvents : 0,
      autoWaitUsage: totalEvents > 0 ? awEvents / totalEvents : 0,
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/trace-collector.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run type-check**

Run: `npx tsc --noEmit`
Expected: Clean (no errors)

- [ ] **Step 6: Commit**

```bash
git add src/trace-collector.ts test/unit/trace-collector.test.ts
git commit -m "feat(trace): flush to disk with environment metadata and run summary"
```

---

### Task 4: Wire TraceCollector into integration tests

**Files:**
- Modify: `test/integration/a11y-targeting-integration.test.ts`
- Create: `benchmark/traces/integration/.gitkeep`

- [ ] **Step 1: Create trace directory structure**

```bash
mkdir -p benchmark/traces/integration benchmark/traces/e2e
touch benchmark/traces/integration/.gitkeep benchmark/traces/e2e/.gitkeep
```

- [ ] **Step 2: Add TraceCollector import and wiring to integration test file**

At the top of `test/integration/a11y-targeting-integration.test.ts`, add the import:

```typescript
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest';
```

(Add `beforeEach` and `afterEach` to the existing import if not already there.)

```typescript
import { TraceCollector } from '../../src/trace-collector.js';
```

After the tool module instantiation (after `const interact = new InteractionTools(engine);`), add:

```typescript
// ── Trace capture ────────────────────────────────────────────────────────────

let trace: TraceCollector;

if (safariAvailable) {
  trace = new TraceCollector({
    runId: `integ-${Date.now()}`,
    type: 'integration',
    testFile: 'test/integration/a11y-targeting-integration.test.ts',
  });
  trace.wrapToolModule(extract as any, 'extraction');
  trace.wrapToolModule(interact as any, 'interaction');
  trace.wrapToolModule(nav as any, 'navigation');
}

beforeEach((ctx) => {
  if (!safariAvailable || !trace) return;
  const suiteName = ctx.task.suite?.name ?? 'unknown';
  trace.startSession(ctx.task.name, suiteName, ctx.task.name);
});

afterEach((ctx) => {
  if (!safariAvailable || !trace) return;
  const passed = ctx.task.result?.state === 'pass';
  const errorMsg = ctx.task.result?.errors?.[0]?.message;
  trace.endSession(passed, errorMsg);
});
```

In the existing `afterAll`, add before the closing:

```typescript
afterAll(async () => {
  for (const url of openTabUrls) {
    try { await closeTab(url); } catch {}
  }
  if (safariAvailable && trace) {
    trace.unwrap();
    const tracePath = await trace.flush('benchmark/traces/integration');
    if (tracePath) console.log(`\nTrace written to: ${tracePath}`);
  }
});
```

- [ ] **Step 3: Run type-check**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 4: Run unit tests to verify no regressions**

Run: `npx vitest run test/unit/`
Expected: All 1107+ tests pass

- [ ] **Step 5: Commit**

```bash
git add benchmark/traces/ test/integration/a11y-targeting-integration.test.ts
git commit -m "feat(trace): wire TraceCollector into integration tests"
```

---

### Task 5: Wire TraceCollector into e2e tests

**Files:**
- Modify: `test/e2e/a11y-targeting-e2e.test.ts`

- [ ] **Step 1: Add TraceCollector import and wiring to e2e test file**

Add `beforeEach, afterEach` to the vitest import. Add TraceCollector import:

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
```

```typescript
import { TraceCollector } from '../../src/trace-collector.js';
```

After `let server: SafariPilotServer;`, add:

```typescript
let trace: TraceCollector;
```

In the existing `beforeAll`, after `server.initialize()`, add:

```typescript
  if (safariAvailable) {
    trace = new TraceCollector({
      runId: `e2e-${Date.now()}`,
      type: 'e2e',
      testFile: 'test/e2e/a11y-targeting-e2e.test.ts',
    });
    trace.wrapServer(server as any);
  }
```

Add `beforeEach` and `afterEach` at file level (after `afterAll`):

```typescript
beforeEach((ctx) => {
  if (!safariAvailable || !trace) return;
  const suiteName = ctx.task.suite?.name ?? 'unknown';
  trace.startSession(ctx.task.name, suiteName, ctx.task.name);
});

afterEach((ctx) => {
  if (!safariAvailable || !trace) return;
  const passed = ctx.task.result?.state === 'pass';
  const errorMsg = ctx.task.result?.errors?.[0]?.message;
  trace.endSession(passed, errorMsg);
});
```

In the existing `afterAll`, add after tab cleanup and before `server.shutdown()`:

```typescript
  if (safariAvailable && trace) {
    trace.unwrap();
    const tracePath = await trace.flush('benchmark/traces/e2e');
    if (tracePath) console.log(`\nTrace written to: ${tracePath}`);
  }
```

- [ ] **Step 2: Run type-check**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Run unit tests to verify no regressions**

Run: `npx vitest run test/unit/`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add test/e2e/a11y-targeting-e2e.test.ts
git commit -m "feat(trace): wire TraceCollector into e2e tests"
```

---

### Task 6: Verify end-to-end trace generation

**Files:**
- No new files — run existing tests and verify trace output

- [ ] **Step 1: Run the integration tests locally (requires Safari)**

Run: `npx vitest run test/integration/a11y-targeting-integration.test.ts`

Expected: Tests run (pass or fail), AND a message at the end:
```
Trace written to: benchmark/traces/integration/2026-04-13T...-XXXXXXX.json
```

- [ ] **Step 2: Verify the trace file is valid**

```bash
node -e "
const trace = require('./benchmark/traces/integration/$(ls benchmark/traces/integration/*.json | head -1 | xargs basename)');
console.log('Run ID:', trace.runId);
console.log('Sessions:', trace.sessions.length);
console.log('Environment:', JSON.stringify(trace.environment, null, 2));
console.log('Summary:', JSON.stringify(trace.summary, null, 2));
if (trace.sessions[0]) {
  console.log('First session events:', trace.sessions[0].events.length);
  if (trace.sessions[0].events[0]) {
    console.log('First event:', JSON.stringify(trace.sessions[0].events[0], null, 2));
  }
}
"
```

Verify:
- `runId` starts with `integ-`
- `sessions` array has entries (one per test that ran)
- `environment` has real git commit and node version
- Events have populated targeting, timing, engine fields

- [ ] **Step 3: Run the CI-safe unit tests to verify nothing broke**

Run: `npx vitest run test/unit/`
Expected: All tests pass, zero regressions

- [ ] **Step 4: Run type-check**

Run: `npx tsc --noEmit`
Expected: Clean

- [ ] **Step 5: Final commit — add initial trace files and push**

```bash
git add benchmark/traces/ src/trace-collector.ts test/
git commit -m "feat(trace): verified trace generation — integration + e2e wired

TraceCollector captures every tool call during test runs:
- 3-level schema: TraceEvent → TraceSession → TraceRun
- Targeting method, auto-wait details, timing breakdown, engine usage
- Snapshot metrics, error hints, domain observations
- Sensitive data redaction matching AuditLog rules
- Git-tracked JSON output in benchmark/traces/
- Wired into integration tests (handler-direct) and e2e tests (server pipeline)
- Zero changes to production code"

git push origin main
```
