/**
 * Phase 5A · 5A.9 — HTTP basic auth via DNR header injection.
 *
 * Per docs/research/p3-http-auth-research.md §7, the recommended approach
 * is to inject `Authorization: Basic base64(user:pass)` via Safari's
 * declarativeNetRequest API, exposed by the existing `dnr_add_rule`
 * background command. To reach that command from the TS engine path
 * (which dispatches via `executeJsInTab`), a new sentinel
 * `__SP_DNR_ADD_RULE__` is intercepted in `extension/background.js
 * executeCommand` and routed to `handleDnrAddRule`. Symmetric removal
 * via `__SP_DNR_REMOVE_RULE__`.
 *
 * No AppleScript fallback exists — DNR only lives in the extension.
 * Calling without the extension engine throws EXTENSION_REQUIRED so the
 * MCP caller can surface a clear remediation hint.
 *
 * This test pins the dispatch boundary: the script string sent to the
 * engine, including the rule's shape (action.requestHeaders Authorization
 * header with Basic-prefixed base64 credentials, condition.urlFilter from
 * urlPattern). The companion e2e (5A9-http-basic-auth.test.ts) exercises
 * the full chain through Safari and a fixture server with a 401 challenge.
 */
import { describe, it, expect } from 'vitest';
import { AuthTools } from '../../../src/tools/auth.js';
import { SafariPilotError, ERROR_CODES } from '../../../src/errors.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { Engine, EngineResult } from '../../../src/types.js';

const ADD_RULE = '__SP_DNR_ADD_RULE__';
const REMOVE_RULE = '__SP_DNR_REMOVE_RULE__';

function recordingEngine(name: Engine, response: string): IEngine & { scripts: string[]; tabUrls: string[] } {
  const scripts: string[] = [];
  const tabUrls: string[] = [];
  const e = {
    name,
    isAvailable: async () => true,
    execute: async () => ({ ok: true, value: response, elapsed_ms: 1 }),
    executeJsInTab: async (...args: unknown[]) => {
      tabUrls.push(args[0] as string);
      scripts.push(args[1] as string);
      return { ok: true, value: response, elapsed_ms: 1 } as EngineResult;
    },
    executeJsInFrame: async () => ({ ok: true, value: response, elapsed_ms: 1 }) as EngineResult,
    shutdown: async () => {},
    scripts,
    tabUrls,
  } as unknown as IEngine & { scripts: string[]; tabUrls: string[] };
  return e;
}

