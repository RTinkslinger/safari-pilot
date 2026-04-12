# P1 File Download Handling — Research Report

> Safari Pilot implementation research for `safari_wait_for_download` tool.
> Date: 2026-04-12 | Sources: Parallel Deep Research (ultra-fast), Apple Developer docs, Playwright docs, Stack Overflow, Eclectic Light, macOS forensics analysis, local system verification.

---

## Table of Contents

1. [Safari Download Behavior](#1-safari-download-behavior)
2. [Playwright Download API Reference](#2-playwright-download-api-reference)
3. [macOS FSEvents API (Swift)](#3-macos-fsevents-api-swift)
4. [DispatchSource / kqueue (Swift)](#4-dispatchsource--kqueue-swift)
5. [Recommended Hybrid Approach](#5-recommended-hybrid-approach)
6. [File Metadata Extraction](#6-file-metadata-extraction)
7. [Alternative Detection Approaches](#7-alternative-detection-approaches)
8. [Edge Cases](#8-edge-cases)
9. [Safari Downloads.plist](#9-safari-downloadsplist)
10. [Implementation Spec for Safari Pilot](#10-implementation-spec-for-safari-pilot)

---

## 1. Safari Download Behavior

### Default Download Location

- Default: `~/Downloads/`
- User-configurable via Safari > Settings > General > "File download location"
- Preference key: `com.apple.Safari` > `DownloadsPath` (string, e.g., `~/Downloads`)
- Since Safari 13 (Catalina), prefs live in `~/Library/Containers/com.apple.Safari/Data/Library/Preferences/com.apple.Safari.plist`
- When not explicitly set, the key is absent and Safari uses `~/Downloads/` as the implicit default

**Reading the download path programmatically:**
```bash
# Shell — returns ~ path or errors if not explicitly set
defaults read com.apple.Safari DownloadsPath 2>/dev/null || echo "$HOME/Downloads"
```

**Setting the download path:**
```bash
# Only works when Safari is NOT running (reads prefs into RAM on launch)
defaults write com.apple.Safari DownloadsPath "/path/to/dir"
# If Safari IS running, must use GUI scripting through System Events
```

**Critical caveat:** Once Safari is running, it reads preferences into RAM. Writing to the plist with `defaults write` has no effect until Safari is relaunched. Changing download location while Safari is running requires AppleScript GUI scripting (clicking through Safari > Settings > General).

Source: https://www.cnet.com/tech/computing/applescript-fun-automatically-changing-safaris-downloads-folder/, verified locally.

### Temporary `.download` Bundle

When Safari initiates a download, it does NOT write directly to the final file. Instead:

1. **Creates** `filename.ext.download` in the download directory — this is a **macOS bundle (directory)**, not a file
2. The bundle contains the partially downloaded data plus metadata about the download
3. **On completion**, Safari renames/replaces the `.download` bundle with the final file (removes `.download` suffix)
4. **On cancellation**, Safari typically deletes the `.download` bundle (but may leave it behind in some cases)
5. **On failure/interruption**, the `.download` bundle persists — user can double-click it to resume in Safari

**Bundle internals:** The `.download` package contains the partial file data. Right-clicking > "Show Package Contents" reveals the actual file within it.

**Key filesystem events during a download:**
```
1. CREATE  filename.ext.download/     (directory created)
2. WRITE   filename.ext.download/...  (data being written inside bundle)
3. RENAME  filename.ext.download → filename.ext  (completion)
   OR
3. DELETE  filename.ext.download      (cancellation)
```

**ExFAT edge case:** Safari has known issues on ExFAT volumes where the `.download` bundle is not properly renamed after completion, leaving the user with a `.download` file that must be manually unpacked. This only affects non-APFS/HFS+ volumes. For automation, target APFS volumes.

Source: https://discussions.apple.com/thread/256050308, https://www.quora.com/What-does-a-MacBook-Pro-do-with-files-that-are-partially-downloaded

### Filename Collision Handling

Safari appends numeric suffixes in parentheses when a file with the same name already exists:
- `document.pdf` (original)
- `document (1).pdf` (first collision)
- `document (2).pdf` (second collision)
- Pattern: `basename (N).ext` where N increments

**Warning:** For very rapid successive downloads of the same file, Safari may overwrite the earlier one before the rename completes. This is a race condition in concurrent download scenarios.

### "Open Safe Files After Downloading"

- Preference key: `AutoOpenSafeDownloads` (boolean)
- "Safe" file types: images (JPEG, PNG, GIF), PDFs, text files, movies, sounds, disk images, and some archive formats
- When enabled, Safari launches the default application for these file types immediately after download

**Disabling programmatically:**
```bash
defaults write com.apple.Safari AutoOpenSafeDownloads -bool false
# Confirmed working on Safari 15+ / macOS Monterey+
# Requires Safari restart to take effect
```

**Impact on automation:** This MUST be disabled for reliable download automation. Auto-opening can:
- Steal focus from Safari
- Trigger Gatekeeper security prompts
- Prevent the automation script from accessing the file
- Launch applications that consume system resources

Source: https://gist.github.com/ChristopherA/98628f8cd00c94f11ee6035d53b0d3c6

### Blob and Data URL Downloads

- Blob URLs (`blob:http://...`) trigger standard downloads but lack a persistent network URL
- The `kMDItemWhereFroms` xattr may contain the `blob:` URI or be absent entirely
- Data URLs may not trigger the download manager at all in some Safari versions
- JavaScript-generated downloads via `<a download>` click work but provenance tracking is limited

---

## 2. Playwright Download API Reference

### Core Pattern

```javascript
// Start waiting BEFORE the action that triggers download
const downloadPromise = page.waitForEvent('download');
await page.getByText('Download file').click();
const download = await downloadPromise;

// Save to permanent location
await download.saveAs('/path/to/' + download.suggestedFilename());
```

### Download Object API

| Method | Returns | Description |
|--------|---------|-------------|
| `url()` | `string` | Source URL of the download |
| `suggestedFilename()` | `string` | Filename from Content-Disposition header or URL path |
| `path()` | `Promise<string>` | Path to temp file (waits for completion, throws on failure) |
| `saveAs(path)` | `Promise<void>` | Copy to permanent location (safe to call during download) |
| `failure()` | `Promise<null\|string>` | `null` if success, error string if failed (e.g., `'canceled'`) |
| `cancel()` | `Promise<void>` | Cancel in-progress download |
| `delete()` | `Promise<void>` | Delete the downloaded file |
| `createReadStream()` | `Promise<Readable>` | Node.js readable stream of file contents |
| `page()` | `Page` | The page that initiated the download |

### Key Behaviors

- **Temporary storage:** Downloads go to a Playwright-managed temp directory (auto-cleaned when browser context closes)
- **Custom path:** `downloadsPath` option on `browserType.launch()` directs all downloads to a specific folder
- **File naming:** Temp file uses random GUID, not the suggested filename
- **Event timing:** `page.on('download')` fires when download **starts**, not when it completes
- **Completion:** `download.path()` and `download.saveAs()` both wait for download to finish

### WebKit-Specific Differences

- Playwright's WebKit is NOT Safari — it's a patched WebKit automation backend
- Does NOT read Safari preferences (download location, auto-open safe files)
- Downloads stream to `/var/folders/...` temp location
- `path()` may be available slightly later than Chromium/Firefox
- May not apply `com.apple.quarantine` xattr (since it's not the Safari application)
- Known bugs: some WebKit builds don't fire the download event for certain content types

Source: https://playwright.dev/docs/api/class-download, https://playwright.dev/docs/downloads

### What Safari Pilot Must Match

The minimum viable parity with Playwright's Download API:

```typescript
interface SafariDownload {
  url: string;           // Source URL (from Downloads.plist or xattr)
  suggestedFilename: string; // Original filename
  path: string;          // Final file path on disk
  size: number;          // File size in bytes
  mimeType: string;      // MIME type (from UTI)
  duration: number;      // Download duration in ms
  failure: string | null; // Error message or null
}
```

---

## 3. macOS FSEvents API (Swift)

### Overview

FSEvents is a **directory-level** monitoring API. It watches entire directory trees and delivers batched, coalesced notifications. It's efficient and scalable but has inherent latency.

### Swift Implementation Pattern

```swift
import CoreServices

class DownloadDirectoryWatcher {
    private var stream: FSEventStreamRef?

    func start(directory: String, latency: CFTimeInterval = 0.3) {
        let pathsToWatch = [directory] as CFArray

        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )

        let callback: FSEventStreamCallback = {
            (streamRef, clientInfo, numEvents, eventPaths, eventFlags, eventIds) in

            let paths = Unmanaged<CFArray>.fromOpaque(eventPaths)
                .takeUnretainedValue() as! [String]
            let flags = Array(UnsafeBufferPointer(
                start: eventFlags, count: numEvents))

            for i in 0..<numEvents {
                let path = paths[i]
                let flag = flags[i]

                // Check for file-level events
                if flag & UInt32(kFSEventStreamEventFlagItemCreated) != 0 {
                    // New file or .download bundle created
                }
                if flag & UInt32(kFSEventStreamEventFlagItemRenamed) != 0 {
                    // .download bundle renamed to final file
                }
                if flag & UInt32(kFSEventStreamEventFlagItemRemoved) != 0 {
                    // .download bundle deleted (cancelled)
                }
            }
        }

        stream = FSEventStreamCreate(
            nil,                                        // allocator
            callback,                                   // callback
            &context,                                   // context
            pathsToWatch,                               // pathsToWatch
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow), // sinceWhen
            latency,                                    // latency (seconds)
            UInt32(kFSEventStreamCreateFlagFileEvents | // per-file events
                   kFSEventStreamCreateFlagUseCFTypes)  // CFArray paths
        )

        // Schedule on dispatch queue (preferred over RunLoop for daemon)
        FSEventStreamSetDispatchTarget(stream!, DispatchQueue.global(qos: .utility))
        FSEventStreamStart(stream!)
    }

    func stop() {
        if let stream = stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            self.stream = nil
        }
    }
}
```

### Key Event Flags

| Flag | Hex | Meaning |
|------|-----|---------|
| `kFSEventStreamEventFlagItemCreated` | `0x00000100` | File/dir created |
| `kFSEventStreamEventFlagItemRemoved` | `0x00000200` | File/dir deleted |
| `kFSEventStreamEventFlagItemRenamed` | `0x00000800` | File/dir renamed |
| `kFSEventStreamEventFlagItemModified` | `0x00001000` | File data changed |
| `kFSEventStreamEventFlagItemIsFile` | `0x00010000` | Event target is a file |
| `kFSEventStreamEventFlagItemIsDir` | `0x00020000` | Event target is a directory |
| `kFSEventStreamCreateFlagFileEvents` | `0x00000010` | Enable per-file events |

### Latency and Coalescing

- **Latency parameter:** Time in seconds the daemon waits before delivering events (coalesces rapid changes)
- **0.3s** is a good default for download monitoring — fast enough to detect completion, low enough overhead
- **0.0s** possible but increases CPU usage and event volume
- Multiple operations within the latency window may be collapsed into a single event with `kFSEventStreamEventFlagMustScanSubDirs`
- When this flag appears, must rescan the directory to determine actual state

### Thread Safety

- FSEventStream callback runs on the dispatch queue or run loop it's scheduled on
- The stream itself is not thread-safe — create/start/stop/invalidate from the same thread/queue
- Use `FSEventStreamSetDispatchTarget` (not RunLoop scheduling) for the daemon

Source: https://developer.apple.com/library/archive/documentation/Darwin/Conceptual/FSEvents_ProgGuide/UsingtheFSEventsFramework/UsingtheFSEventsFramework.html

---

## 4. DispatchSource / kqueue (Swift)

### Overview

`DispatchSource.makeFileSystemObjectSource` wraps the BSD `kqueue`/`kevent` API with `EVFILT_VNODE`. It provides **per-file** monitoring with near-real-time (~ms) latency. Used for precise completion detection.

### Swift Implementation Pattern

```swift
class FileCompletionWatcher {
    private var source: DispatchSourceFileSystemObject?
    private var fileDescriptor: CInt = -1

    /// Monitor a specific file or directory for changes
    func watch(path: String, events: DispatchSource.FileSystemEvent = [.write, .rename, .delete]) {
        fileDescriptor = open(path, O_EVTONLY)  // Open for event monitoring only
        guard fileDescriptor >= 0 else { return }

        source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fileDescriptor,
            eventMask: events,
            queue: DispatchQueue.global(qos: .utility)
        )

        source?.setEventHandler { [weak self] in
            guard let self = self else { return }
            let event = self.source!.data  // DispatchSource.FileSystemEvent
            self.handleEvent(event, path: path)
        }

        source?.setCancelHandler { [weak self] in
            if let fd = self?.fileDescriptor, fd >= 0 {
                close(fd)
            }
        }

        source?.resume()
    }

    private func handleEvent(_ event: DispatchSource.FileSystemEvent, path: String) {
        if event.contains(.rename) {
            // .download bundle was renamed (download complete!)
        }
        if event.contains(.write) {
            // Data written (download in progress)
        }
        if event.contains(.delete) {
            // File deleted (download cancelled)
        }
    }

    func cancel() {
        source?.cancel()
        source = nil
        fileDescriptor = -1
    }

    deinit {
        cancel()
    }
}
```

### FileSystemEvent Options

| Event | Meaning | Use for downloads |
|-------|---------|-------------------|
| `.write` | Data written to file | Detect active writing |
| `.rename` | File/dir renamed | **Primary completion signal** |
| `.delete` | File/dir deleted | Detect cancellation |
| `.extend` | File size increased | Detect data appending |
| `.attrib` | Attributes changed | Detect metadata changes |
| `.link` | Link count changed | Usually not relevant |
| `.revoke` | Access revoked | Rarely used |
| `.funlock` | File unlocked | **Secondary completion signal** |
| `.all` | All events | For debugging only |

### Critical Caveats

1. **File descriptor per file:** Each monitored file requires an open fd. macOS limit is typically 256 per process (adjustable with `setrlimit`). For monitoring a directory + a few `.download` bundles, this is not a concern.

2. **No `NOTE_CLOSE_WRITE` in DispatchSource:** Unlike Linux's `inotify`, macOS kqueue does not have a direct "file closed after write" event. The `.funlock` event is the closest equivalent but not reliably emitted by all write patterns. **Safari's rename of the `.download` bundle is the reliable completion signal.**

3. **Rename breaks the fd:** When the `.download` bundle is renamed to the final file, the file descriptor still points to the same inode. The `.rename` event fires, but to get the new name you must re-resolve the inode (e.g., using `fcntl(fd, F_GETPATH, ...)` to get the current path).

4. **O_EVTONLY:** Always use `O_EVTONLY` when opening files for monitoring — it doesn't prevent the file from being deleted or the volume from being unmounted, and it doesn't count toward the process's "open for reading/writing" limit.

Source: https://stackoverflow.com/questions/24150061/how-to-monitor-a-folder-for-new-files-in-swift, Apple DispatchSource.FileSystemEvent docs.

---

## 5. Recommended Hybrid Approach

The optimal detection strategy for Safari Pilot combines both APIs:

### Architecture

```
┌──────────────────────────────────────────────┐
│  DownloadWatcher (daemon component)          │
│                                              │
│  ┌──────────────┐    ┌───────────────────┐   │
│  │  FSEvents     │    │  DispatchSource    │   │
│  │  (directory)  │───>│  (per .download)  │   │
│  │              │    │                   │   │
│  │  Watches     │    │  Watches specific │   │
│  │  ~/Downloads │    │  .download bundle │   │
│  │  for new     │    │  for .rename or   │   │
│  │  .download   │    │  .delete events   │   │
│  │  bundles     │    │                   │   │
│  └──────────────┘    └───────────────────┘   │
│         │                      │             │
│         │ "new .download"      │ "renamed"   │
│         ▼                      ▼             │
│  ┌──────────────────────────────────────┐    │
│  │  State Machine                       │    │
│  │  IDLE → DOWNLOADING → COMPLETING →   │    │
│  │                       DONE / FAILED  │    │
│  └──────────────────────────────────────┘    │
│                      │                       │
│                      ▼                       │
│  ┌──────────────────────────────────────┐    │
│  │  Metadata Enrichment                 │    │
│  │  - Read xattrs (WhereFroms, quarantine)   │
│  │  - Get UTI / MIME type               │    │
│  │  - Compute file size                 │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
```

### State Machine

```
IDLE
  │
  ├─ FSEvents: .download bundle created ──> DOWNLOADING
  │
DOWNLOADING
  │
  ├─ DispatchSource(.rename) on .download  ──> COMPLETING
  ├─ DispatchSource(.delete) on .download  ──> FAILED (cancelled)
  ├─ Timeout (configurable, default 60s)   ──> FAILED (timeout)
  │
COMPLETING
  │
  ├─ Verify final file exists              ──> DONE
  ├─ Verify file size stable (2 checks)    ──> DONE
  ├─ Final file missing                    ──> FAILED (rename failed)
  │
DONE
  │
  ├─ Enrich with metadata
  ├─ Return result to caller
```

### Why This Beats Alternatives

| Approach | Latency | Accuracy | Complexity | Verdict |
|----------|---------|----------|------------|---------|
| FSEvents only | ~300ms | Medium (no close signal) | Low | Too imprecise |
| DispatchSource only | ~1ms | High | Medium (fd management) | Can't discover new files |
| Polling (stat loop) | 500ms+ | Low (race conditions) | Low | Wasteful |
| lsof checking | 1s+ | Low (parsing, permissions) | High | Too slow, brittle |
| **Hybrid (FSEvents + DispatchSource)** | **~50ms** | **High** | **Medium** | **Best balance** |

---

## 6. File Metadata Extraction

### Extended Attributes (xattr)

**Verified on this machine** against a real Safari download (`developerID_application.cer`):

#### `com.apple.metadata:kMDItemWhereFroms`

Binary plist containing an array of URLs:
```
[
  "https://developer.apple.com/services-account/.../downloadCertificateContent.action?...",
  "https://developer.apple.com/account/resources/certificates/add/download/VWB7J7SR3S"
]
```
- First entry: direct download URL
- Second entry: referring page URL
- For blob/data URLs: may be absent or contain `blob:http://...`

#### `com.apple.quarantine`

Semicolon-delimited text string:
```
0083;69db9415;Safari;8F2FC1E4-A1FA-47D2-A469-8BEB3720AD10
```

Format: `flags;timestamp_hex;agent;UUID`
- **flags:** Hex bitmask controlling Gatekeeper behavior
  - `0x0040` = file has been assessed by Gatekeeper
  - `0x0080` = assessment passed
- **timestamp:** Hex-encoded seconds since some epoch
- **agent:** Application that downloaded the file (e.g., "Safari", "curl")
- **UUID:** Download identifier

#### `com.apple.metadata:kMDItemDownloadedDate`

Binary plist containing the download timestamp as NSDate.

### Reading Extended Attributes in Swift

```swift
import Foundation

func readWhereFroms(path: String) -> [String]? {
    let name = "com.apple.metadata:kMDItemWhereFroms"
    let size = getxattr(path, name, nil, 0, 0, 0)
    guard size > 0 else { return nil }

    var data = Data(count: size)
    let result = data.withUnsafeMutableBytes { ptr in
        getxattr(path, name, ptr.baseAddress, size, 0, 0)
    }
    guard result > 0 else { return nil }

    // Parse binary plist
    let plist = try? PropertyListSerialization.propertyList(
        from: data, options: [], format: nil)
    return plist as? [String]
}

func readQuarantine(path: String) -> String? {
    let name = "com.apple.quarantine"
    let size = getxattr(path, name, nil, 0, 0, 0)
    guard size > 0 else { return nil }

    var buffer = [UInt8](repeating: 0, count: size)
    let result = getxattr(path, name, &buffer, size, 0, 0)
    guard result > 0 else { return nil }

    return String(bytes: buffer, encoding: .utf8)
}
```

### Spotlight Metadata (MDItem)

```swift
import CoreServices

func getFileMetadata(url: URL) -> [String: Any]? {
    guard let item = MDItemCreateWithURL(nil, url as CFURL) else { return nil }

    let attrs: [CFString] = [
        kMDItemContentType,           // UTI e.g., "com.adobe.pdf"
        kMDItemContentTypeTree,       // UTI hierarchy
        kMDItemFSSize,                // File size in bytes
        kMDItemContentCreationDate,   // Creation date
        kMDItemContentModificationDate, // Modification date
        kMDItemDateAdded,             // Date added to directory
        kMDItemWhereFroms,            // Source URLs (same as xattr)
    ]

    guard let dict = MDItemCopyAttributes(item, attrs as CFArray) as? [String: Any] else {
        return nil
    }
    return dict
}
```

**MIME type from UTI:**
```swift
import UniformTypeIdentifiers

func mimeType(forUTI uti: String) -> String? {
    if let utType = UTType(uti) {
        return utType.preferredMIMEType
    }
    return nil
}
```

### CLI Equivalents

```bash
# Read source URLs
xattr -p com.apple.metadata:kMDItemWhereFroms file.pdf | \
  plutil -convert xml1 -o - -

# Read quarantine info
xattr -p com.apple.quarantine file.pdf

# Read Spotlight metadata
mdls -name kMDItemContentType -name kMDItemFSSize \
     -name kMDItemWhereFroms file.pdf

# Get MIME type
file --mime-type file.pdf

# Remove quarantine (for automation)
xattr -d com.apple.quarantine file.pdf
```

Source: https://eclecticlight.co/2024/09/12/from-quarantine-to-provenance-extended-attributes/, local verification.

---

## 7. Alternative Detection Approaches

### NSWorkspace Notifications — NOT Recommended

- No dedicated "download finished" notification
- `NSWorkspace.didPerformFileOperationNotification` is too coarse-grained
- NSMetadataQuery (Spotlight) can observe indexing updates but lags behind actual writes
- Verdict: **Supplementary at best, not primary detection**

### Safari Web Extension APIs — Limited

- Safari does NOT expose a `chrome.downloads`-equivalent API
- Extensions cannot programmatically observe, control, or manage downloads
- Safari extensions face stricter security/signing requirements
- The existing Safari Pilot extension could potentially intercept download-triggering clicks (beforehand), but cannot monitor the download itself
- Verdict: **Useful for capturing pre-download context (URL, trigger element) but not for download monitoring**

### kqueue/kevent Directly — Viable but Unnecessary

- Same underlying mechanism as DispatchSource, just lower-level C API
- No advantage over DispatchSource for this use case
- More boilerplate, harder to manage lifecycle
- Verdict: **Use DispatchSource instead (same kernel mechanism, better Swift API)**

### lsof File Lock Detection — NOT Recommended

- Expensive shell-out per check (`~50-100ms`)
- Parsing output is brittle
- May require elevated privileges in sandboxed environments
- Cannot see file handles in some configurations
- Verdict: **Last resort only, not suitable for production**

---

## 8. Edge Cases

### Authentication-Required Downloads

- Safari sends session cookies with download requests if the user is authenticated
- Safari Pilot works with real authenticated sessions (structural advantage over Playwright)
- No special handling needed — the download works because the user is already logged in
- Edge case: if the download URL redirects to a login page, Safari may save the HTML login page instead of the expected file. Detection: check Content-Type/UTI of the downloaded file.

### JavaScript-Triggered Blob Downloads

- `URL.createObjectURL(blob)` + `<a download>` click = standard download flow
- `kMDItemWhereFroms` will contain `blob:http://...` or may be absent
- **Detection strategy:** Before triggering the download, inject JS via Safari extension to intercept `URL.createObjectURL` calls and capture the blob data + origin page URL
- Alternative: after download, cross-reference Downloads.plist `DownloadEntryURL` with the known action

### Concurrent Downloads

- Each download creates its own `.download` bundle
- Safari's numeric suffix naming is non-deterministic under concurrency
- **Safari Pilot strategy:** Track downloads by `.download` bundle creation timestamp + expected filename pattern, not by exact filename
- After completion, use `DownloadEntryIdentifier` from Downloads.plist to correlate

### Large File / Streaming Downloads

- No `Content-Length` = unknown total size
- **Detection:** Monitor `.download` bundle for write activity cessation
  - Poll file size every 500ms inside the `.download` bundle
  - Consider complete when size stable for 2 consecutive checks AND `.download` bundle is renamed
  - Fallback: inactivity timeout (configurable, default 30s)

### Non-Default Download Locations

- User may have changed Safari's download location to Desktop, external drive, etc.
- **Safari Pilot must read the preference** before starting the watcher:
  ```bash
  defaults read com.apple.Safari DownloadsPath
  ```
- If preference is absent, default to `~/Downloads/`
- Watch the actual configured directory, not hardcoded `~/Downloads/`

### Gatekeeper Quarantine

- Downloaded executables will trigger a security prompt on first open
- For automation: optionally strip quarantine after verification
  ```bash
  xattr -d com.apple.quarantine /path/to/file
  ```
- Safari Pilot should **log** quarantine status but NOT auto-strip it (security risk)
- Provide an option in the tool: `removeQuarantine: boolean` (default false)

---

## 9. Safari Downloads.plist

**Location:** `~/Library/Safari/Downloads.plist`

Safari maintains a download history plist that is extremely valuable for automation. **Verified structure from this machine:**

```
{
  "DownloadHistory" => [
    {
      "DownloadEntryIdentifier"       => "7F7B9819-20B2-4F4D-9238-7A2BA8E73255"  // UUID
      "DownloadEntryURL"              => "https://..."                             // Source URL
      "DownloadEntryPath"             => "/Users/.../Downloads/file.ext"           // Final path
      "DownloadEntryDateAddedKey"     => 2026-04-12 12:46:12 +0000                // Start time
      "DownloadEntryDateFinishedKey"  => 2026-04-12 12:46:12 +0000                // Finish time
      "DownloadEntryProgressBytesSoFar"  => 1480                                  // Bytes downloaded
      "DownloadEntryProgressTotalToLoad" => 1480                                  // Total bytes
      "DownloadEntryBookmarkBlob"     => {binary data}                            // Bookmark for file
      "DownloadEntryProfileUUIDStringKey" => "DefaultProfile"                     // Safari profile
      "DownloadEntryRemoveWhenDoneKey"   => false                                 // Auto-remove flag
      "DownloadEntrySandboxIdentifier"   => "6CFF6FFE-..."                        // Sandbox ID
    }
  ]
}
```

**Key insight:** This plist provides the **source URL**, **file path**, **start/finish timestamps**, and **byte progress** — all the metadata needed without relying on xattrs.

**Retention:** Safari automatically deletes entries after one day by default.

**Access pattern for Safari Pilot:**
1. Before triggering download: snapshot the existing `DownloadHistory` entries
2. After FSEvents signals completion: re-read the plist
3. Diff to find the new entry
4. Extract URL, path, timestamps, and byte counts

**Caveat:** The plist is written by Safari and may lag slightly behind the actual filesystem completion. Use as supplementary metadata, not as the primary completion signal.

---

## 10. Implementation Spec for Safari Pilot

### New Command: `watch_download`

Add to the daemon's `CommandDispatcher`:

```swift
case "watch_download":
    return await handleWatchDownload(command: command)
```

**Parameters:**
```json
{
  "id": "cmd_123",
  "method": "watch_download",
  "params": {
    "timeout": 30000,           // ms, default 30000
    "directory": null,          // null = auto-detect from Safari prefs
    "filenamePattern": null,    // optional regex to match expected filename
    "moveToPath": null,         // optional: move file after download
    "removeQuarantine": false   // optional: strip quarantine xattr
  }
}
```

**Response:**
```json
{
  "id": "cmd_123",
  "ok": true,
  "value": {
    "filename": "document.pdf",
    "path": "/Users/user/Downloads/document.pdf",
    "url": "https://example.com/document.pdf",
    "referrer": "https://example.com/page",
    "size": 1048576,
    "mimeType": "application/pdf",
    "contentType": "com.adobe.pdf",
    "duration": 1523,
    "quarantined": true,
    "movedTo": null
  }
}
```

### New Swift Component: `DownloadWatcher`

**File:** `daemon/Sources/SafariPilotdCore/DownloadWatcher.swift`

Responsibilities:
1. Read Safari's download directory preference
2. Start FSEvents watcher on that directory
3. On `.download` bundle creation: attach DispatchSource for precise tracking
4. On rename/completion: verify file, read metadata, return result
5. On timeout: return failure

### TypeScript Tool: `safari_wait_for_download`

**File:** `src/tools/safari-wait-for-download.ts`

```typescript
{
  name: "safari_wait_for_download",
  description: "Wait for a file download to complete in Safari. Call this BEFORE triggering the download action. Returns metadata about the downloaded file.",
  inputSchema: {
    type: "object",
    properties: {
      timeout: { type: "number", description: "Timeout in ms (default 30000)" },
      filenamePattern: { type: "string", description: "Regex to match expected filename" },
      moveToPath: { type: "string", description: "Move file to this path after download" },
      removeQuarantine: { type: "boolean", description: "Strip Gatekeeper quarantine (default false)" },
    }
  }
}
```

### Integration Points

1. **Daemon startup:** `DownloadWatcher` initializes but doesn't start monitoring until first `watch_download` command
2. **Per-request lifecycle:** Each `watch_download` command creates a monitoring session that auto-cleans after completion or timeout
3. **Concurrent support:** Multiple `watch_download` commands can be active simultaneously (each tracks its own `.download` bundle)
4. **No external dependencies:** Uses only Foundation, CoreServices, and Dispatch — all available on macOS 12+ (the daemon's minimum target)

### Estimated Implementation Effort

| Component | Effort |
|-----------|--------|
| `DownloadWatcher.swift` (FSEvents + DispatchSource hybrid) | 2-3 hours |
| Metadata extraction (xattr + MDItem + Downloads.plist) | 1-2 hours |
| `watch_download` command routing in `CommandDispatcher` | 30 min |
| TypeScript tool definition + daemon bridge | 1 hour |
| Tests | 1-2 hours |
| **Total** | **~1 session** |

This aligns with the roadmap estimate.
