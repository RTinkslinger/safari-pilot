import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  cssToPoints,
  PAPER_SIZES,
  parsePageRanges,
  injectPrintBackground,
  injectHeaderFooter,
  PdfTools,
} from '../../../src/tools/pdf.js';
import type { SafariPilotServer } from '../../../src/server.js';
import type { EngineResult } from '../../../src/types.js';

// ── cssToPoints ──────────────────────────────────────────────────────────────

describe('cssToPoints', () => {
  it('converts px to points (72pt = 1in, 96px = 1in)', () => {
    // 96px = 1in = 72pt → 1px = 0.75pt
    expect(cssToPoints('96px')).toBeCloseTo(72, 5);
    expect(cssToPoints('1px')).toBeCloseTo(0.75, 5);
    expect(cssToPoints('48px')).toBeCloseTo(36, 5);
  });

  it('converts in to points', () => {
    expect(cssToPoints('1in')).toBe(72);
    expect(cssToPoints('0.5in')).toBe(36);
    expect(cssToPoints('2in')).toBe(144);
  });

  it('converts cm to points', () => {
    // 2.54cm = 1in = 72pt
    expect(cssToPoints('2.54cm')).toBeCloseTo(72, 5);
    expect(cssToPoints('1cm')).toBeCloseTo(72 / 2.54, 5);
  });

  it('converts mm to points', () => {
    // 25.4mm = 1in = 72pt
    expect(cssToPoints('25.4mm')).toBeCloseTo(72, 5);
    expect(cssToPoints('1mm')).toBeCloseTo(72 / 25.4, 5);
    expect(cssToPoints('10mm')).toBeCloseTo(10 / 25.4 * 72, 5);
  });

  it('treats bare number as pixels', () => {
    expect(cssToPoints('96')).toBeCloseTo(72, 5);
    expect(cssToPoints('48')).toBeCloseTo(36, 5);
  });

  it('returns 0 for empty string', () => {
    expect(cssToPoints('')).toBe(0);
  });

  it('returns 0 for invalid input', () => {
    expect(cssToPoints('abc')).toBe(0);
    expect(cssToPoints('px')).toBe(0);
    expect(cssToPoints('in')).toBe(0);
  });

  it('handles zero values', () => {
    expect(cssToPoints('0px')).toBe(0);
    expect(cssToPoints('0in')).toBe(0);
    expect(cssToPoints('0')).toBe(0);
  });

  it('handles decimal values', () => {
    expect(cssToPoints('0.5in')).toBe(36);
    expect(cssToPoints('1.5cm')).toBeCloseTo(1.5 / 2.54 * 72, 5);
  });

  it('is case-insensitive for units', () => {
    expect(cssToPoints('1IN')).toBe(72);
    expect(cssToPoints('96PX')).toBeCloseTo(72, 5);
    expect(cssToPoints('2.54CM')).toBeCloseTo(72, 5);
    expect(cssToPoints('25.4MM')).toBeCloseTo(72, 5);
  });

  it('handles whitespace around value', () => {
    expect(cssToPoints(' 1in ')).toBe(72);
    expect(cssToPoints('  96px  ')).toBeCloseTo(72, 5);
  });
});

// ── PAPER_SIZES ──────────────────────────────────────────────────────────────

