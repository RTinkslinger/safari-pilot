// Single source of truth for frameId routing across 10 frame-aware tool handlers.
// Tools call this instead of dispatching engine.executeJsInTab / executeJsInFrame
// themselves.
//
// Contract:
//   params.frameId == null OR === 0 → engine.executeJsInTab (top frame, any engine)
//   params.frameId > 0 + engine.name === 'extension' → engine.executeJsInFrame
//   params.frameId > 0 + engine.name !== 'extension' → throws FrameNotSupportedError
//
// Why this exists: spec D7 maximal v1 = 10 tools accept frameId. Without a shared
// helper the routing rule drifts across tool handlers as new tools land. The
// parameterized test in frame-aware-tools-routing.test.ts (Task 18) verifies all
// 10 tools' adoption of this helper.

import { FrameNotSupportedError } from '../errors.js';
import type { IEngine } from '../engines/engine.js';
import type { EngineResult } from '../types.js';

export async function routeFrameAware(
  engine: IEngine,
  params: { tabUrl: string; frameId?: number },
  jsCode: string,
  timeout?: number,
): Promise<EngineResult> {
  const frameId = params.frameId;
  if (frameId == null || frameId === 0) {
    return engine.executeJsInTab(params.tabUrl, jsCode, timeout);
  }
  if (engine.name !== 'extension') {
    throw new FrameNotSupportedError();
  }
  return engine.executeJsInFrame(params.tabUrl, frameId, jsCode, timeout);
}
