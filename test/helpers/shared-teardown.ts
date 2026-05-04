/**
 * Shared MCP client teardown — relies on `process.once('beforeExit', ...)`
 * registered in `shared-client.ts`.
 *
 * **T71 (2026-05-04):** the previous design registered `afterAll(closeSharedClient)`
 * here under the (wrong) assumption that vitest's `setupFiles` fires the
 * `afterAll` once per worker. It actually fires **once per test file** —
 * confirmed by stderr-tracing closeSharedClient invocations: 4 calls during
 * a 4-file sweep. Each invocation kills the MCP server, spawns a new one for
 * the next file, and creates a ~10s window where Safari's MV3 event page
 * can suspend with a queued command in the bridge → the queued command
 * stalls until the next keepalive wakes the extension. This produced an 80%
 * flake rate on multi-file e2e sweeps with the failure migrating between
 * tests run-to-run (T71 phase-1 evidence).
 *
 * Cleanup paths after T71:
 *   - `process.once('beforeExit', ...)` in shared-client.ts — primary; fires
 *     when the worker's event loop drains at the very end of the run.
 *   - MCP server's own `SIGTERM` handler — secondary; fires when the worker
 *     process is reaped by vitest, cascading to its child processes.
 *
 * This file remains in `setupFiles` so vitest evaluates it (no-op import is
 * cheap), but registers no per-file hook. Empty content is intentional — do
 * not re-add `afterAll(closeSharedClient)` without re-establishing why
 * setupFiles afterAll won't fire per-file.
 */
export {};
