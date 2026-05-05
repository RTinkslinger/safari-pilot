/**
 * E2E test: agent benchmark harness scaffold
 *
 * Verifies that bench/agent.ts:
 *   (a) exits 0 after running a minimal smoke task
 *   (b) writes <out>/score.json with the required BenchScore shape
 *   (c) writes <out>/tool-calls.jsonl with at least one line
 *
 * The test spawns the agent as a real subprocess (node --import tsx bench/agent.ts ...)
 * so it exercises the shipped artifact — not imported module internals.
 *
 * Skipped when ANTHROPIC_API_KEY is absent (CI without key, or offline dev).
 *
 * Zero mocks — no vitest mock APIs, no spies, no stub implementations in this file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

const REPO_ROOT = join(import.meta.dirname, '../..');
const HAS_API_KEY = !!process.env['ANTHROPIC_API_KEY'];

// A minimal smoke task that only requires the agent to call safari_health_check
// and not violate any strict rules. Oracle is no_strict_violation so the test
// doesn't depend on agent IQ — only on harness mechanics producing the right artifacts.
const SMOKE_TASK = {
  id: 'smoke-00',
  description:
    'Call safari_health_check and report whether the system is healthy. Do not open any new tabs.',
  fixtureRoute: '/t43-observation',
  successOracle: {
    type: 'no_strict_violation',
  },
  maxIterations: 3,
  budgetTokens: 4000,
};

describe('bench harness e2e', () => {
  let fixture: FixtureServer;
  let taskPath: string;
  let outDir: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();

    // Write the smoke task to /tmp so agent.ts can read it
    const rand = Math.random().toString(36).slice(2, 8);
    taskPath = join(tmpdir(), `sp-bench-smoke-${rand}.task.json`);
    outDir = join(tmpdir(), `sp-bench-out-${rand}`);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(taskPath, JSON.stringify(SMOKE_TASK), 'utf-8');
  }, 15000);

  afterAll(async () => {
    await fixture.close();
    // Clean up tmp files
    try { rmSync(taskPath, { force: true }); } catch { /* best-effort */ }
    try { rmSync(outDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it.skipIf(!HAS_API_KEY)(
    'runs a single agent task end-to-end and writes a score record',
    () => {
      const result = spawnSync(
        'node',
        [
          '--import', 'tsx',
          join(REPO_ROOT, 'bench/agent.ts'),
          '--task', taskPath,
          '--out', outDir,
          '--fixture-port', String(fixture.hostPort),
          '--variant', 'smoke',
        ],
        {
          cwd: REPO_ROOT,
          env: { ...process.env },
          timeout: 120_000,
          encoding: 'utf-8',
        },
      );

      // (a) exits 0
      expect(
        result.status,
        `agent.ts exited ${result.status}. stderr:\n${result.stderr}`,
      ).toBe(0);

      // (b) score.json exists with required BenchScore shape
      const scorePath = join(outDir, 'score.json');
      expect(existsSync(scorePath), `score.json missing at ${scorePath}`).toBe(true);

      const score = JSON.parse(readFileSync(scorePath, 'utf-8')) as Record<string, unknown>;
      expect(score['task_id']).toBe('smoke-00');
      expect(score['variant']).toBe('smoke');
      expect(typeof score['success']).toBe('boolean');
      expect(typeof score['tool_calls']).toBe('number');
      expect(typeof score['input_tokens']).toBe('number');
      expect(typeof score['output_tokens']).toBe('number');
      expect(typeof score['wall_ms']).toBe('number');
      expect(typeof score['tt']).toBe('number');
      // tt = wall_ms * (input_tokens + output_tokens)
      expect(score['tt']).toBe(
        (score['wall_ms'] as number) * ((score['input_tokens'] as number) + (score['output_tokens'] as number)),
      );

      // (c) tool-calls.jsonl exists with at least 1 line
      const toolCallsPath = join(outDir, 'tool-calls.jsonl');
      expect(existsSync(toolCallsPath), `tool-calls.jsonl missing at ${toolCallsPath}`).toBe(true);

      const lines = readFileSync(toolCallsPath, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0);
      expect(lines.length, 'tool-calls.jsonl must have at least one entry').toBeGreaterThanOrEqual(1);

      // Each line must be valid JSON with a tool field
      for (const line of lines) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        expect(typeof entry['tool']).toBe('string');
      }
    },
    120_000,
  );
});
