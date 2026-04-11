import type { ToolResponse, ToolRequirements } from '../types.js';
import type { AppleScriptEngine } from '../engines/applescript.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

const WAIT_NAVIGATE_MS = 1000;
const WAIT_HISTORY_MS = 500;

/** JS snippet that returns {url, title} for the current page */
const PAGE_INFO_JS = 'return JSON.stringify({url: location.href, title: document.title})';

export class NavigationTools {
  constructor(private readonly engine: AppleScriptEngine) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_navigate',
        description:
          'Navigate to a URL in the specified tab (matched by current URL) or open in the active tab. ' +
          'Returns the final URL and page title after navigation.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Target URL to navigate to' },
            tabUrl: { type: 'string', description: 'Current URL of the tab to navigate (omit to use front tab)' },
            waitUntil: {
              type: 'string',
              enum: ['load', 'domcontentloaded', 'networkidle'],
              description: 'Navigation readiness signal (informational; Safari uses load)',
              default: 'load',
            },
            timeout: { type: 'number', description: 'Navigation timeout in milliseconds', default: 30000 },
          },
          required: ['url'],
        },
        requirements: {},
      },
      {
        name: 'safari_navigate_back',
        description: 'Go back one step in the browser history for the specified tab.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
          },
          required: ['tabUrl'],
        },
        requirements: {},
      },
      {
        name: 'safari_navigate_forward',
        description: 'Go forward one step in the browser history for the specified tab.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
          },
          required: ['tabUrl'],
        },
        requirements: {},
      },
      {
        name: 'safari_reload',
        description: 'Reload the page in the specified tab, optionally bypassing the cache.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab to reload' },
            bypassCache: {
              type: 'boolean',
              description: 'Force a hard reload bypassing browser cache',
              default: false,
            },
          },
          required: ['tabUrl'],
        },
        requirements: {},
      },
      {
        name: 'safari_new_tab',
        description:
          'Open a new agent-owned tab, optionally navigating to a URL and/or in a private window. ' +
          'Returns the new tab URL for future targeting.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL to open in the new tab (default: about:blank)', default: 'about:blank' },
            privateWindow: {
              type: 'boolean',
              description: 'Open in a private browsing window',
              default: false,
            },
          },
          required: [],
        },
        requirements: {},
      },
      {
        name: 'safari_close_tab',
        description: 'Close a specific agent-owned tab identified by its current URL.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab to close' },
          },
          required: ['tabUrl'],
        },
        requirements: {},
      },
      {
        name: 'safari_list_tabs',
        description:
          'List all open tabs across all Safari windows, including their URLs, titles, and basic metadata.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
        requirements: {},
      },
    ];
  }

  getHandler(name: string): Handler {
    switch (name) {
      case 'safari_navigate':
        return (p) => this.handleNavigate(p);
      case 'safari_navigate_back':
        return (p) => this.handleNavigateBack(p);
      case 'safari_navigate_forward':
        return (p) => this.handleNavigateForward(p);
      case 'safari_reload':
        return (p) => this.handleReload(p);
      case 'safari_new_tab':
        return (p) => this.handleNewTab(p);
      case 'safari_close_tab':
        return (p) => this.handleCloseTab(p);
      case 'safari_list_tabs':
        return () => this.handleListTabs();
      default:
        throw new Error(`NavigationTools: unknown tool "${name}"`);
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleNavigate(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const url = params['url'] as string;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 30000;

    const script = this.engine.buildNavigateScript(url);
    const navResult = await this.engine.execute(script, timeout);

    if (!navResult.ok) {
      return this.errorResponse(navResult.error?.message ?? 'Navigation failed', start);
    }

    await sleep(WAIT_NAVIGATE_MS);

    // Get final URL and title — use tabUrl if provided, else the target url
    const tabUrl = (params['tabUrl'] as string | undefined) ?? url;
    const pageInfo = await this.executeJsInTab(tabUrl, PAGE_INFO_JS);

    const data = pageInfo ?? { url, title: '' };
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handleNavigateBack(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    await this.executeJsInTab(tabUrl, 'history.back()');
    await sleep(WAIT_HISTORY_MS);

    const pageInfo = await this.executeJsInTab(tabUrl, PAGE_INFO_JS);
    const data = pageInfo ?? { url: tabUrl, title: '' };

    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handleNavigateForward(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    await this.executeJsInTab(tabUrl, 'history.forward()');
    await sleep(WAIT_HISTORY_MS);

    const pageInfo = await this.executeJsInTab(tabUrl, PAGE_INFO_JS);
    const data = pageInfo ?? { url: tabUrl, title: '' };

    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handleReload(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const bypassCache = params['bypassCache'] === true;

    const reloadJs = bypassCache ? 'location.reload(true)' : 'location.reload()';
    await this.executeJsInTab(tabUrl, reloadJs);
    await sleep(WAIT_NAVIGATE_MS);

    const pageInfo = await this.executeJsInTab(tabUrl, PAGE_INFO_JS);
    const data = pageInfo ?? { url: tabUrl, title: '' };

    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handleNewTab(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const url = (params['url'] as string | undefined) ?? 'about:blank';
    const privateWindow = params['privateWindow'] === true;

    const script = this.engine.buildNewTabScript(url, privateWindow);
    const result = await this.engine.execute(script);

    if (!result.ok) {
      return this.errorResponse(result.error?.message ?? 'Failed to open new tab', start);
    }

    // The engine result value contains the URL of the newly created tab.
    // Parse "tabUrl|||windowId" if present, otherwise use the target url.
    const raw = result.value ?? '';
    let tabUrl = url;
    let windowId: number | undefined;

    if (raw.includes('|||')) {
      const parts = raw.split('|||');
      tabUrl = parts[0]?.trim() ?? url;
      windowId = parts[1] ? parseInt(parts[1].trim(), 10) : undefined;
    } else if (raw.length > 0 && raw !== 'missing value') {
      tabUrl = raw.trim();
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ tabUrl, windowId }) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handleCloseTab(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    const script = this.engine.buildCloseTabScript(tabUrl);
    const result = await this.engine.execute(script);

    const closed = result.ok && result.value !== 'false';
    return {
      content: [{ type: 'text', text: JSON.stringify({ closed, tabUrl }) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handleListTabs(): Promise<ToolResponse> {
    const start = Date.now();

    const script = this.engine.buildListTabsScript();
    const result = await this.engine.execute(script);

    if (!result.ok) {
      return this.errorResponse(result.error?.message ?? 'Failed to list tabs', start);
    }

    const raw = result.value ?? '';
    const tabs = parseTabList(raw);

    return {
      content: [{ type: 'text', text: JSON.stringify({ tabs }) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Execute JavaScript in a tab identified by its URL.
   * Returns parsed page info if the JS returns JSON, otherwise undefined.
   */
  private async executeJsInTab(
    tabUrl: string,
    jsCode: string,
  ): Promise<Record<string, unknown> | undefined> {
    const script = this.engine.buildTabScript(tabUrl, jsCode);
    const result = await this.engine.execute(script);
    if (!result.ok || !result.value) return undefined;
    try {
      const parsed = JSON.parse(result.value);
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

// ── Module-level helpers ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse the raw output of buildListTabsScript.
 *
 * The AppleScript produces lines of: url\ttitle\n
 * The task spec references "winIdx|||tabIdx|||url|||title" as a potential alternative
 * format from enriched scripts — we handle both separators gracefully.
 */
export function parseTabList(raw: string): Array<{ url: string; title: string; index: number }> {
  if (!raw.trim()) return [];

  return raw
    .split('\n')
    .map((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return null;

      // Handle "winIdx|||tabIdx|||url|||title" format (enriched)
      if (trimmed.includes('|||')) {
        const parts = trimmed.split('|||');
        if (parts.length >= 4) {
          return { url: parts[2]?.trim() ?? '', title: parts[3]?.trim() ?? '', index: idx };
        }
        if (parts.length >= 2) {
          return { url: parts[0]?.trim() ?? '', title: parts[1]?.trim() ?? '', index: idx };
        }
      }

      // Handle "url\ttitle" format (default buildListTabsScript output)
      if (trimmed.includes('\t')) {
        const tabIdx = trimmed.indexOf('\t');
        return {
          url: trimmed.slice(0, tabIdx).trim(),
          title: trimmed.slice(tabIdx + 1).trim(),
          index: idx,
        };
      }

      // Single-field line — treat as URL
      return { url: trimmed, title: '', index: idx };
    })
    .filter((t): t is { url: string; title: string; index: number } => t !== null && t.url.length > 0);
}
