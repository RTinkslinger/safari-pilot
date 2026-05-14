// src/tools/overlays.ts — server-side handler for safari_dismiss_overlays
// (v0.1.31 Task 11). Pairs with the __SP_DISMISS_OVERLAYS__:<json> sentinel
// intercept in extension/content-main.js. The handler:
//   1. Assembles a sentinel string with the in-memory pattern registry +
//      kill-switch / paywall-opt-in flags.
//   2. Dispatches it via engine.executeJsInTab → daemon → extension MAIN-world
//      runtime, which executes the dismiss loop with locator.js helpers.
//   3. Sanitizes the dismissed[] entries (drops aria-label / free-text fields)
//      and returns a JSON-stringified summary in content[0].text so
//      IdpiAnnotator can scan for indirect prompt injection.
//
// Architectural note: error.code propagates from extension throw → daemon →
// engine.executeJsInTab → result.error.code → handler-thrown Error.code (same
// pattern as InteractionTools.handleScrollToElement, src/tools/interaction.ts).

import type { Engine, ToolResponse, ToolRequirements } from '../types.js';
import type { IEngine } from '../engines/engine.js';
import type { PatternRegistryEntry } from '../overlays/types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

export interface OverlayToolsConfig {
  engine: IEngine;
  patterns: PatternRegistryEntry[];
  disableOverlayDismiss: boolean;
  enablePaywallDismiss: boolean;
}

interface DismissedEntry {
  category: string;
  id: string;
  selector: string;
  action: string;
  site: string;
  verified: boolean;
}

interface SkippedEntry {
  reason: string;
  candidate?: { selector?: string; category?: string; hint?: string };
}

interface DismissResult {
  dismissed: DismissedEntry[];
  skipped: SkippedEntry[];
  overlaysAtStart: number;
  overlaysAtEnd: number;
}

export class OverlayTools {
  constructor(private config: OverlayToolsConfig) {}

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_dismiss_overlays',
        description:
          'Detect and dismiss known overlay patterns (cookie consent banners, '
          + 'registration walls, app-install prompts, certain paywalls) using a '
          + 'curated allowlist of DOM signatures with a two-signal rule. Returns '
          + 'a manifest of {dismissed[], skipped[]}. NEVER dismisses arbitrary '
          + 'modals — only allowlisted patterns. Paywall patterns are OPT-IN '
          + '(SAFARI_PILOT_ENABLE_PAYWALL_DISMISS=true). Kill switch via '
          + 'SAFARI_PILOT_DISABLE_OVERLAY_DISMISS=true.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', format: 'uri' },
            categories: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['cookie-consent', 'registration-wall', 'app-install', 'paywall'],
              },
            },
          },
          required: ['tabUrl'],
          additionalProperties: false,
        },
        requirements: { requiresAsyncJs: true, requiresShadowDom: true, idempotent: true },
      },
    ];
  }

  getHandler(name: string): ((params: Record<string, unknown>) => Promise<ToolResponse>) | undefined {
    if (name === 'safari_dismiss_overlays') return this.handleDismissOverlays.bind(this);
    return undefined;
  }

  private async handleDismissOverlays(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string | undefined;
    if (!tabUrl) {
      const err = new Error('tabUrl is required');
      (err as Error & { code?: string }).code = 'INVALID_PARAMS';
      throw err;
    }
    const categories = params['categories'] as string[] | undefined;

    const sentinel = '__SP_DISMISS_OVERLAYS__:' + JSON.stringify({
      categories,
      patterns: this.config.patterns,
      killSwitchEngaged: this.config.disableOverlayDismiss,
      paywallEnabled: this.config.enablePaywallDismiss,
    });

    // Retry on transient TAB_NOT_FOUND — Safari's MV3 lifecycle can leave
    // browser.tabs.query() returning empty for ~ms after a freshly opened tab.
    let result = await this.config.engine.executeJsInTab(tabUrl, sentinel, 30_000);
    for (let attempt = 1; attempt < 3 && !result.ok && result.error?.code === 'TAB_NOT_FOUND'; attempt++) {
      await new Promise((r) => setTimeout(r, 300));
      result = await this.config.engine.executeJsInTab(tabUrl, sentinel, 30_000);
    }
    if (!result.ok) {
      const err = new Error(result.error?.message ?? 'safari_dismiss_overlays failed');
      if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
      throw err;
    }

    const raw = (result.value ? JSON.parse(result.value) : {}) as Partial<DismissResult>;

    // Sanitize dismissed[] — id-only, no aria-label / no free-text
    const sanitizedDismissed: DismissedEntry[] = (raw.dismissed || []).map((d) => ({
      category: d.category,
      id: d.id,
      selector: d.selector,
      action: d.action,
      site: d.site,
      verified: d.verified,
    }));

    const summary: DismissResult = {
      dismissed: sanitizedDismissed,
      skipped: raw.skipped || [],
      overlaysAtStart: raw.overlaysAtStart || 0,
      overlaysAtEnd: raw.overlaysAtEnd || 0,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(summary) }],
      metadata: {
        engine: 'extension' as Engine,
        degraded: false,
        latencyMs: Date.now() - start,
        ...summary,
      },
    };
  }
}
