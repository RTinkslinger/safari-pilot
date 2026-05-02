/**
 * T55a — Parameterized routing test across all frame-aware tools.
 *
 * For each of the 6 tools that accept `frameId`, asserts:
 *   (a) frameId omitted → handler dispatches to executeJsInTab (top frame)
 *   (b) frameId set + extension engine → handler dispatches to executeJsInFrame
 *   (c) frameId set + non-extension engine → handler throws FrameNotSupportedError
 *
 * Litmus: a new frame-aware tool added without going through routeFrameAware
 * (the shared helper at src/tools/_frame-routing-helper.ts) will fail its
 * parameterized case here. This is the single defense against drift.
 *
 * Real v1 scope is 6 tools (down from plan's claimed 10) — the 5 "extract_*"
 * tools (text/links/tables/metadata/images) named in the plan don't exist in
 * this codebase. The actual tool inventory across frames.ts/extraction.ts/
 * shadow.ts that accepts frameId is enumerated in TOOLS below.
 */
import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '../../../src/errors.js';
import { FrameTools } from '../../../src/tools/frames.js';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import { ShadowTools } from '../../../src/tools/shadow.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { Engine, EngineResult } from '../../../src/types.js';

const okResult: EngineResult = { ok: true, value: '{"ok":true,"value":"x"}', elapsed_ms: 1 };

function recordingEngine(name: Engine): IEngine & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const e: IEngine & { calls: typeof calls } = {
    name,
    isAvailable: async () => true,
    execute: async () => okResult,
    executeJsInTab: async (...args: unknown[]) => {
      calls.push({ method: 'executeJsInTab', args });
      return okResult;
    },
    executeJsInFrame: async (...args: unknown[]) => {
      calls.push({ method: 'executeJsInFrame', args });
      return okResult;
    },
    shutdown: async () => {},
    calls,
  } as unknown as IEngine & { calls: typeof calls };
  return e;
}

interface ToolSpec {
  tool: string;
  module: 'frames' | 'extraction' | 'shadow';
  minParams: Record<string, unknown>;
}

// 6 frame-aware tools that accept `frameId`. NOTE: safari_list_frames is NOT
// in this list — it RETURNS frameId in its result, but doesn't ACCEPT it as
// a param (you don't list-frames-of-a-specific-frame). The routing rule under
// test is "what does the handler do when the user passes frameId."
const TOOLS: ToolSpec[] = [
  // eval_in_frame requires frameSelector OR frameId — supply frameSelector so the
  // same-origin path can dispatch when frameId is omitted; the param is then
  // ignored when frameId is set (frameId takes precedence).
  { tool: 'safari_eval_in_frame', module: 'frames', minParams: { tabUrl: 'https://x', script: 'return 1', frameSelector: 'iframe' } },
  { tool: 'safari_get_text', module: 'extraction', minParams: { tabUrl: 'https://x', selector: 'div' } },
  { tool: 'safari_get_html', module: 'extraction', minParams: { tabUrl: 'https://x', selector: 'div' } },
  { tool: 'safari_get_attribute', module: 'extraction', minParams: { tabUrl: 'https://x', selector: 'div', attribute: 'href' } },
  { tool: 'safari_query_shadow', module: 'shadow', minParams: { tabUrl: 'https://x', hostSelector: 'div', shadowSelector: 'span' } },
  { tool: 'safari_click_shadow', module: 'shadow', minParams: { tabUrl: 'https://x', hostSelector: 'div', shadowSelector: 'span' } },
];

function makeHandler(spec: ToolSpec, engine: IEngine) {
  let inst: { getHandler(name: string): ((p: Record<string, unknown>) => Promise<unknown>) | undefined };
  if (spec.module === 'frames') inst = new FrameTools(engine);
  else if (spec.module === 'extraction') inst = new ExtractionTools(engine);
  else inst = new ShadowTools(engine);
  const handler = inst.getHandler(spec.tool);
  if (!handler) throw new Error(`handler not found: ${spec.tool}`);
  return handler;
}

describe.each(TOOLS)('$tool — frame-aware routing (T55a)', (spec) => {
  it('frameId omitted → executeJsInTab', async () => {
    const engine = recordingEngine('extension');
    const handler = makeHandler(spec, engine);
    try { await handler(spec.minParams); } catch { /* JSON parse on fake result may throw — fine, we're testing dispatch */ }
    expect(engine.calls.some((c) => c.method === 'executeJsInTab')).toBe(true);
    expect(engine.calls.some((c) => c.method === 'executeJsInFrame')).toBe(false);
  });

  it('frameId set + extension engine → executeJsInFrame', async () => {
    const engine = recordingEngine('extension');
    const handler = makeHandler(spec, engine);
    try { await handler({ ...spec.minParams, frameId: 5 }); } catch { /* fine */ }
    expect(engine.calls.some((c) => c.method === 'executeJsInFrame')).toBe(true);
  });

  it('frameId set + non-extension engine → throws FRAME_NOT_SUPPORTED', async () => {
    const engine = recordingEngine('applescript');
    const handler = makeHandler(spec, engine);
    let caught: unknown = null;
    try {
      await handler({ ...spec.minParams, frameId: 5 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe(ERROR_CODES.FRAME_NOT_SUPPORTED);
    // Critically: never dispatched to executeJsInFrame because the guard fires first.
    expect(engine.calls.some((c) => c.method === 'executeJsInFrame')).toBe(false);
  });
});
