# P1: PDF Generation — Implementation Research

> Research for Safari Pilot's `safari_export_pdf` tool.
> Date: 2026-04-12

---

## TL;DR — Recommended Architecture

**Primary path: WKWebView.printOperationWithPrintInfo: via the Swift daemon.**

This combines Safari's native WebKit rendering with full control over margins, paper size, orientation, scale, page ranges, and output path — all programmatically, all headless, no dialogs. The daemon already exists and speaks NDJSON over stdin/stdout.

**Fallback path: WKWebView.createPDF(configuration:) for simple cases.**

Simpler API but limited configuration (only `rect` and `allowTransparentBackground`). Good for "just give me a PDF of this page" with no pagination control.

**Key competitive advantage: Playwright CANNOT generate PDFs from WebKit.** Its `page.pdf()` is Chromium-only. Safari Pilot would be the only tool that generates PDFs from real Safari/WebKit rendering.

---

## 1. Safari Print-to-PDF via AppleScript

### What the AppleScript Dictionary Actually Says

Safari includes the standard Cocoa `print` command (inherited from `CocoaStandard.sdef`):

```
Command: print (code=aevtpdoc)
  Description: Print a document.
  Parameters:
    - direct parameter: The file(s), document(s), or window(s) to be printed
    - with properties: print settings (type: print settings, optional)
    - print dialog: boolean (optional) — should the app show the print dialog?
```

The `print settings` record type supports:

| Property | Type | Description |
|----------|------|-------------|
| `copies` | integer | Number of copies |
| `collating` | boolean | Collate copies |
| `starting page` | integer | First page to print |
| `ending page` | integer | Last page to print |
| `pages across` | integer | Logical pages across physical page |
| `pages down` | integer | Logical pages down physical page |
| `error handling` | enum | Standard or detailed |
| `target printer` | text | Printer name |

**Safari does NOT have its own print command** — it relies entirely on the inherited Standard Suite.

### Tested Behaviors (Local, Safari 26.4 on macOS 26.4)

| Command | Result |
|---------|--------|
| `print front document` (no dialog param) | Opened print dialog |
| `print front document with print dialog` | Opened print dialog |
| `print front document with properties {target printer:"Save as PDF"} without print dialog` | Exit code 0, no visible dialog, but unclear if PDF was actually generated |
| `print front document with properties {target printer:"PDF"} without print dialog` | Exit code 0, similar ambiguity |

### The Dialog Problem

The standard AppleScript `print` command offers `without print dialog` to suppress the dialog. However:

1. **There is no `output path` parameter** in the standard print settings. Even with `target printer:"Save as PDF"`, there is no way to specify where the PDF goes.
2. macOS's "Save as PDF" is not a real CUPS printer — it is a special handler in the print framework that normally triggers a save dialog.
3. **Without a dialog, it is unclear where the PDF is saved** (if anywhere). This is fundamentally broken for automation.

### System Events UI Automation (Fragile Path)

The alternative is to let the print dialog appear and drive it via System Events:

```applescript
tell application "Safari" to print front document
tell application "System Events"
    tell process "Safari"
        click menu button "PDF" of window "Print"
        click menu item "Save as PDF…" of menu 1 of menu button "PDF" of window "Print"
        repeat until exists sheet 1 of window "Print"
            delay 0.2
        end repeat
        set value of text field 1 of sheet 1 of window "Print" to "/path/to/output.pdf"
        click button "Save" of sheet 1 of window "Print"
    end tell
end tell
```

**Problems:**
- Requires Accessibility + Automation TCC permissions
- UI element names are localized (breaks on non-English systems)
- Timing-dependent (elements may not exist yet)
- Print dialog layout changes between macOS versions
- Cannot run headlessly — dialog must be visible
- Cannot set margins, scale, paper size without further UI driving

### Safari "Export as PDF" Menu Item

Safari's File menu has `Export as PDF...` (confirmed via System Events inspection). This creates a **single continuous page** PDF (no pagination), which differs from Print-to-PDF (paginated). It triggers a save dialog that would also need UI automation.

**Verdict: AppleScript/System Events is the wrong path for Safari Pilot.** It is fragile, non-headless, and lacks parameter control.

---

## 2. Playwright's page.pdf() — Full Reference

