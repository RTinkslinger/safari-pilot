/**
 * Engine assertion helper for e2e tests.
 *
 * Wraps rawCallTool with an assertion that _meta.engine matches the expected engine.
 * Falls back to the __engine backup field embedded in result content (server.ts:622).
 */
import { type McpTestClient, rawCallTool } from './mcp-client.js';

export async function callToolExpectingEngine(
  client: McpTestClient,
  tool: string,
  args: Record<string, unknown>,
  expectedEngine: 'extension' | 'daemon' | 'applescript',
  nextId: number,
  timeout = 60_000,
): Promise<{ payload: Record<string, unknown>; meta: Record<string, unknown> }> {
  const { payload, meta, result } = await rawCallTool(client, tool, args, nextId, timeout);

  if (!meta?.engine) {
    const backupEngine = payload?.__engine;
    if (backupEngine) {
      if (backupEngine !== expectedEngine) {
        throw new Error(`${tool}: expected engine '${expectedEngine}' but got '${backupEngine}' (from __engine backup)`);
      }
      return { payload, meta: { engine: backupEngine } as Record<string, unknown> };
    }
    throw new Error(`${tool}: response missing _meta.engine AND __engine — result: ${JSON.stringify(result).slice(0, 200)}`);
  }

  if (meta.engine !== expectedEngine) {
    throw new Error(
      `${tool}: expected engine '${expectedEngine}' but got '${meta.engine}'` +
      ` — this means the engine selector is routing incorrectly`
    );
  }

  return { payload, meta: meta as Record<string, unknown> };
}
