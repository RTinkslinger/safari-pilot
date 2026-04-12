# Executive Summary

For implementing window-specific video recording in the Safari Pilot automation framework, the recommended approach is to use Apple's modern ScreenCaptureKit framework (macOS 12.3+). This framework provides a high-performance, low-latency pipeline for capturing content directly from a specific Safari window, even when obscured. The process involves using `SCShareableContent` to enumerate and identify the target Safari window, applying an `SCContentFilter` to isolate the capture to that window, and configuring an `SCStream` with desired parameters like resolution and frame rate. The resulting `CMSampleBuffer` frames should then be encoded into a video file using `AVAssetWriter`, leveraging hardware-accelerated `VideoToolbox` encoders (H.264 or HEVC) for efficiency. The most significant challenge is the macOS permission model (TCC), which requires explicit user consent for Screen Recording, granted via a UI prompt. This makes deployment in headless CI/CD environments like standard GitHub Actions runners problematic, as they cannot display the prompt. Solutions require using self-hosted runners with pre-configured user sessions or managing permissions via MDM profiles. Other challenges include robustly handling window resizes, fullscreen transitions, and cropping the browser chrome, all of which are solvable with the ScreenCaptureKit API and auxiliary macOS frameworks.

# Recommended Technical Stack

## Primary Capture Framework

ScreenCaptureKit

## Encoding Library

AVAssetWriter

## Hardware Acceleration Api

VideoToolbox

## Recommended Codec

H.264 for maximum compatibility and portability of test artifacts, especially in CI/CD environments. HEVC (H.265) is a viable alternative if file size is a primary concern, as it offers comparable quality at roughly half the bitrate, but may have less universal playback support.

## Recommended Container

MP4 (MPEG-4 Part 14) is the recommended container format due to its widespread portability and compatibility across different operating systems and web browsers. This makes it ideal for sharing and viewing test recordings. MOV is a native macOS alternative but offers no significant advantages for this use case.


# Screencapturekit Api Deep Dive

## Window Discovery

To discover and select a target Safari window, the primary tool is `SCShareableContent`. By calling `SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)`, an application can asynchronously retrieve a list of all shareable content, including on-screen windows. This list can then be filtered to find the desired Safari window. The most reliable method is to filter the returned array of `SCWindow` objects by the owning application's bundle identifier, which for Safari is `com.apple.Safari`. In cases where multiple Safari windows are open, further disambiguation can be achieved by examining window titles, z-order, or using heuristics like selecting the most recently focused window, which can be determined using other macOS frameworks like `CGWindowList` or Accessibility APIs.

## Content Filtering

Once the target `SCWindow` object representing the Safari window has been identified, a `SCContentFilter` is used to restrict the capture to that window exclusively. This is achieved by initializing the filter using `SCContentFilter(desktopIndependentWindow: window)`. This configuration ensures that the resulting stream will only contain the pixels of the specified window, even if it is partially or fully obscured by other windows. The framework handles compositing the window content correctly. Additionally, for more granular control, the `contentRect` property on `SCStreamConfiguration` can be used in conjunction with the filter to crop out parts of the window, such as the title bar and toolbar, by providing a specific rectangle within the window's coordinate space.

## Stream Configuration

The `SCStreamConfiguration` object is used to define the properties of the output video stream. Key properties include `width` and `height` for the output resolution, `minimumFrameInterval` to control the frame rate (e.g., `CMTime(value: 1, timescale: 30)` for 30 fps), and `pixelFormat` (e.g., `kCVPixelFormatType_32BGRA`) to specify the color format of the captured frames. The `scalingMode` property (e.g., `.scaleToFit`) determines how the source content is scaled to the output resolution. For test automation, a lower frame rate like 20 fps is often sufficient and reduces resource usage. If the window geometry changes significantly (e.g., resize or fullscreen transition), the stream may need to be reconfigured or recreated to avoid encoder mismatches or artifacts.

