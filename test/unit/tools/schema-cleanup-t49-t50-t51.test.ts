/**
 * T49 / T50 / T51 — small schema/handler honesty fixes.
 *
 * T49 — `safari_type` declared `delay: { default: 50 }` but `handleType`
 * runs a synchronous for-loop with no per-keystroke pacing. Zero
 * test/benchmark callers pass it. Fix: drop the param AND ensure the
 * handler doesn't branch on it.
 *
 * T50 — `safari_scroll` accepts `toTop`, `toBottom`, `toElement`
 * independently. Handler emits each branch as a separate JS statement
 * (interaction.ts:749-752); multi-mode silently runs all branches. Fix:
 * throw on multi-mode at handler entry, BEFORE the engine call.
 *
 * T51 — `safari_reload` `bypassCache` calls `location.reload(true)`.
 * Boolean argument is non-standard (never in WHATWG spec). Zero callers
 * in repo. Fix: drop the param AND ensure the handler emits plain
 * `location.reload()` regardless of any bypassCache value still passed.
 *
 * Reviewer-driven (revision 1): schema-only assertions were shape-only.
 * Now each schema-removal test pairs with a handler-behavior assertion
 * that catches a drift where schema is dropped but handler still
 * branches on the param.
 */
import { describe, it, expect } from 'vitest';
import { InteractionTools } from '../../../src/tools/interaction.js';
import { NavigationTools } from '../../../src/tools/navigation.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { AppleScriptEngine } from '../../../src/engines/applescript.js';
import type { SafariPilotServer } from '../../../src/server.js';

interface SchemaWithProperties {
  properties?: Record<string, unknown>;
}

/** Fake IEngine that records every executeJsInTab call so tests can read the
 * actual JS the handler tried to run. Returns ok with empty value so handlers
 * proceed without errors. */
function makeRecordingEngine(): { engine: IEngine; jsCalls: string[]; calls: string[] } {
  const jsCalls: string[] = [];
  const calls: string[] = [];
  // Pass-through buildTabScript so NavigationTools' private executeJsInTab
  // (which calls engine.buildTabScript before engine.execute) records the
  // raw JS in jsCalls instead of an AppleScript wrapper.
  const engine = {
    name: 'applescript' as const,
    isAvailable: async () => true,
    execute: async (script: string) => {
      calls.push('execute');
      jsCalls.push(script);
      return { ok: true, value: '', elapsed_ms: 0 };
    },
    executeJsInTab: async (_url: string, js: string) => {
      calls.push('executeJsInTab');
      jsCalls.push(js);
      return { ok: true, value: '{}', elapsed_ms: 0 };
    },
    shutdown: async () => { /* */ },
    buildTabScript: (_tabUrl: string, jsCode: string) => jsCode,
  };
  return { engine: engine as unknown as IEngine, jsCalls, calls };
}

describe('T49 — safari_type: drop phantom `delay` param (schema + handler parity)', () => {
  const tools = new InteractionTools({} as IEngine, {} as SafariPilotServer);

  it('safari_type schema has no `delay` property', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_type');
    expect(def, 'safari_type definition must exist').toBeDefined();
    const schema = def!.inputSchema as SchemaWithProperties;
    expect(schema.properties).toBeDefined();
    expect(schema.properties).not.toHaveProperty('delay');
  });

  // Handler-parity check: even if a caller passes `delay`, the handler must
  // not branch on it. A drift-fix that removes the schema entry but leaves
  // the handler reading `params['delay']` would silently re-introduce the
  // phantom-param contract. We compare the JS emitted for two extreme
  // delay values; identical output proves `delay` doesn't influence behavior.
  it('handleType emits identical JS regardless of any `delay` value passed', async () => {
    const a = makeRecordingEngine();
    const handlerA = new InteractionTools(a.engine, {} as SafariPilotServer).getHandler('safari_type');
    await handlerA!({ tabUrl: 'https://example.com/', content: 'hi', selector: '#in', delay: 0 });

    const b = makeRecordingEngine();
    const handlerB = new InteractionTools(b.engine, {} as SafariPilotServer).getHandler('safari_type');
    await handlerB!({ tabUrl: 'https://example.com/', content: 'hi', selector: '#in', delay: 9999 });

    expect(a.jsCalls.length).toBeGreaterThan(0);
    expect(b.jsCalls.length).toBeGreaterThan(0);
    // Same emitted JS for both delay extremes — param has zero effect.
    expect(a.jsCalls).toEqual(b.jsCalls);
    // Stronger negative: the JS must not contain any pause construct.
    for (const js of a.jsCalls) {
      expect(js).not.toMatch(/setTimeout|setInterval|requestAnimationFrame|await\s+new\s+Promise/);
    }
  });
});

