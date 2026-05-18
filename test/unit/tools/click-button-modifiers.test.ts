/**
 * 5A.3 — `safari_click` honors the `button: 'left'|'right'|'middle'` and
 * `modifiers: string[]` parameters that the schema has always declared.
 *
 * Pre-fix: the schema declares both (interaction.ts:142-143) but `handleClick`
 * never reads them. Every click dispatches as `MouseEvent('click', opts)` with
 * `button: 0` and no modifier flags — meaning right-click and middle-click
 * paths are silently coerced to left-click, and `modifiers: ['ctrl']` is
 * accepted by the schema and dropped. This is the same class of "schema lies"
 * caught in T49/T50/T51 (see docs/AUDIT-TASKS.md).
 *
 * Post-fix the dispatched payload reflects the params:
 *   - button: 'right'   → buttonNum=2 (sentinel handler dispatches mousedown/mouseup + contextmenu)
 *   - button: 'middle'  → buttonNum=1 (sentinel handler dispatches mousedown/mouseup + auxclick)
 *   - button: 'left'    → buttonNum=0 (sentinel handler dispatches mousedown/mouseup/click) — preserves prior behavior
 *   - modifiers ['ctrl','shift'] → modifiers.ctrl=true, modifiers.shift=true on the sentinel payload
 *
 * The W3C UI Events spec is explicit: 'click' fires only for primary-button
 * (button=0). For non-primary buttons 'auxclick' fires; for right-click
 * additionally 'contextmenu' fires. The sentinel handler in content-main.js
 * branches on buttonNum and dispatches the right terminal event — agents
 * exercising right-click need the contextmenu event to land on real handlers.
 *
 * v0.1.34 Task 7 — handler now marshals via __SP_CLICK__:<json> sentinel
 * (CSP-immune; Trusted Types blocks `new Function`). Tests parse the sentinel
 * payload and check structured fields instead of regexing inline JS. The
 * terminal-event branching is asserted via e2e (sentinel handler lives in
 * extension/content-main.js, not in TS).
 */
import { describe, it, expect } from 'vitest';
import { InteractionTools } from '../../../src/tools/interaction.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { Engine, EngineResult } from '../../../src/types.js';
import type { SafariPilotServer } from '../../../src/server.js';

const okClickResult: EngineResult = {
  ok: true,
  value: JSON.stringify({ clicked: true, navigatedTo: null, element: { tagName: 'BUTTON' }, downloadContext: undefined }),
  elapsed_ms: 1,
};

function recordingEngine(): IEngine & { capturedScripts: string[] } {
  const capturedScripts: string[] = [];
  const e = {
    name: 'extension' as Engine,
    isAvailable: async () => true,
    execute: async () => okClickResult,
    executeJsInTab: async (_tabUrl: string, jsCode: string) => {
      capturedScripts.push(jsCode);
      return okClickResult;
    },
    executeJsInFrame: async () => okClickResult,
    shutdown: async () => {},
    capturedScripts,
  };
  return e as unknown as IEngine & { capturedScripts: string[] };
}

function fakeServer(): SafariPilotServer {
  // setClickContext is the only handleClick collaborator on the server.
  // Stub minimally so the call doesn't throw.
  return { setClickContext: () => {} } as unknown as SafariPilotServer;
}

interface ClickSentinel {
  selector: string;
  buttonNum: number;
  modifiers: { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };
}

async function runClickSentinel(
  engine: IEngine & { capturedScripts: string[] },
  params: Record<string, unknown>,
): Promise<ClickSentinel> {
  const tools = new InteractionTools(engine, fakeServer());
  const handler = tools.getHandler('safari_click');
  if (!handler) throw new Error('safari_click handler not registered');
  // force:true skips auto-wait so the only captured script is the action JS.
  await handler({ tabUrl: 'https://example.com/', selector: 'button.x', force: true, ...params });
  // The action script is the LAST captured (waitAndExecute may also probe).
  const action = engine.capturedScripts[engine.capturedScripts.length - 1];
  if (!action) throw new Error('no action script captured');
  if (!action.startsWith('__SP_CLICK__:')) {
    throw new Error(`expected __SP_CLICK__ sentinel; got: ${action.slice(0, 80)}`);
  }
  return JSON.parse(action.slice('__SP_CLICK__:'.length)) as ClickSentinel;
}

describe('5A.3 — safari_click button + modifiers honored (sentinel transport)', () => {
  it('button="right" marshals buttonNum=2 (sentinel handler dispatches mousedown/mouseup + contextmenu)', async () => {
    const engine = recordingEngine();
    const payload = await runClickSentinel(engine, { button: 'right' });
    expect(payload.buttonNum, 'right click → buttonNum=2').toBe(2);
  });

  it('button="middle" marshals buttonNum=1 (sentinel handler dispatches mousedown/mouseup + auxclick)', async () => {
    const engine = recordingEngine();
    const payload = await runClickSentinel(engine, { button: 'middle' });
    expect(payload.buttonNum, 'middle click → buttonNum=1').toBe(1);
  });

  it('button="left" (default) marshals buttonNum=0 — preserves prior behavior', async () => {
    const engine = recordingEngine();
    const payload = await runClickSentinel(engine, {}); // no button param → defaults to left
    expect(payload.buttonNum, 'default left click → buttonNum=0').toBe(0);
  });

  it('modifiers ["ctrl","shift"] set ctrl and shift true on the sentinel payload', async () => {
    const engine = recordingEngine();
    const payload = await runClickSentinel(engine, { modifiers: ['ctrl', 'shift'] });
    expect(payload.modifiers.ctrl, 'expected modifiers.ctrl=true').toBe(true);
    expect(payload.modifiers.shift, 'expected modifiers.shift=true').toBe(true);
    expect(payload.modifiers.alt, 'alt must not be true when not in modifiers array').toBe(false);
    expect(payload.modifiers.meta, 'meta must not be true when not in modifiers array').toBe(false);
  });

  it('no modifiers param means all four modifier flags are false', async () => {
    const engine = recordingEngine();
    const payload = await runClickSentinel(engine, {});
    expect(payload.modifiers.ctrl, 'ctrl must be false when modifiers omitted').toBe(false);
    expect(payload.modifiers.shift, 'shift must be false when modifiers omitted').toBe(false);
    expect(payload.modifiers.alt, 'alt must be false when modifiers omitted').toBe(false);
    expect(payload.modifiers.meta, 'meta must be false when modifiers omitted').toBe(false);
  });
});
