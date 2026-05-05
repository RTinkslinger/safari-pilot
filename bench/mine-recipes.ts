// bench/mine-recipes.ts
// Usage: node --import tsx bench/mine-recipes.ts [run-dir] [out-dir]
// Default: scans bench-runs/, writes candidates to skills/candidates/
import { mineRecipes } from '../src/discovery/recipe-miner.js';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

async function main(): Promise<void> {
  const root = process.argv[2] ?? 'bench-runs';
  const out = process.argv[3] ?? 'skills/candidates';
  await mkdir(out, { recursive: true });

  // bench-runs/ has nested timestamp dirs containing per-task subdirs.
  // Mine each timestamp dir individually then aggregate.
  const allCandidates: Awaited<ReturnType<typeof mineRecipes>> = [];
  let topEntries: string[];
  try {
    topEntries = await readdir(root);
  } catch {
    console.error(`No such dir: ${root}`);
    process.exit(1);
  }
  for (const e of topEntries) {
    const p = join(root, e);
    const s = await stat(p).catch(() => null);
    if (!s || !s.isDirectory()) continue;
    const cands = await mineRecipes(p, { minOccurrences: 1, minLength: 3 });
    allCandidates.push(...cands);
  }

  // Aggregate by (host + sequence) across all timestamp dirs.
  const merged = new Map<
    string,
    { host: string; steps: (typeof allCandidates)[number]['steps']; occurrences: number }
  >();
  for (const c of allCandidates) {
    const key = c.host + '|' + c.steps.map((s) => s.tool).join('>');
    const existing = merged.get(key);
    if (existing) existing.occurrences += c.occurrences;
    else merged.set(key, { ...c });
  }
  const final = [...merged.values()].filter((c) => c.occurrences >= 2);

  for (const [i, c] of final.entries()) {
    const safeHost = c.host.replace(/[^a-z0-9]/gi, '-');
    const fname = join(out, `${safeHost}-${i}.SKILL.md`);
    const md = `---
name: candidate-${safeHost}-${i}
description: Auto-mined candidate from ${c.occurrences} successful traces on ${c.host}. Review before promoting.
triggers: []
inputs: []
---

\`\`\`json
{ "steps": ${JSON.stringify(
      c.steps.map((s) => ({ tool: s.tool, args: {} })),
      null,
      2,
    )} }
\`\`\`
`;
    await writeFile(fname, md);
  }
  console.log(
    `Wrote ${final.length} candidate skills to ${out} (from ${allCandidates.length} timestamp-level matches)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
