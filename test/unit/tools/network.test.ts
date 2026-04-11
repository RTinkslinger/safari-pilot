import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NetworkTools } from '../../../src/tools/network.js';
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
let tools: NetworkTools;

beforeEach(() => {
  mockEngine = makeEngine();
  tools = new NetworkTools(mockEngine as any);
  vi.clearAllMocks();
});

// ── Tool definitions ──────────────────────────────────────────────────────────

describe('NetworkTools - tool definitions', () => {
  it('registers 3 P0 network tools', () => {
    const defs = tools.getDefinitions();
    expect(defs).toHaveLength(3);
    expect(defs.map(d => d.name)).toEqual([
      'safari_list_network_requests',
      'safari_get_network_request',
      'safari_intercept_requests',
    ]);
  });

  const expectedTools = [
    'safari_list_network_requests',
    'safari_get_network_request',
    'safari_intercept_requests',
  ];

  for (const name of expectedTools) {
    it(`registers ${name}`, () => {
      const defs = tools.getDefinitions();
      expect(defs.find(d => d.name === name)).toBeDefined();
    });

    it(`getHandler returns function for ${name}`, () => {
      expect(tools.getHandler(name)).toBeTypeOf('function');
    });
  }

  it('all tool names have the "safari_" prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });

  it('returns undefined for unknown tool name', () => {
    expect(tools.getHandler('safari_nonexistent')).toBeUndefined();
  });
});

// ── safari_list_network_requests ──────────────────────────────────────────────

describe('safari_list_network_requests', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_list_network_requests')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
  });

  it('schema has filter and limit optional params', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_list_network_requests')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('filter');
    expect(props).toHaveProperty('limit');
  });

  it('returns captured requests from engine result', async () => {
    const data = {
      requests: [
        { url: 'https://api.example.com/data', method: 'GET', status: 200, type: 'fetch', timestamp: Date.now() },
      ],
      count: 1,
      total: 1,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_list_network_requests')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.requests).toHaveLength(1);
    expect(parsed.requests[0].method).toBe('GET');
    expect(parsed.count).toBe(1);
  });

  it('returns empty list when no requests', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ requests: [], count: 0, total: 0 })));

    const handler = tools.getHandler('safari_list_network_requests')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.requests).toHaveLength(0);
    expect(parsed.count).toBe(0);
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ requests: [], count: 0, total: 0 })));

    const handler = tools.getHandler('safari_list_network_requests')!;
    await handler({ tabUrl: 'https://example.com' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Network request failed'));

    const handler = tools.getHandler('safari_list_network_requests')!;
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('Network request failed');
  });

  it('filter subschema has type, status, urlPattern', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_list_network_requests')!;
    const filterProps = (def.inputSchema as any).properties.filter.properties;
    expect(filterProps).toHaveProperty('type');
    expect(filterProps).toHaveProperty('status');
    expect(filterProps).toHaveProperty('urlPattern');
  });

  it('filter.type enum includes expected resource types', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_list_network_requests')!;
    const typeEnum = (def.inputSchema as any).properties.filter.properties.type.enum;
    expect(typeEnum).toContain('fetch');
    expect(typeEnum).toContain('xmlhttprequest');
    expect(typeEnum).toContain('script');
  });
});

// ── safari_get_network_request ────────────────────────────────────────────────

describe('safari_get_network_request', () => {
  it('requires tabUrl and url in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_get_network_request')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('url');
  });

  it('schema has matchMode optional param', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_get_network_request')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('matchMode');
    expect(props.matchMode.enum).toContain('exact');
    expect(props.matchMode.enum).toContain('contains');
    expect(props.matchMode.enum).toContain('endsWith');
  });

  it('returns request details including timing', async () => {
    const data = {
      request: {
        url: 'https://api.example.com/data',
        method: 'GET',
        status: 200,
        type: 'fetch',
        timestamp: Date.now(),
        duration: 120,
        transferSize: 4096,
        encodedBodySize: 3800,
        timing: { dns: 1, connect: 5, ttfb: 80, download: 34 },
      },
      source: 'performance',
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_get_network_request')!;
    const result = await handler({ tabUrl: 'https://example.com', url: '/data' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.request.url).toBe('https://api.example.com/data');
    expect(parsed.request.timing.ttfb).toBe(80);
    expect(parsed.source).toBe('performance');
  });

  it('prefers interceptor source over performance', async () => {
    const data = {
      request: {
        url: 'https://api.example.com/data',
        method: 'POST',
        status: 201,
        type: 'fetch',
        timestamp: Date.now(),
        requestBody: '{"key":"value"}',
      },
      source: 'interceptor',
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_get_network_request')!;
    const result = await handler({ tabUrl: 'https://example.com', url: '/data' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.source).toBe('interceptor');
    expect(parsed.request.method).toBe('POST');
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Network request not found: /missing'));

    const handler = tools.getHandler('safari_get_network_request')!;
    await expect(handler({ tabUrl: 'https://example.com', url: '/missing' })).rejects.toThrow('not found');
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ request: {}, source: 'performance' })));

    const handler = tools.getHandler('safari_get_network_request')!;
    await handler({ tabUrl: 'https://example.com', url: '/api' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });
});

// ── safari_intercept_requests ─────────────────────────────────────────────────

describe('safari_intercept_requests', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_intercept_requests')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
  });

  it('schema has urlPattern, captureBody, maxEntries optional params', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_intercept_requests')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('urlPattern');
    expect(props).toHaveProperty('captureBody');
    expect(props).toHaveProperty('maxEntries');
  });

  it('returns installed status on first call', async () => {
    const data = { status: 'installed', urlPattern: null, captureBody: false, maxEntries: 200 };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_intercept_requests')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.status).toBe('installed');
  });

  it('returns already_installed status on repeat call', async () => {
    const data = { status: 'already_installed', buffered: 5 };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_intercept_requests')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.status).toBe('already_installed');
    expect(parsed.buffered).toBe(5);
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ status: 'installed' })));

    const handler = tools.getHandler('safari_intercept_requests')!;
    await handler({ tabUrl: 'https://example.com' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Intercept failed'));

    const handler = tools.getHandler('safari_intercept_requests')!;
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('Intercept failed');
  });
});

// ── ToolResponse metadata ─────────────────────────────────────────────────────

describe('ToolResponse metadata', () => {
  it('includes engine, degraded, and latencyMs in metadata', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ requests: [], count: 0, total: 0 })));

    const handler = tools.getHandler('safari_list_network_requests')!;
    const result = await handler({ tabUrl: 'https://example.com' });

    expect(result.metadata.engine).toBe('applescript');
    expect(result.metadata.degraded).toBe(false);
    expect(typeof result.metadata.latencyMs).toBe('number');
  });

  it('content[0].type is "text"', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ requests: [], count: 0, total: 0 })));

    const handler = tools.getHandler('safari_list_network_requests')!;
    const result = await handler({ tabUrl: 'https://example.com' });

    expect(result.content[0].type).toBe('text');
  });
});
