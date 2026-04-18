import type { ToolResponse, ToolRequirements } from '../types.js';
import type { IEngine } from '../engines/engine.js';
import type { ToolDefinition } from './navigation.js';

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

/**
 * JS that starts a performance trace.
 * Sets a mark and installs PerformanceObserver listeners for longtasks,
 * layout-shift, largest-contentful-paint, and resource timing.
 * Stores buffered entries on window.__safariPilotTrace so end_trace can collect them.
 */
const BEGIN_TRACE_JS = `
(function () {
  performance.mark('safari_pilot_trace_start');
  const store = {
    startTime: performance.now(),
    longTasks: [],
    layoutShifts: [],
    lcpEntries: [],
    resources: [],
  };
  window.__safariPilotTrace = store;

  const observe = (types, callback) => {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) callback(entry);
      });
      obs.observe({ type: types[0], buffered: true });
      return obs;
    } catch (_) { return null; }
  };

  observe(['longtask'], (e) => store.longTasks.push({ start: e.startTime, duration: e.duration }));
  observe(['layout-shift'], (e) => store.layoutShifts.push({ start: e.startTime, value: e.value }));
  observe(['largest-contentful-paint'], (e) => store.lcpEntries.push({ start: e.startTime, size: e.size, url: e.url }));
  observe(['resource'], (e) => store.resources.push({ name: e.name, duration: e.duration, transferSize: e.transferSize }));

  return JSON.stringify({ tracing: true, startTime: store.startTime });
})()
`.trim();

/**
 * JS that ends the trace and returns all collected metrics.
 */
const END_TRACE_JS = `
(function () {
  performance.mark('safari_pilot_trace_end');
  try {
    performance.measure('safari_pilot_trace', 'safari_pilot_trace_start', 'safari_pilot_trace_end');
  } catch (_) {}

  const store = window.__safariPilotTrace ?? { longTasks: [], layoutShifts: [], lcpEntries: [], resources: [] };
  const traceMs = performance.now() - (store.startTime ?? 0);

  const marks = performance.getEntriesByType('mark').map(m => ({ name: m.name, time: m.startTime }));
  const measures = performance.getEntriesByType('measure').map(m => ({ name: m.name, duration: m.duration }));

  delete window.__safariPilotTrace;

  return JSON.stringify({
    traceMs,
    marks,
    measures,
    longTasks: store.longTasks,
    layoutShifts: store.layoutShifts,
    lcpEntries: store.lcpEntries,
    resourceCount: store.resources.length,
    topResources: store.resources
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10),
  });
})()
`.trim();

/**
 * JS that reads current page performance metrics without starting a trace.
 * Collects Navigation Timing, Paint Timing (FCP, LCP), and CLS.
 */
const GET_PAGE_METRICS_JS = `
(function () {
  const nav = performance.getEntriesByType('navigation')[0] ?? {};
  const paint = {};
  for (const entry of performance.getEntriesByType('paint')) {
    paint[entry.name] = entry.startTime;
  }

  // LCP: last largest-contentful-paint entry
  const lcpAll = performance.getEntriesByType('largest-contentful-paint');
  const lcp = lcpAll.length ? lcpAll[lcpAll.length - 1].startTime : null;

  // CLS: sum of layout-shift values (if buffered entries available)
  let cls = 0;
  for (const e of performance.getEntriesByType('layout-shift')) {
    if (!e.hadRecentInput) cls += e.value;
  }

  const metrics = {
    // Navigation Timing (PerformanceNavigationTiming)
    domainLookupMs: (nav.domainLookupEnd ?? 0) - (nav.domainLookupStart ?? 0),
    connectMs: (nav.connectEnd ?? 0) - (nav.connectStart ?? 0),
    ttfbMs: (nav.responseStart ?? 0) - (nav.requestStart ?? 0),
    responseMs: (nav.responseEnd ?? 0) - (nav.responseStart ?? 0),
    domInteractiveMs: nav.domInteractive ?? null,
    domCompleteMs: nav.domComplete ?? null,
    loadEventEndMs: nav.loadEventEnd ?? null,
    // Paint timings
    fcpMs: paint['first-contentful-paint'] ?? null,
    lcpMs: lcp,
    // Layout stability
    cls: parseFloat(cls.toFixed(4)),
    // Transfer
    transferSizeBytes: nav.transferSize ?? null,
    encodedBodySizeBytes: nav.encodedBodySize ?? null,
  };

  return JSON.stringify(metrics);
})()
`.trim();

export class PerformanceTools {
  constructor(private readonly engine: IEngine) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_begin_trace',
        description:
          'Start a performance trace in the specified tab. ' +
          'Marks the trace start with performance.mark() and installs PerformanceObserver listeners ' +
          'for long tasks, layout shifts, LCP, and resource timing. ' +
          'Call safari_end_trace when done to collect results.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab to trace' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false } as ToolRequirements,
      },
      {
        name: 'safari_end_trace',
        description:
          'End an active performance trace and return collected metrics. ' +
          'Returns marks, measures, long tasks, layout shifts, LCP entries, and top slow resources. ' +
          'Must be called after safari_begin_trace.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab being traced' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false } as ToolRequirements,
      },
      {
        name: 'safari_get_page_metrics',
        description:
          'Get current page performance metrics without starting a trace. ' +
          'Returns Navigation Timing (TTFB, DOM interactive, load), Paint Timing (FCP, LCP), ' +
          'Cumulative Layout Shift (CLS), and transfer sizes.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab to measure' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true } as ToolRequirements,
      },
    ];
  }

  getHandler(name: string): Handler {
    switch (name) {
      case 'safari_begin_trace':
        return (p) => this.handleBeginTrace(p);
      case 'safari_end_trace':
        return (p) => this.handleEndTrace(p);
      case 'safari_get_page_metrics':
        return (p) => this.handleGetPageMetrics(p);
      default:
        throw new Error(`PerformanceTools: unknown tool "${name}"`);
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleBeginTrace(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    const result = await this.engine.executeJsInTab(tabUrl, BEGIN_TRACE_JS);

    if (!result.ok) {
      return this.errorResponse(result.error?.message ?? 'Failed to begin trace', start);
    }

    const data = this.parseJson(result.value) ?? { tracing: false };
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handleEndTrace(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    const result = await this.engine.executeJsInTab(tabUrl, END_TRACE_JS);

    if (!result.ok) {
      return this.errorResponse(result.error?.message ?? 'Failed to end trace', start);
    }

    const data = this.parseJson(result.value) ?? { traceMs: 0, longTasks: [], layoutShifts: [] };
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handleGetPageMetrics(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    const result = await this.engine.executeJsInTab(tabUrl, GET_PAGE_METRICS_JS);

    if (!result.ok) {
      return this.errorResponse(result.error?.message ?? 'Failed to get page metrics', start);
    }

    const data = this.parseJson(result.value) ?? {};
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private parseJson(value?: string): Record<string, unknown> | undefined {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  private errorResponse(message: string, start: number): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      metadata: { engine: 'applescript', degraded: true, latencyMs: Date.now() - start },
    };
  }
}
