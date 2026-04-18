import type { ToolResponse, ToolRequirements } from '../types.js';
import type { IEngine } from '../engines/engine.js';
import type { Engine } from '../types.js';

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
          'Query an element inside a Shadow DOM tree. Pierces the shadow boundary by accessing the ' +
          'host element\'s shadowRoot and querying within it. Returns element metadata when found.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            hostSelector: { type: 'string', description: 'CSS selector for the shadow host element (the element with a shadowRoot)' },
            shadowSelector: { type: 'string', description: 'CSS selector to query inside the shadow root' },
          },
          required: ['tabUrl', 'hostSelector', 'shadowSelector'],
        },
        requirements: { idempotent: true, requiresShadowDom: true },
      },
      {
        name: 'safari_click_shadow',
        description:
          'Click an element inside a Shadow DOM tree. Pierces the shadow boundary and dispatches ' +
          'the full click event sequence (mousedown, mouseup, click) on the shadow element.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            hostSelector: { type: 'string', description: 'CSS selector for the shadow host element' },
            shadowSelector: { type: 'string', description: 'CSS selector for the element to click inside the shadow root' },
          },
          required: ['tabUrl', 'hostSelector', 'shadowSelector'],
        },
        requirements: { idempotent: false, requiresShadowDom: true },
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
    const hostSelector = params['hostSelector'] as string;
    const shadowSelector = params['shadowSelector'] as string;

    const escapedHost = hostSelector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escapedShadow = shadowSelector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

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

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Shadow query failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { found: false }, Date.now() - start);
  }

  private async handleClickShadow(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const hostSelector = params['hostSelector'] as string;
    const shadowSelector = params['shadowSelector'] as string;

    const escapedHost = hostSelector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escapedShadow = shadowSelector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

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

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Shadow click failed');

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
