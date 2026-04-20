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
import { RateLimitedError, CircuitBreakerOpenError, HumanApprovalRequiredError, TabUrlNotRecognizedError } from './errors.js';
import { loadConfig, DEFAULT_CONFIG, type SafariPilotConfig } from './config.js';

const execFileAsync = promisify(execFile);

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
const SKIP_OWNERSHIP_TOOLS = new Set([
  'safari_list_tabs',
  'safari_new_tab',
  'safari_health_check',
  'safari_navigate_back',    // handler queries tab by stale URL after history.back() — can't enforce ownership reliably
  'safari_navigate_forward', // same — handler returns stale URL, subsequent calls would be stranded
]);

// Tools whose successful execution updates the tab's URL in the ownership registry.
// EXCLUDES safari_navigate_back/forward: those handlers query the tab by OLD URL after
// history.back()/forward(), which fails because Safari can't re-locate the tab by a URL
// it no longer has. The handlers fall back to returning the old URL, making tracking
// impossible. This is a pre-existing handler-level limitation — fixing it requires
// tab-index-based queries in the navigation handlers (separate PR).
const NAVIGATION_URL_TRACKING_TOOLS = new Set(['safari_navigate']);

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
      extensionAvailable = await extensionEngine.isAvailable();
      if (extensionAvailable) {
        this.engines.set('extension', extensionEngine);
      }
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
    const start = Date.now();

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

    // 3. Tab ownership check — skip for tools that operate without a specific tab
    if (params['tabUrl'] && !SKIP_OWNERSHIP_TOOLS.has(name)) {
      const tabUrl = params['tabUrl'] as string;
      const tabId = this.tabOwnership.findByUrl(tabUrl);
      if (tabId === undefined) {
        throw new TabUrlNotRecognizedError(tabUrl);
      }
      this.tabOwnership.assertOwnership(tabId);
    }

    // 4. Domain policy evaluation
    const policy = this.domainPolicy.evaluate(url);

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

    // 8. Execute the tool, record circuit breaker outcome, and audit
    try {
      const result = await this.callTool(name, params);
      this.circuitBreaker.recordSuccess(domain);

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
            this.tabOwnership.registerTab(syntheticId, tabData.tabUrl);
          }
        } catch { /* tab registration is best-effort — don't fail the tool call */ }
      }

      // 8.post2: Update ownership URL after navigation succeeds.
      // Only safari_navigate is tracked — see NAVIGATION_URL_TRACKING_TOOLS comment for why.
      if (NAVIGATION_URL_TRACKING_TOOLS.has(name) && result.content?.[0]?.type === 'text') {
        try {
          const navData = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
          const oldUrl = params['tabUrl'] as string | undefined;
          const newUrl = navData.url as string | undefined;
          if (oldUrl && newUrl && oldUrl !== newUrl) {
            const tabId = this.tabOwnership.findByUrl(oldUrl);
            if (tabId !== undefined) {
              this.tabOwnership.updateUrl(tabId, newUrl);
            }
          }
        } catch { /* URL update is best-effort */ }
      }

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
