/**
 * Phase 5 — Async-aware storage (IndexedDB) tools
 *
 * Proves the IDB tools return real data via the extension engine after T6:
 * - content-main.js awaits Promise-returning injected scripts
 * - IDB tools declare `requiresAsyncJs` so engine-selector forces extension routing
 *
 * Pre-T6: the IDB handlers' `return new Promise(...)` was never awaited.
 * Result serialized as `{}` / `"[object Promise]"`. The handlers fell through
 * to the `{databases: [], count: 0}` fallback and looked "successful" even
 * though they returned nothing.
 *
 * This test discriminates: it SEEDS a database, then lists — the seeded name
 * must come back. Pre-T6 the list is empty regardless of what exists.
 *
 * Uses the shared MCP client (see test/helpers/shared-client.ts) — one
 * server spawn per test run, tab-level isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

const TEST_DB = 'sp_t6_test_db';
const TEST_STORE = 'items';

describe('Phase 5: Async storage (IndexedDB) — T6', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let tabUrl: string;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;

    // Open a tab on a real origin — about:blank has IDB quirks.
    const unique = `https://example.com/?sp_p5=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: unique }, nextId());
    tabUrl = tab.tabUrl as string;
    // Wait for the extension content script to inject.
    await new Promise((r) => setTimeout(r, 3000));
  }, 30000);

  afterAll(async () => {
    if (client && tabUrl) {
      // Best-effort cleanup using fire-and-forget (same pattern as seeding):
      // the deleteDatabase call fires asynchronously; we don't need to await
      // its completion because the next test run will recreate the DB anyway.
      try {
        await callTool(
          client, 'safari_evaluate',
          { tabUrl, script: `indexedDB.deleteDatabase('${TEST_DB}'); return { deleteIssued: true };` },
          nextId(), 5000,
        );
      } catch { /* ignore */ }
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* ignore */ }
    }
  });

  it('T6: safari_idb_list returns the seeded database via the extension engine', async () => {
    // Seed via fire-and-forget: the injected script returns SYNCHRONOUSLY but
    // schedules async IDB work. The DB creation + transaction fire in the
    // page's event loop independently of the tool return path. This avoids a
    // separate bug in safari_evaluate's handler wrapping where a user script
    // that `return new Promise(...)` ends up postMessaging the unresolved
    // Promise object and hitting the structured-clone error. That bug is NOT
    // part of T6's scope — T6 is specifically about the IDB tools' own
    // Promise-returning handlers being awaited inside content-main.js, which
    // the safari_idb_list assertion below proves.
    await callTool(
      client, 'safari_evaluate',
      {
        tabUrl,
        script: `
          var req = indexedDB.open('${TEST_DB}', 1);
          req.onupgradeneeded = function(e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains('${TEST_STORE}')) {
              db.createObjectStore('${TEST_STORE}', { keyPath: 'id' });
            }
          };
          req.onsuccess = function(e) {
            var db = e.target.result;
            var tx = db.transaction(['${TEST_STORE}'], 'readwrite');
            var store = tx.objectStore('${TEST_STORE}');
            store.put({ id: 1, name: 'alpha' });
            store.put({ id: 2, name: 'beta' });
            tx.oncomplete = function() { db.close(); };
          };
          return { started: true };
        `,
      },
      nextId(),
      10000,
    );
    // Wait for the async IDB transaction to complete in the page event loop.
    await new Promise((r) => setTimeout(r, 2000));

    // safari_idb_list — pre-T6 this would have hit the same "Promise returned
    // to a non-awaiting wrapper" issue, AND safari_idb_list itself uses
    // `return new Promise(...)` so it needed the extension to await the
    // injected fn. Post-T6 (content-main.js `await fn()` + `requiresAsyncJs`
    // in tool def), this returns the real database list.
    const listRaw = await rawCallTool(
      client, 'safari_idb_list',
      { tabUrl },
      nextId(),
      10000,
    );
    // Engine assertion: requiresAsyncJs forces extension routing. If the
    // selector or caps are wrong, we'll see 'applescript' or 'daemon' here.
    expect(listRaw.meta?.['engine'], 'safari_idb_list must route through the extension engine').toBe('extension');

    const dbs = listRaw.payload['databases'] as Array<{ name: string; version: number }>;
    expect(Array.isArray(dbs), 'databases must be an array').toBe(true);
    const names = dbs.map((d) => d.name);
    expect(names, 'seeded database must appear in the list').toContain(TEST_DB);
  }, 30000);

  it('T6: safari_idb_get returns seeded records via the extension engine', async () => {
    // Depends on the previous test seeding the database. Uses the existing DB.
    const getRaw = await rawCallTool(
      client, 'safari_idb_get',
      { tabUrl, database: TEST_DB, store: TEST_STORE },
      nextId(),
      10000,
    );
    expect(getRaw.meta?.['engine']).toBe('extension');

    // The payload shape depends on the handler — at minimum records are present
    // and our two seeded rows show up.
    const payloadStr = JSON.stringify(getRaw.payload);
    expect(payloadStr).toContain('alpha');
    expect(payloadStr).toContain('beta');
  }, 30000);
});
