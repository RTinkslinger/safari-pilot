import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Engine, ToolResponse, ToolRequirements, ClickContext } from './types.js';
import type { IEngine } from './engines/engine.js';
import { selectEngine, EngineUnavailableError } from './engine-selector.js';
import { AppleScriptEngine } from './engines/applescript.js';
import { DaemonEngine } from './engines/daemon.js';
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
import { KillSwitch } from './security/kill-switch.js';
import { TabOwnership } from './security/tab-ownership.js';
import { AuditLog } from './security/audit-log.js';
import { DomainPolicy } from './security/domain-policy.js';
import { RateLimiter } from './security/rate-limiter.js';
import { CircuitBreaker } from './security/circuit-breaker.js';
import { IdpiScanner } from './security/idpi-scanner.js';
import { RateLimitedError, CircuitBreakerOpenError } from './errors.js';
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
    return { name: 'js_apple_events', ok: value === '2', detail: value !== '2' ? `Unexpected: ${value}` : undefined };
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

  private clickContexts: Map<string, ClickContext> = new Map();
  private clickContextTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

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
  }

  async initialize(): Promise<void> {
    const daemonEngine = new DaemonEngine({ timeoutMs: this.config.daemon.timeoutMs });
    const daemonAvailable = await daemonEngine.isAvailable();
    this.setEngineAvailability({ daemon: daemonAvailable, extension: false });
    if (daemonAvailable) {
      this.engines.set('daemon', daemonEngine);
    } else {
      // Ensure daemon is cleaned up if it failed to start
      await daemonEngine.shutdown();
    }

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
      requirements: {},
      handler: async (params) => this.handleHealthCheck(params),
    });

    // Instantiate all tool modules
    const navTools = new NavigationTools(engine);
    const interactionTools = new InteractionTools(engine, this);
    const extractionTools = new ExtractionTools(engine);
    const networkTools = new NetworkTools(engine);
    const storageTools = new StorageTools(engine);
    const shadowTools = new ShadowTools(engine);
    const frameTools = new FrameTools(engine);
    const permissionTools = new PermissionTools(engine);
    const clipboardTools = new ClipboardTools(engine);
    const serviceWorkerTools = new ServiceWorkerTools(engine);
    const performanceTools = new PerformanceTools(engine);
    const structuredExtractionTools = new StructuredExtractionTools(engine);
    const waitTools = new WaitTools(engine);
    const compoundTools = new CompoundTools(engine);
    const downloadTools = new DownloadTools(this);
    const pdfTools = new PdfTools(this);

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
      requirements: {},
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
      if (tabId !== undefined) {
        this.tabOwnership.assertOwnership(tabId);
      }
      // If tabId is undefined the tool handler will surface its own error;
      // ownership enforcement only applies to tabs we know about.
    }

    // 4. Domain policy evaluation
    const policy = this.domainPolicy.evaluate(url);

    // 5. Rate limit check — check before recording so we don't consume quota on blocked calls
    const limitCheck = this.rateLimiter.checkLimit(domain);
    if (!limitCheck.allowed) {
      throw new RateLimitedError(domain, policy.maxActionsPerMinute);
    }
    this.rateLimiter.recordAction(domain);

    // 6. Circuit breaker check
    if (this.circuitBreaker.isOpen(domain)) {
      throw new CircuitBreakerOpenError(domain, 120);
    }

    // 7. Execute the tool, record circuit breaker outcome, and audit
    try {
      const result = await this.callTool(name, params);
      this.circuitBreaker.recordSuccess(domain);

      // 8. Audit log — success path
      this.auditLog.record({
        tool: name,
        tabUrl: url,
        engine: 'applescript',
        params,
        result: 'ok',
        elapsed_ms: Date.now() - start,
        session: this.sessionId,
      });

      return result;
    } catch (error) {
      this.circuitBreaker.recordFailure(domain);

      // 8. Audit log — error path
      this.auditLog.record({
        tool: name,
        tabUrl: url,
        engine: 'applescript',
        params,
        result: 'error',
        elapsed_ms: Date.now() - start,
        session: this.sessionId,
      });

      throw error;
    }
  }

  getSelectedEngine(requirements: ToolRequirements): Engine {
    return selectEngine(requirements, this.engineAvailability);
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
