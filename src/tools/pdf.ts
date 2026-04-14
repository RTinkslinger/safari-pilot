// ── PDF tool module ─────────────────────────────────────────────────────────
// Utility functions (cssToPoints, paper sizes, page ranges, HTML injection)
// + PdfTools class for safari_export_pdf tool definition and handler.

import { stat } from 'node:fs/promises';
import type { ToolResponse, ToolRequirements, Engine } from '../types.js';
import type { SafariPilotServer } from '../server.js';

// ── CSS unit conversion ──────────────────────────────────────────────────────

/**
 * Convert a CSS length value to PDF points (72pt = 1in).
 *
 * Supported units: px (96px = 1in), in, cm, mm.
 * Bare numbers are treated as pixels. Empty or invalid input returns 0.
 */
export function cssToPoints(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 0;

  // Match: optional digits/decimal, then optional unit letters
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(px|in|cm|mm)?$/i);
  if (!match) return 0;

  const num = parseFloat(match[1]);
  if (isNaN(num)) return 0;

  const unit = (match[2] || 'px').toLowerCase();

  switch (unit) {
    case 'px': return num / 96 * 72;
    case 'in': return num * 72;
    case 'cm': return num / 2.54 * 72;
    case 'mm': return num / 25.4 * 72;
    default:   return 0;
  }
}

// ── Paper sizes ──────────────────────────────────────────────────────────────

export interface PaperSize {
  width: number;   // points
  height: number;  // points
}

/** Standard paper sizes in points (72pt = 1in). All portrait orientation. */
export const PAPER_SIZES: Record<string, PaperSize> = {
  Letter:  { width: 612,    height: 792 },
  Legal:   { width: 612,    height: 1008 },
  A4:      { width: 595.28, height: 841.89 },
  A3:      { width: 841.89, height: 1190.55 },
  Tabloid: { width: 792,    height: 1224 },
};

// ── Page range parsing ───────────────────────────────────────────────────────

/**
 * Parse a page range string into first/last page numbers.
 *
 * - "1-5" -> {first: 1, last: 5}
 * - "3"   -> {first: 3, last: 3}
 * - "" or undefined -> null
 * - invalid or first > last -> null
 */
export function parsePageRanges(ranges: string | undefined): { first: number; last: number } | null {
  if (ranges === undefined || ranges === null) return null;

  const trimmed = ranges.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('-');

  // Only allow "N" or "N-M" forms
  if (parts.length === 1) {
    const page = Number(parts[0]);
    if (!Number.isInteger(page) || page < 1) return null;
    return { first: page, last: page };
  }

  if (parts.length === 2) {
    const first = Number(parts[0]);
    const last = Number(parts[1]);
    if (!Number.isInteger(first) || !Number.isInteger(last)) return null;
    if (first < 1 || last < 1) return null;
    if (first > last) return null;
    return { first, last };
  }

  // More than one dash: invalid
  return null;
}

// ── HTML injection helpers ───────────────────────────────────────────────────

/**
 * Inject CSS that forces print background colors/images to render.
 * Inserts a <style> tag before </head>, or prepends if no </head>.
 */
export function injectPrintBackground(html: string): string {
  const css = '<style>* { -webkit-print-color-adjust: exact !important; color-adjust: exact !important; }</style>';

  // Case-insensitive search for </head>
  const headCloseIdx = html.search(/<\/head>/i);
  if (headCloseIdx !== -1) {
    return html.slice(0, headCloseIdx) + css + html.slice(headCloseIdx);
  }

  // No </head> — prepend
  return css + html;
}

// ── Header/footer injection ──────────────────────────────────────────────────

/** Escape HTML special characters to prevent XSS in injected tokens. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Replace magic class tokens in a header/footer template with their values.
 *
 * Playwright convention: elements with class="pageNumber", class="totalPages",
 * class="date", class="title", class="url" get replaced with actual values.
 *
 * For pageNumber/totalPages, we use CSS counters (works in WebKit print).
 * For date/title/url, we inject the literal string as text content.
 */
