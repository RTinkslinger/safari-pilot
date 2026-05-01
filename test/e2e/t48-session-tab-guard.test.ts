/**
 * T48 — `safari_navigate` (and similar tabUrl-targeted tools) must refuse
 * to operate on the session dashboard tab.
 *
 * The session tab at `http://127.0.0.1:19475/session?id=<sessionId>` is
 * opened at server startup as the rendezvous for the daemon ↔ extension
 * handshake. It is intentionally NOT registered in `tabOwnership`, so
 * today the ownership check throws `TabUrlNotRecognizedError` for it on
 * non-extension paths. T48 adds explicit defense-in-depth — a hard guard
 * that fires regardless of which engine is selected, so a future
 * registry-laundering bug or an extension-path bypass cannot reach it.
 *
 * Pre-T48 expectation on `safari_navigate({tabUrl: <sessionUrl>, url: ...})`:
 *   may return generic TabUrlNotRecognizedError (functional protection
 *   via the ownership-not-registered path, but no explicit "session tab"
 *   semantics in the error).
 *
 * Post-T48: dedicated error mentioning "session" — clear semantics for
 * agent and humans, and the guard runs even for engines/paths that
 * bypass the ownership check.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('T48 — safari_navigate refuses session dashboard tab', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let sessionTabUrl: string | undefined;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;

    // Discover the session URL via safari_list_tabs (which skips ownership).
    // The session tab URL pattern is `http://127.0.0.1:19475/session?id=...`.
    const listed = await rawCallTool(client, 'safari_list_tabs', {}, nextId(), 10000);
    const text = JSON.stringify(listed.payload);
    const match = text.match(/http:\/\/127\.0\.0\.1:19475\/session\?id=[^"\s,\\]+/);
    if (match) sessionTabUrl = match[0];
  }, 30000);

  it('safari_list_tabs returns the session tab so we can target it', () => {
    expect(sessionTabUrl, 'session tab must be discoverable via list_tabs').toBeDefined();
    expect(sessionTabUrl).toMatch(/127\.0\.0\.1:19475\/session\?id=/);
  });

  it('safari_navigate against the session tab URL fails with the T48 dedicated error', async () => {
    if (!sessionTabUrl) throw new Error('precondition: session URL not discovered');
    const r = await rawCallTool(
      client, 'safari_navigate',
      { url: 'https://example.com/', tabUrl: sessionTabUrl },
      nextId(),
      15000,
    ).catch((err) => ({ payload: { _rawText: err.message, _isError: true }, meta: undefined, result: {} }));

    // Discrimination from the existing TabUrlNotRecognizedError (whose
    // message echoes the URL — which CONTAINS "session" by URL-substring
    // coincidence). The T48 guard must use distinctive wording that does
    // NOT appear in the URL or in TabUrlNotRecognizedError's template:
    //   • "dashboard" — the audit's term for this tab; not in the URL
    //   • "refused" — operative verb; not in the existing error template
    // Pre-T48, both pre-existing protections (TabUrlNotRecognizedError on
    // applescript path, deferred-fail-closed on extension path) lack
    // these tokens, so this test is RED until the dedicated guard ships.
    const errorText = (r.payload['_rawText'] as string | undefined)
      ?? JSON.stringify(r.payload);
    const lower = errorText.toLowerCase();
    expect(lower).toContain('dashboard');
    expect(lower).toContain('refused');
  }, 20000);

  it('safari_navigate against a NON-session unrecognized URL still fails (different error; no T48 wording)', async () => {
    // Triangulation: the new guard must be specific to the session tab,
    // not a blanket rename of TabUrlNotRecognizedError. A random
    // unrecognized URL must still hit the ownership-not-registered path
    // and NOT carry the T48 distinctive tokens.
    const r = await rawCallTool(
      client, 'safari_navigate',
      { url: 'https://example.com/', tabUrl: 'https://random-unowned.example.com/' },
      nextId(),
      15000,
    ).catch((err) => ({ payload: { _rawText: err.message, _isError: true }, meta: undefined, result: {} }));

    const errorText = (r.payload['_rawText'] as string | undefined)
      ?? JSON.stringify(r.payload);
    const lower = errorText.toLowerCase();
    expect(errorText.length).toBeGreaterThan(0);
    expect(lower).not.toContain('dashboard');
    expect(lower).not.toContain('refused');
  }, 20000);
});
