/**
 * Security Pipeline via MCP — End-to-End Test
 *
 * TRUE end-to-end: spawns `node dist/index.js`, speaks MCP JSON-RPC over
 * stdin/stdout. No mocks. Exercises the 9-layer security pipeline as seen
 * from the wire: tab ownership, rate limiting, health check, and kill switch.
 *
 * Wire format: newline-delimited JSON (same as other e2e tests).
 *
 * Prerequisites:
 * - `npm run build` must have been run (tests use dist/index.js)
 * - Safari must be running with JS from Apple Events enabled
 *   (Safari > Develop > Allow JavaScript from Apple Events)
 * - SAFARI_AVAILABLE must not be 'false' and CI must not be 'true'
 *
 * Test ordering note:
 * The kill switch test MUST run last within its describe block — it activates
 * the kill switch on the shared server, which blocks all subsequent tool calls
 * on that server instance. The block is intentional and verified by the test.
 * Other security tests each use their own tab and do not depend on kill switch
 * state.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

// ── Configuration ──────────────────────────────────────────────────────────

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');
const SAFARI_AVAILABLE = process.env.CI !== 'true' && process.env.SAFARI_AVAILABLE !== 'false';

// ── McpTestClient ──────────────────────────────────────────────────────────

/**
 * Minimal MCP test client. FIFO queue of resolvers; id-bearing server
 * responses are dispatched in arrival order.
 */
class McpTestClient {
  private proc: ChildProcess;
  private buffer = '';
  private responseQueue: Array<(data: unknown) => void> = [];

