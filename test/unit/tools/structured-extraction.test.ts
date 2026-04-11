import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StructuredExtractionTools } from '../../../src/tools/structured-extraction.js';
import type { EngineResult } from '../../../src/types.js';

// ── Mock factory ──────────────────────────────────────────────────────────────

function makeEngine(): {
  name: 'applescript';
  executeJsInTab: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
} {
  return {
    name: 'applescript' as const,
    executeJsInTab: vi.fn(),
    execute: vi.fn(),
  };
}

function okResult(value: string): EngineResult {
  return { ok: true, value, elapsed_ms: 10 };
}

function errResult(message: string): EngineResult {
  return { ok: false, error: { code: 'JS_ERROR', message, retryable: false }, elapsed_ms: 10 };
}

// ── Shared setup ──────────────────────────────────────────────────────────────

let mockEngine: ReturnType<typeof makeEngine>;
let tools: StructuredExtractionTools;

beforeEach(() => {
  mockEngine = makeEngine();
  tools = new StructuredExtractionTools(mockEngine as any);
  vi.clearAllMocks();
});

// ── Tool registration ─────────────────────────────────────────────────────────

describe('StructuredExtractionTools - tool definitions', () => {
  it('registers exactly 5 tools', () => {
    expect(tools.getDefinitions()).toHaveLength(5);
  });

  const expectedTools = [
    'safari_smart_scrape',
    'safari_extract_tables',
    'safari_extract_links',
    'safari_extract_images',
    'safari_extract_metadata',
  ];

  for (const name of expectedTools) {
    it(`registers tool: ${name}`, () => {
      const defs = tools.getDefinitions();
      expect(defs.find((d) => d.name === name)).toBeDefined();
    });
  }

  it('all tool names have the "safari_" prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });

  it('getHandler throws for unknown tool name', () => {
    expect(() => tools.getHandler('safari_does_not_exist')).toThrow('unknown tool');
  });
});

// ── safari_smart_scrape ───────────────────────────────────────────────────────

describe('safari_smart_scrape', () => {
  it('requires tabUrl and schema in the schema', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_smart_scrape')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('schema');
  });

  it('schema has optional scope param', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_smart_scrape')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('scope');
  });

  it('returns structured data matching the provided schema fields', async () => {
    const payload = {
      data: { name: 'John Doe', email: 'john@example.com', price: '$49.99' },
      fieldsExtracted: 3,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(payload)));

    const handler = tools.getHandler('safari_smart_scrape');
    const result = await handler({
      tabUrl: 'https://example.com',
      schema: { properties: { name: {}, email: {}, price: {} } },
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.data.name).toBe('John Doe');
    expect(data.data.email).toBe('john@example.com');
    expect(data.data.price).toBe('$49.99');
    expect(data.fieldsExtracted).toBe(3);
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ data: {}, fieldsExtracted: 0 })));

    const handler = tools.getHandler('safari_smart_scrape');
    await handler({ tabUrl: 'https://example.com', schema: {} });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('returns null for fields not found in DOM', async () => {
    const payload = { data: { missingField: null }, fieldsExtracted: 1 };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(payload)));

    const handler = tools.getHandler('safari_smart_scrape');
    const result = await handler({
      tabUrl: 'https://example.com',
      schema: { properties: { missingField: {} } },
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.data.missingField).toBeNull();
  });

  it('throws when engine returns an error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Scope element not found'));

    const handler = tools.getHandler('safari_smart_scrape');
    await expect(handler({ tabUrl: 'https://example.com', schema: {} })).rejects.toThrow('Scope element not found');
  });
});

// ── safari_extract_tables ─────────────────────────────────────────────────────

describe('safari_extract_tables', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_extract_tables')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
  });

  it('schema has optional selector param', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_extract_tables')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('selector');
  });

  it('parses HTML table headers and rows correctly', async () => {
    const payload = {
      tables: [
        {
          headers: ['Product', 'Price', 'Stock'],
          rows: [
            ['Widget A', '$10.00', '50'],
            ['Widget B', '$20.00', '30'],
          ],
        },
      ],
      count: 1,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(payload)));

    const handler = tools.getHandler('safari_extract_tables');
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.tables).toHaveLength(1);
    expect(data.count).toBe(1);
    expect(data.tables[0].headers).toEqual(['Product', 'Price', 'Stock']);
    expect(data.tables[0].rows).toHaveLength(2);
    expect(data.tables[0].rows[0]).toEqual(['Widget A', '$10.00', '50']);
    expect(data.tables[0].rows[1]).toEqual(['Widget B', '$20.00', '30']);
  });

  it('returns empty tables array when no tables found', async () => {
    const payload = { tables: [], count: 0 };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(payload)));

    const handler = tools.getHandler('safari_extract_tables');
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.tables).toHaveLength(0);
    expect(data.count).toBe(0);
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ tables: [], count: 0 })));

    const handler = tools.getHandler('safari_extract_tables');
    await handler({ tabUrl: 'https://example.com' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns an error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Extract tables failed'));

    const handler = tools.getHandler('safari_extract_tables');
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('Extract tables failed');
  });
});

