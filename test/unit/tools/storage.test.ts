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
  it('registers 11 storage tools (5 P0 + 6 P1)', () => {
    const defs = tools.getDefinitions();
    expect(defs).toHaveLength(11);
    expect(defs.map(d => d.name)).toEqual([
      'safari_get_cookies',
      'safari_set_cookie',
      'safari_delete_cookie',
      'safari_storage_state_export',
      'safari_storage_state_import',
      'safari_local_storage_get',
      'safari_local_storage_set',
      'safari_session_storage_get',
      'safari_session_storage_set',
      'safari_idb_list',
      'safari_idb_get',
    ]);
  });

  const expectedTools = [
    'safari_get_cookies',
    'safari_set_cookie',
    'safari_delete_cookie',
    'safari_storage_state_export',
    'safari_storage_state_import',
    'safari_local_storage_get',
    'safari_local_storage_set',
    'safari_session_storage_get',
    'safari_session_storage_set',
    'safari_idb_list',
    'safari_idb_get',
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

// ── safari_local_storage_get ──────────────────────────────────────────────────

describe('safari_local_storage_get', () => {
  it('requires tabUrl and key in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_local_storage_get')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('key');
  });

  it('returns key, value, exists when item found', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ key: 'theme', value: 'dark', exists: true })));

    const handler = tools.getHandler('safari_local_storage_get')!;
    const result = await handler({ tabUrl: 'https://example.com', key: 'theme' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.key).toBe('theme');
    expect(parsed.value).toBe('dark');
    expect(parsed.exists).toBe(true);
  });

  it('returns exists: false when key not found', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ key: 'missing', value: null, exists: false })));

    const handler = tools.getHandler('safari_local_storage_get')!;
    const result = await handler({ tabUrl: 'https://example.com', key: 'missing' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.exists).toBe(false);
    expect(parsed.value).toBeNull();
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ key: 'k', value: 'v', exists: true })));

    const handler = tools.getHandler('safari_local_storage_get')!;
    await handler({ tabUrl: 'https://example.com', key: 'k' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('localStorage not available'));

    const handler = tools.getHandler('safari_local_storage_get')!;
    await expect(handler({ tabUrl: 'https://example.com', key: 'k' })).rejects.toThrow('localStorage not available');
  });
});

// ── safari_local_storage_set ──────────────────────────────────────────────────

describe('safari_local_storage_set', () => {
  it('requires tabUrl, key, and value in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_local_storage_set')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('key');
    expect(required).toContain('value');
  });

  it('returns set: true on success', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ key: 'theme', value: 'dark', set: true })));

    const handler = tools.getHandler('safari_local_storage_set')!;
    const result = await handler({ tabUrl: 'https://example.com', key: 'theme', value: 'dark' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.set).toBe(true);
    expect(parsed.key).toBe('theme');
    expect(parsed.value).toBe('dark');
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ key: 'k', value: 'v', set: true })));

    const handler = tools.getHandler('safari_local_storage_set')!;
    await handler({ tabUrl: 'https://example.com', key: 'k', value: 'v' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('localStorage set failed'));

    const handler = tools.getHandler('safari_local_storage_set')!;
    await expect(handler({ tabUrl: 'https://example.com', key: 'k', value: 'v' })).rejects.toThrow('localStorage set failed');
  });
});

// ── safari_session_storage_get ────────────────────────────────────────────────

describe('safari_session_storage_get', () => {
  it('requires tabUrl and key in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_session_storage_get')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('key');
  });

  it('returns key, value, exists when item found', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ key: 'cart', value: '[]', exists: true })));

    const handler = tools.getHandler('safari_session_storage_get')!;
    const result = await handler({ tabUrl: 'https://example.com', key: 'cart' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.key).toBe('cart');
    expect(parsed.value).toBe('[]');
    expect(parsed.exists).toBe(true);
  });

  it('returns exists: false when key not found', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ key: 'nope', value: null, exists: false })));

    const handler = tools.getHandler('safari_session_storage_get')!;
    const result = await handler({ tabUrl: 'https://example.com', key: 'nope' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.exists).toBe(false);
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ key: 'k', value: null, exists: false })));

    const handler = tools.getHandler('safari_session_storage_get')!;
    await handler({ tabUrl: 'https://example.com', key: 'k' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('sessionStorage not available'));

    const handler = tools.getHandler('safari_session_storage_get')!;
    await expect(handler({ tabUrl: 'https://example.com', key: 'k' })).rejects.toThrow('sessionStorage not available');
  });
});

// ── safari_session_storage_set ────────────────────────────────────────────────

