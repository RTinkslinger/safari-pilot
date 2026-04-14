import Foundation
import WebKit
import AppKit
import PDFKit

// MARK: - Public Types

/// Result of a successful PDF generation.
public struct PdfResult: Sendable {
    public let path: String
    public let pageCount: Int
    public let fileSize: Int
    public let warnings: [String]
}

/// Errors specific to PDF generation.
public enum PdfError: Error, Sendable {
    case invalidOutputPath(String)
    case loadFailed(String)
    case generationFailed(String)
    case timeout
    case emptyPdf
}

// MARK: - PdfGenerator

/// Single-use PDF renderer: loads HTML or URL into a hidden WKWebView, waits for
/// navigation + fonts, then generates a PDF via WKWebView.createPDF(configuration:).
///
/// Usage:
/// ```swift
/// let generator = try PdfGenerator(params: command.params)
/// let result = try await generator.generate()
/// print(result.path, result.pageCount, result.fileSize)
/// ```
///
/// - Important: WKWebView must be created and used on the main thread.
///   The `generate()` method dispatches to `@MainActor` internally.
/// - Important: Each instance is single-use. Do not call `generate()` more than once.
public final class PdfGenerator: NSObject, WKNavigationDelegate, @unchecked Sendable {

    // MARK: - Configuration

    private let html: String?
    private let url: URL?
    private let baseURL: URL?
    private let outputPath: URL
    private let paperWidth: Double?
    private let paperHeight: Double?
    private let marginTop: Double
    private let marginRight: Double
    private let marginBottom: Double
    private let marginLeft: Double
    private let scale: Double
    private let landscape: Bool
    private let printBackground: Bool
    private let pageRangeFirst: Int?
    private let pageRangeLast: Int?
    private let fontWaitTimeout: TimeInterval

    // MARK: - State

    /// Single-settle navigation continuation. Guarded by `navigationSettled`.
    private var navigationContinuation: CheckedContinuation<Void, Error>?
    private var navigationSettled = false

    // MARK: - Init

    /// Creates a PdfGenerator from daemon command params.
    ///
    /// Extracts content source (`html` or `url`), paper dimensions, margins, scale,
    /// orientation, page ranges, and font timeout from the params dictionary.
    ///
    /// - Parameter params: The `[String: AnyCodable]` dictionary from the daemon command.
    /// - Throws: `PdfError.invalidOutputPath` if the output directory doesn't exist,
    ///   or if neither `html` nor `url` is provided.
    public init(params: [String: AnyCodable]) throws {
        // Content source — exactly one of html or url required
        let htmlParam = params["html"]?.value as? String
        let urlParam: URL? = {
            if let str = params["url"]?.value as? String {
                return URL(string: str)
            }
            return nil
        }()

        guard htmlParam != nil || urlParam != nil else {
            throw PdfError.invalidOutputPath("Either 'html' or 'url' parameter is required")
        }

        self.html = htmlParam
        self.url = urlParam

        // Base URL for resolving relative resources in HTML
        if let baseStr = params["baseURL"]?.value as? String {
            self.baseURL = URL(string: baseStr)
        } else {
            self.baseURL = nil
        }

        // Output path — validate parent directory exists
        guard let outputStr = params["outputPath"]?.value as? String else {
            throw PdfError.invalidOutputPath("'outputPath' parameter is required")
        }
        let outputURL = URL(fileURLWithPath: outputStr)
        let parentDir = outputURL.deletingLastPathComponent().path
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: parentDir, isDirectory: &isDir),
              isDir.boolValue else {
            throw PdfError.invalidOutputPath("Parent directory does not exist: \(parentDir)")
        }
        self.outputPath = outputURL

        // Paper dimensions (nil = let @page CSS control)
        self.paperWidth = params["paperWidth"]?.value as? Double
        self.paperHeight = params["paperHeight"]?.value as? Double

        // Margins (default 72pt = 1 inch each)
        self.marginTop = (params["marginTop"]?.value as? Double) ?? 72.0
        self.marginRight = (params["marginRight"]?.value as? Double) ?? 72.0
        self.marginBottom = (params["marginBottom"]?.value as? Double) ?? 72.0
        self.marginLeft = (params["marginLeft"]?.value as? Double) ?? 72.0

        // Scale (default 1.0)
        self.scale = (params["scale"]?.value as? Double) ?? 1.0

        // Orientation
        self.landscape = (params["landscape"]?.value as? Bool) ?? false

        // Print background (CSS injection happens in TypeScript, not here)
        self.printBackground = (params["printBackground"]?.value as? Bool) ?? false

        // Page ranges (1-based, nil = all pages)
        if let first = params["pageRangeFirst"]?.value as? Int {
            self.pageRangeFirst = first
        } else {
            self.pageRangeFirst = nil
        }
        if let last = params["pageRangeLast"]?.value as? Int {
            self.pageRangeLast = last
        } else {
            self.pageRangeLast = nil
        }

