import { describe, it, expect, beforeEach } from 'vitest';
import { SafariPilotServer, createServer } from '../../src/server.js';

describe('SafariPilotServer', () => {
  it('can be instantiated', () => {
    const server = new SafariPilotServer();
    expect(server).toBeInstanceOf(SafariPilotServer);
  });

  it('has registered tools after initialization', async () => {
    const server = new SafariPilotServer();
    await server.initialize();
    const names = server.getToolNames();
    expect(names.length).toBeGreaterThan(0);
  });

  it('tool names follow safari_ prefix convention', async () => {
    const server = new SafariPilotServer();
    await server.initialize();
    const names = server.getToolNames();
    for (const name of names) {
      expect(name).toMatch(/^safari_/);
    }
  });

  it('rejects calls to non-existent tools with descriptive error', async () => {
    const server = new SafariPilotServer();
    await server.initialize();
    await expect(server.callTool('nonexistent_tool', {})).rejects.toThrow('Unknown tool');
  });
});

// ── Extension engine initialization ─────────────────────────────────────────

describe('SafariPilotServer — extension engine initialization', () => {

  it('initialize() probes extension availability and reports it in health check', async () => {
    const server = new SafariPilotServer();
    await server.initialize();

    // The health check tool reports engine availability.
    const result = await server.callTool('safari_health_check', {});
    const text = result.content[0]?.text;
    expect(text).toBeDefined();

    const health = JSON.parse(text!);
    // The health check must include an 'extension' entry — this proves
    // initialize() created an ExtensionEngine and checked isAvailable().
    const extensionCheck = health.checks.find(
      (c: { name: string }) => c.name === 'extension',
    );
    expect(extensionCheck).toBeDefined();
    // ok is a boolean — true if daemon + extension are both connected
    expect(typeof extensionCheck.ok).toBe('boolean');
  });

  it('initialize() probes daemon availability and reports it in health check', async () => {
    const server = new SafariPilotServer();
    await server.initialize();

    const result = await server.callTool('safari_health_check', {});
    const health = JSON.parse(result.content[0]!.text!);

    const daemonCheck = health.checks.find(
      (c: { name: string }) => c.name === 'daemon',
    );
    // The daemon check must exist — initialize() must have probed it
    expect(daemonCheck).toBeDefined();
    // ok is a boolean (true if daemon binary is present, false otherwise)
    expect(typeof daemonCheck.ok).toBe('boolean');
  });

  it('engine selector throws EngineUnavailableError when extension is forced unavailable', async () => {
    const server = new SafariPilotServer();
    await server.initialize();

    server.setEngineAvailability({ daemon: true, extension: false });

    const { EngineUnavailableError } = await import('../../src/engine-selector.js');
    expect(() =>
      server.getSelectedEngine({ requiresShadowDom: true }),
    ).toThrow(EngineUnavailableError);
  });

  it('setEngineAvailability() can override detected extension state', async () => {
    const server = new SafariPilotServer();
    await server.initialize();

    // Simulate extension becoming available after init
    server.setEngineAvailability({ daemon: true, extension: true });

    // Now shadow DOM requirement should resolve to extension
    const engine = server.getSelectedEngine({ requiresShadowDom: true });
    expect(engine).toBe('extension');
  });
});

describe('createServer', () => {
  it('returns a SafariPilotServer instance', async () => {
    const server = await createServer();
    expect(server).toBeInstanceOf(SafariPilotServer);
  });
});
