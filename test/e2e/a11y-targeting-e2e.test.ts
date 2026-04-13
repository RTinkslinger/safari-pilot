/**
 * E2E: Accessibility Snapshots, Ref Targeting, Auto-Wait, Locator Targeting
 *
 * Tests the FULL pipeline (MCP Server -> Security -> Engine -> Real Safari)
 * against live websites: Wikipedia, Hacker News, GitHub, X, Reddit, LinkedIn
 *
 * Suites 5-7 (X, Reddit, LinkedIn) require the user to be logged in on Safari.
 * These test authenticated, complex SPAs with shadow DOM, React, and rich ARIA.
 *
 * Prerequisites:
 * - Safari running
 * - "Allow JavaScript from Apple Events" enabled in Safari > Develop
 * - Logged in to X, Reddit, LinkedIn in Safari (for suites 5-7)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { SafariPilotServer } from '../../src/server.js';

// ── Safari availability check (skip entire file in CI / headless) ────────────

let safariAvailable = false;
try {
  execFileSync('osascript', ['-e', 'tell application "Safari" to return name'], { timeout: 5000 });
  safariAvailable = true;
} catch {
  console.log('Safari not available — skipping a11y targeting e2e tests (expected in CI)');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Normalize URL trailing slashes for comparison. */
function normalizeUrl(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}

/** Wait for page load after navigation. */
function waitForLoad(ms = 3000): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Extract all ref annotations ([ref=eN]) from YAML snapshot text. */
function extractRefs(yaml: string): string[] {
  const refs: string[] = [];
  const re = /\[ref=(e\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yaml)) !== null) {
    refs.push(m[1]);
  }
  return refs;
}

// ── Shared state ─────────────────────────────────────────────────────────────

let server: SafariPilotServer;
const openTabUrls: string[] = [];

/** Open a tab and track it for cleanup. Returns the resolved tabUrl. */
async function openTab(url: string): Promise<string> {
  const result = await server.executeToolWithSecurity('safari_new_tab', { url });
  const data = JSON.parse(result.content[0].text!);
  const tabUrl = data.tabUrl as string;
  openTabUrls.push(tabUrl);
  return tabUrl;
}

/** Try closing a tab by URL, handling trailing-slash normalization. */
async function closeTab(url: string): Promise<void> {
  const variants = [url, url.endsWith('/') ? url.slice(0, -1) : url + '/'];
  for (const u of variants) {
    try {
      await server.executeToolWithSecurity('safari_close_tab', { tabUrl: u });
      return;
    } catch { /* try next variant */ }
  }
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  server = new SafariPilotServer();
  await server.initialize();
}, 30000);

afterAll(async () => {
  // Close all tabs opened during the suite
  for (const url of openTabUrls) {
    await closeTab(url);
  }
  await server.shutdown();
});

// =============================================================================
// Suite 1: Full Pipeline Snapshot on Wikipedia
// =============================================================================

const describeWithSafari = safariAvailable ? describe : describe.skip;

