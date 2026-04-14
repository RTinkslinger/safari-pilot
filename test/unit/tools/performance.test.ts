import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PerformanceTools } from '../../../src/tools/performance.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { EngineResult } from '../../../src/types.js';

// ── Mock factory ─────────────────────────────────────────────────────────────

function makeEngine(overrides: Partial<{
  executeJsInTab: (tabUrl: string, jsCode: string, timeout?: number) => Promise<EngineResult>;
}>): IEngine {
  return {
    name: 'applescript',
    execute: vi.fn().mockResolvedValue({ ok: true, value: '', elapsed_ms: 1 }),
    executeJsInTab: vi.fn().mockResolvedValue({ ok: true, value: '', elapsed_ms: 1 }),
    isAvailable: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as IEngine;
}

function okResult(value: string): EngineResult {
  return { ok: true, value, elapsed_ms: 1 };
}

function errResult(code: string, message: string): EngineResult {
  return { ok: false, error: { code, message, retryable: false }, elapsed_ms: 1 };
}

// ── Tool registration ────────────────────────────────────────────────────────

describe('PerformanceTools - registration', () => {
  let tools: PerformanceTools;

  beforeEach(() => {
    tools = new PerformanceTools(makeEngine({}));
  });

  it('registers exactly 3 tools', () => {
    expect(tools.getDefinitions()).toHaveLength(3);
  });

  it('all tool names have the "safari_" prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });

  it('registers safari_begin_trace', () => {
    const names = tools.getDefinitions().map((d) => d.name);
    expect(names).toContain('safari_begin_trace');
  });

  it('registers safari_end_trace', () => {
    const names = tools.getDefinitions().map((d) => d.name);
    expect(names).toContain('safari_end_trace');
  });

  it('registers safari_get_page_metrics', () => {
    const names = tools.getDefinitions().map((d) => d.name);
    expect(names).toContain('safari_get_page_metrics');
  });

  it('all tools require tabUrl', () => {
    for (const def of tools.getDefinitions()) {
      expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
    }
  });

  it('getHandler throws for unknown tool name', () => {
    expect(() => tools.getHandler('safari_unknown')).toThrow(/unknown tool/);
  });
});

// ── safari_begin_trace ───────────────────────────────────────────────────────

describe('safari_begin_trace', () => {
  it('returns tracing: true on success', async () => {
    const payload = JSON.stringify({ tracing: true, startTime: 1234.56 });
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(payload)),
    });
    const tools = new PerformanceTools(engine);
    const handler = tools.getHandler('safari_begin_trace');
    const response = await handler({ tabUrl: 'https://example.com' });

    expect(engine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.tracing).toBe(true);
    expect(data.startTime).toBe(1234.56);
    expect(response.metadata.engine).toBe('applescript');
    expect(response.metadata.degraded).toBe(false);
  });

  it('includes performance.mark call in the JS', async () => {
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(JSON.stringify({ tracing: true, startTime: 0 }))),
    });
    const tools = new PerformanceTools(engine);
    const handler = tools.getHandler('safari_begin_trace');
    await handler({ tabUrl: 'https://example.com' });

    const jsArg = (engine.executeJsInTab as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(jsArg).toContain('safari_pilot_trace_start');
    expect(jsArg).toContain('PerformanceObserver');
  });

  it('returns degraded response on engine error', async () => {
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(errResult('SAFARI_NOT_RUNNING', 'Safari not running')),
    });
    const tools = new PerformanceTools(engine);
    const handler = tools.getHandler('safari_begin_trace');
    const response = await handler({ tabUrl: 'https://example.com' });

    expect(response.metadata.degraded).toBe(true);
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.error).toBeTruthy();
  });
});

// ── safari_end_trace ─────────────────────────────────────────────────────────

