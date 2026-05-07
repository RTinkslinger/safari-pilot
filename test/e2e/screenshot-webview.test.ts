/**
 * Task 11 — WebView screenshot capture e2e (v0.1.30).
 *
 * Proves the new WebView-only screenshot path:
 *   1. Red-pixel proof — capture a page filled with #ff0000 and verify ≥95%
 *      of sampled pixels are red-dominant. Catches: wrong tab captured,
 *      blank/black PNG, screen-of-something-else, colour-channel swap.
 *   2. Tab isolation — capturing must NOT bring Safari to the foreground.
 *      Per project memory `feedback-never-switch-user-tabs` — tab-switch
 *      flicker inside Safari is allowed (it's part of the new behaviour),
 *      but the OS-level frontmost app must NOT change.
 *   3. TAB_NOT_FOUND — capturing a closed tab fails fast with the correct
 *      error signature (not silently captures a different tab).
 *   4. Latency p95 < 1000ms over 20 sequential captures on the same tab.
 *
 * Structure follows test/e2e/T43-observation-tools.test.ts:
 *   - Uses getSharedClient() (singleton across the e2e run; teardown handled
 *     by the setupFile, do NOT call client.close()).
 *   - Local fixture server bound to a random port.
 *   - URL marker `?sp_screenshot_e2e_<a|b|c|d>=<ts>` per opened tab.
 *   - Every opened tab is recorded and closed in afterAll
 *     (feedback-e2e-tests-must-close-tabs).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { callTool, rawCallTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startRedPageServer, type RedPageServer } from '../fixtures/red-page-server.js';

interface ScreenshotPayload {
  data: string;
  mimeType?: string;
}

function getFrontmostApp(): string {
  try {
    return execSync(
      'osascript -e \'tell application "System Events" to name of first application process whose frontmost is true\'',
      { timeout: 3000 },
    ).toString().trim();
  } catch {
    return '';
  }
}

function extractPngBase64(raw: { result: Record<string, unknown> }): string {
  const content = (raw.result['content'] as Array<Record<string, unknown>>) ?? [];
  const imagePart = content.find((p) => p['type'] === 'image');
  if (!imagePart) {
    throw new Error(
      `screenshot result has no image part. content=${JSON.stringify(content).slice(0, 300)}`,
    );
  }
  const data = imagePart['data'] as string;
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('screenshot image data is empty or non-string');
  }
  return data;
}

function decodePng(base64: string): PNG {
  const buf = Buffer.from(base64, 'base64');
  return PNG.sync.read(buf);
}

/**
 * Sample N pixels uniformly from the PNG and return the fraction that are
 * red-dominant per the criterion R > 200 && G < 50 && B < 50.
 *
 * We sample rather than scan all pixels because:
 *   - Retina captures are 2× viewport in each dimension — 2880×1800 PNGs
 *     are ~5M pixels. Full scan is wasteful.
 *   - Page chrome (scroll bars, dev-tool overlays, transient flashes) can
 *     intrude on the edges. Sampling from a centred grid avoids the
 *     no-mans-land at the borders.
 */
function fractionRedDominant(png: PNG, sampleCount = 400): number {
  const { width, height, data } = png;
  // Sample from a centred 80% × 80% rectangle (skip the outer 10% on each side)
  // to avoid scrollbars or any chrome that bleeds into the WebView capture.
  const x0 = Math.floor(width * 0.1);
  const x1 = Math.floor(width * 0.9);
  const y0 = Math.floor(height * 0.1);
  const y1 = Math.floor(height * 0.9);
  const grid = Math.ceil(Math.sqrt(sampleCount));
  let red = 0;
  let total = 0;
  for (let i = 0; i < grid; i++) {
    for (let j = 0; j < grid; j++) {
      const x = x0 + Math.floor(((x1 - x0) * i) / (grid - 1));
      const y = y0 + Math.floor(((y1 - y0) * j) / (grid - 1));
      const idx = (y * width + x) * 4;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      if (r > 200 && g < 50 && b < 50) red++;
      total++;
    }
  }
  return red / total;
}

