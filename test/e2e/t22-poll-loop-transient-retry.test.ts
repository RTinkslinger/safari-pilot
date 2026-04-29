/**
 * T22 — `extension/background.js` `pollLoop` must retry transient failures
 * (network blip, daemon restart, dropped TCP) instead of dying on the
 * first non-Abort error. Pre-fix: any non-AbortError/non-TimeoutError
 * caught at the catch returns from the loop, leaving re-arming to the
 * keepalive alarm (≤60 s). During that dead period the extension cannot
 * pick up commands.
 *
 * Discriminating scenario: arm a one-shot fetch-failure injection in
 * the next `/poll` iteration via the test-bridge. Pre-fix: pollLoop
 * dies on the injected TypeError, alarm-rearm needed. Post-fix: retry
 * ladder catches it, next iteration succeeds, emits a
 * `pollloop_recovered` trace event with `attempts > 0`.
 *
 * Why injection, not daemon kickstart: an earlier iteration of this
 * test used `launchctl kickstart -k` to restart the daemon. That
 * approach (a) revealed a separate daemon-deadlock bug under
 * concurrent test load that masked T22's behavior, and (b) coupled the
 * test to MCP-side TCP recovery (the daemon engine's reconnect path)
 * rather than isolating the pollLoop's retry behavior. Bridge
 * injection precisely targets the catch-and-retry path the fix adds.
 *
 * Discriminator: `pollloop_recovered` event with `attempts > 0` in
 * `~/.safari-pilot/daemon-trace.ndjson`. Pre-fix this trace never
 * exists (the path doesn't exist). Post-fix it must exist if any
 * transient error fires the retry. The keepalive alarm path emits
 * `alarm_fire`, not `pollloop_recovered` — so an alarm-driven recovery
 * cannot satisfy this assertion.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rawCallTool, callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

describe('T22 — pollLoop retries on injected transient fetch failure', () => {
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

  it('arming next-poll-failure injection triggers the retry ladder, emitting pollloop_recovered with attempts > 0', async () => {
    // 1) Open tab A — bridge needs a content-isolated context to operate.
    const aMarker = `https://example.com/?sp_t22=${Date.now()}`;
    const a = await callTool(client, 'safari_new_tab', { url: aMarker }, nextId());
    tabA = a.tabUrl as string;
    await new Promise((r) => setTimeout(r, 1500));

    // 2) Capture boundary timestamp BEFORE arming, so the trace assertion
    //    can filter to events after this point.
    const armedAt = Date.now();

    // 3) Arm the injection. Background sets a single-fire flag; the next
    //    httpPoll iteration in pollLoop will throw a TypeError instead
    //    of fetching. After the throw, pollLoop's catch path runs:
    //    attempts++, sleep(0..jitter), retry. Next iteration succeeds
    //    (flag cleared), and the success-after-retry path emits
    //    `pollloop_recovered` with attempts > 0.
    const arm = await harness(client, nextId, tabA!, {
      action: 'injectNextPollFailure',
    });
    expect((arm as Record<string, unknown>).armed).toBe(true);

    // 4) Wait for the cycle to complete:
    //    - In-flight /poll holds up to 5 s (daemon long-poll)
    //    - Next iteration sees the injected failure → catches → first
    //      retry sleep (0 ms + jitter ≤250 ms)
    //    - Retry fetch succeeds → `pollloop_recovered` emitted
    //    - emitTrace POSTs to /result; daemon writes to
    //      daemon-trace.ndjson
    //    7 s gives ample margin even if the in-flight long-poll is at
    //    the start of its 5-s window.
    await new Promise((r) => setTimeout(r, 7000));

    // 5) Trace assertion (load-bearing).
    expect(
      existsSync(LIVE_DAEMON_TRACE_FILE),
      'daemon-trace.ndjson must exist — daemon writes extension emitTrace ' +
      'events here. If missing, the trace sink is broken.',
    ).toBe(true);
    const trace = readDaemonTraceEvents();
    const recoveredEvents = trace.filter((e) =>
      e.event === 'pollloop_recovered' &&
      typeof e.ts === 'string' && new Date(e.ts).getTime() >= armedAt &&
      typeof e.data?.['attempts'] === 'number' && (e.data['attempts'] as number) > 0,
    );
    expect(
      recoveredEvents.length,
      `Pre-fix bug indicator: no \`pollloop_recovered\` trace events with ` +
      `attempts > 0 after armedAt=${new Date(armedAt).toISOString()}. ` +
      `Either the retry path was never entered (pre-fix) or its trace ` +
      `emission was removed. The keepalive alarm's path emits \`alarm_fire\`, ` +
      `never \`pollloop_recovered\` — so this assertion excludes the ` +
      `alarm-coincidence false-pass mode.`,
    ).toBeGreaterThan(0);
  }, 30000);
});
