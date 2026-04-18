import type { ToolResponse, ToolRequirements, Engine } from '../types.js';
import type { DaemonEngine } from '../engines/daemon.js';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

/**
 * Observability tools for the Safari Extension engine.
 *
 * Both tools proxy the daemon's `extension_health` dispatch (Task 5) and are
 * strictly read-only. They are idempotent and safe to call anytime, including
 * while the Extension is unhealthy — when the daemon is unavailable, the tool
 * returns a degraded response rather than throwing.
 *
 * At 1a the two tools overlap; at 1b the `safari_extension_debug_dump` tool
 * will additionally proxy extension-side `storage.local` state. The daemon
 * never mutates state from these calls.
 */
export class ExtensionDiagnosticsTools {
  private daemonEngine: DaemonEngine | null;
  private handlers: Map<string, Handler> = new Map();

  constructor(daemonEngine: DaemonEngine | null) {
    this.daemonEngine = daemonEngine;
    this.handlers.set('safari_extension_health', this.handleExtensionHealth.bind(this));
    this.handlers.set('safari_extension_debug_dump', this.handleExtensionDebugDump.bind(this));
  }

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_extension_health',
        description:
          'Return observability metrics for the Safari Extension engine: connection status, ' +
          'recent counters, timestamps, breaker state. Read-only; safe to call anytime.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_extension_debug_dump',
        description:
          'Dump extension infrastructure state: daemon-side pending commands, claimedByProfile set, ' +
          'executedLog size, HealthStore snapshot. Observability tool. Does not modify state.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        requirements: { idempotent: true },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  private async handleExtensionHealth(_params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    if (!this.daemonEngine) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'daemon_unavailable',
            message: 'Daemon engine not available; cannot fetch extension health.',
          }),
        }],
        metadata: {
          engine: 'daemon' as Engine,
          degraded: true,
          degradedReason: 'daemon_unavailable',
          latencyMs: Date.now() - start,
        },
      };
    }
    try {
      const result = await this.daemonEngine.sendRawCommand('extension_health', {});
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result.value ?? result.error ?? {}, null, 2),
        }],
        metadata: {
          engine: 'daemon' as Engine,
          degraded: false,
          latencyMs: Date.now() - start,
        },
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'health_query_failed',
            message: err instanceof Error ? err.message : String(err),
          }),
        }],
        metadata: {
          engine: 'daemon' as Engine,
          degraded: true,
          degradedReason: 'health_query_failed',
          latencyMs: Date.now() - start,
        },
      };
    }
  }

  private async handleExtensionDebugDump(_params: Record<string, unknown>): Promise<ToolResponse> {
    // At 1a the dump is the same as health plus a future extended-fields bag.
    // Extension-side debug_dump (reading storage.local) is wired in commit 1b's
    // extension work. For 1a, we proxy the daemon health + an informational note.
    const start = Date.now();
    if (!this.daemonEngine) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'daemon_unavailable' }),
        }],
        metadata: {
          engine: 'daemon' as Engine,
          degraded: true,
          degradedReason: 'daemon_unavailable',
          latencyMs: Date.now() - start,
        },
      };
    }
    const result = await this.daemonEngine.sendRawCommand('extension_health', {});
    const dump = {
      daemon_snapshot: result.value ?? null,
      note_1a:
        'Extension-side storage.local dump is wired in commit 1b. At 1a this tool returns daemon-side state only.',
    };
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(dump, null, 2),
      }],
      metadata: {
        engine: 'daemon' as Engine,
        degraded: false,
        latencyMs: Date.now() - start,
      },
    };
  }
}
