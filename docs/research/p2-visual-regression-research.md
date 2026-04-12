# P2 Visual Regression Testing -- Research Report

> Research for Safari Pilot's visual regression testing feature.
> Covers algorithms, frameworks, Retina handling, baseline management, diff generation, Safari-specific challenges, and performance.
> Compiled 2026-04-12.

---

## Table of Contents

1. [Framework Architecture Comparison](#1-framework-architecture-comparison)
2. [Image Diffing Algorithms](#2-image-diffing-algorithms)
3. [Retina / HiDPI Handling](#3-retina--hidpi-handling)
4. [Baseline Management](#4-baseline-management)
5. [Diff Image Generation & Review](#5-diff-image-generation--review)
6. [Safari-Specific Rendering Challenges](#6-safari-specific-rendering-challenges)
7. [Performance Considerations](#7-performance-considerations)
8. [Recommended Architecture for Safari Pilot](#8-recommended-architecture-for-safari-pilot)
9. [Sources](#9-sources)

---

## 1. Framework Architecture Comparison

### 1.1 Playwright (`expect(page).toHaveScreenshot()`)

**Architecture:** Fully integrated into the test runner. Screenshots captured via browser protocol, compared locally using pixelmatch.

**API:**
```typescript
await expect(page).toHaveScreenshot('name.png', {
  maxDiffPixels: 100,           // absolute pixel count threshold
  maxDiffPixelRatio: 0.01,      // percentage threshold (0-1)
  threshold: 0.2,               // per-pixel color sensitivity (passed to pixelmatch)
  animations: 'disabled',       // freeze CSS animations before capture
  caret: 'hide',                // hide text cursor
  scale: 'css',                 // 'css' (1x) or 'device' (native DPR)
  mask: [page.locator('.ad')],  // mask volatile elements
  maskColor: '#FF00FF',         // mask overlay color
  stylePath: './screenshot.css' // inject CSS before capture
});
```

**Baseline storage:** Files saved to `[testfile]-snapshots/` directory alongside tests. Naming convention: `[name]-[browser]-[platform].png`. Stored in Git by default.

**Update workflow:** `npx playwright test --update-snapshots` regenerates all baselines.

**Key insight for Safari Pilot:** Playwright's `scale: 'css'` option normalizes screenshots to 1x CSS pixels regardless of device DPR. This is the simplest approach to cross-environment consistency. Playwright uses pixelmatch internally with no SSIM or perceptual hashing layer.

**Sources:**
- https://playwright.dev/docs/test-snapshots
- https://playwright.dev/docs/test-configuration

### 1.2 Percy (BrowserStack)

**Architecture:** SaaS cloud service. Test framework captures screenshots and uploads to Percy's cloud. All diffing, baseline storage, and review happen server-side.

**Flow:** Capture in test -> upload via Percy SDK -> cloud diff -> PR comment with link to dashboard.

**Diff engine:** Pixel-level with configurable tolerance. Cloud-rendered, not local.

**Review UI:** Rich web dashboard with side-by-side, overlay, and approval workflows. Integrates with GitHub PR status checks.

**Cost model:** Per-screenshot pricing. Vendor lock-in for storage and diffing.

**Relevance to Safari Pilot:** Percy's cloud model is not applicable (Safari Pilot is local-first), but its PR integration pattern and review UI concepts are worth emulating.

### 1.3 Applitools Eyes

**Architecture:** SaaS with AI-powered Visual AI engine. SDK integrates with browser drivers to capture, then uploads for cloud comparison.

**Diff engine:** Proprietary ML-based. Offers match levels:
- **Strict:** Pixel-accurate comparison (similar to pixelmatch)
- **Layout:** Ignores colors/content, checks structural layout
- **Content:** Checks text content but ignores styling
- **Dynamic:** AI determines what matters

**Key innovation:** The AI approach virtually eliminates false positives from font rendering, anti-aliasing, and minor color shifts. This is the gold standard but requires cloud dependency.

**Relevance to Safari Pilot:** The "match level" concept is powerful. Safari Pilot should offer similar modes (strict pixel, structural, perceptual) even if implemented with open-source algorithms rather than ML.

### 1.4 BackstopJS

**Architecture:** Open-source wrapper around Playwright/Puppeteer. Captures screenshots, diffs locally using Resemble.js, generates HTML reports.

**Baseline storage:** Local `backstop_data/bitmaps_reference/` directory. Committed to Git.

**Diff engine:** Resemble.js (pixel-based with tolerance config).

**Report:** Self-contained HTML with side-by-side, diff mask, and overlay toggle.

**Relevance to Safari Pilot:** BackstopJS's HTML report generator is a good reference for Safari Pilot's own diff report output. The self-contained HTML approach is ideal for local-first tooling.

### 1.5 reg-suit

**Architecture:** Orchestration layer that wraps other capture/diff tools. Key differentiator: stores baselines in cloud storage (S3/GCS) instead of Git.

**Baseline storage:** S3 or GCS buckets with versioning. Generates static HTML reports uploaded to cloud hosting.

**PR integration:** Posts comments with links to hosted reports.

**Relevance to Safari Pilot:** reg-suit's cloud baseline pattern is the right model for teams with large baseline sets. Safari Pilot should support both local (Git) and remote (S3-compatible) baseline storage.

---

## 2. Image Diffing Algorithms

### 2.1 pixelmatch -- The Foundation

**What it is:** ~150-line JavaScript library. No dependencies. Operates on raw RGBA typed arrays. 6.8k GitHub stars, used by Playwright and jest-image-snapshot.

**API:**
```javascript
const numDiffPixels = pixelmatch(img1, img2, output, width, height, {
  threshold: 0.1,          // color sensitivity 0-1 (default 0.1)
  includeAA: false,        // treat AA pixels as real diffs (default false)
  alpha: 0.1,              // opacity of unchanged pixels in diff output
  aaColor: [255,255,0],    // yellow for anti-aliased pixels
  diffColor: [255,0,0],    // red for real differences
  diffColorAlt: null,      // optional alt color for dark-on-light diffs
  diffMask: false           // transparent background instead of original
});
```

**Algorithm internals:**

1. **Fast path:** Compares pixels as 32-bit integers first. If equal, skip expensive computation.

2. **Color distance (YIQ):** Uses the YIQ NTSC color space, not raw RGB. The delta formula:
   ```
   Y = 0.29889531*dR + 0.58662247*dG + 0.11448223*dB  (luminance)
   I = 0.59597799*dR - 0.27417610*dG - 0.32180189*dB  (in-phase)
   Q = 0.21147017*dR - 0.52261711*dG + 0.31114694*dB  (quadrature)
   delta = 0.5053*Y^2 + 0.299*I^2 + 0.1957*Q^2
   ```
   This weights luminance most heavily (matching human vision), and the sign encodes whether img2 is darker (negative) or brighter (positive).

   Based on: "Measuring perceived color difference using YIQ NTSC transmission color space" (Kotsarenko & Ramos, 2010).

3. **Anti-aliasing detection:** For each pixel that exceeds the color threshold, checks 8 neighbors:
   - Calculates brightness deltas between center and all neighbors
   - If fewer than 2 different brightness levels exist, it is NOT anti-aliasing
   - Validates by checking if the darkest/brightest neighbors have 3+ siblings of the same color in BOTH images (via `hasManySiblings`)
   - Based on: "Anti-aliased pixel and intensity slope detector" (Vyshniauskas, 2009)

4. **Threshold math:** A pixel is "different" when `delta > 35215 * threshold^2`. At default threshold 0.1, this requires a perceptual delta > 352.15 (on a 0-35215 scale).

**Performance:** Operates on raw typed arrays -- no image decoding overhead. The 32-bit fast path skips computation for identical pixels. Benchmarks available in `bench.js` but library is considered "blazing fast" for typical web screenshots.

**Safari-specific tuning:** For Safari text rendering, increase threshold to 0.15-0.2 to absorb font smoothing variation without missing real regressions. The AA detection is specifically designed for the kind of sub-pixel artifacts Safari produces.

**Sources:**
- https://github.com/mapbox/pixelmatch (README, source code)
- https://github.com/mapbox/pixelmatch/issues/74 (improved AA discussion)
- https://github.com/mapbox/pixelmatch/issues/75 (AA detection examples)

### 2.2 SSIM (Structural Similarity Index)

**What it is:** A perceptual image quality metric that evaluates structural similarity rather than pixel-level differences. Produces a score from -1 (anti-correlated) to 1 (identical).

**Formula:**
```
SSIM(x,y) = [(2*mu_x*mu_y + C1)(2*sigma_xy + C2)] / [(mu_x^2 + mu_y^2 + C1)(sigma_x^2 + sigma_y^2 + C2)]
```

Where:
- `mu_x`, `mu_y` = mean pixel values (luminance comparison)
- `sigma_x`, `sigma_y` = standard deviations (contrast comparison)
- `sigma_xy` = covariance (structure comparison)
- `C1 = (0.01 * L)^2`, `C2 = (0.03 * L)^2` (stabilization constants, L = dynamic range)

**Three components:**
1. **Luminance (l):** Compares mean brightness
2. **Contrast (c):** Compares variation in intensity
3. **Structure (s):** Compares spatial dependencies/patterns

**Window:** Typically an 11x11 Gaussian sliding window or 8x8 block window, applied across the entire image to produce a quality map. The mean of the map is the final SSIM score.

**MS-SSIM variant:** Multi-Scale SSIM operates at multiple resolution scales through subsampling, mimicking how human vision processes images at different viewing distances. More robust but slower.

**Node.js implementations:**
- `ssim.js` (obartra/ssim) -- archived Dec 2023, 318 stars. Pure JS. Two modes: 'bezkrovny' (fast, optimized) and 'fast' (higher precision, confusingly named).
- `jest-image-snapshot` supports SSIM via `comparisonMethod: 'ssim'` with the bezkrovny algorithm as default.

**When to use SSIM vs pixelmatch:**
- SSIM is better at catching structural/layout shifts while ignoring minor pixel noise
- pixelmatch is better at catching specific pixel-level changes (exact color, individual element)
- SSIM reduces false positives from font smoothing by ~60-80% compared to raw pixel diff
- SSIM is ~3-5x slower than pixelmatch for same image size

**Recommended thresholds:**
- SSIM >= 0.99: Essentially identical (use for strict mode)
- SSIM >= 0.95: Visually identical to human eye (use for standard mode)
- SSIM < 0.90: Clearly different

**Sources:**
- https://en.wikipedia.org/wiki/Structural_similarity_index_measure
- https://github.com/obartra/ssim
- https://github.com/americanexpress/jest-image-snapshot/issues/201

### 2.3 CIEDE2000 (Color Distance)

**What it is:** The most perceptually uniform color difference formula, developed by the CIE in 2000. Operates in CIELAB color space.

**Why it matters:** Simple Euclidean RGB distance is perceptually non-uniform -- a delta of 10 in blue looks very different from a delta of 10 in green. CIEDE2000 corrects for this with five compensations:

1. **Lightness weighting (SL):** Non-linear compensation based on L* value
2. **Chroma weighting (SC):** Adjusts for saturation levels
3. **Hue weighting (SH):** Compensates based on hue angle and chroma
4. **Hue rotation (RT):** Special handling for the problematic blue region (~275 degrees hue)
5. **Neutral color compensation:** Primed values for achromatic colors

**Thresholds:**
- Delta E <= 1.0: Not perceptible to human eye (JND = Just Noticeable Difference)
- Delta E <= 2.3: Revised JND for CIE76 (current understanding)
- Delta E <= 5.0: Acceptable in printing industry
- Delta E < 0.5: Required for automotive paint matching

**Computational cost:** Significantly more expensive than Euclidean RGB or YIQ. Requires RGB->Lab conversion, then arctan, exponential, and multiple conditional branches. Roughly 10-20x more expensive per pixel than pixelmatch's YIQ approach.

**Relevance to Safari Pilot:** CIEDE2000 is overkill for per-pixel comparison (too slow). Better used as a secondary metric: compute average color distance across changed regions to classify whether differences are perceptually significant. Can serve as a "human would notice this" filter.

**Sources:**
- https://en.wikipedia.org/wiki/CIEDE2000

### 2.4 Perceptual Hashing (pHash)

**What it is:** Generates a compact hash (64-256 bits) representing the overall visual appearance of an image. Similar images produce similar hashes even with minor differences.

**Algorithm (typical dHash/pHash):**
1. Resize image to small fixed size (e.g., 8x8 or 32x32)
2. Convert to grayscale
3. Apply DCT (Discrete Cosine Transform) for pHash, or compare adjacent pixels for dHash
4. Threshold coefficients to produce binary hash

**Comparison:** Hamming distance between two hashes. Distance 0 = identical, distance > 10 = visually different.

**Use in visual regression:** Perceptual hashing is a **triage tool**, not a comparison tool. Use it as a fast pre-filter:
- Hash distance 0: Skip full diff entirely (images are virtually identical)
- Hash distance 1-5: Minor change, run full diff
- Hash distance > 10: Major change, definitely run full diff

This saves significant compute time in large test suites where most screenshots haven't changed between runs.

**Node.js libraries:** `imghash`, `sharp-phash`, `blockhash-js`

**Sources:**
- https://www.npmjs.com/package/imghash
- https://en.wikipedia.org/wiki/Perceptual_hashing

### 2.5 Algorithm Decision Matrix

| Scenario | Primary Algorithm | Secondary | Threshold |
|---|---|---|---|
| Text-heavy pages | pixelmatch (AA on, threshold 0.15-0.2) | SSIM >= 0.98 | maxDiffPixelRatio < 0.01 |
| Layout/structural checks | SSIM | -- | SSIM >= 0.95 |
| Color-critical UI (brand) | pixelmatch (threshold 0.05) + CIEDE2000 | -- | maxDiffPixels < 50 |
| Large test suites (triage) | pHash (Hamming distance) | pixelmatch (on mismatch) | hash distance > 3 |
| Cross-environment (CI vs local) | pixelmatch (threshold 0.2) | SSIM >= 0.95 | maxDiffPixelRatio < 0.02 |

---

## 3. Retina / HiDPI Handling

### 3.1 The Problem

macOS Retina displays have a device pixel ratio (DPR) of 2.0. Safari's `screencapture` produces 2x resolution images. A 1440x900 viewport produces a 2880x1800 screenshot. This creates three challenges:

1. **Storage:** 2x images are ~4x the file size (4x pixels)
2. **Cross-environment consistency:** CI runners may have DPR 1.0 (no display) or 2.0 (macOS runners with virtual display)
3. **Comparison validity:** Comparing a 2x screenshot against a 1x baseline is meaningless

### 3.2 Safari Pilot's Current Screenshot Mechanism

From `src/tools/extraction.ts`:
```typescript
execFile('screencapture', ['-x', '-t', screenshotFormat, tmpFile], { timeout: 10000 }, ...);
```

The `screencapture` CLI captures at the native display resolution. On Retina Macs, this is always 2x. There is no flag to force 1x capture.

### 3.3 Strategy: Store at 2x, Normalize When Needed

**Recommendation:** Store baselines at native 2x resolution. This preserves maximum fidelity for detecting sub-pixel rendering differences that Safari is known for. Normalize to 1x only when comparing across environments with different DPRs.

**Rationale:**
- Safari Pilot is macOS-only, so most users have Retina displays
- CI on macOS runners (GitHub Actions `macos-14`) also has 2x virtual displays
- Storing at 2x catches subtle font rendering differences that 1x would blur away
- If a user's CI has 1x DPR, normalize the captured screenshot UP or the baseline DOWN at comparison time

### 3.4 Normalization with sharp

```javascript
import sharp from 'sharp';

// Deterministic 2x -> 1x downscale
async function normalizeToOnex(buffer) {
  const metadata = await sharp(buffer).metadata();
  return sharp(buffer)
    .resize(Math.round(metadata.width / 2), Math.round(metadata.height / 2), {
      kernel: 'lanczos3',   // highest quality downsampling
      fit: 'fill',          // exact dimensions, no aspect ratio games
      fastShrinkOnLoad: false  // disable JPEG shrink-on-load for determinism
    })
    .toColorspace('srgb')   // normalize color space
    .removeAlpha()           // flatten transparency
    .flatten({ background: { r: 255, g: 255, b: 255 } })  // white background
    .png({ compressionLevel: 6, effort: 1 })  // deterministic PNG encoding
    .toBuffer();
}
```

**Critical details:**
- Always use `lanczos3` kernel for downscaling -- it produces the sharpest results with minimal aliasing
- `fastShrinkOnLoad: false` ensures consistent output regardless of input format
- Color space normalization to sRGB prevents color profile differences across machines
- PNG compression settings should be deterministic (same level/effort always)

### 3.5 DPR Detection and Metadata

Every screenshot should capture and store its DPR alongside the image:

```javascript
// In the capture step
const dpr = await page.evaluate(() => window.devicePixelRatio);
const screenshot = await capture();
const metadata = await sharp(screenshot).metadata();

return {
  buffer: screenshot,
  dpr,
  width: metadata.width,     // actual pixel width
  height: metadata.height,   // actual pixel height
  cssWidth: metadata.width / dpr,   // logical CSS width
  cssHeight: metadata.height / dpr,
};
```

Before comparison, assert DPR matches:
```javascript
if (baseline.dpr !== capture.dpr) {
  // Normalize both to the same resolution before comparing
  // Or fail with clear error message
}
```

### 3.6 CI Runner Considerations

| Runner | Display | DPR | Notes |
|---|---|---|---|
| GitHub Actions `macos-14` | Virtual Retina | 2.0 | Consistent with local dev Macs |
| GitHub Actions `macos-13` | Virtual Retina | 2.0 | Older macOS, possible font diffs |
| Self-hosted Mac Mini | Physical display | 2.0 | Most reliable |
| Self-hosted (headless) | No display | 1.0 | Will produce 1x screenshots |
| Linux runners | N/A | N/A | Cannot run Safari at all |

**Recommendation:** Pin CI runners to a specific macOS version (`macos-14`) and assert DPR at test start. Fail fast if DPR mismatch detected.

**Sources:**
- https://sharp.pixelplumbing.com/api-resize
- https://sharp.pixelplumbing.com/performance
- Safari Pilot source: `src/tools/extraction.ts`

---

## 4. Baseline Management

### 4.1 Storage Options

#### Git (Direct)
- **Pros:** Simplest. No extra infrastructure. Versioned with code.
- **Cons:** Bloats repository. Binary diffs are opaque. Clone times increase.
- **Limit:** Practical up to ~50-100 baselines (< 100MB total).

#### Git LFS
- **Pros:** Keeps repo lean. LFS objects stored on GitHub/GitLab server. Standard Git workflow.
- **Cons:** Every CI job must download LFS objects (network overhead). LFS bandwidth quotas on GitHub. Still scales poorly past ~500MB.
- **Limit:** Practical up to ~200-500 baselines.

#### Cloud Artifact Store (S3/GCS)
- **Pros:** Unlimited scale. Versioning built in. Fine-grained IAM. Lifecycle policies for cost management. Faster CI (no LFS checkout).
- **Cons:** Extra infrastructure. Requires sync tooling.
- **Limit:** Effectively unlimited.

#### Recommendation by Scale

| Team Size | Baseline Count | Storage |
|---|---|---|
| Solo / 1-3 devs | < 100 | Git (direct) or Git LFS |
| 4-10 devs | 100-500 | Git LFS |
| 10+ devs | 500+ | S3/GCS with reg-suit or custom sync |

### 4.2 Safari Pilot's Approach

Safari Pilot should support a **pluggable baseline adapter** with two built-in implementations:

1. **Local filesystem (default):** Baselines stored in `<project>/.safari-pilot/baselines/`. Committed to Git or Git LFS by user choice. Zero config.

2. **S3-compatible store (optional):** For teams that need it. Configure via:
   ```json
   {
     "visual": {
       "baselineStore": {
         "type": "s3",
         "bucket": "my-baselines",
         "prefix": "safari-pilot/",
         "region": "us-east-1"
       }
     }
   }
   ```

### 4.3 Baseline Naming Convention

```
<baselines-dir>/
  <test-name>/
    <snapshot-name>-<theme>-<macos-version>.png
    <snapshot-name>-<theme>-<macos-version>.meta.json
```

Example:
```
.safari-pilot/baselines/
  homepage/
    hero-section-light-macos14.png
    hero-section-light-macos14.meta.json
    hero-section-dark-macos14.png
    hero-section-dark-macos14.meta.json
```

The `.meta.json` stores: `{ dpr, width, height, cssWidth, cssHeight, macosVersion, safariVersion, capturedAt, pHash }`.

### 4.4 Baseline Update Workflow

Modeled on Playwright's approach:

```bash
# Update all baselines
safari-pilot test --update-baselines

# Update baselines for specific test
safari-pilot test --update-baselines --grep "homepage"

# Interactive review before update
safari-pilot test --update-baselines --interactive
```

The `--interactive` flag shows each diff and prompts accept/reject, similar to `git add -p` for visual changes.

### 4.5 Branch-Specific Baselines

For feature branches that intentionally change UI:
1. Developer runs tests, gets failures
2. Reviews diffs, runs `--update-baselines` for accepted changes
3. New baselines committed to the feature branch
4. On merge to main, the updated baselines become the new truth
5. Other branches rebase to pick up new baselines

For long-lived branches (release branches), maintain separate baseline directories per branch in cloud storage.

**Sources:**
- Playwright docs: https://playwright.dev/docs/test-snapshots
- reg-suit: https://github.com/reg-viz/reg-suit

---

## 5. Diff Image Generation & Review

### 5.1 Visualization Techniques

#### Highlighted Diff Mask
Overlay colored pixels on a transparent or dimmed version of the original image. Changed pixels shown in magenta/red, AA pixels in yellow, unchanged pixels dimmed.

This is what pixelmatch generates natively. It is the most common and immediately useful visualization.

**Implementation:** Direct pixelmatch output buffer rendered as PNG.

#### Side-by-Side
Three panels: Baseline | Diff Mask | Actual. Allows comparing the original intent against what was rendered.

**Implementation:** Composite three images horizontally using sharp:
```javascript
const composite = sharp({
  create: { width: width * 3, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
})
.composite([
  { input: baselineBuffer, left: 0, top: 0 },
  { input: diffBuffer, left: width, top: 0 },
  { input: actualBuffer, left: width * 2, top: 0 },
])
.png().toBuffer();
```

#### Overlay / Alpha Blend
Superimpose actual on baseline with adjustable opacity. Good for detecting positional shifts.

**Implementation:** Use sharp's `composite` with `blend: 'over'` and adjusted alpha.

#### Blink / Flicker
Rapidly alternate between baseline and actual. The human eye is exceptionally good at detecting differences in temporal flicker, even sub-pixel changes.

**Implementation:** Cannot be a static image. Requires either:
- Animated GIF (2-3 fps alternation)
- HTML report with JavaScript toggle (preferred)

**This is the most effective technique for Safari's subtle font/AA differences.** The deep research specifically recommends it for Safari visual regression review.

### 5.2 Output Format: Self-Contained HTML Report

Generate a single HTML file with embedded images (base64 data URIs) containing:

1. Summary table: test name, status (pass/fail), diff pixel count, diff percentage, SSIM score
2. For each failure:
   - Three-panel composite (static, always visible)
   - Interactive controls: overlay slider, blink toggle, zoom
   - Metadata: DPR, macOS version, Safari version, threshold used
3. Keyboard navigation: arrow keys to move between failures, Enter to approve

**Reference implementations:**
- BackstopJS HTML report: side-by-side + diff mask + overlay toggle
- reg-suit report: hosted static HTML with diff views
- Percy dashboard: overlay slider + blink toggle (SaaS only)

### 5.3 Accessibility of Review Tools

- Use cyan (#00BCD4) for additions and magenta (#E91E63) for removals (color-blind safe)
- Never rely on color alone -- add pattern overlays (dots for additions, stripes for removals)
- Full keyboard navigation for all controls
- ARIA labels on all interactive elements
- High-contrast mode option

**Sources:**
- BackstopJS: https://github.com/garris/BackstopJS
- Percy: https://www.browserstack.com/percy
- reg-suit: https://github.com/reg-viz/reg-suit

---

## 6. Safari-Specific Rendering Challenges

### 6.1 Font Rendering History on macOS

This is the single biggest source of visual regression false positives on Safari.

**Timeline of changes:**
- **Pre-Mojave (< 10.14):** Full sub-pixel anti-aliasing (LCD font smoothing). Borrowed color from adjacent pixels. Text appeared sharp on non-Retina screens but produced pixel-level artifacts.
- **Mojave (10.14, 2018):** Apple removed sub-pixel anti-aliasing by default. Switched to grayscale smoothing. `defaults write -g CGFontRenderingFontSmoothingDisabled -bool NO` could re-enable it. This single change broke every visual regression baseline in existence for Safari.
- **Catalina (10.15, 2019):** The terminal command to re-enable sub-pixel AA was completely removed. Grayscale smoothing only.
- **Ventura (13, 2022) through Sequoia (15, 2024):** Incremental refinements to grayscale smoothing. No dramatic changes but subtle per-version pixel differences persist.

**Impact:** Two machines running the same Safari version on different macOS versions (e.g., macOS 13 vs 14) can produce different pixel patterns for identical text. This means **macOS version must be part of the baseline key**.

**Sources:**
- https://www.reddit.com/r/apple/comments/8wpk18/macos_mojave_nukes_subpixel_antialiasing_making/
- https://discussions.apple.com/thread/250998388
- https://stackoverflow.com/questions/71957671/safari-font-rendering-seems-to-be-different-than-in-other-browsers

### 6.2 CSS Mitigations

Apply these CSS rules in the page before capturing screenshots to maximize determinism:

```css
/* Force grayscale smoothing (most consistent across macOS versions) */
* {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Disable animations and transitions */
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
}

/* Hide blinking cursors */
* { caret-color: transparent !important; }

/* Force explicit backgrounds (prevents system theme bleed) */
html { background-color: #ffffff; }
```

Safari Pilot should inject this CSS automatically before every visual comparison screenshot, similar to Playwright's `stylePath` mechanism.

### 6.3 Light/Dark Mode

macOS system appearance directly affects Safari rendering. `prefers-color-scheme` media queries cause wholesale visual changes. Even elements without explicit dark mode styling can change due to Safari's automatic dark mode adjustments to form controls and scrollbars.

**Strategy:** Maintain separate baselines for light and dark mode. Force color scheme during capture:

```javascript
// Via JavaScript injection before screenshot
await page.evaluate(() => {
  document.documentElement.style.colorScheme = 'light';
});
```

Or via media query emulation if available through the automation engine.

### 6.4 Other Safari-Specific Gotchas

- **Scrollbar appearance:** Safari uses overlay scrollbars that can appear/disappear based on input method (trackpad vs mouse). Force hide scrollbars during capture.
- **System accent color:** macOS allows users to change the system accent color, which affects Safari form controls. Force a specific accent or mask form elements.
- **Display color profile:** Different Macs may have different color profiles (Display P3 vs sRGB). Normalize to sRGB in the preprocessing step.
- **WebKit version:** Safari's WebKit version is tied to macOS updates. Safari 17.0 on macOS 14 may render differently from Safari 17.0 on macOS 13 (yes, the same Safari version).

---

## 7. Performance Considerations

### 7.1 Image Sizes

| Scenario | Resolution | Pixels | PNG Size (approx) |
|---|---|---|---|
| Viewport 1440x900 @ 1x | 1440x900 | 1.3M | 0.5-2 MB |
| Viewport 1440x900 @ 2x | 2880x1800 | 5.2M | 2-8 MB |
| Full page scroll @ 2x | 2880x8000 | 23M | 8-30 MB |

### 7.2 Library Benchmarks

**sharp (libvips):**
- JPEG resize: 64.42 ops/sec (26.8x faster than jimp)
- PNG resize: 28.70 ops/sec (4.7x faster than ImageMagick)
- Memory: Streaming/tile-based, low footprint even for large images
- Threading: Uses libuv thread pool, defaults to CPU core count
- Architecture: demand-driven pipeline, processes only what's needed

**pixelmatch:**
- Pure typed array operations, no image decode overhead
- 32-bit fast path for identical pixels
- For a 2880x1800 image (5.2M pixels): ~50-100ms on modern hardware
- Memory: 4 bytes/pixel * 3 buffers (img1, img2, diff) = ~62MB for 2x Retina viewport

**SSIM (bezkrovny):**
- 3-5x slower than pixelmatch for same image size
- Windowed computation (11x11 Gaussian) adds significant overhead
- For 2880x1800: ~200-500ms

### 7.3 Recommended Pipeline (Performance-Optimized)

```
Capture (screencapture)
    |
    v
Pre-process (sharp)           ~20-50ms
  - Normalize color space
  - Flatten alpha
  - Store DPR metadata
  - Generate pHash
    |
    v
Triage (pHash comparison)     ~0.1ms
  - Hamming distance 0? -> PASS (skip full diff)
  - Hamming distance > 0? -> continue
    |
    v
Full Diff (pixelmatch)        ~50-100ms
  - With AA detection
  - Threshold tuned for Safari (0.15-0.2)
  - Produces diff mask buffer
    |
    v
Secondary Metric (SSIM)       ~200-500ms (optional, only on failures)
  - Provides perceptual similarity score
  - Helps classify severity
    |
    v
Report Generation (sharp)     ~50-100ms per failure
  - Composite side-by-side image
  - Generate HTML report
```

**Total per screenshot (happy path, no change):** ~20-50ms (pHash match)
**Total per screenshot (with diff):** ~300-750ms
**Total per screenshot (full pipeline with SSIM):** ~500-1200ms

### 7.4 Batch Optimization

For large test suites:
- **Parallel comparison:** Use Node.js worker threads. Each comparison is independent.
- **Early termination:** If pHash triage passes, skip entirely (saves ~95% of compute for stable UIs)
- **Lazy SSIM:** Only compute SSIM for screenshots that fail the pixelmatch threshold. This avoids the 3-5x cost for passing tests.
- **sharp concurrency:** Set `sharp.concurrency(os.cpus().length)` for parallel image processing.
- **Memory management:** Process screenshots in batches of 10-20 to avoid OOM on machines with limited RAM. A single 2x Retina full-page screenshot can use 60-90MB of raw pixel data.

**Sources:**
- https://sharp.pixelplumbing.com/performance
- https://github.com/mapbox/pixelmatch (benchmarks)
- https://github.com/americanexpress/jest-image-snapshot (SSIM integration)

---

## 8. Recommended Architecture for Safari Pilot

### 8.1 New Dependencies

```json
{
  "dependencies": {
    "pixelmatch": "^6.0.0",
    "sharp": "^0.33.0",
    "pngjs": "^7.0.0"
  }
}
```

Notes:
- `pixelmatch` is ~150 lines, no deps, minimal footprint
- `sharp` has a native dependency (libvips) but pre-built binaries exist for macOS arm64/x64
- `pngjs` for PNG encode/decode to raw RGBA arrays (pixelmatch input format)
- SSIM can be implemented in ~50 lines without a library (avoiding the archived `ssim.js`)

### 8.2 Proposed API

```typescript
// MCP Tool: safari_visual_compare
{
  name: 'safari_visual_compare',
  description: 'Compare a screenshot against a baseline image for visual regression detection.',
  inputSchema: {
    type: 'object',
    properties: {
      baselinePath: { type: 'string', description: 'Path to baseline image' },
      actualPath: { type: 'string', description: 'Path to actual screenshot (or omit to capture now)' },
      diffOutputPath: { type: 'string', description: 'Where to save the diff image' },
      threshold: { type: 'number', default: 0.15, description: 'Per-pixel color sensitivity (0-1)' },
      maxDiffPixels: { type: 'integer', description: 'Max pixel count before failure' },
      maxDiffPixelRatio: { type: 'number', default: 0.01, description: 'Max diff ratio before failure (0-1)' },
      includeAA: { type: 'boolean', default: false, description: 'Count anti-aliased pixels as diffs' },
      normalizeDpr: { type: 'boolean', default: true, description: 'Normalize DPR differences' },
    },
    required: ['baselinePath']
  }
}

// MCP Tool: safari_update_baseline
{
  name: 'safari_update_baseline',
  description: 'Save current screenshot as the new baseline for visual regression testing.',
  inputSchema: {
    type: 'object',
    properties: {
      baselinePath: { type: 'string', description: 'Where to save the baseline' },
      theme: { type: 'string', enum: ['light', 'dark'], default: 'light' },
      injectCss: { type: 'boolean', default: true, description: 'Inject stabilization CSS before capture' },
    },
    required: ['baselinePath']
  }
}
```

### 8.3 Return Schema

```typescript
interface VisualCompareResult {
  pass: boolean;
  diffPixels: number;
  diffPixelRatio: number;     // 0-1
  totalPixels: number;
  ssimScore: number;           // 0-1 (computed only on failure)
  pHashDistance: number;        // Hamming distance
  diffImagePath: string | null;
  baselineMetadata: {
    dpr: number;
    width: number;
    height: number;
    macosVersion: string;
    safariVersion: string;
  };
  actualMetadata: {
    dpr: number;
    width: number;
    height: number;
    macosVersion: string;
    safariVersion: string;
  };
  dprNormalized: boolean;     // whether DPR normalization was applied
}
```

### 8.4 Comparison Modes (inspired by Applitools)

| Mode | pixelmatch threshold | maxDiffPixelRatio | SSIM threshold | Use case |
|---|---|---|---|---|
| `strict` | 0.1 | 0.001 | 0.995 | Pixel-perfect, brand-critical UI |
| `standard` | 0.15 | 0.01 | 0.98 | General visual regression (default) |
| `tolerant` | 0.25 | 0.05 | 0.95 | Cross-environment, font-heavy pages |
| `layout` | N/A (SSIM only) | N/A | 0.90 | Structural layout checks only |

### 8.5 File Structure

```
src/
  tools/
    visual-regression.ts       # MCP tool handlers
  visual/
    compare.ts                 # Core comparison pipeline
    baseline-store.ts          # Pluggable baseline adapter
    baseline-store-local.ts    # Local filesystem implementation
    baseline-store-s3.ts       # S3-compatible implementation
    preprocess.ts              # sharp-based normalization
    diff-report.ts             # HTML report generator
    phash.ts                   # Perceptual hashing
    ssim.ts                    # SSIM implementation (~50 lines)
    types.ts                   # Visual regression types
```

---

## 9. Sources

### Frameworks & Tools
- Playwright Visual Comparisons: https://playwright.dev/docs/test-snapshots
- pixelmatch: https://github.com/mapbox/pixelmatch
- jest-image-snapshot: https://github.com/americanexpress/jest-image-snapshot
- BackstopJS: https://github.com/garris/BackstopJS
- reg-suit: https://github.com/reg-viz/reg-suit
- Percy: https://www.browserstack.com/percy
- Applitools: https://applitools.com/

### Algorithms & Theory
- SSIM: https://en.wikipedia.org/wiki/Structural_similarity_index_measure
- CIEDE2000: https://en.wikipedia.org/wiki/CIEDE2000
- YIQ color distance (Kotsarenko & Ramos, 2010): referenced in pixelmatch source
- Anti-aliased pixel detector (Vyshniauskas, 2009): referenced in pixelmatch source
- Perceptual hashing: https://en.wikipedia.org/wiki/Perceptual_hashing

### Image Processing
- sharp: https://sharp.pixelplumbing.com/
- sharp performance: https://sharp.pixelplumbing.com/performance
- sharp resize API: https://sharp.pixelplumbing.com/api-resize
- pngjs: https://github.com/lukeapage/pngjs

### Safari Rendering
- macOS Mojave subpixel AA removal: https://www.reddit.com/r/apple/comments/8wpk18/
- Catalina font smoothing: https://discussions.apple.com/thread/250998388
- Safari font rendering differences: https://stackoverflow.com/questions/71957671
- Font weight issues in Safari: https://stackoverflow.com/questions/26510968
- Apple font rendering philosophy: https://blog.codinghorror.com/whats-wrong-with-apples-font-rendering/

### Image Comparison Libraries Survey
- SapientPro comparison survey: https://sapient.pro/blog/best-image-comparison-libraries
- ssim.js (archived): https://github.com/obartra/ssim
- Pixelmatch demo: https://observablehq.com/@mourner/pixelmatch-demo
