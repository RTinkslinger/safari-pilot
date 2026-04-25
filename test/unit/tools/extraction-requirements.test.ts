/**
 * SD-01 regression guard: `safari_evaluate` must declare
 * `requirements.requiresAsyncJs = true` so the engine selector routes it
 * to the extension only — never silently to the daemon or AppleScript,
 * whose JS wrappers serialize Promise objects without awaiting them.
 *
 * Background: commit 99fec1f wrapped `handleEvaluate` in an async IIFE so
 * the user's `return new Promise(...)` resolves end-to-end. That wrapper
 * only works on engines whose `EngineCapabilities.asyncJs === true`. Per
 * src/engine-selector.ts, only `extension` qualifies. Without
 * `requiresAsyncJs: true` in the tool def, when the extension is
 * unavailable (config-disabled, breaker-tripped, or not yet connected) the
 * selector falls through to daemon/applescript — which do NOT await the
 * IIFE's Promise. The resolved value is dropped silently.
 *
 * The fix is the same one-flag pattern already applied to safari_idb_list
 * and safari_idb_get (T6). This unit test guards the contract.
 *
 * Discrimination: remove the flag → safari_evaluate's requirements no
 * longer include `requiresAsyncJs`, this test fails. Restore → passes.
 */
import { describe, it, expect } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import type { IEngine } from '../../../src/engines/engine.js';
import { selectEngine, EngineUnavailableError } from '../../../src/engine-selector.js';

describe('safari_evaluate routing requirements (SD-01)', () => {
  // ExtractionTools only reads getDefinitions() at registration time; the
  // engine reference is only used inside handlers we are not invoking here.
  // A bare object cast satisfies the constructor without producing a stub
  // module — strict adherence to the unit-tests boundary policy in CLAUDE.md
  // (no mocking of internal modules).
  const stubEngine = {} as IEngine;
  const defs = new ExtractionTools(stubEngine).getDefinitions();
  const evalDef = defs.find((d) => d.name === 'safari_evaluate');

  it('exists in the registered tool definitions', () => {
    expect(evalDef, 'safari_evaluate must be registered').toBeDefined();
  });

  it('declares requiresAsyncJs: true so extension is the only legal engine', () => {
    // The contract: engine-selector.ts treats requiresAsyncJs as a hard
    // gate. Without this flag, the selector silently falls through to
    // daemon/applescript and returns a Promise object the caller cannot
    // resolve.
    expect(evalDef!.requirements.requiresAsyncJs).toBe(true);
  });

  it('idempotent stays false (script execution is non-idempotent)', () => {
    // Side-guard: this test catches accidental flips of the existing
    // idempotent flag while the requirements object is being edited.
    expect(evalDef!.requirements.idempotent).toBe(false);
  });

  it('selectEngine throws EngineUnavailableError when extension is down', () => {
    // The behavioural consequence of requiresAsyncJs=true: when the
    // extension is unavailable, the selector throws instead of returning
    // a wrong-engine fallback. server.ts catches this and returns a
    // degraded {error: EXTENSION_REQUIRED} envelope rather than running
    // the script through a Promise-eating wrapper.
    expect(() =>
      selectEngine(
        evalDef!.requirements,
        { extension: false, daemon: true },
      ),
    ).toThrow(EngineUnavailableError);
  });

  it('selectEngine routes to extension when available', () => {
    expect(
      selectEngine(
        evalDef!.requirements,
        { extension: true, daemon: true },
      ),
    ).toBe('extension');
  });
});
