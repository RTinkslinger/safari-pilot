/**
 * T44 — `extension/background.js` `wakeSequence` must clean up stale
 * `sp_cmd` / `sp_result` keys from a previous session before the new
 * pollLoop dispatches commands. Without this, two failure modes surface:
 *
 *   1. Phantom execution: content scripts on tab load read `sp_cmd` from
 *      `browser.storage.local` directly (content-isolated.js:96-100).
 *      A leftover `sp_cmd` from a dead session would re-execute on the
 *      tab when the content script reloads.
 *
 *   2. Phantom delivery: a leftover `sp_result` could be matched by a
 *      future command's commandId collision (very unlikely with
 *      timestamp-based IDs but observable as cruft in storage).
 *
 * Pre-fix `wakeSequence` (loadTabCache → gcPendingStorage →
 * connectAndReconcile → pollLoop) never touches the storage-bus keys.
 * The post-execution cleanup at executeCommand:275 only fires after a
 * successful command — sessions killed mid-flight leave keys behind.
 *
 * Discrimination:
 *   - PRE-FIX:  inject a stale `sp_result`, trigger forceUnload (which
 *     calls `runtime.reload()` → fresh script load → wakeSequence runs).
 *     After wake, read storage back: poison is still present.
 *   - POST-FIX: same flow, but `wakeSequence` calls
 *     `cleanupStaleStorageBus()` which removes orphan keys → poison
 *     gone.
 *
 * Test infrastructure: uses the DEBUG_HARNESS test bridge (introduced
 * in T27) to set/read storage keys and trigger forceUnload. All bridge
 * code is stripped from release builds by `scripts/build-extension.sh`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rawCallTool, callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Daemon writes extension `emitTrace` events here (via /result with
// requestId='__trace__'). T44's discriminator reads this for the
// `orphan_storage_bus_removed` event emitted by `cleanupStaleStorageBus`
// after wake.
const LIVE_DAEMON_TRACE_FILE = join(homedir(), '.safari-pilot', 'daemon-trace.ndjson');

interface TraceEvent { event?: string; data?: Record<string, unknown>; ts?: string }

function readDaemonTraceEvents(): TraceEvent[] {
  if (!existsSync(LIVE_DAEMON_TRACE_FILE)) return [];
  return readFileSync(LIVE_DAEMON_TRACE_FILE, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l) as TraceEvent; } catch { return {} as TraceEvent; } });
}

async function harness(
  client: McpTestClient,
  nextId: () => number,
  tabUrl: string,
  op: Record<string, unknown>,
  timeoutMs = 10000,
): Promise<Record<string, unknown>> {
  const r = await rawCallTool(
    client,
    'safari_evaluate',
    { tabUrl, script: `__SP_TEST_HARNESS__:${JSON.stringify(op)}` },
    nextId(),
    timeoutMs,
  );
  return r.payload;
}

describe('T44 — wakeSequence cleans stale sp_result / sp_cmd', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let tabA: string | null = null;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 30000);

  afterAll(async () => {
    if (tabA) {
      try {
        await callTool(client, 'safari_close_tab', { tabUrl: tabA }, nextId());
      } catch { /* best effort */ }
    }
  }, 30000);

  it('forceUnload + wakeSequence removes a poisoned sp_result that no live pending entry references', async () => {
    // 1) Open tab A. Used as the carrier for bridge ops.
    const aMarker = `https://example.com/?sp_t44=${Date.now()}`;
    const a = await callTool(client, 'safari_new_tab', { url: aMarker }, nextId());
    tabA = a.tabUrl as string;

    // Settle so content scripts inject and tabs.onCreated fires.
    await new Promise((r) => setTimeout(r, 1500));

    // 2) Construct TWO stale storage-bus values — sp_result and sp_cmd —
    //    both with commandIds prefixed `T44_STALE_NEVER_PENDING_` so no
    //    live pending entry can match (collision with a real
    //    Date.now()-prefixed id is structurally impossible). Timestamps
    //    are also old so any "live if recent" predicate would reject them.
    //
    //    The bridge architecture itself uses sp_cmd/sp_result for RPC and
    //    `executeCommand` post-success cleanup wipes both — so a
    //    set-via-bridge → verify-via-bridge → reload-via-bridge sequence
    //    gets its poison wiped before reload. Use the atomic
    //    `forceUnloadWithPoison` action which delays the poison plant
    //    until AFTER the bridge call's own cleanup completes, then
    //    reloads. The poison is in storage at the moment of reload →
    //    wakeSequence → cleanupStaleStorageBus runs on it.
    const staleResultId = `T44_STALE_NEVER_PENDING_RESULT_${Date.now()}`;
    const staleCmdId = `T44_STALE_NEVER_PENDING_CMD_${Date.now()}`;
    const staleResult = {
      commandId: staleResultId,
      result: { ok: true, value: 'POISON_RESULT' },
      timestamp: Date.now() - 60000,
    };
    const staleCmd = {
      commandId: staleCmdId,
      tabId: -9999,
      method: 'execute_script',
      params: { script: 'return "POISON_CMD";', commandId: staleCmdId },
      timestamp: Date.now() - 60000,
      deadline: Date.now() - 30000,
    };

    // 3) Capture the kickstart-boundary timestamp BEFORE perturbation —
    //    used to filter trace events to those emitted AFTER reload.
    const reloadAt = Date.now();

    // 4) Atomic plant-and-unload. After ~250 ms (post-bridge-cleanup),
    //    background plants the poison into sp_cmd/sp_result. After
    //    another ~100 ms, runtime.reload() fires.
    const plantUnload = await harness(client, nextId, tabA!, {
      action: 'forceUnloadWithPoison',
      poison: { sp_result: staleResult, sp_cmd: staleCmd },
    });
    expect((plantUnload as Record<string, unknown>).scheduled).toBe(true);
    expect((plantUnload as Record<string, unknown>).action).toBe('poison_and_unload');

    // Wait for reload + reconcile. Extension reload + daemon reconnect
    // empirically takes 3-5s in CI; give it a full 7s for safety.
    await new Promise((r) => setTimeout(r, 7000));

    // 5) Trace assertion (load-bearing discriminator).
    //    `cleanupStaleStorageBus` emits `orphan_storage_bus_removed` with
    //    the planted commandIds when it removes them. Pre-fix this
    //    function does not exist → trace event never appears.
    //
    //    sp_cmd cannot be verified via the bridge's `getStorage` because
    //    the act of dispatching that read overwrites sp_cmd with the
    //    bridge's own command (storage-bus single-slot key). The trace
    //    is the only safe observation point. Same for sp_result here for
    //    consistency, though sp_result is also bridge-readable (the
    //    bridge reads sp_result before its own response write).
    expect(
      existsSync(LIVE_DAEMON_TRACE_FILE),
      'daemon-trace.ndjson must exist after wake — daemon writes extension ' +
      `emitTrace events here. If missing, the trace sink is broken.`,
    ).toBe(true);
    const trace = readDaemonTraceEvents();
    const cleanupEvents = trace.filter((e) =>
      e.event === 'orphan_storage_bus_removed' &&
      typeof e.ts === 'string' && new Date(e.ts).getTime() >= reloadAt,
    );
    expect(
      cleanupEvents.length,
      `Pre-fix bug indicator: no \`orphan_storage_bus_removed\` trace events ` +
      `after reloadAt=${new Date(reloadAt).toISOString()}. ` +
      `\`cleanupStaleStorageBus\` either was not invoked or did not remove ` +
      `our planted poison. T44's fix must run cleanupStaleStorageBus in ` +
      `wakeSequence and remove orphan keys whose commandId isn't in the ` +
      `live pending set.`,
    ).toBeGreaterThan(0);

    // The cleanup event must reference BOTH our planted poison commandIds.
    // T55a refactored storage bus to commandId-keyed slots — orphan cleanup's
    // `removed` array contains the FULL storage keys (`sp_result_<id>` /
    // `sp_cmd_<id>`). Scanning that array is the authoritative check; the
    // `commandIds` map is supplementary diagnostic.
    // A trace event that removed neither planted key would not satisfy
    // this — the test would be silently passing on incidental cleanups
    // of other orphans (T68 caught exactly this drift).
    const expectedResultKey = `sp_result_${staleResultId}`;
    const expectedCmdKey = `sp_cmd_${staleCmdId}`;
    const hasResultCleanup = cleanupEvents.some((e) => {
      const removed = e.data?.['removed'] as string[] | undefined;
      return removed?.includes(expectedResultKey);
    });
    const hasCmdCleanup = cleanupEvents.some((e) => {
      const removed = e.data?.['removed'] as string[] | undefined;
      return removed?.includes(expectedCmdKey);
    });
    expect(
      hasResultCleanup,
      `Cleanup event must report removal of "${expectedResultKey}". ` +
      `Captured events: ${JSON.stringify(cleanupEvents)}`,
    ).toBe(true);
    expect(
      hasCmdCleanup,
      `Cleanup event must report removal of "${expectedCmdKey}". ` +
      `Captured events: ${JSON.stringify(cleanupEvents)}`,
    ).toBe(true);
  }, 45000);
});