## Frame Delivery

Frames are delivered from an active `SCStream` to the application via a delegate that conforms to the `SCStreamOutput` protocol. The application must add this delegate to the stream using `stream.addStreamOutput(handler, type: .screen, ...)`. The delegate's `stream(_:didOutputSampleBuffer:of:)` method is then called for each new frame. This method receives a `CMSampleBuffer` object, which contains the captured video frame as an `IOSurface-backed CVPixelBuffer`. This buffer can be passed directly to an encoding pipeline, such as one using `AVAssetWriter`, for efficient processing with minimal CPU-side copies. It is crucial to preserve the presentation timestamps from the sample buffers to ensure correct timing in the final video file.

## Direct Recording Api

Starting with macOS 15, Apple introduced `SCRecordingOutput`, a simplified API for direct-to-file recording. This API abstracts away the need for a manual encoding pipeline using `AVAssetWriter`. It is set up as an output on the `SCStream` and handles the process of encoding the frames and writing them to a movie file. While this simplifies the implementation significantly, it offers less granular control over encoding parameters (like bitrate, keyframe interval, etc.) compared to a custom `AVAssetWriter` setup. It is an excellent option for scenarios where simplicity is prioritized over fine-tuned control. However, early versions on macOS 15 have exhibited memory leaks with rapid start/stop cycles, suggesting it's best to reuse a single output instance where possible.


# Video Encoding Pipeline On Macos

## Writer Setup

To encode `CMSampleBuffer` frames from ScreenCaptureKit into a video file, the standard AVFoundation pipeline involves `AVAssetWriter`. First, an `AVAssetWriter` instance is initialized with a destination file URL and file type (e.g., `.mp4`). Then, an `AVAssetWriterInput` is created for the video track, configured with the desired output settings (codec, dimensions, etc.). To feed the pixel buffers from ScreenCaptureKit into this input, an `AVAssetWriterInputPixelBufferAdaptor` is attached to the writer input. The `CMSampleBuffer` objects received from the `SCStreamOutput` delegate can then be appended to the writer via this adaptor, which handles the conversion and encoding process.

## Hardware Acceleration

For optimal performance and minimal CPU/GPU overhead, it is critical to leverage hardware-accelerated video encoding. On macOS, this is achieved through the VideoToolbox framework. When configuring the `AVAssetWriterInput`, specifying a modern codec like H.264 (`.h264`) or HEVC (`.hevc`) will cause AVFoundation to automatically use the available hardware encoders on Apple Silicon and recent Intel Macs. This offloads the computationally expensive encoding task from the CPU to dedicated media engine hardware, resulting in significantly lower resource utilization (~10-25% CPU on Apple Silicon) and enabling real-time recording at high resolutions and frame rates without impacting the performance of the application under test (Safari).

## Codec Tradeoffs

The choice of video codec involves a trade-off between compatibility and file size. H.264 (AVC) is the most widely compatible codec, ensuring that the resulting video files can be played back on almost any device or platform without special software. This makes it a safe and reliable choice for CI/CD artifacts. HEVC (H.265), on the other hand, offers superior compression, typically reducing file sizes by up to 50% compared to H.264 at a similar level of visual quality. This can lead to significant savings in storage and bandwidth, but may require more modern hardware or software for playback. For container formats, MP4 is the most portable choice, whereas MOV is native to the Apple ecosystem.

## Real Time Encoding

When encoding a live stream from ScreenCaptureKit, it's important to configure the pipeline for real-time operation. The `expectsMediaDataInRealTime` property on the `AVAssetWriterInput` should be set to `true`. This hints to the writer that it should optimize for low-latency processing rather than offline transcoding. It's also crucial to manage back-pressure. If the encoder cannot keep up with the incoming frame rate, buffers can build up, leading to increased memory usage and latency. The application should monitor the `isReadyForMoreMediaData` property of the writer input and pause appending frames if it returns false. Promptly releasing `CMSampleBuffer` objects after they have been appended to the writer is also essential to prevent memory from accumulating.


