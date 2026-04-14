/**
 * PDF Export E2E Test — real MCP protocol, real Safari, real PDF files
 *
 * TRUE end-to-end: spawns `node dist/index.js` as a child process,
 * speaks MCP JSON-RPC over stdin/stdout, navigates Safari to a fixture page,
 * exports as PDF, and verifies the file exists on disk with valid content.
 *
 * NO MOCKS. NO SOURCE IMPORTS. Every assertion touches real file system state.
 *
 * Prerequisites:
 * - `npm run build` must have been run (tests use dist/index.js)
 * - Safari must be running with JS from Apple Events enabled
 * - SAFARI_AVAILABLE must not be 'false' and CI must not be 'true'
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { readFileSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

// ── Configuration ──────────────────────────────────────────────────────────

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');
const SAFARI_AVAILABLE = process.env.CI !== 'true' && process.env.SAFARI_AVAILABLE !== 'false';

// ── Helpers ────────────────────────────────────────────────────────────────

function waitMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Clean up a PDF file. Silently ignores missing files.
 */
function cleanupFile(filepath: string): void {
  try { unlinkSync(filepath); } catch { /* file may not exist */ }
}

/**
 * Create a minimal HTTP server that serves PDF test fixture pages.
 * Standalone test fixture — no source imports required.
 */
