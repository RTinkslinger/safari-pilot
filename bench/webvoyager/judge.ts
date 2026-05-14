// bench/webvoyager/judge.ts
//
// Re-implementation of WebVoyager's auto_eval.py for `claude -p` outputs.
// See JUDGE_DEVIATION.md for the documented deviation (single-screenshot variant).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import type { JudgeVerdict } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cachedSystemPrompt: string | null = null;
let cachedUserTemplate: string | null = null;

export function getJudgeSystemPrompt(): string {
  if (cachedSystemPrompt !== null) return cachedSystemPrompt;
  cachedSystemPrompt = readFileSync(join(__dirname, 'judge-system-prompt.txt'), 'utf-8');
  return cachedSystemPrompt;
}

function loadUserTemplate(): string {
  if (cachedUserTemplate !== null) return cachedUserTemplate;
  cachedUserTemplate = readFileSync(join(__dirname, 'judge-user-prompt.txt'), 'utf-8');
  return cachedUserTemplate;
}

/**
 * Substitutes <task>, <answer>, <num> into the upstream-verbatim USER_PROMPT.
 * Default `numScreenshots = 1` reflects our single-screenshot deviation
 * (see JUDGE_DEVIATION.md).
 */
export function buildJudgeUserPrompt(
  question: string,
  agentFinalText: string,
  numScreenshots: number = 1,
): string {
  let p = loadUserTemplate();
  p = p.replace(/<task>/g, question);
  p = p.replace(/<answer>/g, agentFinalText);
  p = p.replace(/<num>/g, String(numScreenshots));
  return p;
}

export interface JudgeResult {
  verdict: JudgeVerdict;
  reasoning: string;
}

/**
 * Verdict parsing — mirrors upstream auto_eval.py lines 130-132 exactly:
 *   - 'NOT SUCCESS' in response → FAILURE
 *   - else 'SUCCESS' in response → SUCCESS
 *   - else → UNKNOWN
 * Order matters: 'NOT SUCCESS' contains the substring 'SUCCESS', so check it first.
 */
export function parseJudgeResponse(text: string): JudgeResult {
  let verdict: JudgeVerdict;
  if (text.includes('NOT SUCCESS')) {
    verdict = 'FAILURE';
  } else if (text.includes('SUCCESS')) {
    verdict = 'SUCCESS';
  } else {
    verdict = 'UNKNOWN';
  }
  const reasoning = text.trim().slice(0, 800);
  return { verdict, reasoning };
}

/**
 * Run the judge against a single (question, agent_answer, screenshot) triple.
 * Sends as system + user messages mirroring upstream's chat structure.
 */
export async function runJudge(
  question: string,
  agentFinalText: string,
  screenshotPath: string,
  client?: OpenAI,
): Promise<JudgeResult> {
  const c = client ?? new OpenAI();
  const imageB64 = readFileSync(screenshotPath).toString('base64');
  const userPrompt = buildJudgeUserPrompt(question, agentFinalText, 1);
  const response = await c.chat.completions.create({
    model: 'gpt-4o',
    seed: 42,
    temperature: 0,
    max_tokens: 1000,
    messages: [
      { role: 'system', content: getJudgeSystemPrompt() },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageB64}` } },
          { type: 'text', text: 'Your verdict:\n' },
        ],
      },
    ],
  });
  const text = response.choices[0]?.message?.content ?? '';
  return parseJudgeResponse(text);
}

/**
 * Majority-of-N verdict aggregator.
 * Returns the verdict with the strict majority of votes, or UNKNOWN if no majority exists.
 */
export function aggregateMajorityVerdict<T extends string>(verdicts: readonly T[]): T | 'UNKNOWN' {
  if (verdicts.length === 0) return 'UNKNOWN' as T | 'UNKNOWN';
  const counts = new Map<T, number>();
  for (const v of verdicts) counts.set(v, (counts.get(v) ?? 0) + 1);
  const half = verdicts.length / 2;
  for (const [v, n] of counts) {
    if (n > half) return v;
  }
  return 'UNKNOWN' as T | 'UNKNOWN';
}
