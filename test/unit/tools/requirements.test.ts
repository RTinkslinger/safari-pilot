import { describe, it, expect, beforeAll } from 'vitest';
import { SafariPilotServer } from '../../../src/server';

/**
 * Enforcement test for Safari MV3 commit-1a Tasks 6+12.
 *
 * Every tool definition must declare `requirements.idempotent: boolean`.
 * The flag exists so the commit-1a EXTENSION_UNCERTAIN handler (Task 7)
 * knows which tools are safe to auto-retry on an ambiguous Extension-engine
 * disconnect vs. which must surface the uncertainty to the caller.
 *
 * This suite is the regression guard: any future tool added to the registry
 * without an idempotent flag will fail these tests.
 */
describe('Tool idempotent-flag migration (Tasks 6+12)', () => {
  let server: SafariPilotServer;
  let tools: ReturnType<SafariPilotServer['getAllToolDefinitions']>;
  let byName: Map<string, (typeof tools)[number]>;

  beforeAll(async () => {
    server = new SafariPilotServer();
    // initialize() registers every tool module onto the server.
    await server.initialize();
    tools = server.getAllToolDefinitions();
    byName = new Map(tools.map((t) => [t.name, t]));
  });

  it('every registered tool declares the idempotent flag', () => {
    expect(tools.length).toBeGreaterThanOrEqual(74);
    for (const tool of tools) {
      expect(tool.requirements, `${tool.name} missing requirements`).toBeDefined();
      expect(
        tool.requirements.idempotent,
        `${tool.name} missing idempotent`,
      ).toBeDefined();
      expect(typeof tool.requirements.idempotent).toBe('boolean');
    }
  });

  it('known non-idempotent tools have idempotent:false', () => {
    for (const name of [
      'safari_click',
      'safari_type',
      'safari_fill',
      'safari_select_option',
      'safari_navigate',
      'safari_reload',
      'safari_press_key',
      'safari_hover',
      'safari_drag',
      'safari_scroll',
    ]) {
      const t = byName.get(name);
      expect(t, `${name} should exist`).toBeDefined();
      expect(
        t?.requirements?.idempotent,
        `${name} should be idempotent:false`,
      ).toBe(false);
    }
  });

  it('known idempotent tools have idempotent:true', () => {
    for (const name of [
      'safari_get_text',
      'safari_snapshot',
      'safari_query_shadow',
      'safari_list_tabs',
      'safari_health_check',
      'safari_take_screenshot',
    ]) {
      const t = byName.get(name);
      expect(t, `${name} should exist`).toBeDefined();
      expect(
        t?.requirements?.idempotent,
        `${name} should be idempotent:true`,
      ).toBe(true);
    }
  });
});
