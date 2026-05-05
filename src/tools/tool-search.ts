// src/tools/tool-search.ts
// safari_tool_search meta-tool — keyword search over the in-memory ToolIndex.
import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';
import type { ToolIndex } from '../discovery/tool-index.js';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}
type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class ToolSearchTools {
  private engine: IEngine;
  private index: ToolIndex;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: IEngine, index: ToolIndex) {
    this.engine = engine;
    this.index = index;
    this.handlers.set('safari_tool_search', this.handleSearch.bind(this));
  }

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_tool_search',
        description:
          'Search the safari-pilot tool catalog by keyword. Use when you cannot find a tool with the capability you need by name alone — e.g. searching "form fill", "table", "screenshot", "wait", "iframe". Returns top-K matches with descriptions.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              minLength: 1,
              description: 'Keyword(s) to search tool names + descriptions',
            },
            topK: {
              type: 'number',
              minimum: 1,
              maximum: 20,
              description: 'Max hits (default 8)',
            },
          },
          required: ['query'],
        },
        requirements: { idempotent: true },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  private async handleSearch(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const query = params['query'] as string;
    const topK = (params['topK'] as number | undefined) ?? 8;
    const hits = this.index.search(query, topK);
    return {
      content: [{ type: 'text', text: JSON.stringify({ hits }) }],
      metadata: {
        engine: this.engine.name as Engine,
        degraded: false,
        latencyMs: Date.now() - start,
      },
    };
  }
}
