/**
 * EXPERIMENT (not a regression test): does Safari's AppleScript
 * `source of document` return on an ad-wedged page where `do JavaScript`
 * times out?
 *
 * Task 5/6 RCA showed Allrecipes recipe pages wedge Safari's WebContent
 * main thread under ad load — every JS-execution tool (safari_evaluate,
 * safari_get_text) times out. If `source of document` (which reads the
 * already-parsed HTML, server-rendered for Allrecipes incl. JSON-LD)
 * returns FAST on the same wedged page, then a raw-source extraction
 * fallback is a viable session-completable fix (AppleScript-only, no
 * extension rebuild). If `source` ALSO blocks (because it queries the
 * same wedged WebContent process), the fix must be DNR ad-blocking
 * (multi-session extension work).
 *
 * This test PRINTS timings and never fails — it's a diagnostic probe.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

const WEDGE_URL = 'https://www.allrecipes.com/recipe/21176/baked-dijon-salmon/';

function timedOsascript(label: string, script: string, timeoutMs: number): { ok: boolean; ms: number; out: string } {
  const start = Date.now();
  try {
    const out = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
      timeout: timeoutMs,
      encoding: 'utf-8',
    });
    const ms = Date.now() - start;
    console.log(`[probe] ${label}: OK in ${ms}ms, ${out.length} chars`);
    return { ok: true, ms, out };
  } catch (err) {
    const ms = Date.now() - start;
    console.log(`[probe] ${label}: FAILED/TIMEOUT after ${ms}ms — ${(err as Error).message?.slice(0, 120)}`);
    return { ok: false, ms, out: '' };
  }
}

describe('EXPERIMENT: source-of-document on ad-wedged page', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let tabUrl: string;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    const tab = await callTool(client, 'safari_new_tab', { url: WEDGE_URL }, nextId());
    tabUrl = tab.tabUrl as string;
    // Let the page load + ads start wedging the main thread.
    await new Promise((r) => setTimeout(r, 8000));
  }, 60000);

  afterAll(async () => {
    if (client && tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* noop */ }
    }
  });

  it('compares do-JavaScript vs source-of-document responsiveness on the wedged page', () => {
    // 1. do JavaScript document.title — the canonical "is the JS engine
    //    responsive" probe. Expected to be slow/timeout on a wedged page.
    const jsProbe = timedOsascript(
      'do-JavaScript(document.title)',
      `tell application "Safari" to do JavaScript "document.title" in (first tab of (first window whose name contains "Baked Dijon") )`,
      20000,
    );

    // 2. source of document — reads the parsed HTML. The KEY question:
    //    does this return fast on the wedged page?
    const sourceProbe = timedOsascript(
      'source-of-document',
      `tell application "Safari" to get source of (first tab of (first window whose name contains "Baked Dijon"))`,
      20000,
    );

    console.log('\n[probe] === VERDICT ===');
    console.log(`[probe] do-JavaScript: ok=${jsProbe.ok} ms=${jsProbe.ms}`);
    console.log(`[probe] source:        ok=${sourceProbe.ok} ms=${sourceProbe.ms} len=${sourceProbe.out.length}`);
    if (sourceProbe.ok && sourceProbe.out.length > 5000) {
      // Does the source contain the recipe data we'd need?
      const hasRating = /4\.\d|rating|ratingValue/i.test(sourceProbe.out);
      const hasJsonLd = /application\/ld\+json/i.test(sourceProbe.out);
      console.log(`[probe] source has rating-ish text: ${hasRating}`);
      console.log(`[probe] source has JSON-LD: ${hasJsonLd}`);
      console.log('[probe] CONCLUSION: raw-source fallback is VIABLE — source returns with recipe data even when JS may be wedged.');
    } else if (!sourceProbe.ok) {
      console.log('[probe] CONCLUSION: source ALSO blocks — raw-source fallback is NOT viable; DNR ad-blocking required.');
    }

    // Diagnostic only — never fails.
    expect(true).toBe(true);
  }, 60000);
});
