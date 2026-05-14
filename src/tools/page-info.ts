/**
 * v0.1.34 Tasks 4-6: ISOLATED-world page-info capability tools.
 *
 * These three tools replace the most-common `safari_evaluate` call sites
 * identified by the T1 audit — trivial page-metadata reads (title, meta,
 * body snippet, near-element text). They route via three new ISOLATED-world
 * sentinel handlers in `extension/content-isolated.js`:
 *
 *   safari_get_page_info     → __SP_GET_PAGE_INFO__:<json>
 *   safari_get_meta_tags     → __SP_GET_META_TAGS__:<json>
 *   safari_extract_text_window → __SP_EXTRACT_TEXT_WINDOW__:<json>
 *
 * Why ISOLATED world? CSP `require-trusted-types-for 'script'` blocks MAIN
 * world's `new Function(...)` regardless of policy registration. ISOLATED
 * world is CSP-exempt by W3C-spec construction (extension content scripts
 * run under the extension's CSP, not the page's). The DOM is shared between
 * MAIN and ISOLATED, so `document.title`, `document.querySelector`, etc.
 * are still reachable. These three tools only need DOM access → ISOLATED
 * is the right home.
 *
 * Requirements: `requiresCspBypass: true` forces routing to the extension
 * engine via `requiresExtension()` in engine-selector.ts. `idempotent: true`
 * because all three are pure reads.
 */
import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

export class PageInfoTools {
  constructor(private readonly engine: IEngine) {}

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_get_page_info',
        description:
          'Returns structured page info (title, url, body snippet, meta description, og:image, lang).',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab to read from' },
            bodyMaxChars: { type: 'number', description: 'Maximum length of body_snippet (default 2000).' },
            frameId: { type: 'number', description: 'Frame ID (default top frame 0).' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true, requiresCspBypass: true },
      },
      {
        name: 'safari_get_meta_tags',
        description:
          'Returns an array of meta tags from the page (<meta name=...> / <meta property=...> / <meta http-equiv=...>).',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab to read from' },
            names: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional whitelist of meta names/properties to return. Without it, all meta tags are returned.',
            },
            frameId: { type: 'number', description: 'Frame ID (default top frame 0).' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true, requiresCspBypass: true },
      },
      {
        name: 'safari_extract_text_window',
        description:
          'Returns textContent of the subtree(s) matching `selector`, capped at `max_chars` (default 5000). ' +
          'Use when reading text near a specific element.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab to read from' },
            selector: { type: 'string', description: 'CSS selector identifying the subtree(s)' },
            max_chars: { type: 'number', description: 'Max chars to return (default 5000).' },
            frameId: { type: 'number', description: 'Frame ID (default top frame 0).' },
          },
          required: ['tabUrl', 'selector'],
        },
        requirements: { idempotent: true, requiresCspBypass: true },
      },
    ];
  }

  getHandler(name: string): ((params: Record<string, unknown>) => Promise<ToolResponse>) | undefined {
    if (name === 'safari_get_page_info') {
      return async (params) => {
        const start = Date.now();
        const tabUrl = params['tabUrl'] as string;
        const bodyMaxChars = (params['bodyMaxChars'] as number | undefined) ?? 2000;
        const frameId = (params['frameId'] as number | undefined) ?? 0;
        const sentinel = '__SP_GET_PAGE_INFO__:' + JSON.stringify({ bodyMaxChars, frameId });
        const result = await this.engine.executeJsInTab(tabUrl, sentinel, 10_000);
        if (!result.ok) {
          const err = new Error(result.error?.message ?? 'safari_get_page_info failed');
          if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
          throw err;
        }
        const parsed = result.value ? JSON.parse(result.value) : {};
        return {
          content: [{ type: 'text', text: JSON.stringify(parsed) }],
          metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
        };
      };
    }
    if (name === 'safari_get_meta_tags') {
      return async (params) => {
        const start = Date.now();
        const tabUrl = params['tabUrl'] as string;
        const names = params['names'] as string[] | undefined;
        const frameId = (params['frameId'] as number | undefined) ?? 0;
        const sentinel = '__SP_GET_META_TAGS__:' + JSON.stringify({ names, frameId });
        const result = await this.engine.executeJsInTab(tabUrl, sentinel, 10_000);
        if (!result.ok) {
          const err = new Error(result.error?.message ?? 'safari_get_meta_tags failed');
          if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
          throw err;
        }
        const parsed = result.value ? JSON.parse(result.value) : {};
        return {
          content: [{ type: 'text', text: JSON.stringify(parsed) }],
          metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
        };
      };
    }
    if (name === 'safari_extract_text_window') {
      return async (params) => {
        const start = Date.now();
        const tabUrl = params['tabUrl'] as string;
        const selector = params['selector'] as string;
        const maxChars = (params['max_chars'] as number | undefined) ?? 5000;
        const frameId = (params['frameId'] as number | undefined) ?? 0;
        const sentinel = '__SP_EXTRACT_TEXT_WINDOW__:' + JSON.stringify({ selector, maxChars, frameId });
        const result = await this.engine.executeJsInTab(tabUrl, sentinel, 10_000);
        if (!result.ok) {
          const err = new Error(result.error?.message ?? 'safari_extract_text_window failed');
          if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
          throw err;
        }
        const parsed = result.value ? JSON.parse(result.value) : {};
        return {
          content: [{ type: 'text', text: JSON.stringify(parsed) }],
          metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
        };
      };
    }
    return undefined;
  }
}
