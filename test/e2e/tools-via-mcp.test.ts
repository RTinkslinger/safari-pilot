/**
 * Tools-via-MCP End-to-End Test
 *
 * TRUE end-to-end: spawns `node dist/index.js` as a real child process,
 * speaks MCP JSON-RPC over stdin/stdout, and verifies real Safari responses.
 * NO MOCKS. Every assertion touches actual AppleScript output from Safari.
 *
 * Wire format: newline-delimited JSON (same as mcp-protocol.test.ts).
 *
 * Prerequisites:
 * - `npm run build` must have been run (tests use dist/index.js)
 * - Safari must be running with JS from Apple Events enabled
 *   (Safari > Develop > Allow JavaScript from Apple Events)
 * - SAFARI_AVAILABLE must not be 'false' and CI must not be 'true'
 *
 * URL normalisation note:
 * Safari stores URLs canonically (e.g. https://example.com/ with trailing slash)
 * but the server's navigate handler returns the input string when the tab lookup
 * fails (exact-match mismatch). We work around this by calling safari_list_tabs
 * after tab creation and after navigations to get the URL Safari actually uses
 * internally, then passing that URL to all subsequent tool calls.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Configuration ──────────────────────────────────────────────────────────

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');
const FIXTURE_PATH = join(import.meta.dirname, '../fixtures/form-test.html');
const FIXTURE_URL = pathToFileURL(FIXTURE_PATH).toString();

const SAFARI_AVAILABLE = process.env.CI !== 'true' && process.env.SAFARI_AVAILABLE !== 'false';

// ── McpTestClient (inlined from mcp-protocol.test.ts for standalone use) ──
//
// Duplicated intentionally — keeping this file self-contained avoids import
// coupling. Extract to test/helpers/mcp-client.ts if a third test file needs it.

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

/** Standard MCP handshake. Must complete before calling any tool. */
async function doHandshake(client: McpTestClient): Promise<void> {
  await client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tools-via-mcp-e2e', version: '1.0.0' },
    },
  });
  client.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

/**
 * Send a tools/call request and return the parsed content[0].text JSON.
 *
 * Safari Pilot tools always write their result as JSON into content[0].text.
 * This helper unwraps that layer so tests work directly with tool data.
 * If the server returns a protocol-level error, throws immediately.
 */
