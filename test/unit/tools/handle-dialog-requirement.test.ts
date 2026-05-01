/**
 * T56 — `safari_handle_dialog` overstates `requiresDialogIntercept: true`.
 *
 * The handler at `src/tools/interaction.ts:859-...` is a pure JS override —
 * it monkey-patches `window.alert`, `window.confirm`, and `window.prompt`
 * via injected JavaScript. This works on any engine that can run JS in a
 * tab, including AppleScript's `do JavaScript`. The `requiresDialogIntercept`
 * capability flag was intended for engines that intercept *native* browser
 * dialogs at the chrome level — which only the Safari Web Extension can do
 * (and only for confirm/alert at-the-prompt, not the JS-override pattern).
 *
 * Effect of the bug: declaring `requiresDialogIntercept: true` forces
 * routing through the extension via `selectEngine`'s `requiresExtension`
 * branch (engine-selector.ts:84-89). When extension is unavailable the
 * tool throws `EngineUnavailableError` instead of falling through to
 * AppleScript, where the JS override would have worked fine.
 *
 * Fix: drop the flag. Tool falls back to AppleScript when extension is
 * unavailable, matching what the handler actually does.
 */
import { describe, it, expect } from 'vitest';
import { InteractionTools } from '../../../src/tools/interaction.js';
import { selectEngine } from '../../../src/engine-selector.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { SafariPilotServer } from '../../../src/server.js';

describe('T56 — safari_handle_dialog must not declare requiresDialogIntercept', () => {
  const tools = new InteractionTools({} as IEngine, {} as SafariPilotServer);
  const def = tools.getDefinitions().find((d) => d.name === 'safari_handle_dialog')!;

  it('safari_handle_dialog definition exists', () => {
    expect(def, 'safari_handle_dialog must be registered').toBeDefined();
  });

  it('requirements does NOT declare requiresDialogIntercept', () => {
    expect(def.requirements.requiresDialogIntercept).not.toBe(true);
  });

  // Behaviour parity check: with the flag dropped, selectEngine must NOT
  // throw EngineUnavailableError when extension is unavailable. It should
  // route to applescript (or daemon) instead. This is the bug T56 fixes —
  // the handler works on AppleScript, but the lying flag forced an
  // extension-only path.
  it('selectEngine does not throw EngineUnavailableError when extension is unavailable', () => {
    expect(() =>
      selectEngine(def.requirements, { daemon: true, extension: false }),
    ).not.toThrow();
  });

  it('selectEngine returns "applescript" or "daemon" without extension (not extension)', () => {
    const engine = selectEngine(def.requirements, { daemon: true, extension: false });
    expect(engine).not.toBe('extension');
    expect(['applescript', 'daemon']).toContain(engine);
  });
});