describe('PAPER_SIZES', () => {
  it('has Letter at 612 x 792', () => {
    expect(PAPER_SIZES['Letter']).toEqual({ width: 612, height: 792 });
  });

  it('has Legal at 612 x 1008', () => {
    expect(PAPER_SIZES['Legal']).toEqual({ width: 612, height: 1008 });
  });

  it('has A4 at 595.28 x 841.89', () => {
    expect(PAPER_SIZES['A4']).toEqual({ width: 595.28, height: 841.89 });
  });

  it('has A3 at 841.89 x 1190.55', () => {
    expect(PAPER_SIZES['A3']).toEqual({ width: 841.89, height: 1190.55 });
  });

  it('has Tabloid at 792 x 1224', () => {
    expect(PAPER_SIZES['Tabloid']).toEqual({ width: 792, height: 1224 });
  });

  it('contains exactly 5 sizes', () => {
    expect(Object.keys(PAPER_SIZES)).toHaveLength(5);
  });

  it('all sizes have positive width and height', () => {
    for (const [name, size] of Object.entries(PAPER_SIZES)) {
      expect(size.width, `${name} width`).toBeGreaterThan(0);
      expect(size.height, `${name} height`).toBeGreaterThan(0);
    }
  });

  it('all sizes are portrait (width <= height)', () => {
    for (const [name, size] of Object.entries(PAPER_SIZES)) {
      expect(size.width, `${name} should be portrait`).toBeLessThanOrEqual(size.height);
    }
  });
});

// ── parsePageRanges ──────────────────────────────────────────────────────────

