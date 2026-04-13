import Foundation
import CoreServices
import UniformTypeIdentifiers

// MARK: - Public Types

public struct DownloadResult: Sendable {
    public let filename: String
    public let path: String
    public let url: String?
    public let referrer: String?
    public let size: Int64
    public let mimeType: String?
    public let contentType: String?
    public let duration: Int
    public let quarantined: Bool
}

public struct ClickContextParams: Sendable {
    public let href: String?
    public let downloadAttr: String?
    public let tabUrl: String?
    public let timestamp: Double?

    public init(
        href: String? = nil,
        downloadAttr: String? = nil,
        tabUrl: String? = nil,
        timestamp: Double? = nil
    ) {
        self.href = href
        self.downloadAttr = downloadAttr
        self.tabUrl = tabUrl
        self.timestamp = timestamp
    }
}

public enum DownloadError: Error, Sendable {
    case directoryNotFound(String)
    case timeout(diagnostics: [String: String])
    case cancelled
    case inlineRender(tabUrl: String)
}

// MARK: - DownloadWatcher

/// Monitors Safari's download directory using FSEvents + DispatchSource to detect
/// `.download` bundle lifecycle events and return metadata about completed downloads.
///
/// Usage:
/// ```swift
/// let watcher = try DownloadWatcher(
///     timeout: 60,
///     filenamePattern: nil,
///     clickContext: ClickContextParams(href: "https://example.com/file.pdf"),
///     directory: nil
/// )
/// let result = try await watcher.watch()
/// print(result.filename, result.size)
/// ```
public final class DownloadWatcher: @unchecked Sendable {

    // MARK: Configuration

    private let timeout: TimeInterval
    private let filenamePattern: NSRegularExpression?
    private let clickContext: ClickContextParams?
    private let directory: URL

    // MARK: State

    private var fsEventStream: FSEventStreamRef?
    private var fsEventContextRetain: Unmanaged<DownloadWatcher>?
    private var dispatchSources: [String: DispatchSourceFileSystemObject] = [:]
    private var fileDescriptors: [String: Int32] = [:]
    private var isSettled = false
    private var continuation: CheckedContinuation<DownloadResult, Error>?
    private let stateQueue = DispatchQueue(label: "com.safaripilot.downloadwatcher", qos: .userInitiated)
    private var startTime: Date = Date()

    // MARK: Snapshot state

    private var snapshotFiles: Set<String> = []
    private var snapshotPlistCount: Int = 0

    // MARK: Init

    /// Creates a DownloadWatcher targeting the specified (or resolved) download directory.
    /// - Parameters:
    ///   - timeout: Maximum seconds to wait for a download to complete.
    ///   - filenamePattern: Optional regex to match the final filename against.
    ///   - clickContext: Optional click context for filtering downloads by href/downloadAttr.
    ///   - directory: Override the download directory. If nil, resolved via Safari defaults.
    /// - Throws: `DownloadError.directoryNotFound` if the directory doesn't exist.
    public init(
        timeout: TimeInterval = 60,
        filenamePattern: String? = nil,
        clickContext: ClickContextParams? = nil,
        directory: String? = nil
    ) throws {
        self.timeout = timeout
        self.clickContext = clickContext

        if let pattern = filenamePattern {
            self.filenamePattern = try NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
        } else {
            self.filenamePattern = nil
        }

        let dirPath = directory ?? DownloadWatcher.resolveDownloadDirectory()
        let dirURL = URL(fileURLWithPath: dirPath, isDirectory: true)

        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: dirPath, isDirectory: &isDir), isDir.boolValue else {
            throw DownloadError.directoryNotFound(dirPath)
        }

