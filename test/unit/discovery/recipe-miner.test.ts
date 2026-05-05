import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mineRecipes } from '../../../src/discovery/recipe-miner.js';

describe('mineRecipes', () => {
  it('extracts a recurring sequence as a candidate skill', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mine-'));
    for (const id of ['run1', 'run2']) {
      const sub = join(dir, id);
      await mkdir(sub, { recursive: true });
      const trace = [
        { tool: 'safari_new_tab', args: { url: 'https://example.com/login' } },
        { tool: 'safari_fill', args: { selector: '#email' } },
        { tool: 'safari_click', args: { selector: 'button[type=submit]' } },
      ].map((e) => JSON.stringify(e)).join('\n');
      await writeFile(join(sub, 'tool-calls.jsonl'), trace);
      await writeFile(join(sub, 'score.json'), JSON.stringify({ task_id: 'login', success: true }));
    }
    const candidates = await mineRecipes(dir, { minOccurrences: 2, minLength: 3 });
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0]?.steps.length).toBe(3);
    expect(candidates[0]?.host).toBe('example.com');
    expect(candidates[0]?.occurrences).toBeGreaterThanOrEqual(2);
  });

  it('skips traces from failed runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mine-fail-'));
    for (const id of ['fail1', 'fail2']) {
      const sub = join(dir, id);
      await mkdir(sub, { recursive: true });
      const trace = [
        { tool: 'safari_new_tab', args: { url: 'https://example.com/x' } },
        { tool: 'safari_click', args: { selector: '.x' } },
      ].map((e) => JSON.stringify(e)).join('\n');
      await writeFile(join(sub, 'tool-calls.jsonl'), trace);
      await writeFile(join(sub, 'score.json'), JSON.stringify({ task_id: 'x', success: false }));
    }
    const candidates = await mineRecipes(dir, { minOccurrences: 2, minLength: 2 });
    expect(candidates.length).toBe(0);
  });

  it('respects minLength filter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mine-short-'));
    for (const id of ['s1', 's2']) {
      const sub = join(dir, id);
      await mkdir(sub, { recursive: true });
      const trace = JSON.stringify({ tool: 'safari_navigate', args: { url: 'https://example.com' } });
      await writeFile(join(sub, 'tool-calls.jsonl'), trace);
      await writeFile(join(sub, 'score.json'), JSON.stringify({ success: true }));
    }
    const candidates = await mineRecipes(dir, { minOccurrences: 2, minLength: 3 });
    expect(candidates.length).toBe(0);
  });

  it('handles missing score.json gracefully', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mine-noscore-'));
    const sub = join(dir, 'no-score');
    await mkdir(sub, { recursive: true });
    const trace = JSON.stringify({ tool: 'safari_new_tab', args: { url: 'https://example.com' } });
    await writeFile(join(sub, 'tool-calls.jsonl'), trace);
    // No score.json
    const candidates = await mineRecipes(dir, { minOccurrences: 1, minLength: 1 });
    expect(candidates).toEqual([]);
  });
});
