/**
 * Phase 5A · 5A.7 — dispatch boundary tests for the two new HAR tools:
 *   - safari_dump_har: reads window.__safariPilotNetwork.entries and returns
 *     a HAR 1.2 log via entriesToHar.
 *   - safari_route_from_har: takes a HAR log + options, computes mock rules
 *     via harToMockRules, installs each rule via the same in-page mock
 *     infrastructure that safari_mock_request uses (window.__safariPilotMocks).
 *
 * The pure transformer logic is fully covered by har-serialize.test.ts (15
 * tests) and har-route.test.ts (21 tests). THIS file exercises the dispatch
 * boundary — what scripts get sent, with what params, and what the handler
 * returns to MCP — using the recording-engine pattern established by
 * cookies-extension-bridge.test.ts and http-auth-dispatch.test.ts.
 *
 * Behavioral truth (real Safari → real fixture server → dump HAR → route
 * back → assert mocks fire) is verified in 5A7-har-record-replay.test.ts
 * (RED-5/GREEN-5 in this same cycle).
 */
import { describe, it, expect } from 'vitest';
import { NetworkTools } from '../../../src/tools/network.js';
import { entriesToHar, type InterceptEntry, type HarLog } from '../../../src/tools/har.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { Engine, EngineResult } from '../../../src/types.js';

interface RecordingEngine extends IEngine {
  scripts: string[];
  responseQueue: string[];
}

function recordingEngine(name: Engine = 'applescript', responses: string[] = ['{}']): RecordingEngine {
  const scripts: string[] = [];
  const responseQueue = [...responses];
  const e: RecordingEngine = {
    name,
    isAvailable: async () => true,
    execute: async () => ({ ok: true, value: '{}', elapsed_ms: 1 }),
    executeJsInTab: async (...args: unknown[]) => {
      scripts.push(args[1] as string);
      const value = responseQueue.shift() ?? '{}';
      return { ok: true, value, elapsed_ms: 1 } as EngineResult;
    },
    executeJsInFrame: async () => ({ ok: true, value: '{}', elapsed_ms: 1 }) as EngineResult,
    shutdown: async () => {},
    scripts,
    responseQueue,
  } as unknown as RecordingEngine;
  return e;
}

const baseEntry: InterceptEntry = {
  url: 'https://api.example.com/users/42',
  method: 'GET',
  status: 200,
  type: 'fetch',
  timestamp: 1714659600000,
  duration: 50,
  responseHeaders: { 'Content-Type': 'application/json' },
  responseBody: '{"id":42}',
};

