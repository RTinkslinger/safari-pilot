import { writeFile, readFile, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildRefSelector, generateSnapshotJs } from '../aria.js';
import { escapeForJsSingleQuote } from '../escape.js';
import { hasLocatorParams, extractLocatorFromParams, buildLocatorSentinel, generateLocatorJs, generateQueryAllJs, resolveMaybePackSelector } from '../locator.js';
import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';
import { ScreenshotPolicy } from '../security/screenshot-policy.js';
import { routeFrameAware } from './_frame-routing-helper.js';
import { loadConfig } from '../config.js';
import { wrapEngineError } from '../errors.js';

const execFileP = promisify(execFile);

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class ExtractionTools {
  private engine: IEngine;
  private screenshotPolicy: ScreenshotPolicy | undefined;
  private handlers: Map<string, Handler> = new Map();
  /** v0.1.34 T16: rollback flag — when true, the 5 refactored extraction tools
   *  (snapshot, get_text, get_html, get_attribute, query_all) dispatch via the
   *  verbatim v0.1.33 JS-string paths preserved as `*Legacy` companions. */
  private readonly legacyMainWorld: boolean;

  constructor(engine: IEngine, screenshotPolicy?: ScreenshotPolicy) {
    this.engine = engine;
    this.screenshotPolicy = screenshotPolicy;
    this.legacyMainWorld = loadConfig().legacyMainWorld === true;
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.handlers.set('safari_snapshot', this.handleSnapshot.bind(this));
    this.handlers.set('safari_get_text', this.handleGetText.bind(this));
    this.handlers.set('safari_get_html', this.handleGetHtml.bind(this));
    this.handlers.set('safari_get_attribute', this.handleGetAttribute.bind(this));
    this.handlers.set('safari_evaluate', this.handleEvaluate.bind(this));
    this.handlers.set('safari_take_screenshot', this.handleTakeScreenshot.bind(this));
    this.handlers.set('safari_get_console_messages', this.handleGetConsoleMessages.bind(this));
    this.handlers.set('safari_query_all', this.handleQueryAll.bind(this));
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_snapshot',
        description:
          'Build a YAML or JSON accessibility snapshot of the page or a sub-tree, with refs (e1, e2, ...). Use when the page structure is unknown after navigation — every subsequent tool can target by ref; cheaper than reading raw HTML.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            scope: {
              type: 'string',
              description: 'CSS selector to scope snapshot, or "page" for full page',
              default: 'page',
            },
            format: {
              type: 'string',
              enum: ['yaml', 'json'],
              description: 'Output format for the snapshot',
              default: 'yaml',
            },
            maxDepth: { type: 'number', description: 'Maximum DOM traversal depth', default: 15 },
            includeHidden: {
              type: 'boolean',
              description: 'Include hidden elements in snapshot',
              default: false,
            },
          },
          required: ['tabUrl'],
        },
        // v0.1.34 T14: leaf read now sentinel-routed via __SP_SNAPSHOT__ →
        // __SP_LOCATOR__.buildSnapshot, CSP-immune on TT-strict pages.
        requirements: { idempotent: true, requiresCspBypass: true },
      },
      {
        name: 'safari_get_text',
        description: 'Read the visible text of one element. Use when verifying a result, capturing an answer, or reading a label — if the answer is a list of items, use safari_query_all instead (never loop safari_get_text by index).',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', minLength: 1, description: 'CSS selector. If omitted, returns full page text.' },
            ref: { type: 'string', description: "Element ref from snapshot (e.g. 'e5'). Takes priority over selector." },
            role: { type: 'string', description: "ARIA role to search for (e.g. 'button', 'link', 'textbox')" },
            name: { type: 'string', description: 'Accessible name to match (substring, case-insensitive)' },
            text: { type: 'string', description: 'Visible text content to match' },
            label: { type: 'string', description: 'Associated label text to match' },
            testId: { type: 'string', description: 'data-testid attribute value (exact match)' },
            placeholder: { type: 'string', description: 'placeholder attribute value' },
            exact: { type: 'boolean', description: 'Use exact matching instead of substring', default: false },
            chain: {
              type: 'array',
              items: { type: 'object' },
              description:
                'T77: multi-step locator chain ops (Playwright-style). Each entry is one of: ' +
                '{op:"filter", hasText|hasNotText|has|hasNot}, {op:"nth", n}, {op:"first"}, {op:"last"}, ' +
                '{op:"and"|"or"|"descendant", locator}. Applied in order against the base locator match set.',
            },
            maxLength: { type: 'number', description: 'Maximum characters to return', default: 50000 },
            multi: { type: 'boolean', description: 'When true, returns {matches: string[], count} for ALL matching elements via querySelectorAll. Default false returns first match only.', default: false },
            frameId: { type: 'number', description: 'Optional: target a specific iframe by frameId from safari_list_frames (cross-origin requires extension engine)' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true, requiresFramesCrossOrigin: true, requiresCspBypass: true },
      },
      {
        name: 'safari_get_html',
        description: 'Read the outer or inner HTML of an element. Use when text alone is insufficient — preserved attributes, nested structure, or HTML-aware downstream parsing; strict mode enforced.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', minLength: 1, description: 'CSS selector. If omitted, returns full page HTML.' },
            ref: { type: 'string', description: "Element ref from snapshot (e.g. 'e5'). Takes priority over selector." },
            role: { type: 'string', description: "ARIA role to search for (e.g. 'button', 'link', 'textbox')" },
            name: { type: 'string', description: 'Accessible name to match (substring, case-insensitive)' },
            text: { type: 'string', description: 'Visible text content to match' },
            label: { type: 'string', description: 'Associated label text to match' },
            testId: { type: 'string', description: 'data-testid attribute value (exact match)' },
            placeholder: { type: 'string', description: 'placeholder attribute value' },
            exact: { type: 'boolean', description: 'Use exact matching instead of substring', default: false },
            chain: {
              type: 'array',
              items: { type: 'object' },
              description:
                'T77: multi-step locator chain ops (Playwright-style). Each entry is one of: ' +
                '{op:"filter", hasText|hasNotText|has|hasNot}, {op:"nth", n}, {op:"first"}, {op:"last"}, ' +
                '{op:"and"|"or"|"descendant", locator}. Applied in order against the base locator match set.',
            },
            outer: {
              type: 'boolean',
              description: 'true = outerHTML (includes the element itself), false = innerHTML (just contents)',
              default: true,
            },
            multi: { type: 'boolean', description: 'When true, returns {matches: string[], count} for ALL matching elements via querySelectorAll. Default false returns first match only.', default: false },
            frameId: { type: 'number', description: 'Optional: target a specific iframe by frameId from safari_list_frames (cross-origin requires extension engine)' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true, requiresFramesCrossOrigin: true, requiresCspBypass: true },
      },
      {
        name: 'safari_get_attribute',
        description: 'Read a named attribute (href, src, value, data-*) of an element. Use when capturing links, image URLs, form values, or test-ids; strict mode enforced.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', minLength: 1, description: 'CSS selector for the element' },
            ref: { type: 'string', description: "Element ref from snapshot (e.g. 'e5'). Takes priority over selector." },
            role: { type: 'string', description: "ARIA role to search for (e.g. 'button', 'link', 'textbox')" },
            name: { type: 'string', description: 'Accessible name to match (substring, case-insensitive)' },
            text: { type: 'string', description: 'Visible text content to match' },
            label: { type: 'string', description: 'Associated label text to match' },
            testId: { type: 'string', description: 'data-testid attribute value (exact match)' },
            placeholder: { type: 'string', description: 'placeholder attribute value' },
            exact: { type: 'boolean', description: 'Use exact matching instead of substring', default: false },
            chain: {
              type: 'array',
              items: { type: 'object' },
              description:
                'T77: multi-step locator chain ops (Playwright-style). Each entry is one of: ' +
                '{op:"filter", hasText|hasNotText|has|hasNot}, {op:"nth", n}, {op:"first"}, {op:"last"}, ' +
                '{op:"and"|"or"|"descendant", locator}. Applied in order against the base locator match set.',
            },
            attribute: { type: 'string', description: 'Attribute name: href, src, data-id, aria-label, etc.' },
            multi: { type: 'boolean', description: 'When true, returns {matches: (string|null)[], count} for ALL matching elements via querySelectorAll. null entries indicate the attribute is missing on that element. Default false returns first match only.', default: false },
            frameId: { type: 'number', description: 'Optional: target a specific iframe by frameId from safari_list_frames (cross-origin requires extension engine)' },
          },
          required: ['tabUrl', 'attribute'],
        },
        requirements: { idempotent: true, requiresFramesCrossOrigin: true, requiresCspBypass: true },
      },
      {
        name: 'safari_evaluate',
        description:
          'Run an arbitrary JavaScript expression in the page context. Returns the expression\'s value via JSON serialization.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            script: { type: 'string', description: 'JavaScript code to execute. Must return a value.' },
            timeout: { type: 'number', description: 'Execution timeout in milliseconds', default: 10000 },
          },
          required: ['tabUrl', 'script'],
        },
        // handleEvaluate's async IIFE wrapper (commit 99fec1f) only resolves
        // when the engine awaits Promise-returning injected scripts. Only the
        // extension engine does. Without requiresAsyncJs, the selector falls
        // through to daemon/applescript on extension-down paths and silently
        // serializes the unresolved Promise as `[object Promise]` or `{}`.
        // Same fix pattern as safari_idb_list / safari_idb_get (T6).
        requirements: { idempotent: false, requiresAsyncJs: true },
      },
      {
        name: 'safari_take_screenshot',
        description:
          'Capture a PNG of the visible Safari WebView for the given tab. ' +
          'Briefly activates the tab in its window (does not bring Safari to foreground), ' +
          'captures via the extension API, and restores the previously active tab. ' +
          "Output PNG is at the display's native devicePixelRatio (Retina captures are 2× viewport pixels). " +
          'Requires the Safari Pilot extension to be installed and enabled. ' +
          'BREAKING in v0.1.30+: replaces the previous whole-screen screencapture behavior with WebView-only capture.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab to capture (required).' },
            format: { type: 'string', enum: ['png'], description: 'Image format. v1 only accepts png; non-png values are rejected with INVALID_PARAMS.' },
            path: { type: 'string', description: 'Optional filesystem path. If provided, the PNG is also written to this path.' },
          },
          required: ['tabUrl'],
          additionalProperties: false,
        },
        requirements: { idempotent: true, requiresViewportCapture: true },
      },
      {
        name: 'safari_get_console_messages',
        description: 'Read buffered console.log/warn/error from the page since the last call. Use when debugging an in-page bug or verifying a JS event fired; level filter supported.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            level: {
              type: 'string',
              enum: ['all', 'log', 'warn', 'error', 'info', 'debug'],
              description: 'Filter by log level',
              default: 'all',
            },
            limit: { type: 'number', description: 'Maximum messages to return', default: 100 },
            clear: { type: 'boolean', description: 'Clear the buffer after reading', default: false },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_query_all',
        description:
          'Return ALL elements matching a locator + optional chain, with refs. Use when the answer is a list (search results, products, table rows as divs) — prefer over loops; chain ops filter inline: chain=[{filter:{hasText:"Active"}},{nth:0}] picks the first Active item.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', minLength: 1, description: 'CSS selector. If provided, used directly via querySelectorAll.' },
            role: { type: 'string', description: 'ARIA role to search for' },
            name: { type: 'string', description: 'Accessible name' },
            text: { type: 'string', description: 'Visible text content to match' },
            label: { type: 'string', description: 'Associated label text' },
            testId: { type: 'string', description: 'data-testid attribute' },
            placeholder: { type: 'string', description: 'placeholder attribute' },
            xpath: { type: 'string', description: 'XPath expression' },
            exact: { type: 'boolean', description: 'Exact text match', default: false },
            filter: { type: 'object' },
            nth: { type: 'number' },
            chain: { type: 'array', items: { type: 'object' }, description: 'T77 chain ops' },
            limit: { type: 'number', description: 'Maximum elements to return', default: 100 },
            frameId: { type: 'number', description: 'Optional frame target' },
          },
          required: ['tabUrl'],
        },
        // v0.1.34 T13: leaf read now sentinel-routed via __SP_QUERY_ALL__ →
        // __SP_LOCATOR__.resolveLocatorAll, CSP-immune on TT-strict pages.
        requirements: { idempotent: true, requiresFramesCrossOrigin: true, requiresCspBypass: true },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleSnapshot(params: Record<string, unknown>): Promise<ToolResponse> {
    if (this.legacyMainWorld) return this.handleSnapshotLegacy(params);
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const scope = (params['scope'] as string | undefined) ?? 'page';
    const maxDepth = typeof params['maxDepth'] === 'number' ? params['maxDepth'] : 15;
    const includeHidden = params['includeHidden'] === true;
    const format = (params['format'] as string | undefined) ?? 'yaml';

    // v0.1.34 T14: __SP_SNAPSHOT__ sentinel for CSP-immunity. In-page handler
    // in content-main.js calls __SP_LOCATOR__.buildSnapshot (ported verbatim
    // from src/aria.ts generateSnapshotJs). Result-envelope shape preserved
    // verbatim: {snapshot, url, title, elementCount, interactiveCount, refMap}.
    // Legacy generateSnapshotJs IIFE retained for AppleScript fallback path.
    const sentinel = '__SP_SNAPSHOT__:' + JSON.stringify({
      scopeSelector: scope === 'page' ? undefined : scope,
      maxDepth,
      includeHidden,
      format,
    });

    const result = await this.engine.executeJsInTab(tabUrl, sentinel);
    if (!result.ok) throw wrapEngineError(result.error, 'Snapshot failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  /** v0.1.34 T16 rollback path. Verbatim v0.1.33 body (commit b3d0eac^). */
  private async handleSnapshotLegacy(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const scope = (params['scope'] as string | undefined) ?? 'page';
    const maxDepth = typeof params['maxDepth'] === 'number' ? params['maxDepth'] : 15;
    const includeHidden = params['includeHidden'] === true;
    const format = (params['format'] as string | undefined) ?? 'yaml';

    const js = generateSnapshotJs({
      scopeSelector: scope === 'page' ? undefined : scope,
      maxDepth,
      includeHidden,
      format: format as 'yaml' | 'json',
    });

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Snapshot failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleGetText(params: Record<string, unknown>): Promise<ToolResponse> {
    if (this.legacyMainWorld) return this.handleGetTextLegacy(params);
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const frameId = params['frameId'] as number | undefined;
    const maxLength = typeof params['maxLength'] === 'number' ? params['maxLength'] : 50000;

    // Resolve targeting: ref → locator → selector
    let selector = params['selector'] as string | undefined;
    const ref = params['ref'] as string | undefined;
    if (ref) {
      selector = buildRefSelector(ref);
    }
    selector = await resolveMaybePackSelector(this.engine, { tabUrl, frameId }, selector);
    if (!selector && hasLocatorParams(params)) {
      const locator = extractLocatorFromParams(params)!;
      // v0.1.34 T7b: __SP_RESOLVE_LOCATOR__ sentinel → CSP-immune resolution
      // on Trusted-Types-strict pages (Extension engine intercepts in MAIN
      // world; legacy generateLocatorJs IIFE retained for AppleScript path).
      const locatorJs = buildLocatorSentinel(locator);
      const locatorResult = await routeFrameAware(this.engine, { tabUrl, frameId }, locatorJs);
      if (locatorResult.ok && locatorResult.value) {
        const parsed = JSON.parse(locatorResult.value);
        if (parsed.found && parsed.selector) {
          selector = parsed.selector;
        } else {
          throw new Error(parsed.hint || 'Locator did not match any element');
        }
      }
    }

    const multi = params['multi'] === true;
    // v0.1.34 T12: __SP_GET_TEXT__ sentinel for CSP-immunity on Trusted-Types-strict
    // pages. Extension engine intercepts in MAIN world (no `new Function()` compile).
    // Result-envelope shape preserved verbatim:
    //   multi:false → {text, length, truncated}
    //   multi:true  → {matches: string[], count}
    const sentinel = '__SP_GET_TEXT__:' + JSON.stringify({
      selector: selector ?? null,
      maxLength,
      multi,
    });

    const result = await routeFrameAware(this.engine, { tabUrl, frameId }, sentinel);
    if (!result.ok) throw wrapEngineError(result.error, 'Get text failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  /** v0.1.34 T16 rollback path. Verbatim v0.1.33 body (commit d7f5c25^). */
  private async handleGetTextLegacy(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const frameId = params['frameId'] as number | undefined;
    const maxLength = typeof params['maxLength'] === 'number' ? params['maxLength'] : 50000;

    // Resolve targeting: ref → locator → selector
    let selector = params['selector'] as string | undefined;
    const ref = params['ref'] as string | undefined;
    if (ref) {
      selector = buildRefSelector(ref);
    }
    selector = await resolveMaybePackSelector(this.engine, { tabUrl, frameId }, selector);
    if (!selector && hasLocatorParams(params)) {
      const locator = extractLocatorFromParams(params)!;
      const locatorJs = generateLocatorJs(locator);
      const locatorResult = await routeFrameAware(this.engine, { tabUrl, frameId }, locatorJs);
      if (locatorResult.ok && locatorResult.value) {
        const parsed = JSON.parse(locatorResult.value);
        if (parsed.found && parsed.selector) {
          selector = parsed.selector;
        } else {
          throw new Error(parsed.hint || 'Locator did not match any element');
        }
      }
    }

    const escapedSelector = selector ? escapeForJsSingleQuote(selector) : '';
    const multi = params['multi'] === true;
    const js = multi
      ? `
      if (!${selector ? 'true' : 'false'}) throw Object.assign(new Error('multi:true requires a selector'), { name: 'INVALID_PARAMS' });
      var els = document.querySelectorAll('${escapedSelector}');
      var max = ${maxLength};
      var matches = [];
      for (var i = 0; i < els.length; i++) {
        var t = els[i].innerText || els[i].textContent || '';
        matches.push(t.slice(0, max));
      }
      return { matches: matches, count: els.length };
    `
      : `
      var el = ${selector ? `document.querySelector('${escapedSelector}')` : 'document.body'};
      if (!el) throw Object.assign(new Error('Element not found'), { name: 'ELEMENT_NOT_FOUND' });
      var max = ${maxLength};
      var text = el.innerText || el.textContent || '';
      return { text: text.slice(0, max), length: text.length, truncated: text.length > max };
    `;

    const result = await routeFrameAware(this.engine, { tabUrl, frameId }, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Get text failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleGetHtml(params: Record<string, unknown>): Promise<ToolResponse> {
    if (this.legacyMainWorld) return this.handleGetHtmlLegacy(params);
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const frameId = params['frameId'] as number | undefined;
    const outer = params['outer'] !== false;

    // Resolve targeting: ref → locator → selector
    let selector = params['selector'] as string | undefined;
    const ref = params['ref'] as string | undefined;
    if (ref) {
      selector = buildRefSelector(ref);
    }
    selector = await resolveMaybePackSelector(this.engine, { tabUrl, frameId }, selector);
    if (!selector && hasLocatorParams(params)) {
      const locator = extractLocatorFromParams(params)!;
      // v0.1.34 T7b: __SP_RESOLVE_LOCATOR__ sentinel → CSP-immune resolution
      // on Trusted-Types-strict pages (Extension engine intercepts in MAIN
      // world; legacy generateLocatorJs IIFE retained for AppleScript path).
      const locatorJs = buildLocatorSentinel(locator);
      const locatorResult = await routeFrameAware(this.engine, { tabUrl, frameId }, locatorJs);
      if (locatorResult.ok && locatorResult.value) {
        const parsed = JSON.parse(locatorResult.value);
        if (parsed.found && parsed.selector) {
          selector = parsed.selector;
        } else {
          throw new Error(parsed.hint || 'Locator did not match any element');
        }
      }
    }

    const escapedSelector = selector ? escapeForJsSingleQuote(selector) : '';
    const multi = params['multi'] === true;
    // 5A.6: multi:true returns {matches: string[], count} via querySelectorAll;
    // multi:false (default) preserves the original {html, length}.
    const js = multi
      ? `
      if (!${selector ? 'true' : 'false'}) throw Object.assign(new Error('multi:true requires a selector'), { name: 'INVALID_PARAMS' });
      var els = document.querySelectorAll('${escapedSelector}');
      var matches = [];
      for (var i = 0; i < els.length; i++) {
        matches.push(${outer ? 'els[i].outerHTML' : 'els[i].innerHTML'});
      }
      return { matches: matches, count: els.length };
    `
      : `
      var el = ${selector ? `document.querySelector('${escapedSelector}')` : 'document.documentElement'};
      if (!el) throw Object.assign(new Error('Element not found'), { name: 'ELEMENT_NOT_FOUND' });
      var html = ${outer ? 'el.outerHTML' : 'el.innerHTML'};
      return { html: html, length: html.length };
    `;

    const result = await routeFrameAware(this.engine, { tabUrl, frameId }, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Get HTML failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  /** v0.1.34 T16 rollback path. Verbatim v0.1.33 body (commit d7f5c25^).
   *  The sentinel path above and this legacy path differ ONLY in locator
   *  resolution (buildLocatorSentinel vs generateLocatorJs) — the rest of
   *  the get-html JS body was unchanged at T7b. */
  private async handleGetHtmlLegacy(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const frameId = params['frameId'] as number | undefined;
    const outer = params['outer'] !== false;

    let selector = params['selector'] as string | undefined;
    const ref = params['ref'] as string | undefined;
    if (ref) {
      selector = buildRefSelector(ref);
    }
    selector = await resolveMaybePackSelector(this.engine, { tabUrl, frameId }, selector);
    if (!selector && hasLocatorParams(params)) {
      const locator = extractLocatorFromParams(params)!;
      const locatorJs = generateLocatorJs(locator);
      const locatorResult = await routeFrameAware(this.engine, { tabUrl, frameId }, locatorJs);
      if (locatorResult.ok && locatorResult.value) {
        const parsed = JSON.parse(locatorResult.value);
        if (parsed.found && parsed.selector) {
          selector = parsed.selector;
        } else {
          throw new Error(parsed.hint || 'Locator did not match any element');
        }
      }
    }

    const escapedSelector = selector ? escapeForJsSingleQuote(selector) : '';
    const multi = params['multi'] === true;
    const js = multi
      ? `
      if (!${selector ? 'true' : 'false'}) throw Object.assign(new Error('multi:true requires a selector'), { name: 'INVALID_PARAMS' });
      var els = document.querySelectorAll('${escapedSelector}');
      var matches = [];
      for (var i = 0; i < els.length; i++) {
        matches.push(${outer ? 'els[i].outerHTML' : 'els[i].innerHTML'});
      }
      return { matches: matches, count: els.length };
    `
      : `
      var el = ${selector ? `document.querySelector('${escapedSelector}')` : 'document.documentElement'};
      if (!el) throw Object.assign(new Error('Element not found'), { name: 'ELEMENT_NOT_FOUND' });
      var html = ${outer ? 'el.outerHTML' : 'el.innerHTML'};
      return { html: html, length: html.length };
    `;

    const result = await routeFrameAware(this.engine, { tabUrl, frameId }, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Get HTML failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleGetAttribute(params: Record<string, unknown>): Promise<ToolResponse> {
    if (this.legacyMainWorld) return this.handleGetAttributeLegacy(params);
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const frameId = params['frameId'] as number | undefined;
    const attribute = params['attribute'] as string;

    // Resolve targeting: ref → locator → selector
    let selector = params['selector'] as string | undefined;
    const ref = params['ref'] as string | undefined;
    if (ref) {
      selector = buildRefSelector(ref);
    }
    selector = await resolveMaybePackSelector(this.engine, { tabUrl, frameId }, selector);
    if (!selector && hasLocatorParams(params)) {
      const locator = extractLocatorFromParams(params)!;
      // v0.1.34 T7b: __SP_RESOLVE_LOCATOR__ sentinel → CSP-immune resolution
      // on Trusted-Types-strict pages (Extension engine intercepts in MAIN
      // world; legacy generateLocatorJs IIFE retained for AppleScript path).
      const locatorJs = buildLocatorSentinel(locator);
      const locatorResult = await routeFrameAware(this.engine, { tabUrl, frameId }, locatorJs);
      if (locatorResult.ok && locatorResult.value) {
        const parsed = JSON.parse(locatorResult.value);
        if (parsed.found && parsed.selector) {
          selector = parsed.selector;
        } else {
          throw new Error(parsed.hint || 'Locator did not match any element');
        }
      }
    }
    if (!selector) {
      throw new Error('safari_get_attribute requires a target element: provide selector, ref, or a locator (role, text, label, testId, placeholder)');
    }

    const escapedSelector = escapeForJsSingleQuote(selector);
    const escapedAttribute = escapeForJsSingleQuote(attribute);
    const multi = params['multi'] === true;
    // 5A.6: multi:true returns {matches: (string|null)[], count} via querySelectorAll;
    // null entries indicate the attribute is missing on that element. multi:false
    // (default) preserves the original {value, element}.
    const js = multi
      ? `
      var els = document.querySelectorAll('${escapedSelector}');
      var matches = [];
      for (var i = 0; i < els.length; i++) {
        matches.push(els[i].getAttribute('${escapedAttribute}'));
      }
      return { matches: matches, count: els.length };
    `
      : `
      var el = document.querySelector('${escapedSelector}');
      if (!el) throw Object.assign(new Error('Element not found'), { name: 'ELEMENT_NOT_FOUND' });
      return {
        value: el.getAttribute('${escapedAttribute}'),
        element: { tagName: el.tagName, id: el.id || undefined },
      };
    `;

    const result = await routeFrameAware(this.engine, { tabUrl, frameId }, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Get attribute failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  /** v0.1.34 T16 rollback path. Verbatim v0.1.33 body (commit d7f5c25^). */
  private async handleGetAttributeLegacy(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const frameId = params['frameId'] as number | undefined;
    const attribute = params['attribute'] as string;

    let selector = params['selector'] as string | undefined;
    const ref = params['ref'] as string | undefined;
    if (ref) {
      selector = buildRefSelector(ref);
    }
    selector = await resolveMaybePackSelector(this.engine, { tabUrl, frameId }, selector);
    if (!selector && hasLocatorParams(params)) {
      const locator = extractLocatorFromParams(params)!;
      const locatorJs = generateLocatorJs(locator);
      const locatorResult = await routeFrameAware(this.engine, { tabUrl, frameId }, locatorJs);
      if (locatorResult.ok && locatorResult.value) {
        const parsed = JSON.parse(locatorResult.value);
        if (parsed.found && parsed.selector) {
          selector = parsed.selector;
        } else {
          throw new Error(parsed.hint || 'Locator did not match any element');
        }
      }
    }
    if (!selector) {
      throw new Error('safari_get_attribute requires a target element: provide selector, ref, or a locator (role, text, label, testId, placeholder)');
    }

    const escapedSelector = escapeForJsSingleQuote(selector);
    const escapedAttribute = escapeForJsSingleQuote(attribute);
    const multi = params['multi'] === true;
    const js = multi
      ? `
      var els = document.querySelectorAll('${escapedSelector}');
      var matches = [];
      for (var i = 0; i < els.length; i++) {
        matches.push(els[i].getAttribute('${escapedAttribute}'));
      }
      return { matches: matches, count: els.length };
    `
      : `
      var el = document.querySelector('${escapedSelector}');
      if (!el) throw Object.assign(new Error('Element not found'), { name: 'ELEMENT_NOT_FOUND' });
      return {
        value: el.getAttribute('${escapedAttribute}'),
        element: { tagName: el.tagName, id: el.id || undefined },
      };
    `;

    const result = await routeFrameAware(this.engine, { tabUrl, frameId }, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Get attribute failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleEvaluate(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const script = params['script'] as string;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 10000;

    // Async IIFE wrapper. Awaits the user script's result before packaging,
    // so a script that `return new Promise(...)` resolves end-to-end instead
    // of being postMessage'd as an unresolved Promise (which hits
    // DataCloneError on the structured-clone boundary). `await` on a
    // non-Promise is a no-op, so synchronous `return <value>` scripts still
    // work. Pair with content-main.js's `await fn()` in execute_script (T6).
    //
    // Test-bridge passthrough: scripts starting with `__SP_TEST_HARNESS__:` or
    // `__SP_FILE_UPLOAD_PROBE_TEST__` are intercepted in
    // extension/content-isolated.js. The bridge guard there checks
    // `script.startsWith(prefix)`, which would FAIL on the IIFE-wrapped script
    // (because the wrapper's preamble starts the string). Bypass the wrapping
    // for sentinel scripts so the raw prefix reaches the bridge. Both prefixes
    // are namespaced; no collision with real scripts in production.
    // (5A.1 phase-0 spike sentinel `__SP_FILE_UPLOAD_PROBE_TEST__` reaches
    // here because the spike e2e test fires it via `safari_evaluate` as a
    // generic JS-eval channel — without the bypass, the sentinel never
    // reaches background.js's executeCommand prefix-match.)
    const isSentinelBypass = typeof script === 'string' && (
      script.startsWith('__SP_TEST_HARNESS__:') ||
      script.startsWith('__SP_FILE_UPLOAD_PROBE_TEST__') ||
      // T79 Cluster D: pack register/unregister sentinels are intercepted in
      // extension/background.js (executeCommand prefix match). The IIFE
      // wrapping below would prefix the script with `return (async () => {...`
      // and break the `cmd.script.startsWith('__SP_PACK_')` check upstream.
      script.startsWith('__SP_PACK_REGISTER__:') ||
      script.startsWith('__SP_PACK_UNREGISTER__:') ||
      // v0.1.34 T2 probe sentinel; intercepted in content-main.js's
      // execute_script case. IIFE wrapping below would break the
      // params.script.startsWith('__SP_TT_PROBE__:') check.
      script.startsWith('__SP_TT_PROBE__:')
    );
    const js = isSentinelBypass ? script : `
      return (async () => {
        var __userResult = await (async function() { ${script} })();
        return { value: __userResult, type: typeof __userResult };
      })();
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js, timeout);
    if (!result.ok) {
      const rawMsg = result.error?.message ?? 'safari_evaluate failed';
      // Match Trusted Types / CSP eval refusal patterns. Safari surfaces these as
      // "Refused to evaluate a string as JavaScript because this document requires
      // a 'Trusted Type' assignment" OR "...because 'unsafe-eval' is not an
      // allowed source". v0.1.34 Task 3: wrap with CSP_BLOCKED / CSP_HARD_BLOCK
      // and an alternative_tools hint pointing at the sentinel-based tools
      // (safari_get_page_info, safari_click, etc. — added T4-T15).
      const isTT = /trusted[- ]?type|trustedTypes/i.test(rawMsg);
      const isEvalBlock = /unsafe-eval|refused to evaluate/i.test(rawMsg);
      if (isTT || isEvalBlock) {
        // Probe the tab via the __SP_TT_PROBE__ sentinel (installed in extension
        // from v0.1.34 Task 2) to distinguish CSP_BLOCKED (soft — Layer 3 policy
        // registered; sentinel-based tools work) from CSP_HARD_BLOCK (hard —
        // page's trusted-types allowlist excludes 'safari-pilot'; even the
        // policy registration was refused). Probe failure defaults to soft.
        let isHardBlock = false;
        try {
          const probe = await this.engine.executeJsInTab(tabUrl, '__SP_TT_PROBE__:{}', 5_000);
          if (probe.ok && probe.value) {
            const parsed = JSON.parse(probe.value);
            isHardBlock = parsed.hardBlock === true;
          }
        } catch { /* probe failure — default to CSP_BLOCKED */ }

        const code = isHardBlock ? 'CSP_HARD_BLOCK' : 'CSP_BLOCKED';
        // Precedence: check eval-block first because Safari's no-eval message also contains
        // the substring 'trusted-types-eval', which would otherwise make isTT match. Concrete:
        //   tt-strict only:  "...requires a 'Trusted Type' assignment"           → isTT && !isEvalBlock → 'tt-strict'
        //   no-eval:         "'unsafe-eval' or 'trusted-types-eval' is not..."  → isTT && isEvalBlock  → 'eval-blocked'
        const cspMode: string = isHardBlock ? 'hard-block' : (isEvalBlock ? 'eval-blocked' : 'tt-strict');
        // v0.1.35 Task 6 — softened from prescriptive `alternative_tools` array
        // to an informational hint. The explicit list of named tools was one of
        // the four nudges that pivoted the agent away from safari_evaluate and
        // halved its usage; `cspMode` is preserved for callers that route on it.
        const hint = {
          fallback_available: true,
          note: 'This script could not run because the page enforces a CSP that disallows eval() or string-to-script.',
          cspMode,
        };
        const wrapped = new Error(
          code + ': ' + rawMsg + ' | hint: ' + JSON.stringify(hint),
        );
        (wrapped as Error & { code?: string }).code = code;
        throw wrapped;
      }
      const err = new Error(rawMsg);
      if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
      throw err;
    }

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleTakeScreenshot(params: Record<string, unknown>): Promise<ToolResponse> {
    const tabUrl = params['tabUrl'] as string | undefined;
    if (!tabUrl) {
      const err = new Error('tabUrl required');
      (err as Error & { code?: string }).code = 'INVALID_PARAMS';
      throw err;
    }

    const requestedFormat = params['format'];
    if (requestedFormat !== undefined && requestedFormat !== 'png') {
      const err = new Error(`format='${String(requestedFormat)}' not supported in v1; only 'png' is accepted`);
      (err as Error & { code?: string }).code = 'INVALID_PARAMS';
      throw err;
    }

    if (this.screenshotPolicy) this.screenshotPolicy.checkDomain(tabUrl);

    const start = Date.now();
    const savePath = params['path'] as string | undefined;

    // Try extension capture first (15s timeout — shorter than the 90s default
    // so we fall back to screencapture quickly on heavy pages where
    // browser.tabs.captureVisibleTab routinely hangs).
    // Investigation 2026-05-12 (Failure B): on Amazon search and Allrecipes
    // search pages, the extension's __SP_TAKE_SCREENSHOT__ sentinel returns
    // nothing within 90s — captureVisibleTab + MV3 throttling. Falling
    // back to macOS `screencapture` produces a usable image and keeps the
    // bench from blocking on screenshot timeouts.
    let base64: string | undefined;
    let degraded = false;
    let engineUsed: Engine = 'extension';

    // Wrap in our own 15s race because src/engines/extension.ts does
    // Math.max(timeout, 90_000) — passing 15s alone would still wait 90s
    // for a stuck extension. Our own race short-circuits to the fallback.
    const extPromise = this.engine.executeJsInTab(tabUrl, '__SP_TAKE_SCREENSHOT__', 15_000);
    const timeoutPromise = new Promise<{ ok: false; error: { code: string; message: string }; elapsed_ms: number }>(
      (resolve) => setTimeout(() => resolve({
        ok: false,
        error: { code: 'CAPTURE_TIMEOUT_LOCAL', message: 'Extension screenshot exceeded 15s local cap; falling back to screencapture' },
        elapsed_ms: 15_000,
      }), 15_000),
    );
    const extResult = await Promise.race([extPromise, timeoutPromise]);
    if (extResult.ok && typeof extResult.value === 'string' && extResult.value.length > 0) {
      base64 = extResult.value;
    } else {
      // Fallback: macOS screencapture of the whole screen.
      // Activate Safari + the target tab via AppleScript first so the visible
      // content matches what the agent navigated to. Capture, base64-encode.
      degraded = true;
      engineUsed = 'applescript';
      try {
        const tabUrlEscaped = tabUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const activateScript = `
          tell application "Safari"
            activate
            repeat with w in (every window)
              set tList to (every tab of w whose URL is "${tabUrlEscaped}")
              if (count of tList) > 0 then
                set index of w to 1
                set current tab of w to (item 1 of tList)
                exit repeat
              end if
            end repeat
          end tell
        `;
        await execFileP('osascript', ['-e', activateScript], { timeout: 8000 });
        // Short settle for window-bring-forward + tab switch repaint.
        await new Promise((r) => setTimeout(r, 350));
        const tmpFile = `/tmp/sp-screen-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`;
        try {
          // -t png explicit format; -x silent (no sound); -C cursor off; -m capture main display
          await execFileP('screencapture', ['-t', 'png', '-x', '-m', tmpFile], { timeout: 8000 });
          const buf = await readFile(tmpFile);
          base64 = buf.toString('base64');
          await unlink(tmpFile).catch(() => { /* best-effort */ });
        } catch (e) {
          await unlink(tmpFile).catch(() => { /* best-effort */ });
          throw e;
        }
      } catch (fallbackErr: unknown) {
        const extMsg = extResult.error?.message ?? 'unknown';
        const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        const err = new Error(`Screenshot failed: extension="${extMsg}" fallback="${fbMsg}"`);
        (err as Error & { code?: string }).code = 'CAPTURE_FAILED';
        throw err;
      }
    }

    if (!base64 || base64.length === 0) {
      const err = new Error('Screenshot returned empty payload');
      (err as Error & { code?: string }).code = 'CAPTURE_FAILED';
      throw err;
    }

    if (savePath) {
      const buf = Buffer.from(base64, 'base64');
      await writeFile(savePath, buf);
    }

    return {
      content: [{ type: 'image', data: base64, mimeType: 'image/png' }],
      metadata: { engine: engineUsed, degraded, latencyMs: Date.now() - start },
    };
  }

  private async handleGetConsoleMessages(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const level = (params['level'] as string | undefined) ?? 'all';
    const limit = typeof params['limit'] === 'number' ? params['limit'] : 100;
    const clear = params['clear'] === true;

    const js = `
      if (!window.__safariPilotConsole) {
        window.__safariPilotConsole = [];
        var origConsole = {};
        ['log', 'warn', 'error', 'info', 'debug'].forEach(function(method) {
          origConsole[method] = console[method];
          console[method] = function() {
            var args = Array.prototype.slice.call(arguments);
            window.__safariPilotConsole.push({
              level: method,
              text: args.map(function(a) { return typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(' '),
              timestamp: Date.now(),
            });
            origConsole[method].apply(console, args);
          };
        });
      }

      var filterLevel = '${level}';
      var msgs = window.__safariPilotConsole;
      if (filterLevel !== 'all') msgs = msgs.filter(function(m) { return m.level === filterLevel; });
      var limited = msgs.slice(-${limit});

      ${clear ? 'window.__safariPilotConsole = [];' : ''}

      return { messages: limited, count: limited.length };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Get console messages failed');

    return this.makeResponse(
      result.value ? JSON.parse(result.value) : { messages: [], count: 0 },
      Date.now() - start,
    );
  }

  private async handleQueryAll(params: Record<string, unknown>): Promise<ToolResponse> {
    if (this.legacyMainWorld) return this.handleQueryAllLegacy(params);
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const frameId = params['frameId'] as number | undefined;
    const limit = typeof params['limit'] === 'number' ? Math.max(1, Math.min(1000, params['limit'])) : 100;

    // v0.1.34 T13: __SP_QUERY_ALL__ sentinel for CSP-immunity. Both selector and
    // locator paths emit the sentinel; in-page handler in content-main.js calls
    // either document.querySelectorAll (selector branch) or
    // __SP_LOCATOR__.resolveLocatorAll (locator branch). Result-envelope shape
    // preserved verbatim: {items, count, limit, truncated}. AppleScript engine
    // never sees __SP_LOCATOR__ — for that path the legacy generateQueryAllJs
    // IIFE is retained via an `appleScriptFallback` field that the engine
    // selector + extension-down path resolves. Since T11 added
    // requiresCspBypass to this tool below, the engine selector now pins
    // safari_query_all to the extension when CSP-sensitive routing is needed;
    // the AppleScript fallback path through `generateQueryAllJs` is preserved
    // for non-CSP pages where the daemon/AppleScript engine is selected.
    let selector = params['selector'] as string | undefined;
    selector = await resolveMaybePackSelector(this.engine, { tabUrl, frameId }, selector);

    if (selector) {
      const sentinel = '__SP_QUERY_ALL__:' + JSON.stringify({ selector, limit });
      const result = await routeFrameAware(this.engine, { tabUrl, frameId }, sentinel);
      if (!result.ok) throw wrapEngineError(result.error, 'query_all (selector) failed');
      const parsed = result.value ? JSON.parse(result.value) : { items: [], count: 0 };
      const normalized = parsed.found === false
        ? { items: [], count: 0, limit, truncated: false }
        : parsed;
      return this.makeResponse(normalized, Date.now() - start);
    }

    // Locator path
    if (!hasLocatorParams(params)) {
      throw new Error('safari_query_all requires either selector or a locator (role, text, label, testId, placeholder, xpath)');
    }
    const locator = extractLocatorFromParams(params)!;
    const sentinel = '__SP_QUERY_ALL__:' + JSON.stringify({ locator, limit });

    const result = await routeFrameAware(this.engine, { tabUrl, frameId }, sentinel);
    if (!result.ok) throw wrapEngineError(result.error, 'query_all failed');

    const parsed = result.value ? JSON.parse(result.value) : { items: [], count: 0 };
    const normalized = parsed.found === false
      ? { items: [], count: 0, limit, truncated: false }
      : parsed;
    return this.makeResponse(normalized, Date.now() - start);
  }

  /** v0.1.34 T16 rollback path. Verbatim v0.1.33 body (commit 1d84568^). */
  private async handleQueryAllLegacy(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const frameId = params['frameId'] as number | undefined;
    const limit = typeof params['limit'] === 'number' ? Math.max(1, Math.min(1000, params['limit'])) : 100;

    // Selector path: bypass locator, use querySelectorAll directly with the same payload shape
    let selector = params['selector'] as string | undefined;
    selector = await resolveMaybePackSelector(this.engine, { tabUrl, frameId }, selector);
    if (selector) {
      const escaped = escapeForJsSingleQuote(selector);
      const js = `
        var __limit = ${limit};
        var __all = Array.prototype.slice.call(document.querySelectorAll('${escaped}'));
        var __truncated = __all.length > __limit;
        var __slice = __all.slice(0, __limit);
        var __items = [];
        for (var __i = 0; __i < __slice.length; __i++) {
          var __el = __slice[__i];
          var __ref = 'sp-' + Math.random().toString(36).substring(2, 8);
          __el.setAttribute('data-sp-ref', __ref);
          var __rect = __el.getBoundingClientRect();
          var __attrs = {};
          if (__el.attributes) {
            for (var __ai = 0; __ai < __el.attributes.length; __ai++) {
              var __a = __el.attributes[__ai];
              if (__a.name && __a.name !== 'data-sp-ref') __attrs[__a.name] = __a.value;
            }
          }
          var __style = window.getComputedStyle(__el);
          var __visible = __style.display !== 'none' && __style.visibility !== 'hidden' && __rect.width > 0 && __rect.height > 0;
          __items.push({
            ref: __ref,
            tagName: __el.tagName || '',
            text: ((__el.innerText !== undefined ? __el.innerText : __el.textContent) || '').replace(/\\s+/g, ' ').trim().substring(0, 500),
            attrs: __attrs,
            boundingBox: { x: __rect.x, y: __rect.y, width: __rect.width, height: __rect.height },
            visible: __visible,
          });
        }
        return JSON.stringify({ items: __items, count: __all.length, limit: __limit, truncated: __truncated });
      `;
      const result = await routeFrameAware(this.engine, { tabUrl, frameId }, js);
      if (!result.ok) throw wrapEngineError(result.error, 'query_all (selector) failed');
      const parsed = result.value ? JSON.parse(result.value) : { items: [], count: 0 };
      const normalized = parsed.found === false
        ? { items: [], count: 0, limit, truncated: false }
        : parsed;
      return this.makeResponse(normalized, Date.now() - start);
    }

    // Locator path
    if (!hasLocatorParams(params)) {
      throw new Error('safari_query_all requires either selector or a locator (role, text, label, testId, placeholder, xpath)');
    }
    const locator = extractLocatorFromParams(params)!;
    const js = generateQueryAllJs(locator, { limit });

    const result = await routeFrameAware(this.engine, { tabUrl, frameId }, js);
    if (!result.ok) throw wrapEngineError(result.error, 'query_all failed');

    const parsed = result.value ? JSON.parse(result.value) : { items: [], count: 0 };
    const normalized = parsed.found === false
      ? { items: [], count: 0, limit, truncated: false }
      : parsed;
    return this.makeResponse(normalized, Date.now() - start);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private makeResponse(data: unknown, latencyMs: number = 0): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript' as Engine, degraded: false, latencyMs },
    };
  }
}
