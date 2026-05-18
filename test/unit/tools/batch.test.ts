/**
 * v0.1.36 — safari_batch unit tests.
 *
 * Pinning the contract:
 *   - safari_batch runs each sub-action through the FULL security pipeline
 *     (it dispatches via server.executeToolWithSecurity), so kill-switch,
 *     rate-limit, tab-ownership, F3.1 envelope conversion all fire per
 *     sub-action. Batching is a transport optimization, not a way to
 *     bypass security.
 *   - Max 4 actions per batch (Browser-Use's max_actions_per_step=4
 *     setting; rejects 5+).
 *   - Nested safari_batch calls are rejected — prevents the loop detector
 *     and rate limiter from being hidden behind a recursive multiplier.
 *   - stopOnError=false (default): continue collecting results after a
 *     failure. stopOnError=true: short-circuit at first failure.
 *
 * Boundary mocks (per CLAUDE.md "Unit Tests" hard rules):
 *   - node:child_process.execSync (pre-call gate's Safari window check)
 *   - global fetch (extension health check)
 *
 * Both probes return healthy so each sub-action's executeToolWithSecurity
 * pipeline reaches the registered tool's handler.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'node:child_process';
import { SafariPilotServer } from '../../../src/server.js';
import { DEFAULT_CONFIG } from '../../../src/config.js';
import { BatchTools } from '../../../src/tools/batch.js';

/** Manually register safari_batch on the server — initialize() isn't run in unit tests. */
function wireBatch(server: SafariPilotServer): void {
  const batchTools = new BatchTools(server);
  for (const def of batchTools.getDefinitions()) {
    const handler = batchTools.getHandler(def.name);
    if (!handler) throw new Error(`no handler for ${def.name}`);
    server.registerTool({ ...def, handler });
  }
}

interface ServerInternals {
  _sessionWindowId?: number;
  executeToolWithSecurity: (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    metadata?: Record<string, unknown>;
  }>;
}

function setSessionWindowId(server: SafariPilotServer, id: number): void {
  (server as unknown as ServerInternals)._sessionWindowId = id;
}

function callExecuteToolWithSecurity(
  server: SafariPilotServer,
  name: string,
  params: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  return (server as unknown as ServerInternals).executeToolWithSecurity(name, params);
}

