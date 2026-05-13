import type { ToolResponse, ToolRequirements } from '../types.js';
import type { IEngine } from '../engines/engine.js';
import { escapeForJsSingleQuote } from '../escape.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class StructuredExtractionTools {
  constructor(private readonly engine: IEngine) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_smart_scrape',
        description:
          'Scrape the page into a JSON object matching a provided schema. Use when extracting heterogeneous structured data — far higher signal than a snapshot when the schema is known; schema follows JSON Schema.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            schema: {
              type: 'object',
              description:
                'JSON Schema describing the desired output shape. Each property name is matched ' +
                'heuristically against DOM labels, headings, and table headers.',
            },
            scope: {
              type: 'string',
              description: 'CSS selector to limit extraction scope (default: full page body)',
            },
          },
          required: ['tabUrl', 'schema'],
        },
        // v0.1.34 T15a: __SP_SMART_SCRAPE__ sentinel for CSP-immunity on
        // Trusted-Types-strict pages. requiresCspBypass pins to Extension engine.
        requirements: { idempotent: true, requiresCspBypass: true },
      },
      {
        name: 'safari_extract_tables',
        description:
          'Extract all <table> elements as structured JSON {headers, rows}. Use when the answer is in a table — far cheaper than parsing HTML manually; auto-detects header rows.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: {
              type: 'string',
              description: 'CSS selector to target a specific table (default: all tables on the page)',
            },
          },
          required: ['tabUrl'],
        },
        // v0.1.34 T15b: __SP_EXTRACT_TABLES__ sentinel for CSP-immunity.
        requirements: { idempotent: true, requiresCspBypass: true },
      },
      {
        name: 'safari_extract_links',
        description:
          'Extract every link on the page as {text, href, attrs}. Use when scoping link discovery — e.g., finding all pagination links or downloading a list of URLs.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            filter: {
              type: 'string',
              enum: ['all', 'internal', 'external'],
              description: 'Filter links by origin relative to current page (default: all)',
              default: 'all',
            },
          },
          required: ['tabUrl'],
        },
        // v0.1.34 T15c: __SP_EXTRACT_LINKS__ sentinel for CSP-immunity.
        requirements: { idempotent: true, requiresCspBypass: true },
      },
      {
        name: 'safari_extract_images',
        description:
          'Extract every <img> as {src, alt, width, height}. Use when collecting image catalogs or auditing alt text; resolves srcset to canonical src.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            minWidth: {
              type: 'number',
              description: 'Minimum rendered width in pixels to include (default: 0)',
              default: 0,
            },
            minHeight: {
              type: 'number',
              description: 'Minimum rendered height in pixels to include (default: 0)',
              default: 0,
            },
          },
          required: ['tabUrl'],
        },
        // v0.1.34 T15d: __SP_EXTRACT_IMAGES__ sentinel for CSP-immunity.
        requirements: { idempotent: true, requiresCspBypass: true },
      },
      {
        name: 'safari_extract_metadata',
        description:
          'Extract document <meta>, OpenGraph, Twitter, JSON-LD, and canonical link metadata. Use when capturing page identity for citation, social sharing detection, or schema.org parsing.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true },
      },
    ];
  }

  getHandler(name: string): Handler {
    switch (name) {
      case 'safari_smart_scrape':
        return (p) => this.handleSmartScrape(p);
      case 'safari_extract_tables':
        return (p) => this.handleExtractTables(p);
      case 'safari_extract_links':
        return (p) => this.handleExtractLinks(p);
      case 'safari_extract_images':
        return (p) => this.handleExtractImages(p);
      case 'safari_extract_metadata':
        return (p) => this.handleExtractMetadata(p);
      default:
        throw new Error(`StructuredExtractionTools: unknown tool "${name}"`);
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleSmartScrape(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const schema = params['schema'] as Record<string, unknown>;
    const scope = params['scope'] as string | undefined;

    // v0.1.34 T15a: __SP_SMART_SCRAPE__ sentinel for CSP-immunity on
    // Trusted-Types-strict pages. Extension engine intercepts in MAIN world
    // (no `new Function()` compile), delegates to __SP_LOCATOR__.smartScrape
    // (ported verbatim from the previous JS-string body). Result-envelope
    // shape preserved verbatim: { data: { [field]: value | null }, fieldsExtracted: number }
    const sentinel = '__SP_SMART_SCRAPE__:' + JSON.stringify({
      schema,
      scope: scope ?? null,
    });

    const result = await this.engine.executeJsInTab(tabUrl, sentinel);
    if (!result.ok) throw new Error(result.error?.message ?? 'Smart scrape failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleExtractTables(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string | undefined;

    // v0.1.34 T15b: __SP_EXTRACT_TABLES__ sentinel for CSP-immunity on
    // Trusted-Types-strict pages. Extension engine intercepts in MAIN world
    // (no `new Function()` compile). Result-envelope shape preserved verbatim:
    //   { tables: [{headers: string[], rows: string[][]}], count: number }
    const sentinel = '__SP_EXTRACT_TABLES__:' + JSON.stringify({
      selector: selector ?? null,
    });

    const result = await this.engine.executeJsInTab(tabUrl, sentinel);
    if (!result.ok) throw new Error(result.error?.message ?? 'Extract tables failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { tables: [], count: 0 }, Date.now() - start);
  }

  private async handleExtractLinks(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const filter = (params['filter'] as string | undefined) ?? 'all';

    // v0.1.34 T15c: __SP_EXTRACT_LINKS__ sentinel for CSP-immunity on
    // Trusted-Types-strict pages. Result-envelope shape preserved verbatim:
    //   { links: [{href, text, context, internal}], count: number }
    const sentinel = '__SP_EXTRACT_LINKS__:' + JSON.stringify({ filter });

    const result = await this.engine.executeJsInTab(tabUrl, sentinel);
    if (!result.ok) throw new Error(result.error?.message ?? 'Extract links failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { links: [], count: 0 }, Date.now() - start);
  }

  private async handleExtractImages(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const minWidth = typeof params['minWidth'] === 'number' ? params['minWidth'] : 0;
    const minHeight = typeof params['minHeight'] === 'number' ? params['minHeight'] : 0;

    // v0.1.34 T15d: __SP_EXTRACT_IMAGES__ sentinel for CSP-immunity on
    // Trusted-Types-strict pages. Result-envelope shape preserved verbatim:
    //   { images: [{src, alt, width, height, naturalWidth, naturalHeight}], count }
    const sentinel = '__SP_EXTRACT_IMAGES__:' + JSON.stringify({ minWidth, minHeight });

    const result = await this.engine.executeJsInTab(tabUrl, sentinel);
    if (!result.ok) throw new Error(result.error?.message ?? 'Extract images failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { images: [], count: 0 }, Date.now() - start);
  }

  private async handleExtractMetadata(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    const js = `
      function getMeta(name) {
        var el = document.querySelector('meta[name="' + name + '"]') ||
                 document.querySelector('meta[property="' + name + '"]');
        return el ? el.getAttribute('content') : null;
      }

      // Standard meta
      var meta = {
        title: document.title || null,
        description: getMeta('description'),
        keywords: getMeta('keywords'),
        author: getMeta('author'),
        robots: getMeta('robots'),
        viewport: getMeta('viewport'),
      };

      // Canonical URL
      var canonicalEl = document.querySelector('link[rel="canonical"]');
      var canonical = canonicalEl ? canonicalEl.getAttribute('href') : null;

      // Open Graph
      var og = {};
      var ogMetas = document.querySelectorAll('meta[property^="og:"]');
      for (var i = 0; i < ogMetas.length; i++) {
        var prop = ogMetas[i].getAttribute('property').replace('og:', '');
        og[prop] = ogMetas[i].getAttribute('content');
      }

      // Twitter Cards
      var twitter = {};
      var twMetas = document.querySelectorAll('meta[name^="twitter:"]');
      for (var j = 0; j < twMetas.length; j++) {
        var name = twMetas[j].getAttribute('name').replace('twitter:', '');
        twitter[name] = twMetas[j].getAttribute('content');
      }

      // JSON-LD
      var jsonLd = [];
      var ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (var k = 0; k < ldScripts.length; k++) {
        try {
          jsonLd.push(JSON.parse(ldScripts[k].textContent));
        } catch (e) {
          // skip malformed
        }
      }

      return {
        meta: meta,
        canonical: canonical,
        openGraph: og,
        twitter: twitter,
        jsonLd: jsonLd,
        url: location.href,
      };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Extract metadata failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private makeResponse(data: unknown, latencyMs: number = 0): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs },
    };
  }
}
