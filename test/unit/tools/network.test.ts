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
  it('registers 8 network tools (3 P0 + 5 P1)', () => {
    const defs = tools.getDefinitions();
    expect(defs).toHaveLength(8);
    expect(defs.map(d => d.name)).toEqual([
      'safari_list_network_requests',
      'safari_get_network_request',
      'safari_intercept_requests',
      'safari_network_throttle',
      'safari_network_offline',
      'safari_mock_request',
      'safari_websocket_listen',
      'safari_websocket_filter',
    ]);
  });

  const expectedTools = [
    'safari_list_network_requests',
    'safari_get_network_request',
    'safari_intercept_requests',
    'safari_network_throttle',
    'safari_network_offline',
    'safari_mock_request',
    'safari_websocket_listen',
    'safari_websocket_filter',
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

// ── safari_network_throttle ───────────────────────────────────────────────────

describe('safari_network_throttle', () => {
  it('requires tabUrl and latencyMs in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_network_throttle')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('latencyMs');
  });

  it('schema has optional downloadKbps param', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_network_throttle')!;
    expect((def.inputSchema as any).properties).toHaveProperty('downloadKbps');
  });

  it('has requiresNetworkIntercept requirement', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_network_throttle')!;
    expect(def.requirements.requiresNetworkIntercept).toBe(true);
  });

  it('returns enabled status on install', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ status: 'enabled', latencyMs: 500, downloadKbps: null })));

    const handler = tools.getHandler('safari_network_throttle')!;
    const result = await handler({ tabUrl: 'https://example.com', latencyMs: 500 });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.status).toBe('enabled');
    expect(parsed.latencyMs).toBe(500);
  });

  it('returns disabled status when latencyMs is 0', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ status: 'disabled', latencyMs: 0, downloadKbps: null })));

    const handler = tools.getHandler('safari_network_throttle')!;
    const result = await handler({ tabUrl: 'https://example.com', latencyMs: 0 });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.status).toBe('disabled');
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ status: 'enabled', latencyMs: 100, downloadKbps: null })));

    const handler = tools.getHandler('safari_network_throttle')!;
    await handler({ tabUrl: 'https://example.com', latencyMs: 100 });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Network throttle failed'));

    const handler = tools.getHandler('safari_network_throttle')!;
    await expect(handler({ tabUrl: 'https://example.com', latencyMs: 200 })).rejects.toThrow('Network throttle failed');
  });
});

// ── safari_network_offline ────────────────────────────────────────────────────

describe('safari_network_offline', () => {
  it('requires tabUrl and offline in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_network_offline')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('offline');
  });

  it('returns offline: true when going offline', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ offline: true })));

    const handler = tools.getHandler('safari_network_offline')!;
    const result = await handler({ tabUrl: 'https://example.com', offline: true });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.offline).toBe(true);
  });

  it('returns offline: false when restoring connectivity', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ offline: false })));

    const handler = tools.getHandler('safari_network_offline')!;
    const result = await handler({ tabUrl: 'https://example.com', offline: false });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.offline).toBe(false);
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ offline: true })));

    const handler = tools.getHandler('safari_network_offline')!;
    await handler({ tabUrl: 'https://example.com', offline: true });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Offline failed'));

    const handler = tools.getHandler('safari_network_offline')!;
    await expect(handler({ tabUrl: 'https://example.com', offline: true })).rejects.toThrow('Offline failed');
  });
});

// ── safari_mock_request ───────────────────────────────────────────────────────