describe('safari_end_trace', () => {
  it('returns trace metrics with marks, measures, and longTasks', async () => {
    const traceData = {
      traceMs: 2500,
      marks: [{ name: 'safari_pilot_trace_start', time: 0 }],
      measures: [{ name: 'safari_pilot_trace', duration: 2500 }],
      longTasks: [{ start: 100, duration: 80 }],
      layoutShifts: [],
      lcpEntries: [{ start: 500, size: 1200, url: 'https://example.com/hero.jpg' }],
      resourceCount: 3,
      topResources: [],
    };
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(JSON.stringify(traceData))),
    });
    const tools = new PerformanceTools(engine);
    const handler = tools.getHandler('safari_end_trace');
    const response = await handler({ tabUrl: 'https://example.com' });

    expect(engine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.traceMs).toBe(2500);
    expect(data.marks).toHaveLength(1);
    expect(data.longTasks).toHaveLength(1);
    expect(data.lcpEntries[0].url).toBe('https://example.com/hero.jpg');
    expect(response.metadata.degraded).toBe(false);
  });

  it('includes safari_pilot_trace_end mark in the JS', async () => {
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(JSON.stringify({ traceMs: 0 }))),
    });
    const tools = new PerformanceTools(engine);
    const handler = tools.getHandler('safari_end_trace');
    await handler({ tabUrl: 'https://example.com' });

    const jsArg = (engine.executeJsInTab as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(jsArg).toContain('safari_pilot_trace_end');
  });

  it('returns degraded response on engine error', async () => {
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(errResult('ELEMENT_NOT_FOUND', 'Tab not found')),
    });
    const tools = new PerformanceTools(engine);
    const handler = tools.getHandler('safari_end_trace');
    const response = await handler({ tabUrl: 'https://example.com' });

    expect(response.metadata.degraded).toBe(true);
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.error).toBeTruthy();
  });
});

// ── safari_get_page_metrics ──────────────────────────────────────────────────

describe('safari_get_page_metrics', () => {
  it('returns navigation timing and paint metrics', async () => {
    const metrics = {
      domainLookupMs: 5,
      connectMs: 20,
      ttfbMs: 120,
      responseMs: 30,
      domInteractiveMs: 800,
      domCompleteMs: 1200,
      loadEventEndMs: 1250,
      fcpMs: 700,
      lcpMs: 950,
      cls: 0.05,
      transferSizeBytes: 45000,
      encodedBodySizeBytes: 40000,
    };
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(JSON.stringify(metrics))),
    });
    const tools = new PerformanceTools(engine);
    const handler = tools.getHandler('safari_get_page_metrics');
    const response = await handler({ tabUrl: 'https://example.com' });

    expect(engine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.ttfbMs).toBe(120);
    expect(data.fcpMs).toBe(700);
    expect(data.lcpMs).toBe(950);
    expect(data.cls).toBe(0.05);
    expect(response.metadata.engine).toBe('applescript');
    expect(response.metadata.degraded).toBe(false);
  });

  it('reads navigation timing, paint timing, and CLS from the JS', async () => {
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult(JSON.stringify({}))),
    });
    const tools = new PerformanceTools(engine);
    const handler = tools.getHandler('safari_get_page_metrics');
    await handler({ tabUrl: 'https://example.com' });

    const jsArg = (engine.executeJsInTab as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(jsArg).toContain('navigation');
    expect(jsArg).toContain('first-contentful-paint');
    expect(jsArg).toContain('layout-shift');
  });

  it('returns empty object as fallback when engine returns empty value', async () => {
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(okResult('')),
    });
    const tools = new PerformanceTools(engine);
    const handler = tools.getHandler('safari_get_page_metrics');
    const response = await handler({ tabUrl: 'https://example.com' });

    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data).toBeDefined();
    expect(response.metadata.degraded).toBe(false);
  });

  it('returns degraded response on engine error', async () => {
    const engine = makeEngine({
      executeJsInTab: vi.fn().mockResolvedValue(errResult('SAFARI_CRASHED', 'Safari crashed')),
    });
    const tools = new PerformanceTools(engine);
    const handler = tools.getHandler('safari_get_page_metrics');
    const response = await handler({ tabUrl: 'https://example.com' });

    expect(response.metadata.degraded).toBe(true);
    const data = JSON.parse(response.content[0].text ?? '{}');
    expect(data.error).toBeTruthy();
  });
});
