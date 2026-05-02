/**
 * Phase 5A · 5A.7 — HAR record & replay (real Safari, full pipeline).
 *
 * Closes the loop end-to-end through the shipped artifact:
 *   safari_intercept_requests (with header capture, path B GREEN-3)
 *     → safari_evaluate fires N fetches against /har-fixture
 *     → safari_dump_har returns HAR 1.2 log
 *     → assert HAR shape + Content-Type captured + body captured
 *     → safari_route_from_har installs mocks
 *     → safari_evaluate re-fires same fetches
 *     → assert mock fired (response body matches CAPTURED timestamp,
 *       not a fresh server-side timestamp)
 *
 * The /har-fixture endpoint returns `{ id, capturedAt }` where `capturedAt`
 * is the server's Date.now() at the moment of request — so a live fetch and
 * a replayed mock fetch return DIFFERENT capturedAt values. That's the
 * litmus: a passing test means the mock fired (returned the cached
 * capturedAt), not the live server.
 *
 * Path B / 5A.7 is page-side TS only — no extension rebuild needed; runs
 * against the existing v0.1.21 install.
 *
 * Companions to this file:
 *   - test/unit/tools/har-serialize.test.ts (15) — entriesToHar contract
 *   - test/unit/tools/har-route.test.ts (21) — harToMockRules contract
 *   - test/unit/tools/interceptor-header-capture.test.ts (3) — interceptor smoke gate
 *   - test/unit/tools/har-tools-dispatch.test.ts (13) — handler dispatch boundary
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    headers: { name: string; value: string }[];
    queryString: { name: string; value: string }[];
    postData?: { mimeType: string; text: string };
  };
  response: {
    status: number;
    headers: { name: string; value: string }[];
    content: { size: number; mimeType: string; text?: string };
  };
}

interface HarLog {
  log: {
    version: string;
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

describe('5A.7 — HAR record & replay (real Safari, full pipeline)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let tabUrl: string | null = null;
  let baseFetchUrl = '';

  // Helper: run JS in the page synchronously, capturing the return value.
  // safari_evaluate is the path the rest of these e2es use — it routes
  // through MCP → engine.executeJsInTab, which is the same path the
  // intercepted fetch (window.fetch override) intercepts.
  async function evalInTab(script: string): Promise<unknown> {
    const r = await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script,
      timeout: 5_000,
    }, nextId(), 15_000);
    return r['value'] ?? r['result'];
  }

  // Helper: fire a single fetch and wait briefly for it to land in the
  // interceptor buffer. We don't await the fetch from inside safari_evaluate
  // because main-world JS via the storage bus doesn't reliably await
  // Promises — pattern lifted from 5A.9. Slot the result on window so we
  // can poll it from the next call if needed; here we only need the
  // server-side capturedAt, which the interceptor records.
  async function fireFetch(id: string): Promise<void> {
    const url = `${baseFetchUrl}?id=${encodeURIComponent(id)}`;
    const slot = `__sp5A7_${id}`;
    await evalInTab(`
      window['${slot}'] = null;
      fetch('${url}', { headers: { 'X-Sp-Test': 'sp5A7-${id}' } })
        .then(function (r) { return r.json(); })
        .then(function (j) { window['${slot}'] = j; })
        .catch(function (e) { window['${slot}'] = { error: String(e) }; });
      return 'dispatched-${id}';
    `);
    // The fixture is local; 800ms is comfortable for a roundtrip + the
    // interceptor's loadend hook.
    await new Promise((r) => setTimeout(r, 800));
  }

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    baseFetchUrl = `http://127.0.0.1:${fixture.hostPort}/har-fixture`;

    // Open ONE tab on the fixture origin. The `/cookie-fixture` page is a
    // benign HTML page that returns 200; we use it as the "container" page
    // from which JS-initiated fetches to /har-fixture happen. (Same-origin
    // — both /cookie-fixture and /har-fixture share the host.)
    const target = `http://127.0.0.1:${fixture.hostPort}/cookie-fixture?sp_t5A7=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    tabUrl = r['tabUrl'] as string;
    await new Promise((r) => setTimeout(r, 1500));

    // Install the interceptor with body capture so the captured entries
    // include responseBody (HAR replay needs the body to mock).
    await callTool(client, 'safari_intercept_requests', {
      tabUrl,
      captureBody: true,
      maxEntries: 200,
    }, nextId(), 15_000);
  }, 60_000);

  afterAll(async () => {
    if (tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
    if (fixture) await fixture.close();
  }, 30_000);

  it('captures fetches and dumps a valid HAR 1.2 log with request + response headers', async () => {
    // Fire 3 distinct fetches. Each gets a unique ?id=, so the HAR contains
    // 3 distinct entries with predictable response bodies.
    await fireFetch('alpha');
    await fireFetch('beta');
    await fireFetch('gamma');

    const dump = await callTool(client, 'safari_dump_har', {
      tabUrl: tabUrl!,
    }, nextId(), 15_000);
    const payload = dump as { har: HarLog; entryCount: number };
    expect(payload.har.log.version).toBe('1.2');
    expect(payload.har.log.creator.name).toBe('Safari Pilot');
    // Should contain at least our 3 fetches; the page may have made other
    // fetches at load time, so use >= rather than ===.
    expect(payload.entryCount).toBeGreaterThanOrEqual(3);

    // Find our /har-fixture entries by URL substring.
    const ourEntries = payload.har.log.entries.filter(
      (e) => e.request.url.includes('/har-fixture'),
    );
    expect(ourEntries).toHaveLength(3);

    // Validate one entry's full shape: request headers captured (X-Sp-Test
    // sent in the fetch), response headers captured (Content-Type + the
    // fixture's X-Har-Id), response body captured.
    const sample = ourEntries.find((e) => e.request.url.includes('id=alpha'));
    expect(sample, `entry for id=alpha not found in: ${JSON.stringify(ourEntries.map((e) => e.request.url))}`).toBeDefined();
    const headerNames = sample!.request.headers.map((h) => h.name.toLowerCase());
    expect(headerNames, `request headers in HAR: ${JSON.stringify(sample!.request.headers)}`).toContain('x-sp-test');

    const responseHeaderNames = sample!.response.headers.map((h) => h.name.toLowerCase());
    expect(responseHeaderNames).toContain('content-type');
    expect(responseHeaderNames).toContain('x-har-id');

    // Body captured + Content-Type-derived mimeType.
    expect(sample!.response.content.mimeType).toMatch(/application\/json/);
    expect(sample!.response.content.text).toBeDefined();
    const parsed = JSON.parse(sample!.response.content.text!) as { id: string; capturedAt: number };
    expect(parsed.id).toBe('alpha');
    expect(typeof parsed.capturedAt).toBe('number');
  }, 60_000);

  it('replays via safari_route_from_har: re-fetched URL returns the CAPTURED timestamp, not a fresh one', async () => {
    // Phase 1: read what the interceptor captured for id=alpha (the live
    // response from the prior test). We need its capturedAt to compare.
    const dump1 = await callTool(client, 'safari_dump_har', {
      tabUrl: tabUrl!,
    }, nextId(), 15_000);
    const payload1 = dump1 as { har: HarLog };
    const alphaEntry = payload1.har.log.entries.find(
      (e) => e.request.url.includes('/har-fixture') && e.request.url.includes('id=alpha'),
    );
    expect(alphaEntry, 'alpha entry must exist from the previous test').toBeDefined();
    const capturedBody = JSON.parse(alphaEntry!.response.content.text!) as { id: string; capturedAt: number };
    const capturedTs = capturedBody.capturedAt;

    // Phase 2: install mocks via route_from_har. The HAR has 3 /har-fixture
    // entries (alpha, beta, gamma); default GET-only filter passes all 3
    // since they were GETs.
    const route = await callTool(client, 'safari_route_from_har', {
      tabUrl: tabUrl!,
      har: payload1.har,
    }, nextId(), 15_000);
    const routePayload = route as { installed: number; rules: { urlPattern: string }[] };
    // At least our 3 /har-fixture rules + possibly other GETs the page made.
    expect(routePayload.installed).toBeGreaterThanOrEqual(3);
    const ourRulePatterns = routePayload.rules.map((r) => r.urlPattern).filter((u) => u.includes('/har-fixture'));
    expect(ourRulePatterns).toHaveLength(3);

    // Phase 3: re-fetch id=alpha. The mock should fire, returning the
    // captured body with capturedTs unchanged. A LIVE fetch would return
    // a fresh capturedAt > capturedTs.
    //
    // Wait at least 5ms between original capture and replay so a live
    // fetch's Date.now() would differ measurably. (Local fixture is
    // millisecond-precise.)
    await new Promise((r) => setTimeout(r, 50));
    await evalInTab(`window['__sp5A7_alpha_replay'] = null;`);
    await evalInTab(`
      fetch('${baseFetchUrl}?id=alpha')
        .then(function (r) { return r.json(); })
        .then(function (j) { window['__sp5A7_alpha_replay'] = j; })
        .catch(function (e) { window['__sp5A7_alpha_replay'] = { error: String(e) }; });
      return 'dispatched-replay';
    `);
    await new Promise((r) => setTimeout(r, 500));

    const replayed = await evalInTab(`return window['__sp5A7_alpha_replay'];`) as { id: string; capturedAt: number } | { error: string };
    expect(replayed, `replay slot empty: ${JSON.stringify(replayed)}`).toBeDefined();
    expect('error' in replayed, `replay errored: ${JSON.stringify(replayed)}`).toBe(false);
    const replayedTyped = replayed as { id: string; capturedAt: number };
    expect(replayedTyped.id).toBe('alpha');
    // Litmus: capturedAt MUST equal the value captured in the prior phase —
    // proving the mock fired and returned the cached body, not the live
    // server-side Date.now().
    expect(replayedTyped.capturedAt).toBe(capturedTs);
  }, 60_000);

  it('passthrough: a URL NOT in the HAR is NOT mocked — returns a fresh server response', async () => {
    // Mocks only install for captured URL patterns. A new fetch to
    // ?id=delta has no matching rule, so the live server handles it and
    // returns a fresh capturedAt strictly greater than the prior alpha
    // capture (Date.now monotonic on the same process).
    await evalInTab(`window['__sp5A7_delta'] = null;`);
    const beforeMs = Date.now();
    await evalInTab(`
      fetch('${baseFetchUrl}?id=delta')
        .then(function (r) { return r.json(); })
        .then(function (j) { window['__sp5A7_delta'] = j; })
        .catch(function (e) { window['__sp5A7_delta'] = { error: String(e) }; });
      return 'dispatched-delta';
    `);
    await new Promise((r) => setTimeout(r, 500));

    const v = await evalInTab(`return window['__sp5A7_delta'];`) as { id: string; capturedAt: number } | { error: string };
    expect('error' in v, `delta fetch errored: ${JSON.stringify(v)}`).toBe(false);
    const vTyped = v as { id: string; capturedAt: number };
    expect(vTyped.id).toBe('delta');
    // Live response — capturedAt should be from after this test started.
    expect(vTyped.capturedAt).toBeGreaterThanOrEqual(beforeMs);
  }, 60_000);
});
