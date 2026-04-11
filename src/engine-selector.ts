import type { Engine, ToolRequirements, EngineCapabilities } from './types.js';

export class EngineUnavailableError extends Error {
  readonly code = 'EXTENSION_REQUIRED';
  constructor(message: string) {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

export const ENGINE_CAPS: Record<Engine, EngineCapabilities> = {
  extension: {
    shadowDom: true,
    cspBypass: true,
    dialogIntercept: true,
    networkIntercept: true,
    cookieHttpOnly: true,
    framesCrossOrigin: true,
    latencyMs: 10,
  },
  daemon: {
    shadowDom: false,
    cspBypass: false,
    dialogIntercept: false,
    networkIntercept: false,
    cookieHttpOnly: false,
    framesCrossOrigin: false,
    latencyMs: 5,
  },
  applescript: {
    shadowDom: false,
    cspBypass: false,
    dialogIntercept: false,
    networkIntercept: false,
    cookieHttpOnly: false,
    framesCrossOrigin: false,
    latencyMs: 80,
  },
};

export function selectEngine(
  tool: ToolRequirements,
  available: { daemon: boolean; extension: boolean }
): Engine {
  const needsExtension =
    tool.requiresShadowDom ||
    tool.requiresCspBypass ||
    tool.requiresDialogIntercept ||
    tool.requiresNetworkIntercept ||
    tool.requiresCookieHttpOnly ||
    tool.requiresFramesCrossOrigin;

  if (needsExtension) {
    if (available.extension) return 'extension';
    throw new EngineUnavailableError(
      'This operation requires the Safari Web Extension which is not available'
    );
  }

  if (available.extension) return 'extension';
  if (available.daemon) return 'daemon';
  return 'applescript';
}
