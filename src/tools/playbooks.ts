/**
 * v0.1.35 Task 9 — light cross-cutting playbook tools.
 *
 * Three general interaction patterns that are NOT site-specific recipes:
 *   - safari_normalize_date              (pure JS date parsing)
 *   - safari_dismiss_cookie_consent      (specialization of safari_dismiss_overlays
 *                                         restricted to the 'cookie-consent' family)
 *   - safari_wait_for_rate_limit_clear   (polls page text for HTTP-429 / rate-limit
 *                                         indicators via __SP_WAIT_RATE_LIMIT_CLEAR__
 *                                         sentinel until cleared OR max_wait_ms)
 *
 * Routing notes:
 *   - safari_normalize_date is engine-free (pure JS in TS).
 *   - safari_dismiss_cookie_consent delegates to OverlayTools.handleDismissOverlays
 *     with categories=['cookie-consent']. Same routing as safari_dismiss_overlays
 *     (extension required for shadow-DOM signal evaluation).
 *   - safari_wait_for_rate_limit_clear uses requiresCspBypass: 'preferred' and
 *     dispatches the __SP_WAIT_RATE_LIMIT_CLEAR__ sentinel through the engine
 *     proxy, mirroring src/tools/final-proof.ts.
 */
import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';
import type { OverlayTools } from './overlays.js';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

export interface PlaybooksToolsConfig {
  engine: IEngine;
  overlayTools: OverlayTools;
}

export class PlaybooksTools {
  constructor(private readonly config: PlaybooksToolsConfig) {}

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_normalize_date',
        description:
          'Parse a date string into ISO format (YYYY-MM-DD) plus numeric '
          + '{year, month, day} components. Pure function — no DOM access. '
          + 'Useful as a pre-step before filling date inputs.',
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'A date string (e.g. "January 10, 2027").' },
          },
          required: ['input'],
          additionalProperties: false,
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_dismiss_cookie_consent',
        description:
          'Dismiss a cookie-consent banner on the current page. Specialization of '
          + 'safari_dismiss_overlays restricted to the cookie-consent overlay family.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', format: 'uri' },
          },
          required: ['tabUrl'],
          additionalProperties: false,
        },
        requirements: { idempotent: true, requiresAsyncJs: true, requiresShadowDom: true },
      },
      {
        name: 'safari_wait_for_rate_limit_clear',
        description:
          'Poll the current page for HTTP-429 / rate-limit indicators in the body text. '
          + 'Returns when the indicators are absent OR when max_wait_ms elapses.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', format: 'uri' },
            max_wait_ms: { type: 'number', default: 30000 },
          },
          required: ['tabUrl'],
          additionalProperties: false,
        },
        requirements: { idempotent: true, requiresCspBypass: 'preferred' },
      },
    ];
  }

  getHandler(name: string): ((params: Record<string, unknown>) => Promise<ToolResponse>) | undefined {
    if (name === 'safari_normalize_date') return this.handleNormalizeDate.bind(this);
    if (name === 'safari_dismiss_cookie_consent') return this.handleDismissCookieConsent.bind(this);
    if (name === 'safari_wait_for_rate_limit_clear') return this.handleWaitRateLimit.bind(this);
    return undefined;
  }

  private async handleNormalizeDate(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const input = params['input'] as string | undefined;
    if (typeof input !== 'string') {
      const err = new Error('input is required and must be a string');
      (err as Error & { code?: string }).code = 'INVALID_PARAMS';
      throw err;
    }
    const date = new Date(input);
    if (Number.isNaN(date.getTime())) {
      const payload = { isError: true, message: `Could not parse date: ${input}` };
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: true,
        metadata: {
          engine: 'applescript' as Engine,
          degraded: false,
          latencyMs: Date.now() - start,
        },
      };
    }
    // Use local civil-date components (not UTC) so a user typing
    // "January 10, 2027" gets back 2027-01-10 regardless of the host's
    // timezone. Otherwise IST/AEST etc. silently shift the day backward
    // when toISOString() crosses midnight UTC.
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const components = { year, month, day };
    const payload = { iso, components, isError: false };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      metadata: {
        engine: 'applescript' as Engine,
        degraded: false,
        latencyMs: Date.now() - start,
      },
    };
  }

  private async handleDismissCookieConsent(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string | undefined;
    if (!tabUrl) {
      const err = new Error('tabUrl is required');
      (err as Error & { code?: string }).code = 'INVALID_PARAMS';
      throw err;
    }

    const overlaysHandler = this.config.overlayTools.getHandler('safari_dismiss_overlays');
    if (!overlaysHandler) {
      throw new Error('safari_dismiss_overlays handler is unavailable');
    }
    const result = await overlaysHandler({ tabUrl, categories: ['cookie-consent'] });

    // Inspect the embedded summary to compute a boolean dismissed flag.
    let dismissedCount = 0;
    try {
      const text = result.content?.[0]?.text;
      if (typeof text === 'string') {
        const summary = JSON.parse(text) as { dismissed?: unknown[] };
        if (Array.isArray(summary.dismissed)) dismissedCount = summary.dismissed.length;
      }
    } catch {
      // best-effort parse — leave dismissedCount at 0.
    }

    const dismissed = dismissedCount > 0;
    const payload = { dismissed, banner_type: 'cookie-consent', isError: false };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      metadata: {
        engine: result.metadata?.engine ?? ('extension' as Engine),
        degraded: result.metadata?.degraded ?? false,
        latencyMs: Date.now() - start,
      },
    };
  }

  private async handleWaitRateLimit(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string | undefined;
    if (!tabUrl) {
      const err = new Error('tabUrl is required');
      (err as Error & { code?: string }).code = 'INVALID_PARAMS';
      throw err;
    }
    const max = typeof params['max_wait_ms'] === 'number' ? (params['max_wait_ms'] as number) : 30_000;

    const sentinel = '__SP_WAIT_RATE_LIMIT_CLEAR__:{}';
    let lastEngineErrorMessage: string | undefined;

    while (Date.now() - start < max) {
      const evalResult = await this.config.engine.executeJsInTab(tabUrl, sentinel, 5_000);
      if (evalResult.ok) {
        const parsed = evalResult.value
          ? (JSON.parse(evalResult.value) as { rate_limited?: boolean })
          : {};
        if (parsed.rate_limited === false) {
          const payload = { ready: true, waited_ms: Date.now() - start, isError: false };
          return {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            metadata: {
              engine: 'extension' as Engine,
              degraded: false,
              latencyMs: Date.now() - start,
            },
          };
        }
      } else {
        lastEngineErrorMessage = evalResult.error?.message;
      }
      const remaining = max - (Date.now() - start);
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, remaining)));
    }

    const payload = {
      ready: false,
      waited_ms: Date.now() - start,
      isError: false,
      ...(lastEngineErrorMessage ? { last_engine_error: lastEngineErrorMessage } : {}),
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      metadata: {
        engine: 'extension' as Engine,
        degraded: false,
        latencyMs: Date.now() - start,
      },
    };
  }
}
