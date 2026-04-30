/**
 * T63 — `requiresApplescript` capability flag honesty.
 *
 * The bug (T61 trace, 2026-04-30): `safari_navigate` returned result metadata
 * `{__engine: "extension"}` despite the actual execution path being raw
 * AppleScript — `NavigationTools` is constructed with `AppleScriptEngine`
 * (server.ts:316), bypassing `EngineProxy` entirely. Same for `CompoundTools`
 * (server.ts:329) and `safari_health_check`'s inline registration.
 *
 * Telemetry-only impact, but it pollutes benchmark routing and made the T61
 * trace investigation slower (we initially looked at the extension path).
 *
 * Fix: declare `requiresApplescript: true` on tool definitions whose handler
 * always uses raw AppleScript regardless of engine availability. `selectEngine`
 * honours the flag and short-circuits to `'applescript'`, so the
 * `__engine` stamping in `executeToolWithSecurity` matches reality.
 *
 * The test surface:
 *   1. selector unit — flag forces applescript even when extension is up
 *   2. tool-definition invariant — every nav/compound/health-check tool must
 *      carry the flag, so the bug cannot regress when adding new tools
 */
import { describe, it, expect } from 'vitest';
import { selectEngine } from '../../../src/engine-selector.js';
import { NavigationTools } from '../../../src/tools/navigation.js';
import { CompoundTools } from '../../../src/tools/compound.js';
import type { AppleScriptEngine } from '../../../src/engines/applescript.js';

describe('T63 — requiresApplescript capability flag', () => {
  it('selectEngine returns "applescript" when requiresApplescript is set, even with extension up', () => {
    const engine = selectEngine(
      { idempotent: false, requiresApplescript: true },
      { daemon: true, extension: true },
    );
    expect(engine).toBe('applescript');
  });

  it('selectEngine still respects requiresApplescript when only daemon+applescript available', () => {
    const engine = selectEngine(
      { idempotent: true, requiresApplescript: true },
      { daemon: true, extension: false },
    );
    expect(engine).toBe('applescript');
  });

  // Triangulation: rules out an implementation that only short-circuits when
  // daemon=true. The flag must override extension preference unconditionally.
  it('selectEngine returns "applescript" with flag when only extension available (no daemon)', () => {
    const engine = selectEngine(
      { idempotent: false, requiresApplescript: true },
      { daemon: false, extension: true },
    );
    expect(engine).toBe('applescript');
  });

  // Edge: applescript is the unconditional bottom fallback in this codebase
  // (engine-selector.ts:91-93). Confirms the flag still resolves cleanly when
  // neither daemon nor extension is up — no throw, no silent default-route.
  it('selectEngine returns "applescript" with flag when nothing else is available', () => {
    const engine = selectEngine(
      { idempotent: false, requiresApplescript: true },
      { daemon: false, extension: false },
    );
    expect(engine).toBe('applescript');
  });

  it('selectEngine without requiresApplescript prefers extension when available (regression guard)', () => {
    const engine = selectEngine(
      { idempotent: true },
      { daemon: true, extension: true },
    );
    expect(engine).toBe('extension');
  });

  // Capability collision: a tool that requires extension capability AND
  // declares requiresApplescript would be a programming error. The flag
  // shouldn't bypass the requiresExtension throw — extension capability
  // requirements take priority since they are correctness-critical
  // (a CSP-blocked tool routed to AppleScript silently fails).
  // Documented for future safety; if you ever need this combo, fix the tool.
  it('requiresExtension capability beats requiresApplescript (correctness > telemetry)', () => {
    expect(() =>
      selectEngine(
        { idempotent: false, requiresApplescript: true, requiresShadowDom: true },
        { daemon: true, extension: false },
      ),
    ).toThrow(/extension/i);
  });
});

describe('T63 — tool-definition invariant: AppleScript-only tools declare the flag', () => {
  // Cast to silence the constructor — the engine isn't actually invoked, we only
  // need .getDefinitions() which is a pure read.
  const fakeEngine = {} as AppleScriptEngine;
  const navTools = new NavigationTools(fakeEngine);
  const compoundTools = new CompoundTools(fakeEngine);

  const navDefs = navTools.getDefinitions();
  const compoundDefs = compoundTools.getDefinitions();

  it.each(navDefs.map((d) => [d.name, d]))(
    '%s declares requiresApplescript: true',
    (_name, def) => {
      expect(def.requirements.requiresApplescript).toBe(true);
    },
  );

  it.each(compoundDefs.map((d) => [d.name, d]))(
    '%s declares requiresApplescript: true',
    (_name, def) => {
      expect(def.requirements.requiresApplescript).toBe(true);
    },
  );

  it('NavigationTools covers the expected tool set (regression guard against silent removal)', () => {
    const names = new Set(navDefs.map((d) => d.name));
    for (const expected of [
      'safari_navigate',
      'safari_navigate_back',
      'safari_navigate_forward',
      'safari_reload',
      'safari_new_tab',
      'safari_close_tab',
      'safari_list_tabs',
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });
});
