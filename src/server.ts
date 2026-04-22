import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Engine, ToolResponse, ToolRequirements, ClickContext } from './types.js';
import type { IEngine } from './engines/engine.js';
import { selectEngine, EngineUnavailableError } from './engine-selector.js';
import { AppleScriptEngine } from './engines/applescript.js';
import { DaemonEngine } from './engines/daemon.js';
import { ExtensionEngine } from './engines/extension.js';
import { EngineProxy } from './engines/engine-proxy.js';
import { NavigationTools } from './tools/navigation.js';
import { InteractionTools } from './tools/interaction.js';
import { ExtractionTools } from './tools/extraction.js';
import { NetworkTools } from './tools/network.js';
import { StorageTools } from './tools/storage.js';
import { ShadowTools } from './tools/shadow.js';
import { FrameTools } from './tools/frames.js';
import { PermissionTools } from './tools/permissions.js';
import { ClipboardTools } from './tools/clipboard.js';
import { ServiceWorkerTools } from './tools/service-workers.js';
import { PerformanceTools } from './tools/performance.js';
import { StructuredExtractionTools } from './tools/structured-extraction.js';
import { WaitTools } from './tools/wait.js';
import { CompoundTools } from './tools/compound.js';
import { DownloadTools } from './tools/downloads.js';
import { PdfTools } from './tools/pdf.js';
import { ExtensionDiagnosticsTools } from './tools/extension-diagnostics.js';
import { KillSwitch } from './security/kill-switch.js';
import { TabOwnership } from './security/tab-ownership.js';
import { AuditLog } from './security/audit-log.js';
import { DomainPolicy } from './security/domain-policy.js';
import { RateLimiter } from './security/rate-limiter.js';
import { CircuitBreaker } from './security/circuit-breaker.js';
import { IdpiScanner } from './security/idpi-scanner.js';
import { HumanApproval } from './security/human-approval.js';
import { ScreenshotRedaction } from './security/screenshot-redaction.js';
import { RateLimitedError, HumanApprovalRequiredError, TabUrlNotRecognizedError, SessionRecoveryError } from './errors.js';
import { loadConfig, DEFAULT_CONFIG, type SafariPilotConfig } from './config.js';
import { trace } from './trace.js';

const execFileAsync = promisify(execFile);

let _traceCounter = 0;
function nextTraceId(): string {
  return `req-${Date.now()}-${++_traceCounter}`;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
  handler: (params: Record<string, unknown>) => Promise<ToolResponse>;
}

// ── HealthCheck helpers ──────────────────────────────────────────────────────

interface HealthCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

async function checkSafariRunning(timeoutMs: number): Promise<HealthCheck> {
  try {
    await execFileAsync('osascript', ['-e', 'tell application "Safari" to return name'], {
      timeout: timeoutMs,
    });
    return { name: 'safari_running', ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: 'safari_running', ok: false, detail: message };
  }
}

async function checkJsFromAppleEvents(timeoutMs: number): Promise<HealthCheck> {
  try {
    const result = await execFileAsync(
      'osascript',
      ['-e', 'tell application "Safari" to do JavaScript "1+1" in current tab of front window'],
      { timeout: timeoutMs },
    );
    const value = result.stdout.trim();
    const ok = value === '2' || value === '2.0';
    return { name: 'js_apple_events', ok, detail: !ok ? `Unexpected: ${value}` : undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'js_apple_events',
      ok: false,
      detail: message.includes('-1743') || message.includes('permission') || message.includes('Apple Events')
        ? 'JS from Apple Events is disabled. Enable in Safari > Develop > Allow JavaScript from Apple Events'
        : message,
    };
  }
}

async function checkScreenRecording(timeoutMs: number): Promise<HealthCheck> {
  try {
    await execFileAsync('screencapture', ['-x', '-t', 'png', '/dev/null'], { timeout: timeoutMs });
    return { name: 'screen_recording', ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'screen_recording',
      ok: false,
      detail: 'Screen Recording permission not granted. Enable in System Settings > Privacy & Security > Screen Recording',
    };
  }
}

// ── Tool names that skip ownership enforcement ──────────────────────────────
// Tab identity tracking now handles back/forward via extension tab.id — no
// need to skip ownership for those tools. They go through the deferred path.
const SKIP_OWNERSHIP_TOOLS = new Set([
  'safari_list_tabs',
  'safari_new_tab',
  'safari_health_check',
]);

/**
 * Infrastructure message types that bypass the 9-layer security pipeline.
 * These are daemon↔extension coordination messages (poll/drain/reconcile/log/result/
 * connect/disconnect), not per-domain tool calls. Analogous to SKIP_OWNERSHIP_TOOLS
 * for tab-management tools.
 *
 * Commits 1b (reconcile, drain) populate this set's real routing; commit 1a declares
 * it so the bypass contract is documented and enforceable up-front.
 */
export const INFRA_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'extension_poll',
  'extension_drain',
  'extension_reconcile',
  'extension_connected',
  'extension_disconnected',
  'extension_log',
  'extension_result',
]);

export class SafariPilotServer {
  private tools: Map<string, ToolDefinition> = new Map();
  private engines: Map<Engine, IEngine> = new Map();
  private engineAvailability = { daemon: false, extension: false };
  private sessionId: string = `sess_${Date.now().toString(36)}`;
  private _engine: AppleScriptEngine | null = null;
  readonly config: SafariPilotConfig;