describe('safari_session_storage_set', () => {
  it('requires tabUrl, key, and value in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_session_storage_set')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('key');
    expect(required).toContain('value');
  });

  it('returns set: true on success', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ key: 'cart', value: '[1,2]', set: true })));

    const handler = tools.getHandler('safari_session_storage_set')!;
    const result = await handler({ tabUrl: 'https://example.com', key: 'cart', value: '[1,2]' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.set).toBe(true);
    expect(parsed.key).toBe('cart');
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ key: 'k', value: 'v', set: true })));

    const handler = tools.getHandler('safari_session_storage_set')!;
    await handler({ tabUrl: 'https://example.com', key: 'k', value: 'v' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('sessionStorage set failed'));

    const handler = tools.getHandler('safari_session_storage_set')!;
    await expect(handler({ tabUrl: 'https://example.com', key: 'k', value: 'v' })).rejects.toThrow('sessionStorage set failed');
  });
});

// ── safari_idb_list ───────────────────────────────────────────────────────────

describe('safari_idb_list', () => {
  it('requires tabUrl in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_idb_list')!;
    expect((def.inputSchema as { required: string[] }).required).toContain('tabUrl');
  });

  it('returns list of databases with name and version', async () => {
    const data = {
      databases: [{ name: 'mydb', version: 1 }, { name: 'cache', version: 2 }],
      count: 2,
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_idb_list')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.databases).toHaveLength(2);
    expect(parsed.databases[0].name).toBe('mydb');
    expect(parsed.databases[1].version).toBe(2);
    expect(parsed.count).toBe(2);
  });

  it('returns empty list when no databases', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ databases: [], count: 0 })));

    const handler = tools.getHandler('safari_idb_list')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.databases).toHaveLength(0);
    expect(parsed.count).toBe(0);
  });

  it('returns note when indexedDB.databases() not supported', async () => {
    const data = { databases: [], count: 0, note: 'indexedDB.databases() not supported in this context' };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_idb_list')!;
    const result = await handler({ tabUrl: 'https://example.com' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.note).toBeDefined();
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ databases: [], count: 0 })));

    const handler = tools.getHandler('safari_idb_list')!;
    await handler({ tabUrl: 'https://example.com' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('IndexedDB list failed'));

    const handler = tools.getHandler('safari_idb_list')!;
    await expect(handler({ tabUrl: 'https://example.com' })).rejects.toThrow('IndexedDB list failed');
  });
});

// ── safari_idb_get ────────────────────────────────────────────────────────────

describe('safari_idb_get', () => {
  it('requires tabUrl, database, and store in schema', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_idb_get')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('database');
    expect(required).toContain('store');
  });

  it('schema has optional query and limit params', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_idb_get')!;
    const props = (def.inputSchema as any).properties;
    expect(props).toHaveProperty('query');
    expect(props).toHaveProperty('limit');
  });

  it('query schema has lower, upper, lowerOpen, upperOpen, only', () => {
    const def = tools.getDefinitions().find(d => d.name === 'safari_idb_get')!;
    const queryProps = (def.inputSchema as any).properties.query.properties;
    expect(queryProps).toHaveProperty('lower');
    expect(queryProps).toHaveProperty('upper');
    expect(queryProps).toHaveProperty('lowerOpen');
    expect(queryProps).toHaveProperty('upperOpen');
    expect(queryProps).toHaveProperty('only');
  });

  it('returns records from the store', async () => {
    const data = {
      records: [
        { key: 1, value: { id: 1, name: 'Alice' } },
        { key: 2, value: { id: 2, name: 'Bob' } },
      ],
      count: 2,
      database: 'mydb',
      store: 'users',
    };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_idb_get')!;
    const result = await handler({ tabUrl: 'https://example.com', database: 'mydb', store: 'users' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].key).toBe(1);
    expect(parsed.records[0].value.name).toBe('Alice');
    expect(parsed.count).toBe(2);
    expect(parsed.database).toBe('mydb');
    expect(parsed.store).toBe('users');
  });

  it('returns empty records when store is empty', async () => {
    const data = { records: [], count: 0, database: 'mydb', store: 'users' };
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify(data)));

    const handler = tools.getHandler('safari_idb_get')!;
    const result = await handler({ tabUrl: 'https://example.com', database: 'mydb', store: 'users' });
    const parsed = JSON.parse(result.content[0].text!);

    expect(parsed.records).toHaveLength(0);
  });

  it('passes tabUrl to engine', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(okResult(JSON.stringify({ records: [], count: 0, database: 'db', store: 's' })));

    const handler = tools.getHandler('safari_idb_get')!;
    await handler({ tabUrl: 'https://example.com', database: 'db', store: 's' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith('https://example.com', expect.any(String));
  });

  it('throws when engine returns error (database not found)', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Failed to open database: mydb'));

    const handler = tools.getHandler('safari_idb_get')!;
    await expect(handler({ tabUrl: 'https://example.com', database: 'mydb', store: 'users' })).rejects.toThrow('Failed to open database');
  });

  it('throws when engine returns error (store not found)', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Object store not found: missing'));

    const handler = tools.getHandler('safari_idb_get')!;
    await expect(handler({ tabUrl: 'https://example.com', database: 'mydb', store: 'missing' })).rejects.toThrow('Object store not found');
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