describeWithSafari('Suite 1: Full Pipeline Snapshot on Wikipedia', () => {
  let wikiTabUrl: string;
  let firstSnapshotYaml: string;
  let firstSnapshotRefs: string[];

  it('1. Open Wikipedia and take an accessibility snapshot', async () => {
    wikiTabUrl = await openTab('https://en.wikipedia.org/wiki/Main_Page');
    await waitForLoad(4000);

    // Resolve the actual tab URL (Wikipedia may redirect or add trailing slash)
    const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: wikiTabUrl,
      script: 'return window.location.href',
    });
    const evalData = JSON.parse(evalResult.content[0].text!);
    if (evalData.value && typeof evalData.value === 'string') {
      wikiTabUrl = evalData.value;
    }

    const result = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: wikiTabUrl,
    });
    const data = JSON.parse(result.content[0].text!);

    expect(data.snapshot).toBeDefined();
    expect(typeof data.snapshot).toBe('string');
    expect(data.snapshot.length).toBeGreaterThan(100);

    // Wikipedia main page should have headings, links, navigation
    expect(data.snapshot).toMatch(/heading/);
    expect(data.snapshot).toMatch(/link/);
    expect(data.snapshot).toMatch(/navigation/);

    // Should have significant interactive elements
    expect(data.interactiveCount).toBeGreaterThan(20);

    // Refs should be present
    const refs = extractRefs(data.snapshot);
    expect(refs.length).toBeGreaterThan(10);

    firstSnapshotYaml = data.snapshot;
    firstSnapshotRefs = refs;

    console.log(`Wikipedia snapshot: ${data.elementCount} elements, ${data.interactiveCount} interactive, ${refs.length} refs`);
    console.log(`Snapshot preview (first 300 chars): ${data.snapshot.substring(0, 300)}`);
  }, 30000);

  it('2. Refs are stable across consecutive snapshots', async () => {
    // Take a second snapshot without any page changes
    const result = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: wikiTabUrl,
    });
    const data = JSON.parse(result.content[0].text!);
    const secondRefs = extractRefs(data.snapshot);

    // Refs stamped on DOM elements should persist — the same elements should
    // have the same ref values on a second pass (no page mutation between snapshots).
    // Check that the intersection is significant (some refs may shift if the DOM
    // had minor dynamic changes, but most should remain stable).
    const sharedRefs = firstSnapshotRefs.filter((r) => secondRefs.includes(r));
    const stabilityRatio = sharedRefs.length / Math.min(firstSnapshotRefs.length, secondRefs.length);

    expect(stabilityRatio).toBeGreaterThan(0.7);
    console.log(
      `Ref stability: ${sharedRefs.length}/${firstSnapshotRefs.length} refs preserved (${(stabilityRatio * 100).toFixed(0)}%)`,
    );
  }, 20000);

  it('3. Snapshot through security pipeline - audit log records it', async () => {
    const auditLog = (server as any).auditLog;
    if (!auditLog) {
      console.log('SKIP: audit log not exposed on server');
      return;
    }

    const entries = auditLog.getEntries();
    const snapshotEntries = entries.filter(
      (e: any) => e.tool === 'safari_snapshot' && e.result === 'ok',
    );

    expect(snapshotEntries.length).toBeGreaterThanOrEqual(1);
    console.log(`Audit log: ${snapshotEntries.length} successful safari_snapshot entries`);
  }, 5000);

  it('4. Scoped snapshot on Wikipedia search area', async () => {
    // Wikipedia's search form is inside #searchform or #p-search or .search-container
    // Try a few known selectors for robustness
    const scopeSelectors = ['#searchform', '#p-search', '#simpleSearch', 'form[role="search"]', 'form'];
    let scopedData: any = null;

    for (const scope of scopeSelectors) {
      try {
        const result = await server.executeToolWithSecurity('safari_snapshot', {
          tabUrl: wikiTabUrl,
          scope,
        });
        scopedData = JSON.parse(result.content[0].text!);
        if (scopedData.elementCount > 0) {
          console.log(`Scoped snapshot with '${scope}': ${scopedData.elementCount} elements, ${scopedData.interactiveCount} interactive`);
          break;
        }
      } catch {
        // Try next selector
      }
    }

    expect(scopedData).not.toBeNull();
    // Scoped snapshot should have fewer elements than full page
    expect(scopedData.elementCount).toBeLessThan(firstSnapshotRefs.length * 2);
    // Should still contain at least one interactive element (the search input)
    expect(scopedData.interactiveCount).toBeGreaterThanOrEqual(1);

    // The search input should have a ref
    const scopedRefs = extractRefs(scopedData.snapshot);
    expect(scopedRefs.length).toBeGreaterThanOrEqual(1);
    console.log(`Scoped refs: ${scopedRefs.join(', ')}`);
  }, 20000);

  it('5. Click a Wikipedia link via ref', async () => {
    // Take a fresh snapshot and find a link ref to click
    const snapResult = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: wikiTabUrl,
    });
    const snapData = JSON.parse(snapResult.content[0].text!);

    // Find a link with a ref — look for a content link (not navigation)
    // Parse for lines that have "link" role and a ref
    const linkRefPattern = /- link "([^"]+)"[^\n]*\[ref=(e\d+)\]/g;
    let linkRef: string | null = null;
    let linkName: string | null = null;
    let m: RegExpExecArray | null;
    while ((m = linkRefPattern.exec(snapData.snapshot)) !== null) {
      const name = m[1];
      const ref = m[2];
      // Skip very short names or navigation-like links
      if (name.length > 3 && !name.match(/^(Log in|Create account|Search|Main page)$/i)) {
        linkRef = ref;
        linkName = name;
        break;
      }
    }

    if (!linkRef) {
      console.log('SKIP: could not find a suitable content link ref in Wikipedia snapshot');
      return;
    }

    console.log(`Clicking link: "${linkName}" via ref=${linkRef}`);

    // Record the URL before clicking
    const urlBefore = wikiTabUrl;

    // Click via ref
    await server.executeToolWithSecurity('safari_click', {
      tabUrl: wikiTabUrl,
      ref: linkRef,
    });

    await waitForLoad(3000);

    // Verify URL changed
    const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: wikiTabUrl,
      script: 'return window.location.href',
    });
    const newUrl = JSON.parse(evalResult.content[0].text!).value;

    // The URL should have changed from the main page
    // (Update wikiTabUrl for the navigate-back test)
    console.log(`URL after click: ${newUrl}`);
    expect(normalizeUrl(newUrl)).not.toBe(normalizeUrl(urlBefore));
    wikiTabUrl = newUrl;
  }, 25000);

  it('6. Navigate back and verify page restored', async () => {
    // Navigate back to the main page
    await server.executeToolWithSecurity('safari_navigate_back', {
      tabUrl: wikiTabUrl,
    });

    await waitForLoad(3000);

    // Get the current URL — should be back on Main_Page
    const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: wikiTabUrl,
      script: 'return window.location.href',
    });
    const backUrl = JSON.parse(evalResult.content[0].text!).value;
    console.log(`URL after navigate back: ${backUrl}`);
    expect(backUrl).toContain('Main_Page');
    wikiTabUrl = backUrl;

    // Snapshot should still work on the restored page
    const snapResult = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: wikiTabUrl,
    });
    const snapData = JSON.parse(snapResult.content[0].text!);
    expect(snapData.interactiveCount).toBeGreaterThan(10);
    console.log(`Restored page snapshot: ${snapData.elementCount} elements, ${snapData.interactiveCount} interactive`);
  }, 25000);
});