### Parameters

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `path` | string | — | Output file path |
| `format` | string | `'Letter'` | Letter, Legal, Tabloid, Ledger, A0-A6 |
| `width` | string/number | — | Overrides format. Units: px, in, cm, mm |
| `height` | string/number | — | Overrides format |
| `landscape` | boolean | `false` | Paper orientation |
| `margin` | object | `{top:0, right:0, bottom:0, left:0}` | With units |
| `scale` | number | `1` | Range: 0.1 to 2.0 |
| `displayHeaderFooter` | boolean | `false` | Enable header/footer |
| `headerTemplate` | string | `''` | HTML with special classes |
| `footerTemplate` | string | `''` | HTML with special classes |
| `printBackground` | boolean | `false` | Include CSS backgrounds |
| `pageRanges` | string | `''` (all) | e.g., `'1-5, 8, 11-13'` |
| `preferCSSPageSize` | boolean | `false` | Honor CSS `@page size` |
| `tagged` | boolean | `false` | Accessible PDF (v1.42+) |
| `outline` | boolean | `false` | PDF bookmarks from headings (v1.42+) |

### Header/Footer Template Classes

Templates support these magic `class` attributes:
- `<span class="date"></span>` — formatted print date
- `<span class="title"></span>` — document title
- `<span class="url"></span>` — document URL
- `<span class="pageNumber"></span>` — current page
- `<span class="totalPages"></span>` — total pages

Templates are rendered in an isolated context. No script execution. No page CSS inheritance. Inline styles only.

### Internal Implementation (Source: `crPdf.ts`)

Playwright's PDF generation is **Chromium-only**. The implementation:

1. Maps paper formats to dimensions in inches (Letter = 8.5x11, A4 = 8.27x11.7, etc.)
2. Converts margin values from CSS units to inches (px/96, cm/2.54, mm/25.4)
3. Sends a single CDP command: `Page.printToPDF` with all parameters
4. Reads the result via `readProtocolStream`

```typescript
// From packages/playwright-core/src/server/chromium/crPdf.ts
const result = await this._client.send('Page.printToPDF', {
    transferMode: 'ReturnAsStream',
    landscape, displayHeaderFooter, headerTemplate, footerTemplate,
    printBackground, scale, paperWidth, paperHeight,
    marginTop, marginBottom, marginLeft, marginRight,
    pageRanges, preferCSSPageSize, generateTaggedPDF, generateDocumentOutline
});
```

### Critical Finding: WebKit PDF is NOT Supported

In `page.ts`, the `pdf` method is **optional** on the `PageDelegate` interface:

```typescript
pdf?: (options: channels.PagePdfParams) => Promise<Buffer>;
```

The WebKit page delegate (`wkPage.ts`) does NOT implement it. **Playwright cannot generate PDFs from WebKit.**

This is a structural advantage for Safari Pilot.

---

## 3. WebKit/Safari PDF Rendering Behavior

### CSS @media print

Safari respects `@media print` rules. Default behavior suppresses background graphics and colors (overridable with `-webkit-print-color-adjust: exact`).

### CSS @page Support

| Feature | Safari Support | Notes |
|---------|---------------|-------|
| `@page` rule | Since Safari 18.2 | Very recent (late 2024) |
| `@page size` | Since Safari 18.2 | Not supported in earlier versions |
| `@page margins` | Since Safari 18.2 | May be overridden by printer settings |
| `@page` named pages | Limited | Inconsistent |
| `marks`, `bleed` | No | No browser supports these |

**Important:** Safari 18.2+ represents a major improvement. Earlier Safari versions had essentially no `@page` support. Since Safari Pilot targets current macOS (which has Safari 26.4+), full `@page` support is available.

### Known Rendering Issues

| Issue | Safari Behavior | Chrome Behavior |
|-------|----------------|-----------------|
| `position: fixed` | Inconsistent — may appear on every page, first page only, or be clipped | Reliably rendered on each page |
| `position: sticky` | Treated as `static` in print | Also degrades to `static` |
| `position: absolute` | Can split awkwardly across pages | Similar but more predictable |
| `overflow: hidden` | May incorrectly clip content across pages | More robust handling |
| Page breaks | Respects `break-before/after/inside` but pagination differs from Chrome | Different break decisions |
| Font rendering | Uses macOS Core Text — different metrics than Chrome/Skia | Uses Skia/FreeType |

**Workaround for overflow clipping:** Set `overflow: visible !important` in print stylesheet.

---

## 4. The Recommended Path: Native APIs via the Swift Daemon

### Option A: WKWebView.createPDF (Simple Path)

```swift
// Available: macOS 11.0+ (Big Sur), iOS 14.0+
func createPDF(configuration: WKPDFConfiguration?, completionHandler: (Data?, Error?) -> Void)

// Async version (macOS 12.0+)
func pdf(configuration: WKPDFConfiguration) async throws -> Data
```

**WKPDFConfiguration** (from header analysis):