describe('T51 — safari_reload: drop phantom `bypassCache` param (schema + handler parity)', () => {
  const tools = new NavigationTools({} as AppleScriptEngine);

  it('safari_reload schema has no `bypassCache` property', () => {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_reload');
    expect(def, 'safari_reload definition must exist').toBeDefined();
    const schema = def!.inputSchema as SchemaWithProperties;
    expect(schema.properties).toBeDefined();
    expect(schema.properties).not.toHaveProperty('bypassCache');
  });

  // Handler-parity check: handler must emit plain `location.reload()` and
  // NEVER `location.reload(true)`, even if `bypassCache:true` is passed.
  // A drift-fix that drops the schema but leaves the ternary in handleReload
  // would silently keep emitting non-standard JS for unaware callers.
  it('handleReload emits `location.reload()` (no boolean arg) regardless of any bypassCache value', async () => {
    const r = makeRecordingEngine();
    // NavigationTools accepts AppleScriptEngine; cast our IEngine fake.
    const handler = new NavigationTools(r.engine as unknown as AppleScriptEngine).getHandler('safari_reload');
    await handler!({ tabUrl: 'https://example.com/', bypassCache: true });

    // Look for the reload call in any JS the handler emitted.
    const reloadCalls = r.jsCalls.filter((js) => js.includes('location.reload'));
    expect(reloadCalls.length).toBeGreaterThan(0);
    for (const js of reloadCalls) {
      // Negative: must NOT contain the deprecated boolean form
      expect(js).not.toMatch(/location\.reload\s*\(\s*true\s*\)/);
      // Positive: must be the spec-compliant no-arg form
      expect(js).toMatch(/location\.reload\s*\(\s*\)/);
    }
  });
});

describe('T50 — safari_scroll handler rejects multi-mode conflicts', () => {
  // Specific error message — narrows the regex per reviewer feedback. The
  // implementation MUST throw a message containing both
  // "mutually exclusive" and the param names; this couples the test to a
  // stable contract instead of any thrown error matching loose synonyms.
  const MUTEX_ERROR = /mutually exclusive.*toTop.*toBottom.*toElement|toTop.*toBottom.*toElement.*mutually exclusive/i;

  it('throws when both toTop and toBottom are passed (engine NOT called)', async () => {
    const r = makeRecordingEngine();
    const handler = new InteractionTools(r.engine, {} as SafariPilotServer).getHandler('safari_scroll');
    await expect(
      handler!({ tabUrl: 'https://example.com/', toTop: true, toBottom: true }),
    ).rejects.toThrow(MUTEX_ERROR);
    expect(r.calls).toEqual([]);
  });

  it('throws when toTop and toElement are passed together (engine NOT called)', async () => {
    const r = makeRecordingEngine();
    const handler = new InteractionTools(r.engine, {} as SafariPilotServer).getHandler('safari_scroll');
    await expect(
      handler!({ tabUrl: 'https://example.com/', toTop: true, toElement: '#footer' }),
    ).rejects.toThrow(MUTEX_ERROR);
    expect(r.calls).toEqual([]);
  });

  it('throws when toBottom and toElement are passed together (engine NOT called)', async () => {
    const r = makeRecordingEngine();
    const handler = new InteractionTools(r.engine, {} as SafariPilotServer).getHandler('safari_scroll');
    await expect(
      handler!({ tabUrl: 'https://example.com/', toBottom: true, toElement: '#footer' }),
    ).rejects.toThrow(MUTEX_ERROR);
    expect(r.calls).toEqual([]);
  });

  it('throws when all three of toTop, toBottom, toElement are passed (engine NOT called)', async () => {
    const r = makeRecordingEngine();
    const handler = new InteractionTools(r.engine, {} as SafariPilotServer).getHandler('safari_scroll');
    await expect(
      handler!({ tabUrl: 'https://example.com/', toTop: true, toBottom: true, toElement: '#x' }),
    ).rejects.toThrow(MUTEX_ERROR);
    expect(r.calls).toEqual([]);
  });

  // Regression guards — strengthened per reviewer to assert exact call shape
  it('does NOT throw with only toTop (single-mode regression guard)', async () => {
    const r = makeRecordingEngine();
    const handler = new InteractionTools(r.engine, {} as SafariPilotServer).getHandler('safari_scroll');
    await handler!({ tabUrl: 'https://example.com/', toTop: true });
    expect(r.calls).toEqual(['executeJsInTab']);
  });

  it('does NOT throw with no mode (default direction-based scroll)', async () => {
    const r = makeRecordingEngine();
    const handler = new InteractionTools(r.engine, {} as SafariPilotServer).getHandler('safari_scroll');
    await handler!({ tabUrl: 'https://example.com/' });
    expect(r.calls).toEqual(['executeJsInTab']);
  });
});
