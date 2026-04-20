/**
 * Functional extension wake probe.
 *
 * Sends a REAL command through the extension engine and waits for a response.
 * If the extension event page is dead, this waits up to 90s for the alarm cycle
 * (1-minute period) to wake it. Returns the updated nextId counter.
 *
 * Unlike the old wakeExtension(), this checks live presence, not historical state.
 */
import { type McpTestClient, rawCallTool } from './mcp-client.js';

export async function ensureExtensionAwake(
  client: McpTestClient,
  tabUrl: string,
  nextId: number,
): Promise<number> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { meta } = await rawCallTool(
        client,
        'safari_evaluate',
        { script: 'return 1', tabUrl },
        nextId++,
        attempt === 0 ? 90_000 : 30_000,
      );
      if (meta?.engine === 'extension') {
        return nextId;
      }
      // Wrong engine is a definitive failure, not a timeout — rethrow immediately
      throw new Error(
        `Extension wake probe: engine was '${meta?.engine}', expected 'extension'. ` +
        `Phase 0 fix may not be working — check handleInternalCommand in CommandDispatcher.swift`,
      );
    } catch (err) {
      const msg = (err as Error).message ?? '';
      const isTimeout = msg.includes('timeout') || msg.includes('Timeout');
      const isWrongEngine = msg.includes('expected \'extension\'');
      if (attempt === 0 && isTimeout && !isWrongEngine) {
        console.warn('Extension wake probe timed out, waiting for alarm cycle...');
        await new Promise(r => setTimeout(r, 30_000));
        continue;
      }
      if (attempt === 0 && !isTimeout) {
        // Non-timeout error on first attempt — rethrow immediately, don't waste 30s
        throw err;
      }
      throw new Error(`Extension not responding after 2 wake attempts: ${msg}`);
    }
  }
  throw new Error('Extension wake probe: unreachable');
}
