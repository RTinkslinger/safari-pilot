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
    asyncJs: true,
    latencyMs: 10,
  },
  daemon: {
    shadowDom: false,
    cspBypass: false,
    dialogIntercept: false,
    networkIntercept: false,
    cookieHttpOnly: false,
    framesCrossOrigin: false,
    asyncJs: false,
    latencyMs: 5,
  },
  applescript: {
    shadowDom: false,
    cspBypass: false,
    dialogIntercept: false,
    networkIntercept: false,
    cookieHttpOnly: false,
    framesCrossOrigin: false,
    asyncJs: false,
    latencyMs: 80,
  },
};

export function selectEngine(
  tool: ToolRequirements,
  available: { daemon: boolean; extension: boolean },
  breaker?: { isEngineTripped(engine: string): boolean },
  config?: { extension?: { enabled?: boolean } }
): Engine {
  const extensionKilled = config?.extension?.enabled === false;
  const breakerTripped = breaker?.isEngineTripped('extension') === true;
  const extensionAvailable = available.extension && !extensionKilled && !breakerTripped;

  const needsExtension =
    tool.requiresShadowDom ||
    tool.requiresCspBypass ||
    tool.requiresDialogIntercept ||
    tool.requiresNetworkIntercept ||
    tool.requiresCookieHttpOnly ||
    tool.requiresFramesCrossOrigin ||
    tool.requiresAsyncJs;

  if (needsExtension) {
    if (extensionAvailable) return 'extension';
    throw new EngineUnavailableError(
      'This operation requires the Safari Web Extension which is not available'
    );
  }

  if (extensionAvailable) return 'extension';
  if (available.daemon) return 'daemon';
  return 'applescript';
}
