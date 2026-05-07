// test/e2e/webvoyager-runner.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let runDir: string;

beforeAll(() => { runDir = mkdtempSync(join(tmpdir(), 'wv-runner-')); });
afterAll(() => { if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true }); });

describe('WebVoyager runner — e2e', () => {
  it('runs 2 tasks, writes scoreboard.json (with --skip-judge to keep cheap)', () => {
    const r = spawnSync(
      'node',
      [
        '--import', 'tsx',
        'bench/webvoyager/runner.ts',
        '--tasks-file', join(__dirname, 'fixtures/wv-2-tasks.jsonl'),
        '--variant', 'runner-smoke',
        '--out-dir', runDir,
        '--runs', '1',
        '--concurrency', '1',
        '--skip-judge',
      ],
      { stdio: 'pipe', cwd: process.cwd() },
    );
    expect(r.status).toBe(0);
    const sbPath = join(runDir, 'scoreboard.json');
    expect(existsSync(sbPath)).toBe(true);
    const sb = JSON.parse(readFileSync(sbPath, 'utf-8'));
    expect(sb.overall.tasks_total).toBe(2);
  }, 600_000);

  it('RESUMES — pre-existing score.json files are honored, runner skips them', () => {
    // Pre-write a fake score for one task; runner should detect and skip it.
    const fakeScore = {
      task_id: 'FIX--smoke', variant: 'resume-test',
      verdict: 'SUCCESS', judge_reasoning: 'pre-existing',
      agent_final_text: 'cached', run_seq: 1, wall_ms: 999,
      screenshot_path: '/tmp/cached.png',
    };
    writeFileSync(join(runDir, 'FIX_-smoke-r1.score.json'), JSON.stringify(fakeScore));
    const r = spawnSync(
      'node',
      [
        '--import', 'tsx',
        'bench/webvoyager/runner.ts',
        '--tasks-file', join(__dirname, 'fixtures/wv-2-tasks.jsonl'),
        '--variant', 'resume-test',
        '--out-dir', runDir,
        '--runs', '1',
        '--concurrency', '1',
        '--skip-judge',
        '--resume',
      ],
      { stdio: 'pipe', cwd: process.cwd() },
    );
    expect(r.status).toBe(0);
    const stdout = r.stdout.toString();
    expect(stdout).toMatch(/skipping.*FIX--smoke|resume.*1.*existing/i);
  }, 600_000);
});
