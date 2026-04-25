/**
 * T7 — `safari_close_tab` must remove the closed tab from the
 * tab-ownership registry. The audit's M-finding flagged
 * `NavigationTools.handleCloseTab` (`src/tools/navigation.ts:304`) for
 * not calling `tabOwnership.removeTab()`. Verified during the
 * 2026-04-25 ledger reconciliation: the cleanup is already in place,
 * but it lives in `src/server.ts:833-852` ("8.post1: Tab ownership
 * removal") — the post-execution adoption logic that runs after every
 * tool. The Explore agent on the reconciliation pass missed this
 * because it only inspected navigation.ts.
 *
 * This test is a **regression guard** for the existing fix. If a
 * future change deletes the post-execution removeTab block at
 * server.ts:833-852, this test will fail. Without the guard, the
 * registry leak the audit warned about would re-emerge silently.
 *
 * Boundary mocks (per CLAUDE.md "Unit Tests" hard rules):
 *   - `node:child_process.execSync` — drives `checkWindowExists()`
 *   - `node:child_process.execFile` — drives `AppleScriptEngine.execute()`
 *   - global `fetch` — drives `checkExtensionStatus()`
 *
 * SD-29 pattern: vitest's `isolate: false` shares the module graph
 * across files; another test file (e.g. pre-call-gate.test.ts) that
 * imports SafariPilotServer first will load the dependency chain with
 * REAL execSync/execFile, and a top-level `vi.mock` here would arrive
 * too late. Register the mock with `vi.doMock` after `vi.resetModules`
 * and dynamic-import so the SUT is re-evaluated against the mocked
 * module.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';

let execSync: ReturnType<typeof vi.fn>;
let execFile: ReturnType<typeof vi.fn>;
type SafariPilotServerCtor = new (config: unknown) => {
  killSwitch: { isActive: () => boolean };
  tabOwnership: {
    registerTab: (id: number, url: string, opts?: { windowId: number; tabIndex: number }) => void;
    findByUrl: (url: string) => number | undefined;
  };
  registerTool: (def: unknown) => void;
};
type TabOwnershipNS = { makeTabId: (windowId: number, tabIndex: number) => number };
type AppleScriptEngineCtor = new () => unknown;
type NavigationToolsCtor = new (engine: unknown) => {
  getDefinitions: () => Array<{ name: string; description: string; inputSchema: Record<string, unknown>; requirements: { idempotent: boolean } }>;
  getHandler: (name: string) => unknown;
};

let SafariPilotServer: SafariPilotServerCtor;
let DEFAULT_CONFIG: unknown;
let TabOwnership: TabOwnershipNS;
let AppleScriptEngine: AppleScriptEngineCtor;
let NavigationTools: NavigationToolsCtor;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return { ...actual, execSync: vi.fn(), execFile: vi.fn() };
  });
  const cp = await import('node:child_process');
  execSync = cp.execSync as unknown as ReturnType<typeof vi.fn>;
  execFile = cp.execFile as unknown as ReturnType<typeof vi.fn>;

  const serverMod = await import('../../../src/server.js');
  SafariPilotServer = serverMod.SafariPilotServer as unknown as SafariPilotServerCtor;
  const cfgMod = await import('../../../src/config.js');
  DEFAULT_CONFIG = cfgMod.DEFAULT_CONFIG;
  const ownershipMod = await import('../../../src/security/tab-ownership.js');
  TabOwnership = ownershipMod.TabOwnership as unknown as TabOwnershipNS;
  const asMod = await import('../../../src/engines/applescript.js');
  AppleScriptEngine = asMod.AppleScriptEngine as unknown as AppleScriptEngineCtor;
  const navMod = await import('../../../src/tools/navigation.js');
  NavigationTools = navMod.NavigationTools as unknown as NavigationToolsCtor;
});

interface ServerInternals {
  _sessionWindowId?: number;
  executeToolWithSecurity: (name: string, params: Record<string, unknown>) => Promise<unknown>;
}

function setSessionWindowId(server: ReturnType<SafariPilotServerCtor>, id: number): void {
  (server as unknown as ServerInternals)._sessionWindowId = id;
}

function callExecuteToolWithSecurity(
  server: ReturnType<SafariPilotServerCtor>,
  name: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return (server as unknown as ServerInternals).executeToolWithSecurity(name, params);
}

describe('safari_close_tab tab-ownership registry hygiene (T7)', () => {
  beforeEach(() => {
    execSync.mockReset();
    execFile.mockReset();
    vi.unstubAllGlobals();
    execSync.mockReturnValue('true\n');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ext: true,
          mcp: true,
          sessionTab: true,
          lastPingAge: 100,
          activeSessions: 1,
        }),
      }),
    );
    execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb?: unknown) => {
      if (typeof cb === 'function') {
        (cb as (err: Error | null, result: { stdout: string; stderr: string }) => void)(
          null,
          { stdout: 'true\n', stderr: '' },
        );
      }
      return undefined;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes the closed tab from tabOwnership registry on successful close', async () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    setSessionWindowId(server, 99999);

    // Production initialise() does real I/O for daemon availability and
    // would not run cleanly in unit scope, so we register only the tool
    // the test exercises — wired exactly the way `initialize()` wires it.
    const engine = new AppleScriptEngine();
    const navTools = new NavigationTools(engine);
    const def = navTools.getDefinitions().find(d => d.name === 'safari_close_tab');
    if (!def) throw new Error('safari_close_tab definition not found in NavigationTools');
    const handler = navTools.getHandler('safari_close_tab');
    server.registerTool({ ...def, handler });

    const tabUrl = 'https://example.test/some-page';
    const tabId = TabOwnership.makeTabId(99999, 1);

    // Pre-register the tab so ownership check passes when close_tab fires.
    server.tabOwnership.registerTab(tabId, tabUrl, { windowId: 99999, tabIndex: 1 });

    expect(
      server.tabOwnership.findByUrl(tabUrl),
      'tabOwnership precondition: tab must be in registry before close',
    ).toBe(tabId);

    // Run the production tool through the security pipeline.
    let thrown: unknown;
    try {
      await callExecuteToolWithSecurity(server, 'safari_close_tab', { tabUrl });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'close_tab call should not throw on the happy path').toBeUndefined();

    // PRIMARY ORACLE — registry must no longer contain the closed tab.
    // The cleanup happens at server.ts:833-852 (post-execution adoption),
    // not inside NavigationTools.handleCloseTab. Removing that block
    // re-introduces the leak the audit warned about.
    expect(
      server.tabOwnership.findByUrl(tabUrl),
      'after safari_close_tab succeeds, tabOwnership.findByUrl must return undefined — '
        + 'the registry must reflect the now-closed state of the tab',
    ).toBeUndefined();
  });
});