function replaceTokens(
  template: string,
  tokens: { title: string; url: string; date: string },
): string {
  let result = template;

  // pageNumber → CSS counter via a styled span
  result = result.replace(
    /<span\s+class="pageNumber"\s*>[\s\S]*?<\/span>/gi,
    '<span style="content: counter(page);"><style>.sp-pn::after { content: counter(page); }</style><span class="sp-pn"></span></span>',
  );

  // totalPages → CSS counter via a styled span
  result = result.replace(
    /<span\s+class="totalPages"\s*>[\s\S]*?<\/span>/gi,
    '<span style="content: counter(pages);"><style>.sp-tp::after { content: counter(pages); }</style><span class="sp-tp"></span></span>',
  );

  // date → literal text
  result = result.replace(
    /<span\s+class="date"\s*>[\s\S]*?<\/span>/gi,
    `<span>${escapeHtml(tokens.date)}</span>`,
  );

  // title → literal text
  result = result.replace(
    /<span\s+class="title"\s*>[\s\S]*?<\/span>/gi,
    `<span>${escapeHtml(tokens.title)}</span>`,
  );

  // url → literal text
  result = result.replace(
    /<span\s+class="url"\s*>[\s\S]*?<\/span>/gi,
    `<span>${escapeHtml(tokens.url)}</span>`,
  );

  return result;
}

/**
 * Inject header/footer HTML and CSS into a document for PDF rendering.
 *
 * - Injects positioning CSS for .sp-pdf-header / .sp-pdf-footer before </head>
 * - Adds body margin offsets (40px top/bottom) for header/footer space
 * - Replaces magic class tokens (pageNumber, totalPages, date, title, url)
 * - Injects header/footer divs before </body>
 *
 * If both headerTemplate and footerTemplate are undefined, returns html unchanged.
 */
export function injectHeaderFooter(
  html: string,
  headerTemplate: string | undefined,
  footerTemplate: string | undefined,
  tokens: { title: string; url: string; date: string },
): string {
  if (!headerTemplate && !footerTemplate) return html;

  // ── Build CSS ──
  const marginTop = headerTemplate ? '40px' : '0';
  const marginBottom = footerTemplate ? '40px' : '0';

  const css = `<style>
.sp-pdf-header, .sp-pdf-footer {
  position: fixed;
  left: 0;
  right: 0;
  z-index: 999999;
  font-size: 10px;
  color: #666;
  padding: 20px;
}
.sp-pdf-header { top: 0; }
.sp-pdf-footer { bottom: 0; }
body { margin-top: ${marginTop} !important; margin-bottom: ${marginBottom} !important; }
</style>`;

  // ── Build header/footer divs ──
  let divs = '';
  if (headerTemplate) {
    const processed = replaceTokens(headerTemplate, tokens);
    divs += `<div class="sp-pdf-header">${processed}</div>`;
  }
  if (footerTemplate) {
    const processed = replaceTokens(footerTemplate, tokens);
    divs += `<div class="sp-pdf-footer">${processed}</div>`;
  }

  // ── Inject CSS before </head> ──
  let result = html;
  const headCloseIdx = result.search(/<\/head>/i);
  if (headCloseIdx !== -1) {
    result = result.slice(0, headCloseIdx) + css + result.slice(headCloseIdx);
  } else {
    result = css + result;
  }

  // ── Inject divs before </body> ──
  const bodyCloseIdx = result.search(/<\/body>/i);
  if (bodyCloseIdx !== -1) {
    result = result.slice(0, bodyCloseIdx) + divs + result.slice(bodyCloseIdx);
  } else {
    result = result + divs;
  }

  return result;
}

// ── Tool types ──────────────────────────────────────────────────────────────

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

// ── PdfTools ────────────────────────────────────────────────────────────────

export class PdfTools {
  private server: SafariPilotServer;
  private handlers: Map<string, Handler> = new Map();

