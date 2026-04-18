import type { ToolResponse, ToolRequirements } from '../types.js';
import type { IEngine } from '../engines/engine.js';

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
          'Schema-based structured extraction. Walks the DOM heuristically to match fields described ' +
          'in a JSON schema — label→input pairs, heading→content pairs, table headers→rows — and returns ' +
          'a structured JSON object matching the schema shape. Ideal for extracting form data, article ' +
          'content, product details, or any repeating page structure.',
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
        requirements: { idempotent: true },
      },
      {
        name: 'safari_extract_tables',
        description:
          'Extract all HTML tables on the page as structured JSON. Each table is returned with its ' +
          'headers (from <th> elements) and rows (from <td> elements). Specify a CSS selector to ' +
          'target a particular table.',
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
        requirements: { idempotent: true },
      },
      {
        name: 'safari_extract_links',
        description:
          'Extract all hyperlinks from the page with their href, link text, and surrounding context ' +
          '(parent heading or paragraph). Optionally filter to internal-only, external-only, or all links.',
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
        requirements: { idempotent: true },
      },
      {
        name: 'safari_extract_images',
        description:
          'Extract all images on the page with their src, alt text, and rendered/natural dimensions. ' +
          'Optionally filter by minimum rendered width or height to skip decorative or tiny images.',
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
        requirements: { idempotent: true },
      },
      {
        name: 'safari_extract_metadata',
        description:
          'Extract page metadata: <title>, <meta> tags (description, keywords, author), ' +
          'Open Graph (og:*), Twitter Cards (twitter:*), JSON-LD structured data, and canonical URL.',
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

    const schemaJson = JSON.stringify(schema);
    const escapedScope = scope ? scope.replace(/'/g, "\\'") : '';

    const js = `
      var schema = ${schemaJson};
      var scopeSel = '${escapedScope}';
      var root = scopeSel ? document.querySelector(scopeSel) : document.body;
      if (!root) throw Object.assign(new Error('Scope element not found'), { name: 'ELEMENT_NOT_FOUND' });

      function normalise(str) {
        return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      }

      function findValueForField(fieldName) {
        var key = normalise(fieldName);

        // 1. label→input pairs
        var labels = root.querySelectorAll('label');
        for (var i = 0; i < labels.length; i++) {
          var lbl = labels[i];
          if (normalise(lbl.textContent) === key || normalise(lbl.textContent).indexOf(key) !== -1) {
            var forId = lbl.getAttribute('for');
            if (forId) {
              var inp = document.getElementById(forId);
              if (inp) return inp.value || inp.textContent || inp.getAttribute('placeholder') || null;
            }
            var nested = lbl.querySelector('input, select, textarea');
            if (nested) return nested.value || null;
          }
        }

        // 2. heading→sibling content pairs
        var headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6');
        for (var h = 0; h < headings.length; h++) {
          var hEl = headings[h];
          if (normalise(hEl.textContent).indexOf(key) !== -1) {
            var next = hEl.nextElementSibling;
            if (next) return (next.innerText || next.textContent || '').trim().slice(0, 500);
          }
        }

        // 3. definition lists (dt→dd)
        var dts = root.querySelectorAll('dt');
        for (var d = 0; d < dts.length; d++) {
          var dt = dts[d];
          if (normalise(dt.textContent).indexOf(key) !== -1) {
            var dd = dt.nextElementSibling;
            if (dd && dd.tagName === 'DD') return (dd.innerText || dd.textContent || '').trim();
          }
        }

        // 4. table headers (th cell) → adjacent td in same row
        var rows = root.querySelectorAll('tr');
        for (var r = 0; r < rows.length; r++) {
          var row = rows[r];
          var cells = row.querySelectorAll('th, td');
          for (var c = 0; c < cells.length; c++) {
            if (cells[c].tagName === 'TH' && normalise(cells[c].textContent).indexOf(key) !== -1) {
              var td = cells[c + 1];
              if (td) return (td.innerText || td.textContent || '').trim();
            }
          }
        }

        // 5. meta tags / data attributes
        var metaEl = document.querySelector('meta[name="' + fieldName.toLowerCase() + '"]');
        if (metaEl) return metaEl.getAttribute('content');

        return null;
      }

      var result = {};
      var props = schema.properties || schema;
      Object.keys(props).forEach(function(field) {
        result[field] = findValueForField(field);
      });

      return { data: result, fieldsExtracted: Object.keys(result).length };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Smart scrape failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleExtractTables(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string | undefined;

    const escapedSelector = selector ? selector.replace(/'/g, "\\'") : '';

    const js = `
      var tables = ${selector ? `document.querySelectorAll('${escapedSelector}')` : 'document.querySelectorAll("table")'};
      var result = [];

      for (var t = 0; t < tables.length; t++) {
        var table = tables[t];
        var headers = [];
        var rows = [];

        // Read headers from thead > tr > th, or first row of th elements
        var thEls = table.querySelectorAll('thead th');
        if (thEls.length === 0) thEls = table.querySelectorAll('tr:first-child th');
        for (var h = 0; h < thEls.length; h++) {
          headers.push((thEls[h].innerText || thEls[h].textContent || '').trim());
        }

        // Read data rows — skip header row if headers came from th in first row
        var trEls = table.querySelectorAll(headers.length > 0 ? 'tbody tr' : 'tr');
        if (trEls.length === 0 && headers.length > 0) {
          // No tbody — get all rows after first
          var allRows = table.querySelectorAll('tr');
          for (var ri = 1; ri < allRows.length; ri++) {
            var cells = allRows[ri].querySelectorAll('td');
            if (cells.length > 0) {
              var row = [];
              for (var ci = 0; ci < cells.length; ci++) {
                row.push((cells[ci].innerText || cells[ci].textContent || '').trim());
              }
              rows.push(row);
            }
          }
        } else {
          for (var ri2 = 0; ri2 < trEls.length; ri2++) {
            var cells2 = trEls[ri2].querySelectorAll('td');
            if (cells2.length > 0) {
              var row2 = [];
              for (var ci2 = 0; ci2 < cells2.length; ci2++) {
                row2.push((cells2[ci2].innerText || cells2[ci2].textContent || '').trim());
              }
              rows.push(row2);
            }
          }
        }

        result.push({ headers: headers, rows: rows });
      }

      return { tables: result, count: result.length };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Extract tables failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { tables: [], count: 0 }, Date.now() - start);
  }

  private async handleExtractLinks(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const filter = (params['filter'] as string | undefined) ?? 'all';

    const js = `
      var filterMode = '${filter}';
      var pageOrigin = location.origin;
      var anchors = document.querySelectorAll('a[href]');
      var links = [];

      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var href = a.href || '';
        var text = (a.innerText || a.textContent || '').trim().slice(0, 200);

        // Determine internal vs external
        var isInternal = false;
        try {
          isInternal = new URL(href).origin === pageOrigin;
        } catch (e) {
          // relative or non-standard href
          isInternal = !href.startsWith('http') || href.startsWith(pageOrigin);
        }

        if (filterMode === 'internal' && !isInternal) continue;
        if (filterMode === 'external' && isInternal) continue;

        // Find surrounding context: nearest heading or paragraph ancestor
        var context = '';
        var node = a.parentElement;
        while (node && node !== document.body) {
          var tag = node.tagName ? node.tagName.toUpperCase() : '';
          if (/^H[1-6]$/.test(tag) || tag === 'P' || tag === 'LI') {
            context = (node.innerText || node.textContent || '').trim().slice(0, 200);
            break;
          }
          node = node.parentElement;
        }

        links.push({
          href: href,
          text: text,
          context: context,
          internal: isInternal,
        });
      }

      return { links: links, count: links.length };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Extract links failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { links: [], count: 0 }, Date.now() - start);
  }

  private async handleExtractImages(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const minWidth = typeof params['minWidth'] === 'number' ? params['minWidth'] : 0;
    const minHeight = typeof params['minHeight'] === 'number' ? params['minHeight'] : 0;

    const js = `
      var minW = ${minWidth};
      var minH = ${minHeight};
      var imgs = document.querySelectorAll('img');
      var images = [];

      for (var i = 0; i < imgs.length; i++) {
        var img = imgs[i];
        var w = img.width || img.offsetWidth || 0;
        var h = img.height || img.offsetHeight || 0;
        if (w < minW || h < minH) continue;

        images.push({
          src: img.src || img.getAttribute('src') || '',
          alt: img.alt || '',
          width: w,
          height: h,
          naturalWidth: img.naturalWidth || 0,
          naturalHeight: img.naturalHeight || 0,
        });
      }

      return { images: images, count: images.length };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
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