describe('5A.9 — http auth via DNR sentinel dispatch', () => {
  // ── safari_authenticate (add) ────────────────────────────────────────

  it('extension engine: dispatches __SP_DNR_ADD_RULE__ sentinel with parsed rule object', async () => {
    const engine = recordingEngine('extension', JSON.stringify({ added: true, ruleId: 1234 }));
    const tools = new AuthTools(engine);
    const handler = tools.getHandler('safari_authenticate')!;
    await handler({ tabUrl: 'https://api.example.com/', username: 'alice', password: 's3cret', urlPattern: '*://api.example.com/*' });

    expect(engine.scripts).toHaveLength(1);
    const dispatched = engine.scripts[0]!;
    expect(dispatched.startsWith(ADD_RULE)).toBe(true);
    expect(dispatched.charAt(ADD_RULE.length)).toBe(':');
  });

  it('extension engine: rule contains Authorization header with Basic-prefixed base64 credentials', async () => {
    const engine = recordingEngine('extension', JSON.stringify({ added: true, ruleId: 1234 }));
    const tools = new AuthTools(engine);
    const handler = tools.getHandler('safari_authenticate')!;
    await handler({ tabUrl: 'https://api.example.com/', username: 'alice', password: 's3cret' });

    const dispatched = engine.scripts[0]!;
    const params = JSON.parse(dispatched.slice(ADD_RULE.length + 1));
    // The DNR rule lives under params.rule (handleDnrAddRule signature).
    // action.type must be 'modifyHeaders'; the requestHeaders[0] must set
    // Authorization to Basic <base64(user:pass)>.
    const expectedB64 = Buffer.from('alice:s3cret', 'utf-8').toString('base64');
    expect(params.rule).toBeDefined();
    expect(params.rule.action.type).toBe('modifyHeaders');
    expect(params.rule.action.requestHeaders).toEqual([
      { header: 'Authorization', operation: 'set', value: `Basic ${expectedB64}` },
    ]);
  });

  it('extension engine: rule.condition.urlFilter takes the urlPattern when provided', async () => {
    const engine = recordingEngine('extension', JSON.stringify({ added: true, ruleId: 5 }));
    const tools = new AuthTools(engine);
    const handler = tools.getHandler('safari_authenticate')!;
    await handler({ tabUrl: 'https://api.example.com/', username: 'u', password: 'p', urlPattern: '*://api.example.com/*' });

    const params = JSON.parse(engine.scripts[0]!.slice(ADD_RULE.length + 1));
    expect(params.rule.condition.urlFilter).toBe('*://api.example.com/*');
  });

  it('extension engine: returns a stable numeric ruleId DERIVED LOCALLY from urlPattern (not echoed from engine)', async () => {
    // Stable ID lets the agent call clear_authentication WITHOUT having to
    // remember the id from the add call — same urlPattern always yields the
    // same rule slot. Replays therefore replace, not duplicate.
    //
    // Engine returns NO ruleId in its response. A misimpl that just echoes
    // engine.value.ruleId would surface `undefined` here and fail the
    // typeof === 'number' check. The id must be COMPUTED locally before
    // dispatch — proven below by matching the response's ruleId to the
    // dispatched rule.id (which lands in the sentinel JSON BEFORE the
    // engine ever sees it).
    const engine = recordingEngine('extension', JSON.stringify({ /* no ruleId */ added: true }));
    const tools = new AuthTools(engine);
    const handler = tools.getHandler('safari_authenticate')!;
    const r1 = await handler({ tabUrl: 'https://api.example.com/v1', username: 'u', password: 'p', urlPattern: '*://api.example.com/*' });
    const r2 = await handler({ tabUrl: 'https://api.example.com/v1', username: 'u', password: 'p', urlPattern: '*://api.example.com/*' });

    const id1 = JSON.parse((r1.content[0] as { text: string }).text).ruleId;
    const id2 = JSON.parse((r2.content[0] as { text: string }).text).ruleId;
    expect(typeof id1).toBe('number');
    expect(id1).toBe(id2);
    // Local-derivation proof: the id surfaced to the caller must match the
    // id baked into the dispatched rule object. If the SUT were echoing
    // the engine's response (which has no ruleId), id1 would be undefined.
    const dispatched1 = JSON.parse(engine.scripts[0]!.slice(ADD_RULE.length + 1));
    const dispatched2 = JSON.parse(engine.scripts[1]!.slice(ADD_RULE.length + 1));
    expect(dispatched1.rule.id).toBe(id1);
    expect(dispatched2.rule.id).toBe(id1);
  });

  it('extension engine: explicit authType:"basic" produces the SAME rule shape as the unset default (no silent ignore)', async () => {
    const engine = recordingEngine('extension', JSON.stringify({ added: true }));
    const tools = new AuthTools(engine);
    const handler = tools.getHandler('safari_authenticate')!;
    // Spec lists authType as a parameter. A misimpl that branches on authType
    // and emits a different rule shape (or ignores the basic case entirely)
    // would pass a "doesn't throw" assertion. Pinning the resulting rule
    // body proves authType:'basic' is genuinely equivalent to the default —
    // i.e., the only currently-supported branch is implemented correctly.
    await handler({ tabUrl: 'https://api.example.com/', username: 'alice', password: 's3cret', urlPattern: '*://api.example.com/*', authType: 'basic' });

    const dispatched = engine.scripts[0]!;
    expect(dispatched.startsWith(ADD_RULE)).toBe(true);
    const params = JSON.parse(dispatched.slice(ADD_RULE.length + 1));
    const expectedB64 = Buffer.from('alice:s3cret', 'utf-8').toString('base64');
    // Same oracle as test 2 — explicit basic must produce the same Basic
    // header. Different shape would prove a hidden authType branch.
    expect(params.rule.action.type).toBe('modifyHeaders');
    expect(params.rule.action.requestHeaders).toEqual([
      { header: 'Authorization', operation: 'set', value: `Basic ${expectedB64}` },
    ]);
  });

  it('extension engine: different urlPatterns produce different ruleIds (no slot collisions for distinct sites)', async () => {
    // Mutation guard: a hardcoded id (e.g. always 1000) would break when an
    // agent authenticates two different APIs simultaneously — the second
    // add would overwrite the first.
    const engine = recordingEngine('extension', JSON.stringify({ added: true }));
    const tools = new AuthTools(engine);
    const handler = tools.getHandler('safari_authenticate')!;
    const a = await handler({ tabUrl: 'https://x', username: 'u', password: 'p', urlPattern: '*://api.example.com/*' });
    const b = await handler({ tabUrl: 'https://x', username: 'u', password: 'p', urlPattern: '*://other.example.com/*' });

    const idA = JSON.parse((a.content[0] as { text: string }).text).ruleId;
    const idB = JSON.parse((b.content[0] as { text: string }).text).ruleId;
    expect(idA).not.toBe(idB);
  });

  // ── No-extension fallback ────────────────────────────────────────────

  // Spec: throws EXTENSION_REQUIRED when engine !== 'extension'. Both
  // applescript AND daemon must trip this — a misimpl checking only
  // `engine.name === 'applescript'` would let daemon through and dispatch
  // a sentinel the daemon engine cannot route, producing a confusing far-side
  // error instead of the typed EXTENSION_REQUIRED.
  it.each([
    ['applescript' as const],
    ['daemon' as const],
  ])('non-extension engine (%s): throws EXTENSION_REQUIRED before any dispatch', async (engineName) => {
    const engine = recordingEngine(engineName, '');
    const tools = new AuthTools(engine);
    const handler = tools.getHandler('safari_authenticate')!;

    let caught: unknown = null;
    try { await handler({ tabUrl: 'https://x', username: 'u', password: 'p', urlPattern: '*://x/*' }); } catch (e) { caught = e; }

    expect(caught).toBeInstanceOf(SafariPilotError);
    expect((caught as SafariPilotError).code).toBe(ERROR_CODES.EXTENSION_REQUIRED);
    // CRITICAL: must not have dispatched anything to the engine — fail fast,
    // don't waste a round-trip emitting a sentinel the engine cannot route.
    expect(engine.scripts).toHaveLength(0);
  });

  // ── safari_clear_authentication ─────────────────────────────────────

  it('extension engine: clear_authentication dispatches __SP_DNR_REMOVE_RULE__ with the urlPattern-derived id', async () => {
    const engine = recordingEngine('extension', JSON.stringify({ removed: true, ruleId: 0 }));
    const tools = new AuthTools(engine);
    // First add, then clear — the clear's rule id MUST match the add's id.
    const addH = tools.getHandler('safari_authenticate')!;
    const added = await addH({ tabUrl: 'https://x', username: 'u', password: 'p', urlPattern: '*://api/*' });
    const expectedId = JSON.parse((added.content[0] as { text: string }).text).ruleId;

    const clearH = tools.getHandler('safari_clear_authentication')!;
    await clearH({ tabUrl: 'https://x', urlPattern: '*://api/*' });

    const lastScript = engine.scripts[engine.scripts.length - 1]!;
    expect(lastScript.startsWith(REMOVE_RULE)).toBe(true);
    expect(lastScript.charAt(REMOVE_RULE.length)).toBe(':');
    const params = JSON.parse(lastScript.slice(REMOVE_RULE.length + 1));
    // browser.declarativeNetRequest's removeDynamicRules takes an id list
    // (ruleId), not a rule object. The sentinel mirrors handleDnrRemoveRule's
    // signature: { ruleId: number }.
    expect(params.ruleId).toBe(expectedId);
  });
});