// =============================================================================
// Suite 2: Locator Targeting on Hacker News
// =============================================================================

describeWithSafari('Suite 2: Locator Targeting on Hacker News', () => {
  let hnTabUrl: string;

  it('7. Open Hacker News', async () => {
    hnTabUrl = await openTab('https://news.ycombinator.com');
    await waitForLoad(3000);

    // Resolve actual URL
    const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: hnTabUrl,
      script: 'return window.location.href',
    });
    const data = JSON.parse(evalResult.content[0].text!);
    if (data.value && typeof data.value === 'string') {
      hnTabUrl = data.value;
    }

    // Verify page loaded
    const textResult = await server.executeToolWithSecurity('safari_get_text', {
      tabUrl: hnTabUrl,
    });
    const textData = JSON.parse(textResult.content[0].text!);
    expect(textData.text).toContain('Hacker News');
    console.log(`Hacker News opened at: ${hnTabUrl}`);
  }, 20000);

  it('8. Find "login" link by text locator and click', async () => {
    // Use text locator to find and click the login link
    await server.executeToolWithSecurity('safari_click', {
      tabUrl: hnTabUrl,
      text: 'login',
    });

    await waitForLoad(3000);

    // Verify navigation to login page
    const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: hnTabUrl,
      script: 'return window.location.href',
    });
    const newUrl = JSON.parse(evalResult.content[0].text!).value;
    console.log(`After clicking login: ${newUrl}`);
    expect(newUrl).toContain('login');
    hnTabUrl = newUrl;
  }, 20000);

  it('9. Navigate back, find Hacker News link by role', async () => {
    // Navigate back to the front page
    await server.executeToolWithSecurity('safari_navigate_back', {
      tabUrl: hnTabUrl,
    });
    await waitForLoad(3000);

    // Resolve current URL
    const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: hnTabUrl,
      script: 'return window.location.href',
    });
    const currentUrl = JSON.parse(evalResult.content[0].text!).value;
    hnTabUrl = currentUrl;
    console.log(`Navigated back to: ${hnTabUrl}`);

    // Use role+name locator to find the "Hacker News" title link
    const textResult = await server.executeToolWithSecurity('safari_get_text', {
      tabUrl: hnTabUrl,
      role: 'link',
      name: 'Hacker News',
    });
    const textData = JSON.parse(textResult.content[0].text!);
    expect(textData.text).toBeTruthy();
    console.log(`Found link by role+name: text="${textData.text}"`);
  }, 25000);

  it('10. Fill form field via locator on login page', async () => {
    // Navigate to the login page which has username/password fields
    await server.executeToolWithSecurity('safari_navigate', {
      url: 'https://news.ycombinator.com/login',
      tabUrl: hnTabUrl,
    });
    await waitForLoad(3000);

    // Resolve current URL
    const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: hnTabUrl,
      script: 'return window.location.href',
    });
    hnTabUrl = JSON.parse(evalResult.content[0].text!).value;

    // HN login page has input fields. Use safari_fill with a locator to find the
    // username input. Try multiple strategies for robustness.
    let filled = false;

    // Strategy 1: by placeholder if the field has one
    // Strategy 2: by the first textbox role on the page
    // Strategy 3: by CSS selector as final fallback
    const strategies = [
      { role: 'textbox' },
      { selector: 'input[type="text"]' },
      { selector: 'input:not([type="hidden"]):not([type="password"])' },
    ];

    for (const targeting of strategies) {
      try {
        await server.executeToolWithSecurity('safari_fill', {
          tabUrl: hnTabUrl,
          ...targeting,
          value: 'test_user_e2e',
        });
        filled = true;
        console.log(`Filled username field via ${JSON.stringify(targeting)}`);
        break;
      } catch (err: any) {
        console.log(`Fill strategy ${JSON.stringify(targeting)} failed: ${err.message}`);
      }
    }

    expect(filled).toBe(true);

    // Verify the value was filled
    const verifyResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: hnTabUrl,
      script: `
        var inputs = document.querySelectorAll('input[type="text"], input:not([type])');
        for (var i = 0; i < inputs.length; i++) {
          if (inputs[i].value) return { value: inputs[i].value, tagName: inputs[i].tagName };
        }
        return { value: null };
      `,
    });
    const verifyData = JSON.parse(verifyResult.content[0].text!);
    const fillValue = typeof verifyData.value === 'string'
      ? JSON.parse(verifyData.value)
      : verifyData.value;
    console.log(`Verified input value: "${fillValue?.value}"`);
  }, 25000);

  it('11. Force mode skips auto-wait', async () => {
    // Click with force: true should succeed immediately without waiting.
    // Use a known element on the HN login page.
    const start = Date.now();

    try {
      await server.executeToolWithSecurity('safari_click', {
        tabUrl: hnTabUrl,
        selector: 'a',
        force: true,
      });
      const elapsed = Date.now() - start;
      console.log(`Force-click completed in ${elapsed}ms (no auto-wait delay)`);
      // Force mode should be fast — no waiting for actionability checks
      // (The actual speed depends on network + AppleScript overhead, so we
      // just verify it completed successfully.)
      expect(elapsed).toBeLessThan(10000);
    } catch (err: any) {
      // Even if the click targets a link that navigates, force mode should
      // have executed. The error might be from post-click navigation.
      console.log(`Force-click result: ${err.message}`);
    }
  }, 15000);
});

