// test/unit/webvoyager/judge.test.ts
import { describe, it, expect } from 'vitest';
import {
  getJudgeSystemPrompt,
  buildJudgeUserPrompt,
  parseJudgeResponse,
} from '../../../bench/webvoyager/judge.js';

describe('judge prompts', () => {
  it('system prompt loads from file and is non-trivial', () => {
    const sys = getJudgeSystemPrompt();
    expect(sys.length).toBeGreaterThan(500);
    // Anchor on a phrase that exists verbatim in upstream
    expect(sys).toContain('As an evaluator');
    expect(sys).toContain("'SUCCESS' or 'NOT SUCCESS'");
  });

  it('user prompt substitutes <task>, <answer>, <num>', () => {
    const built = buildJudgeUserPrompt('Find lasagna', 'Done: link.html', 1);
    expect(built).toContain('TASK: Find lasagna');
    expect(built).toContain('Result Response: Done: link.html');
    expect(built).toContain('1 screenshots at the end:');
    // Placeholders fully replaced
    expect(built).not.toContain('<task>');
    expect(built).not.toContain('<answer>');
    expect(built).not.toContain('<num>');
  });

  it('user prompt defaults numScreenshots to 1', () => {
    const built = buildJudgeUserPrompt('q', 'a');
    expect(built).toContain('1 screenshots at the end:');
  });
});

describe('parseJudgeResponse — upstream substring logic', () => {
  it('returns SUCCESS when response contains "SUCCESS" but not "NOT SUCCESS"', () => {
    const r = parseJudgeResponse('Reasoning: agent returned valid recipe. Verdict: SUCCESS');
    expect(r.verdict).toBe('SUCCESS');
    expect(r.reasoning.length).toBeGreaterThan(0);
  });

  it('returns FAILURE when response contains "NOT SUCCESS" (even though it also contains substring SUCCESS)', () => {
    const r = parseJudgeResponse('The agent did not complete the task. Verdict: NOT SUCCESS');
    expect(r.verdict).toBe('FAILURE');
  });

  it('returns UNKNOWN when response contains neither token', () => {
    const r = parseJudgeResponse('This is some ambiguous reasoning without a final verdict label.');
    expect(r.verdict).toBe('UNKNOWN');
  });

  it('FAILURE check runs before SUCCESS check (substring ordering)', () => {
    // Verdict line literally is "NOT SUCCESS" — must be FAILURE, not SUCCESS
    const r = parseJudgeResponse('Final answer: NOT SUCCESS');
    expect(r.verdict).toBe('FAILURE');
  });

  it('truncates reasoning to 800 chars', () => {
    const big = 'x'.repeat(2000) + ' SUCCESS';
    const r = parseJudgeResponse(big);
    expect(r.reasoning.length).toBeLessThanOrEqual(800);
  });

  it('handles a realistic upstream-style response (free-form text, no Verdict: label)', () => {
    const realistic =
      'The screenshot shows the user has navigated to the recipe page and the agent ' +
      "correctly identified the 4.5-star vegetarian lasagna recipe. " +
      'I conclude the task was completed successfully. SUCCESS';
    const r = parseJudgeResponse(realistic);
    expect(r.verdict).toBe('SUCCESS');
  });
});
