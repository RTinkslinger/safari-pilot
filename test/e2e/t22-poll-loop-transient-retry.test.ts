/**
 * T22 — `extension/background.js` `pollLoop` must retry transient failures
 * (network blip, daemon restart, dropped TCP) instead of dying on the
 * first non-Abort error. Pre-fix: any non-AbortError/non-TimeoutError
 * caught at line ~474 returns from the loop, leaving re-arming to the
 * keepalive alarm (≤60 s). During that dead period the extension cannot
 * pick up commands.
 *
 * Discriminating scenario: kickstart the daemon mid-flight while a
 * `/poll` long-poll fetch is in flight. The daemon binary briefly
 * disappears (~1 s), the in-flight fetch fails with a network error,
 * and then the daemon comes back on the same port.
 *
 *   - PRE-FIX:  pollLoop dies on the first failed fetch. Re-arms only
 *     when the keepalive alarm fires (≤60 s later) — much longer than
 *     this test's budget.
 *   - POST-FIX: pollLoop catches the transient error, retries with
 *     backoff (≤ ~7 s ladder, 5 attempts max). Once the daemon returns,
 *     the next /poll succeeds. The success-after-retry path emits a
 *     `pollloop_recovered` trace event with `attempts > 0` — observable
 *     in `~/.safari-pilot/trace.ndjson`.
 *
 * Discrimination layers (positive controls + behavior):
 *   1. Behavior: `safari_evaluate` after kickstart returns the expected
 *      value within a 10 s budget (well below the 60 s alarm interval
 *      so the alarm cannot rescue pre-fix flakily).
 *   2. Positive control: `pollloop_recovered` trace event with
 *      `attempts > 0` exists in the daemon trace, dated AFTER the
 *      kickstart. Pre-fix this event does not exist (the retry path is
 *      the fix); post-fix it must exist if any transient error fired.
 *      This pins the discriminator to the SPECIFIC code path the fix
 *      adds.
 *   3. Negative space: `safari_extension_health` probe BEFORE the
 *      kickstart confirms the baseline path works; the post-kickstart
 *      success therefore cannot be explained away by a stale-cache
 *      shortcut on the MCP side.
 *
 * In-flight `/poll` assurance: warmup eval lands a no-op result on the
 * extension, after which the pollLoop iterates back into another
 * `httpPoll()` (which holds open up to ~5 s for new commands per the
 * daemon's long-poll). The 2 s sleep before kickstart maximizes the
 * probability that the kickstart fires while a `/poll` is mid-hold.
 *
 * NOTE on shared-singleton perturbation: `launchctl kickstart` against
 * the daemon affects every test in the same vitest run. The MCP server's
 * pre-call health gate (Layer 0) recovers its own daemon connection;
 * subsequent tests should survive but may transiently observe the
 * health-gate's transparent recovery. If this test flakes neighbors,
 * mark serial.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rawCallTool, callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const execAsync = promisify(exec);
// IMPORTANT: extension's emitTrace POSTs to the daemon's `/result` endpoint
// with requestId='__trace__'. The daemon writes those to
// `daemon-trace.ndjson` (Trace.swift). The TS server's
// `~/.safari-pilot/trace.ndjson` is a SEPARATE sink for MCP-side events
// only. Reading the wrong file silently fails open — guard with existsSync
// below.
const LIVE_DAEMON_TRACE_FILE = join(homedir(), '.safari-pilot', 'daemon-trace.ndjson');

interface TraceEvent { event?: string; data?: Record<string, unknown>; ts?: number }

function readDaemonTraceEvents(): TraceEvent[] {
  if (!existsSync(LIVE_DAEMON_TRACE_FILE)) return [];
  return readFileSync(LIVE_DAEMON_TRACE_FILE, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l) as TraceEvent; } catch { return {} as TraceEvent; } });
}

describe('T22 — pollLoop transient-retry on daemon kickstart', () => {
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

  it('extension recovers from a daemon kickstart within 10s and emits a `pollloop_recovered` trace with attempts > 0', async () => {
    // 1) Open tab A — confirms baseline IPC works end-to-end.
    const aMarker = `https://example.com/?sp_t22=${Date.now()}`;
    const a = await callTool(client, 'safari_new_tab', { url: aMarker }, nextId());
    tabA = a.tabUrl as string;
    await new Promise((r) => setTimeout(r, 1500));

    // 2) Health probe — positive control that the MCP-side path is up.
    //    If extension_health fails here, the kickstart-window assertion
    //    cannot be interpreted (could be MCP-side breakage).
    const health = await rawCallTool(
      client, 'safari_extension_health', {}, nextId(), 5000,
    );
    expect((health.payload as { connected?: boolean }).connected).toBe(true);

    // 3) Warmup eval — confirms baseline AND lets pollLoop iterate back
    //    into a `httpPoll()` that holds open for the daemon's 5 s
    //    long-poll window.
    const baseline = await rawCallTool(
      client, 'safari_evaluate',
      { tabUrl: tabA!, script: 'return "baseline";' },
      nextId(), 8000,
    );
    expect(baseline.payload.value).toBe('baseline');

    // 4) Capture the kickstart-boundary timestamp BEFORE perturbation —
    //    used to filter trace events to those emitted AFTER kickstart.
    const kickstartAt = Date.now();
    await new Promise((r) => setTimeout(r, 2000));

    // 5) Kickstart the daemon. The HTTP server (port 19475) is briefly
    //    unreachable (~1 s). An in-flight `/poll` fetch from the
    //    extension fails with a network error. Pre-fix: pollLoop dies.
    //    Post-fix: retry ladder catches up.
    await execAsync(`launchctl kickstart -k gui/$(id -u)/com.safari-pilot.daemon`);

    // 6) Behavior assertion: safari_evaluate within a 10 s budget.
    //    Budget is comfortably below the 60 s keepalive alarm interval,
    //    eliminating "alarm fortuitously rescued pre-fix" as a path.
    //    The post-fix retry ladder maxes ~7 s (0+250+500+1000+2000+4000
    //    plus jitter) — fits inside 10 s with daemon cold-start (~1 s).
    const startTime = Date.now();
    let value: unknown;
    let errorMessage: string | null = null;
    try {
      const recovered = await rawCallTool(
        client, 'safari_evaluate',
        { tabUrl: tabA!, script: 'return "recovered";' },
        nextId(), 10000,
      );
      value = recovered.payload.value;
    } catch (e) {
      errorMessage = (e as Error).message;
    }
    const elapsed = Date.now() - startTime;

    // 7) Settle so any post-success trace flush lands.
    await new Promise((r) => setTimeout(r, 500));

    // ── Behavior assertion (load-bearing) ──────────────────────────────
    expect(
      value,
      `Pre-fix bug indicator: extension never recovered within 10s after ` +
      `daemon kickstart (elapsed=${elapsed}ms, error=${errorMessage}). T22's ` +
      `fix must add a retry ladder so pollLoop re-engages on transient errors ` +
      `instead of waiting for the keepalive alarm.`,
    ).toBe('recovered');
    expect(elapsed, 'Recovery must fit inside the post-fix retry budget').toBeLessThan(10000);

    // ── Positive control (pins discriminator to the fix path) ──────────
    // The post-fix success-after-retry path emits
    //   emitTrace('__pollloop__', 'pollloop_recovered', { attempts })
    // where `attempts > 0`. Pre-fix this event simply does not exist —
    // there is no retry path to emit it. Filter to events after the
    // kickstart boundary so we don't false-pass on a stale event.
    //
    // Implementation-coupling note (intentional): asserting on a
    // specific trace event is normally a smell, but the bug we're
    // testing has NO observable behavior of its own — it's a code
    // path, identical-on-the-wire to "the keepalive alarm fortuitously
    // re-armed pollLoop." The trace emission IS the only observable
    // distinguishing signal, hence the contract-style assertion.
    expect(
      existsSync(LIVE_DAEMON_TRACE_FILE),
      `daemon-trace.ndjson must exist after kickstart — daemon writes ` +
      `to ~/.safari-pilot/daemon-trace.ndjson on every emitTrace call. ` +
      `If missing, the daemon's trace sink is broken and this test ` +
      `cannot discriminate.`,
    ).toBe(true);
    const trace = readDaemonTraceEvents();
    const recoveredEvents = trace.filter((e) =>
      e.event === 'pollloop_recovered' &&
      typeof e.ts === 'number' && e.ts >= kickstartAt &&
      typeof e.data?.['attempts'] === 'number' && (e.data['attempts'] as number) > 0,
    );
    expect(
      recoveredEvents.length,
      `Pre-fix bug indicator: no \`pollloop_recovered\` trace events after ` +
      `kickstartAt=${kickstartAt}. Either the retry path was never ` +
      `entered (pre-fix) or its trace emission was removed. The keepalive ` +
      `alarm's path emits \`alarm_fire\`, never \`pollloop_recovered\` — ` +
      `so this assertion excludes the alarm-coincidence false-pass mode.`,
    ).toBeGreaterThan(0);
  }, 60000);
});
