import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FixtureServer } from '../../../src/benchmark/fixture-server.js';

const TMP_FIXTURES = join(import.meta.dirname, '../../../.test-fixtures');

beforeAll(() => {
  mkdirSync(TMP_FIXTURES, { recursive: true });
  writeFileSync(join(TMP_FIXTURES, 'test.html'), '<html><body><h1>Test Page</h1></body></html>');
  mkdirSync(join(TMP_FIXTURES, 'forms'), { recursive: true });
  writeFileSync(join(TMP_FIXTURES, 'forms/login.html'), '<html><body><form><input name="user"></form></body></html>');
});

afterAll(() => rmSync(TMP_FIXTURES, { recursive: true, force: true }));

describe('FixtureServer', () => {
  let server: FixtureServer;

  afterAll(async () => {
    if (server) await server.stop();
  });

  it('starts on specified port', async () => {
    server = new FixtureServer(TMP_FIXTURES, 0);
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
  });

  it('serves HTML files', async () => {
    const port = server.getPort();
    const res = await fetch(`http://localhost:${port}/test.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h1>Test Page</h1>');
  });

  it('serves files from subdirectories', async () => {
    const port = server.getPort();
    const res = await fetch(`http://localhost:${port}/forms/login.html`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="user"');
  });

  it('returns 404 for missing files', async () => {
    const port = server.getPort();
    const res = await fetch(`http://localhost:${port}/nope.html`);
    expect(res.status).toBe(404);
  });

  it('sets correct content-type', async () => {
    const port = server.getPort();
    const res = await fetch(`http://localhost:${port}/test.html`);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('stops cleanly', async () => {
    await server.stop();
    await expect(fetch(`http://localhost:${server.getPort()}/test.html`)).rejects.toThrow();
  });
});
