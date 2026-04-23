#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version;

async function main(): Promise<void> {
  const safariPilot = await createServer();

  // Register signal handlers BEFORE start(). start() is the call that creates
  // the Safari session window via AppleScript, and it blocks up to ~10s
  // waiting for the extension to connect. If SIGTERM arrives during that
  // window (which is exactly when vitest tears down a test file) and the
  // handler isn't registered yet, Node takes its default termination path
  // and the window leaks. Registering first means the handler is live for
  // every signal delivered after this line — including signals arriving
  // mid-start(). shutdown() is idempotent and safe to call even if
  // _sessionWindowId is still undefined.
  //
  // Only catchable signals are covered here. SIGKILL and hard crashes bypass
  // this handler by design — there is no userspace way to close the Safari
  // window in that case; a subsequent session's registerWithDaemon() /
  // orphan-sweep is the only remedy.
  let shuttingDown = false;
  const gracefulShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await Promise.race([
        safariPilot.shutdown(),
        new Promise<void>((r) => setTimeout(r, 3000)),
      ]);
    } catch (err) {
      console.error('Safari Pilot shutdown error:', err);
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
  process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });

  await safariPilot.start();

  const server = new Server(
    { name: 'safari-pilot', version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = safariPilot.getToolNames().map((name) => {
      const def = safariPilot.getToolDefinition(name)!;
      return {
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
      };
    });
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: params } = request.params;
    const result = await safariPilot.executeToolWithSecurity(name, params ?? {});
    return {
      content: result.content.map((c) => {
        if (c.type === 'image' && c.data) {
          return { type: 'image' as const, data: c.data, mimeType: c.mimeType ?? 'image/png' };
        }
        return { type: 'text' as const, text: c.text ?? '' };
      }),
      _meta: result.metadata ? {
        engine: result.metadata.engine,
        degraded: result.metadata.degraded,
        degradedReason: result.metadata.degradedReason,
        latencyMs: result.metadata.latencyMs,
        ...(result.metadata as Record<string, unknown>),
      } : undefined,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Safari Pilot failed to start:', error);
  process.exit(1);
});
