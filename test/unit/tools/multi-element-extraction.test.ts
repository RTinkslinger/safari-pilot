/**
 * Phase 5A · 5A.6 — extraction tools accept `multi: true` for native
 * multi-element extraction.
 *
 * Pre-fix: `safari_get_text`, `safari_get_html`, `safari_get_attribute` use
 * `document.querySelector` (single match). To extract from N matching
 * elements, agents must fall back to `safari_evaluate` with custom JS — a
 * workaround that loses ref/locator/frame-aware routing.
 *
 * Post-fix: each tool accepts `multi: true`. When set:
 *   - `querySelectorAll` replaces `querySelector` in the generated JS
 *   - Response shape is `{ matches: [...primitive values], count }`
 *   - Single-element shape (`text`/`html`/`value`) is preserved when multi
 *     is false or omitted (no behavior regression for existing callers)
 *
 * Test strategy mirrors 5A.3: capture the generated JS via a recording
 * engine, assert on `querySelectorAll` presence/absence. End-to-end array
 * shape (matches contains real values from real Safari) goes in the
 * companion e2e at test/e2e/5A6-multi-element-extraction.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { Engine, EngineResult } from '../../../src/types.js';

function recordingEngine(returnValue: string): IEngine & { capturedScripts: string[] } {
  const capturedScripts: string[] = [];
  const result: EngineResult = { ok: true, value: returnValue, elapsed_ms: 1 };
  const e = {
    name: 'extension' as Engine,
    isAvailable: async () => true,
    execute: async () => result,
    executeJsInTab: async (_tabUrl: string, jsCode: string) => {
      capturedScripts.push(jsCode);
      return result;
    },
    executeJsInFrame: async (_tabUrl: string, _frameId: number, jsCode: string) => {
      capturedScripts.push(jsCode);
      return result;
    },
    shutdown: async () => {},
    capturedScripts,
  };
  return e as unknown as IEngine & { capturedScripts: string[] };
}

async function runTool(
  toolName: 'safari_get_text' | 'safari_get_html' | 'safari_get_attribute',
  params: Record<string, unknown>,
  returnValue = JSON.stringify({ matches: [], count: 0 }),
): Promise<string> {
  const engine = recordingEngine(returnValue);
  // ExtractionTools' second arg is an optional ScreenshotPolicy — extraction
  // tools (get_text/html/attribute) don't touch it, so omit.
  const tools = new ExtractionTools(engine);
  const handler = tools.getHandler(toolName);
  if (!handler) throw new Error(`${toolName} not registered`);
  try { await handler(params); } catch { /* parse errors on canned return are fine — we test dispatch */ }
  const last = engine.capturedScripts[engine.capturedScripts.length - 1];
  if (!last) throw new Error('no script captured');
  return last;
}

describe('5A.6 — extraction tools support multi: true (querySelectorAll)', () => {
  describe('safari_get_text', () => {
    // v0.1.34 T12: safari_get_text now emits a __SP_GET_TEXT__:<json> sentinel
    // (intercepted in extension/content-main.js MAIN world). Unit tests assert
    // the sentinel JSON envelope encodes the same intent the legacy JS-string
    // expressed — multi-flag, selector, maxLength — and the in-page sentinel
    // handler implements the per-element .innerText / .textContent read +
    // {matches, count} vs {text, length, truncated} shape. The handler logic
    // is verified by test/e2e/csp-extraction-sentinels.test.ts.
    it('multi:true emits sentinel with multi=true and selector', async () => {
      const script = await runTool('safari_get_text', {
        tabUrl: 'https://example.com/',
        selector: 'li',
        multi: true,
      });
      expect(script.startsWith('__SP_GET_TEXT__:'), 'expected __SP_GET_TEXT__ sentinel').toBe(true);
      const payload = JSON.parse(script.slice('__SP_GET_TEXT__:'.length));
      expect(payload.selector).toBe('li');
      expect(payload.multi).toBe(true);
    });

    it('multi:false (default) emits sentinel with multi=false', async () => {
      const script = await runTool('safari_get_text', {
        tabUrl: 'https://example.com/',
        selector: 'li',
      });
      expect(script.startsWith('__SP_GET_TEXT__:'), 'expected __SP_GET_TEXT__ sentinel').toBe(true);
      const payload = JSON.parse(script.slice('__SP_GET_TEXT__:'.length));
      expect(payload.selector).toBe('li');
      expect(payload.multi).toBe(false);
    });
  });

  describe('safari_get_html', () => {
    it('multi:true uses querySelectorAll(<selector>), reads .outerHTML|.innerHTML, returns {matches, count}', async () => {
      const script = await runTool('safari_get_html', {
        tabUrl: 'https://example.com/',
        selector: '.item',
        multi: true,
      });
      expect(script, 'expected querySelectorAll(\'.item\')').toMatch(/querySelectorAll\('\.item'\)/);
      expect(
        /\.outerHTML\b|\.innerHTML\b/.test(script),
        'expected per-element .outerHTML or .innerHTML in multi mode',
      ).toBe(true);
      expect(script, 'expected matches array in response').toMatch(/matches\s*:/);
      expect(script, 'expected count in response shape').toMatch(/\bcount\s*:/);
    });

    it('multi:false (default) preserves single-element querySelector + html shape', async () => {
      const script = await runTool('safari_get_html', {
        tabUrl: 'https://example.com/',
        selector: '.item',
      });
      expect(script, 'default mode must use querySelector (not All)').toMatch(/querySelector\([^A]/);
      expect(
        /querySelectorAll\(/.test(script),
        'default mode must NOT use querySelectorAll',
      ).toBe(false);
      expect(script, 'expected single-element html response shape').toMatch(/\bhtml\s*:/);
    });
  });

  describe('safari_get_attribute', () => {
    it('multi:true uses querySelectorAll(<selector>), reads getAttribute(<attribute>), returns {matches, count}', async () => {
      const script = await runTool('safari_get_attribute', {
        tabUrl: 'https://example.com/',
        selector: 'a',
        attribute: 'href',
        multi: true,
      });
      expect(script, 'expected querySelectorAll(\'a\')').toMatch(/querySelectorAll\('a'\)/);
      // Per-element extraction must call getAttribute with the requested name.
      expect(script, 'expected per-element getAttribute(\'href\')').toMatch(/getAttribute\('href'\)/);
      expect(script, 'expected matches array in response').toMatch(/matches\s*:/);
      expect(script, 'expected count in response shape').toMatch(/\bcount\s*:/);
    });

    it('multi:false (default) preserves single-element querySelector + value shape', async () => {
      const script = await runTool('safari_get_attribute', {
        tabUrl: 'https://example.com/',
        selector: 'a',
        attribute: 'href',
      });
      expect(script, 'default mode must use querySelector (not All)').toMatch(/querySelector\([^A]/);
      expect(
        /querySelectorAll\(/.test(script),
        'default mode must NOT use querySelectorAll',
      ).toBe(false);
      expect(script, 'expected single-element value response shape').toMatch(/\bvalue\s*:/);
    });
  });
});
