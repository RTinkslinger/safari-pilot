import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PermissionTools } from '../../../src/tools/permissions.js';
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
let tools: PermissionTools;

beforeEach(() => {
  mockEngine = makeEngine();
  tools = new PermissionTools(mockEngine as any);
  vi.clearAllMocks();
});

// ── Tool definitions ──────────────────────────────────────────────────────────

describe('PermissionTools - tool definitions', () => {
  it('registers 6 permission tools', () => {
    expect(tools.getDefinitions()).toHaveLength(6);
  });

  const expectedTools = [
    'safari_permission_get',
    'safari_permission_set',
    'safari_override_geolocation',
    'safari_override_timezone',
    'safari_override_locale',
    'safari_override_useragent',
  ];

  for (const name of expectedTools) {
    it(`registers ${name}`, () => {
      expect(tools.getDefinitions().find((d) => d.name === name)).toBeDefined();
    });
  }

  it('all tool names have the "safari_" prefix', () => {
    for (const def of tools.getDefinitions()) {
      expect(def.name).toMatch(/^safari_/);
    }
  });
});

// ── safari_permission_get ─────────────────────────────────────────────────────

describe('safari_permission_get', () => {
  it('requires tabUrl and permission', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_permission_get')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('permission');
  });

  it('returns granted state for geolocation', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ permission: 'geolocation', state: 'granted' })),
    );

    const handler = tools.getHandler('safari_permission_get')!;
    const result = await handler({ tabUrl: 'https://example.com', permission: 'geolocation' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.permission).toBe('geolocation');
    expect(data.state).toBe('granted');
  });

  it('returns prompt state when permission not yet decided', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ permission: 'notifications', state: 'prompt' })),
    );

    const handler = tools.getHandler('safari_permission_get')!;
    const result = await handler({ tabUrl: 'https://example.com', permission: 'notifications' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.state).toBe('prompt');
  });

  it('handles unsupported Permissions API gracefully', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ permission: 'geolocation', state: 'unsupported', error: 'Permissions API not available' })),
    );

    const handler = tools.getHandler('safari_permission_get')!;
    const result = await handler({ tabUrl: 'https://example.com', permission: 'geolocation' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.state).toBe('unsupported');
    expect(data.error).toBeDefined();
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Tab not found'));

    const handler = tools.getHandler('safari_permission_get')!;
    await expect(
      handler({ tabUrl: 'https://example.com', permission: 'geolocation' }),
    ).rejects.toThrow('Tab not found');
  });
});

// ── safari_permission_set ─────────────────────────────────────────────────────

describe('safari_permission_set', () => {
  it('requires tabUrl, permission, and state', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_permission_set')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('permission');
    expect(required).toContain('state');
  });

  it('returns supported: false with Safari guidance (no engine call)', async () => {
    const handler = tools.getHandler('safari_permission_set')!;
    const result = await handler({
      tabUrl: 'https://example.com',
      permission: 'notifications',
      state: 'granted',
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.supported).toBe(false);
    expect(data.permission).toBe('notifications');
    expect(data.requestedState).toBe('granted');
    expect(data.message).toContain('Safari');
    expect(Array.isArray(data.alternatives)).toBe(true);
    // Engine should NOT be called — Safari can't set permissions programmatically
    expect(mockEngine.executeJsInTab).not.toHaveBeenCalled();
  });

  it('includes alternatives list with at least one entry', async () => {
    const handler = tools.getHandler('safari_permission_set')!;
    const result = await handler({
      tabUrl: 'https://example.com',
      permission: 'geolocation',
      state: 'denied',
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.alternatives.length).toBeGreaterThan(0);
  });
});

// ── safari_override_geolocation ───────────────────────────────────────────────

describe('safari_override_geolocation', () => {
  it('requires tabUrl, latitude, and longitude', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_override_geolocation')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('latitude');
    expect(required).toContain('longitude');
  });

  it('patches geolocation and returns overridden position', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(
        JSON.stringify({
          overridden: true,
          position: { latitude: 37.7749, longitude: -122.4194, accuracy: 10 },
        }),
      ),
    );

    const handler = tools.getHandler('safari_override_geolocation')!;
    const result = await handler({
      tabUrl: 'https://example.com',
      latitude: 37.7749,
      longitude: -122.4194,
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.overridden).toBe(true);
    expect(data.position.latitude).toBe(37.7749);
    expect(data.position.longitude).toBe(-122.4194);
    expect(data.position.accuracy).toBe(10);
  });

  it('uses custom accuracy when provided', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ overridden: true, position: { latitude: 51.5, longitude: -0.1, accuracy: 50 } })),
    );

    const handler = tools.getHandler('safari_override_geolocation')!;
    await handler({ tabUrl: 'https://example.com', latitude: 51.5, longitude: -0.1, accuracy: 50 });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith(
      'https://example.com',
      expect.stringContaining('50'),
    );
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Geolocation override failed'));

    const handler = tools.getHandler('safari_override_geolocation')!;
    await expect(
      handler({ tabUrl: 'https://example.com', latitude: 0, longitude: 0 }),
    ).rejects.toThrow('Geolocation override failed');
  });
});

