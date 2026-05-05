import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';

describe('bench task fixture sanity', () => {
  it('every task file is valid JSON with required fields', async () => {
    const taskFiles = (await readdir('bench/tasks')).filter((f) => f.endsWith('.task.json'));
    expect(taskFiles.length, 'at least 6 task files').toBeGreaterThanOrEqual(6);
    for (const f of taskFiles) {
      const t = JSON.parse(await readFile(`bench/tasks/${f}`, 'utf8'));
      expect(t.id, `${f}.id`).toBeTruthy();
      expect(t.description, `${f}.description`).toBeTruthy();
      expect(t.fixtureRoute, `${f}.fixtureRoute`).toMatch(/^\//);
      expect(t.successOracle?.type).toMatch(/^(tool_called_with|final_text_contains|no_strict_violation)$/);
      expect(t.maxIterations).toBeGreaterThanOrEqual(3);
      expect(t.budgetTokens).toBeGreaterThan(0);
    }
  });

  it('fixture-server serves all referenced bench routes', async () => {
    const { startFixtureServer } = await import('../helpers/fixture-server.js');
    const fs = await startFixtureServer();
    try {
      const taskFiles = (await readdir('bench/tasks')).filter((f) => f.endsWith('.task.json'));
      const routes = new Set<string>();
      for (const f of taskFiles) {
        const t = JSON.parse(await readFile(`bench/tasks/${f}`, 'utf8'));
        const route = (t.fixtureRoute as string).split('?')[0]!;
        routes.add(route);
      }
      for (const route of routes) {
        const r = await fetch(`http://127.0.0.1:${fs.hostPort}${route}`);
        expect(r.status, `route ${route} returns 200`).toBe(200);
        const body = await r.text();
        expect(body, `route ${route} has html`).toMatch(/<html|<body|<h1|<button|<ul|<div/i);
      }
    } finally {
      await fs.close();
    }
  });
});