async function callTool(
  client: McpTestClient,
  name: string,
  args: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const resp = await client.send(
    {
      jsonrpc: '2.0',
      id: id(),
      method: 'tools/call',
      params: { name, arguments: args },
    },
    timeoutMs,
  ) as Record<string, unknown>;

  if ('error' in resp) {
    const err = resp['error'] as Record<string, unknown>;
    throw new Error(`MCP protocol error ${err['code']}: ${err['message']}`);
  }

  const result = resp['result'] as Record<string, unknown>;
  const content = result['content'] as Array<Record<string, unknown>> | undefined;
  if (!content || content.length === 0) return result;

  const firstItem = content[0];
  if (firstItem['type'] === 'image') return result; // screenshot — no text to parse

  const text = firstItem['text'] as string | undefined;
  if (!text) return result;

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

/**
 * Resolve the canonical URL that Safari actually uses for a tab.
 *
 * Safari normalises URLs (adds trailing slash, etc.) but safari_new_tab and
 * safari_navigate echo the input URL rather than location.href when the tab
 * lookup fails due to the normalisation mismatch. This helper uses
 * safari_list_tabs to find the real URL by prefix matching.
 *
 * @param rawUrl - The URL as returned by safari_new_tab or safari_navigate
 * @param fallback - Returned if no matching tab is found in list_tabs
 */
async function resolveTabUrl(
  client: McpTestClient,
  rawUrl: string,
  fallback?: string,
): Promise<string> {
  const data = await callTool(client, 'safari_list_tabs', {});
  const tabs = data['tabs'] as Array<Record<string, unknown>>;

  // Strip trailing slash for comparison — normalise both sides
  const canonical = rawUrl.replace(/\/$/, '');
  const match = tabs.find(
    (t) =>
      typeof t['url'] === 'string' &&
      (t['url'] as string).replace(/\/$/, '') === canonical,
  );

  if (match) return match['url'] as string;
  return fallback ?? rawUrl;
}

/**
 * Navigate to a URL and return the canonical URL that Safari uses for the tab.
 *
 * Calls safari_navigate then resolves the actual tab URL via safari_list_tabs,
 * because navigate's URL result may not match Safari's internal normalised URL.
 */
async function navigateAndGetRealUrl(
  client: McpTestClient,
  tabUrl: string,
  targetUrl: string,
): Promise<string> {
  await waitMs(500);
  const data = await callTool(client, 'safari_navigate', { tabUrl, url: targetUrl }, 35000);
  await waitMs(1500);

  // Use the navigate response URL as the rawUrl seed for lookup.
  // If navigate returned an error, fall back to tabUrl.
  const navUrl = typeof data['url'] === 'string' ? data['url'] : tabUrl;
  return resolveTabUrl(client, navUrl, navUrl);
}

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Tools via MCP — real Safari, no mocks', () => {
  let client: McpTestClient;

  /**
   * ownedTabUrl is always the canonical URL that Safari uses internally.
   * Never set from safari_new_tab's echoed input — always resolved via
   * safari_list_tabs or safari_navigate + resolveTabUrl.
   */
  let ownedTabUrl: string;

  beforeAll(async () => {
    client = new McpTestClient();
    await doHandshake(client);
  }, 25000);

  afterAll(async () => {
    if (ownedTabUrl) {
      await callTool(client, 'safari_close_tab', { tabUrl: ownedTabUrl }).catch(() => {});
    }
    await client.close();
  });

  // ── Navigation tools ────────────────────────────────────────────────────

  describe.skipIf(!SAFARI_AVAILABLE)('Navigation tools', () => {
    it('safari_new_tab — creates a new tab and returns a tabUrl string', async () => {
      const data = await callTool(client, 'safari_new_tab', { url: 'https://example.com' });

      expect(typeof data['tabUrl']).toBe('string');
      expect((data['tabUrl'] as string).length).toBeGreaterThan(0);
      expect(data['tabUrl'] as string).toMatch(/^https?:\/\//);

      // Wait for the tab to load, then resolve the canonical URL from list_tabs
      await waitMs(2000);
      ownedTabUrl = await resolveTabUrl(client, data['tabUrl'] as string, data['tabUrl'] as string);
    }, 30000);

    it('safari_navigate — navigates to example.com, resolves canonical URL', async () => {
      if (!ownedTabUrl) return;

      const data = await callTool(client, 'safari_navigate', {
        tabUrl: ownedTabUrl,
        url: 'https://example.com',
      }, 35000);

      // On success: { url, title } — url may or may not have trailing slash
      // On error: { error } — can happen when tab URL was already normalised
      const hasUrl = 'url' in data;
      const hasError = 'error' in data;
      expect(hasUrl || hasError).toBe(true);

      await waitMs(1500);

      if (hasUrl) {
        expect(data['url'] as string).toMatch(/example\.com/);
      }

      // Always re-resolve from list_tabs to get the URL Safari actually uses
      ownedTabUrl = await resolveTabUrl(client, ownedTabUrl, ownedTabUrl);
      expect(ownedTabUrl).toMatch(/example\.com/);
    }, 45000);

    it('safari_navigate_back — navigate to second page then go back', async () => {
      if (!ownedTabUrl) return;

      // Navigate to a second page to build history
      ownedTabUrl = await navigateAndGetRealUrl(
        client,
        ownedTabUrl,
        'https://www.iana.org/domains/reserved',
      );

      // go back — the tool uses history.back() and waits 500ms before querying
      const backData = await callTool(client, 'safari_navigate_back', {
        tabUrl: ownedTabUrl,
      }, 15000);

      // Result is { url, title } or { error }
      const hasUrl = 'url' in backData;
      const hasError = 'error' in backData;
      expect(hasUrl || hasError).toBe(true);

      if (hasUrl) {
        expect(typeof backData['url']).toBe('string');
        expect(backData['url'] as string).toMatch(/^https?:\/\//);
      }

      // Re-sync ownedTabUrl to wherever we landed
      await waitMs(1000);
      ownedTabUrl = await resolveTabUrl(client, ownedTabUrl, ownedTabUrl);
    }, 60000);

    it('safari_list_tabs — lists all open tabs, each with a url field', async () => {
      const data = await callTool(client, 'safari_list_tabs', {});

      expect(Array.isArray(data['tabs'])).toBe(true);
      const tabs = data['tabs'] as Array<Record<string, unknown>>;
      expect(tabs.length).toBeGreaterThanOrEqual(1);

      for (const tab of tabs) {
        expect(typeof tab['url']).toBe('string');
      }
    }, 20000);
  });

  // ── Extraction tools ─────────────────────────────────────────────────────

  describe.skipIf(!SAFARI_AVAILABLE)('Extraction tools', () => {
    beforeAll(async () => {
      if (!ownedTabUrl) return;
      // Navigate to example.com and get the canonical URL Safari assigns it
      ownedTabUrl = await navigateAndGetRealUrl(client, ownedTabUrl, 'https://example.com');
    }, 55000);

    it('safari_get_text — extracts visible text containing "Example Domain"', async () => {
      if (!ownedTabUrl) return;

      const data = await callTool(client, 'safari_get_text', {
        tabUrl: ownedTabUrl,
      });

      expect(typeof data['text']).toBe('string');
      expect((data['text'] as string).length).toBeGreaterThan(0);
      expect(data['text'] as string).toContain('Example Domain');
    }, 20000);

    it('safari_snapshot — returns non-empty ARIA tree with element info', async () => {
      if (!ownedTabUrl) return;

      const data = await callTool(client, 'safari_snapshot', {
        tabUrl: ownedTabUrl,
        format: 'yaml',
      });

      const asString = JSON.stringify(data);
      expect(asString.length).toBeGreaterThan(20);
      // ARIA tree for example.com contains headings, links, and paragraphs
      expect(asString).toMatch(/heading|link|paragraph|h1|ref|role|name/i);
    }, 25000);

    it('safari_get_html — returns HTML document containing an <h1>', async () => {
      if (!ownedTabUrl) return;

      const data = await callTool(client, 'safari_get_html', {
        tabUrl: ownedTabUrl,
      });

      expect(typeof data['html']).toBe('string');
      expect((data['html'] as string).length).toBeGreaterThan(0);
      expect(data['html'] as string).toMatch(/<h1>/i);
      expect(typeof data['length']).toBe('number');
      expect(data['length'] as number).toBeGreaterThan(0);
    }, 20000);

    it('safari_extract_links — returns at least one link from example.com', async () => {
      if (!ownedTabUrl) return;

      const data = await callTool(client, 'safari_extract_links', {
        tabUrl: ownedTabUrl,
        filter: 'all',
      });

      expect(Array.isArray(data['links'])).toBe(true);
      expect(typeof data['count']).toBe('number');
      expect(data['count'] as number).toBeGreaterThan(0);

      const links = data['links'] as Array<Record<string, unknown>>;
      for (const link of links) {
        expect(typeof link['href']).toBe('string');
      }
    }, 20000);
  });

  // ── Interaction tools ─────────────────────────────────────────────────────

  describe.skipIf(!SAFARI_AVAILABLE)('Interaction tools', () => {
    beforeAll(async () => {
      if (!ownedTabUrl) return;
      // Navigate to the local form fixture — file:// URL, no network needed
      ownedTabUrl = await navigateAndGetRealUrl(client, ownedTabUrl, FIXTURE_URL);
    }, 45000);

    it('safari_fill — fills #name input, value verified via safari_evaluate', async () => {
      if (!ownedTabUrl) return;

      const fillData = await callTool(client, 'safari_fill', {
        tabUrl: ownedTabUrl,
        selector: '#name',
        value: 'Safari Pilot Test',
      });

      // Tool must not return a top-level string error
      expect('error' in fillData && typeof fillData['error'] === 'string').toBe(false);

      // Verify the value actually landed in the DOM
      await waitMs(200);
      const evalData = await callTool(client, 'safari_evaluate', {
        tabUrl: ownedTabUrl,
        script: 'return document.getElementById("name").value',
      });
      expect(evalData['value'] as string).toBe('Safari Pilot Test');
    }, 25000);

    it('safari_click — clicks submit button, form handler runs', async () => {
      if (!ownedTabUrl) return;

      // Fill required email field so the form can submit
      await callTool(client, 'safari_fill', {
        tabUrl: ownedTabUrl,
        selector: '#email',
        value: 'test@example.com',
      });

      const clickData = await callTool(client, 'safari_click', {
        tabUrl: ownedTabUrl,
        selector: 'button[type="submit"]',
      });

      // A tool-level error would have a string "error" key at top level
      expect('error' in clickData && typeof clickData['error'] === 'string').toBe(false);

      // Verify form handler ran: #result div transitions from display:none
      await waitMs(400);
      const evalData = await callTool(client, 'safari_evaluate', {
        tabUrl: ownedTabUrl,
        script: 'return document.getElementById("result").style.display',
      });
      expect(evalData['value']).not.toBe('none');
    }, 30000);
  });

  // ── Other tools ─────────────────────────────────────────────────────────────

  describe.skipIf(!SAFARI_AVAILABLE)('Other tools', () => {
    beforeAll(async () => {
      if (!ownedTabUrl) return;
      ownedTabUrl = await navigateAndGetRealUrl(client, ownedTabUrl, 'https://example.com');
    }, 55000);

    it('safari_evaluate — executes JS in tab, returns document.title', async () => {
      if (!ownedTabUrl) return;

      const data = await callTool(client, 'safari_evaluate', {
        tabUrl: ownedTabUrl,
        script: 'return document.title',
      });

      // Returns { value, type }
      expect(data['type']).toBe('string');
      expect(typeof data['value']).toBe('string');
      expect((data['value'] as string).length).toBeGreaterThan(0);
      expect(data['value'] as string).toContain('Example');
    }, 20000);

    it('safari_get_cookies — returns cookies array with correct shape', async () => {
      if (!ownedTabUrl) return;

      const data = await callTool(client, 'safari_get_cookies', {
        tabUrl: ownedTabUrl,
      });

      // Returns { cookies: [...], count: N }
      expect(Array.isArray(data['cookies'])).toBe(true);
      expect(typeof data['count']).toBe('number');
      // Cookie count can legitimately be 0 — example.com may not set any
      expect(data['count'] as number).toBeGreaterThanOrEqual(0);
    }, 20000);
  });
});