describe('5A.7 — safari_dump_har dispatch boundary', () => {
  it('dispatches a script that reads window.__safariPilotNetwork.entries', async () => {
    // The handler queries the in-page interceptor buffer. The token presence
    // catches a regression where the dispatch reads the wrong global.
    const engine = recordingEngine('applescript', [JSON.stringify([])]);
    const tools = new NetworkTools(engine);
    const handler = tools.getHandler('safari_dump_har');
    if (!handler) throw new Error('safari_dump_har not registered');

    await handler({ tabUrl: 'https://x/page' });

    expect(engine.scripts).toHaveLength(1);
    expect(engine.scripts[0]).toContain('__safariPilotNetwork');
    expect(engine.scripts[0]).toContain('entries');
  });

  it('returns a valid HAR 1.2 log built from the entries the page returns', async () => {
    // The page returns the raw entries array as JSON. The TS handler runs
    // entriesToHar on the parsed entries and packages the HAR into the MCP
    // tool response. Test that the round-trip yields the same shape that
    // entriesToHar produces directly — proves the wiring without re-testing
    // entriesToHar's contract (which har-serialize covers).
    const entries: InterceptEntry[] = [baseEntry];
    const engine = recordingEngine('applescript', [JSON.stringify(entries)]);
    const tools = new NetworkTools(engine);
    const handler = tools.getHandler('safari_dump_har')!;
    const expected = entriesToHar(entries);

    const response = await handler({ tabUrl: 'https://x/page' });

    // The MCP response wraps the HAR log in content[0].text as JSON.
    const payload = JSON.parse(response.content[0]!.text!) as { har: HarLog; entryCount: number };
    expect(payload.har).toEqual(expected);
    expect(payload.entryCount).toBe(1);
  });

  it('returns an empty HAR (entryCount: 0) when the interceptor was never installed', async () => {
    // If the page returns null/undefined (because __safariPilotNetwork doesn't
    // exist), the handler must default to an empty entries array — not crash,
    // not return a malformed HAR. Useful for "dump anyway" debug flows.
    const engine = recordingEngine('applescript', ['null']);
    const tools = new NetworkTools(engine);
    const handler = tools.getHandler('safari_dump_har')!;

    const response = await handler({ tabUrl: 'https://x/page' });

    const payload = JSON.parse(response.content[0]!.text!) as { har: HarLog; entryCount: number };
    expect(payload.har.log.entries).toEqual([]);
    expect(payload.har.log.version).toBe('1.2');
    expect(payload.entryCount).toBe(0);
  });

  it('threads options.creatorVersion through to entriesToHar', async () => {
    // The handler accepts creatorVersion as an MCP wire param; entriesToHar
    // uses it to override the default package.json-sourced creator. A bug
    // that dropped the param on the floor would default silently — invisible
    // to the suite without this assertion.
    const engine = recordingEngine('applescript', [JSON.stringify([])]);
    const tools = new NetworkTools(engine);
    const handler = tools.getHandler('safari_dump_har')!;

    const response = await handler({
      tabUrl: 'https://x/page',
      creatorVersion: 'test-1.2.3-pinned',
    });
    const payload = JSON.parse(response.content[0]!.text!) as { har: HarLog };
    expect(payload.har.log.creator.version).toBe('test-1.2.3-pinned');
  });

  it('threads tabUrl through to engine.executeJsInTab', async () => {
    // safari_dump_har is tab-scoped — the buffer lives in that tab's window.
    // A bug that hardcoded the tabUrl would silently dump from the wrong tab.
    const engine = recordingEngine('applescript', [JSON.stringify([])]);
    let observed: string | null = null;
    // Override executeJsInTab to capture the first arg (tabUrl).
    engine.executeJsInTab = async (...args: unknown[]) => {
      observed = args[0] as string;
      engine.scripts.push(args[1] as string);
      return { ok: true, value: JSON.stringify([]), elapsed_ms: 1 } as EngineResult;
    };
    const tools = new NetworkTools(engine);
    const handler = tools.getHandler('safari_dump_har')!;

    await handler({ tabUrl: 'https://specific/tab.html' });
    expect(observed).toBe('https://specific/tab.html');
  });
});

