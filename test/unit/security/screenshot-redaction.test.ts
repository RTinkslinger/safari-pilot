import { describe, it, expect } from 'vitest';
import { ScreenshotRedaction } from '../../../src/security/screenshot-redaction.js';
import type { PageInfo, Rect } from '../../../src/security/screenshot-redaction.js';

const DUMMY_RECT: Rect = { x: 0, y: 0, width: 300, height: 150 };

describe('ScreenshotRedaction', () => {
  const redaction = new ScreenshotRedaction();

  // ── identifySensitiveRegions ─────────────────────────────────────────────────

  it('returns empty array when there are no iframes', () => {
    const pageInfo: PageInfo = { iframes: [] };
    const regions = redaction.identifySensitiveRegions(pageInfo);
    expect(regions).toHaveLength(0);
  });

  it('flags a cross-origin iframe', () => {
    const pageInfo: PageInfo = {
      iframes: [
        { src: 'https://other.example.com/widget', rect: DUMMY_RECT, crossOrigin: true },
      ],
    };
    const regions = redaction.identifySensitiveRegions(pageInfo);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.rect).toEqual(DUMMY_RECT);
  });

  it('does not flag a same-origin, non-banking iframe', () => {
    const pageInfo: PageInfo = {
      iframes: [
        { src: 'https://myapp.com/embed', rect: DUMMY_RECT, crossOrigin: false },
      ],
    };
    const regions = redaction.identifySensitiveRegions(pageInfo);
    expect(regions).toHaveLength(0);
  });

  it('flags all cross-origin iframes when multiple are present', () => {
    const rect1: Rect = { x: 0, y: 0, width: 200, height: 100 };
    const rect2: Rect = { x: 300, y: 0, width: 200, height: 100 };
    const pageInfo: PageInfo = {
      iframes: [
        { src: 'https://ad.example.com/slot', rect: rect1, crossOrigin: true },
        { src: 'https://widget.example.net/chat', rect: rect2, crossOrigin: true },
      ],
    };
    const regions = redaction.identifySensitiveRegions(pageInfo);
    expect(regions).toHaveLength(2);
  });

  it('does not flag same-origin iframes while flagging cross-origin ones', () => {
    const rect1: Rect = { x: 0, y: 0, width: 200, height: 100 };
    const rect2: Rect = { x: 300, y: 0, width: 200, height: 100 };
    const pageInfo: PageInfo = {
      iframes: [
        { src: 'https://myapp.com/safe-embed', rect: rect1, crossOrigin: false },
        { src: 'https://external.example.com/widget', rect: rect2, crossOrigin: true },
      ],
    };
    const regions = redaction.identifySensitiveRegions(pageInfo);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.rect).toEqual(rect2);
  });

  it('returns a reason string for each flagged region', () => {
    const pageInfo: PageInfo = {
      iframes: [
        { src: 'https://other.example.com/widget', rect: DUMMY_RECT, crossOrigin: true },
      ],
    };
    const regions = redaction.identifySensitiveRegions(pageInfo);
    expect(typeof regions[0]!.reason).toBe('string');
    expect(regions[0]!.reason.length).toBeGreaterThan(0);
  });

  it('preserves the exact rect from the iframe info in the region', () => {
    const customRect: Rect = { x: 50, y: 75, width: 640, height: 480 };
    const pageInfo: PageInfo = {
      iframes: [
        { src: 'https://external.com/frame', rect: customRect, crossOrigin: true },
      ],
    };
    const regions = redaction.identifySensitiveRegions(pageInfo);
    expect(regions[0]!.rect).toEqual(customRect);
  });

  // ── getRedactionScript ───────────────────────────────────────────────────────

  it('returns a non-empty string', () => {
    const script = redaction.getRedactionScript();
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(0);
  });

  it('script contains blur CSS', () => {
    const script = redaction.getRedactionScript();
    expect(script).toContain('blur(20px)');
  });

  it('script targets iframe elements', () => {
    const script = redaction.getRedactionScript();
    expect(script).toContain('iframe');
  });

  it('script targets password input fields', () => {
    const script = redaction.getRedactionScript();
    expect(script).toContain('input[type="password"]');
  });

  it('script exposes a cleanup function on window', () => {
    const script = redaction.getRedactionScript();
    expect(script).toContain('__redactionCleanup');
  });

  it('produces the same script on repeated calls (idempotent)', () => {
    const script1 = redaction.getRedactionScript();
    const script2 = redaction.getRedactionScript();
    expect(script1).toBe(script2);
  });

  // ── Banking-domain iframes (same-origin flag false but content is financial) ─

  it('flags a same-origin banking-domain iframe for financial privacy', () => {
    const pageInfo: PageInfo = {
      iframes: [
        { src: 'https://www.chase.com/embed/payment', rect: DUMMY_RECT, crossOrigin: false },
      ],
    };
    const regions = redaction.identifySensitiveRegions(pageInfo);
    expect(regions).toHaveLength(1);
    expect(regions[0]!.reason).toContain('Banking');
  });
});
