import type { IEngine } from '../engines/engine.js';
import type { ToolResponse, ToolRequirements } from '../types.js';
import { EngineRequiredError } from '../errors.js';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

// Map a urlPattern to a stable DNR rule id. Same pattern → same id, so re-adds
// REPLACE (browser.declarativeNetRequest.updateDynamicRules dedups by id) and
// safari_clear_authentication can target the rule without an opaque token.
// Range [10000, 110000) is far above any rule id Safari Pilot otherwise emits.
function urlPatternToRuleId(pattern: string): number {
  let h = 5381;
  for (let i = 0; i < pattern.length; i++) {
    h = ((h << 5) + h + pattern.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 100000 + 10000;
}

export class AuthTools {
  private engine: IEngine;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: IEngine) {
    this.engine = engine;
    this.handlers.set('safari_authenticate', this.handleAuthenticate.bind(this));
    this.handlers.set('safari_clear_authentication', this.handleClear.bind(this));
  }

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_authenticate',
        description:
          'Set HTTP basic-auth credentials for matching URLs via DNR header injection. ' +
          'Parity with Playwright\'s `httpCredentials`. Encodes Authorization: Basic <b64(user:pass)> ' +
          'and registers a declarativeNetRequest rule on the extension. ' +
          'Re-issuing for the same urlPattern REPLACES the prior credentials. ' +
          'Requires extension engine — DNR has no AppleScript fallback.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current tab URL (used for routing)' },
            username: { type: 'string', description: 'HTTP basic-auth username' },
            password: { type: 'string', description: 'HTTP basic-auth password' },
            urlPattern: {
              type: 'string',
              description: 'Match pattern for the rule (e.g. "*://api.example.com/*"). Becomes the DNR condition.urlFilter.',
            },
            authType: {
              type: 'string',
              enum: ['basic'],
              description: 'Auth scheme. Only "basic" is supported in v1.',
              default: 'basic',
            },
          },
          required: ['tabUrl', 'username', 'password', 'urlPattern'],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_clear_authentication',
        description:
          'Remove HTTP basic-auth credentials previously set by safari_authenticate. ' +
          'Targets the rule by hashing the SAME urlPattern that was passed to add — ' +
          'no need to remember the numeric rule id.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current tab URL (used for routing)' },
            urlPattern: { type: 'string', description: 'The same urlPattern passed to safari_authenticate.' },
          },
          required: ['tabUrl', 'urlPattern'],
        },
        requirements: { idempotent: true },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  private requireExtension(): void {
    if (this.engine.name !== 'extension') {
      throw new EngineRequiredError('HTTP authentication via DNR header injection');
    }
  }

  private async handleAuthenticate(params: Record<string, unknown>): Promise<ToolResponse> {
    this.requireExtension();
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const username = params['username'] as string;
    const password = params['password'] as string;
    // Default urlPattern to "*://<host>/*" derived from tabUrl when omitted —
    // matches the agent's natural intent of "auth THIS site I'm on".
    let urlPattern = params['urlPattern'] as string | undefined;
    if (!urlPattern) {
      try {
        const u = new URL(tabUrl);
        urlPattern = `*://${u.hostname}/*`;
      } catch {
        urlPattern = '*://*/*';
      }
    }

    const credentials = Buffer.from(`${username}:${password}`, 'utf-8').toString('base64');
    const ruleId = urlPatternToRuleId(urlPattern);
    const rule = {
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Authorization', operation: 'set', value: `Basic ${credentials}` },
        ],
      },
      condition: {
        urlFilter: urlPattern,
        resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'script', 'stylesheet', 'image', 'font', 'media', 'websocket', 'other'],
      },
    };

    const sentinel = `__SP_DNR_ADD_RULE__:${JSON.stringify({ rule })}`;
    const result = await this.engine.executeJsInTab(tabUrl, sentinel);
    if (!result.ok) throw new Error(result.error?.message ?? 'DNR add rule failed');

    return {
      content: [{ type: 'text', text: JSON.stringify({ ruleId, urlPattern, authType: 'basic' }) }],
      metadata: { engine: this.engine.name, degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handleClear(params: Record<string, unknown>): Promise<ToolResponse> {
    this.requireExtension();
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const urlPattern = params['urlPattern'] as string;

    const ruleId = urlPatternToRuleId(urlPattern);
    const sentinel = `__SP_DNR_REMOVE_RULE__:${JSON.stringify({ ruleId })}`;
    const result = await this.engine.executeJsInTab(tabUrl, sentinel);
    if (!result.ok) throw new Error(result.error?.message ?? 'DNR remove rule failed');

    return {
      content: [{ type: 'text', text: JSON.stringify({ cleared: true, ruleId, urlPattern }) }],
      metadata: { engine: this.engine.name, degraded: false, latencyMs: Date.now() - start },
    };
  }
}
