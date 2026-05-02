/**
 * Phase 5A · 5A.7 — HAR record & replay: `harToMockRules` matcher.
 *
 * Inverse of `entriesToHar`: given a HAR 1.2 log (from our own
 * `safari_dump_har` OR any external HAR source — Playwright export, browser
 * devtools, k6 — anything that speaks HAR), produce mock rules consumable
 * by Safari Pilot's existing `safari_mock_request` infrastructure
 * (`window.__safariPilotMocks` — see network.ts:594-670).
 *
 * Contract pinned here:
 *   - Output is `[{urlPattern, response: {status, body, headers}}, ...]` —
 *     the SAME shape `safari_mock_request` accepts directly. The future
 *     `safari_route_from_har` handler iterates this array and installs
 *     each rule via the existing dispatch path.
 *   - urlPattern is the entry's full URL (including query string). The
 *     existing infrastructure does substring matching, so the full URL
 *     uniquely identifies the request.
 *   - Default `methodFilter` is `m => m === 'GET'`. Reason: the existing
 *     `__safariPilotMocks` is keyed by urlPattern alone — two captures of
 *     the same URL with different methods would collapse to one rule.
 *     GET-only is the safe default for typical read-only replay; users
 *     opting into POST/PUT/DELETE replay accept the URL-collision caveat.
 *   - Status 0 (network errors) and 3xx (redirects) are EXCLUDED by default.
 *     Replaying a network error is a niche case; redirects mean the real
 *     URL changed, which mock-replay can't honor without additional
 *     extension work. Both are flag-opt-in.
 *   - Header array → Record collapse uses last-wins semantics
 *     (Object.fromEntries default), matching `Headers.set` JS API behavior.
 *   - Per-URL deduplication: if multiple entries with the same `urlPattern`
 *     survive filtering, the FIRST one wins. This matches Playwright's
 *     `routeFromHAR` first-occurrence-replay default. Sequential rotation
 *     across repeats is out of scope for this cycle.
 *
 * Pure function — no engine, no fs, no Safari. Chicago-school: real HAR
 * input shapes, real spec compliance, no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  entriesToHar,
  harToMockRules,
  type InterceptEntry,
  type HarLog,
  type MockRule,
} from '../../../src/tools/har.js';

// We build inputs by feeding entries through `entriesToHar` first — that
// guarantees the test inputs are byte-identical to what production HAR
// captures will look like, and exercises the full transformer pair.
const baseEntry: InterceptEntry = {
  url: 'https://api.example.com/users/42',
  method: 'GET',
  status: 200,
  type: 'fetch',
  timestamp: 1714659600000,
  duration: 50,
  responseHeaders: { 'Content-Type': 'application/json' },
  responseBody: '{"id":42,"name":"alice"}',
};

function harFrom(entries: InterceptEntry[]): HarLog {
  return entriesToHar(entries);
}

describe('5A.7 — harToMockRules (HAR 1.2 → mock rules for safari_mock_request)', () => {
  it('returns [] for an empty HAR log', () => {
    const rules = harToMockRules(harFrom([]));
    expect(rules).toEqual([]);
  });

  it('emits one rule for a single GET entry with body, status, and headers', () => {
    const rules = harToMockRules(harFrom([baseEntry]));
    expect(rules).toHaveLength(1);
    const rule = rules[0]!;
    // urlPattern is the full URL — the existing __safariPilotMocks does
    // substring matching, so a fetch to the SAME URL will match this rule.
    expect(rule.urlPattern).toBe('https://api.example.com/users/42');
    expect(rule.response.status).toBe(200);
    expect(rule.response.body).toBe('{"id":42,"name":"alice"}');
    // Header array collapsed to Record — case preserved, value preserved.
    expect(rule.response.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('emits empty body when the HAR response has no content.text', () => {
    // For a HEAD response, a 204 No Content, or an external HAR that omits
    // content.text — the rule's body is '' (empty string). The existing
    // safari_mock_request's `new Response(body, ...)` accepts '' fine; the
    // alternative `undefined` would coerce to "undefined" string, which
    // a fetch caller would receive as the literal four-character body.
    const rules = harToMockRules(harFrom([{
      ...baseEntry,
      responseBody: undefined,
    }]));
    expect(rules[0]!.response.body).toBe('');
  });

  it('preserves response body verbatim (no JSON parsing, no charset transcoding)', () => {
    // Litmus: a buggy implementation that JSON.parse'd content.text would
    // corrupt arbitrary text bodies (HTML, XML, CSV) and break replay. The
    // mock rule's body is what `new Response(body)` will receive — keep it
    // as the exact string the HAR captured.
    const html = '<!doctype html><html><body><p>café résumé</p></body></html>';
    const rules = harToMockRules(harFrom([{
      ...baseEntry,
      url: 'https://x/page.html',
      responseHeaders: { 'Content-Type': 'text/html; charset=utf-8' },
      responseBody: html,
    }]));
    expect(rules[0]!.response.body).toBe(html);
  });

  it('default methodFilter excludes non-GET entries (URL collision avoidance)', () => {
    // The existing __safariPilotMocks is keyed by urlPattern alone. Two
    // entries for the same URL with different methods would collapse to a
    // single rule (last-wins overwrite during installation), silently
    // breaking replay. Default GET-only is the safe behavior — opt-in
    // methodFilter is the escape hatch for users who know what they want.
    const har = harFrom([
      { ...baseEntry, method: 'GET', url: 'https://x/a' },
      { ...baseEntry, method: 'POST', url: 'https://x/b' },
      { ...baseEntry, method: 'PUT', url: 'https://x/c' },
      { ...baseEntry, method: 'DELETE', url: 'https://x/d' },
    ]);
    const rules = harToMockRules(har);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.urlPattern).toBe('https://x/a');
  });

  it('honors methodFilter override to include arbitrary methods', () => {
    const har = harFrom([
      { ...baseEntry, method: 'GET', url: 'https://x/a' },
      { ...baseEntry, method: 'POST', url: 'https://x/b' },
      { ...baseEntry, method: 'PUT', url: 'https://x/c' },
    ]);
    // User wants POST + PUT only. GET excluded because filter returns false.
    const rules = harToMockRules(har, {
      methodFilter: (m) => m === 'POST' || m === 'PUT',
    });
    const urls = rules.map((r) => r.urlPattern);
    expect(urls).toEqual(['https://x/b', 'https://x/c']);
  });

  it('honors urlFilter to scope replay to a subset of captured URLs', () => {
    const har = harFrom([
      { ...baseEntry, url: 'https://api.example.com/users/1' },
      { ...baseEntry, url: 'https://api.example.com/posts/1' },
      { ...baseEntry, url: 'https://cdn.example.com/static/logo.png' },
      { ...baseEntry, url: 'https://api.example.com/users/2' },
    ]);
    const rules = harToMockRules(har, {
      urlFilter: (u) => u.startsWith('https://api.example.com/users/'),
    });
    expect(rules.map((r) => r.urlPattern)).toEqual([
      'https://api.example.com/users/1',
      'https://api.example.com/users/2',
    ]);
  });

  it('skips status 0 (network error) entries by default', () => {
    // Replaying a network error means returning a fake 0 from the mock,
    // which downstream `new Response('', {status: 0})` rejects — Response
    // doesn't allow status < 200. Skip by default; opt-in escape hatch
    // available for unusual replay needs.
    const har = harFrom([
      { ...baseEntry, url: 'https://x/ok' },
      { ...baseEntry, url: 'https://x/failed', status: 0, error: 'NetworkError' },
    ]);
    const rules = harToMockRules(har);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.urlPattern).toBe('https://x/ok');
  });

  it('honors includeErrors to opt status 0 entries back in', () => {
    const har = harFrom([
      { ...baseEntry, url: 'https://x/failed', status: 0, error: 'fail' },
    ]);
    const rules = harToMockRules(har, { includeErrors: true });
    expect(rules).toHaveLength(1);
    expect(rules[0]!.response.status).toBe(0);
  });

  it('skips 3xx redirect entries by default (mock layer cannot honor Location semantics)', () => {
    // A 301/302/307/308 means the captured request was redirected — the real
    // response body lives at a DIFFERENT URL. Replaying the 3xx as a mock
    // would give a Response with no Location handling (mock pipeline doesn't
    // follow redirects). Skip by default to avoid corrupting the rule set
    // with non-replayable noise. 307 is the "trivially-wrong impl trap":
    // a buggy filter `status === 301 || 302 || 308` would let 307 through.
    const har = harFrom([
      { ...baseEntry, url: 'https://x/ok', status: 200 },
      { ...baseEntry, url: 'https://x/p1', status: 301 },
      { ...baseEntry, url: 'https://x/p2', status: 302 },
      { ...baseEntry, url: 'https://x/p3', status: 307 },
      { ...baseEntry, url: 'https://x/p4', status: 308 },
    ]);
    const rules = harToMockRules(har);
    expect(rules.map((r) => r.urlPattern)).toEqual(['https://x/ok']);
  });

  it.each([
    { status: 100, label: '100 Continue' },
    { status: 101, label: '101 Switching Protocols' },
    { status: 304, label: '304 Not Modified (3xx with no body, ambiguous — pinning skip)' },
  ])('skips by default at status-class boundary: $label', ({ status }) => {
    // 1xx are interim responses with no replayable body. 304 is a 3xx with
    // empty-body / use-cache semantics that the mock layer cannot honor
    // (no client-side cache integration). All three should be uniformly
    // skipped by default to keep the contract simple and predictable.
    const rules = harToMockRules(harFrom([
      { ...baseEntry, url: `https://x/s${status}`, status, responseBody: '' },
    ]));
    expect(rules).toEqual([]);
  });

  it('honors includeRedirects to opt 3xx entries back in', () => {
    const har = harFrom([
      { ...baseEntry, url: 'https://x/old', status: 301 },
      { ...baseEntry, url: 'https://x/permanent', status: 308 },
    ]);
    const rules = harToMockRules(har, { includeRedirects: true });
    expect(rules).toHaveLength(2);
    expect(rules.map((r) => r.response.status)).toEqual([301, 308]);
  });

  it('preserves entry order across multiple unique URLs (FIFO, no implicit sort)', () => {
    // Order matters for cases where multiple captured URLs share a
    // substring-overlap; the first installed rule's response wins for
    // overlapping fetches. (Existing __safariPilotMocks iterates Object.keys
    // and matches first-found-substring.)
    const har = harFrom([
      { ...baseEntry, url: 'https://x/c' },
      { ...baseEntry, url: 'https://x/a' },
      { ...baseEntry, url: 'https://x/b' },
    ]);
    const rules = harToMockRules(har);
    expect(rules.map((r) => r.urlPattern)).toEqual(['https://x/c', 'https://x/a', 'https://x/b']);
  });

  it('deduplicates by urlPattern (first occurrence wins) when same URL appears more than once', () => {
    // Polling endpoint pattern: the same URL gets captured 5 times, each
    // with potentially different responses. The existing mock infrastructure
    // can only store ONE response per pattern. First-wins matches Playwright's
    // routeFromHAR default behavior (matches first unmatched entry, but for
    // OUR static install-then-replay model, "first" means "first in HAR order").
    const har = harFrom([
      { ...baseEntry, url: 'https://x/poll', responseBody: 'first' },
      { ...baseEntry, url: 'https://x/poll', responseBody: 'second' },
      { ...baseEntry, url: 'https://x/poll', responseBody: 'third' },
    ]);
    const rules = harToMockRules(har);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.response.body).toBe('first'); // NOT 'third' (would be last-wins)
  });

  it('collapses duplicate header names with last-wins semantics (Headers.set behavior, last-of-N not last-of-2)', () => {
    // HAR allows duplicate header NAMES in the array (e.g. multiple Set-Cookie
    // values). Our Record<string,string> output cannot represent that. The
    // contract is: last value for a given (case-insensitive) name wins —
    // matches `new Headers().set(k, v)` JS behavior. This is a documented
    // lossy collapse; for full multi-value fidelity, use the raw HAR.
    //
    // Use THREE values for X-Order (not two) so that a stub that hardcodes
    // "the second of two" cannot pass. The semantic is "last of N", not
    // "second", which only triangulates with N >= 3.
    //
    // We bypass entriesToHar and craft the header array directly because
    // the Record input shape can't produce duplicate names.
    const har: HarLog = {
      log: {
        version: '1.2',
        creator: { name: 'Test', version: '0.0.0' },
        entries: [{
          startedDateTime: '2024-05-02T14:20:00.000Z',
          time: 50,
          request: {
            method: 'GET', url: 'https://x/cookies',
            httpVersion: 'HTTP/1.1', cookies: [], headers: [],
            queryString: [], headersSize: -1, bodySize: -1,
          },
          response: {
            status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1',
            cookies: [],
            headers: [
              { name: 'Set-Cookie', value: 'a=1' },
              { name: 'Set-Cookie', value: 'b=2' },
              { name: 'X-Order', value: 'a' },
              { name: 'X-Order', value: 'b' },
              { name: 'X-Order', value: 'c' },  // <-- last of 3, not last of 2
            ],
            content: { size: 0, mimeType: '' },
            redirectURL: '', headersSize: -1, bodySize: -1,
          },
          cache: {},
          timings: { send: 0, wait: 50, receive: 0, blocked: -1, dns: -1, connect: -1, ssl: -1 },
        }],
      },
    };
    const rules = harToMockRules(har);
    // Last value for each name wins — matches Headers.set semantics.
    expect(rules[0]!.response.headers).toEqual({
      'Set-Cookie': 'b=2',
      'X-Order': 'c', // load-bearing: NOT 'b' (would mean last-of-2 fix)
    });
  });

  it('emits empty-string body when responseBody is the empty string (distinct from undefined path)', () => {
    // A real 204 No Content or DELETE-success capture has responseBody: ''.
    // The contract: body is the empty string (NOT 'undefined' coerced via
    // String()). Same observable behavior as the responseBody-undefined
    // path, but the code path differs (truthy/falsy check on optional vs
    // empty string). Pin both.
    const rules = harToMockRules(harFrom([{ ...baseEntry, responseBody: '' }]));
    expect(rules[0]!.response.body).toBe('');
  });

  it('emits empty Record when responseHeaders is absent (NOT undefined, NOT a default-headers fixture)', () => {
    // baseEntry has Content-Type. Override to omit headers entirely; the
    // mock rule's headers MUST be the empty Record `{}`, not undefined,
    // not a defaulted set. A fetch consumer's `new Response(body, {headers})`
    // accepts {} fine but rejects undefined.
    const rules = harToMockRules(harFrom([{
      ...baseEntry,
      responseHeaders: undefined,
    }]));
    expect(rules[0]!.response.headers).toEqual({});
  });

  it('roundtrips through entriesToHar → harToMockRules → safari_mock_request shape (wire-format proxy)', () => {
    // End-to-end pure-pipe test: real interceptor entries → HAR → mock rules.
    // The output must JSON-serialize cleanly (this is the wire-format proxy
    // — when safari_route_from_har installs each rule via the existing
    // safari_mock_request handler, the body crosses MCP as JSON).
    const entries: InterceptEntry[] = [
      { ...baseEntry, url: 'https://x/users', responseBody: '[]' },
      { ...baseEntry, url: 'https://x/posts', status: 404, responseBody: 'not found' },
    ];
    const rules: MockRule[] = harToMockRules(harFrom(entries));
    const roundtripped = JSON.parse(JSON.stringify(rules));
    expect(roundtripped).toEqual(rules);
    // Sanity: shape matches what handleMockRequest's input schema expects
    // (urlPattern: string, response: {status, body, headers}) — exactly
    // those keys, no extras. A future drift that added e.g. `method` or
    // `delay` would silently be dropped by the existing handler, breaking
    // any downstream replay logic that expected method-aware behavior.
    for (const rule of rules) {
      expect(Object.keys(rule).sort()).toEqual(['response', 'urlPattern']);
      expect(Object.keys(rule.response).sort()).toEqual(['body', 'headers', 'status']);
      expect(typeof rule.urlPattern).toBe('string');
      expect(typeof rule.response.status).toBe('number');
      expect(typeof rule.response.body).toBe('string');
      expect(rule.response.headers).toBeTypeOf('object');
    }
  });

  it('passes the urlFilter the entry URL exactly as captured (no normalization, with query string)', () => {
    // Verify that urlFilter sees the raw URL (with query string, no
    // canonicalization, no trailing-slash trimming). A buggy implementation
    // that normalized URLs via `new URL()` would lose path/query nuances.
    let observed: string | null = null;
    harToMockRules(harFrom([{
      ...baseEntry,
      url: 'https://api.example.com/search?q=safari+pilot&limit=10',
    }]), {
      urlFilter: (u) => { observed = u; return true; },
    });
    expect(observed).toBe('https://api.example.com/search?q=safari+pilot&limit=10');
  });
});