  // ── Security layers ─────────────────────────────────────────────────────────
  readonly killSwitch: KillSwitch;
  readonly tabOwnership: TabOwnership;
  readonly auditLog: AuditLog;
  readonly domainPolicy: DomainPolicy;
  readonly rateLimiter: RateLimiter;
  readonly circuitBreaker: CircuitBreaker;
  readonly idpiScanner: IdpiScanner;
  readonly humanApproval: HumanApproval;
  readonly screenshotRedaction: ScreenshotRedaction;

  private engineProxy: EngineProxy | null = null;
  private clickContexts: Map<string, ClickContext> = new Map();
  private clickContextTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private _nextTabIndex = 1;
  private _sessionTabOpened = false;
  private _sessionWindowId: number | undefined;
  private _extensionBootstrapAttempted = false;
  private _initMeta: {
    sessionId: string;
    windowId: number | null;
    existingSessions: number;
    systems: { daemon: boolean; extension: boolean; sessionTab: boolean };
    initDurationMs: number;
  } | undefined;

  private get sessionTabUrl(): string {
    return `http://127.0.0.1:19475/session?id=${this.sessionId}`;
  }

  constructor(config?: SafariPilotConfig) {
    this.config = config ?? DEFAULT_CONFIG;

    this.auditLog = new AuditLog({
      maxEntries: this.config.audit.maxEntries,
      logPath: this.config.audit.logPath,
    });
    this.killSwitch = new KillSwitch({
      auditLog: this.auditLog,
      autoActivation: this.config.killSwitch.autoActivation
        ? { maxErrors: this.config.killSwitch.maxErrors, windowSeconds: this.config.killSwitch.windowSeconds }
        : undefined,
    });
    this.tabOwnership = new TabOwnership();
    this.domainPolicy = new DomainPolicy({
      blocked: this.config.domainPolicy.blocked,
      trusted: this.config.domainPolicy.trusted,
      defaultMaxActionsPerMinute: this.config.domainPolicy.defaultMaxActionsPerMinute,
    });
    this.rateLimiter = new RateLimiter({
      windowMs: this.config.rateLimit.windowMs,
      globalLimit: this.config.rateLimit.maxActionsPerMinute,
    });
    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: this.config.circuitBreaker.errorThreshold,
      windowMs: this.config.circuitBreaker.windowMs,
      cooldownMs: this.config.circuitBreaker.cooldownMs,
    });
    this.idpiScanner = new IdpiScanner();
    this.humanApproval = new HumanApproval();
    this.screenshotRedaction = new ScreenshotRedaction();
  }

  async initialize(): Promise<void> {
    const daemonEngine = new DaemonEngine({ timeoutMs: this.config.daemon.timeoutMs });
    const daemonAvailable = await daemonEngine.isAvailable();
    let extensionAvailable = false;
    if (daemonAvailable) {
      this.engines.set('daemon', daemonEngine);
      const extensionEngine = new ExtensionEngine(daemonEngine);
      // Always register — extension routes through daemon so the instance is always
      // valid. It may not be *connected* yet (session tab hasn't opened), but
      // ensureExtensionReady() will bootstrap it on first tool call.
      this.engines.set('extension', extensionEngine);
      extensionAvailable = await extensionEngine.isAvailable();
    } else {
      await daemonEngine.shutdown();
    }
    this.setEngineAvailability({ daemon: daemonAvailable, extension: extensionAvailable });

    // Instantiate the AppleScript engine (always available as fallback)
    const engine = new AppleScriptEngine();
    this._engine = engine;

    // Register health check tool (real implementation)
    this.registerTool({
      name: 'safari_health_check',
      description: 'Verify all required macOS permissions and system prerequisites are met.',
      inputSchema: {
        type: 'object',
        properties: {
          verbose: {
            type: 'boolean',
            description: 'Include detailed system info',
            default: false,
          },
        },
      },
      requirements: { idempotent: true },
      handler: async (params) => this.handleHealthCheck(params),
    });

    // Create engine proxy — tools receive this and it delegates to whichever
    // engine selectEngine() picks before each call. This ensures engine selection
    // actually affects execution, not just metadata.
    const proxy = new EngineProxy(engine);
    this.engineProxy = proxy;

    // Instantiate tool modules with the proxy (IEngine-accepting) or AppleScript
    // engine directly (for tab management tools that always need AppleScript)
    const navTools = new NavigationTools(engine);
    const interactionTools = new InteractionTools(proxy, this);
    const extractionTools = new ExtractionTools(proxy);
    const networkTools = new NetworkTools(proxy);
    const storageTools = new StorageTools(proxy);
    const shadowTools = new ShadowTools(proxy);
    const frameTools = new FrameTools(proxy);
    const permissionTools = new PermissionTools(proxy);
    const clipboardTools = new ClipboardTools(proxy);
    const serviceWorkerTools = new ServiceWorkerTools(proxy);
    const performanceTools = new PerformanceTools(proxy);
    const structuredExtractionTools = new StructuredExtractionTools(proxy);
    const waitTools = new WaitTools(proxy);
    const compoundTools = new CompoundTools(engine);
    const downloadTools = new DownloadTools(this);
    const pdfTools = new PdfTools(this);
    const extensionDiagnosticsTools = new ExtensionDiagnosticsTools(
      daemonAvailable ? daemonEngine : null,
    );

    // Register all tools from all modules.
    // Each module may have getHandler returning Handler (NavigationTools) or Handler | undefined.
    type ToolModule = {
      getDefinitions: () => Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        requirements: ToolRequirements;
      }>;
      getHandler: (name: string) => ((params: Record<string, unknown>) => Promise<ToolResponse>) | undefined;
    };

    const modules: ToolModule[] = [
      navTools as unknown as ToolModule,
      interactionTools,
      extractionTools,
      networkTools,
      storageTools,
      shadowTools,
      frameTools,
      permissionTools,
      clipboardTools as unknown as ToolModule,
      serviceWorkerTools as unknown as ToolModule,
      performanceTools as unknown as ToolModule,
      structuredExtractionTools as unknown as ToolModule,
      waitTools as unknown as ToolModule,
      compoundTools as unknown as ToolModule,
      downloadTools,
      pdfTools,
      extensionDiagnosticsTools,
    ];

    for (const module of modules) {
      for (const def of module.getDefinitions()) {
        const handler = module.getHandler(def.name);
        if (!handler) {
          throw new Error(`No handler found for tool "${def.name}"`);
        }
        this.registerTool({
          ...def,
          handler,
        });
      }
    }

    // Emergency stop — system tool, registered directly (not via a module)
    this.registerTool({
      name: 'safari_emergency_stop',
      description:
        'Emergency stop — immediately close all agent-owned tabs, activate kill switch, and block all further automation.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Reason for the emergency stop' },
        },
      },
      requirements: { idempotent: false },
      handler: async (params) => {
        const reason = (params['reason'] as string | undefined) ?? 'emergency_stop called';
        this.killSwitch.activate(reason);
        return {
          content: [{ type: 'text', text: JSON.stringify({ stopped: true, reason }) }],
          metadata: { engine: 'applescript' as Engine, degraded: false, latencyMs: 0 },
        };
      },
    });
  }

  private async handleHealthCheck(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const checks: HealthCheck[] = [];

    const timeout = this.config.healthCheck.timeoutMs;

    const safariCheck = await checkSafariRunning(timeout);
    checks.push(safariCheck);

    const jsCheck = await checkJsFromAppleEvents(timeout);
    checks.push(jsCheck);

    const srCheck = await checkScreenRecording(timeout);
    checks.push(srCheck);

    // 4. Daemon available?
    checks.push({ name: 'daemon', ok: this.engineAvailability.daemon });

    // 5. Extension connected?
    checks.push({ name: 'extension', ok: this.engineAvailability.extension });

    const healthy = checks.every((c) => c.name === 'daemon' || c.name === 'extension' || c.ok);
    const failedChecks = checks.filter((c) => !c.ok).map((c) => c.name);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            healthy,
            checks,
            failedChecks,
            sessionId: this.sessionId,
          }),
        },
      ],
      metadata: {
        engine: 'applescript' as Engine,
        degraded: !healthy,
        latencyMs: Date.now() - start,
      },
    };
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<ToolResponse> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.handler(params);
  }

  /**
   * Execute a tool through the full security pipeline:
   * kill switch → tab ownership → domain policy → rate limiter →
   * circuit breaker → tool execution → audit log
   */
  async executeToolWithSecurity(
    name: string,
    params: Record<string, unknown>,
  ): Promise<ToolResponse> {
    // 0. Pre-call health gate — live check before every tool call
    const preStatus = await this.checkExtensionStatus();
    const windowOk = await this.checkWindowExists();
    this.setEngineAvailability({
      daemon: this.engineAvailability.daemon,
      extension: preStatus.ext,
    });

    if (!preStatus.ext || !windowOk) {
      const recoveryTraceId = `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const recovered = await this.recoverSession(recoveryTraceId);
      if (!recovered) {
        throw new SessionRecoveryError({
          daemon: this.engineAvailability.daemon,
          extension: preStatus.ext,
          window: windowOk,
          durationMs: 10000,
        });
      }
    }

    const start = Date.now();
    const traceId = nextTraceId();
    trace(traceId, 'server', 'tool_received', {
      tool: name,
      tabUrl: ((params['tabUrl'] ?? params['url'] ?? '') as string),
      paramKeys: Object.keys(params),
    });

    // 1. Kill switch check — blocks all automation when active
    this.killSwitch.checkBeforeAction();

    // 2. Extract URL / domain from params
    const url = ((params['tabUrl'] ?? params['url'] ?? '') as string);
    let domain: string;
    try {
      domain = new URL(url || 'about:blank').hostname;
    } catch {
      domain = '';
    }

    // 3. (Ownership check moved to after engine selection — needs selectedEngineName for deferral)

    // 4. Domain policy evaluation
    const policy = this.domainPolicy.evaluate(url);
    trace(traceId, 'server', 'domain_policy', {
      domain,
      trustLevel: policy.trust,
      blocked: !!policy.blocked,
    });

    // 4a. Blocked domain enforcement — operator-configured blocked list
    if (policy.blocked && domain) {
      this.auditLog.record({
        tool: name, tabUrl: url, engine: 'applescript' as Engine, params,
        result: 'error', elapsed_ms: Date.now() - start, session: this.sessionId,
      });
      throw new Error(`Domain '${domain}' is blocked by configuration. Remove it from domainPolicy.blocked to allow access.`);
    }

    // 4b. Human approval check — sensitive actions on untrusted domains
    try {
      this.humanApproval.assertApproved(name, url, params);
    } catch (err) {
      if (err instanceof HumanApprovalRequiredError) {
        this.auditLog.record({
          tool: name,
          tabUrl: url,
          engine: 'applescript' as Engine,
          params,
          result: 'error',
          elapsed_ms: Date.now() - start,
          session: this.sessionId,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: err.code,
              message: err.message,
              hints: err.hints,
              approvalRequired: true,
            }),
          }],
          metadata: {
            engine: 'applescript' as Engine,
            degraded: true,
            degradedReason: err.message,
            latencyMs: Date.now() - start,
          },
        };
      }
      throw err;
    }

    // 5. Rate limit check — check before recording so we don't consume quota on blocked calls
    const limitCheck = this.rateLimiter.checkLimit(domain);
    if (!limitCheck.allowed) {
      throw new RateLimitedError(domain, policy.maxActionsPerMinute);
    }
    this.rateLimiter.recordAction(domain);
    trace(traceId, 'server', 'rate_limit_check', { domain });

    // 6. Circuit breaker check — assertClosed handles half-open probe logic and
    // reports actual remaining cooldown time (not hardcoded 120s)
    this.circuitBreaker.assertClosed(domain);

    // 7. Engine selection — pick the best available engine for this tool
    const toolDef = this.tools.get(name);
    let selectedEngineName: Engine = 'applescript';
    if (toolDef) {
      try {
        selectedEngineName = selectEngine(
          toolDef.requirements,
          this.engineAvailability,
          this.circuitBreaker,
          this.config,
        );
      } catch (err) {
        if (err instanceof EngineUnavailableError) {
          this.auditLog.record({
            tool: name,
            tabUrl: url,
            engine: 'applescript' as Engine,
            params,
            result: 'error',
            elapsed_ms: Date.now() - start,
            session: this.sessionId,
          });
          return {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            metadata: {
              engine: 'applescript' as Engine,
              latencyMs: Date.now() - start,
              degraded: true,
              degradedReason: err.message,
            },
          };
        }
        throw err;
      }
    }

    // 7b. Set engine proxy delegate so the tool actually uses the selected engine
    if (this.engineProxy) {
      const selectedEngine = this.engines.get(selectedEngineName) || this._engine!;
      this.engineProxy.setDelegate(selectedEngine);
    }

    trace(traceId, 'server', 'engine_selected', {
      engine: selectedEngineName,
      degraded: false,
    });

    // 7c. Reset engine meta to prevent stale reads from previous tool calls
    if (this.engineProxy) {
      this.engineProxy.resetMeta();
    }

    // 7d. Tab ownership check (moved here from step 3 — needs selectedEngineName)
    // When URL not found in registry but extension engine is selected, defer verification
    // to post-execution. The extension result includes _meta.tabId which is matched against
    // the ownership registry via findByExtensionTabId — that is the security gate.
    // This handles cross-domain navigation (click from example.com → iana.org) where the
    // URL changes but the tab.id stays the same.
    let deferredOwnershipCheck = false;
    if (params['tabUrl'] && !SKIP_OWNERSHIP_TOOLS.has(name)) {
      const tabUrl = params['tabUrl'] as string;
      const tabId = this.tabOwnership.findByUrl(tabUrl);
      if (tabId === undefined) {
        // URL not found. If extension engine is selected, defer ownership to post-execution
        // (extension result _meta.tabId identifies the tab, post-verify checks ownership).
        // If not extension engine, fail immediately (no stable identity to verify with).
        if (selectedEngineName === 'extension') {
          deferredOwnershipCheck = true;
        } else {
          throw new TabUrlNotRecognizedError(tabUrl);
        }
      } else {
        this.tabOwnership.assertOwnership(tabId);
        // Inject positional identity so tool handlers can target the exact tab
        // by window id + tab index instead of URL matching.
        const pos = this.tabOwnership.getPosition(tabId);
        if (pos) {
          params['_windowId'] = pos.windowId;
          params['_tabIndex'] = pos.tabIndex;
          // Set on proxy so executeJsInTab uses positional targeting too
          if (this.engineProxy) {
            this.engineProxy.setTabPosition(pos);
          }
        }
      }
    }
    trace(traceId, 'server', 'ownership_check', {
      tabUrl: (params['tabUrl'] as string) ?? null,
      found: params['tabUrl'] ? !!this.tabOwnership.findByUrl(params['tabUrl'] as string) : null,
      deferred: deferredOwnershipCheck,
      skipped: !params['tabUrl'] || SKIP_OWNERSHIP_TOOLS.has(name),
    });

    // 7.5 Engine-degradation re-run
    // When the tool would have preferred the Extension engine (based on availability
    // and breaker state) but engine-selector returned a different engine, re-invoke
    // HumanApproval and IdpiScanner against the new engine's action surface. The
    // invalidate* methods are no-ops at 1a but establish the contract for future
    // engine-aware caching (commit 1c).
    const extensionPreferred = this.engineAvailability.extension === true
      && !this.circuitBreaker.isEngineTripped('extension');
    const degradedFromExtension = extensionPreferred && selectedEngineName !== 'extension';

    let degradationReason: string | undefined;
    if (degradedFromExtension) {
      this.humanApproval.invalidateForDegradation(name);
      this.idpiScanner.invalidateForDegradation(name);
      // Re-assert approval — stateless today, but establishes the pattern
      try {
        this.humanApproval.assertApproved(name, url, params);
      } catch (err) {
        if (err instanceof HumanApprovalRequiredError) {
          this.auditLog.record({
            tool: name,
            tabUrl: url,
            engine: selectedEngineName,
            params,
            result: 'error',
            elapsed_ms: Date.now() - start,
            session: this.sessionId,
          });
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: err.code,
                message: err.message,
                hints: err.hints,
                approvalRequired: true,
              }),
            }],
            metadata: {
              engine: selectedEngineName,
              degraded: true,
              degradedReason: `extension_degraded_approval_required: ${err.message}`,
              latencyMs: Date.now() - start,
            },
          };
        }
        throw err;
      }
      degradationReason = 'extension_unavailable_fallback_to_' + selectedEngineName;
    }

    // 8. Inject traceId into DaemonEngine for cross-process correlation
    const daemonEngine = this.getDaemonEngine();
    if (daemonEngine) {
      daemonEngine.setTraceId(traceId);
    }
    trace(traceId, 'server', 'engine_dispatch', {
      engine: selectedEngineName,
      tabUrl: ((params['tabUrl'] ?? '') as string),
    });

    // 8. Inject session window ID for safari_new_tab so tabs open in the session window
    if (name === 'safari_new_tab' && this._sessionWindowId !== undefined) {
      params['_sessionWindowId'] = this._sessionWindowId;
    }

    // 8pre. Snapshot tabs before click — used to detect website-opened tabs after
    let preClickTabs: Array<{ windowId: number; tabIndex: number; url: string }> | undefined;
    if (name === 'safari_click' && this._engine) {
      preClickTabs = await this._snapshotTabPositions();
    }

    // 8. Execute the tool, record circuit breaker outcome, and audit
    try {
      const result = await this.callTool(name, params);
      this.circuitBreaker.recordSuccess(domain);
      trace(traceId, 'server', 'tool_result', {
        ok: true,
        engine: selectedEngineName,
        metaTabId: this.engineProxy?.getLastMeta()?.tabId ?? null,
        metaTabUrl: this.engineProxy?.getLastMeta()?.tabUrl ?? null,
      }, 'event', Date.now() - start);

      // 8.post: Tab ownership registration — after safari_new_tab succeeds,
      // register the new tab URL so subsequent tool calls pass ownership checks.
      if (name === 'safari_new_tab' && result.content?.[0]?.type === 'text') {
        try {
          const tabData = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
          if (tabData.tabUrl) {
            const syntheticId = TabOwnership.makeTabId(
              tabData.windowId ?? 1,
              this._nextTabIndex++,
            );
            this.tabOwnership.registerTab(syntheticId, tabData.tabUrl, {
              windowId: tabData.windowId,
              tabIndex: tabData.tabIndex,
            });
          }
          // If the session window was closed (WINDOW_CLOSED recovery happened in handler),
          // the new tab opened in front window. Capture that window's ID as the new session window.
          if (this._sessionWindowId !== undefined && !tabData.windowId) {
            try {
              const { execSync } = await import('node:child_process');
              const winId = execSync(
                `osascript -e 'tell application "Safari" to return id of front window'`,
                { timeout: 3000, encoding: 'utf-8' },
              ).trim();
              const parsed = parseInt(winId, 10);
              if (!isNaN(parsed)) {
                this._sessionWindowId = parsed;
              }
            } catch { /* best effort */ }
          }
        } catch { /* tab registration is best-effort — don't fail the tool call */ }
      }

      // 8.post2: Post-execution ownership — read engine meta for tab identity.
      // Extension results include _meta.tabId (stable) + _meta.tabUrl (current URL).
      // Use this to: (a) backfill extensionTabId, (b) refresh URL, (c) verify deferred ownership.
      const engineMeta = this.engineProxy?.getLastMeta();
      if (engineMeta?.tabId !== undefined) {
        const extTabId = engineMeta.tabId;
        const extTabUrl = engineMeta.tabUrl;

        // Backfill extensionTabId on first extension call for this tab
        const tabUrl = params['tabUrl'] as string | undefined;
        if (tabUrl) {
          const ownedByUrl = this.tabOwnership.findByUrl(tabUrl);
          if (ownedByUrl !== undefined) {
            this.tabOwnership.setExtensionTabId(ownedByUrl, extTabId);
          }
        }

        // Refresh URL in registry (keeps findByUrl working for subsequent calls)
        const ownedByExtId = this.tabOwnership.findByExtensionTabId(extTabId);
        if (ownedByExtId !== undefined && extTabUrl) {
          this.tabOwnership.updateUrl(ownedByExtId, extTabUrl);
        }

        // Deferred ownership verification — was the tab actually ours?
        if (deferredOwnershipCheck) {
          if (ownedByExtId === undefined) {
            // Extension executed on a tab we don't own — block the result from reaching agent
            throw new TabUrlNotRecognizedError(params['tabUrl'] as string);
          }
          // Tab is owned — result is safe to return
        }
      } else if (deferredOwnershipCheck) {
        // Extension didn't return _meta. This happens for tools that use
        // engine.execute() (AppleScript) internally instead of executeJsInTab() —
        // e.g., safari_navigate navigates via AppleScript, which has no tab identity.
        //
        // For navigate: the tool result contains the final URL. Update the ownership
        // registry so subsequent calls on the new URL pass findByUrl directly.
        // This is safe: the tool already executed successfully (AppleScript found the
        // tab by URL/position), and deferred check means we trust the extension pipeline.
        if (result.content?.[0]?.type === 'text') {
          try {
            const data = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
            const newUrl = (data.url ?? data.tabUrl) as string | undefined;
            if (newUrl) {
              // Update the first owned tab that has a backfilled extensionTabId.
              // This is the tab we were working with (same tab, URL just changed).
              for (const { tabId } of this.tabOwnership.getAllOwned()) {
                this.tabOwnership.updateUrl(tabId, newUrl);
                break;
              }
            }
          } catch { /* best-effort URL update */ }
        }
        // Don't throw — the tool already executed. Throwing after execution
        // just destroys a valid result without preventing anything.
      }
      trace(traceId, 'server', 'post_verify', {
        deferredVerified: deferredOwnershipCheck,
        metaPresent: !!this.engineProxy?.getLastMeta()?.tabId,
      });

      // 8a. IDPI scan — check extraction tool results for prompt injection attempts
      const EXTRACTION_TOOLS = new Set([
        'safari_get_text', 'safari_get_html', 'safari_snapshot',
        'safari_evaluate', 'safari_get_console_messages',
        'safari_smart_scrape', 'safari_extract_tables',
        'safari_extract_links', 'safari_extract_images',
        'safari_extract_metadata',
      ]);
      if (EXTRACTION_TOOLS.has(name) && result.content) {
        const textContent = result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        if (textContent.length > 0) {
          const scanResult = this.idpiScanner.scan(textContent);
          if (!scanResult.safe) {
            if (!result.metadata) {
              result.metadata = { engine: selectedEngineName, degraded: false, latencyMs: 0 };
            }
            (result.metadata as Record<string, unknown>).idpiThreats = scanResult.threats;
            (result.metadata as Record<string, unknown>).idpiSafe = false;
          }
        }
      }

      // 8b. Screenshot redaction — attach redaction metadata for screenshot tools
      if (name === 'safari_take_screenshot') {
        if (!result.metadata) {
          result.metadata = { engine: selectedEngineName, degraded: false, latencyMs: 0 };
        }
        (result.metadata as Record<string, unknown>).redactionScript = this.screenshotRedaction.getRedactionScript();
        (result.metadata as Record<string, unknown>).redactionApplied = true;
      }

      // 8c. Post-click tab detection — detect tabs opened by website JS (window.open,
      // target="_blank") and auto-register them in the ownership registry. Without
      // this, the agent can't interact with website-opened tabs.
      if (name === 'safari_click' && preClickTabs && this._engine) {
        try {
          // Brief delay for window.open / target=_blank to fire
          await new Promise(r => setTimeout(r, 500));
          const postClickTabs = await this._snapshotTabPositions();
          const preSet = new Set(preClickTabs.map(t => `${t.windowId}:${t.tabIndex}:${t.url}`));
          for (const tab of postClickTabs) {
            const key = `${tab.windowId}:${tab.tabIndex}:${tab.url}`;
            if (!preSet.has(key) && tab.url && tab.url !== 'about:blank') {
              const syntheticId = TabOwnership.makeTabId(tab.windowId, this._nextTabIndex++);
              this.tabOwnership.registerTab(syntheticId, tab.url, {
                windowId: tab.windowId,
                tabIndex: tab.tabIndex,
              });
              trace(traceId, 'server', 'tab_adopted', {
                url: tab.url,
                windowId: tab.windowId,
                tabIndex: tab.tabIndex,
              });
            }
          }
        } catch { /* tab detection is best-effort */ }
      }

      // 9. Audit log — success path
      this.auditLog.record({
        tool: name,
        tabUrl: url,
        engine: selectedEngineName,
        params,
        result: 'ok',
        elapsed_ms: Date.now() - start,
        session: this.sessionId,
      });

      if (result.metadata) {
        result.metadata.engine = selectedEngineName;
      }

      // Propagate engine-degradation reason set by step 7.5 into result metadata
      // so callers can observe the fallback without inspecting server state.
      if (degradationReason && result.metadata && !result.metadata.degradedReason) {
        result.metadata.degradedReason = degradationReason;
        result.metadata.degraded = true;
      }

      // Embed engine in text content so benchmark tracking works even when
      // Claude CLI strips _meta from stream-json output
      if (result.content?.[0]?.type === 'text' && result.content[0].text) {
        try {
          const parsed = JSON.parse(result.content[0].text);
          parsed.__engine = selectedEngineName;
          parsed.__latencyMs = result.metadata?.latencyMs ?? Date.now() - start;
          result.content[0].text = JSON.stringify(parsed);
        } catch {
          // content is not JSON — leave as-is
        }
      }

      return result;
    } catch (error) {
      trace(traceId, 'server', 'tool_error', {
        tool: name,
        error: error instanceof Error ? error.message : String(error),
        code: (error as Record<string, unknown>)?.code ?? 'UNKNOWN',
      }, 'error', Date.now() - start);
      this.circuitBreaker.recordFailure(domain);

      // 9. Audit log — error path
      this.auditLog.record({
        tool: name,
        tabUrl: url,
        engine: selectedEngineName,
        params,
        result: 'error',
        elapsed_ms: Date.now() - start,
        session: this.sessionId,
      });

      throw error;
    }
  }

  getSelectedEngine(requirements: ToolRequirements): Engine {
    return selectEngine(
      requirements,
      this.engineAvailability,
      this.circuitBreaker,
      this.config,
    );
  }

  setEngineAvailability(availability: { daemon: boolean; extension: boolean }): void {
    this.engineAvailability = availability;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getInitMeta(): typeof this._initMeta {
    return this._initMeta;
  }

  setClickContext(ctx: ClickContext): void {
    const key = ctx.tabUrl;
    const existing = this.clickContextTimers.get(key);
    if (existing) clearTimeout(existing);
    this.clickContexts.set(key, ctx);
    this.clickContextTimers.set(key, setTimeout(() => {
      this.clickContexts.delete(key);
      this.clickContextTimers.delete(key);
    }, 60_000));
  }

  /**
   * Snapshot all open tabs with their positional identity.
   * Returns {windowId, tabIndex, url} for each tab across all windows.
   * Used for before/after diff to detect website-opened tabs.
   */
  private async _snapshotTabPositions(): Promise<Array<{ windowId: number; tabIndex: number; url: string }>> {
    if (!this._engine) return [];
    const script = `tell application "Safari"
  set _output to ""
  repeat with _window in every window
    set _winId to id of _window
    repeat with i from 1 to count of tabs of _window
      set _url to URL of tab i of _window
      set _output to _output & _winId & "|||" & i & "|||" & _url & "\\n"
    end repeat
  end repeat
  return _output
end tell`;
    const result = await this._engine.execute(script, 3000);
    if (!result.ok || !result.value) return [];
    return result.value.split('\n').filter(Boolean).map(line => {
      const [winId, idx, ...urlParts] = line.split('|||');
      return {
        windowId: parseInt(winId, 10),
        tabIndex: parseInt(idx, 10),
        url: urlParts.join('|||'), // URL might theoretically contain |||
      };
    }).filter(t => !isNaN(t.windowId) && !isNaN(t.tabIndex));
  }

  consumeClickContext(tabUrl?: string): ClickContext | null {
    if (tabUrl && this.clickContexts.has(tabUrl)) {
      const ctx = this.clickContexts.get(tabUrl)!;
      this.clickContexts.delete(tabUrl);
      const timer = this.clickContextTimers.get(tabUrl);
      if (timer) clearTimeout(timer);
      this.clickContextTimers.delete(tabUrl);
      return ctx;
    }
    // Fallback: return most recent (last set) if no tabUrl specified
    if (this.clickContexts.size > 0) {
      const entries = [...this.clickContexts.entries()];
      const [key, ctx] = entries[entries.length - 1];
      this.clickContexts.delete(key);
      const timer = this.clickContextTimers.get(key);
      if (timer) clearTimeout(timer);
      this.clickContextTimers.delete(key);
      return ctx;
    }
    return null;
  }

  getEngine(): AppleScriptEngine | null {
    return this._engine;
  }

  getDaemonEngine(): DaemonEngine | null {
    return (this.engines.get('daemon') as DaemonEngine) ?? null;
  }

  /**
   * Fast connectivity check via daemon's /status HTTP endpoint.
   * Bypasses the NDJSON command channel — direct HTTP for sub-second response.
   */
  private async checkExtensionStatus(): Promise<{ ext: boolean; mcp: boolean; sessionTab: boolean; lastPingAge: number | null; activeSessions: number }> {
    try {
      const resp = await fetch(`http://127.0.0.1:19475/status?sessionId=${this.sessionId}`, { signal: AbortSignal.timeout(2000) });
      if (!resp.ok) return { ext: false, mcp: false, sessionTab: false, lastPingAge: null, activeSessions: 0 };
      return await resp.json();
    } catch {
      return { ext: false, mcp: false, sessionTab: false, lastPingAge: null, activeSessions: 0 };
    }
  }

  /**
   * Fast check whether the session window still exists in Safari.
   */
  private async checkWindowExists(): Promise<boolean> {
    if (!this._sessionWindowId) return false;
    try {
      const { execSync } = await import('node:child_process');
      const result = execSync(
        `osascript -e 'tell application "Safari" to return (exists window id ${this._sessionWindowId})'`,
        { timeout: 2000, encoding: 'utf-8' },
      ).trim();
      return result === 'true';
    } catch {
      return false;
    }
  }

  /**
   * Attempt transparent session recovery. Called when pre-call gate finds
   * a component down. Blocks up to 10s. Returns true if recovered.
   */
  private async recoverSession(traceId: string): Promise<boolean> {
    const start = Date.now();
    trace(traceId, 'server', 'recovery_start', {
      windowId: this._sessionWindowId,
    });

    // Re-open window if gone
    const windowOk = await this.checkWindowExists();
    if (!windowOk) {
      this._sessionWindowId = undefined;
      await this.ensureSessionWindow(traceId);
    }

    // Poll for extension connection (up to 10s)
    for (let i = 0; i < 10; i++) {
      const status = await this.checkExtensionStatus();
      if (status.ext) {
        this.setEngineAvailability({ ...this.engineAvailability, extension: true });
        const duration = Date.now() - start;
        trace(traceId, 'server', 'recovery_success', { durationMs: duration });
        console.error(`Safari Pilot: session recovered in ${duration}ms`);
        return true;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    const duration = Date.now() - start;
    trace(traceId, 'server', 'recovery_failed', { durationMs: duration });
    return false;
  }

  /**
   * Register this session with the daemon and get existing session count.
   */
  private async registerWithDaemon(): Promise<number> {
    try {
      const resp = await fetch('http://127.0.0.1:19475/session/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: this.sessionId }),
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) return 0;
      const data = await resp.json() as { activeSessions?: number };
      return (data.activeSessions ?? 1) - 1; // subtract self
    } catch {
      return 0;
    }
  }

  /**
   * Create a dedicated Safari window for this MCP session. Runs once per
   * session, unconditionally — even if another session already connected the
   * extension. Every session needs its own window for tab isolation.
   *
   * Opens the session dashboard page (127.0.0.1:19475/session) which also
   * keeps the extension content script alive for keepalive pings.
   */
  private async ensureSessionWindow(traceId: string): Promise<void> {
    if (this._sessionWindowId) return; // already have a window

    trace(traceId, 'server', 'session_window_start', {});
    try {
      const { execSync } = await import('node:child_process');
      const result = execSync(
        `osascript -e 'tell application "Safari"
  make new document with properties {URL:"${this.sessionTabUrl}"}
  return id of window 1
end tell'`,
        { timeout: 5000, encoding: 'utf-8' },
      ).trim();
      const windowId = parseInt(result, 10);
      if (!isNaN(windowId)) {
        this._sessionWindowId = windowId;
        trace(traceId, 'server', 'session_window_created', { windowId });
      }
      this._sessionTabOpened = true;
    } catch {
      trace(traceId, 'server', 'session_window_failed', {}, 'error');
    }
  }

  /**
   * Bootstrap the extension connection. Called BEFORE engine selection on every
   * tool call (when extension isn't yet available). Three-tier fast path:
   *
   *   1. engineAvailability.extension already true → return immediately (0ms)
   *   2. Quick /status check finds extension connected → update availability (≤100ms)
   *   3. First attempt: poll for 10s → update availability or give up
   *
   * Session window creation is handled separately by ensureSessionWindow().
   * After the first full attempt (tier 3), _extensionBootstrapAttempted prevents
   * re-running the 10s poll. Subsequent calls hit tier 1 or 2 only.
   */
  private async ensureExtensionReady(traceId: string): Promise<boolean> {
    // Tier 1: already known available (set by a previous successful bootstrap)
    if (this.engineAvailability.extension) {
      return true;
    }

    // Tier 2: quick live check — handles late connection after a previous timeout
    const status = await this.checkExtensionStatus();
    if (status.ext) {
      this.setEngineAvailability({ ...this.engineAvailability, extension: true });
      trace(traceId, 'server', 'extension_bootstrap_result', { outcome: 'late_connect', waitMs: 0 });
      return true;
    }

    // Tier 3: full bootstrap — only runs once per session
    if (this._extensionBootstrapAttempted) {
      return false;
    }
    this._extensionBootstrapAttempted = true;
    trace(traceId, 'server', 'extension_bootstrap_start', {});

    // Session window is already open (ensureSessionWindow runs first).
    // Poll /status every 1s for up to 10s waiting for extension to connect.
    const start = Date.now();
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const check = await this.checkExtensionStatus();
      if (check.ext) {
        this.setEngineAvailability({ ...this.engineAvailability, extension: true });
        trace(traceId, 'server', 'extension_bootstrap_result', {
          outcome: 'tab_opened_connected',
          waitMs: Date.now() - start,
        });
        return true;
      }
    }

    trace(traceId, 'server', 'extension_bootstrap_result', {
      outcome: 'timeout_fallback',
      waitMs: Date.now() - start,
    }, 'error');
    return false;
  }

  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Returns every registered tool definition. Used by the MV3 enforcement test
   * (Tasks 6+12) to verify every tool declares `requirements.idempotent`.
   */
  getAllToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  async start(): Promise<void> {
    await this.initialize();

    // ── Full startup sequence ─────────────────────────────────────────
    // 1. Register session with daemon
    const otherSessions = await this.registerWithDaemon();
    if (otherSessions > 0) {
      console.error(`Safari Pilot: found ${otherSessions} existing session(s), starting session ${otherSessions + 1} in new window`);
    }

    // 2. Open session window
    await this.ensureSessionWindow('init');

    // 3. Wait for extension to connect (up to 15s)
    console.error('Safari Pilot: waiting for extension connection...');
    const initStart = Date.now();
    let extensionConnected = false;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const status = await this.checkExtensionStatus();
      if (status.ext) {
        extensionConnected = true;
        this.setEngineAvailability({ ...this.engineAvailability, extension: true });
        break;
      }
    }
    const initDuration = Date.now() - initStart;

    if (extensionConnected) {
      console.error(`Safari Pilot: all systems green (${initDuration}ms)`);
    } else {
      console.error(`Safari Pilot: extension not connected after ${initDuration}ms — tools will use daemon engine`);
    }

    // Store init metadata for MCP response enrichment
    this._initMeta = {
      sessionId: this.sessionId,
      windowId: this._sessionWindowId ?? null,
      existingSessions: otherSessions,
      systems: {
        daemon: this.engineAvailability.daemon,
        extension: extensionConnected,
        sessionTab: this._sessionTabOpened,
      },
      initDurationMs: initDuration,
    };

    console.error('Safari Pilot MCP server started');
  }

  async shutdown(): Promise<void> {
    for (const engine of this.engines.values()) {
      await engine.shutdown();
    }
  }
}

export async function createServer(): Promise<SafariPilotServer> {
  const config = loadConfig();
  const server = new SafariPilotServer(config);
  return server;
}
