# P2 Video Recording Research: Safari Browser Session Capture

> Research for Safari Pilot's video recording feature -- capturing Safari browser sessions for debugging test failures using macOS ScreenCaptureKit.
>
> Date: 2026-04-12

---

## Table of Contents

1. [Executive Summary and Recommendation](#1-executive-summary-and-recommendation)
2. [ScreenCaptureKit API Deep Dive](#2-screencapturekit-api-deep-dive)
3. [Video Encoding Pipeline on macOS](#3-video-encoding-pipeline-on-macos)
4. [Playwright Video Recording Analysis](#4-playwright-video-recording-analysis)
5. [Window-Specific Capture Challenges](#5-window-specific-capture-challenges)
6. [Alternative Approaches](#6-alternative-approaches)
7. [Permission and Entitlement Model](#7-permission-and-entitlement-model)
8. [Performance Impact](#8-performance-impact)
9. [Implementation Design for Safari Pilot](#9-implementation-design-for-safari-pilot)
10. [Sources](#10-sources)

---

## 1. Executive Summary and Recommendation

**Recommended stack**: ScreenCaptureKit (capture) + AVAssetWriter (encoding) + VideoToolbox (hardware acceleration) + H.264 codec + MP4 container.

ScreenCaptureKit (macOS 12.3+) is the clear choice for Safari Pilot. It provides GPU-accelerated, window-specific capture that works even when the target window is obscured. The API delivers `CMSampleBuffer` frames via a delegate protocol, which feed directly into AVAssetWriter for hardware-encoded H.264 video output. On Apple Silicon, this pipeline consumes roughly 10-25% CPU at 1080p/30fps with hardware encoding offloaded to the media engine.

The primary challenge is the macOS TCC permission model: Screen Recording permission requires explicit user consent from a GUI session, making headless CI runners (standard GitHub Actions) unable to grant it. Solutions include self-hosted runners with auto-login sessions or MDM-deployed PPPC profiles.

**Key design decisions**:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Capture API | ScreenCaptureKit | Only modern API that captures specific windows while obscured; GPU-accelerated; Apple's forward path |
| Encoding | AVAssetWriter + VideoToolbox | Hardware-accelerated H.264/HEVC; real-time capable; native pipeline for CMSampleBuffer |
| Codec | H.264 (default), HEVC (optional) | H.264 for universal playback; HEVC halves file size but less portable |
| Container | MP4 | Cross-platform playback; CI artifact viewers support it natively |
| Default preset | 720p @ 20fps | ~30-60 MB/min; sufficient for debugging; minimal performance impact |
| Frame delivery | SCStreamOutput delegate | Real-time CMSampleBuffer delivery; IOSurface-backed for zero CPU-copy |
| macOS 15+ | SCRecordingOutput (optional) | Simplified API for direct-to-file recording; less control over encoding params |

---

## 2. ScreenCaptureKit API Deep Dive

### 2.1 Framework Overview

ScreenCaptureKit was introduced in macOS 12.3 (Monterey) as Apple's modern replacement for the deprecated `CGDisplayStream` and `CGWindowList` capture APIs. It is a GPU-accelerated framework designed for high-performance screen capture with low CPU overhead.

**Core classes and availability**:

| Class | Purpose | macOS Version |
|-------|---------|--------------|
| `SCShareableContent` | Enumerate available displays, windows, applications | 12.3+ |
| `SCWindow` | Represents a capturable window (ID, title, frame, owning app) | 12.3+ |
| `SCDisplay` | Represents a physical display (ID, width, height) | 12.3+ |
| `SCRunningApplication` | Represents a running app (bundle ID, name, PID) | 12.3+ |
| `SCContentFilter` | Defines what to capture (window, display, include/exclude) | 12.3+ |
| `SCStreamConfiguration` | Configures resolution, frame rate, pixel format, color space | 12.3+ |
| `SCStream` | Central capture controller; start/stop, deliver frames | 12.3+ |
| `SCRecordingOutput` | Direct-to-file recording (no manual AVAssetWriter needed) | 15.0+ |
| `SCRecordingOutputConfiguration` | Configure recording output format/settings | 15.0+ |
| `SCContentSharingPicker` | System UI for user to select content to share | 14.0+ |

**Key protocols**:

| Protocol | Purpose |
|----------|---------|
| `SCStreamOutput` | Receive `CMSampleBuffer` frames from active stream |
| `SCStreamDelegate` | Handle stream lifecycle events (errors, stops) |
| `SCRecordingOutputDelegate` | Handle recording output events (macOS 15+) |

### 2.2 Window Discovery with SCShareableContent

To find the Safari window, enumerate all shareable content and filter by bundle identifier:

```swift
let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

// Find Safari windows by bundle identifier
let safariWindows = content.windows.filter {
    $0.owningApplication?.bundleIdentifier == "com.apple.Safari"
}

// Select the target window (e.g., most recently focused, or by title)
guard let targetWindow = safariWindows.first else {
    throw CaptureError.safariWindowNotFound
}
```

Each `SCWindow` exposes:
- `windowID: CGWindowID` -- unique window identifier
- `title: String?` -- window title (e.g., the page title in Safari)
- `frame: CGRect` -- window frame in screen coordinates
- `isOnScreen: Bool` -- whether the window is visible
- `owningApplication: SCRunningApplication?` -- the app that owns the window
- `windowLayer: Int` -- the window layer (z-order)
- `isActive: Bool` -- whether the window is the active/key window

When multiple Safari windows exist, disambiguation strategies include:
1. Match by window title (page title)
2. Use `windowLayer` or `isActive` for the frontmost window
3. Cross-reference with `CGWindowListCopyWindowInfo` for additional metadata
4. Use the Accessibility API to get the focused window

### 2.3 Content Filtering

`SCContentFilter` restricts capture to specific content. For window-specific capture:

```swift
// Capture a single window, independent of which display it's on
let filter = SCContentFilter(desktopIndependentWindow: targetWindow)
```

This `desktopIndependentWindow` mode captures ONLY the specified window's content -- other windows, desktop wallpaper, and the menu bar are excluded. The window is captured in full even when partially or fully obscured by other windows.

Other filter modes:
- `SCContentFilter(display:excludingWindows:)` -- capture a display, excluding specific windows
- `SCContentFilter(display:excludingApplications:exceptingWindows:)` -- capture a display, excluding apps
- `SCContentFilter(display:includingWindows:)` -- capture a display, showing only listed windows
- `SCContentFilter(display:includingApplications:exceptingWindows:)` -- capture a display, showing only listed apps

### 2.4 Stream Configuration

`SCStreamConfiguration` controls the output characteristics:

```swift
var config = SCStreamConfiguration()

// Resolution: match the window size or set a fixed output size
config.width = 1280       // output pixel width
config.height = 720       // output pixel height

// Frame rate: 1/N seconds per frame
config.minimumFrameInterval = CMTime(value: 1, timescale: 20)  // 20 fps

// Pixel format
config.pixelFormat = kCVPixelFormatType_32BGRA  // for H.264

// Color space
config.colorSpaceName = CGColorSpace.sRGB       // for H.264

// Cursor: include or exclude
config.showsCursor = true

// Queue depth: frames buffered before delivery
// Higher = smoother but more memory and latency
// Default is 3; recommended 4-6 for recording
config.queueDepth = 6

// Cropping: capture only a sub-rectangle of the source
config.sourceRect = CGRect(x: 0, y: 44, width: 1280, height: 676)  // skip toolbar
config.destinationRect = CGRect(x: 0, y: 0, width: 1280, height: 676)

// Scaling
config.scalesToFit = true  // scale source to fit destination

// Audio (if needed)
config.capturesAudio = false
```

**Key properties reference**:

| Property | Type | Default | Purpose |
|----------|------|---------|---------|
| `width` | Int | Display width | Output pixel width |
| `height` | Int | Display height | Output pixel height |
| `minimumFrameInterval` | CMTime | 1/60 | Minimum time between frames |
| `pixelFormat` | OSType | BGRA | Pixel format of output buffers |
| `colorSpaceName` | CFString | sRGB | Color space for output |
| `showsCursor` | Bool | true | Include cursor in capture |
| `queueDepth` | Int | 3 | Frame buffer queue size |
| `sourceRect` | CGRect | full source | Sub-rectangle of source to capture |
| `destinationRect` | CGRect | full output | Where to place content in output |
| `scalesToFit` | Bool | false | Scale source to fit destination |
| `capturesAudio` | Bool | false | Also capture audio |
| `sampleRate` | Int | 48000 | Audio sample rate |
| `channelCount` | Int | 2 | Audio channel count |
| `includeChildWindows` | Bool | false | Include child/attached windows |
| `captureResolution` | SCCaptureResolutionType | .automatic | Best, nominal, or automatic |
| `streamName` | String? | nil | Debug name for the stream |

### 2.5 Frame Delivery via SCStreamOutput

Frames arrive via the `SCStreamOutput` protocol:

```swift
class StreamHandler: NSObject, SCStreamOutput {
    func stream(_ stream: SCStream,
                didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard sampleBuffer.isValid else { return }

        // Check frame status via attachments
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer, createIfNecessary: false
        ) as? [[SCStreamFrameInfo: Any]],
        let status = attachments.first?[.status] as? Int,
        SCFrameStatus(rawValue: status) == .complete else { return }

        // sampleBuffer contains an IOSurface-backed CVPixelBuffer
        // Pass to AVAssetWriter for encoding
        processFrame(sampleBuffer)
    }
}

// Add the handler to the stream
let handler = StreamHandler()
let stream = SCStream(filter: filter, configuration: config, delegate: streamDelegate)
try stream.addStreamOutput(handler, type: .screen,
    sampleHandlerQueue: DispatchQueue(label: "safari-pilot.capture"))
try await stream.startCapture()
```

**Frame status values** (from `SCStreamFrameInfo` attachments):
- `.complete` -- a new, fully rendered frame
- `.idle` -- no changes since last frame (screen static)
- `.blank` -- blank frame (window minimized or not visible)
- `.suspended` -- stream was suspended
- `.started` -- first frame after stream start

The `CMSampleBuffer` contains an `IOSurface`-backed `CVPixelBuffer`, meaning the frame data lives in GPU memory. This enables zero-copy handoff to the video encoder.

### 2.6 SCRecordingOutput (macOS 15+)

macOS 15 introduced `SCRecordingOutput` for simplified direct-to-file recording without manual AVAssetWriter setup:

```swift
let recordingConfig = SCRecordingOutputConfiguration()
recordingConfig.outputURL = outputFileURL
recordingConfig.videoCodecType = .h264
recordingConfig.outputFileType = .mp4

let recordingOutput = SCRecordingOutput(configuration: recordingConfig,
                                        delegate: recordingDelegate)

try stream.addRecordingOutput(recordingOutput)
try await stream.startCapture()

// ... later ...
try stream.removeRecordingOutput(recordingOutput)
```

**Tradeoffs vs. manual AVAssetWriter**:

| Aspect | SCRecordingOutput | AVAssetWriter |
|--------|-------------------|---------------|
| Complexity | Low (3-4 lines) | High (~50 lines) |
| Codec control | Basic (codec type, file type) | Full (bitrate, profile, keyframe interval) |
| macOS requirement | 15.0+ | 12.3+ |
| Known issues | Memory leaks with rapid start/stop on early macOS 15 | Stable, well-tested |
| Frame manipulation | None | Can filter/transform frames before encoding |
| Timestamp control | Automatic | Manual (required for correct timing) |

**Recommendation**: Use AVAssetWriter for Safari Pilot to support macOS 12.3+ and retain full control over encoding. Offer SCRecordingOutput as an optional fast-path when running on macOS 15+.

### 2.7 Permission Model

ScreenCaptureKit is gated by the TCC (Transparency, Consent, and Control) Screen Recording permission.

```swift
// Check permission without prompting
let hasPermission = CGPreflightScreenCaptureAccess()

// Request permission (shows system dialog)
// MUST be called from a signed GUI app in an interactive user session
let granted = CGRequestScreenCaptureAccess()
```

Key constraints:
- Permission is per-application, identified by bundle identifier and code signature
- The consent dialog can ONLY appear in an interactive GUI session with a logged-in user
- Background daemons (`LaunchDaemons`) cannot trigger the prompt
- `LaunchAgents` CAN trigger the prompt if running in a GUI session
- Once granted, the permission persists in the user's TCC database until revoked
- The Safari Pilot daemon runs as a LaunchAgent in the user session, so it CAN hold this permission

**For Safari Pilot specifically**: The Swift daemon already runs as a LaunchAgent under the user's session. When the user first uses video recording, the daemon can call `CGRequestScreenCaptureAccess()`, which will show the system permission dialog. The user grants it once, and it persists.

---

## 3. Video Encoding Pipeline on macOS

### 3.1 AVAssetWriter Setup

The encoding pipeline takes `CMSampleBuffer` frames from ScreenCaptureKit and writes them to a video file:

```swift
// 1. Create writer for MP4 output
let writer = try AVAssetWriter(url: outputURL, fileType: .mp4)

// 2. Configure video output settings
let videoSettings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: 1280,
    AVVideoHeightKey: 720,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 4_000_000,       // 4 Mbps
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        AVVideoMaxKeyFrameIntervalKey: 60,          // keyframe every 60 frames
        AVVideoExpectedSourceFrameRateKey: 20,
    ] as [String: Any],
    AVVideoColorPropertiesKey: [
        AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
        AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
        AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
    ] as [String: Any],
]

// 3. Create video input
let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
videoInput.expectsMediaDataInRealTime = true  // Critical for live capture

// 4. Add to writer and start
writer.add(videoInput)
writer.startWriting()
writer.startSession(atSourceTime: .zero)
```

Alternatively, use `AVOutputSettingsAssistant` for automatic settings:

```swift
guard let assistant = AVOutputSettingsAssistant(preset: .preset3840x2160) else { return }
assistant.sourceVideoFormat = try CMVideoFormatDescription(
    videoCodecType: .h264, width: width, height: height
)
var settings = assistant.videoSettings!
settings[AVVideoWidthKey] = width
settings[AVVideoHeightKey] = height
```

### 3.2 Frame Handling and Timestamp Management

Critical detail from the nonstrict-hq reference implementation: all sample buffer timestamps must be re-offset relative to the first frame to produce correct timing:

```swift
class StreamOutput: NSObject, SCStreamOutput {
    var firstSampleTime: CMTime = .zero
    var lastSampleBuffer: CMSampleBuffer?

    func stream(_ stream: SCStream,
                didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }

        // Validate frame is complete
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer, createIfNecessary: false
        ) as? [[SCStreamFrameInfo: Any]],
        let status = attachments.first?[.status] as? Int,
        SCFrameStatus(rawValue: status) == .complete else { return }

        guard videoInput.isReadyForMoreMediaData else {
            // Back-pressure: encoder can't keep up, drop frame
            return
        }

        // Offset timestamps relative to first frame
        if firstSampleTime == .zero {
            firstSampleTime = sampleBuffer.presentationTimeStamp
        }
        let offsetTime = sampleBuffer.presentationTimeStamp - firstSampleTime

        // Retime the sample buffer
        let timing = CMSampleTimingInfo(
            duration: sampleBuffer.duration,
            presentationTimeStamp: offsetTime,
            decodeTimeStamp: sampleBuffer.decodeTimeStamp
        )
        if let retimed = try? CMSampleBuffer(copying: sampleBuffer, withNewTiming: [timing]) {
            videoInput.append(retimed)
        }

        lastSampleBuffer = sampleBuffer
    }
}
```

### 3.3 Handling Static Content (Crucial Edge Case)

When nothing changes on screen, ScreenCaptureKit stops delivering frames (sends `.idle` status). This means the video might end prematurely if the last frame was delivered long before recording stopped. The fix: repeat the last frame at stop time.

```swift
func stopRecording() async throws {
    try await stream.stopCapture()

    // Pad with the last frame at current time
    if let lastBuffer = streamOutput.lastSampleBuffer {
        let currentTime = CMTime(
            seconds: ProcessInfo.processInfo.systemUptime,
            preferredTimescale: 100
        ) - streamOutput.firstSampleTime

        let timing = CMSampleTimingInfo(
            duration: lastBuffer.duration,
            presentationTimeStamp: currentTime,
            decodeTimeStamp: lastBuffer.decodeTimeStamp
        )
        let padBuffer = try CMSampleBuffer(copying: lastBuffer, withNewTiming: [timing])
        videoInput.append(padBuffer)
    }

    writer.endSession(atSourceTime: streamOutput.lastSampleBuffer?.presentationTimeStamp ?? .zero)
    videoInput.markAsFinished()
    await writer.finishWriting()
}
```

### 3.4 Codec Comparison

| Aspect | H.264 (AVC) | HEVC (H.265) |
|--------|-------------|--------------|
| Playback compatibility | Universal | macOS 10.13+, iOS 11+, modern browsers |
| File size (1080p/30fps) | ~70-130 MB/min @ 4-8 Mbps | ~35-65 MB/min @ 2-4 Mbps |
| File size (720p/20fps) | ~30-60 MB/min @ 2-4 Mbps | ~15-30 MB/min @ 1-2 Mbps |
| Hardware encoding | All Apple Silicon + recent Intel | All Apple Silicon + recent Intel |
| Max resolution (AVAssetWriter) | 4096 x 2304 | 7680 x 4320 |
| Pixel format | `kCVPixelFormatType_32BGRA` | `kCVPixelFormatType_ARGB2101010LEPacked` |
| Color space | sRGB | Display P3 (wider gamut) |
| Encoding CPU overhead | Very low | Very low (comparable to H.264) |
| CI artifact viewers | Universally supported | May require transcoding |

**Recommendation**: Default to H.264 for maximum compatibility. Offer HEVC as an option via configuration for users who need smaller files.

### 3.5 Container Format

| Aspect | MP4 | MOV |
|--------|-----|-----|
| Cross-platform | Yes (Windows, Linux, web) | macOS/iOS native |
| Web playback | `<video>` tag works directly | May need transcoding |
| CI artifact viewers | Universal | Limited |
| Feature set | Slightly restricted | Full QuickTime features |
| AVAssetWriter support | `.mp4` file type | `.mov` file type |

**Recommendation**: MP4 for portability. The nonstrict-hq reference uses MOV (Apple convention), but MP4 is strictly better for test artifacts that may be viewed on non-Mac systems.

---

## 4. Playwright Video Recording Analysis

### 4.1 Architecture

Playwright's video recording uses a multi-layer architecture:

1. **Browser screencast API**: Each browser engine provides frame capture
   - Chromium: CDP `Page.startScreencast` -- receives JPEG frames from the compositor
   - Firefox: Juggler protocol `TargetRegistry` -- native screencast implementation
   - WebKit: WebKit remote debugging protocol -- frame delivery
2. **Screencast class** (`screencast.ts`): Manages multiple clients (video recorder, tracing, etc.); distributes frames
3. **FfmpegVideoRecorder** (`videoRecorder.ts`): Pipes JPEG frames to ffmpeg, which encodes to VP8/WebM

### 4.2 Key Implementation Details

From Playwright's source code (`packages/playwright-core/src/server/videoRecorder.ts`):

- **Output format**: WebM container with VP8 codec (`.webm` extension required)
- **Frame rate**: 25 fps (hardcoded constant)
- **Resolution**: Defaults to viewport scaled to fit within 800x800px; both dimensions forced to even numbers (VP8 requirement)
- **Quality**: VP8 settings -- `qmin 0`, `qmax 50`, `crf 8`, `bitrate 1M`, `deadline realtime`, `speed 8`
- **Encoding**: ffmpeg subprocess receives JPEG frames via stdin (`image2pipe` mode)
- **Frame handling**: Frames are repeated to fill gaps when screen is static; 1 second padding added at end
- **Resize handling**: ffmpeg `pad` and `crop` filters resize mismatched frames to target video size

**Recording lifecycle**:
- Per-context: `recordVideo` option in browser context options
- Video saved on browser context close
- Modes: `'off'`, `'on'`, `'retain-on-failure'`, `'on-first-retry'`
- Path access: `page.video().path()` (available only after page/context close)

### 4.3 Key Differences from Safari Pilot's Approach

| Aspect | Playwright | Safari Pilot (proposed) |
|--------|-----------|------------------------|
| Capture source | Browser's internal compositor via protocol | OS-level window capture via ScreenCaptureKit |
| Encoding | ffmpeg subprocess (VP8/WebM) | Native AVAssetWriter (H.264/MP4) |
| Frame format | JPEG images piped to ffmpeg | CMSampleBuffer with IOSurface |
| Dependencies | Bundled ffmpeg binary | No external dependencies (native frameworks) |
| Window chrome | Not captured (content only) | Captured by default (can crop via sourceRect) |
| Obscured windows | N/A (captures from compositor) | Full capture even when obscured |
| Audio | Not captured | Available via ScreenCaptureKit |
| Performance | Medium (JPEG decode + VP8 encode) | Low (GPU-backed zero-copy pipeline) |

### 4.4 Design Lessons from Playwright

1. **Per-test isolation**: Each test gets its own video artifact -- simplifies debugging
2. **Retain-on-failure mode**: Only keep videos for failed tests -- saves storage in CI
3. **Static content padding**: Repeat last frame to fill recording duration -- prevent short videos
4. **Frame resize handling**: Handle mismatched frame sizes gracefully (pad/crop)
5. **Graceful stop**: Flush all buffered frames before closing the output file
6. **Even dimensions**: Ensure video dimensions are even numbers (codec requirement)
7. **Annotations**: Playwright 1.49+ supports visual annotations showing action names overlay on video

---

## 5. Window-Specific Capture Challenges

### 5.1 Obscured Windows

**ScreenCaptureKit captures the full window content even when obscured.** When using `SCContentFilter(desktopIndependentWindow:)`, the framework renders only the target window's layer, excluding all other windows. This is fundamentally different from legacy `CGWindowListCreateImage` which captures the screen as-is (including obscuring windows).

Exceptions:
- Transient system UI (context menus, secure input fields) may be filtered by privacy protections
- The Dock and menu bar are excluded (they're separate window layers)

### 5.2 Window Resize During Recording

When the Safari window is resized, the capture stream's configured dimensions no longer match the window. Two strategies:

**Strategy A -- Reconfigure the stream** (preferred for minor resizes):
```swift
config.width = newWidth
config.height = newHeight
try await stream.updateConfiguration(config)
```

**Strategy B -- Recreate the stream** (required for major geometry changes):
```swift
try await stream.stopCapture()
// ... reconfigure and create new SCStream ...
try await newStream.startCapture()
```

**Strategy C -- Fixed output size with scaling** (simplest, recommended for Safari Pilot):
- Set `config.width` and `config.height` to a fixed output size (e.g., 1280x720)
- Set `config.scalesToFit = true`
- ScreenCaptureKit automatically scales the window content to fit
- No reconfiguration needed when the window resizes

Strategy C is recommended because it avoids the complexity of tracking window geometry changes and produces a consistent video resolution regardless of window size changes.

### 5.3 Multiple Safari Windows

When multiple Safari windows are open, `SCShareableContent` returns all of them. Identification strategies for Safari Pilot:

1. **By window ID**: If Safari Pilot tracks which window it's automating (via AppleScript `id of window`), use `SCWindow.windowID` to match
2. **By title**: Match `SCWindow.title` against the expected page title
3. **By process and focus**: Use the Accessibility API to determine which Safari window is focused
4. **By tab binding**: If Safari Pilot knows the tab ID, correlate via window title or Accessibility tree

Recommended approach for Safari Pilot: track the `windowID` of the automated window from the start of the session, then match it against `SCWindow.windowID` when setting up the capture.

### 5.4 Tab Switching Within a Window

Tab switching within the same Safari window IS captured by ScreenCaptureKit. Since the framework captures the window's rendered content at the OS level, any visual change within the window (including tab switches, navigation, scrolling, animations) is captured in the frame stream.

### 5.5 Window Chrome vs. Web Content

ScreenCaptureKit captures the entire window, including:
- Title bar
- Toolbar (address bar, tab bar, back/forward buttons)
- Status bar
- Window frame/border

To crop to just the web content area:

```swift
// Use Accessibility API to get web content bounds
// AXWebArea element within Safari's AX hierarchy gives the content rect
let contentRect = getWebContentRect(windowID: targetWindow.windowID)

// Convert to window-local coordinates
config.sourceRect = CGRect(
    x: contentRect.origin.x - windowFrame.origin.x,
    y: contentRect.origin.y - windowFrame.origin.y,
    width: contentRect.width,
    height: contentRect.height
)
```

Alternatively, accept the full window capture (including chrome) -- for test debugging, seeing the URL bar and tab state can be valuable context.

**Recommendation for Safari Pilot**: Capture the full window by default (including chrome). Offer an option `cropToContent: true` for users who want only the web content area.

### 5.6 Fullscreen Mode

When Safari enters fullscreen mode:
- The window's frame changes to fill the entire screen
- The menu bar auto-hides
- The toolbar may hide (in Safari's minimal UI mode)

The `SCContentFilter(desktopIndependentWindow:)` filter continues to capture the correct window, but the stream configuration may need updating to match the new dimensions. Monitor for fullscreen transitions using:
- `NSWindow.didEnterFullScreenNotification` / `didExitFullScreenNotification`
- `NSWorkspace.activeSpaceDidChangeNotification`
- Accessibility API notifications

With Strategy C (fixed output size + scaling), fullscreen transitions are handled automatically -- the content just scales differently within the same output dimensions.

---

## 6. Alternative Approaches

### 6.1 `screencapture` CLI

The built-in `screencapture` command supports video recording:

```bash
# Record the entire screen for 30 seconds
screencapture -v -V 30 output.mov

# Record a specific window (still image only -- -l flag)
screencapture -l <windowid> output.png
```

**Key limitation**: The `-v` (video) flag records the ENTIRE screen. The `-l <windowid>` flag captures a specific window but only for still images, not video. There is no way to combine `-v` and `-l` for window-specific video recording.

**Verdict**: Not suitable for Safari Pilot. Would require recording full screen and post-processing to crop to the Safari window, which is wasteful and complex.

### 6.2 AVFoundation (AVCaptureScreenInput) -- Deprecated

The older AVFoundation approach used `AVCaptureScreenInput`:

```swift
let screenInput = AVCaptureScreenInput(displayID: CGMainDisplayID())
screenInput?.cropRect = windowFrame  // crop to window area
let session = AVCaptureSession()
session.addInput(screenInput!)
// ... add AVCaptureMovieFileOutput ...
session.startRunning()
```

**Problems**:
- Captures the display, not a specific window -- obscuring windows appear in the capture
- `cropRect` is display-relative, not window-relative -- breaks when window moves
- Apple has deprecated this in favor of ScreenCaptureKit
- Less performant than ScreenCaptureKit (2-3x higher CPU)

**Verdict**: Not recommended. Deprecated, inferior capture quality, no window-independent mode.

### 6.3 CGWindowListCreateImage (Frame-by-Frame)

The legacy approach polls for individual frame captures:

```swift
// Capture a single frame of a specific window
let image = CGWindowListCreateImage(
    .null,
    .optionIncludingWindow,
    windowID,
    [.boundsIgnoreFraming, .bestResolution]
)
```

**Problems**:
- Polling-based: must call repeatedly (e.g., 20x/sec) from a timer
- CPU-intensive: each call forces a compositor snapshot
- No hardware acceleration for the capture itself
- Must manually encode frames into video (additional overhead)
- Captures obscured windows correctly, but with significant CPU cost

**Verdict**: Fallback option only. Could be used on macOS versions < 12.3, but performance is poor.

### 6.4 CGDisplayStream -- Deprecated

```swift
let stream = CGDisplayStream(
    display: displayID,
    outputWidth: width,
    outputHeight: height,
    pixelFormat: Int32(kCVPixelFormatType_32BGRA),
    properties: nil,
    handler: { status, displayTime, frameSurface, updateRef in
        // Process IOSurface frame
    }
)
stream?.start()
```

**Problems**:
- Officially deprecated -- Apple explicitly recommends ScreenCaptureKit
- Captures entire display, not a specific window
- Will likely be removed in a future macOS release
- Less performant than ScreenCaptureKit

**Verdict**: Do not use. Deprecated with no future.

### 6.5 QuickTime Automation via AppleScript

```applescript
tell application "QuickTime Player"
    set newScreenRecording to new screen recording
    start newScreenRecording
    -- ... wait ...
    stop newScreenRecording
    save newScreenRecording in file outputPath
end tell
```

**Problems**:
- Records entire screen (no window targeting)
- Requires user interaction to select recording area
- Slow startup (QuickTime launch + initialization)
- No programmatic control over resolution/codec
- Unreliable for automation

**Verdict**: Not suitable. Too slow, no window targeting, requires UI interaction.

### 6.6 Comparison Summary

| Method | Window-Specific | Obscured Capture | Performance | macOS Support | Status |
|--------|----------------|------------------|-------------|---------------|--------|
| **ScreenCaptureKit** | Yes (filter) | Yes | Excellent (GPU) | 12.3+ | Active, recommended |
| screencapture CLI | No (full screen only for video) | N/A | Medium | 10.15+ | Stable |
| AVCaptureScreenInput | No (display + crop) | No | Medium | 10.7+ | Deprecated |
| CGWindowListCreateImage | Yes | Yes | Poor (polling) | 10.5+ | Deprecated |
| CGDisplayStream | No (display only) | N/A | Medium | 10.8+ | Deprecated |
| QuickTime AppleScript | No | N/A | Very Poor | 10.x+ | Stable but unsuitable |

---

## 7. Permission and Entitlement Model

### 7.1 TCC Framework

Screen Recording is governed by macOS TCC (Transparency, Consent, and Control). The permission flow:

1. App calls `CGRequestScreenCaptureAccess()` (or attempts to use ScreenCaptureKit)
2. If no prior decision exists, macOS shows a system consent dialog
3. User approves or denies
4. Decision stored in `~/Library/Application Support/com.apple.TCC/TCC.db`
5. Managed by `tccd` daemon
6. Permission persists until user explicitly revokes it in System Settings

### 7.2 Programmatic Permission APIs

```swift
// Non-intrusive check: does the app already have permission?
// Returns immediately, never shows UI
let hasPermission: Bool = CGPreflightScreenCaptureAccess()

// Request permission: triggers system dialog if no prior decision
// Returns true if permission was granted
// ONLY works from a signed GUI app in an interactive user session
let granted: Bool = CGRequestScreenCaptureAccess()
```

**Important behaviors**:
- `CGPreflightScreenCaptureAccess()` returns `false` if no decision has been made yet
- `CGRequestScreenCaptureAccess()` returns `false` immediately if called from a non-GUI context (no dialog shown)
- On macOS 14+, the first call to ScreenCaptureKit APIs (like `SCShareableContent`) also triggers the permission prompt
- Permission is tied to the app's bundle identifier AND code signature

### 7.3 Safari Pilot's Permission Context

The Safari Pilot Swift daemon runs as a LaunchAgent (not a LaunchDaemon), meaning it operates within the user's login session. This is important because:

- **LaunchDaemon** (runs as root, no GUI session) -- CANNOT request Screen Recording permission
- **LaunchAgent** (runs in user session) -- CAN request permission if the session is interactive

However, LaunchAgents don't have a visible UI by default. The permission dialog is shown by the system (not by the app), so it will appear even for "headless" LaunchAgents as long as a GUI session is active (user is logged in with a display).

**Recommended flow for Safari Pilot**:
1. When `safari_start_recording` is called, check `CGPreflightScreenCaptureAccess()`
2. If denied, return a structured error with instructions: "Screen Recording permission required. Grant it in System Settings > Privacy & Security > Screen Recording for Safari Pilot Daemon"
3. Optionally call `CGRequestScreenCaptureAccess()` to trigger the system dialog
4. Cache the permission state to avoid repeated checks

### 7.4 CI/CD Implications

**Standard GitHub Actions macOS runners**: Cannot grant Screen Recording permission. The runners operate in a restricted environment without a full interactive GUI session. `CGRequestScreenCaptureAccess()` fails silently.

**Self-hosted macOS runners**: Can work if:
1. The machine has an auto-login user account
2. Screen Recording permission was granted once manually
3. The permission persists across reboots (stored in TCC.db)

**MDM-managed machines**: The most robust CI solution:
1. Create a PPPC (Privacy Preferences Policy Control) configuration profile
2. Grant `kTCCServiceScreenCapture` to the Safari Pilot daemon's bundle ID and code signature
3. Deploy via MDM (Jamf, Mosyle, Kandji, etc.)
4. Permission is pre-approved -- no user interaction needed

**Example PPPC profile payload**:
```xml
<dict>
    <key>Authorization</key>
    <string>AllowStandardUserToSetSystemService</string>
    <key>CodeRequirement</key>
    <string>identifier "com.safari-pilot.daemon" and anchor apple generic</string>
    <key>Identifier</key>
    <string>com.safari-pilot.daemon</string>
    <key>IdentifierType</key>
    <string>bundleID</string>
    <key>StaticCode</key>
    <false/>
    <key>Allowed</key>
    <true/>
</dict>
```

**TCC.db direct manipulation**: Technically possible but strongly discouraged. The database is SIP-protected on macOS 11+ and editing it directly is unsupported, may break with OS updates, and requires disabling SIP (which compromises system security). Not viable for CI.

### 7.5 Permission Detection and User Guidance

Safari Pilot should implement robust permission detection:

```swift
func checkRecordingPermission() -> RecordingPermissionStatus {
    if CGPreflightScreenCaptureAccess() {
        return .granted
    }

    // Detect if we're in a headless/CI environment
    let hasWindowServer = NSWorkspace.shared.runningApplications.contains {
        $0.bundleIdentifier == "com.apple.WindowServer"
    }

    if !hasWindowServer {
        return .headlessEnvironment(
            message: "Screen Recording requires an interactive GUI session. " +
                     "Use a self-hosted runner with auto-login or deploy a PPPC profile via MDM."
        )
    }

    return .notGranted(
        message: "Screen Recording permission required. " +
                 "Grant it in System Settings > Privacy & Security > Screen Recording."
    )
}
```

---

## 8. Performance Impact

### 8.1 CPU/GPU Utilization

ScreenCaptureKit's performance on Apple Silicon (measured estimates from documentation and community benchmarks):

| Preset | Resolution | FPS | CPU (Apple Silicon) | CPU (Intel) | GPU |
|--------|-----------|-----|--------------------|----|-----|
| CI-Optimized | 720p | 20 | 8-15% | 15-25% | 5-10% |
| Standard | 1080p | 30 | 15-25% | 20-35% | 10-15% |
| High Quality | 4K | 30 | 20-30% | 30-45% | 15-20% |

These numbers include both capture and hardware-accelerated encoding. The actual impact on Safari's rendering performance is minimal because:
- ScreenCaptureKit reads from the window compositor's existing render pipeline
- No additional compositing work is required for the captured window
- Hardware encoding is offloaded to the dedicated media engine (Apple Silicon) or Intel Quick Sync

### 8.2 Memory Footprint

Memory consumption depends on resolution and queue depth:

| Resolution | Queue Depth | Approximate Memory |
|-----------|------------|-------------------|
| 720p (1280x720) | 3 (default) | 50-80 MB |
| 720p (1280x720) | 6 (recommended) | 80-120 MB |
| 1080p (1920x1080) | 3 | 100-150 MB |
| 1080p (1920x1080) | 6 | 150-200 MB |
| 4K (3840x2160) | 3 | 300-400 MB |

Each frame is stored as a GPU-backed IOSurface texture. Critical to release `CMSampleBuffer` references promptly after encoding to prevent accumulation.

### 8.3 File Size Estimates

At the recommended CI-Optimized preset (720p/20fps/H.264):

| Recording Duration | Estimated File Size |
|-------------------|-------------------|
| 10 seconds | 5-10 MB |
| 30 seconds | 15-30 MB |
| 1 minute | 30-60 MB |
| 5 minutes | 150-300 MB |
| 10 minutes | 300-600 MB |

For HEVC at the same resolution: roughly half these sizes.

### 8.4 Impact on Safari Rendering

Recording via ScreenCaptureKit has negligible impact on Safari's rendering performance:
- The framework reads from the window server's existing composite buffer
- No additional rendering passes are triggered in Safari
- Safari's JavaScript execution is unaffected
- Page load times should not change measurably
- Scrolling performance may see a marginal (1-2ms) increase in frame time due to compositor contention, but this is within noise

The main performance risk is in the encoding pipeline: if AVAssetWriter falls behind (e.g., on a heavily loaded CI machine), frames are dropped rather than causing back-pressure on Safari.

### 8.5 Recommended Frame Rate for Test Recording

| Frame Rate | Use Case | Tradeoff |
|-----------|----------|----------|
| 10 fps | Long-running tests, CI with storage constraints | Low resource use; may miss fast animations |
| 15 fps | General test recording | Good balance; captures most interactions |
| **20 fps** | **Recommended default** | **Smooth enough for debugging; reasonable file size** |
| 30 fps | Animation-heavy tests, visual regression | Higher quality; 50% more storage |
| 60 fps | Rarely needed for test debugging | Excessive for most use cases |

**Recommendation**: Default to 20 fps. Allow users to configure 10-60 fps range.

### 8.6 ScreenCaptureKit vs. Legacy API Performance

| Metric | ScreenCaptureKit | CGDisplayStream | CGWindowListCreateImage |
|--------|-----------------|-----------------|------------------------|
| CPU usage (1080p/30fps) | 15-25% | 30-50% | 60-80% |
| GPU pipeline | Native, zero-copy | Partial | None (CPU compositing) |
| Latency | 2-3 frames | 3-5 frames | N/A (polling) |
| Frame delivery | Push (delegate) | Push (callback) | Pull (polling timer) |
| Window isolation | Native | Not supported | Supported |

ScreenCaptureKit is 2-3x more efficient than legacy approaches due to its deep integration with the window server's GPU pipeline.

---

## 9. Implementation Design for Safari Pilot

### 9.1 Proposed API

```
# MCP Tools
safari_start_recording(options?)  -> { recordingId, status }
safari_stop_recording(recordingId) -> { path, duration, fileSize, resolution, codec }
```

**Options for `safari_start_recording`**:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `windowId` | Int? | auto (active window) | Specific Safari window to record |
| `resolution` | String | "720p" | Output resolution: "720p", "1080p", "native" |
| `fps` | Int | 20 | Frame rate: 10-60 |
| `codec` | String | "h264" | Video codec: "h264", "hevc" |
| `format` | String | "mp4" | Container format: "mp4", "mov" |
| `outputPath` | String? | auto (temp dir) | Where to save the file |
| `showCursor` | Bool | true | Include cursor in recording |
| `cropToContent` | Bool | false | Crop to web content (exclude chrome) |
| `includeAudio` | Bool | false | Record system audio |

### 9.2 Recording Lifecycle

```
1. safari_start_recording() called
   |
   v
2. Check CGPreflightScreenCaptureAccess()
   |-- Denied -> Return structured error with permission instructions
   |
   v
3. Enumerate windows via SCShareableContent
   |-- Find Safari window by windowId or active window heuristic
   |-- Not found -> Return error
   |
   v
4. Create SCContentFilter(desktopIndependentWindow:)
   |
   v
5. Configure SCStreamConfiguration (resolution, fps, pixel format)
   |
   v
6. Set up AVAssetWriter + AVAssetWriterInput
   |-- Configure codec, bitrate, color properties
   |-- Set expectsMediaDataInRealTime = true
   |-- Start writing session
   |
   v
7. Create SCStream, add StreamOutput handler
   |
   v
8. Start capture -> Return { recordingId, status: "recording" }
   |
   v
   ... recording frames ...
   |
   v
9. safari_stop_recording(recordingId) called
   |
   v
10. Stop SCStream capture
    |
    v
11. Pad last frame to current time (handle static content)
    |
    v
12. Finalize AVAssetWriter (endSession, markAsFinished, finishWriting)
    |
    v
13. Return { path, duration, fileSize, resolution, codec }
```

### 9.3 Error Handling

| Error Condition | Detection | Response |
|----------------|-----------|----------|
| No screen recording permission | `CGPreflightScreenCaptureAccess()` returns false | Return error with permission instructions |
| Safari window not found | No matching SCWindow | Return error listing available windows |
| Window closed during recording | `SCStreamDelegate.stream(_:didStopWithError:)` | Finalize partial video, return with warning |
| Window minimized | Frame status becomes `.blank` | Pause encoding, resume on restore |
| Encoder back-pressure | `videoInput.isReadyForMoreMediaData` returns false | Drop frames, log warning |
| Disk full | AVAssetWriter error | Finalize what's possible, return error |
| Recording already active | Check active recordings set | Return error |

### 9.4 Recommended Presets

| Preset | Resolution | FPS | Codec | Est. File Size/min | Use Case |
|--------|-----------|-----|-------|-------------------|----------|
| `ci` | 720p | 15 | H.264 | ~20-40 MB | CI environments, storage-constrained |
| `default` | 720p | 20 | H.264 | ~30-60 MB | General test debugging |
| `quality` | 1080p | 30 | H.264 | ~70-130 MB | Detailed visual inspection |
| `compact` | 720p | 20 | HEVC | ~15-30 MB | When file size matters most |

### 9.5 Architecture Within Safari Pilot

The recording capability integrates into the existing Swift daemon:

```
Safari Pilot Architecture:
  MCP Server (Node.js)
    |
    v
  Swift Daemon (LaunchAgent)  <-- Add recording module here
    |
    +-- ScreenCaptureKit capture (SCStream)
    +-- AVAssetWriter encoding (H.264/HEVC)
    +-- Recording state management
    |
    v
  Safari (via AppleScript / Web Extension)
```

The recording runs entirely within the Swift daemon process. No new processes or dependencies needed. The daemon already runs as a LaunchAgent in the user session, which is the correct context for Screen Recording permission.

---

## 10. Sources

### Apple Documentation and WWDC

- Apple Developer Documentation: ScreenCaptureKit Framework -- https://developer.apple.com/documentation/screencapturekit
- WWDC 2022 Session 10156: "Meet ScreenCaptureKit" -- https://developer.apple.com/videos/play/wwdc2022/10156/
- WWDC 2022 Session 10155: "Take ScreenCaptureKit to the next level" -- https://developer.apple.com/videos/play/wwdc2022/10155/
- Apple Developer Documentation: SCStreamConfiguration -- https://developer.apple.com/documentation/screencapturekit/scstreamconfiguration
- Apple Developer Documentation: SCContentFilter -- https://developer.apple.com/documentation/screencapturekit/sccontentfilter
- Apple Developer Documentation: SCRecordingOutput -- https://developer.apple.com/documentation/screencapturekit/screcordingoutput
- Apple Developer Documentation: AVAssetWriter -- https://developer.apple.com/documentation/avfoundation/avassetwriter
- Apple Developer Documentation: CGPreflightScreenCaptureAccess -- https://developer.apple.com/documentation/coregraphics/3656523-cgpreflightscreencaptureaccess
- Apple Developer Documentation: CGRequestScreenCaptureAccess -- https://developer.apple.com/documentation/coregraphics/3656524-cgrequestscreencaptureaccess

### Reference Implementations

- nonstrict-hq/ScreenCaptureKit-Recording-example (MIT) -- https://github.com/nonstrict-hq/ScreenCaptureKit-Recording-example
- Nonstrict blog: "Recording to disk with ScreenCaptureKit" -- https://nonstrict.eu/blog/2023/recording-to-disk-with-screencapturekit/

### Playwright Source Code

- Playwright screencast.ts -- https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/screencast.ts
- Playwright videoRecorder.ts -- https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/videoRecorder.ts
- Playwright Video Recording docs -- https://playwright.dev/docs/videos

### macOS System Documentation

- `man screencapture` (macOS built-in)
- GitHub Actions runner-images macOS configuration -- https://github.com/actions/runner-images

### Deep Research Report

- Parallel deep research report (trun_4e978fe567d34864a8be54f0307237b8) -- detailed analysis across all 7 research areas, generated 2026-04-12
