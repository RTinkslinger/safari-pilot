import type { ToolResponse, ToolRequirements } from '../types.js';
import type { IEngine } from '../engines/engine.js';
import type { ToolDefinition } from './navigation.js';

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

/**
 * JS that lists all registered service worker registrations for the current origin.
 * Returns an array of {scope, scriptURL, state} objects.
 */
const SW_LIST_JS = `
(async () => {
  if (!('serviceWorker' in navigator)) {
    return JSON.stringify({ registrations: [], supported: false });
  }
  const regs = await navigator.serviceWorker.getRegistrations();
  const registrations = regs.map(r => ({
    scope: r.scope,
    scriptURL: (r.active || r.installing || r.waiting)?.scriptURL ?? null,
    state: r.active ? 'active' : r.installing ? 'installing' : r.waiting ? 'waiting' : 'unknown',
    updateViaCache: r.updateViaCache,
  }));
  return JSON.stringify({ registrations, supported: true });
})()
`.trim();

/**
 * Build JS that unregisters a specific service worker by scope.
 */
function buildSwUnregisterJs(scope: string): string {
  const escapedScope = JSON.stringify(scope);
  return `
(async () => {
  if (!('serviceWorker' in navigator)) {
    return JSON.stringify({ unregistered: false, error: 'Service workers not supported' });
  }
  const regs = await navigator.serviceWorker.getRegistrations();
  const target = regs.find(r => r.scope === ${escapedScope});
  if (!target) {
    return JSON.stringify({ unregistered: false, error: 'No service worker found for scope: ' + ${escapedScope} });
  }
  const result = await target.unregister();
  return JSON.stringify({ unregistered: result, scope: ${escapedScope} });
})()
`.trim();
}

export class ServiceWorkerTools {
  constructor(private readonly engine: IEngine) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_sw_list',
        description:
          'List all registered service workers for the page\'s origin. ' +
          'Returns an array of registrations with their scope, scriptURL, and lifecycle state.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab to inspect' },
          },
          required: ['tabUrl'],
        },
        requirements: {} as ToolRequirements,
      },
      {
        name: 'safari_sw_unregister',
        description: 'Unregister a specific service worker by its scope URL.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab to execute in' },
            scope: { type: 'string', description: 'The scope URL of the service worker to unregister (e.g. "https://example.com/")' },
          },
          required: ['tabUrl', 'scope'],
        },
        requirements: {} as ToolRequirements,
      },
    ];
  }

  getHandler(name: string): Handler {
    switch (name) {
      case 'safari_sw_list':
        return (p) => this.handleSwList(p);
      case 'safari_sw_unregister':
        return (p) => this.handleSwUnregister(p);
      default:
        throw new Error(`ServiceWorkerTools: unknown tool "${name}"`);
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleSwList(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    const result = await this.engine.executeJsInTab(tabUrl, SW_LIST_JS);

    if (!result.ok) {
      return this.errorResponse(result.error?.message ?? 'Failed to list service workers', start);
    }

    const data = this.parseJson(result.value) ?? { registrations: [], supported: false };
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handleSwUnregister(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const scope = params['scope'] as string;

    const js = buildSwUnregisterJs(scope);
    const result = await this.engine.executeJsInTab(tabUrl, js);

    if (!result.ok) {
      return this.errorResponse(result.error?.message ?? 'Failed to unregister service worker', start);
    }

    const data = this.parseJson(result.value) ?? { unregistered: false };
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
