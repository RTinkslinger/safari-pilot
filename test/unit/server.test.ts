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

describe('createServer', () => {
  it('returns a SafariPilotServer instance', async () => {
    const server = await createServer();
    expect(server).toBeInstanceOf(SafariPilotServer);
  });
});
