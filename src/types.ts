export type Engine = 'extension' | 'daemon' | 'applescript';

export interface EngineCapabilities {
  shadowDom: boolean;
  cspBypass: boolean;
  dialogIntercept: boolean;
  networkIntercept: boolean;
  cookieHttpOnly: boolean;
  framesCrossOrigin: boolean;
  latencyMs: number;
}

export interface ToolRequirements {
  requiresShadowDom?: boolean;
  requiresCspBypass?: boolean;
  requiresDialogIntercept?: boolean;
  requiresNetworkIntercept?: boolean;
  requiresCookieHttpOnly?: boolean;
  requiresFramesCrossOrigin?: boolean;
  prefersFastLatency?: boolean;
}

export interface EngineResult {
  ok: boolean;
  value?: string;
  error?: EngineError;
  elapsed_ms: number;
}

export interface EngineError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ToolError {
  code: string;
  message: string;
  retryable: boolean;
  hints: string[];
  context: {
    engine: Engine;
    url: string;
    selector?: string;
    elapsed_ms: number;
  };
  cause_chain?: string[];
}

export interface ToolResponse {
  content: Array<{ type: 'text' | 'image'; text?: string; data?: string; mimeType?: string }>;
  metadata: {
    engine: Engine;
    degraded: boolean;
    degradedReason?: string;
    latencyMs: number;
    tabUrl?: string;
  };
}

export type TabId = number;

export interface TabInfo {
  tabId: TabId;
  url: string;
  title: string;
  windowId: number;
  isPrivate: boolean;
  ownedByAgent: boolean;
  isActive: boolean;
}

export interface DomainPolicy {
  domain: string;
  trust: 'trusted' | 'untrusted' | 'unknown';
  privateWindow: boolean;
  extensionAllowed: boolean;
  maxActionsPerMinute: number;
}

export interface AuditEntry {
  timestamp: string;
  tool: string;
  tabUrl: string;
  engine: Engine;
  params: Record<string, unknown>;
  result: 'ok' | 'error';
  elapsed_ms: number;
  session: string;
}