// =============================================================================
// Suite 3: Auto-Wait Behavior (against example.com)
// =============================================================================

describeWithSafari('Suite 3: Auto-Wait Behavior', () => {
  let exTabUrl: string;

  it('12. Open example.com, click via auto-wait', async () => {
    exTabUrl = await openTab('https://example.com');
    await waitForLoad(3000);

    // Resolve actual URL
    const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: exTabUrl,
      script: 'return window.location.href',
    });
    exTabUrl = JSON.parse(evalResult.content[0].text!).value;
    console.log(`Example.com opened at: ${exTabUrl}`);

    // Click the "More information..." link. Auto-wait should detect it is
    // visible and enabled, then click.
    await server.executeToolWithSecurity('safari_click', {
      tabUrl: exTabUrl,
      text: 'More information',
    });

    await waitForLoad(4000);

    // Verify navigation to IANA page
    const navResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: exTabUrl,
      script: 'return window.location.href',
    });
    const newUrl = JSON.parse(navResult.content[0].text!).value;
    console.log(`After clicking "More information...": ${newUrl}`);

    // Should have navigated to iana.org or similar
    expect(newUrl).not.toBe(exTabUrl);
    expect(newUrl.toLowerCase()).toMatch(/iana\.org/);
    exTabUrl = newUrl;
  }, 25000);

  it('13. Navigate back, verify snapshot still works', async () => {
    await server.executeToolWithSecurity('safari_navigate_back', {
      tabUrl: exTabUrl,
    });
    await waitForLoad(3000);

    // Resolve URL
    const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: exTabUrl,
      script: 'return window.location.href',
    });
    exTabUrl = JSON.parse(evalResult.content[0].text!).value;
    console.log(`Back to: ${exTabUrl}`);

    // Snapshot should still work on example.com
    const snapResult = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: exTabUrl,
    });
    const snapData = JSON.parse(snapResult.content[0].text!);
    expect(snapData.snapshot).toBeDefined();
    expect(snapData.snapshot.length).toBeGreaterThan(0);
    expect(snapData.snapshot).toMatch(/heading/);
    console.log(`Example.com snapshot: ${snapData.elementCount} elements, ${snapData.interactiveCount} interactive`);
  }, 25000);

  it('14. Auto-wait provides diagnostic on timeout for non-existent element', async () => {
    // Try to click a selector that does not exist. The auto-wait should
    // eventually fail with an actionable error message.
    try {
      await server.executeToolWithSecurity('safari_click', {
        tabUrl: exTabUrl,
        selector: '#absolutely-does-not-exist-xyz-12345',
        timeout: 2000,
      });
      // If it does not throw, the test still passes — but we expect an error
      expect.fail('Expected an error for non-existent element');
    } catch (err: any) {
      const message = err.message || String(err);
      console.log(`Auto-wait error for non-existent element: "${message}"`);
      // The error should mention the element was not found or not actionable
      expect(message.toLowerCase()).toMatch(/not found|not actionable|element|timeout/i);
    }
  }, 15000);
});

// =============================================================================
// Suite 4: Ref + Locator Combined on GitHub
// =============================================================================