        // Font wait timeout (param arrives in milliseconds, convert to seconds)
        let fontWaitMs = (params["fontWaitTimeout"]?.value as? Double) ?? 3000.0
        self.fontWaitTimeout = fontWaitMs / 1000.0

        super.init()
    }

    // MARK: - Public API

    /// Generate the PDF. Dispatches all WebKit/AppKit work to the main thread.
    ///
    /// - Returns: `PdfResult` with the output path, page count, file size, and any warnings.
    /// - Throws: `PdfError` on failure (load, generation, timeout, empty output).
    public func generate() async throws -> PdfResult {
        try await generateOnMain()
    }

    // MARK: - Main-thread implementation

    /// All WKWebView work must happen on the main thread.
    /// This method is the @MainActor entry point dispatched from `generate()`.
    @MainActor
    private func generateOnMain() async throws -> PdfResult {
        var warnings: [String] = []

        // 1. Determine content dimensions from paper size + margins
        let effectivePaperWidth = paperWidth ?? 612.0   // Default: US Letter
        let effectivePaperHeight = paperHeight ?? 792.0
        let contentWidth = effectivePaperWidth - marginLeft - marginRight
        let contentHeight = effectivePaperHeight - marginTop - marginBottom

        // 2. Create a hidden WKWebView sized to the printable content area.
        //    The frame width controls how the HTML layout engine flows content.
        let config = WKWebViewConfiguration()
        config.suppressesIncrementalRendering = true

        let frameWidth = landscape ? contentHeight : contentWidth
        let webView = WKWebView(
            frame: NSRect(x: 0, y: 0, width: frameWidth, height: 1),
            configuration: config
        )
        webView.navigationDelegate = self

        defer {
            webView.navigationDelegate = nil
            webView.stopLoading()
        }

        // 3. Load content
        if let html = self.html {
            webView.loadHTMLString(html, baseURL: baseURL)
        } else if let url = self.url {
            webView.load(URLRequest(url: url))
        }

        // 4. Wait for navigation to finish (didFinishNavigation / didFail)
        try await waitForNavigation()

        // 5. Wait for fonts to load (with timeout)
        let fontsReady = await waitForFonts(webView: webView)
        if !fontsReady {
            warnings.append("Font loading timed out after \(fontWaitTimeout)s — some fonts may not render")
        }

        // 6. Detect broken images
        let brokenCount = await detectBrokenImages(webView: webView)
        if brokenCount > 0 {
            warnings.append("\(brokenCount) image(s) failed to load (naturalWidth === 0)")
        }

        // 7. Inject CSS for margins, background printing, and scale via JavaScript.
        //    createPDF captures the visible viewport — padding on body simulates margins,
        //    and zoom handles the scale factor.
        var cssRules: [String] = []

        // Margins via body padding
        cssRules.append("body { padding: \(marginTop)pt \(marginRight)pt \(marginBottom)pt \(marginLeft)pt !important; margin: 0 !important; box-sizing: border-box !important; }")

        // Background color/image printing
        if printBackground {
            cssRules.append("* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }")
        }

        // Scale via CSS zoom (applied to document element to affect layout)
        if scale != 1.0 {
            cssRules.append("html { zoom: \(scale) !important; }")
        }

        let cssInjection = """
        (function() {
            var style = document.createElement('style');
            style.textContent = \(Self.jsStringLiteral(cssRules.joined(separator: " ")));
            document.head.appendChild(style);
        })()
        """
        _ = try? await webView.evaluateJavaScript(cssInjection)

        // 8. Generate PDF using WKWebView.createPDF — the reliable async API.
        //    Unlike NSPrintOperation.run(), this completes without blocking or looping.
        let pdfConfig = WKPDFConfiguration()

        // Set the capture rect to match the full paper size.
        // The body padding we injected above creates the margin effect within this rect.
        if landscape {
            pdfConfig.rect = CGRect(x: 0, y: 0, width: effectivePaperHeight, height: effectivePaperWidth)
        } else {
            pdfConfig.rect = CGRect(x: 0, y: 0, width: effectivePaperWidth, height: effectivePaperHeight)
        }

        let pdfData: Data
        do {
            pdfData = try await webView.pdf(configuration: pdfConfig)
        } catch {
            throw PdfError.generationFailed("WKWebView.createPDF failed: \(error.localizedDescription)")
        }

        // 9. Apply page range filter if requested (createPDF produces all pages)
        let finalData: Data
        if pageRangeFirst != nil || pageRangeLast != nil {
            guard let sourcePdf = PDFDocument(data: pdfData) else {
                throw PdfError.generationFailed("Failed to parse generated PDF for page range extraction")
            }
            let totalPages = sourcePdf.pageCount
            let first = max((pageRangeFirst ?? 1) - 1, 0)            // Convert 1-based to 0-based
            let last = min((pageRangeLast ?? totalPages) - 1, totalPages - 1)

            guard first <= last, first < totalPages else {
                throw PdfError.generationFailed("Page range \(first+1)-\(last+1) is out of bounds (document has \(totalPages) page(s))")
            }

            let filteredPdf = PDFDocument()
            for i in first...last {
                if let page = sourcePdf.page(at: i) {
                    filteredPdf.insert(page, at: filteredPdf.pageCount)
                }
            }

            guard let filteredData = filteredPdf.dataRepresentation() else {
                throw PdfError.generationFailed("Failed to serialize filtered PDF")
            }
            finalData = filteredData
        } else {
            finalData = pdfData
        }

        // 10. Write PDF data to disk
        do {
            try finalData.write(to: outputPath)
        } catch {
            throw PdfError.generationFailed("Failed to write PDF to \(outputPath.path): \(error.localizedDescription)")
        }

        // 11. Verify output file
        let fm = FileManager.default
        guard fm.fileExists(atPath: outputPath.path) else {
            throw PdfError.generationFailed("PDF file was not created at \(outputPath.path)")
        }

        let fileSize = finalData.count

        // Read page count via PDFKit
        let pageCount: Int
        if let pdfDoc = PDFDocument(url: outputPath) {
            pageCount = pdfDoc.pageCount
        } else {
            pageCount = 0
        }

        // Empty PDF check
        if pageCount == 0 && fileSize < 100 {
            throw PdfError.emptyPdf
        }

        return PdfResult(
            path: outputPath.path,
            pageCount: pageCount,
            fileSize: fileSize,
            warnings: warnings
        )
    }

    // MARK: - Helpers

    /// Escape a Swift string into a JavaScript string literal (single-quoted).
    private static func jsStringLiteral(_ s: String) -> String {
        var escaped = s
        escaped = escaped.replacingOccurrences(of: "\\", with: "\\\\")
        escaped = escaped.replacingOccurrences(of: "'", with: "\\'")
        escaped = escaped.replacingOccurrences(of: "\n", with: "\\n")
        escaped = escaped.replacingOccurrences(of: "\r", with: "\\r")
        return "'\(escaped)'"
    }

    // MARK: - Navigation waiting

    /// Wait for WKWebView navigation to complete via CheckedContinuation, with a timeout.
    /// The WKNavigationDelegate callbacks (`didFinish`, `didFail`, `didFailProvisionalNavigation`)
    /// resume this continuation. If navigation doesn't settle within `timeout` seconds,
    /// throws `PdfError.timeout`.
    @MainActor
    private func waitForNavigation(timeout: TimeInterval = 30) async throws {
        let loaded = try await withThrowingTaskGroup(of: Bool.self) { group in
            group.addTask { @MainActor in
                try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                    self.navigationContinuation = cont
                }
                return true
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return false
            }
            let first = try await group.next() ?? false
            group.cancelAll()
            return first
        }
        if !loaded {
            throw PdfError.timeout
        }
    }

    /// Settle-once helper: resumes the navigation continuation exactly once.
    /// Subsequent calls are no-ops (guards against double-resume from delegate callbacks).
    private func settleNavigation(with result: Result<Void, Error>) {
        guard !navigationSettled else { return }
        navigationSettled = true

        let cont = navigationContinuation
        navigationContinuation = nil

        switch result {
        case .success:
            cont?.resume()
        case .failure(let error):
            cont?.resume(throwing: error)
        }
    }

    // MARK: - WKNavigationDelegate

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        settleNavigation(with: .success(()))
    }

    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        settleNavigation(with: .failure(PdfError.loadFailed(error.localizedDescription)))
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        settleNavigation(with: .failure(PdfError.loadFailed(error.localizedDescription)))
    }

    // MARK: - Font waiting

    /// Evaluate `document.fonts.ready` with a timeout. Returns true if fonts loaded,
    /// false if the timeout fired first.
    @MainActor
    private func waitForFonts(webView: WKWebView) async -> Bool {
        let js = "document.fonts.ready.then(() => 'ready')"

        // Race: font loading vs timeout
        return await withTaskGroup(of: Bool.self) { group in
            group.addTask { @MainActor in
                do {
                    let result = try await webView.evaluateJavaScript(js)
                    return (result as? String) == "ready"
                } catch {
                    // JS evaluation failed (e.g., about:blank) — treat as ready
                    return true
                }
            }

            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(self.fontWaitTimeout * 1_000_000_000))
                return false
            }

            // First result wins
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
    }

    // MARK: - Broken image detection

    /// Count `<img>` elements whose `naturalWidth === 0` (failed to load).
    @MainActor
    private func detectBrokenImages(webView: WKWebView) async -> Int {
        let js = """
        (function() {
            var imgs = document.querySelectorAll('img[src]');
            var broken = 0;
            for (var i = 0; i < imgs.length; i++) {
                if (imgs[i].naturalWidth === 0) broken++;
            }
            return broken;
        })()
        """

        do {
            let result = try await webView.evaluateJavaScript(js)
            return (result as? Int) ?? 0
        } catch {
            // If JS eval fails, we can't detect broken images — not a fatal error
            return 0
        }
    }
}
