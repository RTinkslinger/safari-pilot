// bench/webvoyager/sample.ts
import type { WebVoyagerTask } from './types.js';

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleSeed(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function stratifiedSample(tasks: WebVoyagerTask[], n: number, seed: number): WebVoyagerTask[] {
  const bySite = new Map<string, WebVoyagerTask[]>();
  for (const t of tasks) {
    const arr = bySite.get(t.site) ?? [];
    arr.push(t);
    bySite.set(t.site, arr);
  }

  const sites = [...bySite.keys()].sort();
  const perSite = Math.floor(n / sites.length);
  const remainder = n - perSite * sites.length;

  const rand = mulberry32(seed);
  const result: WebVoyagerTask[] = [];

  for (let s = 0; s < sites.length; s++) {
    const siteTasks = bySite.get(sites[s]!)!.slice();
    for (let i = siteTasks.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [siteTasks[i], siteTasks[j]] = [siteTasks[j]!, siteTasks[i]!];
    }
    const want = perSite + (s < remainder ? 1 : 0);
    const take = Math.min(want, siteTasks.length);  // graceful: small sites take what they have
    result.push(...siteTasks.slice(0, take));
  }

  return result;
}
