// src/discovery/recipe-miner.ts
// Port of Browser Use's browser-harness pattern: read execution traces,
// extract recurring successful tool sequences, emit candidate skills.
import { readdir, readFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface MineOptions {
  minOccurrences: number;
  minLength: number;
}

export interface RecipeCandidate {
  host: string;
  steps: Array<{ tool: string; argSignature: string }>;
  occurrences: number;
}

export async function mineRecipes(rootDir: string, opts: MineOptions): Promise<RecipeCandidate[]> {
  const traces = await collectTraces(rootDir);
  const counts = new Map<string, RecipeCandidate>();
  for (const trace of traces) {
    if (trace.steps.length < opts.minLength) continue;
    const key = trace.host + '|' + trace.steps.map((s) => `${s.tool}:${s.argSignature}`).join('>');
    const existing = counts.get(key);
    if (existing) existing.occurrences++;
    else counts.set(key, { host: trace.host, steps: trace.steps, occurrences: 1 });
  }
  return [...counts.values()].filter((c) => c.occurrences >= opts.minOccurrences);
}

async function collectTraces(
  root: string,
): Promise<Array<{ host: string; steps: Array<{ tool: string; argSignature: string }> }>> {
  const out: Array<{ host: string; steps: Array<{ tool: string; argSignature: string }> }> = [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(root, e);
    const s = await stat(p).catch(() => null);
    if (!s || !s.isDirectory()) continue;
    try {
      const score = JSON.parse(await readFile(join(p, 'score.json'), 'utf8')) as Record<string, unknown>;
      if (!score['success']) continue;
      const traceText = await readFile(join(p, 'tool-calls.jsonl'), 'utf8');
      const steps = traceText
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const entry = JSON.parse(line) as { tool: unknown; args: unknown };
          return {
            tool: String(entry.tool),
            argSignature: signature(entry.args),
          };
        });
      const host = inferHost(traceText);
      out.push({ host, steps });
    } catch {
      /* skip incomplete run dirs */
    }
  }
  return out;
}

function signature(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  return Object.keys(args as Record<string, unknown>)
    .sort()
    .join(',');
}

function inferHost(trace: string): string {
  const m = trace.match(/"url"\s*:\s*"https?:\/\/([^/"]+)/);
  return m?.[1] ?? 'unknown';
}
