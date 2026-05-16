import type { ToolResponse, ToolRequirements } from '../types.js';
import type { IEngine } from '../engines/engine.js';
import { wrapEngineError } from '../errors.js';
import type { Engine } from '../types.js';
import { escapeForJsSingleQuote } from '../escape.js';
import { routeFrameAware } from './_frame-routing-helper.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class ShadowTools {
  private engine: IEngine;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: IEngine) {
    this.engine = engine;
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.handlers.set('safari_query_shadow', this.handleQueryShadow.bind(this));
    this.handlers.set('safari_click_shadow', this.handleClickShadow.bind(this));
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_query_shadow',
        description:
          'Find an element inside Shadow DOM, piercing open shadow roots. Use when standard CSS selectors fail because the target is in a custom-element shadow tree.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            hostSelector: { type: 'string', description: 'CSS selector for the shadow host element (the element with a shadowRoot)' },
            shadowSelector: { type: 'string', description: 'CSS selector to query inside the shadow root' },
            frameId: { type: 'number', description: 'Optional: target a specific iframe by frameId from safari_list_frames (cross-origin requires extension engine)' },
          },
          required: ['tabUrl', 'hostSelector', 'shadowSelector'],
        },
        requirements: { idempotent: true, requiresShadowDom: true, requiresFramesCrossOrigin: true },
      },
      {
        name: 'safari_click_shadow',
        description:
          'Click an element inside Shadow DOM. Use when safari_click fails because the target element is inside a shadow-root; shadow-aware replacement for safari_click.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            hostSelector: { type: 'string', description: 'CSS selector for the shadow host element' },
            shadowSelector: { type: 'string', description: 'CSS selector for the element to click inside the shadow root' },
            frameId: { type: 'number', description: 'Optional: target a specific iframe by frameId from safari_list_frames (cross-origin requires extension engine)' },
          },
          required: ['tabUrl', 'hostSelector', 'shadowSelector'],
        },
        requirements: { idempotent: false, requiresShadowDom: true, requiresFramesCrossOrigin: true },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleQueryShadow(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const frameId = params['frameId'] as number | undefined;
    const hostSelector = params['hostSelector'] as string;
    const shadowSelector = params['shadowSelector'] as string;

    const escapedHost = escapeForJsSingleQuote(hostSelector);
    const escapedShadow = escapeForJsSingleQuote(shadowSelector);

    const js = `
      var host = document.querySelector('${escapedHost}');
      if (!host) throw Object.assign(new Error('Shadow host not found: ${escapedHost}'), { name: 'ELEMENT_NOT_FOUND' });
      var root = host.shadowRoot;
      if (!root) throw Object.assign(new Error('Element has no shadowRoot: ${escapedHost}'), { name: 'SHADOW_ROOT_NOT_FOUND' });
      var el = root.querySelector('${escapedShadow}');
      if (!el) throw Object.assign(new Error('Shadow element not found: ${escapedShadow}'), { name: 'ELEMENT_NOT_FOUND' });

      var rect = el.getBoundingClientRect();
      return {
        found: true,
        element: {
          tagName: el.tagName,
          id: el.id || undefined,
          className: el.className || undefined,
          textContent: (el.textContent || '').slice(0, 200),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        },
      };
    `;

    const result = await routeFrameAware(this.engine, { tabUrl, frameId }, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Shadow query failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { found: false }, Date.now() - start);
  }

  private async handleClickShadow(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const frameId = params['frameId'] as number | undefined;
    const hostSelector = params['hostSelector'] as string;
    const shadowSelector = params['shadowSelector'] as string;

    const escapedHost = escapeForJsSingleQuote(hostSelector);
    const escapedShadow = escapeForJsSingleQuote(shadowSelector);

    const js = `
      var host = document.querySelector('${escapedHost}');
      if (!host) throw Object.assign(new Error('Shadow host not found: ${escapedHost}'), { name: 'ELEMENT_NOT_FOUND' });
      var root = host.shadowRoot;
      if (!root) throw Object.assign(new Error('Element has no shadowRoot: ${escapedHost}'), { name: 'SHADOW_ROOT_NOT_FOUND' });
      var el = root.querySelector('${escapedShadow}');
      if (!el) throw Object.assign(new Error('Shadow element not found: ${escapedShadow}'), { name: 'ELEMENT_NOT_FOUND' });

      var rect = el.getBoundingClientRect();
      var opts = { bubbles: true, cancelable: true, view: window, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));

      return {
        clicked: true,
        element: {
          tagName: el.tagName,
          id: el.id || undefined,
          textContent: (el.textContent || '').slice(0, 100),
        },
      };
    `;

    const result = await routeFrameAware(this.engine, { tabUrl, frameId }, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Shadow click failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { clicked: true }, Date.now() - start);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private makeResponse(data: unknown, latencyMs: number = 0): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript' as Engine, degraded: false, latencyMs },
    };
  }
}
