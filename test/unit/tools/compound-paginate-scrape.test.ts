/**
 * T19 — `safari_paginate_scrape` must NOT silently continue with a stale
 * URL after navigation. Pre-T19, after clicking "next", the loop queried
 * the new page's URL via `executeJsInTab(currentUrl, 'return location.href')`
 * — but `currentUrl` was the OLD URL, so the tab lookup failed silently.
 * The result was either an empty string (because of `urlRes.value ?? currentUrl`
 * not catching empty-string fallback) or a stale URL, and all subsequent
 * pages either silently failed or scraped the old page repeatedly. The
 * audit's central word is **silent**.
 *
 * Audit finding: docs/AUDIT-TASKS.md T19 (P1, H17 — tool-modules audit).
 * Origin: `35e3c58` (2026-04-12). CompoundTools receives raw `engine` not
 * `proxy` — no positional identity.
 *
 * Lean fix path (per advisor): make the failure LOUD instead of silent.
 * On post-navigation URL-query failure, break the loop, surface a warning,
 * and set `metadata.degraded: true`. Proper positional-identity threading
 * is a follow-up.
 */
import { describe, it, expect } from 'vitest';
import { CompoundTools } from '../../../src/tools/compound.js';
import type { AppleScriptEngine } from '../../../src/engines/applescript.js';
import type { EngineResult } from '../../../src/types.js';

/**
 * Sequenced fake engine. Returns the next pre-canned response on each
 * `executeJsInTab` call. Index increments per call. Throws if the test
 * runs out of pre-canned responses (catches infinite-loop regressions).
 */
function makeSequencedEngine(responses: EngineResult[]): AppleScriptEngine {
  let i = 0;
  const calls: Array<{ tabUrl: string; jsCode: string }> = [];
  return {
    name: 'applescript',
    executeJsInTab: async (tabUrl: string, jsCode: string) => {
      calls.push({ tabUrl, jsCode });
      if (i >= responses.length) {
        throw new Error(
          `Sequenced engine exhausted at call ${i + 1}: tabUrl=${tabUrl} jsCode=${jsCode.slice(0, 60)}`,
        );
      }
      return responses[i++];
    },
    // The handler exercised here only touches executeJsInTab; the rest
    // of the AppleScriptEngine surface is irrelevant to T19.
    getCalls: () => calls,
  } as unknown as AppleScriptEngine;
}

