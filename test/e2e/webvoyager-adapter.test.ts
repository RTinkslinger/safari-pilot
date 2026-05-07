// test/e2e/webvoyager-adapter.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWebVoyagerTask } from '../../bench/webvoyager/adapter.js';
import type { WebVoyagerTask } from '../../bench/webvoyager/types.js';

let outDir: string;

beforeAll(() => {
  outDir = mkdtempSync(join(tmpdir(), 'wv-test-'));
});

afterAll(() => {
  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
});

describe('WebVoyager adapter — e2e (real claude -p, real Safari, post-hoc screenshot)', () => {
  it('drives a trivial task and returns final text + screenshot path captured by harness', async () => {
    const task: WebVoyagerTask = {
      id: 'TEST--smoke',
      site: 'Test',
      url: 'http://127.0.0.1:18080/bench-smoke',
      question: 'What is the H1 text on this page?',
    };
    const result = await runWebVoyagerTask(task, {
      variant: 'adapter-smoke-test',
      outDir,
      runSeq: 1,
      timeoutMs: 180_000,
    });
    expect(result.task_id).toBe('TEST--smoke');
    expect(result.agent_final_text.length).toBeGreaterThan(0);
    expect(result.screenshot_path).toMatch(/\.png$/);
    expect(existsSync(result.screenshot_path)).toBe(true);
    expect(statSync(result.screenshot_path).size).toBeGreaterThan(1000);
    expect(result.wall_ms).toBeGreaterThan(0);
  }, 240_000);
});