| Property | Type | Default | Available |
|----------|------|---------|-----------|
| `rect` | `CGRect` | `CGRect.null` (full page) | macOS 10.15.4+ |
| `allowTransparentBackground` | `Bool` | `false` | macOS 14.0+ |

**Limitations:**
- No margins control
- No paper size control
- No scale control
- No page ranges
- No header/footer
- Captures the page as a single continuous PDF (like "Export as PDF")

**Use case:** Quick PDF capture of visible content. Not suitable as Playwright parity.

### Option B: WKWebView.printOperationWithPrintInfo (Full-Featured Path) ★ RECOMMENDED

```swift
// Available: macOS 11.0+
func printOperation(with printInfo: NSPrintInfo) -> NSPrintOperation
```

**NSPrintInfo** provides complete control (from AppKit header analysis):

| Property Key | Type | Purpose |
|-------------|------|---------|
| `NSPrintPaperSize` | NSSize (points) | Paper dimensions |
| `NSPrintOrientation` | enum | Portrait (0) or Landscape (1) |
| `NSPrintScalingFactor` | float | Scale percentage |
| `NSPrintTopMargin` | float (points) | Top margin |
| `NSPrintBottomMargin` | float (points) | Bottom margin |
| `NSPrintLeftMargin` | float (points) | Left margin |
| `NSPrintRightMargin` | float (points) | Right margin |
| `NSPrintJobDisposition` | string | **Set to `NSPrintSaveJob` for PDF** |
| `NSPrintJobSavingURL` | NSURL | **Output file path** |
| `NSPrintAllPages` | boolean | Print all pages |
| `NSPrintFirstPage` | integer | First page (1-based) |
| `NSPrintLastPage` | integer | Last page (1-based) |
| `NSPrintCopies` | integer | Number of copies |
| `NSPrintHeaderAndFooter` | boolean | Show header/footer |
| `NSPrintHorizontalPagination` | enum | Auto, Fit, or Clip |
| `NSPrintVerticalPagination` | enum | Auto, Fit, or Clip |

**The key insight:** Setting `NSPrintJobDisposition` to `NSPrintSaveJob` and `NSPrintJobSavingURL` to a file URL makes the print operation write directly to a PDF file — no dialog, no printer, completely headless.

**Standard paper sizes (in points, 72pt = 1 inch):**

| Format | Width | Height |
|--------|-------|--------|
| Letter | 612 | 792 |
| Legal | 612 | 1008 |
| A4 | 595.28 | 841.89 |
| A3 | 841.89 | 1190.55 |
| Tabloid | 792 | 1224 |

### Implementation Sketch for the Swift Daemon

```swift
import WebKit
import AppKit

func generatePDF(
    webView: WKWebView,
    outputPath: String,
    paperSize: NSSize = NSSize(width: 612, height: 792), // Letter
    margins: NSEdgeInsets = NSEdgeInsets(top: 72, left: 72, bottom: 72, right: 72), // 1 inch
    landscape: Bool = false,
    scale: CGFloat = 1.0,
    pageRanges: (first: Int, last: Int)? = nil
) throws {
    let printInfo = NSPrintInfo()

    // Paper & orientation
    printInfo.paperSize = paperSize
    printInfo.orientation = landscape ? .landscape : .portrait
    printInfo.scalingFactor = scale

    // Margins (in points)
    printInfo.topMargin = margins.top
    printInfo.bottomMargin = margins.bottom
    printInfo.leftMargin = margins.left
    printInfo.rightMargin = margins.right

    // Output to file (no dialog)
    printInfo.jobDisposition = .save
    printInfo.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] =
        URL(fileURLWithPath: outputPath)

    // Page ranges
    if let ranges = pageRanges {
        printInfo.dictionary()[NSPrintInfo.AttributeKey("NSPrintAllPages")] = false
        printInfo.dictionary()[NSPrintInfo.AttributeKey("NSPrintFirstPage")] = ranges.first
        printInfo.dictionary()[NSPrintInfo.AttributeKey("NSPrintLastPage")] = ranges.last
    }

    // Generate
    let printOp = webView.printOperation(with: printInfo)
    printOp.showsPrintPanel = false
    printOp.showsProgressPanel = false
    printOp.run()
}
```

### The WKWebView Challenge

The daemon currently does NOT have a WKWebView instance — it communicates with Safari via AppleScript and the Safari Web Extension. There are two approaches:

**Approach 1: Create a hidden WKWebView in the daemon**
- The daemon creates a WKWebView, loads the same URL that Safari has open
- Generates PDF from this WKWebView
- Pro: Full API access to NSPrintInfo/printOperation
- Con: Requires re-loading the page (extra network request, may miss auth state)
- Con: Daemon needs to run with a connection to WindowServer (needs a GUI context even if hidden)

