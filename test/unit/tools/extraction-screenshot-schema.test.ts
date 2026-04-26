/**
 * T17 — `safari_take_screenshot` schema must NOT advertise params the
 * handler ignores. Pre-T17 the schema declared `tabUrl`, `fullPage`, and
 * `quality` but the handler at extraction.ts:390-409 only reads `format`
 * and `path`. The implementation uses `screencapture -x` which captures
 * the frontmost window only — `tabUrl` cannot retarget, `fullPage` cannot
 * scroll-and-stitch, and `quality` cannot tune JPEG compression.
 *
 * The dead params are silent-wrong-behavior: callers that pass `tabUrl`
 * believe they're targeting a specific tab but get the frontmost regardless.
 * Worse, the property's own description ("used to bring it to front")
 * implies the tool will activate the tab — which would violate the core
 * product principle of tab isolation (CLAUDE.md: "Never switch user tabs").
 *
 * Audit finding: docs/AUDIT-TASKS.md T17 (P1, H15 — tool-modules audit).
 * Origin: `115c762` (2026-04-11) — schema-first, implementation-never pattern.
 * Competitive analysis marks fullPage as "RD" (roadmap), so removal is
 * preferred over implementation.
 */
import { describe, it, expect } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import type { IEngine } from '../../../src/engines/engine.js';

describe('safari_take_screenshot inputSchema (T17)', () => {
  const tools = new ExtractionTools({} as IEngine);

  function getProperties(): Record<string, unknown> {
    const def = tools.getDefinitions().find((d) => d.name === 'safari_take_screenshot');
    if (!def) throw new Error('safari_take_screenshot tool definition must exist');
    const props = (def.inputSchema as { properties?: Record<string, unknown> }).properties;
    if (!props) throw new Error('safari_take_screenshot inputSchema.properties must exist');
    return props;
  }

  it('declares optional `tabUrl` (T59: used for ScreenshotPolicy domain check; does not retarget screencapture)', () => {
    // tabUrl added in T59 so callers can supply the current tab URL for
    // ScreenshotPolicy.checkDomain() before screencapture runs.
    // screencapture -x still captures the frontmost window — tabUrl does NOT
    // activate or switch tabs (CLAUDE.md: "Never switch user tabs").
    const props = getProperties();
    expect(props).toHaveProperty('tabUrl');
    expect((props['tabUrl'] as Record<string, unknown>)['type']).toBe('string');
  });

  it('does not declare `fullPage` (handler captures viewport only; scroll-and-stitch is roadmap)', () => {
    // Discrimination target: extraction.ts:175-179. Pre-T17 the schema
    // declared fullPage:boolean — but `screencapture -x -t png` cannot
    // produce a full-scroll capture. Implementation deferred to roadmap
    // per the H15 finding.
    expect(getProperties()).not.toHaveProperty('fullPage');
  });

  it('does not declare `quality` (handler does not pass JPEG compression to screencapture)', () => {
    // Discrimination target: extraction.ts:185. Pre-T17 the schema
    // declared quality:number — but the handler's execFile call passes
    // only `-x -t <fmt> <tmpFile>` to screencapture. The quality value
    // never reaches the binary.
    expect(getProperties()).not.toHaveProperty('quality');
  });
});