describe('safari_mock_request', () => {
  it('requires tabUrl and urlPattern in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_mock_request')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('urlPattern');
  });

  it('schema has optional response param with status, body, headers', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_mock_request')!;
    const responseProps = (def.inputSchema as any).properties.response.properties;
    expect(responseProps).toHaveProperty('status');
    expect(responseProps).toHaveProperty('body');
    expect(responseProps).toHaveProperty('headers');
  });

  it('returns installed status with mock info', async () => {
    const data = { status: 'installed', urlPattern: '/api/users', response: { status: 200, body: '[]', headers: {} }, totalMocks: 1 };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_mock_request')!;
    const result = await handler({
      tabUrl: 'https://example.com',
      urlPattern: '/api/users',
      response: { status: 200, body: '[]', headers: {} },
    });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.status).toBe('installed');
    expect(parsed.urlPattern).toBe('/api/users');
    expect(parsed.totalMocks).toBe(1);
  });

  it('returns removed status when no response provided', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ status: 'removed', urlPattern: '/api/users' })));

    const handler = tools.getHandler('safari_mock_request')!;
    const result = await handler({ tabUrl: 'https://example.com', urlPattern: '/api/users' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.status).toBe('removed');
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ status: 'installed', urlPattern: '/api', totalMocks: 1 })));

    const handler = tools.getHandler('safari_mock_request')!;
    await handler({ tabUrl: 'https://example.com', urlPattern: '/api', response: { status: 404, body: '' } });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Mock request failed'));

    const handler = tools.getHandler('safari_mock_request')!;
    await expect(handler({ tabUrl: 'https://example.com', urlPattern: '/api' })).rejects.toThrow('Mock request failed');
  });
});

// ── safari_websocket_listen ───────────────────────────────────────────────────

describe('safari_websocket_listen', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_websocket_listen')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
  });

  it('schema has optional urlPattern param', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_websocket_listen')!;
    expect((def.inputSchema as any).properties).toHaveProperty('urlPattern');
  });

  it('has requiresNetworkIntercept requirement', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_websocket_listen')!;
    expect(def.requirements.requiresNetworkIntercept).toBe(true);
  });

  it('returns installed status on first call', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ status: 'installed', urlPattern: null })));

    const handler = tools.getHandler('safari_websocket_listen')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.status).toBe('installed');
  });

  it('returns already_installed status on repeat call', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ status: 'already_installed', buffered: 3 })));

    const handler = tools.getHandler('safari_websocket_listen')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.status).toBe('already_installed');
    expect(parsed.buffered).toBe(3);
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ status: 'installed', urlPattern: null })));

    const handler = tools.getHandler('safari_websocket_listen')!;
    await handler({ tabUrl: 'https://example.com' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('WebSocket listen failed'));

    const handler = tools.getHandler('safari_websocket_listen')!;
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('WebSocket listen failed');
  });
});

// ── safari_websocket_filter ───────────────────────────────────────────────────

describe('safari_websocket_filter', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_websocket_filter')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
  });

  it('schema has optional pattern and direction params', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_websocket_filter')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('pattern');
    expect(props).toHaveProperty('direction');
  });

  it('direction enum has sent, received, both', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_websocket_filter')!;
    const dirEnum = (def.inputSchema as any).properties.direction.enum;
    expect(dirEnum).toContain('sent');
    expect(dirEnum).toContain('received');
    expect(dirEnum).toContain('both');
  });

  it('returns filtered messages', async () => {
    const data = {
      messages: [
        { direction: 'received', data: '{"type":"ping"}', timestamp: Date.now(), url: 'wss://example.com/ws' },
      ],
      count: 1,
      total: 3,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_websocket_filter')!;
    const result = await handler({ tabUrl: 'https://example.com', direction: 'received' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].direction).toBe('received');
    expect(parsed.count).toBe(1);
    expect(parsed.total).toBe(3);
  });

  it('returns error note when listener not installed', async () => {
    const data = { messages: [], count: 0, error: 'WebSocket listener not installed. Call safari_websocket_listen first.' };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_websocket_filter')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.messages).toHaveLength(0);
    expect(parsed.error).toBeDefined();
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ messages: [], count: 0, total: 0 })));

    const handler = tools.getHandler('safari_websocket_filter')!;
    await handler({ tabUrl: 'https://example.com' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('WebSocket filter failed'));

    const handler = tools.getHandler('safari_websocket_filter')!;
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('WebSocket filter failed');
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
