import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
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

// ── Shared engine and tools ───────────────────────────────────────────────────

let mockEngine: ReturnType<typeof makeEngine>;
let tools: ExtractionTools;

beforeEach(() => {
  mockEngine = makeEngine();
  tools = new ExtractionTools(mockEngine as any);
  vi.clearAllMocks();
});

// ── Tool definitions ──────────────────────────────────────────────────────────

describe('ExtractionTools - tool definitions', () => {
  it('registers 7 P0 extraction tools', () => {
    expect(tools.getDefinitions()).toHaveLength(7);
  });

  const expectedTools = [
    'safari_snapshot',
    'safari_get_text',
    'safari_get_html',
    'safari_get_attribute',
    'safari_evaluate',
    'safari_take_screenshot',
    'safari_get_console_messages',
  ];

  for (const name of expectedTools) {
    it(`registers ${name}`, () => {
      const defs = tools.getDefinitions();
      expect(defs.find((d) => d.name === name)).toBeDefined();
    });
  }

  it('all tool names have the "safari_" prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });
});

// ── safari_snapshot ───────────────────────────────────────────────────────────

describe('safari_snapshot', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_snapshot')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
  });

  it('returns accessibility tree with snapshot, elementCount, interactiveCount', async () => {
    const snapshotData = {
      snapshot: '- heading "Test" [level=1]\n- button "Submit" [enabled]',
      url: 'https://example.com',
      title: 'Test Page',
      elementCount: 2,
      interactiveCount: 1,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(snapshotData)));

    const handler = tools.getHandler('safari_snapshot')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.snapshot).toContain('heading');
    expect(data.snapshot).toContain('button');
    expect(data.elementCount).toBe(2);
    expect(data.interactiveCount).toBe(1);
    expect(data.url).toBe('https://example.com');
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Snapshot failed'));

    const handler = tools.getHandler('safari_snapshot')!;
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('Snapshot failed');
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ snapshot: '', elementCount: 0, interactiveCount: 0, url: '', title: '' })));

    const handler = tools.getHandler('safari_snapshot')!;
    await handler({ tabUrl: 'https://example.com' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('schema has format and scope optional params', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_snapshot')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('format');
    expect(props).toHaveProperty('scope');
    expect(props).toHaveProperty('maxDepth');
    expect(props).toHaveProperty('includeHidden');
  });
});

// ── safari_get_text ───────────────────────────────────────────────────────────

describe('safari_get_text', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_get_text')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
  });

  it('returns page text content', async () => {
    const textData = { text: 'Hello World', length: 11, truncated: false };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(textData)));

    const handler = tools.getHandler('safari_get_text')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.text).toBe('Hello World');
    expect(data.length).toBe(11);
    expect(data.truncated).toBe(false);
  });

  it('indicates when text is truncated', async () => {
    const textData = { text: 'A'.repeat(50000), length: 100000, truncated: true };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(textData)));

    const handler = tools.getHandler('safari_get_text')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.truncated).toBe(true);
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Element not found'));

    const handler = tools.getHandler('safari_get_text')!;
    await expect(handler({ tabUrl: 'https://example.com', selector: '#missing' })).rejects.toThrow('Element not found');
  });

  it('schema has selector and maxLength optional params', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_get_text')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('selector');
    expect(props).toHaveProperty('maxLength');
  });
});

// ── safari_get_html ───────────────────────────────────────────────────────────

describe('safari_get_html', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_get_html')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
  });

  it('returns HTML content', async () => {
    const htmlData = { html: '<div><p>Hello</p></div>', length: 22 };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(htmlData)));

    const handler = tools.getHandler('safari_get_html')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.html).toBe('<div><p>Hello</p></div>');
    expect(data.length).toBe(22);
  });

  it('schema has selector and outer optional params', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_get_html')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('selector');
    expect(props).toHaveProperty('outer');
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Get HTML failed'));

    const handler = tools.getHandler('safari_get_html')!;
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('Get HTML failed');
  });
});

// ── safari_get_attribute ──────────────────────────────────────────────────────

describe('safari_get_attribute', () => {
  it('requires tabUrl, selector, and attribute in schema', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_get_attribute')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('selector');
    expect(required).toContain('attribute');
  });

  it('returns attribute value and element info', async () => {
    const attrData = { value: 'https://link.com', element: { tagName: 'A', id: 'my-link' } };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(attrData)));

    const handler = tools.getHandler('safari_get_attribute')!;
    const result = await handler({ tabUrl: 'https://example.com', selector: 'a#my-link', attribute: 'href' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.value).toBe('https://link.com');
    expect(data.element.tagName).toBe('A');
  });

  it('returns null value for missing attribute', async () => {
    const attrData = { value: null, element: { tagName: 'DIV', id: undefined } };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(attrData)));

    const handler = tools.getHandler('safari_get_attribute')!;
    const result = await handler({ tabUrl: 'https://example.com', selector: 'div', attribute: 'href' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.value).toBeNull();
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Element not found'));

    const handler = tools.getHandler('safari_get_attribute')!;
    await expect(handler({ tabUrl: 'https://example.com', selector: '#missing', attribute: 'href' })).rejects.toThrow('Element not found');
  });
});