describe('safari_batch (v0.1.36 action batching)', () => {
  const mockExec = execSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExec.mockReset();
    vi.unstubAllGlobals();
    mockExec.mockReturnValue('true\n');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ext: true,
          mcp: true,
          sessionTab: true,
          lastPingAge: 100,
          activeSessions: 1,
        }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs each sub-action through the full security pipeline and returns results in order', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 30000);
    wireBatch(server);

    // Register two stub tools that record their invocation order and return distinct values.
    const calls: string[] = [];
    server.registerTool({
      name: 'safari_a',
      description: 'stub a',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: true },
      handler: async () => {
        calls.push('a');
        return {
          content: [{ type: 'text', text: JSON.stringify({ tool: 'a' }) }],
          metadata: { engine: 'extension', degraded: false, latencyMs: 0 },
        };
      },
    });
    server.registerTool({
      name: 'safari_b',
      description: 'stub b',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: true },
      handler: async () => {
        calls.push('b');
        return {
          content: [{ type: 'text', text: JSON.stringify({ tool: 'b' }) }],
          metadata: { engine: 'extension', degraded: false, latencyMs: 0 },
        };
      },
    });

    const response = await callExecuteToolWithSecurity(server, 'safari_batch', {
      actions: [
        { tool: 'safari_a' },
        { tool: 'safari_b' },
      ],
    });

    expect(calls).toEqual(['a', 'b']);
    const payload = JSON.parse(response.content[0]?.text ?? '{}') as {
      results: Array<{ tool: string; ok: boolean }>;
      executed: number;
      total: number;
    };
    expect(payload.executed).toBe(2);
    expect(payload.total).toBe(2);
    expect(payload.results).toHaveLength(2);
    expect(payload.results[0]?.tool).toBe('safari_a');
    expect(payload.results[0]?.ok).toBe(true);
    expect(payload.results[1]?.tool).toBe('safari_b');
    expect(payload.results[1]?.ok).toBe(true);
  });

  it('rejects nested safari_batch (no recursive multiplier)', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 30001);
    wireBatch(server);

    let thrown: unknown;
    try {
      await callExecuteToolWithSecurity(server, 'safari_batch', {
        actions: [{ tool: 'safari_batch', args: { actions: [{ tool: 'safari_anything' }] } }],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg.toLowerCase()).toContain('nested safari_batch');
  });

  it('rejects >4 actions (Browser-Use max_actions_per_step parity)', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 30002);
    wireBatch(server);

    let thrown: unknown;
    try {
      await callExecuteToolWithSecurity(server, 'safari_batch', {
        actions: [
          { tool: 'safari_x' },
          { tool: 'safari_x' },
          { tool: 'safari_x' },
          { tool: 'safari_x' },
          { tool: 'safari_x' },  // 5th
        ],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg.toLowerCase()).toContain('max 4');
  });

  it('rejects non-safari_ tool names', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 30003);
    wireBatch(server);

    let thrown: unknown;
    try {
      await callExecuteToolWithSecurity(server, 'safari_batch', {
        actions: [{ tool: 'fetch_remote_url' }],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg.toLowerCase()).toContain('must start with "safari_"');
  });

  it('stopOnError=false continues after a failing sub-action (default behaviour)', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 30004);
    wireBatch(server);

    let bRan = false;
    server.registerTool({
      name: 'safari_fail',
      description: 'always fails',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: true },
      handler: async () => {
        throw new Error('intentional sub-action failure');
      },
    });
    server.registerTool({
      name: 'safari_after',
      description: 'should still run',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: true },
      handler: async () => {
        bRan = true;
        return {
          content: [{ type: 'text', text: JSON.stringify({ ran: true }) }],
          metadata: { engine: 'extension', degraded: false, latencyMs: 0 },
        };
      },
    });

    const response = await callExecuteToolWithSecurity(server, 'safari_batch', {
      actions: [
        { tool: 'safari_fail' },
        { tool: 'safari_after' },
      ],
    });

    expect(bRan).toBe(true);  // failure didn't halt the batch
    const payload = JSON.parse(response.content[0]?.text ?? '{}') as {
      results: Array<{ tool: string; ok: boolean; error?: { message: string } }>;
      executed: number;
    };
    expect(payload.executed).toBe(2);
    expect(payload.results[0]?.ok).toBe(false);
    expect(payload.results[0]?.error?.message).toContain('intentional sub-action failure');
    expect(payload.results[1]?.ok).toBe(true);
  });

  it('stopOnError=true short-circuits at first failure', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 30005);
    wireBatch(server);

    let bRan = false;
    server.registerTool({
      name: 'safari_fail',
      description: 'always fails',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: true },
      handler: async () => {
        throw new Error('intentional sub-action failure');
      },
    });
    server.registerTool({
      name: 'safari_after',
      description: 'must NOT run when stopOnError=true',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: true },
      handler: async () => {
        bRan = true;
        return {
          content: [{ type: 'text', text: JSON.stringify({ ran: true }) }],
          metadata: { engine: 'extension', degraded: false, latencyMs: 0 },
        };
      },
    });

    const response = await callExecuteToolWithSecurity(server, 'safari_batch', {
      actions: [
        { tool: 'safari_fail' },
        { tool: 'safari_after' },
      ],
      stopOnError: true,
    });

    expect(bRan).toBe(false);
    const payload = JSON.parse(response.content[0]?.text ?? '{}') as {
      executed: number;
      total: number;
    };
    expect(payload.executed).toBe(1);
    expect(payload.total).toBe(2);
  });

  it('handles a sub-action that returns isError:true (F3.1 envelope path) — captures and continues', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 30006);
    wireBatch(server);

    // Use a real registered tool whose handler throws EngineExecutionError.
    // F3.1 converts that to isError:true; safari_batch should record ok:false
    // and continue (stopOnError defaults to false).
    let secondRan = false;
    server.registerTool({
      name: 'safari_engine_err',
      description: 'throws EngineExecutionError via wrapEngineError',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: true },
      handler: async () => {
        const { wrapEngineError } = await import('../../../src/errors.js');
        throw wrapEngineError({
          code: 'DAEMON_TIMEOUT',
          message: 'simulated timeout',
          retryable: false,
          hints: ['switch tools'],
        }, 'fb');
      },
    });
    server.registerTool({
      name: 'safari_after_engine_err',
      description: 'should still run',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: true },
      handler: async () => {
        secondRan = true;
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
          metadata: { engine: 'extension', degraded: false, latencyMs: 0 },
        };
      },
    });

    const response = await callExecuteToolWithSecurity(server, 'safari_batch', {
      actions: [
        { tool: 'safari_engine_err' },
        { tool: 'safari_after_engine_err' },
      ],
    });

    expect(secondRan).toBe(true);
    const payload = JSON.parse(response.content[0]?.text ?? '{}') as {
      results: Array<{ tool: string; ok: boolean; isError?: boolean }>;
    };
    expect(payload.results[0]?.ok).toBe(false);
    expect(payload.results[0]?.isError).toBe(true);
    expect(payload.results[1]?.ok).toBe(true);
  });

  it('an empty actions array is rejected', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 30007);
    wireBatch(server);

    let thrown: unknown;
    try {
      await callExecuteToolWithSecurity(server, 'safari_batch', { actions: [] });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg.toLowerCase()).toContain('non-empty');
  });
});
