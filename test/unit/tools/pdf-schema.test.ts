/**
 * T18 — `safari_export_pdf` schema must NOT declare `tabUrl` because the
 * handler's HTML extraction (`extractHtml`) ignores the param. Code review
 * at `e6c7682` (2026-04-14) deliberately removed tab-aware branches and
 * renamed the param to `_tabUrl` (the underscore prefix is the in-codebase
 * convention for "unused").
 *
 * Pre-T18, the schema declared tabUrl with the description "URL of the tab
 * to export (optional — defaults to current tab)". This is silent-wrong-
 * behavior: a caller passing tabUrl believes the named tab will be exported,
 * but `extractHtml` always reaches into `current tab of front window`. The
 * URL-based fallback path (used when HTML extraction fails) honors tabUrl,
 * but the primary path does not — partial honor is worse than no claim.
 *
 * Audit finding: docs/AUDIT-TASKS.md T18 (P1, H18 — tool-modules audit).
 * Origin: `016ff8c` → `e6c7682` (2026-04-14) — review chose "always front
 * tab" over fixing the targeting.
 *
 * Lean fix path (matching T17's pattern): remove the tabUrl property from
 * the schema so the LLM-visible contract matches what the handler actually
 * does. Proper per-tab HTML extraction (option 1, the harder path) requires
 * routing through the engine's tab-aware execution and is filed as a
 * follow-up SD (see FOLLOW-UPS.md if added).
 */
import { describe, it, expect } from 'vitest';
import { PdfTools } from '../../../src/tools/pdf.js';
import type { SafariPilotServer } from '../../../src/server.js';

describe('safari_export_pdf inputSchema (T18)', () => {
  const tools = new PdfTools({} as SafariPilotServer);

  it('does not declare `tabUrl` (handler\'s extractHtml ignores it; always reads front tab)', () => {
    // Discrimination target: src/tools/pdf.ts:291-294. Pre-T18 the schema
    // declared tabUrl with description "URL of the tab to export
    // (optional — defaults to current tab)" — a false promise that
    // misleads LLM clients into thinking they can export a non-front tab
    // via this tool.
    const def = tools.getDefinitions().find((d) => d.name === 'safari_export_pdf');
    expect(def, 'safari_export_pdf tool definition must exist').toBeDefined();
    const props = (def?.inputSchema as { properties?: Record<string, unknown> }).properties;
    expect(props).not.toHaveProperty('tabUrl');
  });
});
