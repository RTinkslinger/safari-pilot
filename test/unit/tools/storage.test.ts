import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StorageTools } from '../../../src/tools/storage.js';
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
let tools: StorageTools;

beforeEach(() => {
  mockEngine = makeEngine();
  tools = new StorageTools(mockEngine as any);
  vi.clearAllMocks();
});

// ── Tool definitions ──────────────────────────────────────────────────────────

describe('StorageTools - tool definitions', () => {
  it('registers 5 P0 storage tools', () => {
    const defs = tools.getDefinitions();
    expect(defs).toHaveLength(5);
    expect(defs.map(d => d.name)).toEqual([
      'safari_get_cookies',
      'safari_set_cookie',
      'safari_delete_cookie',
      'safari_storage_state_export',
      'safari_storage_state_import',
    ]);
  });

  const expectedTools = [
    'safari_get_cookies',
    'safari_set_cookie',
    'safari_delete_cookie',
    'safari_storage_state_export',
    'safari_storage_state_import',
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

// ── safari_get_cookies ────────────────────────────────────────────────────────

describe('safari_get_cookies', () => {
  it('schema has tabUrl and domain optional params', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_get_cookies')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('tabUrl');
    expect(props).toHaveProperty('domain');
  });

  it('returns cookies via document.cookie', async () => {
    const data = {
      cookies: [
        { name: 'session', value: 'abc123', domain: 'example.com', path: '/', httpOnly: false, secure: false, sameSite: 'lax' },
      ],
      count: 1,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_get_cookies')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.cookies).toHaveLength(1);
    expect(parsed.cookies[0].name).toBe('session');
    expect(parsed.count).toBe(1);
  });

  it('returns empty cookie list when no cookies', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ cookies: [], count: 0 })));

    const handler = tools.getHandler('safari_get_cookies')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.cookies).toHaveLength(0);
    expect(parsed.count).toBe(0);
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ cookies: [], count: 0 })));

    const handler = tools.getHandler('safari_get_cookies')!;
    await handler({ tabUrl: 'https://example.com' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Get cookies failed'));

    const handler = tools.getHandler('safari_get_cookies')!;
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('Get cookies failed');
  });

  it('cookie schema has name, value, domain, path, httpOnly, secure, sameSite', async () => {
    const data = {
      cookies: [{ name: 'sid', value: 'xyz', domain: 'example.com', path: '/', httpOnly: false, secure: true, sameSite: 'lax' }],
      count: 1,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_get_cookies')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);
    const cookie = parsed.cookies[0];

    expect(cookie).toHaveProperty('name');
    expect(cookie).toHaveProperty('value');
    expect(cookie).toHaveProperty('domain');
    expect(cookie).toHaveProperty('path');
    expect(cookie).toHaveProperty('httpOnly');
    expect(cookie).toHaveProperty('secure');
    expect(cookie).toHaveProperty('sameSite');
  });
});

// ── safari_set_cookie ─────────────────────────────────────────────────────────

describe('safari_set_cookie', () => {
  it('requires tabUrl, name, and value in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_set_cookie')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('name');
    expect(required).toContain('value');
  });

  it('schema has domain, path, expires, httpOnly, secure, sameSite optional params', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_set_cookie')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('domain');
    expect(props).toHaveProperty('path');
    expect(props).toHaveProperty('expires');
    expect(props).toHaveProperty('httpOnly');
    expect(props).toHaveProperty('secure');
    expect(props).toHaveProperty('sameSite');
  });

  it('returns set: true on success', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ set: true, name: 'session', cookie: 'session=abc123; path=/' })));

    const handler = tools.getHandler('safari_set_cookie')!;
    const result = await handler({ tabUrl: 'https://example.com', name: 'session', value: 'abc123' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.set).toBe(true);
    expect(parsed.name).toBe('session');
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ set: true, name: 'x', cookie: 'x=y; path=/' })));

    const handler = tools.getHandler('safari_set_cookie')!;
    await handler({ tabUrl: 'https://example.com', name: 'x', value: 'y' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Set cookie failed'));

    const handler = tools.getHandler('safari_set_cookie')!;
    await expect(handler({ tabUrl: 'https://example.com', name: 'x', value: 'y' })).rejects.toThrow('Set cookie failed');
  });

  it('sameSite enum includes strict, lax, none', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_set_cookie')!;
    const sameSiteEnum = (def.inputSchema as any).properties.sameSite.enum;
    expect(sameSiteEnum).toContain('strict');
    expect(sameSiteEnum).toContain('lax');
    expect(sameSiteEnum).toContain('none');
  });
});

// ── safari_delete_cookie ──────────────────────────────────────────────────────