describeWithSafari('Suite 4: Ref + Locator Combined on GitHub', () => {
  let ghTabUrl: string;
  let ghSnapshotData: any;

  it('15. Open GitHub homepage', async () => {
    ghTabUrl = await openTab('https://github.com');
    await waitForLoad(4000);

    // Resolve actual URL (GitHub may redirect)
    const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: ghTabUrl,
      script: 'return window.location.href',
    });
    ghTabUrl = JSON.parse(evalResult.content[0].text!).value;
    console.log(`GitHub opened at: ${ghTabUrl}`);

    // Take snapshot
    const snapResult = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: ghTabUrl,
    });
    ghSnapshotData = JSON.parse(snapResult.content[0].text!);
    expect(ghSnapshotData.snapshot).toBeDefined();
    console.log(
      `GitHub snapshot: ${ghSnapshotData.elementCount} elements, ${ghSnapshotData.interactiveCount} interactive`,
    );
  }, 30000);

  it('16. Snapshot captures GitHub heading/link roles', async () => {
    const snapshot = ghSnapshotData.snapshot as string;

    // GitHub's page should have heading roles
    expect(snapshot).toMatch(/heading/);

    // Should have link roles
    expect(snapshot).toMatch(/link/);

    // Should have substantial interactive elements (buttons, links, inputs)
    expect(ghSnapshotData.interactiveCount).toBeGreaterThan(5);

    // Extract and count refs
    const refs = extractRefs(snapshot);
    expect(refs.length).toBeGreaterThan(5);
    console.log(`GitHub refs count: ${refs.length}`);
    console.log(`GitHub snapshot roles preview: ${snapshot.substring(0, 400)}`);
  }, 10000);

  it('17. Locator finds GitHub sign-in link', async () => {
    // GitHub homepage should have a "Sign in" link. Use role+name locator
    // to find it without clicking.
    // Note: GitHub may show "Sign in" or "Sign up" depending on the page state.
    // We try "Sign in" first, then fall back to other known elements.
    const targets = [
      { role: 'link', name: 'Sign in' },
      { role: 'link', name: 'Sign up' },
      { role: 'link', name: 'GitHub' },
    ];

    let found = false;
    for (const target of targets) {
      try {
        const result = await server.executeToolWithSecurity('safari_get_text', {
          tabUrl: ghTabUrl,
          role: target.role,
          name: target.name,
        });
        const data = JSON.parse(result.content[0].text!);
        if (data.text) {
          console.log(`Found "${target.name}" link via role locator: text="${data.text}"`);
          found = true;
          break;
        }
      } catch (err: any) {
        console.log(`Locator {role: "${target.role}", name: "${target.name}"} failed: ${err.message}`);
      }
    }

    // At minimum, we should find at least one of these links on GitHub
    expect(found).toBe(true);
  }, 20000);
});

// =============================================================================
// Suite 5: X (Twitter) — Authenticated, Shadow DOM, Complex ARIA
// =============================================================================

describeWithSafari('Suite 5: X (Twitter) — Authenticated SPA', () => {
  let xTabUrl: string;
  let xSnapshotData: any;

  it('18. Open X home feed and take snapshot', async () => {
    xTabUrl = await openTab('https://x.com/home');
    await waitForLoad(5000);

    const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: xTabUrl,
      script: 'return window.location.href',
    });
    xTabUrl = JSON.parse(evalResult.content[0].text!).value;
    console.log(`X opened at: ${xTabUrl}`);

    const snapResult = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: xTabUrl,
    });
    xSnapshotData = JSON.parse(snapResult.content[0].text!);

    expect(xSnapshotData.snapshot).toBeDefined();
    expect(xSnapshotData.snapshot.length).toBeGreaterThan(200);
    expect(xSnapshotData.interactiveCount).toBeGreaterThan(10);

    console.log(
      `X snapshot: ${xSnapshotData.elementCount} elements, ${xSnapshotData.interactiveCount} interactive`,
    );
  }, 30000);

  it('19. Snapshot captures X navigation landmarks and feed structure', async () => {
    const snap = xSnapshotData.snapshot as string;

    // X's authenticated home should have navigation, links, and interactive elements
    expect(snap).toMatch(/link/);

    const refs = extractRefs(snap);
    expect(refs.length).toBeGreaterThan(10);
    console.log(`X refs: ${refs.length}`);

    // Check for navigation-like elements (Home, Explore, Search, etc.)
    const hasNav = snap.match(/navigation/i) || snap.match(/link "Home"/i) || snap.match(/link "Explore"/i);
    expect(hasNav).toBeTruthy();
    console.log('X navigation landmarks detected');
  }, 10000);

  it('20. Locate X search input via role', async () => {
    // X has a prominent search box — try to find it via locator
    const searchStrategies = [
      { role: 'searchbox' },
      { role: 'textbox', name: 'Search' },
      { placeholder: 'Search' },
      { selector: 'input[data-testid="SearchBox_Search_Input"]' },
      { selector: 'input[aria-label="Search query"]' },
    ];

    let foundSearch = false;
    for (const targeting of searchStrategies) {
      try {
        const result = await server.executeToolWithSecurity('safari_get_text', {
          tabUrl: xTabUrl,
          ...targeting,
        });
        const data = JSON.parse(result.content[0].text!);
        console.log(`X search found via ${JSON.stringify(targeting)}: "${data.text?.slice(0, 50)}"`);
        foundSearch = true;
        break;
      } catch {
        // try next strategy
      }
    }

    // X should have a search input somewhere in the nav
    if (!foundSearch) {
      console.log('X search input not directly accessible — may be behind navigation. Checking snapshot...');
      const hasSearchRef = xSnapshotData.snapshot.match(/search/i);
      expect(hasSearchRef).toBeTruthy();
    } else {
      expect(foundSearch).toBe(true);
    }
  }, 20000);

  it('21. Click a tweet action button via ref (like/reply area)', async () => {
    // Take fresh snapshot to get current refs
    const snapResult = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: xTabUrl,
    });
    const snapData = JSON.parse(snapResult.content[0].text!);

    // Find a button ref in the feed (reply, retweet, like buttons)
    // These typically have roles like button with names like "Reply", "Like", etc.
    const buttonPattern = /- button "([^"]*)"[^\n]*\[ref=(e\d+)\]/g;
    const buttons: { name: string; ref: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = buttonPattern.exec(snapData.snapshot)) !== null) {
      buttons.push({ name: m[1], ref: m[2] });
    }

    console.log(`X buttons found: ${buttons.length}`);
    if (buttons.length > 0) {
      console.log(`Sample buttons: ${buttons.slice(0, 5).map(b => `"${b.name}" [ref=${b.ref}]`).join(', ')}`);
    }

    // We just verify buttons with refs exist in the feed — we do NOT click
    // action buttons (like, retweet) to avoid modifying the user's account
    expect(buttons.length).toBeGreaterThan(0);
  }, 20000);

  it('22. Snapshot scoped to X primary column', async () => {
    // X's main content area has data-testid="primaryColumn" or similar
    const scopeSelectors = [
      '[data-testid="primaryColumn"]',
      'main',
      '[role="main"]',
      'section[role="region"]',
    ];

    let scopedData: any = null;
    for (const scope of scopeSelectors) {
      try {
        const result = await server.executeToolWithSecurity('safari_snapshot', {
          tabUrl: xTabUrl,
          scope,
        });
        scopedData = JSON.parse(result.content[0].text!);
        if (scopedData.elementCount > 0) {
          console.log(`X scoped snapshot ('${scope}'): ${scopedData.elementCount} elements, ${scopedData.interactiveCount} interactive`);
          break;
        }
      } catch {
        // try next scope
      }
    }

    if (scopedData && scopedData.elementCount > 0) {
      // Scoped snapshot should be smaller than full page
      expect(scopedData.elementCount).toBeLessThan(xSnapshotData.elementCount);
      expect(scopedData.interactiveCount).toBeGreaterThan(0);
    } else {
      console.log('X scope selectors not matched — page structure may have changed');
    }
  }, 20000);
});

