import { execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppleScriptEngine } from '../engines/applescript.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class ExtractionTools {
  private engine: AppleScriptEngine;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: AppleScriptEngine) {
    this.engine = engine;
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
          'Capture the page accessibility tree as a compact representation. The primary way the agent "sees" the page. ' +
          'Returns roles, names, states, and interactive element metadata.',
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
            maxDepth: { type: 'number', description: 'Maximum DOM traversal depth', default: 10 },
            includeHidden: {
              type: 'boolean',
              description: 'Include hidden elements in snapshot',
              default: false,
            },
          },
          required: ['tabUrl'],
        },
        requirements: {},
      },
      {
        name: 'safari_get_text',
        description: 'Extract the visible text content of the page or a specific element.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'CSS selector. If omitted, returns full page text.' },
            maxLength: { type: 'number', description: 'Maximum characters to return', default: 50000 },
          },
          required: ['tabUrl'],
        },
        requirements: {},
      },
      {
        name: 'safari_get_html',
        description: 'Get the HTML content of an element or the full page.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'CSS selector. If omitted, returns full page HTML.' },
            outer: {
              type: 'boolean',
              description: 'true = outerHTML (includes the element itself), false = innerHTML (just contents)',
              default: true,
            },
          },
          required: ['tabUrl'],
        },
        requirements: {},
      },
      {
        name: 'safari_get_attribute',
        description: 'Get a specific attribute value from an element.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'CSS selector for the element' },
            attribute: { type: 'string', description: 'Attribute name: href, src, data-id, aria-label, etc.' },
          },
          required: ['tabUrl', 'selector', 'attribute'],
        },
        requirements: {},
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
        requirements: {},
      },
      {
        name: 'safari_take_screenshot',
        description:
          'Capture a screenshot of the Safari window via screencapture CLI. ' +
          'Returns the image as base64-encoded PNG. Requires Screen Recording permission.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab (used to bring it to front)' },
            fullPage: {
              type: 'boolean',
              description: 'Capture the full scrollable page (not just viewport)',
              default: false,
            },
            path: {
              type: 'string',
              description: 'Optional file path to save the screenshot. If omitted, returns base64 data.',
            },
            format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format', default: 'png' },
            quality: { type: 'number', description: 'JPEG quality 0-100', default: 80 },
          },
          required: [],
        },
        requirements: {},
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
        requirements: {},
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
    const maxDepth = typeof params['maxDepth'] === 'number' ? params['maxDepth'] : 10;
    const includeHidden = params['includeHidden'] === true;
    const scopeSelector = scope === 'page' || !scope ? '' : scope.replace(/'/g, "\\'");

    const js = `
      var maxD = ${maxDepth};
      var inclHidden = ${includeHidden};
      var scopeSelector = '${scopeSelector}';

      function getRole(el) {
        if (el.getAttribute('role')) return el.getAttribute('role');
        var tag = el.tagName.toLowerCase();
        var typeMap = {
          a: 'link', button: 'button', input: 'textbox', select: 'combobox',
          textarea: 'textbox', img: 'img', h1: 'heading', h2: 'heading', h3: 'heading',
          h4: 'heading', h5: 'heading', h6: 'heading', nav: 'navigation', main: 'main',
          form: 'form', table: 'table', ul: 'list', ol: 'list', li: 'listitem'
        };
        return typeMap[tag] || '';
      }

      function getName(el) {
        return el.getAttribute('aria-label') || el.getAttribute('alt') ||
          el.getAttribute('title') || el.getAttribute('placeholder') ||
          (el.labels && el.labels[0] ? el.labels[0].textContent.trim() : '') ||
          (el.textContent || '').trim().slice(0, 80);
      }

      function getState(el) {
        var states = [];
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
          if (el.required) states.push('required');
          if (el.disabled) states.push('disabled');
          if (el.readOnly) states.push('readonly');
          if (el.type === 'checkbox' || el.type === 'radio') states.push(el.checked ? 'checked' : 'unchecked');
          if (el.type) states.push('type=' + el.type);
        }
        if (el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && el.type === 'submit')) {
          states.push(el.disabled ? 'disabled' : 'enabled');
        }
        var level = el.tagName.match(/^H(\\d)$/i);
        if (level) states.push('level=' + level[1]);
        return states;
      }

      function isInteractive(el) {
        var tag = el.tagName.toLowerCase();
        return ['a', 'button', 'input', 'select', 'textarea'].indexOf(tag) !== -1 ||
          el.getAttribute('role') === 'button' || el.getAttribute('tabindex') !== null ||
          el.onclick !== null;
      }

      var lines = [];
      var elementCount = 0;
      var interactiveCount = 0;

      function walk(node, depth) {
        if (depth > maxD) return;
        if (node.nodeType !== 1) return;
        if (!inclHidden && (node.offsetParent === null && getComputedStyle(node).position !== 'fixed')) return;

        var role = getRole(node);
        var name = getName(node);
        if (role || isInteractive(node)) {
          elementCount++;
          if (isInteractive(node)) interactiveCount++;
          var indent = '';
          for (var i = 0; i < depth; i++) indent += '  ';
          var states = getState(node);
          var stateStr = states.length ? ' [' + states.join(', ') + ']' : '';
          var idStr = node.id ? ' #' + node.id : '';
          var hrefStr = node.tagName === 'A' && node.href ? ' -> ' + new URL(node.href).pathname : '';
          lines.push(indent + '- ' + (role || node.tagName.toLowerCase()) + (name ? ' "' + name.replace(/"/g, '\\\\"').slice(0, 80) + '"' : '') + stateStr + idStr + hrefStr);
        }

        for (var ci = 0; ci < node.children.length; ci++) {
          walk(node.children[ci], depth + (role ? 1 : 0));
        }
      }

      var root = scopeSelector ? document.querySelector(scopeSelector) : document.body;
      if (!root) throw Object.assign(new Error('Scope element not found'), { name: 'ELEMENT_NOT_FOUND' });
      walk(root, 0);

      return {
        snapshot: lines.join('\\n'),
        url: window.location.href,
        title: document.title,
        elementCount: elementCount,
        interactiveCount: interactiveCount,
      };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Snapshot failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleGetText(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string | undefined;
    const maxLength = typeof params['maxLength'] === 'number' ? params['maxLength'] : 50000;

    const escapedSelector = selector ? selector.replace(/'/g, "\\'") : '';
    const js = `
      var el = ${selector ? `document.querySelector('${escapedSelector}')` : 'document.body'};
      if (!el) throw Object.assign(new Error('Element not found'), { name: 'ELEMENT_NOT_FOUND' });
      var max = ${maxLength};
      var text = el.innerText || el.textContent || '';
      return { text: text.slice(0, max), length: text.length, truncated: text.length > max };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Get text failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleGetHtml(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string | undefined;
    const outer = params['outer'] !== false;

    const escapedSelector = selector ? selector.replace(/'/g, "\\'") : '';
    const js = `
      var el = ${selector ? `document.querySelector('${escapedSelector}')` : 'document.documentElement'};
      if (!el) throw Object.assign(new Error('Element not found'), { name: 'ELEMENT_NOT_FOUND' });
      var html = ${outer ? 'el.outerHTML' : 'el.innerHTML'};
      return { html: html, length: html.length };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Get HTML failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleGetAttribute(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string;
    const attribute = params['attribute'] as string;

    const escapedSelector = selector.replace(/'/g, "\\'");
    const escapedAttribute = attribute.replace(/'/g, "\\'");
    const js = `
      var el = document.querySelector('${escapedSelector}');
      if (!el) throw Object.assign(new Error('Element not found'), { name: 'ELEMENT_NOT_FOUND' });
      return {
        value: el.getAttribute('${escapedAttribute}'),
        element: { tagName: el.tagName, id: el.id || undefined },
      };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Get attribute failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleEvaluate(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const script = params['script'] as string;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 10000;

    const js = `
      var __userResult = (function() { ${script} })();
      return { value: __userResult, type: typeof __userResult };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js, timeout);
    if (!result.ok) throw new Error(result.error?.message ?? 'Evaluate failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleTakeScreenshot(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const format = (params['format'] as string | undefined) ?? 'png';
    const savePath = params['path'] as string | undefined;
    const screenshotFormat = format === 'jpeg' ? 'jpg' : 'png';
    const tmpFile = savePath ?? join(tmpdir(), `safari-pilot-${Date.now()}.${screenshotFormat}`);
    const usingTmpFile = !savePath;

    try {
      await new Promise<void>((resolve, reject) => {
        execFile('screencapture', ['-x', '-t', screenshotFormat, tmpFile], { timeout: 10000 }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

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
