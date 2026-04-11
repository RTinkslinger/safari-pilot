// ─── ScreenshotRedaction ─────────────────────────────────────────────────────
//
// Identifies sensitive regions in screenshots that must be redacted before
// the image is surfaced to downstream consumers.
//
// Redaction happens in two stages:
//   1. `identifySensitiveRegions` — server-side analysis of page metadata
//      (iframe origins, DOM field types) to locate what must be hidden.
//   2. `getRedactionScript` — client-side JS injected before capture that adds
//      a CSS blur overlay to sensitive elements, so they are blurred in the
//      raw screenshot rather than cropped after the fact.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IframeInfo {
  src: string;
  rect: Rect;
  crossOrigin: boolean;
}

export interface PageInfo {
  iframes: IframeInfo[];
}

export interface SensitiveRegion {
  rect: Rect;
  reason: string;
}

// ─── Banking domain patterns ───────────────────────────────────────────────────

const BANKING_DOMAIN_PATTERNS: RegExp[] = [
  /bank(ofamerica|ofengland|west|\.com)/i,
  /chase\.com/i,
  /wellsfargo\.com/i,
  /citibank\.com/i,
  /hsbc\.com/i,
  /barclays\.com/i,
  /paypal\.com/i,
  /stripe\.com/i,
];

function isBankingDomain(src: string): boolean {
  try {
    const hostname = new URL(src).hostname;
    return BANKING_DOMAIN_PATTERNS.some((p) => p.test(hostname));
  } catch {
    return false;
  }
}

// ─── ScreenshotRedaction ──────────────────────────────────────────────────────

export class ScreenshotRedaction {
  /**
   * Analyse page metadata and return regions that must be redacted.
   *
   * Rules applied (in order):
   *   - Cross-origin iframes are always flagged — their content cannot be
   *     inspected and may contain sensitive third-party UI.
   *   - Banking-domain iframes are flagged even if same-origin is claimed,
   *     because financial data warrants extra caution.
   *
   * Same-origin, non-banking iframes are considered safe and are not flagged.
   */
  identifySensitiveRegions(pageInfo: PageInfo): SensitiveRegion[] {
    const regions: SensitiveRegion[] = [];

    for (const iframe of pageInfo.iframes) {
      if (iframe.crossOrigin) {
        regions.push({
          rect: iframe.rect,
          reason: 'Cross-origin iframe content cannot be inspected and must be redacted',
        });
        continue; // already flagged — no need for additional banking check
      }

      if (isBankingDomain(iframe.src)) {
        regions.push({
          rect: iframe.rect,
          reason: 'Banking-domain iframe content must be redacted for financial privacy',
        });
      }
    }

    return regions;
  }

  /**
   * Return JavaScript that should be evaluated in the page context before the
   * screenshot is captured.
   *
   * The script locates sensitive elements (cross-origin iframes, password
   * inputs) and temporarily applies `filter: blur(20px)` so the screenshot
   * captures already-blurred content. A cleanup function is attached to
   * `window.__redactionCleanup` for callers to call after the screenshot.
   */
  getRedactionScript(): string {
    return `
(function () {
  var BLUR_STYLE = 'filter: blur(20px) !important; pointer-events: none;';
  var ATTR = 'data-safari-pilot-redacted';
  var affected = [];

  function redact(el) {
    if (el.hasAttribute(ATTR)) return;
    var prev = el.getAttribute('style') || '';
    el.setAttribute(ATTR, prev);
    el.setAttribute('style', (prev ? prev + '; ' : '') + BLUR_STYLE);
    affected.push(el);
  }

  // 1. All iframes — cross-origin frames cannot be origin-checked from JS,
  //    so redact all iframes as a conservative default.
  var iframes = document.querySelectorAll('iframe');
  for (var i = 0; i < iframes.length; i++) {
    redact(iframes[i]);
  }

  // 2. Password input fields
  var passwords = document.querySelectorAll('input[type="password"]');
  for (var j = 0; j < passwords.length; j++) {
    redact(passwords[j]);
  }

  // 3. Sensitive input fields by name/id attributes
  var sensitiveSelectors = [
    'input[name*="card"]',
    'input[name*="cvv"]',
    'input[name*="ssn"]',
    'input[name*="account"]',
    'input[autocomplete="cc-number"]',
    'input[autocomplete="cc-csc"]',
  ].join(', ');
  var sensitiveInputs = document.querySelectorAll(sensitiveSelectors);
  for (var k = 0; k < sensitiveInputs.length; k++) {
    redact(sensitiveInputs[k]);
  }

  // Cleanup: restore original styles
  window.__redactionCleanup = function () {
    for (var n = 0; n < affected.length; n++) {
      var el = affected[n];
      var orig = el.getAttribute(ATTR) || '';
      if (orig) {
        el.setAttribute('style', orig);
      } else {
        el.removeAttribute('style');
      }
      el.removeAttribute(ATTR);
    }
    affected = [];
    delete window.__redactionCleanup;
  };
})();
`.trim();
  }
}
