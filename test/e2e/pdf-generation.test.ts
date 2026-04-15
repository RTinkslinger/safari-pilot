/**
 * PDF Generation E2E Tests
 *
 * Verifies safari_export_pdf generates a valid PDF from a real Safari tab
 * through the real MCP protocol over stdin/stdout.
 *
 * Zero mocks. Zero source imports. Real Safari + daemon interaction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { McpTestClient, initClient, callTool } from '../helpers/mcp-client.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe.skipIf(process.env.CI === 'true')('PDF Generation E2E', () => {
  let client: McpTestClient;
  let nextId: number;
  let tabUrl: string;
  const pdfFiles: string[] = [];

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;

    // Open a tab to example.com
    const newTab = await callTool(
      client,
      'safari_new_tab',
      { url: 'https://example.com' },
      nextId++,
      20000,
    );
    tabUrl = newTab['tabUrl'] as string;

    // Wait for page to fully load
    await new Promise((r) => setTimeout(r, 3000));

    // Resolve the actual tab URL
    const tabsResult = await callTool(client, 'safari_list_tabs', {}, nextId++, 10000);
    const tabs = tabsResult['tabs'] as Array<Record<string, unknown>>;
    const exampleTab = tabs.find(
      (t) => (t['url'] as string).includes('example.com'),
    );
    if (exampleTab) {
      tabUrl = exampleTab['url'] as string;
    }
  }, 40000);

  afterAll(async () => {
    // Clean up PDF files
    for (const f of pdfFiles) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        // Best effort
      }
    }

    // Clean up tab
    for (const url of [tabUrl, 'https://example.com/', 'https://example.com']) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: url }, nextId++, 10000);
      } catch {
        // Ignore
      }
    }
    if (client) await client.close();
  });

  it('safari_export_pdf generates a PDF file from example.com', async () => {
    const outputPath = `/tmp/safari-pilot-e2e-test-${Date.now()}.pdf`;
    pdfFiles.push(outputPath);

    const result = await callTool(
      client,
      'safari_export_pdf',
      {
        path: outputPath,
        tabUrl,
      },
      nextId++,
      45000,
    );

    // Check the result reports success
    expect(result['path']).toBe(outputPath);
    expect(result['pageCount']).toBeGreaterThan(0);
    expect(result['fileSize']).toBeGreaterThan(0);
  }, 50000);

  it('generated PDF file exists on disk', async () => {
    const outputPath = `/tmp/safari-pilot-e2e-pdf-exists-${Date.now()}.pdf`;
    pdfFiles.push(outputPath);

    await callTool(
      client,
      'safari_export_pdf',
      {
        path: outputPath,
        tabUrl,
      },
      nextId++,
      45000,
    );

    expect(existsSync(outputPath)).toBe(true);
  }, 50000);

  it('generated PDF starts with %PDF header (valid PDF)', async () => {
    const outputPath = `/tmp/safari-pilot-e2e-pdf-header-${Date.now()}.pdf`;
    pdfFiles.push(outputPath);

    await callTool(
      client,
      'safari_export_pdf',
      {
        path: outputPath,
        tabUrl,
      },
      nextId++,
      45000,
    );

    expect(existsSync(outputPath)).toBe(true);

    const buffer = readFileSync(outputPath);
    expect(buffer.length).toBeGreaterThan(4);

    // PDF files start with the magic bytes "%PDF"
    const header = buffer.subarray(0, 4).toString('ascii');
    expect(header).toBe('%PDF');
  }, 50000);
});
