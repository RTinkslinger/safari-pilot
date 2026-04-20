/**
 * PDF Generation E2E Tests
 *
 * Verifies safari_export_pdf generates a valid PDF from a real Safari tab
 * through the real MCP protocol over stdin/stdout.
 *
 * Selector-only engine proof: verifies _meta.engine === 'extension' (the engine
 * selector routes through extension) AND that the physical PDF output exists.
 * PdfTools uses AppleScript internally, but the engine selector picks extension
 * as the routing layer — both facts are verified.
 *
 * Zero mocks. Zero source imports. Real Safari + daemon interaction.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { McpTestClient, initClient, callTool, rawCallTool } from '../helpers/mcp-client.js';
import { ensureExtensionAwake } from '../helpers/ensure-extension-awake.js';
import { callToolExpectingEngine } from '../helpers/assert-engine.js';

const SERVER_PATH = join(import.meta.dirname, '../../dist/index.js');

describe('PDF Generation E2E', () => {
  let client: McpTestClient;
  let nextId: number;
  let agentTabUrl: string;
  const pdfFiles: string[] = [];

  beforeAll(async () => {
    const init = await initClient(SERVER_PATH);
    client = init.client;
    nextId = init.nextId;
    const tabResult = await callTool(client, 'safari_new_tab', { url: 'https://example.com/?e2e=pdf-generation' }, nextId++, 20_000);
    agentTabUrl = tabResult['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 3000));
    nextId = await ensureExtensionAwake(client, agentTabUrl, nextId);
  }, 180_000);

  afterAll(async () => {
    try {
      // Clean up PDF files
      for (const f of pdfFiles) {
        try {
          if (existsSync(f)) unlinkSync(f);
        } catch {
          // Best effort
        }
      }
      if (agentTabUrl && client) {
        await callTool(client, 'safari_close_tab', { tabUrl: agentTabUrl }, nextId++, 10_000)
          .catch(() => {});
      }
    } finally {
      await client?.close().catch(() => {});
    }
  });

  it('safari_export_pdf generates a PDF file from example.com', async () => {
    const outputPath = `/tmp/safari-pilot-e2e-test-${Date.now()}.pdf`;
    pdfFiles.push(outputPath);

    const { payload, meta } = await callToolExpectingEngine(
      client,
      'safari_export_pdf',
      { path: outputPath, tabUrl: agentTabUrl },
      'extension',
      nextId++,
      60_000,
    );

    // Selector-only engine proof: extension was selected
    expect(meta!['engine']).toBe('extension');

    // Observable result: PDF was actually generated
    expect(payload['path']).toBe(outputPath);
    expect(payload['pageCount']).toBeGreaterThan(0);
    expect(payload['fileSize']).toBeGreaterThan(0);
  }, 120_000);

  it('generated PDF file exists on disk', async () => {
    const outputPath = `/tmp/safari-pilot-e2e-pdf-exists-${Date.now()}.pdf`;
    pdfFiles.push(outputPath);

    const { meta } = await callToolExpectingEngine(
      client,
      'safari_export_pdf',
      { path: outputPath, tabUrl: agentTabUrl },
      'extension',
      nextId++,
      60_000,
    );

    // Selector-only engine proof
    expect(meta!['engine']).toBe('extension');

    // Observable result: file is on disk
    expect(existsSync(outputPath)).toBe(true);
  }, 120_000);

  it('generated PDF starts with %PDF header (valid PDF)', async () => {
    const outputPath = `/tmp/safari-pilot-e2e-pdf-header-${Date.now()}.pdf`;
    pdfFiles.push(outputPath);

    const { meta } = await callToolExpectingEngine(
      client,
      'safari_export_pdf',
      { path: outputPath, tabUrl: agentTabUrl },
      'extension',
      nextId++,
      60_000,
    );

    // Selector-only engine proof
    expect(meta!['engine']).toBe('extension');

    // Observable result: valid PDF binary format
    expect(existsSync(outputPath)).toBe(true);

    const buffer = readFileSync(outputPath);
    expect(buffer.length).toBeGreaterThan(4);

    // PDF files start with the magic bytes "%PDF"
    const header = buffer.subarray(0, 4).toString('ascii');
    expect(header).toBe('%PDF');
  }, 120_000);
});