# Playwright Implementation Analysis

## Recording Mechanism

Playwright utilizes the native screencasting capabilities of each browser engine. For Chromium-based browsers, it uses the Chrome DevTools Protocol (CDP), specifically the `Page.startScreencast` API, to receive encoded frames (typically JPEG/PNG snapshots) directly from the browser's compositor. For WebKit, it employs a similar mechanism through WebKit’s remote-debugging protocol, which also delivers frame data. Playwright then abstracts these different implementations behind a unified API, later encoding the received image frames into a video file.

## Output Formats

By default, Playwright saves videos for Chromium in the WebM container format using the VP8 or VP9 codec. It can also transcode these videos into the MP4 format for broader compatibility. The frames received from the browser's screencast API are often individual images (like JPEG), which Playwright then encodes and muxes into the final video file using tools like FFmpeg or an internal muxer.

## Lifecycle Management

Playwright's testing framework tightly integrates video recording with the test execution lifecycle. A video is typically recorded on a per-test or per-context basis, starting when the test begins and stopping when it concludes. The final video artifact is written to disk upon test completion. Intermediate frames are stored in a temporary location and cleaned up afterwards, unless configured to be retained. The framework also provides manual control through `page.screencast.start()` and `page.screencast.stop()` for custom recording lifecycles.

## Key Design Takeaways

Several key design lessons from Playwright's implementation can be applied to Safari Pilot's native ScreenCaptureKit approach. These include: 1) **Per-Test Isolation**: Adopt a model where each test run generates its own isolated video artifact, simplifying debugging. 2) **Rich Metadata**: Embed or store alongside the video useful metadata such as the test ID, timestamp, viewport size, macOS version, and Safari Pilot version. 3) **Robust Failure Handling**: In case of an unexpected stop, ensure any captured frames are assembled into a partial video file and marked as incomplete, rather than being discarded. 4) **Resize Management**: Handle viewport resizes gracefully, either by starting a new video segment and concatenating later or by scaling frames to a fixed resolution before encoding. 5) **Clear CI/CD Diagnostics**: Detect permission issues (like TCC grants) or non-interactive sessions early and provide clear, actionable error messages, with documentation on pre-authorizing runners.


# Window Capture Challenges And Solutions

## Obscured Windows

ScreenCaptureKit is capable of capturing the full content of a target Safari window even when it is partially or completely obscured by other windows. The framework delivers frames containing the composited content of the specified window, and the occluding windows are not included in the capture. However, it's noted that transient UI elements like context menus or secure input fields may be omitted from the stream depending on the system's privacy filters.

## Window Resizing

When a captured window is resized, the stream's configuration must be updated. For minor size adjustments, reconfiguring the existing stream's `contentRect` and `scale` properties via `updateConfiguration(_:)` may be sufficient. However, for significant geometry changes, the recommended strategy is to recreate the entire `SCStream` instance. This avoids potential mismatches or errors in the underlying video encoder which may not handle dynamic resolution changes gracefully.

## Multiple Window Identification

To select the correct Safari window when multiple are open, the primary method is to use `SCShareableContent` to enumerate all available windows. The resulting list of `SCWindow` objects can be filtered by the owning application's bundle identifier (`com.apple.Safari`). To further disambiguate, you can use additional properties such as the window ID, window title, z-order, and last-focused timestamps, which can be obtained via `CGWindowList` or Accessibility APIs. A common heuristic is to select the most recently focused Safari window for capture.

## Cropping Window Chrome

To exclude the browser's title bar and toolbar (chrome) from the recording, you can use the `contentRect` property within the `SCStreamConfiguration`. The precise coordinates for this content rectangle can be calculated by using the Accessibility (AX) APIs to inspect the window's UI element hierarchy and determine the bounds of the web content area relative to the overall window bounds. This method provides efficient, server-side cropping before the frames are delivered to the application, which is more performant than post-processing the frames with CoreGraphics.

