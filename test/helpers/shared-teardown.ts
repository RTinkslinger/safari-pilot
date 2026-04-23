/**
 * Worker-level afterAll teardown for the shared MCP client.
 *
 * Registered via `vitest.config.ts → setupFiles`, this file runs once per
 * vitest worker. With `poolOptions.forks.singleFork: true` there is exactly
 * one worker for the entire run, so this `afterAll` fires exactly once —
 * after the last test in the last file completes.
 *
 * Idempotent with `closeSharedClient`'s null guard, so we don't need to
 * coordinate with the `beforeExit` backup in `shared-client.ts`.
 */
import { afterAll } from 'vitest';
import { closeSharedClient } from './shared-client.js';

afterAll(async () => {
  await closeSharedClient();
});
