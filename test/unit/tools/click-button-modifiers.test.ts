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
 * Post-fix the dispatched MouseEvent payload reflects the params:
 *   - button: 'right'   → dispatch mousedown/mouseup (button=2) + contextmenu
 *   - button: 'middle'  → dispatch mousedown/mouseup (button=1) + auxclick
 *   - button: 'left'    → dispatch mousedown/mouseup/click (button=0) — preserves prior behavior
 *   - modifiers ['ctrl','shift'] → MouseEvent options include ctrlKey:true, shiftKey:true
 *
 * The W3C UI Events spec is explicit: 'click' fires only for primary-button
 * (button=0). For non-primary buttons 'auxclick' fires; for right-click
 * additionally 'contextmenu' fires. We mirror that contract — agents
 * exercising right-click need the contextmenu event to land on real handlers.
 *
 * Test strategy: unit-test the GENERATED action-JS string (vitest env is node,
 * no DOM). Capture engine.executeJsInTab calls via a recording engine, then
 * assert on substrings of the dispatched script. Pattern matches
 * test/unit/tools/handle-dialog-requirement.test.ts and the T49/T50/T51 suite.
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

async function runClick(
  engine: IEngine & { capturedScripts: string[] },
  params: Record<string, unknown>,
): Promise<string> {
  const tools = new InteractionTools(engine, fakeServer());
  const handler = tools.getHandler('safari_click');
  if (!handler) throw new Error('safari_click handler not registered');
  // force:true skips auto-wait so the only captured script is the action JS.
  await handler({ tabUrl: 'https://example.com/', selector: 'button.x', force: true, ...params });
  // The action script is the LAST captured (waitAndExecute may also probe).
  const action = engine.capturedScripts[engine.capturedScripts.length - 1];
  if (!action) throw new Error('no action script captured');
  return action;
}

describe('5A.3 — safari_click button + modifiers honored', () => {
  it('button="right" dispatches mousedown/mouseup + contextmenu with button=2 (and NOT a primary click event)', async () => {
    const engine = recordingEngine();
    const script = await runClick(engine, { button: 'right' });
    // The MouseEvent options block must carry button: 2.
    expect(script, 'expected button: 2 in MouseEvent opts').toMatch(/button:\s*2\b/);
    // mousedown/mouseup must precede the terminating event — many real-world
    // contextmenu handlers also listen on mousedown.
    expect(script, 'expected mousedown dispatch').toMatch(/dispatchEvent\(new MouseEvent\(['"]mousedown['"]/);
    expect(script, 'expected mouseup dispatch').toMatch(/dispatchEvent\(new MouseEvent\(['"]mouseup['"]/);
    // contextmenu must be dispatched (this is what real handlers listen to).
    expect(script, 'expected contextmenu dispatch').toMatch(/dispatchEvent\(new MouseEvent\(['"]contextmenu['"]/);
    // Primary 'click' event must NOT fire for right-button (per W3C UI Events).
    expect(
      /dispatchEvent\(new MouseEvent\(['"]click['"]/.test(script),
      'right-click must not dispatch primary "click" event',
    ).toBe(false);
  });

  it('button="middle" dispatches mousedown/mouseup + auxclick with button=1 (and NOT primary click or contextmenu)', async () => {
    const engine = recordingEngine();
    const script = await runClick(engine, { button: 'middle' });
    expect(script, 'expected button: 1 in MouseEvent opts').toMatch(/button:\s*1\b/);
    expect(script, 'expected mousedown dispatch').toMatch(/dispatchEvent\(new MouseEvent\(['"]mousedown['"]/);
    expect(script, 'expected mouseup dispatch').toMatch(/dispatchEvent\(new MouseEvent\(['"]mouseup['"]/);
    expect(script, 'expected auxclick dispatch').toMatch(/dispatchEvent\(new MouseEvent\(['"]auxclick['"]/);
    expect(
      /dispatchEvent\(new MouseEvent\(['"]click['"]/.test(script),
      'middle-click must not dispatch primary "click" event',
    ).toBe(false);
    expect(
      /dispatchEvent\(new MouseEvent\(['"]contextmenu['"]/.test(script),
      'middle-click must not dispatch contextmenu',
    ).toBe(false);
  });

  it('button="left" (default) preserves prior behavior — dispatches mousedown/mouseup/click with button=0', async () => {
    const engine = recordingEngine();
    const script = await runClick(engine, {}); // no button param → defaults to left
    expect(script, 'default left click expects button: 0').toMatch(/button:\s*0\b/);
    expect(script, 'expected mousedown dispatch').toMatch(/dispatchEvent\(new MouseEvent\(['"]mousedown['"]/);
    expect(script, 'expected mouseup dispatch').toMatch(/dispatchEvent\(new MouseEvent\(['"]mouseup['"]/);
    expect(script, 'left click must dispatch the primary click event').toMatch(/dispatchEvent\(new MouseEvent\(['"]click['"]/);
    expect(
      /dispatchEvent\(new MouseEvent\(['"]contextmenu['"]/.test(script),
      'left click must not dispatch contextmenu',
    ).toBe(false);
    expect(
      /dispatchEvent\(new MouseEvent\(['"]auxclick['"]/.test(script),
      'left click must not dispatch auxclick',
    ).toBe(false);
  });

  it('modifiers ["ctrl","shift"] set ctrlKey and shiftKey on the dispatched MouseEvent', async () => {
    const engine = recordingEngine();
    const script = await runClick(engine, { modifiers: ['ctrl', 'shift'] });
    expect(script, 'expected ctrlKey: true').toMatch(/ctrlKey:\s*true\b/);
    expect(script, 'expected shiftKey: true').toMatch(/shiftKey:\s*true\b/);
    // Unspecified modifiers must NOT be set true.
    expect(
      /altKey:\s*true\b/.test(script),
      'altKey must not be true when not in modifiers array',
    ).toBe(false);
    expect(
      /metaKey:\s*true\b/.test(script),
      'metaKey must not be true when not in modifiers array',
    ).toBe(false);
  });

  it('no modifiers param means no modifier keys set true on the MouseEvent', async () => {
    const engine = recordingEngine();
    const script = await runClick(engine, {});
    // None of the four modifier flags should be true.
    for (const k of ['ctrlKey', 'shiftKey', 'altKey', 'metaKey']) {
      expect(
        new RegExp(`${k}:\\s*true\\b`).test(script),
        `${k} must not be true when modifiers is omitted`,
      ).toBe(false);
    }
  });
});