// ── safari_extract_links ──────────────────────────────────────────────────────

describe('safari_extract_links', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_extract_links')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
  });

  it('schema has filter enum with all/internal/external options', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_extract_links')!;
    const props = (def.inputSchema as any).properties;
    expect(props.filter.enum).toContain('all');
    expect(props.filter.enum).toContain('internal');
    expect(props.filter.enum).toContain('external');
  });

  it('returns links with href, text, and context', async () => {
    const payload = {
      links: [
        { href: '/about', text: 'About Us', context: 'Navigation', internal: true },
        { href: 'https://external.example.com/blog', text: 'External Blog', context: 'Navigation', internal: false },
      ],
      count: 2,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(payload)));

    const handler = tools.getHandler('safari_extract_links');
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.links).toHaveLength(2);
    expect(data.count).toBe(2);
    expect(data.links[0].href).toBe('/about');
    expect(data.links[0].text).toBe('About Us');
    expect(data.links[0].context).toBe('Navigation');
    expect(data.links[0].internal).toBe(true);
    expect(data.links[1].internal).toBe(false);
  });

  it('passes tabUrl and filter to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ links: [], count: 0 })));

    const handler = tools.getHandler('safari_extract_links');
    await handler({ tabUrl: 'https://example.com', filter: 'external' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('returns empty links array when no links found', async () => {
    const payload = { links: [], count: 0 };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(payload)));

    const handler = tools.getHandler('safari_extract_links');
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.links).toHaveLength(0);
    expect(data.count).toBe(0);
  });

  it('throws when engine returns an error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Extract links failed'));

    const handler = tools.getHandler('safari_extract_links');
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('Extract links failed');
  });
});

// ── safari_extract_images ─────────────────────────────────────────────────────

describe('safari_extract_images', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_extract_images')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
  });

  it('schema has minWidth and minHeight optional params', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_extract_images')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('minWidth');
    expect(props).toHaveProperty('minHeight');
  });

  it('returns images with src, alt, and dimensions', async () => {
    const payload = {
      images: [
        { src: 'https://example.com/hero.jpg', alt: 'Hero image', width: 800, height: 400, naturalWidth: 1600, naturalHeight: 800 },
        { src: 'https://example.com/thumb.jpg', alt: 'Thumbnail', width: 100, height: 100, naturalWidth: 200, naturalHeight: 200 },
      ],
      count: 2,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(payload)));

    const handler = tools.getHandler('safari_extract_images');
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.images).toHaveLength(2);
    expect(data.count).toBe(2);
    expect(data.images[0].src).toBe('https://example.com/hero.jpg');
    expect(data.images[0].alt).toBe('Hero image');
    expect(data.images[0].width).toBe(800);
    expect(data.images[0].height).toBe(400);
    expect(data.images[0].naturalWidth).toBe(1600);
    expect(data.images[0].naturalHeight).toBe(800);
  });

  it('filters images below minWidth threshold', async () => {
    // Engine is mocked — just verify params are passed to JS
    const payload = {
      images: [
        { src: 'https://example.com/hero.jpg', alt: 'Hero', width: 800, height: 400, naturalWidth: 800, naturalHeight: 400 },
      ],
      count: 1,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(payload)));

    const handler = tools.getHandler('safari_extract_images');
    const result = await handler({ tabUrl: 'https://example.com', minWidth: 200, minHeight: 200 });
    const data = JSON.parse(result.content[0].text!);

    // The JS contains the minWidth/minHeight values — verify the call happened with JS containing those values
    const jsArg = mockEngine.executeJsInTab.mock.calls[0][1] as string;
    expect(jsArg).toContain('200'); // both minW and minH are 200
    expect(data.images).toHaveLength(1);
  });

  it('returns empty images array when none found', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ images: [], count: 0 })));

    const handler = tools.getHandler('safari_extract_images');
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.images).toHaveLength(0);
    expect(data.count).toBe(0);
  });

  it('throws when engine returns an error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Extract images failed'));

    const handler = tools.getHandler('safari_extract_images');
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('Extract images failed');
  });
});

