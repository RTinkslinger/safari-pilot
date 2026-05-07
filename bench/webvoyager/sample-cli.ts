// bench/webvoyager/sample-cli.ts
//
// Draws a stratified deterministic sample from a WebVoyager-format JSONL.
// Used by run.sh to produce the 175-task dev sample with a fixed seed.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseWebVoyagerTask } from './types.js';
import { stratifiedSample, sampleSeed } from './sample.js';

const args: Record<string, string> = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a && a.startsWith('--') && i + 1 < process.argv.length) {
    args[a.slice(2)] = process.argv[i + 1] as string;
    i++;
  }
}

const tasks = readFileSync(args['in']!, 'utf-8')
  .split('\n').filter((l) => l.trim()).map(parseWebVoyagerTask);

const n = parseInt(args['n']!, 10);
const seed = sampleSeed(args['seed'] ?? 'default');
const sampled = stratifiedSample(tasks, n, seed);

writeFileSync(
  args['out']!,
  sampled.map((t) => JSON.stringify({ id: t.id, web_name: t.site, ques: t.question, web: t.url })).join('\n') + '\n',
);
process.stdout.write(`[sample-cli] wrote ${sampled.length} tasks to ${args['out']}\n`);
