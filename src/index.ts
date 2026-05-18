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
  // Bug-2 (2026-05-18) — STDIO_EOF added. claude exits its child via stdio
  // pipe close, no signal sent; without this branch the session window
  // leaked because Node drained the event loop and exited before
  // gracefulShutdown ran. Exit code 0 for the EOF path matches "clean
  // drain" (SIGINT keeps 130, SIGTERM keeps 143 for backward compat with
  // anything that grepped on the prior codes).
  const gracefulShutdown = async (reason: 'SIGINT' | 'SIGTERM' | 'STDIO_EOF'): Promise<void> => {
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
    const exitCode = reason === 'SIGINT' ? 130 : reason === 'SIGTERM' ? 143 : 0;
    process.exit(exitCode);
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
      // T30 — forward MCP `isError` from soft-return paths
      // (HumanApproval) so clients see protocol-level error semantics.
      ...(result.isError ? { isError: true } : {}),
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
  // Bug-2 (2026-05-18) — stdio EOF must flow through the same shutdown
  // path as SIGTERM/SIGINT, otherwise the session window leaks when the
  // parent (claude, vitest harness, etc.) closes the pipe instead of
  // sending a signal.
  //
  // The MCP SDK's StdioServerTransport listens for stdin 'data' and
  // 'error' events but NOT 'end' — so its `onclose` callback only fires
  // when a caller explicitly invokes `transport.close()`. Closing stdin
  // from the outside therefore does NOT propagate through the SDK; we
  // have to listen on the raw stream ourselves. Once 'end' fires, Node's
  // event loop drains and the process exits — registering the listener
  // is the difference between "shutdown ran" and "Node hard-exited."
  process.stdin.on('end', () => { void gracefulShutdown('STDIO_EOF'); });
  // 'close' fires after 'end' (or when stdin is destroyed). Belt-and-
  // suspenders for parents that abruptly destroy the pipe rather than
  // closing it cleanly. gracefulShutdown is idempotent (shuttingDown
  // flag), so double-firing is safe.
  process.stdin.on('close', () => { void gracefulShutdown('STDIO_EOF'); });
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Safari Pilot failed to start:', error);
  process.exit(1);
});
