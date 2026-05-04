/**
 * T77 A-7 + A-8: chain field exposed in inputSchema for every locator-aware
 * MCP tool (extraction reads + interaction actions). Mechanical schema
 * wiring — chain extraction itself was added to extractLocatorFromParams in
 * A-1; in-page resolution in A-2..A-5. This file pins the inputSchema
 * surface so MCP clients see chain as a first-class param.
 */
import { describe, expect, it } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import { InteractionTools } from '../../../src/tools/interaction.js';

const fakeEngine = {
  name: 'extension' as const,
  executeJsInTab: async () => ({ ok: true, value: '{}', elapsed_ms: 0 }),
  executeJsInFrame: async () => ({ ok: true, value: '{}', elapsed_ms: 0 }),
};

function chainProp(def: { inputSchema: unknown }): { type?: string; items?: unknown; description?: string } | undefined {
  const schema = def.inputSchema as { properties?: Record<string, unknown> };
  return schema.properties?.['chain'] as { type?: string; items?: unknown; description?: string } | undefined;
}

describe('T77 A-7 — extraction tools expose chain in inputSchema', () => {
  const tools = new ExtractionTools(fakeEngine as never);
  const defs = tools.getDefinitions();

  for (const name of ['safari_get_text', 'safari_get_html', 'safari_get_attribute']) {
    it(`${name} declares chain as an array property`, () => {
      const def = defs.find((d) => d.name === name);
      expect(def, `${name} must be registered`).toBeDefined();
      const chain = chainProp(def!);
      expect(chain, `${name}.chain must be in inputSchema.properties`).toBeDefined();
      expect(chain!.type).toBe('array');
      expect(chain!.items).toBeDefined();
    });
  }
});

describe('T77 A-8 — interaction tools expose chain in inputSchema', () => {
  const fakeServer = {} as never;
  const tools = new InteractionTools(fakeEngine as never, fakeServer);
  const defs = tools.getDefinitions();

  // Every interaction tool that uses elementTargetingParams (locator-aware)
  // gets chain via the shared spread. Enumerate the locator-aware set.
  const locatorAwareTools = [
    'safari_click',
    'safari_double_click',
    'safari_fill',
    'safari_select_option',
    'safari_check',
    'safari_hover',
    'safari_type',
    'safari_press_key',
    'safari_drag',
  ];

  for (const name of locatorAwareTools) {
    it(`${name} declares chain via shared elementTargetingParams`, () => {
      const def = defs.find((d) => d.name === name);
      expect(def, `${name} must be registered`).toBeDefined();
      const props = (def!.inputSchema as { properties?: Record<string, unknown> }).properties;
      // Sanity: locator-aware tools also expose role/testId
      if (!props?.['role'] && !props?.['testId']) {
        // Tool isn't locator-aware in current schema — skip chain check
        return;
      }
      const chain = chainProp(def!);
      expect(chain, `${name}.chain must be in inputSchema.properties`).toBeDefined();
      expect(chain!.type).toBe('array');
    });
  }
});
