/**
 * T30 — `HumanApprovalRequiredError` is the only tool-pipeline failure that
 * returns a soft response (instead of throwing) so the MCP client can
 * surface a structured `approvalRequired: true` payload to the user. But
 * the response previously omitted the MCP `isError` flag, so MCP clients
 * saw it as a SUCCESSFUL tool call with weird content. Other security
 * layers (KillSwitch, RateLimiter, CircuitBreaker, blocked-domain) all
 * throw hard errors, so they round-trip as MCP tool errors automatically.
 *
 * Fix: add `isError: true` to both HumanApproval soft-return paths
 * (server.ts:509-525 initial-check, 662-678 post-engine-degradation
 * re-check) and propagate the flag through index.ts's MCP CallTool
 * handler so client-visible errors match the protocol contract.
 *
 * Coverage scope (acknowledged limitation): only Site 1 (initial check,
 * line 497) is exercised here. Site 2 (re-check after engine degradation,
 * line 650) is structurally identical and currently dead code — because
 * HumanApproval is stateless, the re-assert against the SAME inputs that
 * passed Site 1 cannot throw a different result. A test that drove Site 2
 * would require either making HumanApproval stateful (production
 * behaviour change) or mocking the internal module (disallowed by
 * CLAUDE.md unit-test boundary policy). Site 2 fix is enforced via diff
 * symmetry in code review, not via this test.
 *
 * Boundary mocks (per CLAUDE.md "Unit Tests" hard rules):
 *   - `node:child_process.execSync` — drives `checkWindowExists()`
 *   - global `fetch` — drives `checkExtensionStatus()`
 *
 * Both probes return healthy so the gate doesn't recover and the call
 * reaches the human-approval check at server.ts:497.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execSync: vi.fn() };
});

import { execSync } from 'node:child_process';
import { SafariPilotServer } from '../../../src/server.js';
import { DEFAULT_CONFIG } from '../../../src/config.js';

interface ServerInternals {
  _sessionWindowId?: number;
  executeToolWithSecurity: (name: string, params: Record<string, unknown>) => Promise<unknown>;
}

function setSessionWindowId(server: SafariPilotServer, id: number): void {
  (server as unknown as ServerInternals)._sessionWindowId = id;
}

function callExecuteToolWithSecurity(
  server: SafariPilotServer,
  name: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return (server as unknown as ServerInternals).executeToolWithSecurity(name, params);
}

describe('SafariPilotServer HumanApproval soft-return must set isError (T30)', () => {
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

  it('marks the soft-return response with isError:true when HumanApproval blocks an OAuth URL', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 99999);
    // Tool stub registration isn't required to hit the bug — the gate
    // doesn't need toolDef when probes are healthy, and the
    // HumanApproval check runs before engine selection / tab ownership.
    // But include one for completeness so the path through the catch is
    // identical to production when a real tool is registered.
    server.registerTool({
      name: 'safari_navigate',
      description: 'test stub for human-approval iserror',
      inputSchema: { type: 'object', properties: {} } as Record<string, unknown>,
      requirements: { idempotent: false },
      handler: async () => {
        throw new Error('handler should not be reached when approval is blocked');
      },
    });

    // accounts.google.com/o/oauth* matches OAUTH_URL_PATTERNS at
    // human-approval.ts:23, so HumanApprovalRequiredError will be thrown
    // and the catch block at server.ts:498 runs the soft-return path.
    const response = (await callExecuteToolWithSecurity(server, 'safari_navigate', {
      tabUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=test',
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean; metadata: { degraded: boolean } };

    // PRIMARY ORACLE: isError must be true on the soft-return response.
    // A regression where isError is omitted (the pre-T30 state) leaves
    // the MCP client unable to distinguish an approval-blocked call from
    // a successful one.
    expect(
      response.isError,
      'HumanApproval soft-return must set isError:true so MCP clients '
        + 'recognise the approval-blocked call as a tool-level error',
    ).toBe(true);

    // SECONDARY ORACLE: the response must still carry the structured
    // approvalRequired payload that downstream UIs depend on. Locks
    // against an over-correction where someone "fixes" by replacing the
    // soft-return with `throw err`, which would lose the structured
    // approvalRequired hint.
    const text = response.content[0]?.text ?? '';
    expect(text).toContain('approvalRequired');

    // TERTIARY ORACLE: degraded metadata is preserved (existing contract).
    expect(response.metadata.degraded).toBe(true);
  });
});
