/**
 * SD-04 unit coverage for the ScreenshotRedaction post-execution layer
 * (layer 8b).
 *
 * The e2e test in `test/e2e/security-layers.test.ts` proves the layer is
 * wired (screenshot metadata carries `redactionScript` + `redactionApplied`).
 * This unit suite covers the server-side analysis (`identifySensitiveRegions`)
 * and the script-content shape that the e2e cannot exercise:
 *
 *   - Cross-origin iframes are always flagged.
 *   - Banking-domain iframes are flagged even when same-origin claimed.
 *   - Non-banking same-origin iframes are not flagged.
 *   - The redaction script targets iframes, password inputs, and CC fields.
 *
 * Discrimination: comment out the cross-origin branch in
 * `identifySensitiveRegions` → test 1 fails. Comment out the banking
 * branch → test 2 fails. Remove the password input selector from
 * `getRedactionScript` → test 5 fails.
 */
import { describe, it, expect } from 'vitest';
import { ScreenshotRedaction } from '../../../src/security/screenshot-redaction.js';

describe('ScreenshotRedaction (SD-04)', () => {
  const redactor = new ScreenshotRedaction();

  it('flags cross-origin iframes regardless of source', () => {
    const regions = redactor.identifySensitiveRegions({
      iframes: [
        {
          src: 'https://3rdparty.example/embed',
          rect: { x: 0, y: 0, width: 200, height: 100 },
          crossOrigin: true,
        },
      ],
    });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.reason).toMatch(/cross-origin/i);
    expect(regions[0]!.rect).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it('flags banking-domain iframes even when same-origin claimed', () => {
    const regions = redactor.identifySensitiveRegions({
      iframes: [
        {
          src: 'https://chase.com/widget',
          rect: { x: 10, y: 20, width: 300, height: 150 },
          crossOrigin: false,
        },
      ],
    });
    expect(regions).toHaveLength(1);
    expect(regions[0]!.reason).toMatch(/banking|financial/i);
  });

  it('does NOT flag non-banking same-origin iframes', () => {
    const regions = redactor.identifySensitiveRegions({
      iframes: [
        {
          src: 'https://example.com/inner',
          rect: { x: 0, y: 0, width: 100, height: 50 },
          crossOrigin: false,
        },
      ],
    });
    expect(regions).toHaveLength(0);
  });

  it('returns empty list when no iframes are present', () => {
    const regions = redactor.identifySensitiveRegions({ iframes: [] });
    expect(regions).toHaveLength(0);
  });

  it('redaction script targets iframes, password inputs, and CC fields', () => {
    const script = redactor.getRedactionScript();
    expect(script).toContain("iframe");
    expect(script).toContain("input[type=\"password\"]");
    expect(script).toContain('input[name*="card"]');
    expect(script).toContain('input[name*="cvv"]');
    expect(script).toContain('input[name*="ssn"]');
    expect(script).toContain("data-safari-pilot-redacted");
    expect(script).toContain("filter: blur(20px)");
  });

  it('redaction script attaches a cleanup function', () => {
    const script = redactor.getRedactionScript();
    expect(script).toContain('window.__redactionCleanup');
  });

  it('multiple iframes — mix of flagged and safe — produces correct subset', () => {
    const regions = redactor.identifySensitiveRegions({
      iframes: [
        { src: 'https://chase.com/x', rect: { x: 0, y: 0, width: 1, height: 1 }, crossOrigin: false },
        { src: 'https://example.com/y', rect: { x: 0, y: 0, width: 1, height: 1 }, crossOrigin: false },
        { src: 'https://3p.example/z', rect: { x: 0, y: 0, width: 1, height: 1 }, crossOrigin: true },
      ],
    });
    expect(regions).toHaveLength(2);
    const reasons = regions.map((r) => r.reason);
    expect(reasons.some((r) => /cross-origin/i.test(r))).toBe(true);
    expect(reasons.some((r) => /banking|financial/i.test(r))).toBe(true);
  });
});
