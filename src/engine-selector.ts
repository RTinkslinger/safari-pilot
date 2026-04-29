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
    // T34: false until the extension can correctly route per-frame messages.
    // T55 (2026-04-29) confirmed that adding `all_frames: true` to the manifest
    // alone is insufficient — the storage bus (`sp_cmd`/`sp_result`) is keyed
    // only on `commandId` with no `frameId` discrimination, so every frame
    // would race to write the single result slot (last-writer-wins). The real
    // prereq is frame-aware storage-bus routing, tracked as T55a. Once T55a
    // lands and the manifest gains `all_frames: true`, this flips to true in
    // the same commit. Invariant guarded by
    // test/unit/engine-selector/cap-manifest-parity.test.ts.
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
