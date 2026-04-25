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
    // T34: false until extension/manifest.json content_scripts entries gain
    // `all_frames: true` (tracked under T55). Without manifest all_frames the
    // extension cannot run inside cross-origin iframes — see
    // test/unit/engine-selector/cap-manifest-parity.test.ts for the invariant.
    framesCrossOrigin: false,
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

/**
 * True when the tool's declared capabilities can only be served by the
 * Safari Web Extension — Shadow DOM piercing, CSP bypass, dialog/network
 * interception, HttpOnly cookies, cross-origin frames, async JS.
 *
 * Used by `selectEngine` (routing) and the pre-call health gate in
 * `SafariPilotServer.executeToolWithSecurity` (T28 — to skip extension
 * recovery for AppleScript-only tools when the extension is unreachable).
 */
export function requiresExtension(tool: ToolRequirements): boolean {
  return !!(
    tool.requiresShadowDom ||
    tool.requiresCspBypass ||
    tool.requiresDialogIntercept ||
    tool.requiresNetworkIntercept ||
    tool.requiresCookieHttpOnly ||
    tool.requiresFramesCrossOrigin ||
    tool.requiresAsyncJs
  );
}

export function selectEngine(
  tool: ToolRequirements,
  available: { daemon: boolean; extension: boolean },
  breaker?: { isEngineTripped(engine: string): boolean },
  config?: { extension?: { enabled?: boolean } }
): Engine {
  const extensionKilled = config?.extension?.enabled === false;
  const breakerTripped = breaker?.isEngineTripped('extension') === true;
  const extensionAvailable = available.extension && !extensionKilled && !breakerTripped;

  if (requiresExtension(tool)) {
    if (extensionAvailable) return 'extension';
    throw new EngineUnavailableError(
      'This operation requires the Safari Web Extension which is not available'
    );
  }

  if (extensionAvailable) return 'extension';
  if (available.daemon) return 'daemon';
  return 'applescript';
}
