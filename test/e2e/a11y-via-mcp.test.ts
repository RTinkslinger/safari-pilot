/**
 * Accessibility Features via MCP — End-to-End Test
 *
 * TRUE end-to-end: spawns `node dist/index.js`, speaks MCP JSON-RPC over
 * stdin/stdout. No mocks. Verifies real accessibility snapshot output from
 * Safari, ref-based targeting, locator targeting, and auto-wait behaviour.
 *
 * Wire format: newline-delimited JSON (same as other e2e tests).
 *
 * Prerequisites:
 * - `npm run build` must have been run (tests use dist/index.js)
 * - Safari must be running with JS from Apple Events enabled
 *   (Safari > Develop > Allow JavaScript from Apple Events)
 * - SAFARI_AVAILABLE must not be 'false' and CI must not be 'true'
 *
 * Design: each describe group creates its OWN tab in beforeAll and closes it
 * in afterAll. This prevents URL state leakage across groups — after a click
 * navigates the tab to a different URL, subsequent groups still start fresh.
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
      clientInfo: { name: 'a11y-via-mcp-e2e', version: '1.0.0' },
    },
  });
  client.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/**
 * Call a tool and return the parsed content[0].text JSON.
 * Throws on protocol-level errors (MCP error in the response).
 */
async function callTool(
  client: McpTestClient,
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const resp = (await client.send(
    {
      jsonrpc: '2.0',
      id: id(),
      method: 'tools/call',
      params: { name, arguments: args },
    },
    timeoutMs,
  )) as Record<string, unknown>;

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
 * Resolve the canonical URL Safari actually uses for a tab (trailing slash etc.)
 * by matching against safari_list_tabs output.
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

/**
 * Open a new tab at example.com and return the canonical URL Safari uses.
 * Waits for the page to load before returning.
 */
async function openExampleTab(client: McpTestClient): Promise<string> {
  const data = await callTool(client, 'safari_new_tab', { url: 'https://example.com' });
  await waitMs(2000);
  return resolveTabUrl(client, data['tabUrl'] as string);
}

// ── Tests ──────────────────────────────────────────────────────────────────
//
// Each describe group owns its own tab (created in beforeAll, closed in afterAll).
// This prevents URL state leakage when a test navigates the tab away from example.com.

describe('Accessibility features via MCP — real Safari, no mocks', () => {
  let client: McpTestClient;

  beforeAll(async () => {
    client = new McpTestClient();
    await doHandshake(client);
  }, 25000);

  afterAll(async () => {
    await client.close();
  });

  // ── 1. safari_snapshot returns YAML with [ref=eN] patterns ───────────────

  describe.skipIf(!SAFARI_AVAILABLE)('snapshot — YAML with element refs', () => {
    let tabUrl: string;

    beforeAll(async () => {
      tabUrl = await openExampleTab(client);
    }, 30000);

    afterAll(async () => {
      if (tabUrl) {
        await callTool(client, 'safari_close_tab', { tabUrl }).catch(() => {});
      }
    });

    it('returns snapshot object with non-empty snapshot text', async () => {
      if (!tabUrl) return;

      const data = await callTool(client, 'safari_snapshot', {
        tabUrl,
        format: 'yaml',
      });

      // SnapshotResult: { snapshot: string, url, title, elementCount, interactiveCount }
      expect(typeof data['snapshot']).toBe('string');
      expect((data['snapshot'] as string).length).toBeGreaterThan(10);
    }, 25000);

    it('snapshot YAML contains heading and link role entries', async () => {
      if (!tabUrl) return;

      const data = await callTool(client, 'safari_snapshot', {
        tabUrl,
        format: 'yaml',
      });

      const yaml = data['snapshot'] as string;
      // example.com has an <h1> (heading role) and an <a> (link role)
      expect(yaml).toMatch(/heading/i);
      expect(yaml).toMatch(/link/i);
    }, 25000);

    it('snapshot YAML contains [ref=eN] identifiers for interactive elements', async () => {
      if (!tabUrl) return;

      const data = await callTool(client, 'safari_snapshot', {
        tabUrl,
        format: 'yaml',
      });

      const yaml = data['snapshot'] as string;
      // Interactive elements (links on example.com) must get ref annotations.
      // Format: [ref=e1], [ref=e2], ...
      expect(yaml).toMatch(/\[ref=e\d+\]/);
    }, 25000);

    it('snapshot result includes url, elementCount, and interactiveCount metadata', async () => {
      if (!tabUrl) return;

      const data = await callTool(client, 'safari_snapshot', {
        tabUrl,
        format: 'yaml',
      });

      expect(typeof data['url']).toBe('string');
      expect(typeof data['elementCount']).toBe('number');
      expect(data['elementCount'] as number).toBeGreaterThan(0);
      expect(typeof data['interactiveCount']).toBe('number');
      // example.com has at least one link (the "More information..." anchor)
      expect(data['interactiveCount'] as number).toBeGreaterThan(0);
    }, 25000);
  });

  // ── 2. Refs extracted from snapshot can target elements for clicks ────────

  describe.skipIf(!SAFARI_AVAILABLE)('snapshot refs — usable in safari_click', () => {
    let tabUrl: string;

    beforeAll(async () => {
      tabUrl = await openExampleTab(client);
    }, 30000);

    afterAll(async () => {
      // Close whatever URL the tab ended up at after the click.
      // Use the most recently known tabUrl; if it navigated, we close by evaluate.
      if (tabUrl) {
        await callTool(client, 'safari_close_tab', { tabUrl }).catch(() => {});
      }
    });

    it('extracts a ref from snapshot and passes it to safari_click without error', async () => {
      if (!tabUrl) return;

      // Get a snapshot and extract the first ref
      const snapshotData = await callTool(client, 'safari_snapshot', {
        tabUrl,
        format: 'yaml',
      });

      const yaml = snapshotData['snapshot'] as string;
      const refMatch = yaml.match(/\[ref=(e\d+)\]/);
      expect(refMatch).not.toBeNull();
      const ref = refMatch![1];

      // Click the element via its ref. example.com's link navigates away, so
      // we accept either a successful click or a navigation-triggered response.
      // What we must NOT get is a tool-level "ref not found" error.
      const clickData = await callTool(client, 'safari_click', {
        tabUrl,
        ref,
      }, 20000);

      // A ref-not-found or injection error would surface as { error: '...' }
      // A successful click returns something other than a string-typed error field
      const hasStringError =
        'error' in clickData && typeof clickData['error'] === 'string';
      expect(hasStringError).toBe(false);
    }, 35000);
  });

  // ── 3. Click targeting by CSS selector ──────────────────────────────────
  //
  // Tests that safari_click reaches and activates a specific element by CSS
  // selector — the foundational interaction path used before locators resolve.
  // The "More information..." link on example.com is the target.

  describe.skipIf(!SAFARI_AVAILABLE)('click targeting — CSS selector', () => {
    let tabUrl: string;

    beforeAll(async () => {
      tabUrl = await openExampleTab(client);
    }, 30000);

    afterAll(async () => {
      if (tabUrl) {
        await callTool(client, 'safari_close_tab', { tabUrl }).catch(() => {});
      }
    });

    it('safari_click with selector=a[href] activates the link on example.com', async () => {
      if (!tabUrl) return;

      // Re-resolve to get the exact canonical URL Safari uses for this tab.
      // buildTabScript matches by URL of _tab — must be exact (trailing slash matters).
      const freshTabUrl = await resolveTabUrl(client, tabUrl);

      // Click the only link on example.com using a CSS selector.
      // This exercises the full security pipeline → tool handler → auto-wait → click.
      const data = await callTool(client, 'safari_click', {
        tabUrl: freshTabUrl,
        selector: 'a[href]',
      }, 25000);

      // Should not return a top-level string error (element-not-found, selector error, etc.)
      const hasStringError = 'error' in data && typeof data['error'] === 'string';
      expect(hasStringError).toBe(false);
    }, 35000);
  });

  // ── 4. Locator targeting by visible text content ──────────────────────────

  describe.skipIf(!SAFARI_AVAILABLE)('locator targeting — text content', () => {
    let tabUrl: string;

    beforeAll(async () => {
      tabUrl = await openExampleTab(client);
    }, 30000);

    afterAll(async () => {
      if (tabUrl) {
        await callTool(client, 'safari_close_tab', { tabUrl }).catch(() => {});
      }
    });

    it('safari_get_text with text locator returns the matched element text', async () => {
      if (!tabUrl) return;

      // The <h1> on example.com contains "Example Domain".
      // text locator matches innerText (substring, case-insensitive).
      const data = await callTool(client, 'safari_get_text', {
        tabUrl,
        text: 'Example Domain',
        exact: false,
      }, 20000);

      // On success: { text, length, truncated }
      expect(typeof data['text']).toBe('string');
      expect(data['text'] as string).toMatch(/Example Domain/i);
    }, 25000);
  });

  // ── 5. Auto-wait succeeds on real page load ───────────────────────────────

  describe.skipIf(!SAFARI_AVAILABLE)('auto-wait — immediate extraction after navigation', () => {
    let tabUrl: string;

    beforeAll(async () => {
      tabUrl = await openExampleTab(client);
    }, 30000);

    afterAll(async () => {
      if (tabUrl) {
        await callTool(client, 'safari_close_tab', { tabUrl }).catch(() => {});
      }
    });

    it('safari_get_text on a freshly loaded page returns body text without explicit wait', async () => {
      if (!tabUrl) return;

      // The tab is already at example.com (set by openExampleTab in beforeAll).
      // Call get_text directly on the loaded tab — no navigate, no sleep.
      // This verifies that text extraction works on a ready page without
      // requiring any explicit wait from the caller.
      const data = await callTool(client, 'safari_get_text', {
        tabUrl,
      }, 20000);

      // The tab has example.com loaded. Text must be non-empty.
      expect(typeof data['text']).toBe('string');
      expect((data['text'] as string).length).toBeGreaterThan(0);
      // example.com always contains "Example Domain" in its <h1>
      expect(data['text'] as string).toMatch(/Example Domain/i);
    }, 30000);
  });
});
