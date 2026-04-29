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

    // 2) Inject TWO stale storage-bus keys — sp_result and sp_cmd — both
    //    with commandIds prefixed `T44_STALE_NEVER_PENDING_` so no live
    //    pending entry can match (collision with a real Date.now()-prefixed
    //    id is structurally impossible). Timestamps are also old so any
    //    "live if recent" predicate would also reject them.
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
    const setResRes = await harness(client, nextId, tabA!, {
      action: 'setStorageFlag',
      key: 'sp_result',
      value: staleResult,
    });
    expect((setResRes.value as Record<string, unknown> | undefined)?.set).toBe('sp_result');
    const setCmdRes = await harness(client, nextId, tabA!, {
      action: 'setStorageFlag',
      key: 'sp_cmd',
      value: staleCmd,
    });
    expect((setCmdRes.value as Record<string, unknown> | undefined)?.set).toBe('sp_cmd');

    // 3) Confirm both poisons really landed (sanity check; isolates a
    //    bridge-bug failure from a wake-cleanup-bug failure).
    const sanityResult = await harness(client, nextId, tabA!, {
      action: 'getStorage',
      key: 'sp_result',
    });
    expect(
      (sanityResult.value as { value?: Record<string, unknown> | null } | undefined)?.value,
      'bridge sanity check: sp_result must read back the poison we just wrote',
    ).toMatchObject({ commandId: staleResultId });
    const sanityCmd = await harness(client, nextId, tabA!, {
      action: 'getStorage',
      key: 'sp_cmd',
    });
    expect(
      (sanityCmd.value as { value?: Record<string, unknown> | null } | undefined)?.value,
      'bridge sanity check: sp_cmd must read back the poison we just wrote',
    ).toMatchObject({ commandId: staleCmdId });

    // 4) Trigger forceUnload. The bridge dispatches `runtime.reload()`
    //    after a 50ms ack delay; the extension reinstalls and runs a
    //    fresh `wakeSequence` (loadTabCache → gcPendingStorage →
    //    [cleanupStaleStorageBus, post-fix] → connectAndReconcile →
    //    pollLoop).
    await harness(client, nextId, tabA!, { action: 'forceUnload' });

    // Wait for reload + reconcile. Extension reload + daemon reconnect
    // empirically takes 3-5s in CI; give it a full 7s for safety.
    await new Promise((r) => setTimeout(r, 7000));

    // 5) Read sp_result back. Discriminator:
    //    PRE-FIX:  still equals stalePoison (wakeSequence never touched it)
    //    POST-FIX: null/undefined (cleanupStaleStorageBus removed it)
    //
    //    NOTE on post-unload bridge availability: forceUnload reloads
    //    the extension. The bridge still works because it lives in the
    //    DEBUG_HARNESS-built artifact; tab A's content scripts re-inject
    //    on tab navigation/reload. We rely on tabs.onCreated/onUpdated
    //    re-populating tabCacheMap for tab A so findTargetTab can
    //    resolve `tabA!` for this read. If this read flakes due to
    //    cache cold-start, tighten the wait above.
    let resultRead: Record<string, unknown>;
    let cmdRead: Record<string, unknown>;
    try {
      resultRead = await harness(client, nextId, tabA!, {
        action: 'getStorage',
        key: 'sp_result',
      }, 15000);
      cmdRead = await harness(client, nextId, tabA!, {
        action: 'getStorage',
        key: 'sp_cmd',
      }, 15000);
    } catch (e) {
      throw new Error(
        `Post-unload bridge read failed (likely tabCacheMap cold-start) — ` +
        `consider increasing the post-unload settle wait. Original error: ${(e as Error).message}`,
      );
    }
    const resultReadback = (resultRead.value as { value?: unknown } | undefined)?.value;
    const cmdReadback = (cmdRead.value as { value?: unknown } | undefined)?.value;

    // Load-bearing assertions. The bridge's getStorage returns
    // `stored[key] ?? null` (background.js dispatcher) — so a missing key
    // reads back as exactly `null`. Anything else means the cleanup
    // didn't fire (or fired but left residue).
    expect(
      resultReadback,
      `Pre-fix bug indicator: sp_result was NOT cleaned up by wakeSequence ` +
      `(read back: ${JSON.stringify(resultReadback)}). T44's fix must remove ` +
      `orphan storage-bus keys whose commandId is not in the live pending set.`,
    ).toBeNull();
    expect(
      cmdReadback,
      `Pre-fix bug indicator: sp_cmd was NOT cleaned up by wakeSequence ` +
      `(read back: ${JSON.stringify(cmdReadback)}). Stale sp_cmd is the ` +
      `phantom-execution risk — content scripts on tab load read it via ` +
      `content-isolated.js:96-100.`,
    ).toBeNull();
  }, 45000);
});
