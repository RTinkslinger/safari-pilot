// test/e2e/webvoyager-judge-real.test.ts
//
// Hits the real OpenAI gpt-4o API once. Cost ~$0.01 per run.
// Skipped if OPENAI_API_KEY is not set in env.

import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJudge } from '../../bench/webvoyager/judge.js';

const skip = !process.env.OPENAI_API_KEY;

describe.skipIf(skip)('runJudge — real OpenAI gpt-4o', () => {
  it('returns one of SUCCESS/FAILURE/UNKNOWN against a 1x1 white PNG', async () => {
    // 8x8 white PNG — minimum size accepted by OpenAI vision API
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000080000000808020000004b6d29dc0000000f49444154789c63f88f03300c2d0900ba1ebf4130930afc0000000049454e44ae426082',
      'hex',
    );
    const path = join(tmpdir(), 'wv-judge-smoke.png');
    writeFileSync(path, png);

    const r = await runJudge('What does the user see?', 'A blank white screen', path);
    expect(['SUCCESS', 'FAILURE', 'UNKNOWN']).toContain(r.verdict);
    expect(r.reasoning.length).toBeGreaterThan(0);
  }, 60_000);
});
