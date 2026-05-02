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
    // T55a (2026-05-02): true = the extension can inject content scripts into
    // typical cross-origin iframes via manifest all_frames:true with frame-aware
    // storage-bus routing (commandId-keyed sp_cmd_<id>/sp_result_<id> + lazy
    // sp_getFrameId handshake + frameUrl mutation guard). FRAME_UNREACHABLE is
    // returned when injection fails for a specific frame (sandbox without
    // allow-scripts, page CSP blocking extension scripts, COOP/COEP isolation,
    // or silent injection failure). FRAME_NOT_FOUND for stale frameIds at
    // dispatch (validated via webNavigation.getAllFrames). Invariant guarded
    // by test/unit/engine-selector/cap-manifest-parity.test.ts.
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

  // T63 — tools that always use raw AppleScript (NavigationTools, CompoundTools,
  // safari_health_check) declare `requiresApplescript` so the engine telemetry
  // matches reality. Checked AFTER `requiresExtension` so a misconfigured tool
  // that sets both flags still routes to extension when extension capability is
  // genuinely required (correctness wins over telemetry honesty).
  if (tool.requiresApplescript) return 'applescript';

  if (extensionAvailable) return 'extension';
  if (available.daemon) return 'daemon';
  return 'applescript';
}
