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
          'Navigate the current tab to a URL and wait for load. ' +
          'Use when starting a task, following a known link, or after a redirect chain; updates tab ownership so subsequent tools target the new URL.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Target URL to navigate to' },
            tabUrl: { type: 'string', description: 'Current URL of the agent-owned tab to navigate' },
            waitUntil: {
              type: 'string',
              enum: ['load', 'domcontentloaded', 'networkidle'],
              description: 'Navigation readiness signal (informational; Safari uses load)',
              default: 'load',
            },
            timeout: { type: 'number', description: 'Navigation timeout in milliseconds', default: 30000 },
          },
          required: ['url', 'tabUrl'],
        },
        requirements: { idempotent: false, requiresApplescript: true },
      },
      {
        name: 'safari_navigate_back',
        description: 'Go back one step in browser history. Use when the previous page is needed after following a link or submitting a form.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false, requiresApplescript: true },
      },
      {
        name: 'safari_navigate_forward',
        description: 'Go forward one step in browser history. Use when re-advancing to a page visited before a safari_navigate_back call.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false, requiresApplescript: true },
      },
      {
        name: 'safari_reload',
        description: 'Reload the page in the specified tab. Use when a page needs a hard refresh to reflect server-side state changes or to clear stale UI.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab to reload' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false, requiresApplescript: true },
      },
      {
        name: 'safari_new_tab',
        description:
          'Open a new Safari tab at a URL AND wait for the page to load before returning. ' +
          'After this call, extraction and interaction tools (safari_get_text, safari_click, safari_evaluate, etc.) ' +
          'can be called directly on the returned tabUrl — no need to insert safari_wait_for between safari_new_tab ' +
          'and the next tool call. Use when isolating work from an existing tab, opening multiple windows in parallel, ' +
          'or starting a task with a fresh context; returns a tabUrl you must pass to subsequent tools.',
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
        requirements: { idempotent: false, requiresApplescript: true },
      },
      {
        name: 'safari_close_tab',
        description:
          'Close a specific agent-owned tab. ' +
          'NOTE: routine cleanup is NOT required — the MCP server automatically closes its session window (and every tab inside it) when the session ends, so end-of-task close_tab calls are redundant and waste a turn. ' +
          'Use only when you need to free a tab MID-TASK (e.g., recovering from an unrecoverable page state, switching contexts before opening another tab with the same URL).',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab to close' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false, requiresApplescript: true },
      },
      {
        name: 'safari_list_tabs',
        description:
          'List all Safari tabs the agent owns (created via safari_new_tab). Use when you have lost track of an agent-owned tab or need to discover available tabs after an unexpected error; bypasses ownership checks.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
        requirements: { idempotent: true, requiresApplescript: true },
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
    const tabUrlParam = params['tabUrl'];
    // Security: tabUrl is required so that server-side ownership enforcement can
    // verify the target tab is agent-owned. Without it, the "front tab" fallback
    // would let the agent navigate ANY user tab (banking, email, etc.).
    if (typeof tabUrlParam !== 'string' || tabUrlParam === '') {
      throw new Error(
        'safari_navigate requires `tabUrl` (the current URL of an agent-owned tab). ' +
        'Open a tab with safari_new_tab first, then pass its URL as tabUrl.',
      );
    }
    const tabUrl = tabUrlParam;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 30000;

    // Positional targeting: server injects _windowId/_tabIndex from ownership registry
    const windowId = typeof params['_windowId'] === 'number' ? params['_windowId'] : undefined;
    const tabIndex = typeof params['_tabIndex'] === 'number' ? params['_tabIndex'] : undefined;

    const script = this.engine.buildNavigateScript(url, windowId, tabIndex);
    const navResult = await this.engine.execute(script, timeout);

    if (!navResult.ok) {
      return this.errorResponse(navResult.error?.message ?? 'Navigation failed', start);
    }

    // T06 — wait for JS-responsiveness (not just elapsed time) after navigation,
    // same rationale as handleNewTab: ad-heavy destination pages wedge the
    // WebContent main thread during ad-load; returning while wedged makes the
    // agent's first extraction time out and burn turns retrying. Poll a trivial
    // eval until responsive, up to a budget; the page is reached by position
    // (windowId/tabIndex) since the URL just changed and the registry is stale.
    if (windowId !== undefined && tabIndex !== undefined) {
      const probeDeadline = Date.now() + 18_000;
      await sleep(WAIT_NAVIGATE_MS);
      while (Date.now() < probeDeadline) {
        const probe = await this.engine.executeJsInTabByPosition(windowId, tabIndex, 'return 1+1;', 3000);
        if (probe.ok && typeof probe.value === 'string' && probe.value.includes('2')) break;
        await sleep(1500);
      }
    } else {
      await sleep(WAIT_NAVIGATE_MS);
    }

    // Get final URL and title via the original tabUrl.
    // Known limitation (T2): the tab's URL has changed but the registry still has
    // the old URL. executeJsInTab looks up by URL which will fail. A subsequent
    // tool call with the NEW url will also fail until T2 wires the update.
    const pageInfo = await this.executeJsInTab(tabUrl, PAGE_INFO_JS);

    const data = pageInfo ?? { url, title: '' };
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: {
        engine: 'applescript',
        degraded: false,
        latencyMs: Date.now() - start,
        suggested_next_tools: [
          { tool: 'safari_snapshot', reason: 'Get a YAML map of the new page with refs you can pass to subsequent locator-using tools.' },
        ],
      },
    };
  }

  private async handleNavigateBack(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const windowId = typeof params['_windowId'] === 'number' ? params['_windowId'] : undefined;
    const tabIndex = typeof params['_tabIndex'] === 'number' ? params['_tabIndex'] : undefined;

    await this.executeJsInTab(tabUrl, 'history.back()');
    await sleep(WAIT_HISTORY_MS);

    // After history.back(), the tab URL has changed — query by position if available,
    // otherwise fall back to stale URL (may fail).
    const pageInfo = windowId && tabIndex
      ? await this.executeJsInTabByPosition(windowId, tabIndex, PAGE_INFO_JS)
      : await this.executeJsInTab(tabUrl, PAGE_INFO_JS);
    const data = pageInfo ?? { url: tabUrl, title: '' };

    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handleNavigateForward(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const windowId = typeof params['_windowId'] === 'number' ? params['_windowId'] : undefined;
    const tabIndex = typeof params['_tabIndex'] === 'number' ? params['_tabIndex'] : undefined;

    await this.executeJsInTab(tabUrl, 'history.forward()');
    await sleep(WAIT_HISTORY_MS);

    // After history.forward(), the tab URL has changed — query by position if available.
    const pageInfo = windowId && tabIndex
      ? await this.executeJsInTabByPosition(windowId, tabIndex, PAGE_INFO_JS)
      : await this.executeJsInTab(tabUrl, PAGE_INFO_JS);
    const data = pageInfo ?? { url: tabUrl, title: '' };

    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handleReload(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    // T51 — `bypassCache: true` historically emitted `location.reload(true)`,
    // but the boolean argument is non-standard (never in the WHATWG spec)
    // and Safari/WebKit's behavior is unverified. The param had zero
    // callers in the repo. Spec-compliant `location.reload()` only.
    await this.executeJsInTab(tabUrl, 'location.reload()');
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
    const sessionWindowId = typeof params['_sessionWindowId'] === 'number' ? params['_sessionWindowId'] : undefined;

    let script = this.engine.buildNewTabScript(url, privateWindow, sessionWindowId);
    let result = await this.engine.execute(script);

    // If the session window was closed, retry without windowId (opens in front window).
    // The server will detect the missing windowId in the response and open a new session window.
    if (!result.ok && result.error?.message?.includes('WINDOW_CLOSED')) {
      script = this.engine.buildNewTabScript(url, privateWindow);
      result = await this.engine.execute(script);
    }

    // Fix B (2026-05-18) — when no _sessionWindowId is supplied (bench
    // mode via SAFARI_PILOT_NO_SESSION_WINDOW=1) and Safari has zero
    // windows, the `tell front window` AppleScript path errors with
    // `-1719` ("Can't get window 1. Invalid index") or `-1700` ("Can't
    // make missing value into type tab"). The 2026-05-18 batch-probe RCA
    // (bench-runs/v0136-probes/RCA-batch-regression.md §4 Factor 3)
    // documented four catastrophic tasks where the agent had to discover
    // this and run `Bash osascript ... activate` itself, burning 4–6
    // turns. Activate Safari ourselves and retry once. Match the
    // message substring (not just the APPLESCRIPT_ERROR code class) so
    // unrelated AppleScript errors fall through to errorResponse.
    if (
      !result.ok &&
      sessionWindowId === undefined &&
      result.error?.message !== undefined &&
      (result.error.message.includes('(-1719)') || result.error.message.includes('(-1700)'))
    ) {
      await this.engine.execute('tell application "Safari" to activate');
      script = this.engine.buildNewTabScript(url, privateWindow);
      result = await this.engine.execute(script);
    }

    if (!result.ok) {
      return this.errorResponse(result.error?.message ?? 'Failed to open new tab', start);
    }

    // The engine result value contains the URL of the newly created tab.
    // Parse "tabUrl|||windowId|||tabIndex" — positional identity for subsequent operations.
    const raw = result.value ?? '';
    let tabUrl = url;
    let windowId: number | undefined;
    let tabIndex: number | undefined;

    if (raw.includes('|||')) {
      const parts = raw.split('|||');
      tabUrl = parts[0]?.trim() ?? url;
      windowId = parts[1] ? parseInt(parts[1].trim(), 10) : undefined;
      tabIndex = parts[2] ? parseInt(parts[2].trim(), 10) : undefined;
    } else if (raw.length > 0 && raw !== 'missing value') {
      tabUrl = raw.trim();
    }

    // T03 — implicit wait for page load. handleNavigate already does this
    // (WAIT_NAVIGATE_MS sleep after AppleScript). handleNewTab did not,
    // forcing agents to insert a defensive safari_wait_for after every
    // safari_new_tab. Empirical evidence: every bench task's SP trace
    // (bare1-sp through bare4-sp) shows a safari_wait_for that returns in
    // 30-50ms because the page IS already loaded — the wait_for is wasted
    // turn. Matching handleNavigate's behavior closes that 1-turn gap.
    //
    // T06 — wait for JS-RESPONSIVENESS, not just elapsed time. Ad-heavy
    // pages (recipe sites, news) wedge the WebContent main thread during
    // ad-load; returning while wedged makes the agent's first extraction
    // time out, and it then burns 10+ turns retrying (Allrecipes--4/5:
    // 388-513s, 17-19 turns). The wedge is intermittent/transient — a
    // probe showed the same page responsive in 411ms when not caught
    // mid-ad-load. Poll a trivial eval until it returns, up to a budget,
    // so safari_new_tab returns only when the page can execute JS. On a
    // page that never settles, the budget caps the wait (no worse than a
    // fixed sleep). windowId/tabIndex come from the make-tab result above.
    if (url !== 'about:blank') {
      if (windowId !== undefined && tabIndex !== undefined) {
        const probeDeadline = Date.now() + 18_000; // 18s budget
        let responsive = false;
        // First probe after a short settle so the initial parse completes.
        await sleep(WAIT_NAVIGATE_MS);
        while (Date.now() < probeDeadline) {
          const probe = await this.engine.executeJsInTabByPosition(windowId, tabIndex, 'return 1+1;', 3000);
          if (probe.ok && typeof probe.value === 'string' && probe.value.includes('2')) {
            responsive = true;
            break;
          }
          // Wedged (timeout / CSP / empty) — give the ad-load a moment, retry.
          await sleep(1500);
        }
        void responsive; // best-effort; we return regardless once budget elapses
      } else {
        await sleep(WAIT_NAVIGATE_MS);
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ tabUrl, windowId, tabIndex }) }],
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

  /**
   * Execute JavaScript in a tab identified by position (window id + tab index).
   * Used after history.back()/forward() where the URL has changed and can't be matched.
   */
  private async executeJsInTabByPosition(
    windowId: number,
    tabIndex: number,
    jsCode: string,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.engine.executeJsInTabByPosition(windowId, tabIndex, jsCode);
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