## Fullscreen Transitions

When a window enters or exits fullscreen mode, its bounds change significantly, and system elements like the menu bar may auto-hide. This requires the capture stream to be reconfigured. The application should monitor for fullscreen, space, and window change notifications using APIs like Accessibility (AX), `NSWindow`, or `CGWindowList`. Upon detecting a fullscreen transition, the stream should be reconfigured or, more robustly, recreated entirely to match the new geometry and ensure the capture continues correctly.


# Alternative Recording Methods Comparison

## Method Name

screencapture CLI

## Description

The `screencapture` command-line interface is a utility built into macOS (available since Catalina) that can capture screen content. While it can capture still images of specific windows, its video recording capability (activated with the `-v` flag) is limited to capturing the entire screen. To achieve window-specific video, one would need to record the full screen and then use post-processing tools to crop the video to the desired window's dimensions.

## Performance Impact

Compared to the modern and highly optimized ScreenCaptureKit, the `screencapture` CLI imposes a 'Medium' CPU/GPU load. It is less efficient because it captures the entire display buffer rather than targeting a specific window's compositor layer directly, leading to higher resource consumption for the same task.

## Ci Cd Viability

The `screencapture` CLI is simple to execute as a single command, making it technically viable in a CI/CD pipeline. However, its primary challenge is the same as other methods: it requires the 'Screen Recording' permission to be granted by the system's TCC framework. On headless CI runners (like default GitHub Actions runners) that lack a user session, this permission cannot be granted via a UI prompt, making its use problematic unless the runner is pre-configured with the permission via MDM or manual setup.

## Maintenance Risk

The maintenance risk for using the `screencapture` CLI is considered 'Low'. It is a standard, officially supported command-line utility provided by Apple as part of macOS. Its core functionality is stable and unlikely to be deprecated or undergo breaking changes without a long notice period, making it a relatively safe choice from a long-term maintenance perspective.


# Permission And Entitlement Model Guide

## Tcc Framework Overview

Screen Recording on macOS is governed by the Transparency, Consent, and Control (TCC) security framework. The first time an application attempts to use screen capture APIs like ScreenCaptureKit, TCC intercepts the call and presents a system-level prompt to the currently logged-in user, asking for permission. This consent is granted on a per-application basis, identified by the app's unique bundle identifier. Once a user makes a choice, the decision is securely stored in a protected SQLite database (TCC.db), which is managed by the system's `tccd` daemon. This daemon is responsible for enforcing the stored policies, ensuring that only authorized applications can access screen content.

## Programmatic Permission Apis

To interact with the TCC framework programmatically, developers use two key functions from the CoreGraphics framework. The first is `CGPreflightScreenCaptureAccess()`, which synchronously returns a boolean value indicating whether the application already has permission to record the screen. This function does not trigger any user interface and is intended for a quick, non-intrusive status check. If the preflight check returns false, the application should then call `CGRequestScreenCaptureAccess()`. This function is what triggers the system's consent dialog box for the user. It's important to note that this request will only succeed and display the prompt if called from an application running in an interactive GUI session; calls from background processes or headless environments will typically fail silently without showing a prompt.

## Application Requirements

A critical requirement for successfully requesting and obtaining Screen Recording permission is the context in which the application is running. The request must originate from a signed, graphical user interface (GUI) application that is operating within an active, logged-in user session. This is because TCC is designed to present a UI prompt to a human user for consent. Consequently, non-GUI processes such as command-line tools, daemons (LaunchDaemons), or even some background agents (LaunchAgents) generally cannot obtain this permission, as they lack the necessary interactive context to display the system prompt.

## Sandboxing And Entitlements

