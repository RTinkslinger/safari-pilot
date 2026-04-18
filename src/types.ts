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
  /**
   * Whether the tool is safe to retry automatically if the caller observes an
   * ambiguous disconnect (e.g. Extension engine loses native-host socket mid-call
   * with no success confirmation). Tools that mutate page or browser state —
   * clicks, typing, navigation, cookie writes, permission overrides — must be
   * `false` so the caller is required to make an explicit retry decision.
   *
   * Required — no default. Every registered tool must declare this.
   */
  idempotent: boolean;
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

export interface StructuredUncertainty {
  disconnectPhase: 'before_dispatch' | 'after_dispatch_before_ack' | 'after_ack_before_result';
  likelyExecuted: boolean;
  recommendation: 'probe_state' | 'caller_decides';
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
  /**
   * Populated only for EXTENSION_UNCERTAIN errors. Surfaces the disconnect phase
   * and recommended caller action so non-idempotent tools can make an informed
   * retry decision instead of being auto-retried.
   */
  uncertainResult?: StructuredUncertainty;
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

export interface ClickContext {
  href: string | undefined;
  downloadAttr: string | undefined;
  isDownloadLink: boolean;
  tabUrl: string;
  timestamp: number;
}
