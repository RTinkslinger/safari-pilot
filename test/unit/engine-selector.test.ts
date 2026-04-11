import { describe, it, expect } from 'vitest';
import { selectEngine, EngineUnavailableError, ENGINE_CAPS } from '../../src/engine-selector.js';
import type { ToolRequirements } from '../../src/types.js';

const ALL_AVAILABLE = { daemon: true, extension: true };
const DAEMON_ONLY = { daemon: true, extension: false };
const NEITHER = { daemon: false, extension: false };

describe('selectEngine', () => {
  it('selects extension when requiresShadowDom is true and extension is available', () => {
    const result = selectEngine({ requiresShadowDom: true }, ALL_AVAILABLE);
    expect(result).toBe('extension');
  });

  it('selects extension when requiresCspBypass is true and extension is available', () => {
    const result = selectEngine({ requiresCspBypass: true }, ALL_AVAILABLE);
    expect(result).toBe('extension');
  });

  it('selects extension when requiresDialogIntercept is true and extension is available', () => {
    const result = selectEngine({ requiresDialogIntercept: true }, ALL_AVAILABLE);
    expect(result).toBe('extension');
  });

  it('selects extension when requiresNetworkIntercept is true and extension is available', () => {
    const result = selectEngine({ requiresNetworkIntercept: true }, ALL_AVAILABLE);
    expect(result).toBe('extension');
  });

  it('selects extension when requiresCookieHttpOnly is true and extension is available', () => {
    const result = selectEngine({ requiresCookieHttpOnly: true }, ALL_AVAILABLE);
    expect(result).toBe('extension');
  });

  it('selects extension when requiresFramesCrossOrigin is true and extension is available', () => {
    const result = selectEngine({ requiresFramesCrossOrigin: true }, ALL_AVAILABLE);
    expect(result).toBe('extension');
  });

  it('prefers extension over daemon and applescript when no requirements and all available', () => {
    const result = selectEngine({}, ALL_AVAILABLE);
    expect(result).toBe('extension');
  });

  it('prefers daemon over applescript when extension unavailable and no requirements', () => {
    const result = selectEngine({}, DAEMON_ONLY);
    expect(result).toBe('daemon');
  });

  it('falls back to applescript when daemon and extension both unavailable', () => {
    const result = selectEngine({}, NEITHER);
    expect(result).toBe('applescript');
  });

  it('throws EngineUnavailableError with EXTENSION_REQUIRED code when extension needed but unavailable', () => {
    expect(() => selectEngine({ requiresShadowDom: true }, DAEMON_ONLY)).toThrow(
      EngineUnavailableError
    );
    try {
      selectEngine({ requiresShadowDom: true }, DAEMON_ONLY);
    } catch (err) {
      expect(err).toBeInstanceOf(EngineUnavailableError);
      expect((err as EngineUnavailableError).code).toBe('EXTENSION_REQUIRED');
      expect((err as EngineUnavailableError).name).toBe('EngineUnavailableError');
    }
  });

  it('EngineUnavailableError message mentions Safari Web Extension', () => {
    expect(() => selectEngine({ requiresCspBypass: true }, NEITHER)).toThrowError(
      /Safari Web Extension/
    );
  });
});

describe('ENGINE_CAPS', () => {
  it('extension has all capabilities enabled', () => {
    const caps = ENGINE_CAPS.extension;
    expect(caps.shadowDom).toBe(true);
    expect(caps.cspBypass).toBe(true);
    expect(caps.dialogIntercept).toBe(true);
    expect(caps.networkIntercept).toBe(true);
    expect(caps.cookieHttpOnly).toBe(true);
    expect(caps.framesCrossOrigin).toBe(true);
  });

  it('daemon and applescript have no advanced capabilities', () => {
    for (const engine of ['daemon', 'applescript'] as const) {
      const caps = ENGINE_CAPS[engine];
      expect(caps.shadowDom).toBe(false);
      expect(caps.cspBypass).toBe(false);
      expect(caps.dialogIntercept).toBe(false);
    }
  });
});