// ── safari_override_timezone ──────────────────────────────────────────────────

describe('safari_override_timezone', () => {
  it('requires tabUrl and timezone', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_override_timezone')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('timezone');
  });

  it('patches Intl.DateTimeFormat and returns overridden timezone', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ overridden: true, timezone: 'America/New_York' })),
    );

    const handler = tools.getHandler('safari_override_timezone')!;
    const result = await handler({ tabUrl: 'https://example.com', timezone: 'America/New_York' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.overridden).toBe(true);
    expect(data.timezone).toBe('America/New_York');
  });

  it('passes timezone to JS executed in tab', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ overridden: true, timezone: 'Asia/Tokyo' })),
    );

    const handler = tools.getHandler('safari_override_timezone')!;
    await handler({ tabUrl: 'https://example.com', timezone: 'Asia/Tokyo' });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith(
      'https://example.com',
      expect.stringContaining('Asia/Tokyo'),
    );
  });
});

// ── safari_override_locale ────────────────────────────────────────────────────

describe('safari_override_locale', () => {
  it('requires tabUrl and locale', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_override_locale')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('locale');
  });

  it('patches navigator.language and returns overridden locale', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ overridden: true, locale: 'fr-FR' })),
    );

    const handler = tools.getHandler('safari_override_locale')!;
    const result = await handler({ tabUrl: 'https://example.com', locale: 'fr-FR' });
    const data = JSON.parse(result.content[0].text!);

    expect(data.overridden).toBe(true);
    expect(data.locale).toBe('fr-FR');
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('Locale override failed'));

    const handler = tools.getHandler('safari_override_locale')!;
    await expect(
      handler({ tabUrl: 'https://example.com', locale: 'de-DE' }),
    ).rejects.toThrow('Locale override failed');
  });
});

// ── safari_override_useragent ─────────────────────────────────────────────────

describe('safari_override_useragent', () => {
  it('requires tabUrl and userAgent', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_override_useragent')!;
    const required = (def.inputSchema as { required: string[] }).required;
    expect(required).toContain('tabUrl');
    expect(required).toContain('userAgent');
  });

  it('patches navigator.userAgent and returns overridden value', async () => {
    const chromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ overridden: true, userAgent: chromeUA })),
    );

    const handler = tools.getHandler('safari_override_useragent')!;
    const result = await handler({ tabUrl: 'https://example.com', userAgent: chromeUA });
    const data = JSON.parse(result.content[0].text!);

    expect(data.overridden).toBe(true);
    expect(data.userAgent).toBe(chromeUA);
  });

  it('passes userAgent string to JS executed in tab', async () => {
    const mobileUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';
    mockEngine.executeJsInTab.mockResolvedValue(
      okResult(JSON.stringify({ overridden: true, userAgent: mobileUA })),
    );

    const handler = tools.getHandler('safari_override_useragent')!;
    await handler({ tabUrl: 'https://example.com', userAgent: mobileUA });

    expect(mockEngine.executeJsInTab).toHaveBeenCalledWith(
      'https://example.com',
      expect.stringContaining('iPhone'),
    );
  });

  it('throws when engine returns error', async () => {
    mockEngine.executeJsInTab.mockResolvedValue(errResult('User-Agent override failed'));

    const handler = tools.getHandler('safari_override_useragent')!;
    await expect(
      handler({ tabUrl: 'https://example.com', userAgent: 'Mozilla/5.0' }),
    ).rejects.toThrow('User-Agent override failed');
  });
});

// ── getHandler ────────────────────────────────────────────────────────────────

describe('getHandler', () => {
  it('returns undefined for unknown tool name', () => {
    expect(tools.getHandler('safari_nonexistent')).toBeUndefined();
  });

  it('returns a function for every registered tool', () => {
    for (const def of tools.getDefinitions()) {
      const handler = tools.getHandler(def.name);
      expect(typeof handler).toBe('function');
    }
  });
});
