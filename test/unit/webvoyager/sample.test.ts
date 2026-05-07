// test/unit/webvoyager/sample.test.ts
import { describe, it, expect } from 'vitest';
import { stratifiedSample, sampleSeed } from '../../../bench/webvoyager/sample.js';
import type { WebVoyagerTask } from '../../../bench/webvoyager/types.js';

const tasks: WebVoyagerTask[] = [];
const sites = ['Allrecipes', 'Amazon', 'Apple'];
for (const site of sites) {
  for (let i = 0; i < 30; i++) {
    tasks.push({ id: `${site}--${i}`, site, url: `https://${site.toLowerCase()}.com`, question: `q${i}` });
  }
}

describe('stratifiedSample', () => {
  it('returns approximately n items, proportionally across sites', () => {
    const sample = stratifiedSample(tasks, 30, sampleSeed('v1'));
    expect(sample.length).toBeGreaterThanOrEqual(28);
    expect(sample.length).toBeLessThanOrEqual(32);
    const counts: Record<string, number> = {};
    for (const t of sample) counts[t.site] = (counts[t.site] ?? 0) + 1;
    expect(Object.keys(counts).length).toBe(3);
    for (const c of Object.values(counts)) {
      expect(c).toBeGreaterThanOrEqual(8);
      expect(c).toBeLessThanOrEqual(12);
    }
  });

  it('is deterministic for the same seed', () => {
    const a = stratifiedSample(tasks, 30, sampleSeed('v1'));
    const b = stratifiedSample(tasks, 30, sampleSeed('v1'));
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id));
  });

  it('produces different orderings for different seeds', () => {
    const a = stratifiedSample(tasks, 30, sampleSeed('v1'));
    const b = stratifiedSample(tasks, 30, sampleSeed('v2'));
    expect(a.map((t) => t.id)).not.toEqual(b.map((t) => t.id));
  });

  it('handles small sites gracefully (takes all available)', () => {
    const small: WebVoyagerTask[] = [
      { id: 'Big--1', site: 'Big', url: 'x', question: 'x' },
      { id: 'Big--2', site: 'Big', url: 'x', question: 'x' },
      { id: 'Big--3', site: 'Big', url: 'x', question: 'x' },
      { id: 'Tiny--1', site: 'Tiny', url: 'x', question: 'x' },
    ];
    const sample = stratifiedSample(small, 4, sampleSeed('v1'));
    // Tiny only has 1 task; sampler must not crash and must include it
    expect(sample.find((t) => t.site === 'Tiny')).toBeDefined();
  });
});