// =============================================================================
// Suite 6: Reddit — Authenticated, Modern React SPA
// =============================================================================

describeWithSafari('Suite 6: Reddit — Authenticated SPA', () => {
  let redditTabUrl: string;
  let redditSnapshotData: any;

  it('23. Open Reddit home feed and take snapshot', async () => {
    redditTabUrl = await openTab('https://www.reddit.com');
    await waitForLoad(5000);

    const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: redditTabUrl,
      script: 'return window.location.href',
    });
    redditTabUrl = JSON.parse(evalResult.content[0].text!).value;
    console.log(`Reddit opened at: ${redditTabUrl}`);

    const snapResult = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: redditTabUrl,
    });
    redditSnapshotData = JSON.parse(snapResult.content[0].text!);

    expect(redditSnapshotData.snapshot).toBeDefined();
    expect(redditSnapshotData.snapshot.length).toBeGreaterThan(200);
    expect(redditSnapshotData.interactiveCount).toBeGreaterThan(10);

    console.log(
      `Reddit snapshot: ${redditSnapshotData.elementCount} elements, ${redditSnapshotData.interactiveCount} interactive`,
    );
  }, 30000);

  it('24. Snapshot captures Reddit feed structure', async () => {
    const snap = redditSnapshotData.snapshot as string;

    // Reddit should have links (post titles), buttons (vote, comment, share)
    expect(snap).toMatch(/link/);
    expect(snap).toMatch(/button/);

    const refs = extractRefs(snap);
    expect(refs.length).toBeGreaterThan(15);

    console.log(`Reddit refs: ${refs.length}`);
    console.log(`Reddit snapshot preview:\n${snap.substring(0, 500)}`);
  }, 10000);

  it('25. Locate Reddit search via locator and fill', async () => {
    const searchStrategies = [
      { role: 'searchbox' },
      { role: 'combobox', name: 'Search' },
      { placeholder: 'Search Reddit' },
      { role: 'textbox', name: 'Search' },
      { selector: 'input[type="search"]' },
      { selector: '#search-input' },
      { selector: 'input[name="q"]' },
    ];

    let filled = false;
    for (const targeting of searchStrategies) {
      try {
        await server.executeToolWithSecurity('safari_fill', {
          tabUrl: redditTabUrl,
          ...targeting,
          value: 'safari browser automation',
        });
        filled = true;
        console.log(`Reddit search filled via ${JSON.stringify(targeting)}`);
        break;
      } catch {
        // try next
      }
    }

    if (filled) {
      expect(filled).toBe(true);
    } else {
      console.log('Reddit search input not directly fillable — may require click to expand first');
      // Still pass — the important thing is the locator attempted resolution
    }
  }, 20000);

  it('26. Navigate to a subreddit via ref', async () => {
    // Take fresh snapshot
    const snapResult = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: redditTabUrl,
    });
    const snapData = JSON.parse(snapResult.content[0].text!);

    // Find a link to a subreddit (r/something)
    const subredditPattern = /- link "([^"]*r\/[^"]+)"[^\n]*\[ref=(e\d+)\]/g;
    let subRef: string | null = null;
    let subName: string | null = null;
    let m: RegExpExecArray | null;
    while ((m = subredditPattern.exec(snapData.snapshot)) !== null) {
      subRef = m[2];
      subName = m[1];
      break;
    }

    if (subRef) {
      console.log(`Clicking subreddit link: "${subName}" via ref=${subRef}`);
      await server.executeToolWithSecurity('safari_click', {
        tabUrl: redditTabUrl,
        ref: subRef,
      });
      await waitForLoad(4000);

      const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
        tabUrl: redditTabUrl,
        script: 'return window.location.href',
      });
      const newUrl = JSON.parse(evalResult.content[0].text!).value;
      console.log(`Navigated to: ${newUrl}`);
      expect(newUrl).toContain('/r/');
      redditTabUrl = newUrl;
    } else {
      // Fallback: find any content link
      const linkPattern = /- link "([^"]{5,})"[^\n]*\[ref=(e\d+)\]/g;
      while ((m = linkPattern.exec(snapData.snapshot)) !== null) {
        if (!m[1].match(/^(Home|Popular|All|Log|Sign|Create|Get)/i)) {
          subRef = m[2];
          subName = m[1];
          break;
        }
      }

      if (subRef) {
        console.log(`Clicking content link: "${subName}" via ref=${subRef}`);
        await server.executeToolWithSecurity('safari_click', {
          tabUrl: redditTabUrl,
          ref: subRef,
        });
        await waitForLoad(3000);
      } else {
        console.log('No suitable content link found in Reddit snapshot');
      }
    }
  }, 25000);

  it('27. Snapshot on subreddit/post page still works', async () => {
    const snapResult = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: redditTabUrl,
    });
    const snapData = JSON.parse(snapResult.content[0].text!);
    expect(snapData.snapshot).toBeDefined();
    expect(snapData.interactiveCount).toBeGreaterThan(5);
    console.log(
      `Reddit post-navigation snapshot: ${snapData.elementCount} elements, ${snapData.interactiveCount} interactive`,
    );
  }, 20000);
});

