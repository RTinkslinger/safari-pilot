/**
 * T15 — `safari_new_tab` must declare `requirements.idempotent = false`.
 *
 * Pre-T15: navigation.ts:108 set `requirements: { idempotent: true }` for
 * safari_new_tab. This was a migration error (origin commit `78938fb`,
 * 2026-04-18, same batch that broke `safari_eval_in_frame` at `368cbe2`)
 * — the bulk-migration spec didn't categorize safari_new_tab and a
 * boilerplate `idempotent: true` was applied.
 *
 * Architecturally wrong: each call to safari_new_tab creates a brand-new
 * Safari tab, which is the canonical NON-idempotent operation. A retry
 * (driven by any future engine-failure recovery, MCP client retry, or
 * tool-cache layer that respects the idempotent flag) would silently
 * create duplicate tabs and corrupt the agent's tab-ownership registry.
 *
 * Currently inert (NavigationTools never routes through the extension
 * engine, and the engine-selector doesn't yet consume the idempotent
 * flag), but a regression here would silently leak duplicate tabs the
 * moment any caller respects the flag — which is exactly the kind of
 * latent bug T15 was filed to prevent.
 *
 * Audit finding: docs/AUDIT-TASKS.md T15 (P1, H13). Pattern mirror of
 * SD-01's safari_evaluate requirement guard (extraction-requirements.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { NavigationTools } from '../../../src/tools/navigation.js';
import type { AppleScriptEngine } from '../../../src/engines/applescript.js';

describe('safari_new_tab routing requirements (T15)', () => {
  // NavigationTools reads getDefinitions() at registration time; the engine
  // reference is only used inside handlers we are not invoking here. A bare
  // object cast satisfies the constructor without producing a stub.
  const tools = new NavigationTools({} as AppleScriptEngine);

  it('declares idempotent = false (creating a tab is the canonical non-idempotent action)', () => {
    // Discrimination target: src/tools/navigation.ts:108. Reverting the
    // T15 fix (`idempotent: false` → `idempotent: true`) re-introduces
    // the migration-error contract: future retry/dedupe machinery would
    // mistakenly skip or replay safari_new_tab and produce duplicate tabs.
    const def = tools.getDefinitions().find((d) => d.name === 'safari_new_tab');

    expect(def, 'safari_new_tab tool definition must exist').toBeDefined();
    expect(def?.requirements?.idempotent).toBe(false);
  });
});
