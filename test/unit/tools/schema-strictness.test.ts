// test/unit/tools/schema-strictness.test.ts
// Cluster B — enum / min-max / minLength constraints on closed-set params
import { describe, it, expect } from 'vitest';
import { SafariPilotServer } from '../../../src/server.js';
import { loadConfig } from '../../../src/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SchemaNode = Record<string, unknown>;

function getSchema(tools: ReturnType<SafariPilotServer['listToolDefinitions']>, toolName: string): SchemaNode {
  const t = tools.find((d) => d.name === toolName);
  if (!t) throw new Error(`Tool not found: ${toolName}`);
  return (t.inputSchema as SchemaNode);
}

function getProp(schema: SchemaNode, propName: string): SchemaNode {
  const props = schema['properties'] as Record<string, SchemaNode> | undefined;
  if (!props) throw new Error(`Schema has no properties`);
  const prop = props[propName];
  if (!prop) throw new Error(`Property not found: ${propName}`);
  return prop;
}

// ---------------------------------------------------------------------------
// Expected enum values (runtime-accurate — adapted from micro-manifest spec)
// ---------------------------------------------------------------------------

const REQUIRED_ENUMS: Array<{ tool: string; param: string; values: string[] }> = [
  // wait.ts — actual WaitCondition type values (spec used different names)
  {
    tool: 'safari_wait_for',
    param: 'condition',
    values: ['selector', 'selectorHidden', 'text', 'textGone', 'urlMatch', 'networkidle', 'function'],
  },
  // extraction.ts — already has yaml/json (regression guard)
  {
    tool: 'safari_snapshot',
    param: 'format',
    values: ['yaml', 'json'],
  },
  // extraction.ts — level must include 'debug' (Cluster B addition)
  {
    tool: 'safari_get_console_messages',
    param: 'level',
    values: ['all', 'log', 'warn', 'error', 'info', 'debug'],
  },
  // NOTE: safari_network_throttle has no 'profile' param — omitted from this test.
  // The tool only exposes latencyMs + downloadKbps. Adding a lying schema param
  // without handler wiring was deliberately skipped (spec mismatch, reported here).
];

// ---------------------------------------------------------------------------
// Selector-using tools that must have minLength: 1 on their 'selector' param
// ---------------------------------------------------------------------------

const SELECTOR_MIN_LENGTH_TOOLS = [
  // interaction.ts
  'safari_click',
  'safari_double_click',
  'safari_fill',
  'safari_select_option',
  'safari_check',
  'safari_hover',
  'safari_type',
  // extraction.ts
  'safari_get_text',
  'safari_get_html',
  'safari_get_attribute',
  'safari_query_all',
];

// ---------------------------------------------------------------------------
// Timeout bounds
// ---------------------------------------------------------------------------

const TIMEOUT_BOUNDS: Array<{ tool: string; param: string; minimum: number; maximum: number }> = [
  { tool: 'safari_wait_for', param: 'timeout', minimum: 0, maximum: 120000 },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cluster B — schema strictness: enums, minLength, bounds', () => {
  let tools: ReturnType<SafariPilotServer['listToolDefinitions']>;

  beforeAll(() => {
    const cfg = loadConfig();
    const server = new SafariPilotServer(cfg);
    tools = server.listToolDefinitions();
  });

  // --- enum constraints ---
  describe('enum constraints on closed-set string params', () => {
    it.each(REQUIRED_ENUMS)('$tool.$param has correct enum values', ({ tool, param, values }) => {
      const schema = getSchema(tools, tool);
      const prop = getProp(schema, param);
      expect(prop['enum'], `${tool}.${param} missing enum`).toBeDefined();
      const actual = prop['enum'] as string[];
      // Every expected value must be present
      for (const v of values) {
        expect(actual, `${tool}.${param} missing enum value "${v}"`).toContain(v);
      }
      // No unexpected values (no extra hallucination targets)
      expect(actual.sort()).toEqual([...values].sort());
    });
  });

  // --- selector minLength ---
  describe('selector params have minLength: 1', () => {
    it.each(SELECTOR_MIN_LENGTH_TOOLS)('%s.selector has minLength: 1', (toolName) => {
      const schema = getSchema(tools, toolName);
      const props = schema['properties'] as Record<string, SchemaNode> | undefined;
      // selector is optional on many tools (can use role/ref/etc instead) — only enforce when it exists
      if (!props || !props['selector']) return;
      const selectorProp = props['selector'] as SchemaNode;
      expect(selectorProp['minLength'], `${toolName}.selector missing minLength`).toBe(1);
    });
  });

  // --- numeric bounds ---
  describe('timeout and numeric params have min/max bounds', () => {
    it.each(TIMEOUT_BOUNDS)('$tool.$param has minimum $minimum and maximum $maximum', ({ tool, param, minimum, maximum }) => {
      const schema = getSchema(tools, tool);
      const prop = getProp(schema, param);
      expect(prop['minimum'], `${tool}.${param} missing minimum`).toBe(minimum);
      expect(prop['maximum'], `${tool}.${param} missing maximum`).toBe(maximum);
    });
  });
});