describe('safari_paginate_scrape — T19 stale-URL detection', () => {
  it('breaks the pagination loop and surfaces a warning + degraded=true when the post-click URL query returns an empty string', async () => {
    // Sequence on page 1:
    //   1. extract           → ok=true, value='{"title":"P1"}'
    //   2. hasNext            → ok=true, value='found'
    //   3. clickNext          → ok=true, value='clicked'
    //   4. location.href query → ok=true, value=''   ← post-navigation lookup
    //                                                   silently fails because
    //                                                   the OLD URL no longer
    //                                                   matches any tab.
    //
    // Pre-T19: loop continued with currentUrl='', subsequent extract
    // calls hit `executeJsInTab('', ...)` and silently returned garbage.
    //
    // Post-T19: loop breaks at step 4, result has exactly 1 page, the
    // metadata.degraded flag flips to true, and a warning is surfaced.
    const engine = makeSequencedEngine([
      { ok: true, value: '{"title":"P1"}', elapsed_ms: 10 },
      { ok: true, value: 'found', elapsed_ms: 5 },
      { ok: true, value: 'clicked', elapsed_ms: 5 },
      { ok: true, value: '', elapsed_ms: 5 }, // post-nav URL query — empty (the bug)
    ]);

    const tools = new CompoundTools(engine);
    const handler = tools.getHandler('safari_paginate_scrape');
    if (!handler) throw new Error('safari_paginate_scrape handler must exist');

    const response = await handler({
      tabUrl: 'https://example.com/page1',
      extractScript: 'return JSON.stringify({title: document.title})',
      nextSelector: 'a.next',
      maxPages: 5,
    });

    const data = JSON.parse(response.content[0].text);

    expect(data.pages.length, 'must scrape exactly 1 page before bailing').toBe(1);
    expect(data.pages[0].pageNum).toBe(1);
    expect(data.totalPages).toBe(1);

    // Loud failure surface: degraded flag + warning text.
    expect(response.metadata.degraded, 'metadata.degraded must flip true on stale-URL bail').toBe(true);
    expect(data.warnings, 'warnings array must be populated with the stale-URL message').toBeDefined();
    expect(data.warnings.length).toBeGreaterThan(0);
    expect(data.warnings[0]).toMatch(/url|stale|navigation|page\s*2/i);
  });

  it('breaks the pagination loop when the post-click URL query returns ok=false', async () => {
    // Sequence: same as above, but step 4 returns ok=false (the engine
    // failed to find the tab at all, instead of returning an empty value).
    const engine = makeSequencedEngine([
      { ok: true, value: '{"title":"P1"}', elapsed_ms: 10 },
      { ok: true, value: 'found', elapsed_ms: 5 },
      { ok: true, value: 'clicked', elapsed_ms: 5 },
      { ok: false, error: { code: 'TAB_URL_NOT_RECOGNIZED', message: 'no such tab', retryable: false }, elapsed_ms: 5 },
    ]);

    const tools = new CompoundTools(engine);
    const handler = tools.getHandler('safari_paginate_scrape');
    if (!handler) throw new Error('safari_paginate_scrape handler must exist');

    const response = await handler({
      tabUrl: 'https://example.com/page1',
      extractScript: 'return JSON.stringify({title: document.title})',
      nextSelector: 'a.next',
      maxPages: 5,
    });

    const data = JSON.parse(response.content[0].text);

    expect(data.pages.length).toBe(1);
    expect(response.metadata.degraded).toBe(true);
    expect(data.warnings).toBeDefined();
    expect(data.warnings.length).toBeGreaterThan(0);
  });

  it('completes pagination without warnings when post-click URL queries succeed', async () => {
    // Regression check: the existing happy-path must continue to work.
    // Two pages, no stale-URL fault. Sequence:
    //   1. extract page 1     → ok=true, value='{"p":1}'
    //   2. hasNext page 1     → ok=true, value='found'
    //   3. clickNext page 1   → ok=true, value='clicked'
    //   4. location.href      → ok=true, value='https://example.com/page2'   ← real URL
    //   5. extract page 2     → ok=true, value='{"p":2}'
    //   6. hasNext page 2     → ok=true, value='not found'   ← end of pagination
    const engine = makeSequencedEngine([
      { ok: true, value: '{"p":1}', elapsed_ms: 10 },
      { ok: true, value: 'found', elapsed_ms: 5 },
      { ok: true, value: 'clicked', elapsed_ms: 5 },
      { ok: true, value: 'https://example.com/page2', elapsed_ms: 5 },
      { ok: true, value: '{"p":2}', elapsed_ms: 10 },
      { ok: true, value: 'not found', elapsed_ms: 5 },
    ]);

    const tools = new CompoundTools(engine);
    const handler = tools.getHandler('safari_paginate_scrape');
    if (!handler) throw new Error('safari_paginate_scrape handler must exist');

    const response = await handler({
      tabUrl: 'https://example.com/page1',
      extractScript: 'return JSON.stringify({p: 1})',
      nextSelector: 'a.next',
      maxPages: 5,
    });

    const data = JSON.parse(response.content[0].text);

    expect(data.pages.length).toBe(2);
    expect(data.pages[1].url, 'page 2 url must be the post-navigation URL').toBe('https://example.com/page2');
    expect(response.metadata.degraded).toBe(false);
    // warnings is optional and must be absent or empty on the happy path.
    expect(data.warnings === undefined || data.warnings.length === 0).toBe(true);
  });
});
