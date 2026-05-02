/**
 * Phase 5A · 5A.7 — HAR record & replay: serialization helper.
 *
 * Pins the contract for `entriesToHar(entries, options?)`: a pure transformer
 * from the existing in-page interceptor buffer shape (window.__safariPilotNetwork.entries
 * — see src/tools/network.ts handleInterceptRequests) to a HAR 1.2 `log`
 * object as defined by http://www.softwareishard.com/blog/har-12-spec/.
 *
 * Why this test matters:
 *   - HAR is the interchange format that lets a Safari Pilot capture be
 *     replayed by ANY tool that speaks HAR (Playwright's routeFromHAR, browser
 *     devtools, k6, vegeta, etc.). If our shape diverges from the spec in
 *     subtle ways (e.g. headers as an object instead of an array of {name,value}),
 *     external tools silently treat the HAR as empty.
 *   - The transformation has to handle realistic interceptor data: optional
 *     headers (path B is enhancing the interceptor to capture them, but legacy
 *     captures won't have them yet), URL-embedded query strings, request and
 *     response bodies, and error entries (status === 0).
 *   - Entry ORDER must match capture order — replay matchers in routeFromHAR
 *     match first-found, so reordering corrupts replay sequence for repeat URLs.
 *
 * Path B note: the interceptor enhancement (capturing req/resp headers) is the
 * NEXT RED cycle. This file pins the transformer's behavior — given headers
 * are present, they roundtrip correctly; given they're absent, [] emits.
 *
 * Production call-site coverage: the wire path is `safari_dump_har` handler →
 * `entriesToHar` → JSON.stringify → MCP response. The handler doesn't exist
 * yet (RED-4 in this 5A.7 cycle). When that handler ships, its dispatch test
 * MUST verify the result of `entriesToHar` round-trips through `JSON.stringify`
 * to the MCP `content[0].text` payload without field loss. Test 11 below is
 * the proxy until then.
 *
 * Pure function — no engine, no fs (other than reading package.json for the
 * version assertion), no Safari. Chicago-school: real input shapes, real
 * spec compliance, no mocks.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  entriesToHar,
  type InterceptEntry,
  type HarLog,
} from '../../../src/tools/har.js';

const baseEntry: InterceptEntry = {
  url: 'https://api.example.com/users/42',
  method: 'GET',
  status: 200,
  type: 'fetch',
  timestamp: 1714659600000, // 2024-05-02T14:20:00.000Z UTC (deterministic; verified via new Date(ms).toISOString())
  duration: 123,
};

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PKG_VERSION = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8')).version as string;

describe('5A.7 — entriesToHar (interceptor → HAR 1.2)', () => {
  it('emits a minimal valid HAR 1.2 log when entries is empty', () => {
    const har = entriesToHar([]);
    expect(har.log.version).toBe('1.2');
    // Creator name MUST identify Safari Pilot for downstream tooling that
    // routes by creator (e.g. har-validator's known-source heuristics).
    expect(har.log.creator.name).toBe('Safari Pilot');
    // Pin the documented contract: default version is sourced from
    // package.json. A regression that hardcodes "0.0.0-default" would
    // mislead any HAR consumer routing by Safari Pilot version (e.g. for
    // bug compatibility shims). If we ever decide to decouple, drop both
    // this assertion AND the comment claiming package.json sourcing — they
    // move together.
    expect(har.log.creator.version).toBe(PKG_VERSION);
    expect(har.log.entries).toEqual([]);
  });

  it('translates a single fetch GET into a HAR entry with required HAR-validator fields', () => {
    const har = entriesToHar([baseEntry]);
    expect(har.log.entries).toHaveLength(1);
    const e = har.log.entries[0]!;

    // startedDateTime is ISO 8601 derived from timestamp — HAR replay tools
    // sort by this field, so the format must be parseable as a Date.
    expect(e.startedDateTime).toBe('2024-05-02T14:20:00.000Z');
    // `time` in HAR is total elapsed ms = sum of non-(-1) timings == duration.
    expect(e.time).toBe(123);

    // request: method, url, default httpVersion. Headers/queryString/cookies
    // must be EMPTY ARRAYS when source has no data — NOT undefined, NOT
    // populated with any default. Pin the literal `[]` to rule out a stub
    // that returns canned content.
    expect(e.request.method).toBe('GET');
    expect(e.request.url).toBe('https://api.example.com/users/42');
    expect(e.request.httpVersion).toBe('HTTP/1.1');
    expect(e.request.headers).toEqual([]);
    expect(e.request.queryString).toEqual([]);
    expect(e.request.cookies).toEqual([]);
    expect(e.request.headersSize).toBe(-1); // unknown — spec sentinel
    expect(e.request.bodySize).toBe(-1);

    // response: status, statusText synthesized from status, httpVersion,
    // and EMPTY arrays for headers/cookies (not undefined).
    expect(e.response.status).toBe(200);
    expect(e.response.statusText).toBe('OK'); // synthesized for known codes
    expect(e.response.httpVersion).toBe('HTTP/1.1');
    expect(e.response.headers).toEqual([]);
    expect(e.response.cookies).toEqual([]);
    expect(e.response.content.size).toBe(0); // no body captured
    expect(e.response.content.mimeType).toBe(''); // unknown — spec allows ''

    // cache: empty object is spec-compliant (no cache info captured).
    expect(e.cache).toEqual({});

    // timings: HAR-validator checks ALL timing fields, with -1 as the
    // "not measured" sentinel. We only have aggregate duration → emit as
    // wait, mark unmeasured fields as -1, send/receive as 0. Invariant:
    // time === sum of non-(-1) timings.
    expect(e.timings.send).toBe(0);
    expect(e.timings.wait).toBe(123);
    expect(e.timings.receive).toBe(0);
    expect(e.timings.blocked).toBe(-1);
    expect(e.timings.dns).toBe(-1);
    expect(e.timings.connect).toBe(-1);
    expect(e.timings.ssl).toBe(-1);
  });

  it('parses URL query string into queryString array (spec: name/value pairs, decoded)', () => {
    const har = entriesToHar([{
      ...baseEntry,
      url: 'https://api.example.com/search?q=safari+pilot&limit=10&empty=&q=again',
    }]);
    const qs = har.log.entries[0]!.request.queryString;
    // Order preserved as it appeared in URL — important for replay matchers
    // that hash the canonical query string. Repeated keys are emitted as
    // separate entries (HAR 1.2 spec allows duplicate `name`s).
    expect(qs).toEqual([
      { name: 'q', value: 'safari pilot' }, // + decoded to space
      { name: 'limit', value: '10' },
      { name: 'empty', value: '' }, // empty value preserved, not dropped
      { name: 'q', value: 'again' }, // duplicate key preserved in order
    ]);
    // request.url MUST keep the full original URL (HAR consumers rebuild
    // the request from request.url; query strings are parsed-AND-preserved).
    expect(har.log.entries[0]!.request.url).toBe(
      'https://api.example.com/search?q=safari+pilot&limit=10&empty=&q=again',
    );
  });

  it('emits empty queryString and ignores hash fragment for URLs without a query string', () => {
    // The interceptor records URLs verbatim. The transformer must:
    //   - URL with no `?` → queryString === [] (NOT undefined, NOT [{name:'',...}])
    //   - URL with `#fragment` → fragment is NOT leaked into queryString.values
    //     (a buggy split-on-? would put the fragment in the last value)
    const noQuery = entriesToHar([{ ...baseEntry, url: 'https://example.com/path' }]);
    expect(noQuery.log.entries[0]!.request.queryString).toEqual([]);

    const withHash = entriesToHar([{
      ...baseEntry,
      url: 'https://example.com/path?q=x#section-3',
    }]);
    const qs = withHash.log.entries[0]!.request.queryString;
    expect(qs).toEqual([{ name: 'q', value: 'x' }]); // no #section-3 leak
  });

  it('roundtrips request headers as the spec-compliant {name, value} array shape', () => {
    // Path B: the enhanced interceptor captures request headers as
    // Record<string, string>. The transformer MUST emit the spec-mandated
    // array-of-objects shape — NOT a Record, NOT a {key, val} alternate,
    // NOT a flat string. Use structural equality to pin the shape AND content
    // together so a stub returning {key, val} entries doesn't slip through
    // (the previous .map/.find chain would have).
    const har = entriesToHar([{
      ...baseEntry,
      method: 'POST',
      requestHeaders: {
        'Content-Type': 'application/json',
        'X-Trace-Id': 'abc-123',
        'Accept': 'application/json',
      },
    }]);
    const headers = har.log.entries[0]!.request.headers;
    expect(headers).toEqual(expect.arrayContaining([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Trace-Id', value: 'abc-123' },
      { name: 'Accept', value: 'application/json' },
    ]));
    expect(headers).toHaveLength(3); // no extras, no dropped headers
  });

  it('roundtrips response headers and infers content.mimeType from Content-Type', () => {
    const har = entriesToHar([{
      ...baseEntry,
      responseHeaders: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Response-Id': 'r-987',
      },
      responseBody: '{"ok":true}',
    }]);
    const e = har.log.entries[0]!;
    expect(e.response.headers).toEqual(expect.arrayContaining([
      { name: 'Content-Type', value: 'application/json; charset=utf-8' },
      { name: 'X-Response-Id', value: 'r-987' },
    ]));
    expect(e.response.headers).toHaveLength(2);
    // mimeType MUST be derived from Content-Type header so HAR consumers
    // can decode response.content.text correctly. A non-empty Content-Type
    // header with empty content.mimeType is a common HAR-export bug we're
    // explicitly preventing.
    expect(e.response.content.mimeType).toBe('application/json; charset=utf-8');
    expect(e.response.content.text).toBe('{"ok":true}');
    expect(e.response.content.size).toBe('{"ok":true}'.length);
  });

  it('preserves comma-containing header values as a single header entry (no auto-split)', () => {
    // A buggy implementation that splits on `,` would corrupt:
    //   - `Date: Mon, 02 May 2026 12:34:56 GMT` (split into 4 nonsensical entries)
    //   - `Cache-Control: no-cache, no-store, must-revalidate` (legitimate
    //     comma-joined directives that semantically belong together).
    // HAR spec says one entry per header VALUE, but the input shape
    // (Record<string, string>) gives us the comma-joined value as ONE string
    // — emit it as ONE entry. Multi-value-via-array-input is out of scope
    // until the interceptor migrates to Record<string, string[]>.
    const har = entriesToHar([{
      ...baseEntry,
      responseHeaders: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Date': 'Mon, 02 May 2026 12:34:56 GMT',
      },
    }]);
    const headers = har.log.entries[0]!.response.headers;
    expect(headers).toHaveLength(2); // exactly 2 entries — NOT 7 from naive split
    expect(headers).toEqual(expect.arrayContaining([
      { name: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
      { name: 'Date', value: 'Mon, 02 May 2026 12:34:56 GMT' },
    ]));
  });

  it('encodes request body as postData with mimeType from request headers', () => {
    const har = entriesToHar([{
      ...baseEntry,
      method: 'POST',
      url: 'https://api.example.com/users',
      requestHeaders: { 'Content-Type': 'application/json' },
      requestBody: '{"name":"alice"}',
    }]);
    const req = har.log.entries[0]!.request;
    // postData is OPTIONAL in HAR but required for replay matchers that
    // gate on body. When requestBody is present, postData MUST be emitted.
    expect(req.postData).toBeDefined();
    expect(req.postData?.mimeType).toBe('application/json');
    expect(req.postData?.text).toBe('{"name":"alice"}');
  });

  it('emits postData with empty mimeType when request body is present but no Content-Type header', () => {
    // Edge: an XHR `send(body)` without an explicit Content-Type. The
    // transformer must NOT crash, must NOT use undefined (HAR validators
    // reject `undefined` mimeType), and SHOULD emit `''` per HAR spec
    // section 4.7 (mimeType is required string, may be empty).
    const har = entriesToHar([{
      ...baseEntry,
      method: 'POST',
      requestBody: 'raw=payload',
      // no requestHeaders
    }]);
    const post = har.log.entries[0]!.request.postData;
    expect(post).toBeDefined();
    expect(post?.mimeType).toBe('');
    expect(post?.text).toBe('raw=payload');
  });

  it('omits postData entirely when no request body (not {text: ""}, which downstream tools misinterpret)', () => {
    // har-validator and Playwright's routeFromHAR both treat
    // postData: {text: ""} as "explicitly empty body" not "no body" — for a
    // GET that distinction matters because some matchers gate on body presence.
    // The contract: no body → no postData key.
    const har = entriesToHar([baseEntry]);
    expect(har.log.entries[0]!.request.postData).toBeUndefined();
  });

  it('preserves entry order across multiple captures (FIFO, no implicit sort, even with same timestamp)', () => {
    // Replay matchers like Playwright's routeFromHAR scan entries in order
    // and return the FIRST match. Reordering by URL/timestamp/etc. would
    // break replay of repeat-URL sequences (e.g. polling endpoints).
    // Two of these entries share a timestamp — a sort-by-timestamp regression
    // would have an unstable result here; insertion order must dominate.
    const har = entriesToHar([
      { ...baseEntry, url: 'https://x/a', timestamp: 1714659603000 },
      { ...baseEntry, url: 'https://x/b', timestamp: 1714659601000 },
      { ...baseEntry, url: 'https://x/c', timestamp: 1714659601000 },
      { ...baseEntry, url: 'https://x/d', timestamp: 1714659602000 },
    ]);
    const urls = har.log.entries.map((e) => e.request.url);
    expect(urls).toEqual(['https://x/a', 'https://x/b', 'https://x/c', 'https://x/d']);
  });

  it('records a failed request (status 0 + error string) with _errorMessage and consistent timing', () => {
    // The interceptor records network errors with status: 0 and an `error`
    // string. HAR 1.2 doesn't have a dedicated error shape — convention is
    // status 0 + empty statusText, with the original message preserved as
    // a custom underscore-prefixed key (HAR spec section 2.4 allows these).
    const har = entriesToHar([{
      ...baseEntry,
      status: 0,
      duration: 50,
      error: 'NetworkError: Failed to fetch',
    }]);
    const entry = har.log.entries[0]!;
    expect(entry.response.status).toBe(0);
    expect(entry.response.statusText).toBe(''); // unknown for failed requests
    expect((entry.response as Record<string, unknown>)['_errorMessage']).toBe('NetworkError: Failed to fetch');
    // Time/timings invariants must still hold even for errors — replay tools
    // sort and budget by these fields.
    expect(entry.time).toBe(50);
    expect(entry.timings.wait).toBe(50);
  });

  it('omits _errorMessage when status === 0 but no error field is present (in-flight snapshot)', () => {
    // The interceptor initializes status: 0 BEFORE the response lands. A buffer
    // dumped mid-flight contains entries with status:0 and no error string.
    // The transformer must NOT emit `_errorMessage: undefined` (which would
    // serialize as missing in JSON but show up to consumers walking
    // `Object.keys` in unserialized form). Pin: the key is OMITTED entirely.
    const har = entriesToHar([{
      ...baseEntry,
      status: 0,
      duration: 0,
      // no error field set
    }]);
    const respKeys = Object.keys(har.log.entries[0]!.response);
    expect(respKeys).not.toContain('_errorMessage');
  });

  it('honors options.creatorVersion when supplied, overriding the package.json default', () => {
    // Allows consumers (e.g. golden-fixture tests, custom integrators) to pin
    // a specific creator version in the HAR rather than coupling to release
    // cadence. The override MUST work even when the default test (test 1)
    // would have passed against the same hardcoded value, so use a value that
    // CANNOT be the package.json version.
    const sentinel = '999.999.999-test-override';
    expect(sentinel).not.toBe(PKG_VERSION); // sanity — guarantees the override is doing real work
    const har = entriesToHar([], { creatorVersion: sentinel });
    expect(har.log.creator.version).toBe(sentinel);
  });

  it('produces output that is JSON-serializable without throwing (round-trip safe — wire-format proxy)', () => {
    // Litmus: any value the transformer puts into the output must survive
    // JSON.stringify → JSON.parse, which is the on-wire contract for
    // safari_dump_har's tool response. A bug that emitted a Date object,
    // a Map, or undefined-as-key would silently corrupt the wire format.
    // This is a PROXY for handler-level call-site coverage; the future
    // safari_dump_har handler test will exercise the real wire path.
    const har: HarLog = entriesToHar([
      baseEntry,
      { ...baseEntry, status: 0, error: 'fail' },
      { ...baseEntry, requestBody: '{}', responseBody: '{}' },
      { ...baseEntry, requestHeaders: { 'X-A': 'b' }, responseHeaders: { 'Content-Type': 'text/plain' } },
    ]);
    const roundtripped = JSON.parse(JSON.stringify(har));
    expect(roundtripped).toEqual(har);
  });
});