        self.directory = dirURL
    }

    deinit {
        cleanup()
    }

    // MARK: Public API

    /// Watches for a download to complete and returns its metadata.
    ///
    /// The state machine:
    /// 1. Snapshot directory + Downloads.plist entry count
    /// 2. Check for pre-existing `.download` bundles (fast-path for already-started downloads)
    /// 3. Start FSEvents stream with file-level events at 0.3s latency
    /// 4. On `.download` bundle creation: attach DispatchSource for rename/delete events
    /// 5. On rename (bundle disappears → final file appears): enrich metadata and return
    /// 6. On delete: return `.cancelled`
    /// 7. On timeout: diff directory and check plist for fast completions; return `.timeout`
    ///
    /// - Returns: `DownloadResult` with enriched metadata for the completed file.
    /// - Throws: `DownloadError.timeout`, `.cancelled`, or `.inlineRender`.
    public func watch() async throws -> DownloadResult {
        startTime = Date()

        // 1. Snapshot
        snapshotFiles = directoryContents()
        snapshotPlistCount = readPlistEntryCount()

        // 2. Check for existing .download bundles (download already started)
        let existingBundles = snapshotFiles.filter { $0.hasSuffix(".download") }
        for bundle in existingBundles {
            attachDispatchSource(forBundle: bundle)
        }

        return try await withCheckedThrowingContinuation { cont in
            stateQueue.async {
                self.continuation = cont
                self.startFSEvents()
                self.startTimeoutTimer()
            }
        }
    }

    // MARK: - Directory Resolution

    /// Reads `defaults read com.apple.Safari DownloadsPath` to find Safari's configured
    /// download folder. Falls back to `~/Downloads` if unset or on any error.
    public static func resolveDownloadDirectory() -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/defaults")
        proc.arguments = ["read", "com.apple.Safari", "DownloadsPath"]

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()

        do {
            try proc.run()
            proc.waitUntilExit()
            if proc.terminationStatus == 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let raw = String(data: data, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if let raw = raw, !raw.isEmpty {
                    // Expand tilde if present
                    return (raw as NSString).expandingTildeInPath
                }
            }
        } catch {
            // Fall through to default
        }

        return (NSString("~/Downloads").expandingTildeInPath)
    }

    // MARK: - Metadata Enrichment

    /// Reads extended attributes (WhereFroms, quarantine flag), UTI/MIME type, and file size.
    /// - Parameter filePath: Absolute path to the completed download file.
    /// - Returns: A tuple containing (sourceURL, referrer, mimeType, contentType, size, quarantined).
    public static func enrichMetadata(filePath: String) -> (
        url: String?,
        referrer: String?,
        mimeType: String?,
        contentType: String?,
        size: Int64,
        quarantined: Bool
    ) {
        var sourceURL: String? = nil
        var referrer: String? = nil
        var quarantined = false
        var mimeType: String? = nil
        var contentType: String? = nil

        // Read kMDItemWhereFroms — binary plist array containing [sourceURL, referrer]
        let whereFromsKey = "com.apple.metadata:kMDItemWhereFroms"
        let maxSize = 65536
        var buf = [UInt8](repeating: 0, count: maxSize)
        let len = filePath.withCString { cPath in
            whereFromsKey.withCString { cKey in
                getxattr(cPath, cKey, &buf, maxSize, 0, 0)
            }
        }

        if len > 0 {
            let data = Data(buf[0..<len])
            if let plist = try? PropertyListSerialization.propertyList(
                from: data,
                options: [],
                format: nil
            ) as? [String] {
                sourceURL = plist.indices.contains(0) ? plist[0] : nil
                referrer = plist.indices.contains(1) ? plist[1] : nil
            }
        }

        // Check quarantine xattr
        let quarantineKey = "com.apple.quarantine"
        let qLen = filePath.withCString { cPath in
            quarantineKey.withCString { cKey in
                getxattr(cPath, cKey, nil, 0, 0, 0)
            }
        }
        quarantined = qLen > 0

        // File size
        var size: Int64 = 0
        if let attrs = try? FileManager.default.attributesOfItem(atPath: filePath),
           let fileSize = attrs[.size] as? Int64 {
            size = fileSize
        }

        // UTI → MIME type (macOS 11+)
        if #available(macOS 11.0, *) {
            let fileURL = URL(fileURLWithPath: filePath)
            let ext = fileURL.pathExtension
            if !ext.isEmpty, let utType = UTType(filenameExtension: ext) {
                mimeType = utType.preferredMIMEType
                contentType = utType.identifier
            }
        }

        return (sourceURL, referrer, mimeType, contentType, size, quarantined)
    }

    // MARK: - FSEvents

    private func startFSEvents() {
        let pathsToWatch = [directory.path] as CFArray
        let retained = Unmanaged.passRetained(self)
        fsEventContextRetain = retained
        var ctx = FSEventStreamContext(
            version: 0,
            info: retained.toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )

        let flags = UInt32(
            kFSEventStreamCreateFlagFileEvents |
            kFSEventStreamCreateFlagUseCFTypes |
            kFSEventStreamCreateFlagNoDefer
        )

        let callback: FSEventStreamCallback = { (
            streamRef,
            clientCallBackInfo,
            numEvents,
            eventPaths,
            eventFlags,
            eventIds
        ) in
            guard let info = clientCallBackInfo else { return }
            let watcher = Unmanaged<DownloadWatcher>.fromOpaque(info).takeUnretainedValue()
            let paths = unsafeBitCast(eventPaths, to: NSArray.self) as! [String]
            let flags = UnsafeBufferPointer(start: eventFlags, count: numEvents)

            for (path, flag) in zip(paths, flags) {
                watcher.handleFSEvent(path: path, flags: flag)
            }
        }

        let stream = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &ctx,
            pathsToWatch,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.3, // latency in seconds
            flags
        )

        guard let stream = stream else {
            Logger.error("DownloadWatcher: failed to create FSEventStream")
            return
        }

        self.fsEventStream = stream
        FSEventStreamSetDispatchQueue(stream, stateQueue)
        FSEventStreamStart(stream)
        Logger.info("DownloadWatcher: FSEventStream started on \(directory.path)")
    }

    private func handleFSEvent(path: String, flags: FSEventStreamEventFlags) {
        let filename = URL(fileURLWithPath: path).lastPathComponent

        // We care about .download bundle creation
        if filename.hasSuffix(".download") {
            let isCreated = flags & UInt32(kFSEventStreamEventFlagItemCreated) != 0
            let isDir = flags & UInt32(kFSEventStreamEventFlagItemIsDir) != 0

            if isCreated && isDir && !dispatchSources.keys.contains(path) {
                Logger.debug("DownloadWatcher: detected new .download bundle: \(filename)")
                attachDispatchSource(forBundle: path)
            }
        }
    }

    // MARK: - DispatchSource (per .download bundle)

    private func attachDispatchSource(forBundle bundlePath: String) {
        guard dispatchSources[bundlePath] == nil else { return }

        let fd = bundlePath.withCString { open($0, O_EVTONLY) }
        guard fd >= 0 else {
            Logger.warning("DownloadWatcher: could not open fd for \(bundlePath)")
            return
        }

        fileDescriptors[bundlePath] = fd

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.rename, .delete],
            queue: stateQueue
        )

        let bundleURL = URL(fileURLWithPath: bundlePath)
        source.setEventHandler { [weak self] in
            guard let self = self else { return }
            let data = source.data

            if data.contains(.rename) {
                // Bundle was renamed — the final file should now exist
                self.handleBundleRenamed(bundlePath: bundlePath, bundleURL: bundleURL)
            } else if data.contains(.delete) {
                // Bundle was deleted — download was cancelled
                self.resolve(with: .failure(DownloadError.cancelled))
            }
        }

        source.setCancelHandler { [weak self] in
            close(fd)
            self?.fileDescriptors.removeValue(forKey: bundlePath)
        }

        dispatchSources[bundlePath] = source
        source.resume()
        Logger.debug("DownloadWatcher: attached DispatchSource for \(URL(fileURLWithPath: bundlePath).lastPathComponent)")
    }

    private func handleBundleRenamed(bundlePath: String, bundleURL: URL) {
        // The .download bundle disappears when Safari renames it to the final file.
        // Determine the final filename by stripping ".download" extension.
        let bundleFilename = bundleURL.lastPathComponent
        let finalFilename: String

        if bundleFilename.hasSuffix(".download") {
            // Strip outer .download
            let withoutDownload = String(bundleFilename.dropLast(".download".count))
            finalFilename = withoutDownload
        } else {
            finalFilename = bundleFilename
        }

        let finalPath = directory.appendingPathComponent(finalFilename).path

        // Give the filesystem a brief moment to settle (consistent with existing daemon patterns)
        stateQueue.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self = self else { return }
            guard FileManager.default.fileExists(atPath: finalPath) else {
                // File not yet visible — may have been moved elsewhere
                Logger.warning("DownloadWatcher: expected final file not found at \(finalPath)")
                return
            }

            guard self.matchesFilters(finalFilename) else {
                Logger.debug("DownloadWatcher: \(finalFilename) did not match filters — continuing to watch")
                return
            }

            let meta = DownloadWatcher.enrichMetadata(filePath: finalPath)

            guard self.matchesResult(filename: finalFilename, sourceURL: meta.url) else {
                Logger.debug("DownloadWatcher: \(finalFilename) did not match result filters — continuing to watch")
                return
            }

            let elapsed = Int(Date().timeIntervalSince(self.startTime))
            let result = DownloadResult(
                filename: finalFilename,
                path: finalPath,
                url: meta.url,
                referrer: meta.referrer,
                size: meta.size,
                mimeType: meta.mimeType,
                contentType: meta.contentType,
                duration: elapsed,
                quarantined: meta.quarantined
            )

            Logger.info("DownloadWatcher: download complete — \(finalFilename) (\(meta.size) bytes)")
            self.resolve(with: .success(result))
        }
    }

    // MARK: - Timeout

    private func startTimeoutTimer() {
        let timerSource = DispatchSource.makeTimerSource(queue: stateQueue)
        timerSource.schedule(deadline: .now() + timeout)
        timerSource.setEventHandler { [weak self] in
            self?.handleTimeout()
        }
        timerSource.resume()
    }

    private func handleTimeout() {
        // Check if a download actually completed (fast-path: plist entry count changed
        // or new files appeared in the directory)
        if let result = checkForCompletedDownload() {
            Logger.info("DownloadWatcher: fast-completion detected at timeout — \(result.filename)")
            resolve(with: .success(result))
            return
        }

        let currentFiles = directoryContents()
        let newFiles = currentFiles.subtracting(snapshotFiles)
        let currentPlistCount = readPlistEntryCount()

        let diagnostics: [String: String] = [
            "directory": directory.path,
            "timeoutSeconds": String(format: "%.0f", timeout),
            "newFilesFound": String(newFiles.count),
            "plistCountBefore": String(snapshotPlistCount),
            "plistCountAfter": String(currentPlistCount),
            "activeBundles": String(dispatchSources.count)
        ]

        Logger.warning("DownloadWatcher: timeout after \(timeout)s waiting for download")
        resolve(with: .failure(DownloadError.timeout(diagnostics: diagnostics)))
    }

    // MARK: - Filter Helpers

    /// Returns true if the filename matches the filenamePattern regex and
    /// optionally the downloadAttr hint from the click context.
    private func matchesFilters(_ filename: String) -> Bool {
        if let pattern = filenamePattern {
            let range = NSRange(filename.startIndex..., in: filename)
            guard pattern.firstMatch(in: filename, options: [], range: range) != nil else {
                return false
            }
        }

        if let attr = clickContext?.downloadAttr, !attr.isEmpty {
            // downloadAttr is typically the final filename hint
            guard filename.lowercased() == attr.lowercased() ||
                  filename.lowercased().hasPrefix((attr as NSString).deletingPathExtension.lowercased())
            else {
                return false
            }
        }

        return true
    }

    /// Returns true if the completed result matches click-context expectations (href vs source URL,
    /// filenamePattern).
    private func matchesResult(filename: String, sourceURL: String?) -> Bool {
        // Pattern check (re-verify after enrichment)
        if let pattern = filenamePattern {
            let range = NSRange(filename.startIndex..., in: filename)
            guard pattern.firstMatch(in: filename, options: [], range: range) != nil else {
                return false
            }
        }

        // Click-context href check — if we have a known href and a source URL, they should
        // share the same host at minimum
        if let href = clickContext?.href, let source = sourceURL {
            if let hrefHost = URL(string: href)?.host,
               let sourceHost = URL(string: source)?.host {
                guard hrefHost == sourceHost else {
                    return false
                }
            }
        }

        return true
    }

    // MARK: - Downloads.plist

    /// Reads the Safari Downloads.plist entry count.
    /// Returns 0 on any error (file missing, parse failure).
    private func readPlistEntryCount() -> Int {
        let plistPath = (NSString("~/Library/Safari/Downloads.plist").expandingTildeInPath)
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: plistPath)),
              let plist = try? PropertyListSerialization.propertyList(
                  from: data, options: [], format: nil
              ) as? [String: Any],
              let entries = plist["DownloadHistory"] as? [Any]
        else {
            return 0
        }
        return entries.count
    }

    // MARK: - Fast-completion Check

    /// Checks for files that completed between snapshot and now.
    /// Returns the first matching `DownloadResult` if found, otherwise nil.
    private func checkForCompletedDownload() -> DownloadResult? {
        let currentFiles = directoryContents()
        let newFiles = currentFiles.subtracting(snapshotFiles)
            .filter { !$0.hasSuffix(".download") }

        for filename in newFiles {
            guard matchesFilters(filename) else { continue }

            let filePath = directory.appendingPathComponent(filename).path
            let meta = DownloadWatcher.enrichMetadata(filePath: filePath)

            guard matchesResult(filename: filename, sourceURL: meta.url) else { continue }

            let elapsed = Int(Date().timeIntervalSince(startTime))
            return DownloadResult(
                filename: filename,
                path: filePath,
                url: meta.url,
                referrer: meta.referrer,
                size: meta.size,
                mimeType: meta.mimeType,
                contentType: meta.contentType,
                duration: elapsed,
                quarantined: meta.quarantined
            )
        }

        return nil
    }

    // MARK: - Directory Listing

    private func directoryContents() -> Set<String> {
        let items = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return Set(items)
    }

    // MARK: - Continuation Resolution

    /// Thread-safe, settle-once resolution. Subsequent calls are no-ops.
    private func resolve(with result: Result<DownloadResult, Error>) {
        // Settle pattern: prevent double-resolution
        guard !isSettled else { return }
        isSettled = true

        let cont = continuation
        continuation = nil

        cleanup()

        switch result {
        case .success(let value):
            cont?.resume(returning: value)
        case .failure(let error):
            cont?.resume(throwing: error)
        }
    }

    // MARK: - Cleanup

    /// Stops the FSEvents stream, cancels all DispatchSources, and closes open file descriptors.
    private func cleanup() {
        // Cancel all DispatchSources (their cancel handlers close the fds)
        for (_, source) in dispatchSources {
            source.cancel()
        }
        dispatchSources.removeAll()

        // Close any fds not yet cleaned up by cancel handlers
        for (_, fd) in fileDescriptors {
            close(fd)
        }
        fileDescriptors.removeAll()

        // Stop and invalidate the FSEvents stream
        if let stream = fsEventStream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            fsEventStream = nil
            // Release the retained self pointer passed as FSEvents context
            fsEventContextRetain?.release()
            fsEventContextRetain = nil
        }
    }
}
