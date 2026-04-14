import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DownloadTools } from '../../../src/tools/downloads.js';
import type { SafariPilotServer } from '../../../src/server.js';
import type { ClickContext, EngineResult } from '../../../src/types.js';

// ── Mock factories ────────────────────────────────────────────────────────────

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
      : vi.fn().mockResolvedValue({ ok: false, error: { code: 'UNAVAILABLE', message: 'mock', retryable: false }, elapsed_ms: 1 }),
    isAvailable: vi.fn().mockResolvedValue(false),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function makeServer(overrides: {
  clickContext?: ClickContext | null;
  daemonEngine?: ReturnType<typeof makeDaemonEngine> | null;
  appleScriptEngine?: ReturnType<typeof makeAppleScriptEngine> | null;
} = {}): SafariPilotServer {
  const clickContext = overrides.clickContext !== undefined ? overrides.clickContext : null;
  return {
    consumeClickContext: vi.fn().mockReturnValue(clickContext),
    setClickContext: vi.fn(),
    getDaemonEngine: vi.fn().mockReturnValue(overrides.daemonEngine ?? null),
    getEngine: vi.fn().mockReturnValue(overrides.appleScriptEngine ?? null),
  } as unknown as SafariPilotServer;
}

// ── Tool definition tests ─────────────────────────────────────────────────────

