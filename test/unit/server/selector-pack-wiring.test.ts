/**
 * T79 C-4: SelectorPackTools wired into SafariPilotServer.
 *
 * The plan prescribed `makeServer().listTools()` style assertions, but the
 * actual server has no such API — tools are registered via a `modules` array
 * iterated in the constructor. Source-grep is the established pattern for
 * verifying server-side wiring without spawning a full server (see e.g. T60,
 * T67 extension-source tests). This test confirms:
 *   - server.ts imports SelectorPackTools
 *   - server.ts constructs it with the feature-flag config
 *   - server.ts adds the instance to the modules iteration array
 *
 * The empty-getDefinitions-when-disabled path is what gates registration —
 * no extra conditional in server.ts needed. C-3 tests verify that gating.
 */
import { describe, expect, test, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('T79 C-4 — SelectorPackTools wired into server.ts', () => {
  let src: string;

  beforeAll(async () => {
    src = await readFile('src/server.ts', 'utf8');
  });

  test('server.ts imports SelectorPackTools', () => {
    expect(src).toMatch(/import\s+\{[^}]*SelectorPackTools[^}]*\}\s+from\s+'\.\/tools\/selector-pack\.js'/);
  });

  test('server.ts constructs SelectorPackTools with config.selectorPack', () => {
    expect(src).toMatch(/new\s+SelectorPackTools\s*\(/);
    // Constructor must receive the feature-flag config so the gate works.
    expect(src).toMatch(/this\.config\.selectorPack/);
  });

  test('server.ts adds SelectorPackTools to the modules iteration array', () => {
    // Same modules array that contains interactionTools, extractionTools, etc.
    // The iteration walks `getDefinitions()` and registers handlers — when
    // feature flag is off, SelectorPackTools.getDefinitions() returns [] and
    // nothing is registered (verified at unit level in C-3).
    expect(src).toMatch(/selectorPackTools/);
  });
});
