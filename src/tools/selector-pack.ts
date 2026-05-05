import { validatePackName, validatePackBody } from '../security/selector-pack-validator.js';
import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class SelectorPackTools {
  private engine: IEngine;
  private enabled: boolean;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: IEngine, config: { enabled: boolean }) {
    this.engine = engine;
    this.enabled = config.enabled;
    if (this.enabled) {
      this.handlers.set('safari_register_selector', this.handleRegister.bind(this));
      this.handlers.set('safari_unregister_selector', this.handleUnregister.bind(this));
    }
  }

  getDefinitions(): ToolDefinition[] {
    if (!this.enabled) return [];
    return [
      {
        name: 'safari_register_selector',
        description:
          'Register a custom selector engine on a tab as a JS function body. Use when the same complex element-finding logic is needed >2 times — register once, then call any locator-using tool with selector="pack:<name>=<arg>"; persists across navigations until tab close (passes through HumanApproval).',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Tab URL the pack registers under' },
            name: { type: 'string', description: 'Pack name (alphanumeric+underscore, max 64 chars)' },
            body: { type: 'string', description: 'JS function body (max 32KB). Receives (root, arg). Must return Element or null.' },
          },
          required: ['tabUrl', 'name', 'body'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_unregister_selector',
        description: 'Unregister a previously-registered selectorPack on the tab. Use when the pack name is being recycled or to free storage.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['tabUrl', 'name'],
        },
        requirements: { idempotent: true },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  private async handleRegister(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const name = params['name'] as string;
    const body = params['body'] as string;

    validatePackName(name);
    validatePackBody(body);

    // Cluster D: persistence delivered via __SP_PACK_REGISTER__ sentinel. The
    // extension intercepts and (a) writes sp_pack_<tabId>_<name>=body to
    // storage.local for re-injection on navigation; (b) injects window.__sp_pack[name]
    // into the page now via the standard storage-bus execute path. tabs.onUpdated
    // re-injects from storage on every status:complete; tabs.onRemoved cleans up.
    //
    // Sentinel payload uses JSON for the round-trip — name and body have already
    // passed validatePackName/validatePackBody so substring-injection paths are
    // closed at the validator layer. JSON.stringify is the only encoding needed
    // here for transport.
    const sentinel = '__SP_PACK_REGISTER__:' + JSON.stringify({ name, body });
    const result = await this.engine.executeJsInTab(tabUrl, sentinel);
    if (!result.ok) throw new Error(result.error?.message ?? 'register failed');
    const parsed = result.value ? JSON.parse(result.value) : { ok: false };
    if (!parsed.ok) throw new Error(`selectorPack register rejected by page: ${parsed.error}`);

    return this.makeResponse(parsed, Date.now() - start);
  }

  private async handleUnregister(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const name = params['name'] as string;
    validatePackName(name);

    // Cluster D: __SP_PACK_UNREGISTER__ sentinel removes both the storage key
    // and the page-side __sp_pack[name] entry.
    const sentinel = '__SP_PACK_UNREGISTER__:' + JSON.stringify({ name });
    const result = await this.engine.executeJsInTab(tabUrl, sentinel);
    if (!result.ok) throw new Error(result.error?.message ?? 'unregister failed');
    return this.makeResponse(result.value ? JSON.parse(result.value) : { ok: true }, Date.now() - start);
  }

  private makeResponse(data: unknown, latencyMs: number = 0): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: this.engine.name as Engine, degraded: false, latencyMs },
    };
  }
}
