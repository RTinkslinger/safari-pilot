import { describe, it, expect } from 'vitest';
import { callTool } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('safari_tool_search e2e', () => {
  it('returns relevant hits for a keyword via MCP', async () => {
    const { client, nextId } = await getSharedClient();
    const r = await callTool(client, 'safari_tool_search', { query: 'table extract' }, nextId(), 10_000);
    const hits = (r['hits'] ?? []) as Array<{ name: string; score: number }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.name === 'safari_extract_tables')).toBe(true);
  });

  it('respects topK', async () => {
    const { client, nextId } = await getSharedClient();
    const r = await callTool(client, 'safari_tool_search', { query: 'safari', topK: 3 }, nextId(), 10_000);
    const hits = (r['hits'] ?? []) as unknown[];
    expect(hits.length).toBeLessThanOrEqual(3);
  });
});
