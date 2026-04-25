import type { ToolResponse, ToolRequirements } from '../types.js';
import type { AppleScriptEngine } from '../engines/applescript.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

// ── Types ────────────────────────────────────────────────────────────────────

export interface FlowStep {
  action: 'navigate' | 'click' | 'fill' | 'wait' | 'assert';
  selector?: string;
  value?: string;
  assert?: { type: 'text' | 'element' | 'url'; expected: string };
}

export interface FlowStepResult {
  step: number;
  result: string;
  passed: boolean;
}

export interface TestFlowResult {
  passed: boolean;
  steps: FlowStepResult[];
  failedAt?: number;
  screenshot?: string;
}

export interface PageChange {
  check: number;
  timestamp: string;
  diff: string;
}

export interface MonitorResult {
  changes: PageChange[];
  checksPerformed: number;
  finalSnapshot?: string;
}

export interface ScrapedPage {
  pageNum: number;
  url: string;
  data: unknown;
}

export interface PaginateResult {
  pages: ScrapedPage[];
  totalPages: number;
  /** T19: surfaced when pagination bails early (e.g. stale-URL post-navigation tracking failure). */
  warnings?: string[];
}

export interface MediaState {
  action: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  muted: boolean;
  volume: number;
  playbackRate: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const WAIT_NAVIGATE_MS = 1000;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_CHECKS = 10;
const DEFAULT_MAX_PAGES = 5;

export class CompoundTools {
  constructor(private readonly engine: AppleScriptEngine) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_test_flow',
        description:
          'Execute a sequence of steps (navigate, click, fill, wait, assert) on a page ' +
          'and verify assertions at each step. Returns pass/fail status with per-step results.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab to test in' },
            steps: {
              type: 'array',
              description: 'Ordered list of steps to execute',
              items: {
                type: 'object',
                properties: {
                  action: {
                    type: 'string',
                    enum: ['navigate', 'click', 'fill', 'wait', 'assert'],
                  },
                  selector: { type: 'string', description: 'CSS selector for click/fill/assert steps' },
                  value: { type: 'string', description: 'URL for navigate, text for fill, ms for wait' },
                  assert: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['text', 'element', 'url'] },
                      expected: { type: 'string' },
                    },
                  },
                },
                required: ['action'],
              },
            },
          },
          required: ['tabUrl', 'steps'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_monitor_page',
        description:
          'Watch a page for changes by polling at an interval. Can monitor DOM mutations, ' +
          'text content changes, attribute changes, or network requests. Returns detected diffs.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab to monitor' },
            watch: {
              type: 'string',
              enum: ['dom', 'text', 'attribute', 'network'],
              description: 'What to watch for changes',
            },
            selector: { type: 'string', description: 'CSS selector to scope monitoring (optional)' },
            interval: {
              type: 'number',
              description: 'Poll interval in milliseconds (default 1000)',
              default: 1000,
            },
            maxChecks: {
              type: 'number',
              description: 'Maximum number of poll checks before stopping (default 10)',
              default: 10,
            },
          },
          required: ['tabUrl', 'watch'],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_paginate_scrape',
        description:
          'Follow pagination through a multi-page result set, extracting data from each page. ' +
          'Runs extractScript on each page, then clicks the nextSelector to advance. ' +
          'Returns all collected data with page URLs.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the first page' },
            extractScript: {
              type: 'string',
              description: 'JavaScript to run on each page. Must return the data to collect.',
            },
            nextSelector: {
              type: 'string',
              description: 'CSS selector for the "next page" button or link',
            },
            maxPages: {
              type: 'number',
              description: 'Maximum number of pages to scrape (default 5)',
              default: 5,
            },
          },
          required: ['tabUrl', 'extractScript', 'nextSelector'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_media_control',
        description:
          'Control media playback (video/audio) on a page. Supports play, pause, mute, ' +
          'unmute, seek to a time, and setting playback speed. Returns current media state.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab containing the media' },
            action: {
              type: 'string',
              enum: ['play', 'pause', 'mute', 'unmute', 'seek', 'speed'],
              description: 'Playback control action to execute',
            },
            selector: {
              type: 'string',
              description: 'CSS selector for a specific video/audio element (default: first on page)',
            },
            value: {
              type: 'number',
              description: 'Seek time in seconds (for seek), or speed multiplier (for speed)',
            },
          },
          required: ['tabUrl', 'action'],
        },
        requirements: { idempotent: false },
      },
    ];
  }

  getHandler(name: string): Handler {
    switch (name) {
      case 'safari_test_flow':
        return (p) => this.handleTestFlow(p);
      case 'safari_monitor_page':
        return (p) => this.handleMonitorPage(p);
      case 'safari_paginate_scrape':
        return (p) => this.handlePaginateScrape(p);
      case 'safari_media_control':
        return (p) => this.handleMediaControl(p);
      default:
        throw new Error(`CompoundTools: unknown tool "${name}"`);
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleTestFlow(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const steps = params['steps'] as FlowStep[];

    const stepResults: FlowStepResult[] = [];
    let passed = true;
    let failedAt: number | undefined;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      let stepPassed = true;
      let result = 'ok';

      try {
        switch (step.action) {
          case 'navigate': {
            const url = step.value ?? '';
            const script = this.engine.buildNavigateScript(url);
            const res = await this.engine.execute(script);
            if (!res.ok) {
              stepPassed = false;
              result = res.error?.message ?? 'navigation failed';
            } else {
              await sleep(WAIT_NAVIGATE_MS);
            }
            break;
          }

          case 'click': {
            const clickJs = `
              var el = document.querySelector(${JSON.stringify(step.selector ?? '')});
              if (!el) throw new Error('Element not found: ${step.selector}');
              el.click();
              return 'clicked';
            `;
            const res = await this.engine.executeJsInTab(tabUrl, clickJs);
            if (!res.ok) {
              stepPassed = false;
              result = res.error?.message ?? 'click failed';
            } else {
              result = res.value ?? 'clicked';
            }
            break;
          }

          case 'fill': {
            const fillJs = `
              var el = document.querySelector(${JSON.stringify(step.selector ?? '')});
              if (!el) throw new Error('Element not found: ${step.selector}');
              el.value = ${JSON.stringify(step.value ?? '')};
              el.dispatchEvent(new Event('input', {bubbles: true}));
              el.dispatchEvent(new Event('change', {bubbles: true}));
              return 'filled';
            `;
            const res = await this.engine.executeJsInTab(tabUrl, fillJs);
            if (!res.ok) {
              stepPassed = false;
              result = res.error?.message ?? 'fill failed';
            } else {
              result = res.value ?? 'filled';
            }
            break;
          }

          case 'wait': {
            const ms = parseInt(step.value ?? '500', 10);
            await sleep(isNaN(ms) ? 500 : ms);
            result = `waited ${ms}ms`;
            break;
          }

          case 'assert': {
            const assertion = step.assert;
            if (!assertion) {
              result = 'no assertion defined';
              break;
            }

            if (assertion.type === 'url') {
              const urlJs = 'return location.href';
              const res = await this.engine.executeJsInTab(tabUrl, urlJs);
              const actual = res.value ?? '';
              if (!actual.includes(assertion.expected)) {
                stepPassed = false;
                result = `url assertion failed: expected "${assertion.expected}" in "${actual}"`;
              } else {
                result = `url ok: ${actual}`;
              }
            } else if (assertion.type === 'text') {
              const textJs = `
                var el = ${step.selector
                  ? `document.querySelector(${JSON.stringify(step.selector)})`
                  : 'document.body'};
                if (!el) throw new Error('Element not found');
                return el.textContent || '';
              `;
              const res = await this.engine.executeJsInTab(tabUrl, textJs);
              const actual = res.value ?? '';
              if (!actual.includes(assertion.expected)) {
                stepPassed = false;
                result = `text assertion failed: expected "${assertion.expected}" in content`;
              } else {
                result = `text ok`;
              }
            } else if (assertion.type === 'element') {
              const elJs = `
                var el = document.querySelector(${JSON.stringify(assertion.expected)});
                return el ? 'found' : 'not found';
              `;
              const res = await this.engine.executeJsInTab(tabUrl, elJs);
              if (res.value !== 'found') {
                stepPassed = false;
                result = `element assertion failed: "${assertion.expected}" not found`;
              } else {
                result = `element found: ${assertion.expected}`;
              }
            }
            break;
          }
        }
      } catch (err: unknown) {
        stepPassed = false;
        result = err instanceof Error ? err.message : String(err);
      }

      stepResults.push({ step: i + 1, result, passed: stepPassed });

      if (!stepPassed) {
        passed = false;
        failedAt = i + 1;
        break;
      }
    }

    const data: TestFlowResult = { passed, steps: stepResults };
    if (failedAt !== undefined) data.failedAt = failedAt;

    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: !passed, latencyMs: Date.now() - start },
    };
  }

  private async handleMonitorPage(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const watch = params['watch'] as 'dom' | 'text' | 'attribute' | 'network';
    const selector = params['selector'] as string | undefined;
    const interval = typeof params['interval'] === 'number' ? params['interval'] : DEFAULT_POLL_INTERVAL_MS;
    const maxChecks = typeof params['maxChecks'] === 'number' ? params['maxChecks'] : DEFAULT_MAX_CHECKS;

    const snapshotJs = buildSnapshotScript(watch, selector);
    const changes: PageChange[] = [];

    // Take initial snapshot
    const initialRes = await this.engine.executeJsInTab(tabUrl, snapshotJs);
    let previousSnapshot = initialRes.value ?? '';

    for (let check = 1; check <= maxChecks; check++) {
      await sleep(interval);

      const res = await this.engine.executeJsInTab(tabUrl, snapshotJs);
      const currentSnapshot = res.value ?? '';

      if (currentSnapshot !== previousSnapshot) {
        changes.push({
          check,
          timestamp: new Date().toISOString(),
          diff: buildDiff(previousSnapshot, currentSnapshot),
        });
        previousSnapshot = currentSnapshot;
      }
    }

    const data: MonitorResult = {
      changes,
      checksPerformed: maxChecks,
      finalSnapshot: previousSnapshot,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handlePaginateScrape(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const extractScript = params['extractScript'] as string;
    const nextSelector = params['nextSelector'] as string;
    const maxPages = typeof params['maxPages'] === 'number' ? params['maxPages'] : DEFAULT_MAX_PAGES;

    const pages: ScrapedPage[] = [];
    const warnings: string[] = [];
    let currentUrl = tabUrl;
    let degraded = false;

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      // Extract data from current page
      const extractRes = await this.engine.executeJsInTab(currentUrl, extractScript);
      let pageData: unknown = extractRes.value ?? null;

      // Try to parse if it looks like JSON
      if (typeof pageData === 'string') {
        try {
          pageData = JSON.parse(pageData);
        } catch {
          // keep as string
        }
      }

      pages.push({ pageNum, url: currentUrl, data: pageData });

      // Check if there's a next page
      const hasNextJs = `
        var el = document.querySelector(${JSON.stringify(nextSelector)});
        return el ? 'found' : 'not found';
      `;
      const hasNextRes = await this.engine.executeJsInTab(currentUrl, hasNextJs);

      if (hasNextRes.value !== 'found') {
        // No next button — stop pagination
        break;
      }

      if (pageNum < maxPages) {
        // Click next and wait for navigation
        const clickNextJs = `
          var el = document.querySelector(${JSON.stringify(nextSelector)});
          if (!el) throw new Error('Next selector not found');
          el.click();
          return 'clicked';
        `;
        const clickRes = await this.engine.executeJsInTab(currentUrl, clickNextJs);
        if (!clickRes.ok) break;

        await sleep(WAIT_NAVIGATE_MS);

        // T19: query the new URL via the SAME stale `currentUrl` (CompoundTools
        // does not have positional identity threaded through). If the lookup
        // fails (ok=false) OR returns an empty/whitespace value, the post-
        // navigation tab is no longer findable by the old URL — stop the loop
        // LOUDLY (warning + degraded=true) instead of continuing with a stale
        // URL that silently scrapes the old page or empty results.
        const urlRes = await this.engine.executeJsInTab(currentUrl, 'return location.href');
        const newUrl = typeof urlRes.value === 'string' ? urlRes.value.trim() : '';
        if (!urlRes.ok || !newUrl) {
          warnings.push(
            `Pagination stopped at page ${pageNum}: post-navigation URL tracking failed ` +
              `(stale tab lookup; safari_paginate_scrape uses URL-based tab targeting and ` +
              `positional identity is not threaded through CompoundTools).`,
          );
          degraded = true;
          break;
        }
        currentUrl = newUrl;
      }
    }

    const data: PaginateResult = {
      pages,
      totalPages: pages.length,
      ...(warnings.length > 0 ? { warnings } : {}),
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded, latencyMs: Date.now() - start },
    };
  }

  private async handleMediaControl(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const action = params['action'] as 'play' | 'pause' | 'mute' | 'unmute' | 'seek' | 'speed';
    const selector = params['selector'] as string | undefined;
    const value = params['value'] as number | undefined;

    const selectorExpr = selector
      ? `document.querySelector(${JSON.stringify(selector)})`
      : `document.querySelector('video, audio')`;

    const controlJs = buildMediaControlScript(selectorExpr, action, value);
    const res = await this.engine.executeJsInTab(tabUrl, controlJs);

    if (!res.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: res.error?.message ?? 'Media control failed' }) }],
        metadata: { engine: 'applescript', degraded: true, latencyMs: Date.now() - start },
      };
    }

    let state: MediaState;
    try {
      const parsed = JSON.parse(res.value ?? '{}');
      state = parsed as MediaState;
    } catch {
      state = {
        action,
        currentTime: 0,
        duration: 0,
        paused: true,
        muted: false,
        volume: 1,
        playbackRate: 1,
      };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(state) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSnapshotScript(watch: string, selector?: string): string {
  const targetExpr = selector
    ? `document.querySelector(${JSON.stringify(selector)})`
    : `document.body`;

  switch (watch) {
    case 'text':
      return `
        var el = ${targetExpr};
        return el ? (el.textContent || '') : '';
      `;
    case 'attribute':
      return `
        var el = ${targetExpr};
        if (!el) return '{}';
        var attrs = {};
        for (var i = 0; i < el.attributes.length; i++) {
          attrs[el.attributes[i].name] = el.attributes[i].value;
        }
        return JSON.stringify(attrs);
      `;
    case 'network':
      // Snapshot performance entries as a proxy for network activity
      return `
        var entries = performance.getEntriesByType('resource');
        return JSON.stringify(entries.map(function(e) { return {name: e.name, duration: e.duration}; }));
      `;
    case 'dom':
    default:
      return `
        var el = ${targetExpr};
        return el ? el.innerHTML : '';
      `;
  }
}

function buildDiff(prev: string, current: string): string {
  if (prev === current) return '(no change)';
  const prevLen = prev.length;
  const curLen = current.length;
  return `content changed (${prevLen} -> ${curLen} chars)`;
}

function buildMediaControlScript(selectorExpr: string, action: string, value?: number): string {
  const actionCode = (() => {
    switch (action) {
      case 'play':   return 'el.play();';
      case 'pause':  return 'el.pause();';
      case 'mute':   return 'el.muted = true;';
      case 'unmute': return 'el.muted = false;';
      case 'seek':   return `el.currentTime = ${value ?? 0};`;
      case 'speed':  return `el.playbackRate = ${value ?? 1};`;
      default:       return '';
    }
  })();

  return `
    var el = ${selectorExpr};
    if (!el) throw new Error('No media element found');
    ${actionCode}
    return JSON.stringify({
      action: ${JSON.stringify(action)},
      currentTime: el.currentTime,
      duration: el.duration || 0,
      paused: el.paused,
      muted: el.muted,
      volume: el.volume,
      playbackRate: el.playbackRate
    });
  `;
}