describe('5A.7 — safari_route_from_har dispatch boundary', () => {
  it('returns installed:0 and dispatches NO mock-install scripts for an empty HAR', async () => {
    // Empty HAR → harToMockRules returns []. No rules to install → no engine
    // dispatches at all. A buggy impl that always dispatched a "noop install"
    // would inflate the script count.
    const engine = recordingEngine();
    const tools = new NetworkTools(engine);
    const handler = tools.getHandler('safari_route_from_har');
    if (!handler) throw new Error('safari_route_from_har not registered');

    const har = entriesToHar([]);
    const response = await handler({ tabUrl: 'https://x/page', har });

    expect(engine.scripts).toHaveLength(0);
    const payload = JSON.parse(response.content[0]!.text!) as { installed: number };
    expect(payload.installed).toBe(0);
  });

  it('installs one mock per surviving rule (default GET-only filter applied)', async () => {
    // 4 entries: 1 GET, 3 non-GET. With the default methodFilter (GET only),
    // harToMockRules emits 1 rule, so the handler dispatches exactly 1
    // mock-install script. Catches a regression where the handler bypasses
    // harToMockRules and installs everything indiscriminately.
    const har = entriesToHar([
      { ...baseEntry, method: 'GET',    url: 'https://x/a' },
      { ...baseEntry, method: 'POST',   url: 'https://x/b' },
      { ...baseEntry, method: 'PUT',    url: 'https://x/c' },
      { ...baseEntry, method: 'DELETE', url: 'https://x/d' },
    ]);
    const engine = recordingEngine();
    const tools = new NetworkTools(engine);
    const handler = tools.getHandler('safari_route_from_har')!;

    const response = await handler({ tabUrl: 'https://x/page', har });

    // 1 mock-install dispatch — the existing handleMockRequest's flow.
    expect(engine.scripts).toHaveLength(1);
    // The dispatched script must touch __safariPilotMocks — that's the
    // shared in-page state with safari_mock_request, the contract by which
    // mocks fire when fetches happen.
    expect(engine.scripts[0]).toContain('__safariPilotMocks');
    const payload = JSON.parse(response.content[0]!.text!) as { installed: number };
    expect(payload.installed).toBe(1);
  });

  it('honors options.methods (string[] form, not callback) to expand beyond GET', async () => {
    // The MCP wire is JSON — callbacks aren't transferable. The handler
    // exposes `methods: string[]` and internally builds the methodFilter
    // callback as `m => methods.includes(m)`. This test pins the wire shape.
    const har = entriesToHar([
      { ...baseEntry, method: 'GET',  url: 'https://x/a' },
      { ...baseEntry, method: 'POST', url: 'https://x/b' },
      { ...baseEntry, method: 'PUT',  url: 'https://x/c' },
    ]);
    const engine = recordingEngine();
    const tools = new NetworkTools(engine);
    const handler = tools.getHandler('safari_route_from_har')!;

    // User wants POST + PUT only — GET excluded, both others included.
    const response = await handler({
      tabUrl: 'https://x/page',
      har,
      methods: ['POST', 'PUT'],
    });

    expect(engine.scripts).toHaveLength(2);
    const payload = JSON.parse(response.content[0]!.text!) as { installed: number };
    expect(payload.installed).toBe(2);
  });

  it('honors options.includeErrors to opt status-0 entries into the rule set', async () => {
    const har = entriesToHar([
      { ...baseEntry, url: 'https://x/ok' },
      { ...baseEntry, url: 'https://x/failed', status: 0, error: 'NetworkError' },
    ]);

    // Default: status-0 entries skipped → 1 install.
    {
      const engine = recordingEngine();
      const tools = new NetworkTools(engine);
      const handler = tools.getHandler('safari_route_from_har')!;
      const resp = await handler({ tabUrl: 'https://x/page', har });
      expect(engine.scripts).toHaveLength(1);
      expect((JSON.parse(resp.content[0]!.text!) as { installed: number }).installed).toBe(1);
    }
    // Opt-in via includeErrors → 2 installs (fresh engine, cleaner than reset).
    {
      const engine = recordingEngine();
      const tools = new NetworkTools(engine);
      const handler = tools.getHandler('safari_route_from_har')!;
      const resp = await handler({ tabUrl: 'https://x/page', har, includeErrors: true });
      expect(engine.scripts).toHaveLength(2);
      expect((JSON.parse(resp.content[0]!.text!) as { installed: number }).installed).toBe(2);
    }
  });

  it('honors options.includeRedirects to opt 3xx entries into the rule set (sibling parity to includeErrors)', async () => {
    // Sibling toggle to includeErrors. Without explicit coverage, a wiring
    // regression that swapped the two flags would be invisible to the suite.
    const har = entriesToHar([
      { ...baseEntry, url: 'https://x/ok', status: 200 },
      { ...baseEntry, url: 'https://x/moved', status: 301 },
      { ...baseEntry, url: 'https://x/temp', status: 307 },
    ]);

    // Default: 3xx entries skipped → 1 install.
    {
      const engine = recordingEngine();
      const tools = new NetworkTools(engine);
      const handler = tools.getHandler('safari_route_from_har')!;
      const resp = await handler({ tabUrl: 'https://x/page', har });
      expect((JSON.parse(resp.content[0]!.text!) as { installed: number }).installed).toBe(1);
    }
    // Opt-in via includeRedirects → 3 installs.
    {
      const engine = recordingEngine();
      const tools = new NetworkTools(engine);
      const handler = tools.getHandler('safari_route_from_har')!;
      const resp = await handler({ tabUrl: 'https://x/page', har, includeRedirects: true });
      expect((JSON.parse(resp.content[0]!.text!) as { installed: number }).installed).toBe(3);
    }
  });

  it('returns the rules array in the response (lets callers inspect what was installed)', async () => {
    // Without exposing the rules in the response, callers can't reconcile
    // expected vs actual installs (especially after applying filters). The
    // shape is the same MockRule[] that harToMockRules returns — tested for
    // shape integrity in har-route.test.ts already; here we just verify the
    // handler exposes them.
    const har = entriesToHar([
      { ...baseEntry, url: 'https://x/users', responseBody: '[]' },
      { ...baseEntry, url: 'https://x/posts', responseBody: '[1,2]' },
    ]);
    const engine = recordingEngine();
    const tools = new NetworkTools(engine);
    const handler = tools.getHandler('safari_route_from_har')!;

    const response = await handler({ tabUrl: 'https://x/page', har });
    const payload = JSON.parse(response.content[0]!.text!) as {
      installed: number;
      rules: { urlPattern: string; response: { status: number; body: string; headers: Record<string, string> } }[];
    };

    expect(payload.installed).toBe(2);
    expect(payload.rules).toHaveLength(2);
    expect(payload.rules.map((r) => r.urlPattern)).toEqual(['https://x/users', 'https://x/posts']);
    expect(payload.rules[0]!.response.body).toBe('[]');
    expect(payload.rules[1]!.response.body).toBe('[1,2]');
  });

  it('threads tabUrl through to every per-rule dispatch (not hardcoded)', async () => {
    // Each rule installs into the SAME tab's __safariPilotMocks. A bug
    // that captured tabUrl from the first rule and then hardcoded it would
    // silently install all subsequent rules into the wrong tab.
    const har = entriesToHar([
      { ...baseEntry, url: 'https://x/a' },
      { ...baseEntry, url: 'https://x/b' },
      { ...baseEntry, url: 'https://x/c' },
    ]);
    const observed: string[] = [];
    const engine = recordingEngine();
    engine.executeJsInTab = async (...args: unknown[]) => {
      observed.push(args[0] as string);
      engine.scripts.push(args[1] as string);
      return { ok: true, value: '{}', elapsed_ms: 1 } as EngineResult;
    };
    const tools = new NetworkTools(engine);
    const handler = tools.getHandler('safari_route_from_har')!;

    await handler({ tabUrl: 'https://target/tab.html', har });

    expect(observed).toEqual([
      'https://target/tab.html',
      'https://target/tab.html',
      'https://target/tab.html',
    ]);
  });

  it('honors options.urlPatterns to limit replay to matching URL substrings', async () => {
    // urlPatterns is a user-friendly form of urlFilter — array of substrings,
    // any match keeps the rule. Common case: "only replay /api/* but skip
    // /auth/*" without writing a callback.
    const har = entriesToHar([
      { ...baseEntry, url: 'https://x/api/users' },
      { ...baseEntry, url: 'https://x/auth/login' },
      { ...baseEntry, url: 'https://x/api/posts' },
      { ...baseEntry, url: 'https://x/static/logo.png' },
    ]);
    const engine = recordingEngine();
    const tools = new NetworkTools(engine);
    const handler = tools.getHandler('safari_route_from_har')!;

    const response = await handler({
      tabUrl: 'https://x/page',
      har,
      urlPatterns: ['/api/'],
    });

    const payload = JSON.parse(response.content[0]!.text!) as {
      installed: number;
      rules: { urlPattern: string }[];
    };
    expect(payload.installed).toBe(2);
    expect(payload.rules.map((r) => r.urlPattern)).toEqual([
      'https://x/api/users',
      'https://x/api/posts',
    ]);
  });
});
