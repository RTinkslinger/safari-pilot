import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Engine, ToolResponse, ToolRequirements } from './types.js';
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

// Per-check timeout: short enough to keep the total health check fast,
// long enough to survive a sluggish osascript startup (~100-300 ms typical).
const HEALTH_CHECK_TIMEOUT_MS = 3000;

async function checkSafariRunning(): Promise<HealthCheck> {
  try {
    await execFileAsync('osascript', ['-e', 'tell application "Safari" to return name'], {
      timeout: HEALTH_CHECK_TIMEOUT_MS,
    });
    return { name: 'safari_running', ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { name: 'safari_running', ok: false, detail: message };
  }
}

async function checkJsFromAppleEvents(): Promise<HealthCheck> {
  try {
    const result = await execFileAsync(
      'osascript',
      ['-e', 'tell application "Safari" to do JavaScript "1+1" in current tab of front window'],
      { timeout: HEALTH_CHECK_TIMEOUT_MS },
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

async function checkScreenRecording(): Promise<HealthCheck> {
  try {
    // screencapture -x captures without sound; a permission error means SR is blocked
    await execFileAsync('screencapture', ['-x', '-t', 'png', '/dev/null'], { timeout: HEALTH_CHECK_TIMEOUT_MS });
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

export class SafariPilotServer {
  private tools: Map<string, ToolDefinition> = new Map();
  private engines: Map<Engine, IEngine> = new Map();
  private engineAvailability = { daemon: false, extension: false };
  private sessionId: string = `sess_${Date.now().toString(36)}`;
  private _engine: AppleScriptEngine | null = null;

  async initialize(): Promise<void> {
    // Instantiate and probe the DaemonEngine first (fastest path)
    const daemonEngine = new DaemonEngine();
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
    const interactionTools = new InteractionTools(engine);
    const extractionTools = new ExtractionTools(engine);
    const networkTools = new NetworkTools(engine);
    const storageTools = new StorageTools(engine);
    const shadowTools = new ShadowTools(engine);
    const frameTools = new FrameTools(engine);
    const permissionTools = new PermissionTools(engine);
    const clipboardTools = new ClipboardTools(engine);
    const serviceWorkerTools = new ServiceWorkerTools(engine);
    const performanceTools = new PerformanceTools(engine);

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
  }

  private async handleHealthCheck(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const checks: HealthCheck[] = [];

    // 1. Safari running?
    const safariCheck = await checkSafariRunning();
    checks.push(safariCheck);

    // 2. JS from Apple Events enabled?
    const jsCheck = await checkJsFromAppleEvents();
    checks.push(jsCheck);

    // 3. Screen Recording permission?
    const srCheck = await checkScreenRecording();
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

  getSelectedEngine(requirements: ToolRequirements): Engine {
    return selectEngine(requirements, this.engineAvailability);
  }

  setEngineAvailability(availability: { daemon: boolean; extension: boolean }): void {
    this.engineAvailability = availability;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getEngine(): AppleScriptEngine | null {
    return this._engine;
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
  const server = new SafariPilotServer();
  return server;
}
