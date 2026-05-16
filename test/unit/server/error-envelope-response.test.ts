/**
 * F3.1 — `executeToolWithSecurity` catch block must convert any caught
 * `SafariPilotError` into a structured `isError: true` MCP response so the
 * agent sees `{ error, message, retryable, hints }` JSON in `content[0].text`
 * instead of an opaque thrown Error. Mirrors the T30 HumanApproval soft-return
 * pattern at server.ts:737-759.
 *
 * Pre-F3.1 the catch block rethrew the error, the MCP SDK serialized it as a
 * bare JSON-RPC -32603 with just the message string, and the agent lost all
 * recoverable structure (code, retryable, hints). Track A's DAEMON_TIMEOUT
 * envelope was operationally inert.
 *
 * Boundary mocks (per CLAUDE.md "Unit Tests" hard rules):
 *   - `node:child_process.execSync` — drives `checkWindowExists()`
 *   - global `fetch` — drives `checkExtensionStatus()`
 *
 * Both probes return healthy so the pre-call gate doesn't reroute the call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'node:child_process';
import { SafariPilotServer } from '../../../src/server.js';
import { DEFAULT_CONFIG } from '../../../src/config.js';
import {
  EngineExecutionError,
  wrapEngineError,
} from '../../../src/errors.js';

interface ServerInternals {
  _sessionWindowId?: number;
  executeToolWithSecurity: (
    name: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    metadata?: { engine?: string; latencyMs?: number; degraded?: boolean };
  }>;
}

function setSessionWindowId(server: SafariPilotServer, id: number): void {
  (server as unknown as ServerInternals)._sessionWindowId = id;
}

function callExecuteToolWithSecurity(
  server: SafariPilotServer,
  name: string,
  params: Record<string, unknown>,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  metadata?: { engine?: string; latencyMs?: number; degraded?: boolean };
}> {
  return (server as unknown as ServerInternals).executeToolWithSecurity(name, params);
}

describe('executeToolWithSecurity catch: SafariPilotError → structured isError (F3.1)', () => {
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

  it('an EngineExecutionError thrown by a tool handler surfaces as structured isError with code/retryable/hints', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 12345);

    server.registerTool({
      name: 'sp_test_f31_envelope',
      description: 'F3.1 test stub — handler throws a wrapped EngineExecutionError',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: true },
      handler: async () => {
        throw wrapEngineError(
          {
            code: 'DAEMON_TIMEOUT',
            message: "Daemon command 'execute' timed out after 30000ms",
            retryable: false,
            hints: [
              'Switch tools',
              'Call safari_wait_for first',
            ],
          },
          'should never see this fallback',
        );
      },
    });

    const response = await callExecuteToolWithSecurity(server, 'sp_test_f31_envelope', {});

    // PRIMARY ORACLE: isError true, structured payload in content[0].text.
    expect(response.isError).toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0]?.type).toBe('text');
    const payload = JSON.parse(response.content[0]?.text ?? '{}') as {
      error: string;
      message: string;
      retryable: boolean;
      hints: string[];
    };
    expect(payload.error).toBe('DAEMON_TIMEOUT');
    expect(payload.message).toBe("Daemon command 'execute' timed out after 30000ms");
    expect(payload.retryable).toBe(false);
    expect(payload.hints).toEqual(['Switch tools', 'Call safari_wait_for first']);

    // SECONDARY ORACLE: metadata carries engine + latency.
    expect(response.metadata?.engine).toBeDefined();
    expect(typeof response.metadata?.latencyMs).toBe('number');
  });

  it('a directly-constructed EngineExecutionError (no wrap helper) round-trips with the same shape', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 12346);

    server.registerTool({
      name: 'sp_test_f31_direct',
      description: 'F3.1 test stub — handler throws an EngineExecutionError directly',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: true },
      handler: async () => {
        throw new EngineExecutionError({
          code: 'CONTENT_SCRIPT_NOT_READY',
          message: 'Content script has not yet loaded',
          retryable: true,
          hints: ['Call safari_wait_for with selector="body"'],
        });
      },
    });

    const response = await callExecuteToolWithSecurity(server, 'sp_test_f31_direct', {});

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0]?.text ?? '{}') as {
      error: string;
      retryable: boolean;
      hints: string[];
    };
    expect(payload.error).toBe('CONTENT_SCRIPT_NOT_READY');
    expect(payload.retryable).toBe(true);
    expect(payload.hints).toEqual(['Call safari_wait_for with selector="body"']);
  });

  it('a non-SafariPilotError (raw TypeError) is still rethrown — the catch block does not swallow programming bugs', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 12347);

    server.registerTool({
      name: 'sp_test_f31_typeerror',
      description: 'F3.1 test stub — handler throws a raw TypeError',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: true },
      handler: async () => {
        throw new TypeError('this is a programming bug');
      },
    });

    await expect(
      callExecuteToolWithSecurity(server, 'sp_test_f31_typeerror', {}),
    ).rejects.toThrow(TypeError);
  });
});
