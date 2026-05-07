import { describe, it, expect } from 'vitest';
import { selectEngine, requiresExtension, ENGINE_CAPS, EngineUnavailableError } from '../../../src/engine-selector.js';

describe('engine-selector — viewport capture (Task 4)', () => {
  it('ENGINE_CAPS.extension.viewportCapture === true', () => {
    expect(ENGINE_CAPS.extension.viewportCapture).toBe(true);
  });

  it('ENGINE_CAPS.daemon.viewportCapture is falsy', () => {
    expect(ENGINE_CAPS.daemon.viewportCapture).toBeFalsy();
  });

  it('ENGINE_CAPS.applescript.viewportCapture is falsy', () => {
    expect(ENGINE_CAPS.applescript.viewportCapture).toBeFalsy();
  });

  it('requiresExtension returns true for {requiresViewportCapture: true}', () => {
    expect(requiresExtension({ idempotent: false, requiresViewportCapture: true })).toBe(true);
  });

  it('selectEngine routes viewport-capture tool to extension when available', () => {
    const engine = selectEngine(
      { idempotent: false, requiresViewportCapture: true },
      { daemon: true, extension: true }
    );
    expect(engine).toBe('extension');
  });

  it('selectEngine throws EngineUnavailableError when extension unavailable', () => {
    expect(() => selectEngine(
      { idempotent: false, requiresViewportCapture: true },
      { daemon: true, extension: false }
    )).toThrow(EngineUnavailableError);
  });
});