// ── safari_evaluate ───────────────────────────────────────────────────────────

describe('safari_evaluate', () => {
  it('requires tabUrl and script in schema', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_evaluate')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('script');
  });

  it('executes arbitrary JS and returns result', async () => {
    const evalData = { value: 42, type: 'number' };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(evalData)));

    const handler = tools.getHandler('safari_evaluate')!;
    const result = await handler({ tabUrl: 'https://example.com', script: 'return 42' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.value).toBe(42);
    expect(data.type).toBe('number');
  });

  it('returns string results', async () => {
    const evalData = { value: 'hello', type: 'string' };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(evalData)));

    const handler = tools.getHandler('safari_evaluate')!;
    const result = await handler({ tabUrl: 'https://example.com', script: 'return "hello"' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.value).toBe('hello');
    expect(data.type).toBe('string');
  });

  it('passes timeout to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ value: true, type: 'boolean' })));

    const handler = tools.getHandler('safari_evaluate')!;
    await handler({ tabUrl: 'https://example.com', script: 'return true', timeout: 5000 });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith(
      'https://example.com',
      expect.any(String),
      5000,
    );
  });

  it('uses default timeout of 10000 when not specified', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ value: 1, type: 'number' })));

    const handler = tools.getHandler('safari_evaluate')!;
    await handler({ tabUrl: 'https://example.com', script: 'return 1' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith(
      'https://example.com',
      expect.any(String),
      10000,
    );
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Evaluate failed'));

    const handler = tools.getHandler('safari_evaluate')!;
    await expect(handler({ tabUrl: 'https://example.com', script: 'throw new Error()' })).rejects.toThrow('Evaluate failed');
  });
});

// ── safari_take_screenshot ────────────────────────────────────────────────────

describe('safari_take_screenshot', () => {
  it('schema has tabUrl, fullPage, path, format, quality params', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_take_screenshot')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('tabUrl');
    expect(props).toHaveProperty('fullPage');
    expect(props).toHaveProperty('path');
    expect(props).toHaveProperty('format');
    expect(props).toHaveProperty('quality');
  });

  it('has no required fields (can screenshot active window without tabUrl)', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_take_screenshot')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toHaveLength(0);
  });

  it('format enum includes png and jpeg', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_take_screenshot')!;
    const props = (def.inputSchema as any).properties;
    expect(props.format.enum).toContain('png');
    expect(props.format.enum).toContain('jpeg');
  });

  it('handler is registered', () => {
    expect(tools.getHandler('safari_take_screenshot')).toBeDefined();
  });
});

// ── safari_get_console_messages ───────────────────────────────────────────────

describe('safari_get_console_messages', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_get_console_messages')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
  });

  it('returns captured console messages', async () => {
    const consoleData = {
      messages: [
        { level: 'log', text: 'Hello from console', timestamp: 1000 },
        { level: 'error', text: 'Something went wrong', timestamp: 2000 },
      ],
      count: 2,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(consoleData)));

    const handler = tools.getHandler('safari_get_console_messages')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.messages).toHaveLength(2);
    expect(data.count).toBe(2);
    expect(data.messages[0].level).toBe('log');
    expect(data.messages[1].level).toBe('error');
  });

  it('returns empty messages list on new page (no console yet)', async () => {
    const consoleData = { messages: [], count: 0 };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(consoleData)));

    const handler = tools.getHandler('safari_get_console_messages')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.messages).toHaveLength(0);
    expect(data.count).toBe(0);
  });

  it('schema has level, limit, and clear optional params', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_get_console_messages')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('level');
    expect(props).toHaveProperty('limit');
    expect(props).toHaveProperty('clear');
  });

  it('level enum includes all expected values', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_get_console_messages')!;
    const props = (def.inputSchema as any).properties;
    expect(props.level.enum).toContain('all');
    expect(props.level.enum).toContain('log');
    expect(props.level.enum).toContain('warn');
    expect(props.level.enum).toContain('error');
    expect(props.level.enum).toContain('info');
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Get console messages failed'));

    const handler = tools.getHandler('safari_get_console_messages')!;
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('Get console messages failed');
  });
});

// ── Metadata ─────────────────────────────────────────────────────────────────

describe('ToolResponse metadata', () => {
  it('includes engine, degraded, and latencyMs in metadata', async () => {
    const textData = { text: 'test', length: 4, truncated: false };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(textData)));

    const handler = tools.getHandler('safari_get_text')!;
    const result = await handler({ tabUrl: 'https://example.com' });

    expect(result.metadata.engine).toBe('applescript');
    expect(result.metadata.degraded).toBe(false);
    expect(typeof result.metadata.latencyMs).toBe('number');
  });
});
