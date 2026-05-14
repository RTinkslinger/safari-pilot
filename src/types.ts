export type Engine = 'extension' | 'daemon' | 'applescript';

export interface EngineCapabilities {
  shadowDom: boolean;
  cspBypass: boolean;
  dialogIntercept: boolean;
  networkIntercept: boolean;
  cookieHttpOnly: boolean;
  framesCrossOrigin: boolean;
  /**
   * Whether the engine awaits Promise-returning injected scripts.
   * AppleScript's `do JavaScript` and the daemon's AppleScript wrapper are
   * synchronous — a `return new Promise(...)` serializes as `{}` or
   * `[object Promise]`, silently dropping the real result. Only the
   * extension's content-main.js awaits the injected function's return value.
   */
  asyncJs: boolean;
  /**
   * Whether the engine can capture rendered WebView pixels for a specific
   * tab via browser.tabs.captureVisibleTab. Only the extension can; daemon
   * and AppleScript engines have no path to the rendered viewport.
   */
  viewportCapture?: boolean;
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
  /**
   * v0.1.35 Task 6 — `true` keeps the strict semantic: tool MUST run on the
   * Extension engine; if Extension is unavailable, EngineUnavailableError
   * fires before the tool runs (used by sentinel-only paths like
   * safari_get_text/get_html/get_attribute via buildLocatorSentinel).
   * `'preferred'` means: prefer the Extension engine when available, but
   * fall back to AppleScript/Daemon rather than throwing. Used for tools
   * with a config-gated legacy IIFE fallback path (safari_click, safari_fill,
   * safari_type, safari_scroll). The pre-call extension health gate also
   * checks for `=== true`, so 'preferred' tools don't force extension recovery
   * when the extension is genuinely unreachable.
   */
  requiresCspBypass?: boolean | 'preferred';
  requiresDialogIntercept?: boolean;
  requiresNetworkIntercept?: boolean;
  requiresCookieHttpOnly?: boolean;
  requiresFramesCrossOrigin?: boolean;
  /**
   * Tool's injected JS uses `return new Promise(...)` or otherwise needs the
   * engine to await the return value. Routed only to engines where
   * `EngineCapabilities.asyncJs === true`.
   */
  requiresAsyncJs?: boolean;
  /**
   * The tool needs to capture rendered WebView pixels (screenshots).
   * Forces routing to the extension engine; the daemon and AppleScript
   * paths cannot capture WebView contents.
   */
  requiresViewportCapture?: boolean;
  prefersFastLatency?: boolean;
  /**
   * T63 — tool's handler always uses raw AppleScript regardless of engine
   * availability (e.g. NavigationTools constructed with AppleScriptEngine
   * directly, bypassing EngineProxy). Setting this makes `selectEngine`
   * return 'applescript', so the result-metadata stamping in
   * `executeToolWithSecurity` (server.ts:982,997) reflects what actually
   * ran. Honesty-only: no correctness impact, since these tools were
   * already running on AppleScript — the bug was telemetry lying.
   *
   * Tools that require extension capability (Shadow DOM, CSP bypass, etc.)
   * MUST NOT set this — extension correctness wins over telemetry honesty.
   */
  requiresApplescript?: boolean;
}

export interface EngineResult {
  ok: boolean;
  value?: string;
  error?: EngineError;
  elapsed_ms: number;
  meta?: { tabId?: number; tabUrl?: string };
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
  /**
   * MCP `CallToolResult.isError`. Tool-level errors that take a
   * soft-return path (e.g. `HumanApprovalRequiredError` — which surfaces
   * a structured `approvalRequired` payload instead of throwing) must
   * set this so MCP clients can distinguish them from successful calls.
   * Other security failures throw and are converted to MCP errors by
   * the SDK automatically.
   */
  isError?: boolean;
  metadata: {
    engine: Engine;
    degraded: boolean;
    degradedReason?: string;
    latencyMs: number;
    tabUrl?: string;
    /** Cluster G — server-produced hints for the agent's next call.
     *  Each entry names a tool and explains why it is the recommended
     *  follow-up given what just happened (e.g. after safari_navigate
     *  the suggestion is safari_snapshot to orient). Optional; omit when
     *  no strong recommendation exists. */
    suggested_next_tools?: Array<{ tool: string; reason: string }>;
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