The Screen Recording permission is a user privacy setting managed by TCC and is distinct from the App Sandbox. Both sandboxed and non-sandboxed applications are capable of requesting this permission, and both must follow the same user consent flow. Unlike other hardware access like the camera or microphone, there is no special entitlement that an application can declare to bypass the TCC user prompt for ScreenCaptureKit. The application must be properly code-signed (e.g., with a Developer ID for distribution), but this signing does not grant any automatic permissions; it only establishes the application's identity for the TCC framework.


# Ci Cd Integration Strategy

## Hosted Runner Limitations

Standard hosted CI/CD runners, such as the macOS environments provided by GitHub Actions, are not suitable for applications that require user-granted Screen Recording permission. These runners typically execute builds in a headless environment, meaning there is no active GUI session or logged-in user to which the TCC framework can present the necessary consent prompt. As a result, any call to `CGRequestScreenCaptureAccess()` from within this environment will fail, preventing the application from acquiring the permission needed to use ScreenCaptureKit.

## Recommended Ci Setup

To enable screen recording in an automated CI/CD pipeline, the recommended approach is to use self-hosted macOS runners. A physical Mac or a dedicated macOS virtual machine (e.g., an EC2 Mac instance) can be configured with a user account that has auto-login enabled. This creates the necessary interactive GUI session for TCC to function. An administrator can then run the test application once manually to grant the Screen Recording permission. This consent is persisted in the user's TCC database, allowing all subsequent automated test runs for that application to succeed without requiring further interaction. This setup effectively mimics a standard user environment, bypassing the limitations of headless hosted runners.

## Mdm Pre Approval

For organizations that manage their macOS fleet, Mobile Device Management (MDM) offers a robust and scalable solution for pre-approving permissions. An administrator can create and deploy a Privacy Preferences Policy Control (PPPC) configuration profile to managed machines. This profile can explicitly grant the Screen Recording permission (`kTCCServiceScreenCapture`) to a specific application, identified by its bundle ID and code signature. When this profile is installed on a CI runner, the application is pre-approved, and it can begin screen recording without ever needing to trigger a user prompt. This is the officially supported method for enabling such functionality in managed or automated environments, as it avoids manual setup and the unsupported practice of directly editing the TCC.db file.

## Failure Diagnostics

To ensure robustness, an application should implement strategies to detect permission failures early and provide clear, actionable feedback. At startup, the app should immediately call `CGPreflightScreenCaptureAccess()`. If this returns false, it should then determine its execution context. If it detects it is running in a non-interactive session (e.g., by checking for the absence of the WindowServer process), it should log a specific error message explaining that screen recording is not possible in a headless CI environment and recommend using a self-hosted runner or an MDM profile. If the app is in an interactive session, it should provide instructions guiding the user to manually grant the permission in System Settings > Privacy & Security > Screen Recording. This prevents silent failures and helps users and developers quickly diagnose the root cause.


# Performance Impact And Optimization

## Cpu Gpu Utilization

ScreenCaptureKit's performance is highly efficient due to its GPU-backed pipeline that minimizes CPU-side copies. On modern Apple Silicon (M1/M2) hardware, capturing a single Safari window at 720p @ 20 fps typically consumes around 10-15% CPU and 5-10% GPU. For a higher quality 1080p @ 30 fps recording, utilization increases to approximately 15-25% CPU and 10-15% GPU. On older Intel-based Macs, the resource usage is modestly higher, estimated at 20-30% CPU and 10-20% GPU for similar tasks, primarily because they lack the unified memory architecture of Apple Silicon. This performance is significantly better (2-3x lower CPU usage) than legacy APIs like `CGDisplayStream` or `AVCaptureScreenInput`.

## Latency And Buffering

The latency from frame capture to the encoded output is primarily influenced by the frame buffer queue depth configured in the `SCStream`. The default queue depth is three, which introduces a latency of approximately 2-3 frames (e.g., 66-100 milliseconds at 30 fps). While increasing the queue depth to 5-8 frames can enhance frame rate stability, especially under system load, it also increases latency to the 150-200 ms range and consumes more memory. When these frames are passed to `AVAssetWriter` for hardware-accelerated H.264/HEVC encoding, the total end-to-end latency for a stream with the default queue depth is typically 120 ms or less.

