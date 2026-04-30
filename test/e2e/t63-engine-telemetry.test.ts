/**
 * T63 — engine telemetry honesty (e2e).
 *
 * Bug context: `safari_navigate` was returning result metadata
 * `{__engine: "extension"}` despite the actual execution path being raw
 * AppleScript. NavigationTools is constructed with AppleScriptEngine directly
 * (server.ts:316) bypassing the EngineProxy, but `selectedEngineName`
 * (server.ts:600) was 'extension' and got stamped into both `result.metadata.engine`
 * and the embedded JSON `__engine` field (server.ts:982, 997).
 *
 * The unit suite (`test/unit/engine-selector/applescript-only.test.ts`)
 * proves `selectEngine` honours the new `requiresApplescript` flag. THIS
 * suite is the architectural test the unit suite cannot perform: it runs
 * through the real MCP stack against real Safari and asserts the stamped
 * telemetry matches the engine that actually executed.
 *
 * Fail litmus: delete the `requiresApplescript: true` tag from
 * `safari_navigate`'s definition — this test goes red. Delete the
 * `requiresApplescript` branch in selectEngine — this test goes red.
 * That is the architectural coverage T63 needs.
 *
 * Pre-T63 expectation: `__engine === "extension"` (RED).
 * Post-T63 expectation: `__engine === "applescript"` (GREEN).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('T63 — engine telemetry matches actual execution path', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let tabUrl: string;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;

    const unique = `https://example.com/?sp_t63=${Date.now()}`;
    const tab = await rawCallTool(client, 'safari_new_tab', { url: unique }, nextId(), 15000);
    tabUrl = tab.payload['tabUrl'] as string;
    await new Promise(r => setTimeout(r, 2000));
  }, 30000);

  afterAll(async () => {
    if (client && tabUrl) {
      try { await rawCallTool(client, 'safari_close_tab', { tabUrl }, nextId(), 10000); } catch { /* already closed */ }
    }
  });

  it('safari_new_tab reports __engine === "applescript" (always-AppleScript handler)', async () => {
    const unique = `https://example.com/?sp_t63nt=${Date.now()}`;
    const r = await rawCallTool(client, 'safari_new_tab', { url: unique }, nextId(), 15000);
    expect(r.payload['__engine']).toBe('applescript');
    expect((r.meta ?? {})['engine']).toBe('applescript');
    // Cleanup the throwaway tab
    const newTabUrl = r.payload['tabUrl'] as string;
    if (newTabUrl) {
      try { await rawCallTool(client, 'safari_close_tab', { tabUrl: newTabUrl }, nextId(), 10000); } catch { /* */ }
    }
  }, 30000);

  it('safari_navigate reports __engine === "applescript" (this is the T63 primary regression case)', async () => {
    const r = await rawCallTool(
      client, 'safari_navigate',
      { url: 'https://httpbin.org/html', tabUrl },
      nextId(),
      30000,
    );
    expect(r.payload['__engine']).toBe('applescript');
    expect((r.meta ?? {})['engine']).toBe('applescript');
    tabUrl = r.payload['url'] as string;
  }, 35000);

  it('safari_list_tabs reports __engine === "applescript" (always-AppleScript enumeration)', async () => {
    const r = await rawCallTool(client, 'safari_list_tabs', {}, nextId(), 10000);
    expect(r.payload['__engine']).toBe('applescript');
    expect((r.meta ?? {})['engine']).toBe('applescript');
  }, 15000);

  it('safari_health_check reports __engine === "applescript" (no engine actually runs)', async () => {
    const r = await rawCallTool(client, 'safari_health_check', {}, nextId(), 10000);
    expect(r.payload['__engine']).toBe('applescript');
    expect((r.meta ?? {})['engine']).toBe('applescript');
  }, 15000);

  // Closes the reviewer's MAJOR finding: navigate_back / navigate_forward go
  // through the *deferred ownership* path (server.ts step 7d), distinct from
  // the primary safari_navigate flow. If the flag misbehaves on this branch,
  // this test catches it.
  it('safari_navigate_back reports __engine === "applescript" (deferred-ownership path)', async () => {
    const r = await rawCallTool(
      client, 'safari_navigate_back',
      { tabUrl },
      nextId(),
      15000,
    );
    expect(r.payload['__engine']).toBe('applescript');
    expect((r.meta ?? {})['engine']).toBe('applescript');
    if (r.payload['url']) tabUrl = r.payload['url'] as string;
  }, 20000);
});
