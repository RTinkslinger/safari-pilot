/**
 * T78 B-3: safari_query_all MCP tool registration.
 * Verifies schema surface, requirements, and that the tool is registered
 * in ExtractionTools.getDefinitions().
 */
import { describe, expect, test } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';

const fakeEngine = {
  name: 'extension' as const,
  executeJsInTab: async () => ({ ok: true, value: '{}', elapsed_ms: 0 }),
  executeJsInFrame: async () => ({ ok: true, value: '{}', elapsed_ms: 0 }),
};

describe('T78 B-3 — safari_query_all registration', () => {
  test('safari_query_all is registered with rich payload schema', () => {
    const tools = new ExtractionTools(fakeEngine as never);
    const def = tools.getDefinitions().find((d) => d.name === 'safari_query_all');
    expect(def).toBeDefined();
    const props = (def!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props['limit']).toBeDefined();
    expect(props['role']).toBeDefined();
    expect(props['chain']).toBeDefined();
    expect(def!.requirements.idempotent).toBe(true);
  });
});