describe('safari_take_screenshot — WebView capture (v0.1.30)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: RedPageServer;
  const openedTabUrls: string[] = [];

  beforeAll(async () => {
    fixture = await startRedPageServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 35_000);

  afterAll(async () => {
    if (client) {
      for (const tabUrl of openedTabUrls) {
        try {
          await callTool(client, 'safari_close_tab', { tabUrl }, nextId());
        } catch { /* best-effort cleanup */ }
      }
    }
    if (fixture) await fixture.close();
  });

  /**
   * Open a tab on the red fixture and wait for document.readyState ===
   * 'complete'. Records the resolved tabUrl in openedTabUrls so afterAll
   * can sweep it.
   *
   * Note: safari_wait_for has no 'load' condition (src/tools/wait.ts:100
   * lists ['selector','selectorHidden','text','textGone','urlMatch',
   * 'networkidle','function']). We use 'function' with a JS predicate that
   * returns the readyState boolean — that's the documented escape hatch.
   */
  async function openRedTab(marker: string): Promise<string> {
    const target = `${fixture.url}?sp_screenshot_e2e_${marker}=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: target }, nextId());
    const tabUrl = tab.tabUrl as string;
    openedTabUrls.push(tabUrl);
    await callTool(
      client,
      'safari_wait_for',
      {
        tabUrl,
        condition: 'function',
        value: 'return document.readyState === "complete"',
        timeout: 10_000,
      },
      nextId(),
      15_000,
    );
    return tabUrl;
  }

  it('captures the red WebView — ≥95% sampled pixels are red-dominant', async () => {
    const tabUrl = await openRedTab('a');

    const raw = await rawCallTool(
      client,
      'safari_take_screenshot',
      { tabUrl },
      nextId(),
      20_000,
    );
    const base64 = extractPngBase64(raw);
    // PNG signature in base64 starts with "iVBOR" — cheap sanity check
    // before paying for the full decode.
    expect(base64.startsWith('iVBOR')).toBe(true);

    const png = decodePng(base64);
    expect(png.width).toBeGreaterThan(0);
    expect(png.height).toBeGreaterThan(0);

    const fraction = fractionRedDominant(png, 400);
    expect(
      fraction,
      `expected ≥95% red-dominant pixels (R>200, G<50, B<50). ` +
        `Got ${(fraction * 100).toFixed(1)}% on a ${png.width}×${png.height} PNG.`,
    ).toBeGreaterThanOrEqual(0.95);
  }, 45_000);

  it('does NOT bring Safari to the foreground while capturing', async () => {
    const beforeFront = getFrontmostApp();
    // If Safari is already frontmost (test harness misconfigured / user
    // running tests with Safari in focus), we cannot prove the negative —
    // skip rather than falsely pass. Per advisor guidance: it's an
    // environment precondition, not a product assertion.
    if (beforeFront === 'Safari') {
      console.warn(
        `[screenshot-webview] precondition not met: frontmost=${beforeFront} — skipping no-foregrounding assertion`,
      );
      return;
    }

    const tabUrl = await openRedTab('b');
    const afterOpenFront = getFrontmostApp();

    await callTool(client, 'safari_take_screenshot', { tabUrl }, nextId(), 20_000);

    const afterCaptureFront = getFrontmostApp();
    expect(
      afterCaptureFront,
      `frontmost app changed during screenshot capture. ` +
        `before-open=${beforeFront}, after-open=${afterOpenFront}, after-capture=${afterCaptureFront}. ` +
        `safari_take_screenshot must NOT activate Safari.`,
    ).not.toBe('Safari');
  }, 45_000);

  it('returns TAB_NOT_FOUND when capturing a tab that has been closed', async () => {
    const target = `${fixture.url}?sp_screenshot_e2e_c=${Date.now()}`;
    const tab = await callTool(client, 'safari_new_tab', { url: target }, nextId());
    const deadTabUrl = tab.tabUrl as string;
    // Don't push to openedTabUrls — we'll close it explicitly below.

    await callTool(
      client,
      'safari_wait_for',
      {
        tabUrl: deadTabUrl,
        condition: 'function',
        value: 'return document.readyState === "complete"',
        timeout: 10_000,
      },
      nextId(),
      15_000,
    );

    await callTool(client, 'safari_close_tab', { tabUrl: deadTabUrl }, nextId());

    let errorMsg = '';
    let payload: unknown = null;
    try {
      // Use rawCallTool — we want full envelope visibility on whichever
      // surface delivers the error (some tools throw via JSON-RPC error,
      // others return _isError text). Both branches are caught.
      const raw = await rawCallTool(
        client,
        'safari_take_screenshot',
        { tabUrl: deadTabUrl },
        nextId(),
        15_000,
      );
      payload = raw.payload;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    // Match conforms to t27/t21 convention: error.message is `MCP protocol
    // error <code>: <message>` (mcp-client.ts:213). The TAB_NOT_FOUND
    // signature can also surface as message text on a non-rejected payload.
    const haystack = errorMsg + ' | ' + JSON.stringify(payload);
    expect(
      haystack,
      `expected TAB_NOT_FOUND surface for screenshot on closed tab. errorMsg=${errorMsg}, payload=${JSON.stringify(payload)}`,
    ).toMatch(/TAB_NOT_FOUND|No agent-owned tab matches/);
  }, 35_000);

  it('p95 latency < 1000ms over 20 sequential captures on the same tab', async () => {
    const tabUrl = await openRedTab('d');
    const latencies: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      await callTool(client, 'safari_take_screenshot', { tabUrl }, nextId(), 20_000);
      latencies.push(Date.now() - t0);
    }
    // numeric comparator — JS default sort is lexicographic and silently
    // mis-ranks "1000" vs "999".
    const sorted = [...latencies].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(0.95 * sorted.length)] ?? 0;
    const median = sorted[Math.floor(0.5 * sorted.length)] ?? 0;
    expect(
      p95,
      `p95 latency ${p95}ms exceeds 1000ms budget. ` +
        `median=${median}ms, samples=${JSON.stringify(latencies)}`,
    ).toBeLessThan(1000);
  }, 60_000);

  it('payload is image/png with non-empty base64 data', async () => {
    // Cheap shape regression — independent of the colour-content assertion.
    // If the v0.1.30 wire format ever drifts away from MCP image content,
    // this fails first and isolates the cause.
    const tabUrl = openedTabUrls[0];
    if (!tabUrl) {
      // First test should have opened a tab; if it didn't, we open a fresh one.
      const fresh = await openRedTab('a');
      const raw = await rawCallTool(
        client,
        'safari_take_screenshot',
        { tabUrl: fresh },
        nextId(),
        20_000,
      );
      const part = ((raw.result['content'] as Array<Record<string, unknown>>) ?? []).find(
        (p) => p['type'] === 'image',
      ) as ScreenshotPayload | undefined;
      expect(part).toBeDefined();
      expect(part!.mimeType ?? 'image/png').toContain('png');
      expect(part!.data.length).toBeGreaterThan(500);
      return;
    }
    const raw = await rawCallTool(
      client,
      'safari_take_screenshot',
      { tabUrl },
      nextId(),
      20_000,
    );
    const part = ((raw.result['content'] as Array<Record<string, unknown>>) ?? []).find(
      (p) => p['type'] === 'image',
    ) as ScreenshotPayload | undefined;
    expect(part).toBeDefined();
    expect(part!.mimeType ?? 'image/png').toContain('png');
    expect(part!.data.length).toBeGreaterThan(500);
  }, 30_000);
});