describe('safari_delete_cookie', () => {
  it('requires tabUrl and name in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_delete_cookie')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('name');
  });

  it('schema has domain and path optional params', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_delete_cookie')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('domain');
    expect(props).toHaveProperty('path');
  });

  it('returns deleted: true when cookie was found and removed', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ deleted: true, existed: true, name: 'session' })));

    const handler = tools.getHandler('safari_delete_cookie')!;
    const result = await handler({ tabUrl: 'https://example.com', name: 'session' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.deleted).toBe(true);
    expect(parsed.existed).toBe(true);
    expect(parsed.name).toBe('session');
  });

  it('returns existed: false when cookie did not exist', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ deleted: false, existed: false, name: 'ghost' })));

    const handler = tools.getHandler('safari_delete_cookie')!;
    const result = await handler({ tabUrl: 'https://example.com', name: 'ghost' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.existed).toBe(false);
    expect(parsed.deleted).toBe(false);
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ deleted: true, existed: true, name: 'x' })));

    const handler = tools.getHandler('safari_delete_cookie')!;
    await handler({ tabUrl: 'https://example.com', name: 'x' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Delete cookie failed'));

    const handler = tools.getHandler('safari_delete_cookie')!;
    await expect(handler({ tabUrl: 'https://example.com', name: 'x' })).rejects.toThrow('Delete cookie failed');
  });
});

// ── safari_storage_state_export ───────────────────────────────────────────────

describe('safari_storage_state_export', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_storage_state_export')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
  });

  it('exports cookies + localStorage + sessionStorage', async () => {
    const data = {
      state: {
        url: 'https://example.com',
        cookies: [{ name: 'sid', value: 'x' }],
        localStorage: { key: 'value' },
        sessionStorage: {},
        exportedAt: new Date().toISOString(),
      },
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_storage_state_export')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.state.cookies).toHaveLength(1);
    expect(parsed.state.localStorage.key).toBe('value');
    expect(parsed.state.sessionStorage).toEqual({});
    expect(parsed.state.exportedAt).toBeDefined();
  });

  it('state includes url field', async () => {
    const data = {
      state: {
        url: 'https://example.com/dashboard',
        cookies: [],
        localStorage: {},
        sessionStorage: {},
        exportedAt: new Date().toISOString(),
      },
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_storage_state_export')!;
    const result = await handler({ tabUrl: 'https://example.com/dashboard' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.state.url).toBe('https://example.com/dashboard');
  });

  it('passes tabUrl to engine', async () => {
    const data = { state: { url: '', cookies: [], localStorage: {}, sessionStorage: {}, exportedAt: '' } };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_storage_state_export')!;
    await handler({ tabUrl: 'https://example.com' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Storage state export failed'));

    const handler = tools.getHandler('safari_storage_state_export')!;
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('Storage state export failed');
  });
});

// ── safari_storage_state_import ───────────────────────────────────────────────

describe('safari_storage_state_import', () => {
  it('requires tabUrl and state in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_storage_state_import')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('state');
  });

  it('returns import summary with counts', async () => {
    const data = {
      imported: { cookies: 2, localStorage: 3, sessionStorage: 1, errors: [] },
      success: true,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const stateToImport = {
      cookies: [{ name: 'sid', value: 'abc' }, { name: 'pref', value: 'dark' }],
      localStorage: { theme: 'dark', lang: 'en', lastVisit: '2026-01-01' },
      sessionStorage: { cart: '[]' },
    };

    const handler = tools.getHandler('safari_storage_state_import')!;
    const result = await handler({ tabUrl: 'https://example.com', state: stateToImport });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.success).toBe(true);
    expect(parsed.imported.cookies).toBe(2);
    expect(parsed.imported.localStorage).toBe(3);
    expect(parsed.imported.sessionStorage).toBe(1);
    expect(parsed.imported.errors).toHaveLength(0);
  });

  it('reports partial success when some imports fail', async () => {
    const data = {
      imported: { cookies: 1, localStorage: 0, sessionStorage: 0, errors: ['localStorage:SecurityError: Access denied'] },
      success: false,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_storage_state_import')!;
    const result = await handler({
      tabUrl: 'https://example.com',
      state: { cookies: [{ name: 'x', value: 'y' }], localStorage: { key: 'val' }, sessionStorage: {} },
    });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.success).toBe(false);
    expect(parsed.imported.errors).toHaveLength(1);
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ imported: { cookies: 0, localStorage: 0, sessionStorage: 0, errors: [] }, success: true })));

    const handler = tools.getHandler('safari_storage_state_import')!;
    await handler({ tabUrl: 'https://example.com', state: { cookies: [], localStorage: {}, sessionStorage: {} } });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Storage state import failed'));

    const handler = tools.getHandler('safari_storage_state_import')!;
    await expect(handler({ tabUrl: 'https://example.com', state: {} })).rejects.toThrow('Storage state import failed');
  });

  it('state schema has cookies, localStorage, sessionStorage', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_storage_state_import')!;
    const stateProps = (def.inputSchema as any).properties.state.properties;
    expect(stateProps).toHaveProperty('cookies');
    expect(stateProps).toHaveProperty('localStorage');
    expect(stateProps).toHaveProperty('sessionStorage');
  });
});

// ── ToolResponse metadata ─────────────────────────────────────────────────────

describe('ToolResponse metadata', () => {
  it('includes engine, degraded, and latencyMs in metadata', async () => {
    const data = { cookies: [], count: 0 };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_get_cookies')!;
    const result = await handler({ tabUrl: 'https://example.com' });

    expect(result.metadata.engine).toBe('applescript');
    expect(result.metadata.degraded).toBe(false);
    expect(typeof result.metadata.latencyMs).toBe('number');
  });

  it('content[0].type is "text"', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ cookies: [], count: 0 })));

    const handler = tools.getHandler('safari_get_cookies')!;
    const result = await handler({ tabUrl: 'https://example.com' });

    expect(result.content[0].type).toBe('text');
  });
});
