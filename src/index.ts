#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.js';

async function main(): Promise<void> {
  const safariPilot = await createServer();
  await safariPilot.start();

  const server = new Server(
    { name: 'safari-pilot', version: '0.1.4' },
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