**Approach 2: Use Safari's own print infrastructure via AppleScript + NSPrintInfo**
- Have the daemon invoke `osascript` to tell Safari to print, but programmatically configure the print settings
- Pro: Uses Safari's actual page state (auth, cookies, JS state)
- Con: Less control, AppleScript print settings are limited

**Approach 3 (Hybrid, Recommended): JavaScript-based content extraction + WKWebView rendering**
- Use the Safari Web Extension to extract the page HTML/CSS
- Load it into a daemon-side WKWebView
- Generate PDF with full NSPrintInfo control
- Pro: Gets the actual rendered content, full API control
- Con: May not perfectly replicate the page (external resources, CORS)

**Approach 4 (Simplest MVP): AppleScript print + cupsfilter post-processing**
- Use `tell application "Safari" to print front document with properties {target printer:"Save as PDF"} without print dialog`
- If Safari writes to a default location, move the file
- Post-process with `qpdf` for margins/encryption if needed
- Pro: Simplest to implement, uses Safari's real rendering
- Con: Uncertain output path, limited parameter control

### Recommended Strategy: Tiered Implementation

**Tier 1 (MVP — half session):**
Use the existing AppleScript engine. Tell Safari to print. Drive the print dialog via System Events only if needed. For "just make a PDF" this is sufficient. Limitations documented clearly.

**Tier 2 (Full-featured — 1-2 sessions):**
Add a WKWebView to the Swift daemon. When `safari_export_pdf` is called:
1. Extension extracts the serialized page HTML (already possible with `safari_get_page_source`)
2. Daemon loads HTML into its WKWebView
3. Daemon uses `printOperationWithPrintInfo` with full NSPrintInfo configuration
4. Returns the PDF path, page count, file size

This gives us Playwright-level control with real WebKit rendering.

---

## 5. Header/Footer Templates

### Safari's Native Support

Safari's print-to-PDF can include basic headers/footers (page URL, date, page numbers) via the system print dialog's "Header & Footer" checkbox. This is NOT customizable — it is system-controlled.

The `NSPrintHeaderAndFooter` key controls this boolean in NSPrintInfo.

### CSS @page Margin Boxes

CSS Paged Media Level 3 defines margin boxes for headers/footers:

```css
@page {
  @top-center {
    content: "Document Title";
    font-size: 10px;
  }
  @bottom-right {
    content: "Page " counter(page) " of " counter(pages);
    font-size: 10px;
  }
}
```

**Safari support:** Limited. The `@page` rule itself is supported since Safari 18.2, but margin box support (`@top-center`, `@bottom-left`, etc.) is inconsistent across browsers and may not work in Safari.

### Recommended Approach for Safari Pilot

For custom headers/footers, inject HTML elements into the page before printing:

```javascript
// Inject header/footer via the extension before PDF generation
const header = document.createElement('div');
header.className = 'safari-pilot-pdf-header';
header.innerHTML = headerTemplate
  .replace(/class="pageNumber"/g, 'data-sp-page-number')
  .replace(/class="totalPages"/g, 'data-sp-total-pages');
header.style.cssText = 'position: fixed; top: 0; width: 100%; z-index: 999999;';
document.body.prepend(header);
```

For `pageNumber`/`totalPages` tokens: these would need to be populated after PDF generation (via post-processing with a PDF library) or approximated via CSS `counter(page)`.

**Realistic assessment:** Full Playwright-style header/footer templates with page number tokens are hard to replicate exactly. For MVP, support custom HTML injection with CSS `position: fixed` (which Safari renders on each page in recent versions). Page numbering via CSS counters as best-effort.

---

## 6. Edge Cases

### Multi-page Documents
- WKWebView's `printOperationWithPrintInfo` handles pagination automatically
- `createPDF` produces a single continuous page (no pagination)
- Page count can be detected post-generation via `pdfinfo` (poppler-utils) or PDFKit in Swift
- CSS `break-before`/`break-after`/`break-inside` are respected

### Infinite Scroll Pages
- Browser print engines paginate based on content height
- Infinite scroll pages that lazy-load will only capture what is currently loaded
- Strategy: Scroll to bottom first (via `safari_scroll`), wait for all content to load, then generate PDF
- Or: Set a `max-height` in print CSS and use explicit break points

### SVG Elements
- WebKit renders SVGs as vectors in PDF — crisp at any zoom
- Complex SVGs with filters or animations may not render correctly in print