// ── safari_extract_metadata ───────────────────────────────────────────────────

describe('safari_extract_metadata', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_extract_metadata')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
  });

  it('returns standard meta tags', async () => {
    const payload = {
      meta: {
        title: 'Extraction Test Page',
        description: 'A test page for structured extraction',
        keywords: 'test, extraction, safari-pilot',
        author: 'Safari Pilot Tests',
        robots: null,
        viewport: null,
      },
      canonical: 'https://example.com/canonical',
      openGraph: {},
      twitter: {},
      jsonLd: [],
      url: 'https://example.com/test',
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(payload)));

    const handler = tools.getHandler('safari_extract_metadata');
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.meta.title).toBe('Extraction Test Page');
    expect(data.meta.description).toBe('A test page for structured extraction');
    expect(data.meta.author).toBe('Safari Pilot Tests');
    expect(data.canonical).toBe('https://example.com/canonical');
  });

  it('returns Open Graph metadata', async () => {
    const payload = {
      meta: { title: 'Test', description: null, keywords: null, author: null, robots: null, viewport: null },
      canonical: null,
      openGraph: {
        title: 'OG Test Title',
        description: 'OG test description',
        image: 'https://example.com/og-image.png',
        url: 'https://example.com/test',
      },
      twitter: {},
      jsonLd: [],
      url: 'https://example.com',
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(payload)));

    const handler = tools.getHandler('safari_extract_metadata');
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.openGraph.title).toBe('OG Test Title');
    expect(data.openGraph.description).toBe('OG test description');
    expect(data.openGraph.image).toBe('https://example.com/og-image.png');
  });

  it('returns Twitter Card metadata', async () => {
    const payload = {
      meta: { title: 'Test', description: null, keywords: null, author: null, robots: null, viewport: null },
      canonical: null,
      openGraph: {},
      twitter: {
        card: 'summary_large_image',
        title: 'Twitter Test Title',
        description: 'Twitter test description',
      },
      jsonLd: [],
      url: 'https://example.com',
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(payload)));

    const handler = tools.getHandler('safari_extract_metadata');
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.twitter.card).toBe('summary_large_image');
    expect(data.twitter.title).toBe('Twitter Test Title');
  });

  it('returns JSON-LD structured data', async () => {
    const ldObj = { '@context': 'https://schema.org', '@type': 'WebPage', name: 'Extraction Test Page' };
    const payload = {
      meta: { title: 'Test', description: null, keywords: null, author: null, robots: null, viewport: null },
      canonical: null,
      openGraph: {},
      twitter: {},
      jsonLd: [ldObj],
      url: 'https://example.com',
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(payload)));

    const handler = tools.getHandler('safari_extract_metadata');
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.jsonLd).toHaveLength(1);
    expect(data.jsonLd[0]['@type']).toBe('WebPage');
    expect(data.jsonLd[0].name).toBe('Extraction Test Page');
  });

  it('passes tabUrl to engine', async () => {
    const emptyPayload = {
      meta: { title: null, description: null, keywords: null, author: null, robots: null, viewport: null },
      canonical: null,
      openGraph: {},
      twitter: {},
      jsonLd: [],
      url: 'https://example.com',
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(emptyPayload)));

    const handler = tools.getHandler('safari_extract_metadata');
    await handler({ tabUrl: 'https://example.com' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns an error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Extract metadata failed'));

    const handler = tools.getHandler('safari_extract_metadata');
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('Extract metadata failed');
  });
});

// ── ToolResponse metadata ─────────────────────────────────────────────────────

describe('ToolResponse metadata', () => {
  it('includes engine=applescript, degraded=false, and latencyMs in metadata', async () => {
    const payload = { tables: [], count: 0 };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(payload)));

    const handler = tools.getHandler('safari_extract_tables');
    const result = await handler({ tabUrl: 'https://example.com' });

    expect(result.metadata.engine).toBe('applescript');
    expect(result.metadata.degraded).toBe(false);
    expect(typeof result.metadata.latencyMs).toBe('number');
  });
});
