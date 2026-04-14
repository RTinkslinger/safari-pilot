// ── PDF utility functions ────────────────────────────────────────────────────
// Pure functions for CSS unit conversion, paper sizes, page ranges,
// and HTML injection for print backgrounds and headers/footers.
// No daemon or server dependencies — fully testable in isolation.

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
