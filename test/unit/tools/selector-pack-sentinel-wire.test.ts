/**
 * T79 Cluster D: SelectorPackTools sends sentinel-based scripts to the engine,
 * not direct page-eval JS. The extension's __SP_PACK_REGISTER__ /
 * __SP_PACK_UNREGISTER__ handlers (D-2) intercept and orchestrate storage
 * write + page injection.
 *
 * Cluster C's handler ran a direct `window.__sp_pack[...] = new Function(...)`
 * IIFE; Cluster D replaces it with a sentinel. This test pins the wire shape
 * so any regression that drops the sentinel reverts to non-persistent
 * registration without warning.
 */
import { describe, expect, test, vi } from 'vitest';
import { SelectorPackTools } from '../../../src/tools/selector-pack.js';

function captureEngine() {
  const captured: Array<{ tabUrl: string; jsCode: string }> = [];
  return {
    captured,
    engine: {
      name: 'extension' as const,
      executeJsInTab: vi.fn(async (tabUrl: string, jsCode: string) => {
        captured.push({ tabUrl, jsCode });
        // Echo a generic ok response — sentinel handler in extension would
        // normally relay the page-side injection result; for unit purposes
        // any ok result lets the handler return cleanly.
        return { ok: true as const, value: JSON.stringify({ ok: true, name: 'echo' }), elapsed_ms: 0 };
      }),
    },
  };
}

describe('T79 Cluster D — SelectorPackTools sentinel wire format', () => {
  test('handleRegister sends __SP_PACK_REGISTER__ sentinel with JSON payload', async () => {
    const { captured, engine } = captureEngine();
    const tools = new SelectorPackTools(engine as never, { enabled: true });
    const handler = tools.getHandler('safari_register_selector')!;
    await handler({
      tabUrl: 'http://x',
      name: 'myEngine',
      body: 'return root.querySelector(arg);',
    });
    expect(captured).toHaveLength(1);
    const sent = captured[0]!.jsCode;
    expect(sent.startsWith('__SP_PACK_REGISTER__:'), `expected sentinel prefix, got: ${sent}`).toBe(true);
    const payloadJson = sent.slice('__SP_PACK_REGISTER__:'.length);
    const payload = JSON.parse(payloadJson);
    expect(payload.name).toBe('myEngine');
    expect(payload.body).toBe('return root.querySelector(arg);');
  });

  test('handleRegister does NOT bypass the sentinel — no inline new Function eval IIFE', async () => {
    // Regression sentinel: Cluster C used a direct IIFE that evaluated the
    // body in-page without storage persistence. If a future change reverts to
    // that shape, the persistence guarantee silently breaks. Pin the contract.
    const { captured, engine } = captureEngine();
    const tools = new SelectorPackTools(engine as never, { enabled: true });
    const handler = tools.getHandler('safari_register_selector')!;
    await handler({
      tabUrl: 'http://x',
      name: 'good',
      body: 'return root.body;',
    });
    expect(captured[0]!.jsCode).not.toMatch(/window\.__sp_pack\[/);
    expect(captured[0]!.jsCode).not.toMatch(/new Function\(/);
  });

  test('handleUnregister sends __SP_PACK_UNREGISTER__ sentinel with name only', async () => {
    const { captured, engine } = captureEngine();
    const tools = new SelectorPackTools(engine as never, { enabled: true });
    const handler = tools.getHandler('safari_unregister_selector')!;
    await handler({
      tabUrl: 'http://x',
      name: 'myEngine',
    });
    expect(captured).toHaveLength(1);
    const sent = captured[0]!.jsCode;
    expect(sent.startsWith('__SP_PACK_UNREGISTER__:')).toBe(true);
    const payload = JSON.parse(sent.slice('__SP_PACK_UNREGISTER__:'.length));
    expect(payload.name).toBe('myEngine');
    expect(payload.body).toBeUndefined();
  });

  test('validators still run BEFORE the sentinel is built (eval body rejected)', async () => {
    const { captured, engine } = captureEngine();
    const tools = new SelectorPackTools(engine as never, { enabled: true });
    const handler = tools.getHandler('safari_register_selector')!;
    await expect(handler({
      tabUrl: 'http://x',
      name: 'evil',
      body: 'eval("alert(1)");',
    })).rejects.toThrow(/eval/i);
    expect(captured, 'engine must not be called when validator rejects').toHaveLength(0);
  });

  test('validators still run BEFORE the sentinel is built (invalid name rejected)', async () => {
    const { captured, engine } = captureEngine();
    const tools = new SelectorPackTools(engine as never, { enabled: true });
    const handler = tools.getHandler('safari_register_selector')!;
    await expect(handler({
      tabUrl: 'http://x',
      name: 'has-dash',
      body: 'return root.body;',
    })).rejects.toThrow(/invalid|must match/i);
    expect(captured).toHaveLength(0);
  });
});
