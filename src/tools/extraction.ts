import * as childProcess from 'node:child_process';

type ScreencaptureRunner = (format: string, filePath: string) => Promise<void>;

function defaultScreencaptureRunner(format: string, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      'screencapture',
      ['-x', '-t', format, filePath],
      { timeout: 10000 },
      (error) => { if (error) reject(error); else resolve(); },
    );
  });
}
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSnapshotJs, buildRefSelector } from '../aria.js';
import { escapeForJsSingleQuote } from '../escape.js';
import { hasLocatorParams, extractLocatorFromParams, generateLocatorJs } from '../locator.js';
import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';
import { ScreenshotPolicy } from '../security/screenshot-policy.js';
import { routeFrameAware } from './_frame-routing-helper.js';

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
  private screencaptureRunner: ScreencaptureRunner;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: IEngine, screenshotPolicy?: ScreenshotPolicy, screencaptureRunner: ScreencaptureRunner = defaultScreencaptureRunner) {
    this.engine = engine;
    this.screenshotPolicy = screenshotPolicy;
    this.screencaptureRunner = screencaptureRunner;
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
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_snapshot',
        description:
          'Capture a Playwright-compatible accessibility tree snapshot. Returns ARIA roles, names, states, and [ref=eN] identifiers ' +
          'for interactive elements. Use refs to target elements in subsequent actions (click, fill, etc.).',
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
        requirements: { idempotent: true },
      },
      {
        name: 'safari_get_text',
        description: 'Extract the visible text content of the page or a specific element.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'CSS selector. If omitted, returns full page text.' },
            ref: { type: 'string', description: "Element ref from snapshot (e.g. 'e5'). Takes priority over selector." },
            role: { type: 'string', description: "ARIA role to search for (e.g. 'button', 'link', 'textbox')" },
            name: { type: 'string', description: 'Accessible name to match (substring, case-insensitive)' },
            text: { type: 'string', description: 'Visible text content to match' },
            label: { type: 'string', description: 'Associated label text to match' },
            testId: { type: 'string', description: 'data-testid attribute value (exact match)' },
            placeholder: { type: 'string', description: 'placeholder attribute value' },
            exact: { type: 'boolean', description: 'Use exact matching instead of substring', default: false },
            maxLength: { type: 'number', description: 'Maximum characters to return', default: 50000 },
            multi: { type: 'boolean', description: 'When true, returns {matches: string[], count} for ALL matching elements via querySelectorAll. Default false returns first match only.', default: false },
            frameId: { type: 'number', description: 'Optional: target a specific iframe by frameId from safari_list_frames (cross-origin requires extension engine)' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true, requiresFramesCrossOrigin: true },
      },
      {
        name: 'safari_get_html',
        description: 'Get the HTML content of an element or the full page.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'CSS selector. If omitted, returns full page HTML.' },
            ref: { type: 'string', description: "Element ref from snapshot (e.g. 'e5'). Takes priority over selector." },
            role: { type: 'string', description: "ARIA role to search for (e.g. 'button', 'link', 'textbox')" },
            name: { type: 'string', description: 'Accessible name to match (substring, case-insensitive)' },
            text: { type: 'string', description: 'Visible text content to match' },
            label: { type: 'string', description: 'Associated label text to match' },
            testId: { type: 'string', description: 'data-testid attribute value (exact match)' },
            placeholder: { type: 'string', description: 'placeholder attribute value' },
            exact: { type: 'boolean', description: 'Use exact matching instead of substring', default: false },
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
        requirements: { idempotent: true, requiresFramesCrossOrigin: true },
      },
      {
        name: 'safari_get_attribute',
        description: 'Get a specific attribute value from an element.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'CSS selector for the element' },
            ref: { type: 'string', description: "Element ref from snapshot (e.g. 'e5'). Takes priority over selector." },
            role: { type: 'string', description: "ARIA role to search for (e.g. 'button', 'link', 'textbox')" },
            name: { type: 'string', description: 'Accessible name to match (substring, case-insensitive)' },
            text: { type: 'string', description: 'Visible text content to match' },
            label: { type: 'string', description: 'Associated label text to match' },
            testId: { type: 'string', description: 'data-testid attribute value (exact match)' },
            placeholder: { type: 'string', description: 'placeholder attribute value' },
            exact: { type: 'boolean', description: 'Use exact matching instead of substring', default: false },
            attribute: { type: 'string', description: 'Attribute name: href, src, data-id, aria-label, etc.' },
            multi: { type: 'boolean', description: 'When true, returns {matches: (string|null)[], count} for ALL matching elements via querySelectorAll. null entries indicate the attribute is missing on that element. Default false returns first match only.', default: false },
            frameId: { type: 'number', description: 'Optional: target a specific iframe by frameId from safari_list_frames (cross-origin requires extension engine)' },
          },
          required: ['tabUrl', 'attribute'],
        },
        requirements: { idempotent: true, requiresFramesCrossOrigin: true },
      },
      {
        name: 'safari_evaluate',
        description:
          'Execute arbitrary JavaScript in the page context and return the result. ' +
          'The most flexible extraction tool. Script must return a JSON-serializable value.',
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
          'Capture a screenshot of the frontmost Safari window via the screencapture CLI ' +
          '(no per-tab targeting; captures whatever is on top). Returns the image as base64-encoded PNG ' +
          'unless `path` is provided. Requires Screen Recording permission.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: {
              type: 'string',
              description: 'Current URL of the tab being screenshotted. Used for screenshot domain policy check. Does not retarget screencapture.',
            },
            path: {
              type: 'string',
              description: 'Optional file path to save the screenshot. If omitted, returns base64 data.',
            },
            format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format', default: 'png' },
          },
          required: [],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_get_console_messages',
        description: 'Retrieve console messages (log, warn, error, info) captured from the page.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            level: {
              type: 'string',
              enum: ['all', 'log', 'warn', 'error', 'info'],
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
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleSnapshot(params: Record<string, unknown>): Promise<ToolResponse> {
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
    if (!result.ok) throw new Error(result.error?.message ?? 'Snapshot failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleGetText(params: Record<string, unknown>): Promise<ToolResponse> {
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
    // 5A.6: multi:true returns {matches: string[], count} via querySelectorAll;
    // multi:false (default) preserves the original {text, length, truncated}.
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
    if (!result.ok) throw new Error(result.error?.message ?? 'Get text failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleGetHtml(params: Record<string, unknown>): Promise<ToolResponse> {
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
    if (!result.ok) throw new Error(result.error?.message ?? 'Get HTML failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleGetAttribute(params: Record<string, unknown>): Promise<ToolResponse> {
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
    if (!result.ok) throw new Error(result.error?.message ?? 'Get attribute failed');

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
      script.startsWith('__SP_FILE_UPLOAD_PROBE_TEST__')
    );
    const js = isSentinelBypass ? script : `
      return (async () => {
        var __userResult = await (async function() { ${script} })();
        return { value: __userResult, type: typeof __userResult };
      })();
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js, timeout);
    if (!result.ok) throw new Error(result.error?.message ?? 'Evaluate failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleTakeScreenshot(params: Record<string, unknown>): Promise<ToolResponse> {
    const tabUrl = params['tabUrl'];
    if (this.screenshotPolicy && typeof tabUrl === 'string') {
      this.screenshotPolicy.checkDomain(tabUrl);
    }

    const start = Date.now();
    const format = (params['format'] as string | undefined) ?? 'png';
    const savePath = params['path'] as string | undefined;
    const screenshotFormat = format === 'jpeg' ? 'jpg' : 'png';
    const tmpFile = savePath ?? join(tmpdir(), `safari-pilot-${Date.now()}.${screenshotFormat}`);
    const usingTmpFile = !savePath;

    try {
      await this.screencaptureRunner(screenshotFormat, tmpFile);

      const buffer = await readFile(tmpFile);
      const base64 = buffer.toString('base64');

      if (usingTmpFile) {
        await unlink(tmpFile).catch(() => {});
      }

      return {
        content: [{ type: 'image', data: base64, mimeType: `image/${screenshotFormat === 'jpg' ? 'jpeg' : 'png'}` }],
        metadata: { engine: 'applescript' as Engine, degraded: false, latencyMs: Date.now() - start },
      };
    } catch (error: unknown) {
      if (usingTmpFile) {
        await unlink(tmpFile).catch(() => {});
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Screenshot failed: ${message}`);
    }
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
        ['log', 'warn', 'error', 'info'].forEach(function(method) {
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
    if (!result.ok) throw new Error(result.error?.message ?? 'Get console messages failed');

    return this.makeResponse(
      result.value ? JSON.parse(result.value) : { messages: [], count: 0 },
      Date.now() - start,
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private makeResponse(data: unknown, latencyMs: number = 0): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript' as Engine, degraded: false, latencyMs },
    };
  }
}