describe('parsePageRanges', () => {
  it('parses "1-5" to {first: 1, last: 5}', () => {
    expect(parsePageRanges('1-5')).toEqual({ first: 1, last: 5 });
  });

  it('parses "3" to {first: 3, last: 3}', () => {
    expect(parsePageRanges('3')).toEqual({ first: 3, last: 3 });
  });

  it('returns null for undefined', () => {
    expect(parsePageRanges(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parsePageRanges('')).toBeNull();
  });

  it('returns null when first > last', () => {
    expect(parsePageRanges('5-3')).toBeNull();
  });

  it('returns null for non-numeric input', () => {
    expect(parsePageRanges('abc')).toBeNull();
    expect(parsePageRanges('a-b')).toBeNull();
  });

  it('handles single page 1', () => {
    expect(parsePageRanges('1')).toEqual({ first: 1, last: 1 });
  });

  it('handles large ranges', () => {
    expect(parsePageRanges('1-100')).toEqual({ first: 1, last: 100 });
  });

  it('returns null for zero page', () => {
    expect(parsePageRanges('0')).toBeNull();
  });

  it('returns null for negative pages', () => {
    expect(parsePageRanges('-1')).toBeNull();
  });

  it('returns null for float pages', () => {
    expect(parsePageRanges('1.5')).toBeNull();
    expect(parsePageRanges('1.5-3')).toBeNull();
  });

  it('handles whitespace', () => {
    expect(parsePageRanges(' 1-5 ')).toEqual({ first: 1, last: 5 });
    expect(parsePageRanges(' 3 ')).toEqual({ first: 3, last: 3 });
  });

  it('returns null for multiple dashes', () => {
    expect(parsePageRanges('1-3-5')).toBeNull();
  });

  it('handles equal first and last in range', () => {
    expect(parsePageRanges('5-5')).toEqual({ first: 5, last: 5 });
  });
});

// ── injectPrintBackground ────────────────────────────────────────────────────

describe('injectPrintBackground', () => {
  const expectedCSS = '* { -webkit-print-color-adjust: exact !important; color-adjust: exact !important; }';

  it('injects CSS before </head> in a full HTML document', () => {
    const html = '<html><head><title>Test</title></head><body>Hello</body></html>';
    const result = injectPrintBackground(html);

    expect(result).toContain(expectedCSS);
    // CSS should appear before </head>
    const cssIndex = result.indexOf(expectedCSS);
    const headCloseIndex = result.indexOf('</head>');
    expect(cssIndex).toBeLessThan(headCloseIndex);
    // Original content is preserved
    expect(result).toContain('<title>Test</title>');
    expect(result).toContain('<body>Hello</body>');
  });

  it('prepends CSS when no </head> tag exists', () => {
    const html = '<div>No head tag here</div>';
    const result = injectPrintBackground(html);

    expect(result).toContain(expectedCSS);
    // CSS should appear before original content
    const cssIndex = result.indexOf(expectedCSS);
    const divIndex = result.indexOf('<div>');
    expect(cssIndex).toBeLessThan(divIndex);
  });

  it('wraps CSS in a <style> tag', () => {
    const html = '<html><head></head><body></body></html>';
    const result = injectPrintBackground(html);

    expect(result).toContain('<style>');
    expect(result).toContain('</style>');
  });

  it('handles empty HTML', () => {
    const result = injectPrintBackground('');
    expect(result).toContain(expectedCSS);
  });

  it('preserves existing styles', () => {
    const html = '<html><head><style>body { color: red; }</style></head><body></body></html>';
    const result = injectPrintBackground(html);

    expect(result).toContain('body { color: red; }');
    expect(result).toContain(expectedCSS);
  });

  it('is case-insensitive for </head> matching', () => {
    const html = '<html><HEAD></HEAD><body></body></html>';
    const result = injectPrintBackground(html);
    expect(result).toContain(expectedCSS);
  });
});

// ── injectHeaderFooter ───────────────────────────────────────────────────────

describe('injectHeaderFooter', () => {
  const tokens = {
    title: 'My Document',
    url: 'https://example.com/doc',
    date: '2026-04-14',
  };

  it('injects header div before </body>', () => {
    const html = '<html><head></head><body><p>Content</p></body></html>';
    const result = injectHeaderFooter(html, '<span>Header</span>', undefined, tokens);

    expect(result).toContain('sp-pdf-header');
    expect(result).toContain('Header');
  });

  it('injects footer div before </body>', () => {
    const html = '<html><head></head><body><p>Content</p></body></html>';
    const result = injectHeaderFooter(html, undefined, '<span>Footer</span>', tokens);

    expect(result).toContain('sp-pdf-footer');
    expect(result).toContain('Footer');
  });

  it('injects both header and footer', () => {
    const html = '<html><head></head><body><p>Content</p></body></html>';
    const result = injectHeaderFooter(html, '<span>H</span>', '<span>F</span>', tokens);

    expect(result).toContain('sp-pdf-header');
    expect(result).toContain('sp-pdf-footer');
  });

  it('injects CSS for header/footer positioning before </head>', () => {
    const html = '<html><head></head><body></body></html>';
    const result = injectHeaderFooter(html, '<span>H</span>', undefined, tokens);

    // Check that positioning CSS is present
    expect(result).toContain('position: fixed');
    expect(result).toContain('.sp-pdf-header');
    expect(result).toContain('z-index');
  });

  it('adds body margin offset for header/footer space', () => {
    const html = '<html><head></head><body></body></html>';
    const result = injectHeaderFooter(html, '<span>H</span>', '<span>F</span>', tokens);

    // Body should have margin for header/footer
    expect(result).toContain('margin-top');
    expect(result).toContain('margin-bottom');
  });

  it('replaces class="pageNumber" with CSS counter(page)', () => {
    const html = '<html><head></head><body></body></html>';
    const header = '<span class="pageNumber"></span>';
    const result = injectHeaderFooter(html, header, undefined, tokens);

    expect(result).toContain('counter(page)');
  });

  it('replaces class="totalPages" with CSS counter(pages)', () => {
    const html = '<html><head></head><body></body></html>';
    const footer = '<span class="totalPages"></span>';
    const result = injectHeaderFooter(html, undefined, footer, tokens);

    expect(result).toContain('counter(pages)');
  });

  it('replaces class="date" with literal date string', () => {
    const html = '<html><head></head><body></body></html>';
    const header = '<span class="date"></span>';
    const result = injectHeaderFooter(html, header, undefined, tokens);

    expect(result).toContain('2026-04-14');
  });

  it('replaces class="title" with literal title string', () => {
    const html = '<html><head></head><body></body></html>';
    const header = '<span class="title"></span>';
    const result = injectHeaderFooter(html, header, undefined, tokens);

    expect(result).toContain('My Document');
  });

  it('replaces class="url" with literal url string', () => {
    const html = '<html><head></head><body></body></html>';
    const footer = '<span class="url"></span>';
    const result = injectHeaderFooter(html, undefined, footer, tokens);

    expect(result).toContain('https://example.com/doc');
  });

  it('handles multiple token replacements in same template', () => {
    const html = '<html><head></head><body></body></html>';
    const header = '<span class="title"></span> - <span class="date"></span> - Page <span class="pageNumber"></span>';
    const result = injectHeaderFooter(html, header, undefined, tokens);

    expect(result).toContain('My Document');
    expect(result).toContain('2026-04-14');
    expect(result).toContain('counter(page)');
  });

  it('returns unchanged HTML when both header and footer are undefined', () => {
    const html = '<html><head></head><body><p>Content</p></body></html>';
    const result = injectHeaderFooter(html, undefined, undefined, tokens);

    // No header/footer divs should be injected
    expect(result).not.toContain('sp-pdf-header');
    expect(result).not.toContain('sp-pdf-footer');
  });

  it('preserves original body content', () => {
    const html = '<html><head></head><body><p>Important content</p></body></html>';
    const result = injectHeaderFooter(html, '<span>H</span>', '<span>F</span>', tokens);

    expect(result).toContain('<p>Important content</p>');
  });

  it('handles HTML without </body> by appending', () => {
    const html = '<html><head></head><body><p>Content</p>';
    const result = injectHeaderFooter(html, '<span>H</span>', undefined, tokens);

    expect(result).toContain('sp-pdf-header');
    expect(result).toContain('>H</span>');
  });

  it('CSS includes font size, color, and padding', () => {
    const html = '<html><head></head><body></body></html>';
    const result = injectHeaderFooter(html, '<span>H</span>', undefined, tokens);

    expect(result).toContain('10px');
    expect(result).toContain('#666');
    expect(result).toContain('20px');
  });

  it('CSS includes z-index 999999', () => {
    const html = '<html><head></head><body></body></html>';
    const result = injectHeaderFooter(html, '<span>H</span>', undefined, tokens);

    expect(result).toContain('999999');
  });

  it('escapes HTML entities in title token', () => {
    const dangerousTokens = {
      title: '<script>alert("xss")</script>',
      url: 'https://example.com',
      date: '2026-04-14',
    };
    const html = '<html><head></head><body></body></html>';
    const header = '<span class="title"></span>';
    const result = injectHeaderFooter(html, header, undefined, dangerousTokens);

    // Should not contain raw script tag
    expect(result).not.toContain('<script>alert("xss")</script>');
  });
});

// ── Mock factories (pattern from downloads.test.ts) ─────────────────────────

function makeDaemonEngine(overrides: {
  isAvailable?: () => Promise<boolean>;
  command?: (method: string, params: Record<string, unknown>, timeout?: number) => Promise<EngineResult>;
} = {}) {
  return {
    name: 'daemon' as const,
    isAvailable: overrides.isAvailable
      ? vi.fn().mockImplementation(overrides.isAvailable)
      : vi.fn().mockResolvedValue(false),
    command: overrides.command
      ? vi.fn().mockImplementation(overrides.command)
      : vi.fn().mockResolvedValue({ ok: false, error: { code: 'UNAVAILABLE', message: 'mock', retryable: false }, elapsed_ms: 1 }),
    execute: vi.fn().mockResolvedValue({ ok: false, error: { code: 'UNAVAILABLE', message: 'mock', retryable: false }, elapsed_ms: 1 }),
  };
}

function makeAppleScriptEngine(overrides: {
  execute?: (script: string, timeout?: number) => Promise<EngineResult>;
} = {}) {
  return {
    name: 'applescript' as const,
    execute: overrides.execute
      ? vi.fn().mockImplementation(overrides.execute)
      : vi.fn().mockResolvedValue({ ok: true, value: '<html><head></head><body>Test</body></html>', elapsed_ms: 5 }),
    isAvailable: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function makeServer(overrides: {
  daemonEngine?: ReturnType<typeof makeDaemonEngine> | null;
  appleScriptEngine?: ReturnType<typeof makeAppleScriptEngine> | null;
} = {}): SafariPilotServer {
  return {
    getDaemonEngine: vi.fn().mockReturnValue(overrides.daemonEngine ?? null),
    getEngine: vi.fn().mockReturnValue(overrides.appleScriptEngine ?? makeAppleScriptEngine()),
  } as unknown as SafariPilotServer;
}

// ── PdfTools - getDefinitions() ─────────────────────────────────────────────

describe('PdfTools - getDefinitions()', () => {
  let tools: PdfTools;

  beforeEach(() => {
    tools = new PdfTools(makeServer());
  });

  it('returns exactly 1 tool', () => {
    expect(tools.getDefinitions()).toHaveLength(1);
  });

  it('tool name is safari_export_pdf', () => {
    expect(tools.getDefinitions()[0].name).toBe('safari_export_pdf');
  });

  it('path is in the required array', () => {
    const schema = tools.getDefinitions()[0].inputSchema as Record<string, unknown>;
    const required = schema['required'] as string[];
    expect(required).toContain('path');
  });

  it('has format property with enum', () => {
    const schema = tools.getDefinitions()[0].inputSchema as Record<string, unknown>;
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['format']).toBeDefined();
    expect(props['format']['enum']).toEqual(['Letter', 'Legal', 'A4', 'A3', 'Tabloid']);
  });

  it('has margin property as object type', () => {
    const schema = tools.getDefinitions()[0].inputSchema as Record<string, unknown>;
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['margin']).toBeDefined();
    expect(props['margin']['type']).toBe('object');
  });

  it('has scale property', () => {
    const schema = tools.getDefinitions()[0].inputSchema as Record<string, unknown>;
    const props = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(props['scale']).toBeDefined();
    expect(props['scale']['type']).toBe('number');
  });

  it('requirements is an empty object', () => {
    const reqs = tools.getDefinitions()[0].requirements;
    expect(reqs).toEqual({});
  });

  it('all tools have the safari_ prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });
});

// ── PdfTools - getHandler() ─────────────────────────────────────────────────

describe('PdfTools - getHandler()', () => {
  let tools: PdfTools;

  beforeEach(() => {
    tools = new PdfTools(makeServer());
  });

  it('returns a defined handler for safari_export_pdf', () => {
    const handler = tools.getHandler('safari_export_pdf');
    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
  });

  it('returns undefined for an unknown tool name', () => {
    expect(tools.getHandler('unknown_tool')).toBeUndefined();
  });
});

// ── PdfTools - missing path error ───────────────────────────────────────────

describe('PdfTools - missing path error', () => {
  it('returns INVALID_OUTPUT_PATH when path is missing', async () => {
    const tools = new PdfTools(makeServer());
    const handler = tools.getHandler('safari_export_pdf')!;

    const response = await handler({});
    const parsed = JSON.parse(response.content[0].text!);

    expect(parsed).toHaveProperty('error', 'INVALID_OUTPUT_PATH');
    expect(parsed).toHaveProperty('message');
  });
});

// ── PdfTools - daemon dispatch ──────────────────────────────────────────────

describe('PdfTools - daemon dispatch', () => {
  it('calls daemon.command with generate_pdf method', async () => {
    const daemon = makeDaemonEngine({
      isAvailable: async () => true,
      command: async () => ({
        ok: true,
        value: JSON.stringify({ pageCount: 1, fileSize: 5000 }),
        elapsed_ms: 50,
      }),
    });

    const server = makeServer({ daemonEngine: daemon });
    const tools = new PdfTools(server);
    const handler = tools.getHandler('safari_export_pdf')!;

    await handler({ path: '/tmp/test.pdf' });

    expect(daemon.command).toHaveBeenCalledWith(
      'generate_pdf',
      expect.any(Object),
      expect.any(Number),
    );
  });

  it('passes margin values converted to points', async () => {
    const daemon = makeDaemonEngine({
      isAvailable: async () => true,
      command: async () => ({
        ok: true,
        value: JSON.stringify({ pageCount: 1, fileSize: 5000 }),
        elapsed_ms: 50,
      }),
    });

    const server = makeServer({ daemonEngine: daemon });
    const tools = new PdfTools(server);
    const handler = tools.getHandler('safari_export_pdf')!;

    await handler({
      path: '/tmp/test.pdf',
      margin: { top: '1in', right: '0.5in', bottom: '1in', left: '0.5in' },
    });

    // 1in = 72pt, 0.5in = 36pt
    expect(daemon.command).toHaveBeenCalledWith(
      'generate_pdf',
      expect.objectContaining({
        marginTop: 72,
        marginRight: 36,
        marginBottom: 72,
        marginLeft: 36,
      }),
      expect.any(Number),
    );
  });

  it('passes A4 paper size dimensions', async () => {
    const daemon = makeDaemonEngine({
      isAvailable: async () => true,
      command: async () => ({
        ok: true,
        value: JSON.stringify({ pageCount: 1, fileSize: 5000 }),
        elapsed_ms: 50,
      }),
    });

    const server = makeServer({ daemonEngine: daemon });
    const tools = new PdfTools(server);
    const handler = tools.getHandler('safari_export_pdf')!;

    await handler({ path: '/tmp/test.pdf', format: 'A4' });

    expect(daemon.command).toHaveBeenCalledWith(
      'generate_pdf',
      expect.objectContaining({
        paperWidth: 595.28,
        paperHeight: 841.89,
      }),
      expect.any(Number),
    );
  });

  it('clamps scale to 0.1-2.0 range', async () => {
    const daemon = makeDaemonEngine({
      isAvailable: async () => true,
      command: async () => ({
        ok: true,
        value: JSON.stringify({ pageCount: 1, fileSize: 5000 }),
        elapsed_ms: 50,
      }),
    });

    const server = makeServer({ daemonEngine: daemon });
    const tools = new PdfTools(server);
    const handler = tools.getHandler('safari_export_pdf')!;

    // Scale below minimum
    await handler({ path: '/tmp/test.pdf', scale: 0.01 });
    expect(daemon.command).toHaveBeenCalledWith(
      'generate_pdf',
      expect.objectContaining({ scale: 0.1 }),
      expect.any(Number),
    );

    daemon.command.mockClear();

    // Scale above maximum
    await handler({ path: '/tmp/test.pdf', scale: 5.0 });
    expect(daemon.command).toHaveBeenCalledWith(
      'generate_pdf',
      expect.objectContaining({ scale: 2.0 }),
      expect.any(Number),
    );
  });
});

// ── PdfTools - response shape ───────────────────────────────────────────────

describe('PdfTools - response shape', () => {
  it('daemon success returns content + metadata with engine=daemon', async () => {
    const daemon = makeDaemonEngine({
      isAvailable: async () => true,
      command: async () => ({
        ok: true,
        value: JSON.stringify({ pageCount: 3, fileSize: 12345 }),
        elapsed_ms: 100,
      }),
    });

    const server = makeServer({ daemonEngine: daemon });
    const tools = new PdfTools(server);
    const handler = tools.getHandler('safari_export_pdf')!;

    const response = await handler({ path: '/tmp/test.pdf' });

    expect(response).toHaveProperty('content');
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.content[0]).toHaveProperty('type', 'text');

    expect(response).toHaveProperty('metadata');
    expect(response.metadata.engine).toBe('daemon');
    expect(response.metadata).toHaveProperty('degraded');
    expect(typeof response.metadata.latencyMs).toBe('number');
  });

  it('no daemon returns error response', async () => {
    const server = makeServer({ daemonEngine: null });
    const tools = new PdfTools(server);
    const handler = tools.getHandler('safari_export_pdf')!;

    const response = await handler({ path: '/tmp/test.pdf' });
    const parsed = JSON.parse(response.content[0].text!);

    expect(parsed).toHaveProperty('error');
    expect(response).toHaveProperty('metadata');
    expect(typeof response.metadata.latencyMs).toBe('number');
  });
});
