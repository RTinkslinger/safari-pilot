/**
 * T79 C-3: SelectorPackTools register + unregister tool definitions.
 * Verifies feature-flag gating, schema surface, and that handler-side
 * validation rejects invalid name + forbidden body patterns BEFORE any
 * in-page execution.
 */
import { describe, expect, test } from 'vitest';
import { SelectorPackTools } from '../../../src/tools/selector-pack.js';

const fakeEngine = {
  name: 'extension' as const,
  executeJsInTab: async () => ({ ok: true, value: '{"ok":true}', elapsed_ms: 0 }),
};

describe('T79 SelectorPackTools', () => {
  test('register tool defined with name + body params', () => {
    const tools = new SelectorPackTools(fakeEngine as never, { enabled: true });
    const def = tools.getDefinitions().find((d) => d.name === 'safari_register_selector');
    expect(def).toBeDefined();
    const props = (def!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props['name']).toBeDefined();
    expect(props['body']).toBeDefined();
    expect(def!.requirements.idempotent).toBe(false); // mutates registry
  });

  test('unregister tool defined with name param', () => {
    const tools = new SelectorPackTools(fakeEngine as never, { enabled: true });
    const def = tools.getDefinitions().find((d) => d.name === 'safari_unregister_selector');
    expect(def).toBeDefined();
  });

  test('tools NOT registered when feature flag disabled', () => {
    const tools = new SelectorPackTools(fakeEngine as never, { enabled: false });
    expect(tools.getDefinitions()).toHaveLength(0);
  });

  test('register handler rejects invalid name with clear error', async () => {
    const tools = new SelectorPackTools(fakeEngine as never, { enabled: true });
    const handler = tools.getHandler('safari_register_selector')!;
    await expect(handler({ tabUrl: 'http://x', name: 'bad-name', body: 'return root;' }))
      .rejects.toThrow(/invalid/i);
  });

  test('register handler rejects body containing eval', async () => {
    const tools = new SelectorPackTools(fakeEngine as never, { enabled: true });
    const handler = tools.getHandler('safari_register_selector')!;
    await expect(handler({ tabUrl: 'http://x', name: 'good', body: 'eval("x")' }))
      .rejects.toThrow(/eval/i);
  });
});