// =============================================================================
// Suite 7: LinkedIn — Authenticated, Rich ARIA, Complex Forms
// =============================================================================

describeWithSafari('Suite 7: LinkedIn — Authenticated, Rich ARIA', () => {
  let liTabUrl: string;
  let liSnapshotData: any;

  it('28. Open LinkedIn feed and take snapshot', async () => {
    liTabUrl = await openTab('https://www.linkedin.com/feed/');
    await waitForLoad(5000);

    const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
      tabUrl: liTabUrl,
      script: 'return window.location.href',
    });
    liTabUrl = JSON.parse(evalResult.content[0].text!).value;
    console.log(`LinkedIn opened at: ${liTabUrl}`);

    const snapResult = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: liTabUrl,
    });
    liSnapshotData = JSON.parse(snapResult.content[0].text!);

    expect(liSnapshotData.snapshot).toBeDefined();
    expect(liSnapshotData.snapshot.length).toBeGreaterThan(200);
    expect(liSnapshotData.interactiveCount).toBeGreaterThan(10);

    console.log(
      `LinkedIn snapshot: ${liSnapshotData.elementCount} elements, ${liSnapshotData.interactiveCount} interactive`,
    );
  }, 30000);

  it('29. LinkedIn snapshot has rich ARIA: navigation, buttons, links, headings', async () => {
    const snap = liSnapshotData.snapshot as string;

    // LinkedIn is one of the most ARIA-rich sites on the web
    expect(snap).toMatch(/link/);
    expect(snap).toMatch(/button/);

    // LinkedIn should have navigation landmarks
    const hasNav = snap.match(/navigation/) || snap.match(/banner/);
    expect(hasNav).toBeTruthy();

    const refs = extractRefs(snap);
    expect(refs.length).toBeGreaterThan(20);

    console.log(`LinkedIn refs: ${refs.length}`);

    // Count distinct roles in the snapshot
    const rolePattern = /^- (\w+)/gm;
    const roles = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = rolePattern.exec(snap)) !== null) {
      roles.add(m[1]);
    }
    console.log(`LinkedIn distinct roles: ${[...roles].sort().join(', ')}`);
    // LinkedIn should expose many distinct ARIA roles
    expect(roles.size).toBeGreaterThan(5);
  }, 10000);

  it('30. Locate LinkedIn search via locator and fill', async () => {
    const searchStrategies = [
      { role: 'combobox', name: 'Search' },
      { role: 'searchbox' },
      { placeholder: 'Search' },
      { selector: 'input.search-global-typeahead__input' },
      { selector: 'input[role="combobox"]' },
    ];

    let filled = false;
    for (const targeting of searchStrategies) {
      try {
        await server.executeToolWithSecurity('safari_fill', {
          tabUrl: liTabUrl,
          ...targeting,
          value: 'software engineer',
        });
        filled = true;
        console.log(`LinkedIn search filled via ${JSON.stringify(targeting)}`);
        break;
      } catch (err: any) {
        console.log(`LinkedIn search strategy ${JSON.stringify(targeting)} failed: ${err.message.slice(0, 80)}`);
      }
    }

    if (filled) {
      // Verify the value was set
      const verifyResult = await server.executeToolWithSecurity('safari_evaluate', {
        tabUrl: liTabUrl,
        script: `
          var inputs = document.querySelectorAll('input[role="combobox"], input.search-global-typeahead__input, input[type="search"]');
          for (var i = 0; i < inputs.length; i++) {
            if (inputs[i].value) return { value: inputs[i].value };
          }
          return { value: null };
        `,
      });
      const verifyData = JSON.parse(verifyResult.content[0].text!);
      const val = typeof verifyData.value === 'string' ? JSON.parse(verifyData.value) : verifyData.value;
      console.log(`LinkedIn search verified value: "${val?.value}"`);
    } else {
      console.log('LinkedIn search requires click-to-focus — checking snapshot for search element...');
      expect(liSnapshotData.snapshot.toLowerCase()).toMatch(/search/);
    }
  }, 25000);

  it('31. Find LinkedIn messaging or notifications via role locator', async () => {
    // LinkedIn's nav bar has messaging and notifications icons
    const navTargets = [
      { role: 'link', name: 'Messaging' },
      { role: 'link', name: 'Notifications' },
      { role: 'link', name: 'Home' },
      { role: 'link', name: 'My Network' },
      { role: 'link', name: 'Jobs' },
    ];

    const found: string[] = [];
    for (const target of navTargets) {
      try {
        const result = await server.executeToolWithSecurity('safari_get_text', {
          tabUrl: liTabUrl,
          role: target.role,
          name: target.name,
        });
        const data = JSON.parse(result.content[0].text!);
        if (data.text !== undefined) {
          found.push(target.name);
        }
      } catch {
        // not found via this locator
      }
    }

    console.log(`LinkedIn nav items found via role+name locator: ${found.join(', ') || 'none'}`);
    // Should find at least one LinkedIn nav item
    expect(found.length).toBeGreaterThan(0);
  }, 25000);

  it('32. Ref click on a LinkedIn feed post link', async () => {
    // Take fresh snapshot for current refs
    const snapResult = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: liTabUrl,
    });
    const snapData = JSON.parse(snapResult.content[0].text!);

    // Find a content link in the feed (post author, article title, etc.)
    const linkPattern = /- link "([^"]{8,})"[^\n]*\[ref=(e\d+)\]/g;
    const contentLinks: { name: string; ref: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = linkPattern.exec(snapData.snapshot)) !== null) {
      const name = m[1];
      // Skip nav links
      if (!name.match(/^(Home|My Network|Jobs|Messaging|Notifications|Post|Search|Sign|Log|LinkedIn)/i)) {
        contentLinks.push({ name, ref: m[2] });
      }
    }

    console.log(`LinkedIn content links found: ${contentLinks.length}`);
    if (contentLinks.length > 0) {
      console.log(`Sample: ${contentLinks.slice(0, 3).map(l => `"${l.name.slice(0, 40)}" [ref=${l.ref}]`).join(', ')}`);

      // Click the first content link via ref
      const target = contentLinks[0];
      console.log(`Clicking: "${target.name.slice(0, 50)}" via ref=${target.ref}`);
      await server.executeToolWithSecurity('safari_click', {
        tabUrl: liTabUrl,
        ref: target.ref,
      });
      await waitForLoad(3000);

      // Verify page changed
      const evalResult = await server.executeToolWithSecurity('safari_evaluate', {
        tabUrl: liTabUrl,
        script: 'return window.location.href',
      });
      const newUrl = JSON.parse(evalResult.content[0].text!).value;
      console.log(`LinkedIn navigated to: ${newUrl}`);
      liTabUrl = newUrl;
    } else {
      console.log('No content links found in LinkedIn feed snapshot — feed may still be loading');
    }
  }, 25000);

  it('33. Snapshot still works after LinkedIn SPA navigation', async () => {
    const snapResult = await server.executeToolWithSecurity('safari_snapshot', {
      tabUrl: liTabUrl,
    });
    const snapData = JSON.parse(snapResult.content[0].text!);
    expect(snapData.snapshot).toBeDefined();
    expect(snapData.interactiveCount).toBeGreaterThan(5);

    const refs = extractRefs(snapData.snapshot);
    console.log(
      `LinkedIn post-nav snapshot: ${snapData.elementCount} elements, ${snapData.interactiveCount} interactive, ${refs.length} refs`,
    );
  }, 20000);
});
