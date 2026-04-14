import type { ToolResponse, ToolRequirements } from '../types.js';
import type { IEngine } from '../engines/engine.js';
import type { ToolDefinition } from './navigation.js';

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export type WaitCondition =
  | 'selector'
  | 'selectorHidden'
  | 'text'
  | 'textGone'
  | 'urlMatch'
  | 'networkidle'
  | 'function';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const NETWORK_IDLE_QUIET_MS = 500;

/**
 * Build the JS snippet that checks a condition and returns true/false.
 */
function buildConditionJs(condition: WaitCondition, value: string): string {
  switch (condition) {
    case 'selector':
      return `return document.querySelector(${JSON.stringify(value)}) !== null`;

    case 'selectorHidden':
      return `return document.querySelector(${JSON.stringify(value)}) === null`;

    case 'text':
      return `return document.body && document.body.textContent.includes(${JSON.stringify(value)})`;

    case 'textGone':
      return `return !document.body || !document.body.textContent.includes(${JSON.stringify(value)})`;

    case 'urlMatch':
      return `return location.href.includes(${JSON.stringify(value)})`;

    case 'networkidle': {
      // Track in-flight XHR/fetch count and resolve when quiet for NETWORK_IDLE_QUIET_MS.
      // The JS returns true once there has been no XHR/fetch activity for the threshold.
      return `return (function() {
  if (!window.__safariPilotNetworkIdleSetup) {
    window.__safariPilotNetworkIdleSetup = true;
    window.__safariPilotInflight = 0;
    window.__safariPilotLastActivity = Date.now();
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function() {
      window.__safariPilotInflight++;
      window.__safariPilotLastActivity = Date.now();
      this.addEventListener('loadend', function() {
        window.__safariPilotInflight = Math.max(0, window.__safariPilotInflight - 1);
        window.__safariPilotLastActivity = Date.now();
      });
      return origSend.apply(this, arguments);
    };
    const origFetch = window.fetch;
    window.fetch = function() {
      window.__safariPilotInflight++;
      window.__safariPilotLastActivity = Date.now();
      return origFetch.apply(this, arguments).finally(function() {
        window.__safariPilotInflight = Math.max(0, window.__safariPilotInflight - 1);
        window.__safariPilotLastActivity = Date.now();
      });
    };
  }
  return window.__safariPilotInflight === 0 && (Date.now() - window.__safariPilotLastActivity) >= ${NETWORK_IDLE_QUIET_MS};
})()
`.trim();
    }

    case 'function':
      // value is a JS function body — evaluate and return its truthy result
      return `return (function() { ${value} })()`;

    default:
      return 'return false';
  }
}

export class WaitTools {
  constructor(private readonly engine: IEngine) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_wait_for',
        description:
          'Wait for a condition to be met in the specified tab before proceeding. ' +
          'Polls the page at configurable intervals until the condition is satisfied or the timeout expires. ' +
          'Supports waiting for DOM selectors, text content, URL patterns, network idle, and custom JS functions.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab to poll' },
            condition: {
              type: 'string',
              enum: ['selector', 'selectorHidden', 'text', 'textGone', 'urlMatch', 'networkidle', 'function'],
              description:
                'The condition to wait for: ' +
                '"selector" — element matching CSS selector exists; ' +
                '"selectorHidden" — element has disappeared; ' +
                '"text" — text appears in page body; ' +
                '"textGone" — text is absent from page body; ' +
                '"urlMatch" — current URL contains the pattern; ' +
                '"networkidle" — no XHR/fetch activity for 500 ms; ' +
                '"function" — custom JS function body returns truthy',
            },
            value: {
              type: 'string',
              description: 'The CSS selector, text, URL pattern, or JS function body depending on condition',
            },
            timeout: {
              type: 'number',
              description: 'Maximum time to wait in milliseconds',
              default: DEFAULT_TIMEOUT_MS,
            },
            pollInterval: {
              type: 'number',
              description: 'How often to check the condition in milliseconds',
              default: DEFAULT_POLL_INTERVAL_MS,
            },
          },
          required: ['tabUrl', 'condition'],
        },
        requirements: {} as ToolRequirements,
      },
    ];
  }

  getHandler(name: string): Handler {
    switch (name) {
      case 'safari_wait_for':
        return (p) => this.handleWaitFor(p);
      default:
        throw new Error(`WaitTools: unknown tool "${name}"`);
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleWaitFor(params: Record<string, unknown>): Promise<ToolResponse> {
    const wallStart = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const condition = params['condition'] as WaitCondition;
    const value = typeof params['value'] === 'string' ? params['value'] : '';
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : DEFAULT_TIMEOUT_MS;
    const pollInterval = typeof params['pollInterval'] === 'number' ? params['pollInterval'] : DEFAULT_POLL_INTERVAL_MS;

    const conditionJs = buildConditionJs(condition, value);

    let met = false;
    let timedOut = false;

    while (true) {
      const elapsed = Date.now() - wallStart;

      if (elapsed >= timeout) {
        timedOut = true;
        break;
      }

      const result = await this.evalCondition(tabUrl, conditionJs);
      if (result === true) {
        met = true;
        break;
      }

      // Sleep for the poll interval — but cap it so we don't overshoot the timeout.
      const remaining = timeout - (Date.now() - wallStart);
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      await sleep(Math.min(pollInterval, remaining));
    }

    const elapsed = Date.now() - wallStart;
    return {
      content: [{ type: 'text', text: JSON.stringify({ met, elapsed, timedOut }) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: elapsed },
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Execute JS in a tab and return the raw boolean/truthy result.
   * Returns false on engine failure or unparseable output.
   */
  private async evalCondition(tabUrl: string, jsCode: string): Promise<boolean> {
    const result = await this.engine.executeJsInTab(tabUrl, jsCode);
    if (!result.ok || !result.value) return false;

    const raw = result.value.trim();
    // Engine returns 'true'/'false' as strings; also handle JSON booleans
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    try {
      return Boolean(JSON.parse(raw));
    } catch {
      return Boolean(raw);
    }
  }
}

// ── Module-level helpers ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
