import { describe, it, expect, vi } from 'vitest';
import { ExtensionDiagnosticsTools } from '../../../src/tools/extension-diagnostics';
import type { DaemonEngine } from '../../../src/engines/daemon';

function makeMockDaemonEngine(
  overrides: Partial<{
    sendRawCommand: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<{
      ok: boolean;
      value?: unknown;
      error?: { code: string; message: string };
    }>;
  }> = {},
): DaemonEngine {
  return {
    sendRawCommand:
      overrides.sendRawCommand ??
      vi.fn(async () => ({
        ok: true,
        value: {
          isConnected: true,
          lastAlarmFireTimestamp: 1700000000000,
          roundtripCount1h: 3,
          timeoutCount1h: 0,
          uncertainCount1h: 0,
          forceReloadCount24h: 0,
          pendingCommandsCount: 0,
          executedLogSize: 0,
          claimedByProfiles: [],
          engineCircuitBreakerState: 'closed',
          killSwitchActive: false,
        },
      })),
  } as unknown as DaemonEngine;
}

describe('ExtensionDiagnosticsTools', () => {
  it('getDefinitions returns 2 tools, both idempotent', () => {
    const tools = new ExtensionDiagnosticsTools(makeMockDaemonEngine());
    const defs = tools.getDefinitions();
    expect(defs.length).toBe(2);
    expect(defs.map((d) => d.name).sort()).toEqual([
      'safari_extension_debug_dump',
      'safari_extension_health',
    ]);
    for (const d of defs) {
      expect(d.requirements.idempotent).toBe(true);
    }
  });

  it('safari_extension_health returns composite health from daemon', async () => {
    const tools = new ExtensionDiagnosticsTools(makeMockDaemonEngine());
    const handler = tools.getHandler('safari_extension_health')!;
    const response = await handler({});
    expect(response.metadata.engine).toBe('daemon');
    expect(response.metadata.degraded).toBe(false);
    expect(response.content[0].text).toContain('"isConnected": true');
    expect(response.content[0].text).toContain('"roundtripCount1h": 3');
  });

  it('safari_extension_debug_dump includes daemon snapshot + 1a note', async () => {
    const tools = new ExtensionDiagnosticsTools(makeMockDaemonEngine());
    const handler = tools.getHandler('safari_extension_debug_dump')!;
    const response = await handler({});
    expect(response.metadata.engine).toBe('daemon');
    expect(response.content[0].text).toContain('daemon_snapshot');
    expect(response.content[0].text).toContain('note_1a');
    expect(response.content[0].text).toContain('commit 1b');
  });

  it('returns degraded response when daemon unavailable', async () => {
    const tools = new ExtensionDiagnosticsTools(null);
    const h = tools.getHandler('safari_extension_health')!;
    const response = await h({});
    expect(response.metadata.degraded).toBe(true);
    expect(response.metadata.degradedReason).toBe('daemon_unavailable');
    expect(response.content[0].text).toContain('daemon_unavailable');
  });
});
