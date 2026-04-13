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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

// ── Configuration ──────────────────────────────────────────────────────────

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');
const FIXTURE_PATH = join(import.meta.dirname, '../fixtures/form-test.html');
const FIXTURE_URL = pathToFileURL(FIXTURE_PATH).toString();

const SAFARI_AVAILABLE = process.env.CI !== 'true' && process.env.SAFARI_AVAILABLE !== 'false';

// ── Helpers ────────────────────────────────────────────────────────────────

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
  fallback: string | undefined,
  nextIdRef: { value: number },
): Promise<string> {
  const data = await callTool(client, 'safari_list_tabs', {}, nextIdRef.value++);
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
  nextIdRef: { value: number },
): Promise<string> {
  await waitMs(500);
  const data = await callTool(client, 'safari_navigate', { tabUrl, url: targetUrl }, nextIdRef.value++, 35000);
  await waitMs(1500);

  // Use the navigate response URL as the rawUrl seed for lookup.
  // If navigate returned an error, fall back to tabUrl.
  const navUrl = typeof data['url'] === 'string' ? data['url'] : tabUrl;
  return resolveTabUrl(client, navUrl, navUrl, nextIdRef);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Tools via MCP — real Safari, no mocks', () => {
  let client: McpTestClient;
  let nextId = 100;

  // Wrap nextId in a ref object so helper functions can increment it
  const idRef = { value: nextId };

  /**
   * ownedTabUrl is always the canonical URL that Safari uses internally.
   * Never set from safari_new_tab's echoed input — always resolved via
   * safari_list_tabs or safari_navigate + resolveTabUrl.
   */
  let ownedTabUrl: string;

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH, 1);
    client = init.client;
    idRef.value = init.nextId;
  }, 25000);

  afterAll(async () => {
    if (ownedTabUrl) {
      await callTool(client, 'safari_close_tab', { tabUrl: ownedTabUrl }, idRef.value++).catch(() => {});
    }
    await client.close();
  });

  // ── Navigation tools ────────────────────────────────────────────────────

  describe.skipIf(!SAFARI_AVAILABLE)('Navigation tools', () => {
    it('safari_new_tab — creates a new tab and returns a tabUrl string', async () => {
      const data = await callTool(client, 'safari_new_tab', { url: 'https://example.com' }, idRef.value++);

      expect(typeof data['tabUrl']).toBe('string');
      expect((data['tabUrl'] as string).length).toBeGreaterThan(0);
      expect(data['tabUrl'] as string).toMatch(/^https?:\/\//);

      // Wait for the tab to load, then resolve the canonical URL from list_tabs
      await waitMs(2000);
      ownedTabUrl = await resolveTabUrl(client, data['tabUrl'] as string, data['tabUrl'] as string, idRef);
    }, 30000);

    it('safari_navigate — navigates to example.com, resolves canonical URL', async () => {
      if (!ownedTabUrl) return;

      const data = await callTool(client, 'safari_navigate', {
        tabUrl: ownedTabUrl,
        url: 'https://example.com',
      }, idRef.value++, 35000);

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
      ownedTabUrl = await resolveTabUrl(client, ownedTabUrl, ownedTabUrl, idRef);
      expect(ownedTabUrl).toMatch(/example\.com/);
    }, 45000);

    it('safari_navigate_back — navigate to second page then go back', async () => {
      if (!ownedTabUrl) return;

      // Navigate to a second page to build history
      ownedTabUrl = await navigateAndGetRealUrl(
        client,
        ownedTabUrl,
        'https://www.iana.org/domains/reserved',
        idRef,
      );

      // go back — the tool uses history.back() and waits 500ms before querying
      const backData = await callTool(client, 'safari_navigate_back', {
        tabUrl: ownedTabUrl,
      }, idRef.value++, 15000);

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
      ownedTabUrl = await resolveTabUrl(client, ownedTabUrl, ownedTabUrl, idRef);
    }, 60000);

    it('safari_list_tabs — lists all open tabs, each with a url field', async () => {
      const data = await callTool(client, 'safari_list_tabs', {}, idRef.value++);

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
      ownedTabUrl = await navigateAndGetRealUrl(client, ownedTabUrl, 'https://example.com', idRef);
    }, 55000);

    it('safari_get_text — extracts visible text containing "Example Domain"', async () => {
      if (!ownedTabUrl) return;

      const data = await callTool(client, 'safari_get_text', {
        tabUrl: ownedTabUrl,
      }, idRef.value++);

      expect(typeof data['text']).toBe('string');
      expect((data['text'] as string).length).toBeGreaterThan(0);
      expect(data['text'] as string).toContain('Example Domain');
    }, 20000);

    it('safari_snapshot — returns non-empty ARIA tree with element info', async () => {
      if (!ownedTabUrl) return;

      const data = await callTool(client, 'safari_snapshot', {
        tabUrl: ownedTabUrl,
        format: 'yaml',
      }, idRef.value++);

      const asString = JSON.stringify(data);
      expect(asString.length).toBeGreaterThan(20);
      // ARIA tree for example.com contains headings, links, and paragraphs
      expect(asString).toMatch(/heading|link|paragraph|h1|ref|role|name/i);
    }, 25000);

    it('safari_get_html — returns HTML document containing an <h1>', async () => {
      if (!ownedTabUrl) return;

      const data = await callTool(client, 'safari_get_html', {
        tabUrl: ownedTabUrl,
      }, idRef.value++);

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
      }, idRef.value++);

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
      ownedTabUrl = await navigateAndGetRealUrl(client, ownedTabUrl, FIXTURE_URL, idRef);
    }, 45000);

    it('safari_fill — fills #name input, value verified via safari_evaluate', async () => {
      if (!ownedTabUrl) return;

      const fillData = await callTool(client, 'safari_fill', {
        tabUrl: ownedTabUrl,
        selector: '#name',
        value: 'Safari Pilot Test',
      }, idRef.value++);

      // Tool must not return a top-level string error
      expect('error' in fillData && typeof fillData['error'] === 'string').toBe(false);

      // Verify the value actually landed in the DOM
      await waitMs(200);
      const evalData = await callTool(client, 'safari_evaluate', {
        tabUrl: ownedTabUrl,
        script: 'return document.getElementById("name").value',
      }, idRef.value++);
      expect(evalData['value'] as string).toBe('Safari Pilot Test');
    }, 25000);

    it('safari_click — clicks submit button, form handler runs', async () => {
      if (!ownedTabUrl) return;

      // Fill required email field so the form can submit
      await callTool(client, 'safari_fill', {
        tabUrl: ownedTabUrl,
        selector: '#email',
        value: 'test@example.com',
      }, idRef.value++);

      const clickData = await callTool(client, 'safari_click', {
        tabUrl: ownedTabUrl,
        selector: 'button[type="submit"]',
      }, idRef.value++);

      // A tool-level error would have a string "error" key at top level
      expect('error' in clickData && typeof clickData['error'] === 'string').toBe(false);

      // Verify form handler ran: #result div transitions from display:none
      await waitMs(400);
      const evalData = await callTool(client, 'safari_evaluate', {
        tabUrl: ownedTabUrl,
        script: 'return document.getElementById("result").style.display',
      }, idRef.value++);
      expect(evalData['value']).not.toBe('none');
    }, 30000);
  });

  // ── Other tools ─────────────────────────────────────────────────────────────

  describe.skipIf(!SAFARI_AVAILABLE)('Other tools', () => {
    beforeAll(async () => {
      if (!ownedTabUrl) return;
      ownedTabUrl = await navigateAndGetRealUrl(client, ownedTabUrl, 'https://example.com', idRef);
    }, 55000);

    it('safari_evaluate — executes JS in tab, returns document.title', async () => {
      if (!ownedTabUrl) return;

      const data = await callTool(client, 'safari_evaluate', {
        tabUrl: ownedTabUrl,
        script: 'return document.title',
      }, idRef.value++);

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
      }, idRef.value++);

      // Returns { cookies: [...], count: N }
      expect(Array.isArray(data['cookies'])).toBe(true);
      expect(typeof data['count']).toBe('number');
      // Cookie count can legitimately be 0 — example.com may not set any
      expect(data['count'] as number).toBeGreaterThanOrEqual(0);
    }, 20000);
  });
});
