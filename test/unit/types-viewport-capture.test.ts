import { describe, it, expect } from 'vitest';
import type { ToolRequirements, EngineCapabilities } from '../../src/types.js';

describe('viewport capture types (Task 3)', () => {
  it('ToolRequirements has optional requiresViewportCapture', () => {
    const req: ToolRequirements = { idempotent: false, requiresViewportCapture: true };
    expect(req.requiresViewportCapture).toBe(true);
  });

  it('EngineCapabilities has optional viewportCapture', () => {
    const caps: EngineCapabilities = {
      shadowDom: false, cspBypass: false, dialogIntercept: false,
      networkIntercept: false, cookieHttpOnly: false, framesCrossOrigin: false,
      asyncJs: false, latencyMs: 5,
      viewportCapture: true,
    };
    expect(caps.viewportCapture).toBe(true);
  });
});