  constructor() {
    this.proc = spawn('node', [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: join(import.meta.dirname, '../..'),
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg !== null && typeof msg === 'object' && 'id' in (msg as object)) {
          const resolver = this.responseQueue.shift();
          if (resolver) resolver(msg);
        }
      }
    });

    // Uncomment for debugging: this.proc.stderr!.on('data', (c: Buffer) => process.stderr.write(c));
  }

  async send(msg: Record<string, unknown>, timeoutMs = 25000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP timeout (${timeoutMs}ms) for method: ${msg['method']}`)),
        timeoutMs,
      );
      this.responseQueue.push((data) => {
        clearTimeout(timer);
        resolve(data);
      });
      this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  notify(msg: Record<string, unknown>): void {
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  async close(): Promise<void> {
    this.proc.kill('SIGTERM');
    return new Promise((resolve) => {
      this.proc.on('close', () => resolve());
      setTimeout(resolve, 3000);
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

let nextId = 2; // id=1 reserved for initialize

const id = () => nextId++;

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function doHandshake(client: McpTestClient): Promise<void> {
  await client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'security-via-mcp-e2e', version: '1.0.0' },
    },
  });
  client.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/**
 * Send a tools/call request and return the raw JSON-RPC response object.
 * Unlike callTool() in other suites, this returns the full response — callers
 * need to inspect both 'result' and 'error' branches for security tests.
 */
async function sendToolCall(
  client: McpTestClient,
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  return (await client.send(
    {
      jsonrpc: '2.0',
      id: id(),
      method: 'tools/call',
      params: { name, arguments: args },
    },
    timeoutMs,
  )) as Record<string, unknown>;
}

/**
 * Send a tools/call and parse content[0].text JSON if successful.
 * Throws on protocol-level errors (kill switch, malformed, etc.).
 */
async function callTool(
  client: McpTestClient,
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const resp = await sendToolCall(client, name, args, timeoutMs);

  if ('error' in resp) {
    const err = resp['error'] as Record<string, unknown>;
    throw new Error(`MCP protocol error ${err['code']}: ${err['message']}`);
  }

  const result = resp['result'] as Record<string, unknown>;
  const content = result['content'] as Array<Record<string, unknown>> | undefined;
  if (!content || content.length === 0) return result;

  const firstItem = content[0];
  if (firstItem['type'] === 'image') return result;

  const text = firstItem['text'] as string | undefined;
  if (!text) return result;

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

/**
 * Resolve the canonical URL Safari uses for a tab, via safari_list_tabs.
 */
async function resolveTabUrl(
  client: McpTestClient,
  rawUrl: string,
): Promise<string> {
  const data = await callTool(client, 'safari_list_tabs', {});
  const tabs = data['tabs'] as Array<Record<string, unknown>>;
  const canonical = rawUrl.replace(/\/$/, '');
  const match = tabs.find(
    (t) =>
      typeof t['url'] === 'string' &&
      (t['url'] as string).replace(/\/$/, '') === canonical,
  );
  return match ? (match['url'] as string) : rawUrl;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Security pipeline via MCP — real Safari, no mocks', () => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = new McpTestClient();
    await doHandshake(client);
  }, 25000);

  afterAll(async () => {
    await client.close();
  });

  // ── 1. Health check returns structured result ────────────────────────────
  //
  // No Safari required — health check works even if Safari isn't running,
  // returning a structured response with check results.

  describe('safari_health_check — structured response through MCP', () => {
    it('returns healthy field and a checks array with named entries', async () => {
      const data = await callTool(client, 'safari_health_check', {}, 20000);

      // { healthy: boolean, checks: [{name, ok}], failedChecks: string[], sessionId }
      expect(typeof data['healthy']).toBe('boolean');
      expect(Array.isArray(data['checks'])).toBe(true);
      expect(Array.isArray(data['failedChecks'])).toBe(true);
      expect(typeof data['sessionId']).toBe('string');
      expect((data['sessionId'] as string).length).toBeGreaterThan(0);
    }, 25000);

    it('checks array contains expected check names', async () => {
      const data = await callTool(client, 'safari_health_check', {}, 20000);
      const checks = data['checks'] as Array<Record<string, unknown>>;

      // Each check must have a name (string) and ok (boolean) field
      for (const check of checks) {
        expect(typeof check['name']).toBe('string');
        expect(typeof check['ok']).toBe('boolean');
      }

      const names = checks.map((c) => c['name'] as string);
      // Core checks that are always present regardless of Safari state
      expect(names).toContain('safari_running');
      expect(names).toContain('daemon');
      expect(names).toContain('extension');
    }, 25000);
  });

  // ── 2. Tab ownership enforced through MCP ─────────────────────────────────

  describe.skipIf(!SAFARI_AVAILABLE)('tab ownership — agent can only act on owned tabs', () => {
    let ownedTabUrl: string;

    beforeAll(async () => {
      const data = await callTool(client, 'safari_new_tab', { url: 'https://example.com' });
      await waitMs(2000);
      ownedTabUrl = await resolveTabUrl(client, data['tabUrl'] as string);
    }, 30000);

    afterAll(async () => {
      if (ownedTabUrl) {
        await callTool(client, 'safari_close_tab', { tabUrl: ownedTabUrl }).catch(() => {});
      }
    });

    it('tools succeed on the agent-owned tab URL', async () => {
      if (!ownedTabUrl) return;

      // safari_get_text on an owned tab should succeed (or fail with a
      // Safari-level error, not an ownership error)
      const data = await callTool(client, 'safari_get_text', {
        tabUrl: ownedTabUrl,
      }, 20000);

      // Ownership was not the failure mode — either text was returned or a
      // Safari-level issue occurred. An ownership rejection would have thrown
      // at the protocol level (the test would have thrown from callTool).
      const hasText = typeof data['text'] === 'string';
      const hasSafariError =
        'error' in data && typeof data['error'] === 'string' &&
        !(data['error'] as string).toLowerCase().includes('ownership');
      expect(hasText || hasSafariError).toBe(true);
    }, 25000);

    it('safari_list_tabs (ownership-exempt tool) lists tabs without restriction', async () => {
      // safari_list_tabs is in SKIP_OWNERSHIP_TOOLS — must always work
      const data = await callTool(client, 'safari_list_tabs', {}, 15000);
      expect(Array.isArray(data['tabs'])).toBe(true);
      expect((data['tabs'] as Array<unknown>).length).toBeGreaterThan(0);
    }, 20000);
  });

  // ── 3. Rate limiter active — 5 rapid requests all succeed (well under limit)

  describe.skipIf(!SAFARI_AVAILABLE)('rate limiter — 5 rapid requests stay under limit', () => {
    let ownedTabUrl: string;

    beforeAll(async () => {
      const data = await callTool(client, 'safari_new_tab', { url: 'https://example.com' });
      await waitMs(2000);
      ownedTabUrl = await resolveTabUrl(client, data['tabUrl'] as string);
    }, 30000);

    afterAll(async () => {
      if (ownedTabUrl) {
        await callTool(client, 'safari_close_tab', { tabUrl: ownedTabUrl }).catch(() => {});
      }
    });

    it('5 rapid safari_get_text requests all complete without rate-limit error', async () => {
      if (!ownedTabUrl) return;

      // Global limit is 120/min. 5 requests are trivially within budget.
      // We fire them sequentially to avoid FIFO queue ambiguity.
      const results: Record<string, unknown>[] = [];

      for (let i = 0; i < 5; i++) {
        // callTool throws on protocol error (including rate-limit rejection)
        const data = await callTool(client, 'safari_get_text', {
          tabUrl: ownedTabUrl,
        }, 15000);
        results.push(data);
      }

      expect(results).toHaveLength(5);

      // All 5 must have succeeded at the protocol level (no throw = no rate-limit)
      // Each response has either 'text' (success) or a Safari-level 'error' (acceptable)
      for (const r of results) {
        const hasText = typeof r['text'] === 'string';
        const hasSafariError = 'error' in r && typeof r['error'] === 'string';
        expect(hasText || hasSafariError).toBe(true);
      }
    }, 90000);
  });

  // ── 4. Kill switch — activate then verify blocking ────────────────────────
  //
  // This test MUST run last. It activates the kill switch on the shared
  // server process, which persists for the lifetime of that process. The
  // afterAll for this suite kills the process, so no cross-suite contamination.
  //
  // Uses a SEPARATE McpTestClient so the kill switch test doesn't interfere
  // with the rate-limiter or ownership tests that run before it.

  describe('kill switch — safari_emergency_stop blocks subsequent calls', () => {
    let killClient: McpTestClient;
    let killClientNextId = 2;
    const killId = () => killClientNextId++;

    beforeAll(async () => {
      killClient = new McpTestClient();
      // Perform the MCP handshake on this dedicated client
      await killClient.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'kill-switch-e2e', version: '1.0.0' },
        },
      });
      killClient.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }, 25000);

    afterAll(async () => {
      await killClient.close();
    });

    it('safari_emergency_stop returns stopped: true with the given reason', async () => {
      const resp = await killClient.send({
        jsonrpc: '2.0',
        id: killId(),
        method: 'tools/call',
        params: {
          name: 'safari_emergency_stop',
          arguments: { reason: 'e2e-kill-switch-test' },
        },
      }) as Record<string, unknown>;

      // Must be a successful JSON-RPC response (no protocol error)
      expect(resp).toMatchObject({ jsonrpc: '2.0' });
      expect('error' in resp).toBe(false);

      const result = resp['result'] as Record<string, unknown>;
      const content = result['content'] as Array<Record<string, unknown>>;
      expect(Array.isArray(content)).toBe(true);

      const text = content[0]['text'] as string;
      const data = JSON.parse(text) as Record<string, unknown>;
      expect(data['stopped']).toBe(true);
      expect(data['reason']).toBe('e2e-kill-switch-test');
    }, 20000);

    it('any subsequent tool call is blocked by the active kill switch', async () => {
      // After emergency stop, the kill switch is active on this server process.
      // executeToolWithSecurity() calls killSwitch.checkBeforeAction() first —
      // this throws KillSwitchActiveError, which the MCP SDK surfaces as a
      // protocol-level error response (not a result.content tool error).
      const resp = await killClient.send({
        jsonrpc: '2.0',
        id: killId(),
        method: 'tools/call',
        params: {
          name: 'safari_health_check',
          arguments: {},
        },
      }) as Record<string, unknown>;

      // The kill switch check runs before ANY tool logic. The MCP SDK catches
      // the thrown KillSwitchActiveError and returns a JSON-RPC error object.
      expect(resp).toMatchObject({ jsonrpc: '2.0' });
      expect('error' in resp).toBe(true);

      const err = resp['error'] as Record<string, unknown>;
      expect(typeof err['code']).toBe('number');
      expect(typeof err['message']).toBe('string');

      // The error message should mention the kill switch or the reason we gave
      const message = (err['message'] as string).toLowerCase();
      const mentionsKillSwitch =
        message.includes('kill') ||
        message.includes('stop') ||
        message.includes('e2e-kill-switch-test') ||
        message.includes('emergency');
      expect(mentionsKillSwitch).toBe(true);
    }, 20000);
  });
});