## Memory Footprint

The memory footprint of a ScreenCaptureKit recording session is mainly determined by the video resolution and the frame buffer queue depth. For a 1080p recording at 30 fps with a queue depth of three, the memory consumption is approximately 150-200 MB, as each frame is stored in a GPU-backed texture. To prevent memory leaks or excessive usage, it is crucial to manage the lifecycle of `CMSampleBuffer` objects. They should be released promptly after being appended to the `AVAssetWriter`. This is typically handled automatically by ARC (Automatic Reference Counting) when the reference is dropped, but can also be done explicitly by calling `CMSampleBufferInvalidate`.

## File Size Estimates

File sizes are a function of resolution, frame rate, codec, and bitrate. For common presets using the widely compatible H.264 codec, the estimated file sizes are as follows: a 720p recording at 20 fps with a 2-4 Mbps bitrate will generate a file of approximately 30-60 MB per minute. A higher-quality 1080p recording at 30 fps with a 4-8 Mbps bitrate will result in a file of about 70-130 MB per minute. Opting for the more modern HEVC (H.265) codec can reduce these file sizes by roughly 50% for a comparable level of visual quality, though H.264 remains a safer choice for maximum compatibility across different platforms and CI artifact viewers.


# Recommended Recording Presets

## Preset Name

CI-Optimized

## Use Case

This preset is designed for automated testing in continuous integration (CI) environments, such as on GitHub Actions macOS runners. It prioritizes low resource usage (CPU, GPU, memory) and smaller file sizes to ensure that test suite performance is not significantly impacted and that video artifacts are easy to store and transfer. The settings provide sufficient visual quality for debugging test failures without being overly resource-intensive.

## Resolution

720p

## Frame Rate

20.0

## Codec

H.264

## Estimated File Size Per Minute

~30-60 MB per minute


# Implementation Lifecycle Guide

## Session Start

To initialize a capture session, first check for Screen Recording permissions using `CGPreflightScreenCaptureAccess()`. If not granted, request it via `CGRequestScreenCaptureAccess()`, which must be called from a signed GUI app in an active user session. Once permission is confirmed, use `SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)` to get a list of shareable windows. Filter this list to find the target Safari `SCWindow`. Create an `SCContentFilter` using the selected window. Then, set up an `SCStreamConfiguration` with the desired width, height, frame rate (`minimumFrameInterval`), and pixel format. Finally, create the `SCStream`, add an `SCStreamOutput` handler to receive the `CMSampleBuffer` frames, and begin the capture by calling `startCapture()`.

## Session Stop

To gracefully stop a capture session, call the `stopCapture()` method on the active `SCStream` instance. This will stop the flow of new frames and invoke the `stream(_:didStopWithError:)` delegate method. Upon stopping, it's important to finalize the video file. If using `AVAssetWriter`, this involves calling `finishWriting(completionHandler:)`. Inspired by Playwright's robustness, if the stop is unexpected, the implementation should attempt to flush any buffered `CMSampleBuffer`s to the writer and finalize the file. If finalization fails, the partial video file should be saved and marked as incomplete in associated metadata for debugging purposes.

## Event Handling

Robust event handling is critical for maintaining a stable capture. The application should monitor for various window events. `SCWindow` notifications can signal when a window is minimized or closed, at which point the stream should be gracefully stopped or the filter updated. For more complex events like a window moving between spaces, changing fullscreen state, or being resized, the application should monitor notifications from Accessibility (AX), `NSWindow`, and `CGWindowList`. When such an event is detected, the stream's configuration should be updated or the stream should be recreated to adapt to the new geometry or state. If a window is minimized, it may stop providing frames, so the app should detect this and can pause or stop recording until the window is restored.

