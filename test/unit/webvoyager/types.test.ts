// test/unit/webvoyager/types.test.ts
import { describe, it, expect } from 'vitest';
import type { WebVoyagerTask, WebVoyagerScore, JudgeVerdict } from '../../../bench/webvoyager/types.js';
import { parseWebVoyagerTask } from '../../../bench/webvoyager/types.js';

describe('WebVoyager types', () => {
  it('parses a canonical WebVoyager task line into WebVoyagerTask', () => {
    const raw = JSON.stringify({
      web_name: 'Allrecipes',
      id: 'Allrecipes--12',
      ques: 'Find a vegetarian lasagna recipe with at least 4-star rating.',
      web: 'https://www.allrecipes.com',
    });
    const task: WebVoyagerTask = parseWebVoyagerTask(raw);
    expect(task.id).toBe('Allrecipes--12');
    expect(task.site).toBe('Allrecipes');
    expect(task.url).toBe('https://www.allrecipes.com');
    expect(task.question).toBe('Find a vegetarian lasagna recipe with at least 4-star rating.');
  });

  it('throws on malformed task JSON', () => {
    expect(() => parseWebVoyagerTask('{not json')).toThrow(/parse/i);
    expect(() => parseWebVoyagerTask(JSON.stringify({ id: 'x' }))).toThrow(/missing/i);
  });

  it('JudgeVerdict has the three required values', () => {
    const verdicts: JudgeVerdict[] = ['SUCCESS', 'FAILURE', 'UNKNOWN'];
    expect(verdicts.length).toBe(3);
  });

  it('WebVoyagerScore uses wall_ms as cost metric (no tt)', () => {
    const score: WebVoyagerScore = {
      task_id: 'Allrecipes--12',
      variant: 'v0.1.29',
      verdict: 'SUCCESS',
      judge_reasoning: 'Agent returned a valid recipe URL',
      agent_final_text: 'Found: Classic Vegetarian Lasagna at allrecipes.com/recipe/45323',
      run_seq: 1,
      wall_ms: 18420,
      screenshot_path: '/tmp/wv-Allrecipes--12.png',
    };
    expect(score.wall_ms).toBeGreaterThan(0);
    // Compile-time check: tt should NOT be in the type
    expect('tt' in score).toBe(false);
  });
});
