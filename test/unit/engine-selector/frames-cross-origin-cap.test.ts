/**
 * T55a — framesCrossOrigin capability flag tests.
 *
 * Three assertions:
 * 1. ENGINE_CAPS.extension.framesCrossOrigin is true after T55a lands.
 * 2. selectEngine routes to extension when a tool sets requiresFramesCrossOrigin
 *    AND extension is available.
 * 3. selectEngine throws EngineUnavailableError when extension is unavailable
 *    and a tool requires framesCrossOrigin (no silent fallback to AppleScript
 *    that would surface a SecurityError DOMException for cross-origin).
 *
 * Litmus: removing requiresFramesCrossOrigin: true from a frame-aware tool's
 * static requirements would silently allow it to route to AppleScript when
 * extension is down — caller would get a confusing DOMException instead of
 * the typed FrameNotSupportedError. The cap flag + selector check is the gate.
 */
import { describe, it, expect } from 'vitest';
import { selectEngine, ENGINE_CAPS, EngineUnavailableError } from '../../../src/engine-selector.js';

describe('framesCrossOrigin capability flag (T55a)', () => {
  it('ENGINE_CAPS.extension.framesCrossOrigin is true after T55a', () => {
    expect(ENGINE_CAPS.extension.framesCrossOrigin).toBe(true);
  });

  it('selectEngine returns extension for tool with requiresFramesCrossOrigin when extension available', () => {
    const tool = { idempotent: false, requiresFramesCrossOrigin: true };
    expect(selectEngine(tool, { extension: true, daemon: true })).toBe('extension');
  });

  it('selectEngine throws EngineUnavailableError when requiresFramesCrossOrigin and extension unavailable', () => {
    const tool = { idempotent: false, requiresFramesCrossOrigin: true };
    expect(() => selectEngine(tool, { extension: false, daemon: true })).toThrow(EngineUnavailableError);
  });
});