function createPdfFixtureServer(): { server: Server; getPort: () => number } {
  let port = 0;
  const server = createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/pdf-test-page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><title>E2E PDF Test</title></head>
<body>
  <h1>PDF Export E2E Test</h1>
  <p>Content for verification. This page is used by the Safari Pilot e2e test suite
     to verify that PDF export produces a real, valid PDF file on disk.</p>
  <ul>
    <li>Item one</li>
    <li>Item two</li>
    <li>Item three</li>
  </ul>
</body>
</html>`);
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  return {
    server,
    getPort: () => port,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PDF Export via MCP — real Safari, real files, no mocks', () => {
  let client: McpTestClient;
  const idRef = { value: 100 };

  // Fixture server
  let fixtureServer: Server;
  let fixturePort: number;

  // Tabs to clean up
  let ownedTabUrl: string | undefined;

  // Files to clean up
  const filesToCleanup: string[] = [];

  beforeAll(async () => {
    // Start fixture server on a random port
    const { server, getPort } = createPdfFixtureServer();
    fixtureServer = server;

    fixturePort = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Unexpected server address format'));
          return;
        }
        resolve(addr.port);
      });
    });

    // Start MCP client
    const init = await initClient(SERVER_PATH, 1);
    client = init.client;
    idRef.value = init.nextId;
  }, 25000);

  afterAll(async () => {
    // Close tab if we created one
    if (ownedTabUrl) {
      await callTool(client, 'safari_close_tab', { tabUrl: ownedTabUrl }, idRef.value++).catch(() => {});
    }

    // Close MCP client
    await client.close();

    // Stop fixture server
    await new Promise<void>((resolve, reject) => {
      fixtureServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Clean up any generated PDF files
    for (const f of filesToCleanup) {
      cleanupFile(f);
    }
  });

  // ── Test 1: Tool listing ─────────────────────────────────────────────────

  describe('tool listing', () => {
    it('safari_export_pdf appears in tools/list with expected schema', async () => {
      const resp = await client.send({
        jsonrpc: '2.0',
        id: idRef.value++,
        method: 'tools/list',
        params: {},
      }) as Record<string, unknown>;

      expect(resp).toMatchObject({ jsonrpc: '2.0' });
      expect(resp).not.toHaveProperty('error');

      const result = resp['result'] as Record<string, unknown>;
      const tools = result['tools'] as Array<Record<string, unknown>>;

      const pdfTool = tools.find((t) => t['name'] === 'safari_export_pdf');
      expect(pdfTool, 'safari_export_pdf must be in tools/list').toBeDefined();

      // Verify schema shape
      const schema = pdfTool!['inputSchema'] as Record<string, unknown>;
      expect(schema['type']).toBe('object');

      // path must be in required
      const required = schema['required'] as string[];
      expect(required).toContain('path');

      const properties = schema['properties'] as Record<string, unknown>;

      // format must have enum
      const formatProp = properties['format'] as Record<string, unknown>;
      expect(formatProp['type']).toBe('string');
      expect(formatProp['enum']).toEqual(['Letter', 'Legal', 'A4', 'A3', 'Tabloid']);

      // margin must be an object
      const marginProp = properties['margin'] as Record<string, unknown>;
      expect(marginProp['type']).toBe('object');
      expect(marginProp['properties']).toHaveProperty('top');
      expect(marginProp['properties']).toHaveProperty('right');
      expect(marginProp['properties']).toHaveProperty('bottom');
      expect(marginProp['properties']).toHaveProperty('left');

      // scale must exist
      const scaleProp = properties['scale'] as Record<string, unknown>;
      expect(scaleProp['type']).toBe('number');

      // Verify description is meaningful
      const desc = pdfTool!['description'] as string;
      expect(desc.length).toBeGreaterThan(20);
      expect(desc.toLowerCase()).toMatch(/pdf/);
    }, 15000);
  });

  // ── Test 2: Real PDF generation ──────────────────────────────────────────

  describe.skipIf(!SAFARI_AVAILABLE)('real PDF generation', () => {
    it('exports a fixture page as PDF and produces a valid file on disk', async () => {
      const outputPath = join(tmpdir(), `safari-pilot-e2e-pdf-${Date.now()}.pdf`);
      filesToCleanup.push(outputPath);

      // 1. Create a new tab
      const tabData = await callTool(
        client, 'safari_new_tab', {},
        idRef.value++, 15000,
      );
      expect(typeof tabData['tabUrl']).toBe('string');
      ownedTabUrl = tabData['tabUrl'] as string;

      // 2. Navigate to the fixture page
      const pageUrl = `http://localhost:${fixturePort}/pdf-test-page`;
      const navData = await callTool(
        client, 'safari_navigate',
        { url: pageUrl, tabUrl: ownedTabUrl },
        idRef.value++, 15000,
      );

      // Update tabUrl to the resolved URL from navigation
      if (typeof navData['url'] === 'string') {
        ownedTabUrl = navData['url'] as string;
      }

      // Wait for page to fully render
      await waitMs(2000);

      // 3. Export as PDF
      const pdfData = await callTool(
        client, 'safari_export_pdf',
        { path: outputPath, tabUrl: ownedTabUrl, timeout: 30000 },
        idRef.value++, 45000,
      );

      // 4. Verify response — PDF generation MUST succeed
      expect(
        pdfData['error'],
        `PDF export failed: ${JSON.stringify(pdfData)}`,
      ).toBeUndefined();

      expect(typeof pdfData['path']).toBe('string');
      expect(pdfData['path']).toBe(outputPath);
      expect(pdfData['pageCount']).toBeGreaterThan(0);
      expect(pdfData['fileSize']).toBeGreaterThan(0);
      expect(pdfData['source']).toBe('html');

      // 5. Verify file exists on disk
      const fileStat = statSync(outputPath);
      expect(fileStat.size).toBeGreaterThan(0);

      // 6. Verify PDF magic bytes
      const header = readFileSync(outputPath).subarray(0, 5).toString('ascii');
      expect(header).toBe('%PDF-');
    }, 60000);
  });

  // ── Test 3: Format comparison ────────────────────────────────────────────

  describe.skipIf(!SAFARI_AVAILABLE)('format comparison', () => {
    it('exports same page as Letter and A4, both succeed with different file sizes', async () => {
      const letterPath = join(tmpdir(), `safari-pilot-e2e-pdf-letter-${Date.now()}.pdf`);
      const a4Path = join(tmpdir(), `safari-pilot-e2e-pdf-a4-${Date.now()}.pdf`);
      filesToCleanup.push(letterPath, a4Path);

      // Ensure we have a tab navigated to the fixture page.
      // If Test 2 ran, ownedTabUrl is already on the fixture page.
      // If not (unlikely since skipIf is the same condition), create one.
      if (!ownedTabUrl) {
        const tabData = await callTool(
          client, 'safari_new_tab', {},
          idRef.value++, 15000,
        );
        ownedTabUrl = tabData['tabUrl'] as string;

        const pageUrl = `http://localhost:${fixturePort}/pdf-test-page`;
        const navData = await callTool(
          client, 'safari_navigate',
          { url: pageUrl, tabUrl: ownedTabUrl },
          idRef.value++, 15000,
        );
        if (typeof navData['url'] === 'string') {
          ownedTabUrl = navData['url'] as string;
        }
        await waitMs(2000);
      }

      // Export as Letter
      const letterData = await callTool(
        client, 'safari_export_pdf',
        { path: letterPath, tabUrl: ownedTabUrl, format: 'Letter', timeout: 30000 },
        idRef.value++, 45000,
      );

      expect(
        letterData['error'],
        `Letter PDF export failed: ${JSON.stringify(letterData)}`,
      ).toBeUndefined();
      expect(letterData['pageCount']).toBeGreaterThan(0);
      expect(letterData['fileSize']).toBeGreaterThan(0);

      // Verify Letter file on disk
      const letterStat = statSync(letterPath);
      expect(letterStat.size).toBeGreaterThan(0);
      const letterHeader = readFileSync(letterPath).subarray(0, 5).toString('ascii');
      expect(letterHeader).toBe('%PDF-');

      // Export as A4
      const a4Data = await callTool(
        client, 'safari_export_pdf',
        { path: a4Path, tabUrl: ownedTabUrl, format: 'A4', timeout: 30000 },
        idRef.value++, 45000,
      );

      expect(
        a4Data['error'],
        `A4 PDF export failed: ${JSON.stringify(a4Data)}`,
      ).toBeUndefined();
      expect(a4Data['pageCount']).toBeGreaterThan(0);
      expect(a4Data['fileSize']).toBeGreaterThan(0);

      // Verify A4 file on disk
      const a4Stat = statSync(a4Path);
      expect(a4Stat.size).toBeGreaterThan(0);
      const a4Header = readFileSync(a4Path).subarray(0, 5).toString('ascii');
      expect(a4Header).toBe('%PDF-');

      // Both must succeed but produce different file sizes
      // (Letter = 8.5x11in, A4 = 210x297mm — different dimensions = different rendering)
      expect(letterStat.size).not.toBe(a4Stat.size);
    }, 90000);
  });
});