### Canvas Elements
- Canvas content is rasterized in the PDF (bitmap)
- Resolution depends on the canvas's intrinsic dimensions, not CSS display size
- For higher quality: call `canvas.toDataURL()` at higher resolution before printing

### Web Fonts
- Safari uses macOS Core Text for font rendering
- Fonts loaded via `@font-face` are generally embedded in the PDF
- System fonts are embedded/subsetted by the OS graphics engine
- For reliability: use `document.fonts.ready` promise before generating PDF

### Password-Protected PDFs
- Not possible natively — requires post-processing
- `qpdf --encrypt USER_PASS OWNER_PASS 256 -- input.pdf output.pdf`
- Can also use `PDFDocument` in Swift to set password via `write(to:withOptions:)` with `.ownerPasswordOption` and `.userPasswordOption`

### PDF/A Compliance
- Not available from browser rendering engines
- Requires Ghostscript post-processing: `gs -dPDFA=2 -sColorConversionStrategy=UseDeviceIndependentColor ...`
- Validate with `veraPDF`

---

## 7. API Design Recommendation

Based on this research, the `safari_export_pdf` tool should have this interface:

```typescript
interface SafariExportPdfParams {
  // Required
  path: string;              // Output file path

  // Paper
  format?: string;           // 'Letter' | 'Legal' | 'A4' | 'A3' | 'Tabloid' etc.
  width?: string;            // Custom width with units (e.g., '8.5in', '210mm')
  height?: string;           // Custom height with units
  landscape?: boolean;       // Default: false

  // Margins
  margin?: {
    top?: string;            // e.g., '1in', '2.54cm', '72px'
    right?: string;
    bottom?: string;
    left?: string;
  };

  // Rendering
  scale?: number;            // 0.1 to 2.0, default 1.0
  printBackground?: boolean; // Default: false
  pageRanges?: string;       // e.g., '1-5, 8, 11-13'

  // Headers/footers (Tier 2)
  displayHeaderFooter?: boolean;
  headerTemplate?: string;   // HTML string
  footerTemplate?: string;   // HTML string

  // Advanced (Tier 2+)
  preferCSSPageSize?: boolean;
  waitForFonts?: boolean;    // Wait for document.fonts.ready
}

interface SafariExportPdfResult {
  path: string;
  pageCount: number;
  fileSize: number;          // bytes
  elapsed_ms: number;
}
```

This mirrors Playwright's API for developer familiarity while being achievable via the native macOS APIs.

---

## 8. Effort Estimate (Revised)

| Phase | Work | Sessions |
|-------|------|----------|
| **Tier 1 MVP** | AppleScript `print` with `without print dialog`, basic output path handling, format/landscape params | 0.5 |
| **Tier 2 Full** | WKWebView in daemon, NSPrintInfo full config, margin/scale/pageRanges, page count detection | 1-2 |
| **Tier 3 Headers** | HTML injection for headers/footers, CSS counter-based page numbers | 0.5-1 |
| **Total** | | **2-3.5** |

The roadmap estimate of "half session" is realistic for Tier 1 only. Full Playwright parity requires Tier 2.

---

## Sources

- Safari AppleScript dictionary (`sdef /Applications/Safari.app`) — local inspection
- macOS CocoaStandard.sdef (`/System/Library/ScriptingDefinitions/CocoaStandard.sdef`) — local inspection
- WKWebView.h header — Xcode SDK, macOS platform
- WKPDFConfiguration.h header — Xcode SDK
- NSPrintInfo.h header — AppKit framework, macOS SDK
- Playwright source: `packages/playwright-core/src/server/chromium/crPdf.ts` — [GitHub](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/crPdf.ts)
- Playwright source: `packages/playwright-core/src/server/page.ts` (pdf optional interface)
- Playwright docs: [page.pdf()](https://playwright.dev/docs/api/class-page#page-pdf)
- Can I Use: [CSS Paged Media](https://caniuse.com/css-paged-media) — Safari 18.2+ support
- Can I Use: [@page size](https://caniuse.com/mdn-css_at-rules_page_size) — Safari 18.2+ support
- wkhtmltopdf status: [wkhtmltopdf.org/status.html](https://wkhtmltopdf.org/status.html) — archived, unmaintained
- Parallel Deep Research: `safari-pdf-generation.md` / `safari-pdf-generation.json` — multi-source analysis
- Apple WKWebView docs: `createPDF(configuration:completionHandler:)` — macOS 11.0+
- Apple NSPrintInfo docs: `NSPrintSaveJob`, `NSPrintJobSavingURL` — programmatic PDF save