  constructor(server: SafariPilotServer) {
    this.server = server;
    this.handlers.set('safari_export_pdf', this.handleExportPdf.bind(this));
  }

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_export_pdf',
        description:
          'Export the current Safari tab as a PDF file. Captures the page HTML, applies ' +
          'print-specific settings (paper size, margins, background colors, headers/footers), ' +
          'and renders to PDF via the native daemon. Supports CSS page sizes, custom dimensions, ' +
          'page ranges, and scale. Falls back to URL-based rendering if HTML extraction fails ' +
          'or produces an empty PDF. Returns file path, page count, and file size on success.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Absolute file path where the PDF will be saved (must end in .pdf)',
            },
            tabUrl: {
              type: 'string',
              description: 'URL of the tab to export (optional — defaults to current tab)',
            },
            format: {
              type: 'string',
              enum: ['Letter', 'Legal', 'A4', 'A3', 'Tabloid'],
              description: 'Paper size format (default: Letter). Ignored if width/height are provided.',
            },
            width: {
              type: 'string',
              description: 'Custom page width as CSS value (e.g. "8.5in", "210mm"). Overrides format.',
            },
            height: {
              type: 'string',
              description: 'Custom page height as CSS value (e.g. "11in", "297mm"). Overrides format.',
            },
            landscape: {
              type: 'boolean',
              description: 'If true, swap width and height for landscape orientation (default: false)',
            },
            margin: {
              type: 'object',
              description: 'Page margins as CSS values (default: 1in each)',
              properties: {
                top: { type: 'string', description: 'Top margin (e.g. "1in", "2.54cm")' },
                right: { type: 'string', description: 'Right margin' },
                bottom: { type: 'string', description: 'Bottom margin' },
                left: { type: 'string', description: 'Left margin' },
              },
            },
            scale: {
              type: 'number',
              description: 'Scale factor for rendering (0.1 to 2.0, default: 1.0)',
            },
            printBackground: {
              type: 'boolean',
              description: 'If true, include background colors and images (default: false)',
            },
            pageRanges: {
              type: 'string',
              description: 'Page range to export (e.g. "1-5", "3"). Exports all pages if omitted.',
            },
            displayHeaderFooter: {
              type: 'boolean',
              description: 'If true, inject header/footer templates into the PDF (default: false)',
            },
            headerTemplate: {
              type: 'string',
              description: 'HTML template for page header. Supports class="pageNumber", "totalPages", "date", "title", "url" tokens.',
            },
            footerTemplate: {
              type: 'string',
              description: 'HTML template for page footer. Same token classes as headerTemplate.',
            },
            preferCSSPageSize: {
              type: 'boolean',
              description: 'If true, use the page\'s CSS @page size instead of format/width/height (default: false)',
            },
            timeout: {
              type: 'number',
              description: 'Maximum time in milliseconds for PDF generation (default: 30000)',
            },
          },
          required: ['path'],
        },
        requirements: {} as ToolRequirements,
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  // ── Main handler ──────────────────────────────────────────────────────────

  private async handleExportPdf(
    params: Record<string, unknown>,
  ): Promise<ToolResponse> {
    const start = Date.now();
    const path = params['path'] as string | undefined;

    // 1. Validate output path
    if (!path || typeof path !== 'string' || !path.trim()) {
      return this.makeErrorResponse(
        'INVALID_OUTPUT_PATH',
        'The "path" parameter is required and must be a non-empty string',
        'applescript',
        start,
      );
    }

    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 30_000;
    const tabUrl = params['tabUrl'] as string | undefined;
    const warnings: string[] = [];

    // 2. Resolve paper size
    const { paperWidth, paperHeight } = this.resolvePaperSize(params);

    // 3. Convert margins (default 1in each)
    const marginObj = (params['margin'] ?? {}) as Record<string, string | undefined>;
    const marginTop = cssToPoints(marginObj['top'] ?? '1in');
    const marginRight = cssToPoints(marginObj['right'] ?? '1in');
    const marginBottom = cssToPoints(marginObj['bottom'] ?? '1in');
    const marginLeft = cssToPoints(marginObj['left'] ?? '1in');

    // 4. Clamp scale
    const rawScale = typeof params['scale'] === 'number' ? params['scale'] : 1.0;
    const scale = Math.min(2.0, Math.max(0.1, rawScale));

    // 5. Parse page ranges
    const pageRanges = parsePageRanges(params['pageRanges'] as string | undefined);

    // 6. Extract HTML from Safari tab
    let html: string | null = null;
    let tabUrlResolved: string = '';
    let documentTitle: string = '';
    try {
      tabUrlResolved = await this.getTabUrl(tabUrl);
      html = await this.extractHtml(tabUrl);
      documentTitle = await this.getDocumentTitle(tabUrl);
    } catch (err) {
      warnings.push(`HTML extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 7. Apply HTML injections
    if (html) {
      if (params['printBackground']) {
        html = injectPrintBackground(html);
      }
      if (params['displayHeaderFooter']) {
        html = injectHeaderFooter(
          html,
          params['headerTemplate'] as string | undefined,
          params['footerTemplate'] as string | undefined,
          {
            title: documentTitle,
            url: tabUrlResolved,
            date: new Date().toLocaleDateString(),
          },
        );
      }
    }

    // 8. Build daemon params (all values in points, no CSS units)
    const preferCSSPageSize = params['preferCSSPageSize'] === true;
    const landscape = params['landscape'] === true;
    const printBackground = params['printBackground'] === true;

    const daemonParams: Record<string, unknown> = {
      outputPath: path,
      marginTop,
      marginRight,
      marginBottom,
      marginLeft,
      scale,
      landscape,
      printBackground,
    };

    if (!preferCSSPageSize) {
      daemonParams['paperWidth'] = landscape ? paperHeight : paperWidth;
      daemonParams['paperHeight'] = landscape ? paperWidth : paperHeight;
    }

    if (pageRanges) {
      daemonParams['firstPage'] = pageRanges.first;
      daemonParams['lastPage'] = pageRanges.last;
    }

    // 9. Primary attempt: HTML-based rendering
    if (html) {
      daemonParams['html'] = html;
      // Base URL = origin of the tab URL, so relative assets resolve correctly
      try {
        const urlObj = new URL(tabUrlResolved);
        daemonParams['baseURL'] = urlObj.origin;
      } catch {
        // Non-URL tab (e.g. about:blank) — omit baseURL
      }

      const result = await this.callDaemon(daemonParams, timeout);
      if (result) {
        try {
          const parsed = typeof result.value === 'string'
            ? JSON.parse(result.value)
            : result.value;

          // Check if the result is viable (not empty PDF)
          const pageCount = parsed?.pageCount ?? 0;
          const fileSize = parsed?.fileSize ?? 0;

          if (pageCount > 0 && fileSize >= 100) {
            return this.processResult(parsed, 'html', path, warnings, start);
          }

          // HTML render produced empty/tiny PDF — fall through to URL fallback
          warnings.push(
            `HTML rendering produced ${pageCount} pages / ${fileSize} bytes — retrying with URL`,
          );
        } catch (parseErr) {
          warnings.push(`Failed to parse daemon HTML response: ${String(parseErr)}`);
        }
      }
    }

    // 10. URL fallback: send URL instead of HTML
    if (tabUrlResolved) {
      const elapsed = Date.now() - start;
      const remainingTimeout = Math.max(5_000, timeout - elapsed);

      const urlParams = { ...daemonParams };
      delete urlParams['html'];
      delete urlParams['baseURL'];
      urlParams['url'] = tabUrlResolved;

      const result = await this.callDaemon(urlParams, remainingTimeout);
      if (result) {
        try {
          const parsed = typeof result.value === 'string'
            ? JSON.parse(result.value)
            : result.value;
          return this.processResult(parsed, 'url', path, warnings, start);
        } catch (parseErr) {
          return this.makeErrorResponse(
            'DAEMON_PARSE_ERROR',
            `Daemon returned unparseable response: ${String(result.value).slice(0, 200)}`,
            'daemon',
            start,
          );
        }
      }
    }

    // Both paths failed
    return this.makeErrorResponse(
      'PDF_GENERATION_FAILED',
      `Failed to generate PDF. ${warnings.length > 0 ? 'Warnings: ' + warnings.join('; ') : ''}`,
      html ? 'daemon' : 'applescript',
      start,
    );
  }

  // ── Helper: extract HTML from tab ─────────────────────────────────────────

  private async extractHtml(tabUrl?: string): Promise<string> {
    const engine = this.server.getEngine();
    if (!engine) throw new Error('AppleScript engine unavailable');

    const script = tabUrl
      ? `tell application "Safari" to do JavaScript "document.documentElement.outerHTML" in document 1`
      : `tell application "Safari" to do JavaScript "document.documentElement.outerHTML" in current tab of front window`;

    const result = await engine.execute(script, 10_000);
    if (!result.ok || !result.value) {
      throw new Error(result.error?.message ?? 'Failed to extract HTML from Safari tab');
    }
    return result.value;
  }

  // ── Helper: get tab URL ───────────────────────────────────────────────────

  private async getTabUrl(tabUrl?: string): Promise<string> {
    if (tabUrl) return tabUrl;

    const engine = this.server.getEngine();
    if (!engine) throw new Error('AppleScript engine unavailable');

    const script = 'tell application "Safari" to return URL of current tab of front window';
    const result = await engine.execute(script, 5_000);
    if (!result.ok || !result.value) {
      throw new Error(result.error?.message ?? 'Failed to get tab URL');
    }
    return result.value.trim();
  }

  // ── Helper: get document title ────────────────────────────────────────────

  private async getDocumentTitle(tabUrl?: string): Promise<string> {
    const engine = this.server.getEngine();
    if (!engine) return '';

    const script = tabUrl
      ? `tell application "Safari" to return name of document 1`
      : `tell application "Safari" to return name of current tab of front window`;

    try {
      const result = await engine.execute(script, 5_000);
      return result.ok && result.value ? result.value.trim() : '';
    } catch {
      return '';
    }
  }

  // ── Helper: call daemon ───────────────────────────────────────────────────

  private async callDaemon(
    params: Record<string, unknown>,
    timeout: number,
  ): Promise<{ value: string | Record<string, unknown> } | null> {
    const daemon = this.server.getDaemonEngine();
    if (!daemon) return null;

    const available = await daemon.isAvailable();
    if (!available) return null;

    const result = await daemon.command('generate_pdf', params, timeout + 5_000);

    if (result.ok && result.value) {
      return { value: result.value };
    }

    return null;
  }

  // ── Helper: resolve paper size ────────────────────────────────────────────

  private resolvePaperSize(params: Record<string, unknown>): {
    paperWidth: number;
    paperHeight: number;
  } {
    const customWidth = params['width'] as string | undefined;
    const customHeight = params['height'] as string | undefined;

    // Custom dimensions take precedence
    if (customWidth && customHeight) {
      const w = cssToPoints(customWidth);
      const h = cssToPoints(customHeight);
      if (w > 0 && h > 0) {
        return { paperWidth: w, paperHeight: h };
      }
    }

    // Named format lookup (default: Letter)
    const format = (params['format'] as string) ?? 'Letter';
    const size = PAPER_SIZES[format] ?? PAPER_SIZES['Letter'];
    return { paperWidth: size.width, paperHeight: size.height };
  }

  // ── Helper: process daemon result ─────────────────────────────────────────

  private async processResult(
    parsed: Record<string, unknown>,
    source: 'html' | 'url',
    outputPath: string,
    warnings: string[],
    startTime: number,
  ): Promise<ToolResponse> {
    // Verify file exists on disk
    let fileSize = parsed['fileSize'] as number | undefined;
    try {
      const st = await stat(outputPath);
      fileSize = st.size;
    } catch {
      warnings.push('Could not verify file on disk after generation');
    }

    const result = {
      path: outputPath,
      pageCount: parsed['pageCount'] ?? 0,
      fileSize: fileSize ?? 0,
      source,
      warnings: warnings.length > 0 ? warnings : undefined,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      metadata: {
        engine: 'daemon' as Engine,
        degraded: source === 'url',
        degradedReason: source === 'url' ? 'HTML extraction failed, used URL fallback' : undefined,
        latencyMs: Date.now() - startTime,
      },
    };
  }

  // ── Helper: error response ────────────────────────────────────────────────

  private makeErrorResponse(
    code: string,
    message: string,
    engine: Engine,
    startTime: number,
  ): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
      metadata: {
        engine,
        degraded: false,
        latencyMs: Date.now() - startTime,
      },
    };
  }
}