## Error Recovery

To handle unexpected stream interruptions, the application must implement the `SCStreamDelegate` protocol, specifically the `stream(_:didStopWithError:)` method. This delegate method is called when the stream stops for any reason, including system-level errors. Inside this method, the application should inspect the provided error object to determine the cause of the interruption. Based on the error, a recovery strategy can be implemented, which often involves attempting to recreate the `SCStream` after a short delay. This ensures that the recording can automatically resume if the interruption was transient.


# Code Implementation Examples

## Description

An illustrative Swift pseudo-code example demonstrating the end-to-end process of starting a screen capture session for a specific Safari window using ScreenCaptureKit. It covers checking for and requesting screen recording permissions, asynchronously fetching shareable content, finding the Safari window by its bundle identifier, creating a content filter and stream configuration, and finally initializing and starting the stream.

## Language

Swift

## Code Snippet

```swift
func startSafariCapture() async throws {
    guard CGPreflightScreenCaptureAccess() else {
        let granted = CGRequestScreenCaptureAccess()
        guard granted else { throw CaptureError.permissionDenied }
    }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let safariWindow = content.windows.first(where: { $0.owningApplication?.bundleIdentifier == "com.apple.Safari" }) else {
        throw CaptureError.safariWindowNotFound
    }
    let filter = SCContentFilter(desktopIndependentWindow: safariWindow)
    var config = SCStreamConfiguration()
    config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
    let handler = StreamHandler() // Assumes StreamHandler conforms to SCStreamOutput
    let stream = SCStream(filter: filter, configuration: config, delegate: nil)
    try stream.addStreamOutput(handler, type: .screen, sampleHandlerQueue: DispatchQueue(label: "sampleQueue"))
    try stream.startCapture()
    self.activeStream = stream
}
```


# Known Issues And Mitigations

## Macos Version

macOS 14 and later

## Issue Description

When an application attempts to request Screen Recording permission programmatically using `CGRequestScreenCaptureAccess` on a headless CI/CD runner (e.g., standard GitHub Actions macOS runners), the TCC (Transparency, Consent, and Control) permission prompt does not appear. This is because these environments typically lack an interactive GUI session required for the system to display the dialog to a user. As a result, the permission request fails silently or is automatically denied, preventing ScreenCaptureKit from functioning.

## Mitigation Strategy

The primary mitigation is to pre-grant the Screen Recording permission for the application's bundle identifier. There are several ways to achieve this: 1) Use self-hosted macOS runners configured with an auto-login user session where the permission can be granted once manually. 2) For supervised devices, an MDM (Mobile Device Management) server can push a PPPC (Privacy Preferences Policy Control) configuration profile that pre-approves the application for Screen Recording. 3) A manual but effective workaround involves running the app on a standard Mac with a GUI, granting the permission, and then copying the resulting entry from the user's TCC.db SQLite database (`~/Library/Application Support/com.apple.TCC/TCC.db`) to the CI runner's environment. Direct editing of TCC.db is unsupported and risky, but copying a valid entry is a known workaround.


# Future Proofing And Api Deprecation

Adopting ScreenCaptureKit is the most effective strategy for future-proofing the video recording implementation. Apple has clearly signaled that ScreenCaptureKit is the modern, supported, and forward-looking API for all screen capture needs on macOS. The research into alternative methods confirms that older APIs carry significant risk; for instance, `CGDisplayStream` is officially deprecated, meaning it could be removed in any future macOS release, which would break the implementation and require urgent refactoring. Other legacy methods like `AVCaptureScreenInput` and polling with `CGWindowListCreateImage` are less performant and are not receiving new features. By building on ScreenCaptureKit, Safari Pilot aligns with Apple's technology roadmap, ensuring access to future performance improvements, new features (like the `SCRecordingOutput` introduced in macOS 15), and continued support. Relying on any other capture method, particularly deprecated ones, creates a significant maintenance burden and technical debt.
