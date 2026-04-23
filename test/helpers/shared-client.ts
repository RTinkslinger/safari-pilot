/**
 * Shared MCP client for the e2e harness.
 *
 * Production runs ONE MCP server per Claude Code session. The pre-T-Harness
 * test suite ran one per test file (6 servers → 6 Safari session windows,
 * 6× init latency). This module is the harness-side fix: every test file
 * calls `getSharedClient()` which lazily spawns a single server, and all
 * subsequent calls across all files return the same instance.
 *
 * The singleton pattern only holds if vitest is configured with:
 *   pool: 'forks', poolOptions: { forks: { singleFork: true } }, isolate: false
 * (see vitest.config.ts). With those settings, every test file shares a
 * single worker process and therefore a single module instance. Without
 * them, each file gets its own fork and its own "singleton" — the plural
 * is the bug.
 *
 * Teardown is wired two ways for safety:
 *   1. A setupFile runs `afterAll(closeSharedClient)` inside the worker —
 *      the primary path.
 *   2. `beforeExit` on process exit — backup for paths where setupFiles
 *      don't fire (early crash, unhandled rejection).
 * Both are idempotent. T10's SIGTERM handler on the server side is the
 * third line of defence — even `kill -TERM` on the worker closes its
 * session window.
 *
 * Per-test isolation is via unique URL markers (`?sp_<file>_<counter>=...`)
 * on new-tab calls. Tests MUST close any tabs they open in try/finally.
 * Trace-scanning assertions MUST filter by a unique-per-test identifier —
 * `~/.safari-pilot/trace.ndjson` is shared across the whole run.
 */
import { initClient, type McpTestClient } from './mcp-client.js';

interface SharedState {
  client: McpTestClient;
  counter: number;
}

let shared: SharedState | null = null;
let initPromise: Promise<SharedState> | null = null;

/**
 * Lazily initialize the shared MCP client. First call performs the spawn +
 * MCP `initialize` handshake (~10s for extension connect). All subsequent
 * calls — from any test in any file in the same worker — return the same
 * instance with a shared monotonic `nextId()` counter.
 *
 * Concurrent callers wait on a single in-flight promise so we never spawn
 * two servers if two test files race on the first call. On init failure,
 * the cached promise is cleared so a subsequent call can retry from scratch;
 * the original caller still sees the original rejection (they asked first).
 */
export async function getSharedClient(): Promise<{ client: McpTestClient; nextId: () => number }> {
  if (shared) {
    return { client: shared.client, nextId: () => shared!.counter++ };
  }
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const { client, nextId } = await initClient('dist/index.js');
        shared = { client, counter: nextId };
        return shared;
      } catch (err) {
        // Clear the cached rejection so the next caller can retry rather
        // than permanently await the same rejected promise.
        initPromise = null;
        throw err;
      }
    })();
  }
  const s = await initPromise;
  return { client: s.client, nextId: () => s.counter++ };
}

/**
 * Shut down the shared client. Idempotent and null-safe — can be called
 * before initialization (setupFile `afterAll` fires even if no test ever
 * reached `getSharedClient()`, e.g. if precondition setup failed).
 */
export async function closeSharedClient(): Promise<void> {
  if (!shared) return;
  const s = shared;
  shared = null;
  initPromise = null;
  try {
    await s.client.close();
  } catch {
    // Best effort — the process is going away either way.
  }
}

// Process-level backup: if the worker exits without running the setupFile's
// `afterAll` (crash during setupFile load, unhandled rejection before any
// test registered a hook), try to close before the event loop drains.
// `beforeExit` is async-friendly; `exit` is sync-only and therefore useless
// for this purpose. This path is defensive and not covered by a unit test —
// the primary teardown is the setupFile `afterAll` and T10's server-side
// SIGTERM handler catches everything beyond that. If `beforeExit` fires
// after `afterAll` already nulled `shared`, the null guard makes it a no-op.
process.once('beforeExit', () => {
  if (shared) {
    void closeSharedClient();
  }
});