describe('DownloadTools - getDefinitions()', () => {
  let tools: DownloadTools;

  beforeEach(() => {
    tools = new DownloadTools(makeServer());
  });

  it('returns exactly 1 tool', () => {
    expect(tools.getDefinitions()).toHaveLength(1);
  });

  it('tool name is safari_wait_for_download', () => {
    expect(tools.getDefinitions()[0].name).toBe('safari_wait_for_download');
  });

  it('input schema has timeout property', () => {
    const schema = tools.getDefinitions()[0].inputSchema as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    expect(props).toHaveProperty('timeout');
  });

  it('input schema has filenamePattern property', () => {
    const schema = tools.getDefinitions()[0].inputSchema as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    expect(props).toHaveProperty('filenamePattern');
  });

  it('input schema has tabUrl property', () => {
    const schema = tools.getDefinitions()[0].inputSchema as Record<string, unknown>;
    const props = schema['properties'] as Record<string, unknown>;
    expect(props).toHaveProperty('tabUrl');
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

// ── getHandler() tests ────────────────────────────────────────────────────────

describe('DownloadTools - getHandler()', () => {
  let tools: DownloadTools;

  beforeEach(() => {
    tools = new DownloadTools(makeServer());
  });

  it('returns a defined handler for safari_wait_for_download', () => {
    const handler = tools.getHandler('safari_wait_for_download');
    expect(handler).toBeDefined();
    expect(typeof handler).toBe('function');
  });

  it('returns undefined for an unknown tool name', () => {
    expect(tools.getHandler('unknown_tool')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(tools.getHandler('')).toBeUndefined();
  });
});

// ── Click context consumption ─────────────────────────────────────────────────

describe('DownloadTools - click context consumption', () => {
  it('calls consumeClickContext() on the server when handler is invoked', async () => {
    const server = makeServer({ daemonEngine: null, appleScriptEngine: null });
    const tools = new DownloadTools(server);
    const handler = tools.getHandler('safari_wait_for_download')!;

    // Use a very short timeout so the test doesn't hang
    await handler({ timeout: 100 });

    expect(server.consumeClickContext).toHaveBeenCalledOnce();
  });

  it('passes click context href to daemon when context is available', async () => {
    const clickCtx: ClickContext = {
      href: 'https://example.com/file.pdf',
      downloadAttr: null,
      isDownloadLink: true,
      tabUrl: 'https://example.com',
      timestamp: Date.now(),
    };

    const daemon = makeDaemonEngine({
      isAvailable: async () => true,
      command: async () => ({
        ok: false,
        error: { code: 'TIMEOUT', message: 'timed out', retryable: false },
        elapsed_ms: 1,
      }),
    });

    const server = makeServer({ clickContext: clickCtx, daemonEngine: daemon });
    const tools = new DownloadTools(server);
    const handler = tools.getHandler('safari_wait_for_download')!;

    await handler({ timeout: 100 });

    expect(server.consumeClickContext).toHaveBeenCalledOnce();
    // Daemon should have been asked to watch_download
    expect(daemon.command).toHaveBeenCalledWith(
      'watch_download',
      expect.objectContaining({
        clickContext: expect.objectContaining({ href: 'https://example.com/file.pdf' }),
      }),
      expect.any(Number),
    );
  });

  it('does not call daemon.command when daemon is unavailable', async () => {
    const daemon = makeDaemonEngine({ isAvailable: async () => false });
    const server = makeServer({ daemonEngine: daemon });
    const tools = new DownloadTools(server);
    const handler = tools.getHandler('safari_wait_for_download')!;

    await handler({ timeout: 100 });

    expect(daemon.command).not.toHaveBeenCalled();
  });
});

// ── Response shape tests ──────────────────────────────────────────────────────

describe('DownloadTools - response shape (timeout path)', () => {
  // With daemon unavailable and a very short timeout, the plist polling loop
  // will fall through to the timeout branch, giving us a predictable response.

  it('response has content array with a text item', async () => {
    const server = makeServer({ daemonEngine: null, appleScriptEngine: null });
    const tools = new DownloadTools(server);
    const handler = tools.getHandler('safari_wait_for_download')!;

    const response = await handler({ timeout: 100, filenamePattern: 'IMPOSSIBLE_MATCH_UNIT_TEST_99999' });

    expect(response).toHaveProperty('content');
    expect(Array.isArray(response.content)).toBe(true);
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.content[0]).toHaveProperty('type', 'text');
    expect(response.content[0]).toHaveProperty('text');
  });

  it('response has metadata with engine, degraded, and latencyMs', async () => {
    const server = makeServer({ daemonEngine: null, appleScriptEngine: null });
    const tools = new DownloadTools(server);
    const handler = tools.getHandler('safari_wait_for_download')!;

    const response = await handler({ timeout: 100, filenamePattern: 'IMPOSSIBLE_MATCH_UNIT_TEST_99999' });

    expect(response).toHaveProperty('metadata');
    expect(response.metadata).toHaveProperty('engine');
    expect(response.metadata).toHaveProperty('degraded');
    expect(response.metadata).toHaveProperty('latencyMs');
    expect(typeof response.metadata.latencyMs).toBe('number');
  });

  it('timeout response text contains TIMEOUT error code', async () => {
    const server = makeServer({ daemonEngine: null, appleScriptEngine: null });
    const tools = new DownloadTools(server);
    const handler = tools.getHandler('safari_wait_for_download')!;

    const response = await handler({ timeout: 100, filenamePattern: 'IMPOSSIBLE_MATCH_UNIT_TEST_99999' });
    const parsed = JSON.parse(response.content[0].text!);

    expect(parsed).toHaveProperty('error', 'TIMEOUT');
    expect(parsed).toHaveProperty('message');
  });

  it('daemon TIMEOUT response text contains TIMEOUT error code', async () => {
    const daemon = makeDaemonEngine({
      isAvailable: async () => true,
      command: async () => ({
        ok: false,
        error: { code: 'TIMEOUT', message: 'daemon timed out', retryable: false },
        elapsed_ms: 1,
      }),
    });

    const server = makeServer({ daemonEngine: daemon });
    const tools = new DownloadTools(server);
    const handler = tools.getHandler('safari_wait_for_download')!;

    const response = await handler({ timeout: 100, filenamePattern: 'IMPOSSIBLE_MATCH_UNIT_TEST_99999' });
    const parsed = JSON.parse(response.content[0].text!);

    expect(parsed).toHaveProperty('error', 'TIMEOUT');
  });

  it('daemon success response is parsed and returned', async () => {
    const metadata = {
      filename: 'report.pdf',
      path: '/Users/test/Downloads/report.pdf',
      url: 'https://example.com/report.pdf',
      size: 12345,
      mimeType: 'application/pdf',
      source: 'daemon',
    };

    const daemon = makeDaemonEngine({
      isAvailable: async () => true,
      command: async () => ({
        ok: true,
        value: JSON.stringify(metadata),
        elapsed_ms: 5,
      }),
    });

    const server = makeServer({ daemonEngine: daemon });
    const tools = new DownloadTools(server);
    const handler = tools.getHandler('safari_wait_for_download')!;

    const response = await handler({ timeout: 5_000 });
    const parsed = JSON.parse(response.content[0].text!);

    expect(parsed).toHaveProperty('filename', 'report.pdf');
    expect(parsed).toHaveProperty('path', '/Users/test/Downloads/report.pdf');
    expect(parsed).toHaveProperty('source', 'daemon');
    expect(response.metadata.engine).toBe('daemon');
    expect(response.metadata.degraded).toBe(false);
  });
});

// ── Inline render detection ───────────────────────────────────────────────────

describe('DownloadTools - inline render detection', () => {
  it('returns DOWNLOAD_INLINE_RENDER error when tab navigated to the clicked href', async () => {
    const clickCtx: ClickContext = {
      href: 'https://example.com/file.pdf',
      downloadAttr: null,
      isDownloadLink: false,
      tabUrl: 'https://example.com',
      timestamp: Date.now(),
    };

    const engine = makeAppleScriptEngine({
      execute: async () => ({
        ok: true,
        value: 'https://example.com/file.pdf',
        elapsed_ms: 5,
      }),
    });

    const server = makeServer({
      clickContext: clickCtx,
      daemonEngine: null,
      appleScriptEngine: engine,
    });

    const tools = new DownloadTools(server);
    const handler = tools.getHandler('safari_wait_for_download')!;

    const response = await handler({ timeout: 5_000, tabUrl: 'https://example.com' });
    const parsed = JSON.parse(response.content[0].text!);

    expect(parsed).toHaveProperty('error', 'DOWNLOAD_INLINE_RENDER');
  });

  it('skips inline detection when no href in click context', async () => {
    const clickCtx: ClickContext = {
      href: undefined,
      downloadAttr: null,
      isDownloadLink: false,
      tabUrl: 'https://example.com',
      timestamp: Date.now(),
    };

    const engine = makeAppleScriptEngine();
    const server = makeServer({
      clickContext: clickCtx,
      daemonEngine: null,
      appleScriptEngine: engine,
    });

    const tools = new DownloadTools(server);
    const handler = tools.getHandler('safari_wait_for_download')!;

    // Falls through to plist polling — will timeout quickly
    await handler({ timeout: 100 });

    // Engine execute should NOT have been called for inline detection
    expect(engine.execute).not.toHaveBeenCalled();
  });
});
