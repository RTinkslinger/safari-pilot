# Final Verdict

## Recommendation

Viable with Workarounds

## Summary

Based on extensive evidence from Apple's own documentation, developer forums, and community reports up to 2026, switching to the event-page form (`"background": {"scripts": ["background.js"], "persistent": false}`) is a viable and recommended primary fix for the documented service worker instability on Safari 18.x / macOS 26. Safari explicitly accepts this MV3 manifest configuration, and multiple sources confirm it serves as an effective workaround for the critical bug where service workers are permanently killed under memory pressure and fail to wake reliably. While this approach is not a panacea for all background processing challenges and introduces a significant cross-browser portability issue (as Chrome has deprecated this form), it directly and effectively addresses the core problem of background script death on Safari. The primary 'workaround' is not for Safari itself, but for the development process, which must incorporate build-time manifest generation to maintain compatibility with other browsers like Chrome. The evidence does not show that event pages are equally broken; on the contrary, they are reported to be the solution to the service worker's brokenness.

## Confidence

High


# Event Page Manifest Acceptance

## Acceptance Status

Accepted

## Safari Runtime Behavior

Safari 18.x on macOS 26 explicitly accepts and honors the MV3 manifest declaration `"background": {"scripts": [...], "persistent": false}`. According to Apple's official documentation, 'Optimizing your web extension for Safari,' this nonpersistent background page is a valid option for MV3. The runtime does not issue warnings, silently convert it to a service worker, or reject the manifest. Developer reports from Apple Developer Forums confirm that this format serves as a crucial and effective workaround for a bug where MV3 service workers are permanently killed under high memory pressure and fail to restart. Using the event-page form has been shown to restore reliable background script execution in these scenarios.

## Tooling Behavior

Development tools like `xcrun safari-web-extension-converter` and Xcode 16/17 templates accommodate the event-page manifest, although they may default to or prefer the `service_worker` declaration for MV3 extensions. While some versions of the converter might attempt to normalize manifests towards the `service_worker` format, the event-page form remains valid and is not subject to a hard build-time rejection. The primary 'gotcha' reported by developers is not build failure, but potential limitations in debugging and inspection capabilities within Safari's Web Inspector for non-service-worker background scripts.

## Confidence

High


# Wake Event Reliability

## Event Name

browser.alarms.onAlarm

## Is Reliable

False

## Reported Latency

Unreliable / Not specified

## Notes And Constraints

The reliability of `browser.alarms.onAlarm` is questionable. While Apple's documentation does not confirm a strict 1-minute minimum as seen in Chrome, community reports consistently indicate that alarms with intervals of less than one minute are unreliable on macOS. This is attributed to system-level power management features, including timer throttling and coalescing, which can delay or batch alarm events. Furthermore, some developers report that alarms may fail to wake a background script that has been terminated by the system. For critical tasks requiring guaranteed execution, it is recommended to use alarms in combination with more robust mechanisms like native messaging.


# Safari 18 Regressions And Quirks

## Issue Id

Community Consensus (Apple Developer Forums, etc.)

## Title

MV3 Service Worker Fails to Wake After Aggressive Termination

## Summary

Widespread community reports from 2024-2026 indicate that Safari 18.x on macOS 26 aggressively terminates MV3 service workers after approximately 30-45 seconds of inactivity. The critical issue is that the service worker often fails to wake upon subsequent trigger events such as `browser.alarms.onAlarm`, `browser.runtime.onMessage`, or `browser.webNavigation` events. This behavior is exacerbated under high system memory load, leading to a 'permanently killed' state that requires manual user intervention (e.g., re-enabling the extension) to resolve. This fundamental unreliability is the primary driver for seeking alternative background script implementations.

## Status

Workaround Available

## Source Url

https://developer.apple.com/forums/tags/safari-extensions

## Issue Id

127681420

## Title

Safari Web Extension background pages would stop responding after about 30 seconds

## Summary

This bug, officially acknowledged and fixed by Apple in Safari release notes, confirms the core issue reported by the community. It addresses background pages becoming unresponsive after about 30 seconds. The existence of this bug ID validates the widespread developer complaints about the short lifecycle and unreliability of background scripts in recent Safari versions, providing an authoritative anchor for the observed problems.

## Status

Resolved

## Source Url

https://developer.apple.com/forums/tags/safari-extensions

## Issue Id

WebKit Bugzilla 306050 & 303614

## Title

General WebKit Instability During Safari 26.x Cycle

## Summary

Apple Security Advisories for Safari 26.2 (Jan 9, 2026) and Safari 26.4 (Mar 24, 2026) reference WebKit bug fixes (303614 and 306050 respectively). While not directly tied to MV3 event pages, their presence during the relevant timeframe points to broader instability and ongoing regression triage within the WebKit engine on macOS 26. This context suggests that the platform was undergoing significant changes, which could contribute to unexpected behaviors in complex subsystems like Web Extensions.

## Status

Resolved

## Source Url

https://developer.apple.com/forums/tags/safari-extensions


# Multi Profile Behavior

## Instance Scoping

Per-profile

## Alarm Scoping

Per-profile

## Messaging Isolation

Strictly isolated per profile

## Storage Partitioning

Partitioned per profile


# Production Extension Analysis

## Extension Name

Bitwarden

## Background Architecture

MV3 Service Worker

## Manifest Background Stanza

Not available in provided context, but public commentary confirms a shift to a service worker model.

## Public Commentary Summary

In a blog post about their transition to Manifest V3, Bitwarden describes moving away from persistent background pages to a model that does not rely on global memory access. This strongly implies the adoption of the standard MV3 service worker architecture, aligning with Chrome's requirements and suggesting they are adapting to its lifecycle rather than using a Safari-specific workaround.

## Source Url

https://bitwarden.com/blog/bitwarden-manifest-v3/

## Extension Name

uBlock Origin Lite (uBOL)

## Background Architecture

MV3 Service Worker (Declarative-first)

## Manifest Background Stanza

Not available in provided context.

## Public Commentary Summary

uBlock Origin Lite is specifically designed as an MV3-native content blocker that operates almost entirely declaratively through the `declarativeNetRequest` API. This architectural choice is a strategic solution to the unreliable background script lifecycle in MV3, as it does not require a permanent or frequently woken background process for its core functionality, thus circumventing the service worker instability issues in Safari.

## Source Url

https://github.com/uBlockOrigin/uBOL-home

## Extension Name

AdGuard for Safari

## Background Architecture

MV3 Service Worker

## Manifest Background Stanza

Not available in provided context.

## Public Commentary Summary

AdGuard announced the release of a beta version of its browser extension built on Manifest V3, positioning itself as a first-mover among ad blockers. Its successful operation as an MV3 ad blocker indicates that it has adapted to the service worker model. This suggests they have developed strategies to work within the constraints of Safari's service worker implementation, likely through a combination of declarative rules and efficient, event-driven code.

## Source Url

https://adguard.com/en/blog/adguard-mv3-beta.html


# Xcode Packaging Gotchas

## Build Validation Notes

When using the event-page form (`"background": {"scripts": [...], "persistent": false}`) in an MV3 manifest, Xcode 16/17 is not expected to generate build-time errors or validation warnings. Apple's official documentation supports both non-persistent background pages and service workers for MV3. While Xcode's default templates may favor the `service_worker` key, the `scripts` form is valid and should be accepted by the build and embedding process. However, developers have reported that this conversion can lead to tooling limitations. The primary 'gotcha' is not a build failure but a potential degradation in debugging and inspection capabilities. Safari's Developer Tools and Xcode's debugging paths have historically had better support for the `service_worker` model, and developers may find it more difficult to inspect the background context or diagnose runtime issues with the event-page form.

## Entitlement Implications

Converting a Safari Web Extension's background model from `service_worker` to the `scripts` + `persistent:false` event-page form does not require any changes to the entitlements of the containing app or the app extension (`.appex`). Research confirms there is no distinct entitlement specifically required for using an event-page background versus a service worker. The standard entitlements for a sandboxed application (`com.apple.security.app-sandbox`) and any necessary network, keychain, or other permissions declared in the containing app's entitlements file remain the same. The permissions model is governed by the App Sandbox and the permissions declared within the `manifest.json`, not the choice of background script implementation.

## Signing And Notarization Notes

For Developer ID distribution outside the Mac App Store, there are no specific constraints or issues related to code-signing and notarization that arise from using the event-page form instead of a service worker. The standard process applies: the containing application and its embedded app extension (`.appex`) must be correctly code-signed with a Developer ID Application certificate. Subsequently, the entire application bundle must be submitted to Apple's notarization service. The notarization service primarily checks for malware, valid code signatures, and the use of disallowed entitlements; it does not differentiate based on the extension's background script type. As long as the bundle is correctly structured and signed, the choice between `service_worker` and `scripts` + `persistent:false` has no bearing on the notarization outcome.

## Sandbox Constraints

Switching to an event-page background model does not introduce new App Sandbox permission constraints or require additional entitlements. The extension continues to operate within the same sandbox environment as it would with a service worker. The primary implication is a change in the runtime model: the background script is designed to be non-persistent and will unload when idle. This affects how long-running tasks must be designed but does not alter the fundamental security boundaries or permissions granted to the extension. Any access to user data, network resources, or local files is still governed by the permissions requested in the `manifest.json` and the entitlements of the containing application.


# Background Model Comparison

## Lifecycle Policy Comparison

In Safari 18.x, both MV3 service workers and event pages (`persistent:false`) are designed to be non-persistent to conserve memory and power. However, their practical lifecycle policies differ dramatically due to a critical flaw in Safari's service worker implementation. While both are intended to unload when idle and wake for events, service workers are subject to being permanently killed when system memory usage becomes high (e.g., around 80% RAM). Once killed in this manner, they do not automatically restart, even when memory is freed, effectively disabling the extension's background logic. In contrast, the event-page model has been reported by the developer community to be more resilient. It appears to follow a more traditional event-driven lifecycle, reliably unloading when idle and, crucially, waking up to handle new events even under the same memory pressure conditions that cause service workers to fail permanently.

## Unload Behavior Comparison

The idle/unload threshold for both models is aggressive, with community reports indicating that background contexts are terminated after approximately 30-45 seconds of inactivity. The key difference is in the behavior *after* unloading. A service worker, particularly on a system with high memory load, may be completely terminated by the OS and fail to recover. This is not a graceful unload but a hard kill from which it does not return. The event-page model, while also being non-persistent, does not appear to suffer from this permanent termination bug. It unloads when idle but remains correctly registered with the system to be re-activated by its event listeners, providing a much more reliable unload/reload cycle.

## Wake Trigger Comparison

The effectiveness of wake triggers is the most significant point of divergence. For MV3 service workers in Safari 18.x, wake triggers such as `browser.alarms.onAlarm`, `browser.runtime.onMessage`, and `browser.webNavigation` events are highly unreliable. Community benchmarks and widespread developer reports indicate that after a service worker is killed, these events frequently fail to wake it, or do so with extreme latency and inconsistency. Conversely, switching to the event-page form (`scripts` + `persistent:false`) is reported to restore the reliability of these wake triggers. Developers have confirmed that this workaround allows events to consistently activate the background script, making it a viable solution for the service worker's wake failures. While precise latency metrics are sparse, the qualitative difference is stark: event pages wake reliably, whereas service workers do not.

## Apple Recommendation Summary

Apple's official documentation, including "Optimizing your web extension for Safari," presents both non-persistent background pages and service workers as valid options for MV3 extensions on macOS. The documentation provides explicit examples for the `"scripts": [...], "persistent": false` configuration. Apple even recommends this non-persistent model for event-driven extensions to optimize performance. While one document suggests using a service worker for "better compatibility with other browsers," this recommendation is undermined by the severe reliability issues of Safari's own service worker implementation. The existence of the event-page form as a documented, officially supported alternative, combined with community reports of it being a successful workaround (as discussed in Apple Developer Forums thread 721222), makes it the de facto recommended solution for reliable background processing in Safari 18.x.


# Wake Latency And Reliability Data

## Reliability Summary

The overall wake reliability for MV3 extensions in Safari 18.x is highly dependent on the manifest's background declaration. The `service_worker` form is plagued by a significant reliability issue where the background script is aggressively terminated after approximately 30-45 seconds of idle or under high system memory pressure (around 80% RAM), and critically, fails to restart upon subsequent wake events. This is described as a 'permanent kill' bug. In contrast, the event-page form (`"background": {"scripts": [...], "persistent": false}`) is a widely reported and effective workaround. Community evidence indicates that this form restores reliable wake behavior, as its listeners continue to function even under the high memory conditions that cause service workers to fail permanently.

## Cold Start Latency Range

Several seconds to tens of seconds

## Warm Start Latency Range

Sub-second to a few seconds

## Influencing Factors

The primary factor influencing reliability is the background script's lifecycle policy, with service workers being highly unreliable. System load and macOS power management policies are major contributors to termination and wake failures. These include high memory usage (which can permanently kill service workers), high CPU/IO load, and macOS features like energy-saver mode, low-power mode, and background app nap, all of which exacerbate background termination and reduce the reliability of wake events.


# Cross Browser Portability Analysis

## Chrome Compatibility Summary

Adopting the event-page form (`"scripts": [...], "persistent": false`) for an MV3 extension poses a significant compatibility risk for Chrome and Chromium-based browsers. The official Manifest V3 specification for Chrome mandates the use of a service worker (`"background": {"service_worker": ...}`). Using the `scripts` key, which is the syntax for MV2-style background pages, is deprecated. Consequently, submitting an extension with this configuration to the Chrome Web Store carries a high risk of being rejected during the review process. While some newer versions of Chrome might ignore the unsupported key rather than failing to load the extension locally, relying on this behavior for a production release is not advisable.

## Firefox Compatibility Summary

Firefox has taken a different implementation path for Manifest V3 and maintains strong compatibility with the event-page form. In fact, Firefox's MV3 support has historically been built around non-persistent background scripts using the `"background": {"scripts": [...], "persistent": false}` syntax, rather than service workers. Therefore, using this form as a workaround for Safari presents a low runtime compatibility risk for Firefox. Developers targeting both Safari and Firefox can likely use the same manifest configuration for the background context without issue, though toolchains like `web-ext` should be used for packaging.

## Overall Risk Assessment

The overall portability risk of adopting the Safari-specific event-page workaround is high if a single, universal manifest file is desired. The strategy creates a direct conflict with Chrome's strict MV3 requirements, jeopardizing publication on the Chrome Web Store. While it aligns well with Firefox's implementation, the incompatibility with the largest browser ecosystem makes it a non-viable universal solution. This divergence forces developers to manage browser-specific configurations, increasing build complexity. The risk is not in runtime errors across all platforms, but in the failure to meet the specific manifest requirements of the Chrome platform.

## Recommended Mitigation Strategy

The most robust and widely recommended strategy to maintain multi-browser support is to abandon a one-size-fits-all manifest and instead generate browser-specific manifests at build time. This involves creating separate manifest templates (e.g., `manifest.chrome.json`, `manifest.safari.json`, `manifest.firefox.json`) and using a build script or bundler plugin (like `vite-plugin-web-extension`) to select the appropriate one for each target. For Chrome, the manifest would use `service_worker`. For Safari and Firefox, it would use `scripts` + `persistent:false`. This approach explicitly resolves the compatibility conflict, ensures compliance with each browser's store policies, and is a common practice for managing inconsistencies in the web extension ecosystem.


# Developer Recommendation Playbook

## Primary Recommendation

For event-driven background logic on Safari 18.x, the primary recommended strategy is to use a non-persistent event page by declaring `"background": {"scripts": ["background.js"], "persistent": false}` in the MV3 manifest. This has been shown to be a reliable workaround for the widely reported issue where Safari's `service_worker`s are aggressively terminated under memory pressure and fail to restart, severing the connection to the extension.

## Decision Criteria

The choice of background strategy should be based on the task's persistence requirements:
1.  **For Event-Driven Tasks:** If the background logic needs to react to browser events (e.g., `tabs.onUpdated`, `runtime.onMessage`, `webNavigation`) and can tolerate being idle, the non-persistent event page (`scripts` + `persistent:false`) is the most reliable choice on Safari.
2.  **For Guaranteed Scheduled Tasks:** If a task must execute at a specific time with high fidelity, do not rely solely on `browser.alarms` within the web extension. Combine `browser.alarms` with a native messaging trigger from a helper app as a fallback to ensure execution.
3.  **For Truly Persistent/Long-Running Tasks:** If the extension requires a process that is always running (e.g., for continuous monitoring or managing a persistent connection), a web extension background script is not a viable solution on Safari. The only reliable approach is to implement this logic in a native helper application packaged with the extension.

## Fallback Strategies

To build a resilient extension, implement fallback mechanisms for critical operations:
1.  **Native Messaging with a Helper App Extension:** Package the web extension within a containing native app that includes an app extension. Use `browser.runtime.sendNativeMessage` to offload critical tasks or trigger wake-ups from the more stable native environment. This requires adding the `nativeMessaging` permission to the manifest. The native app can handle tasks that require guaranteed execution or state recovery.
2.  **State Persistence and Recovery:** Assume the background script can be terminated at any time. Persist critical state frequently using `browser.storage.local`. Upon script startup (`runtime.onStartup`), include logic to check for and recover from an incomplete state left by a previous, terminated session.

## Monitoring Metrics

To proactively detect and diagnose background reliability issues in production, implement telemetry to track the following key metrics:
- **Missed Alarms Rate:** Log the delta between an alarm's scheduled time and its actual execution time. A high rate of missed alarms or large deltas indicates wake failures.
- **Cold-Start Latency:** Measure the wall-clock time from an event trigger (e.g., a `runtime.sendMessage` from a content script) to the start of the corresponding event handler's execution in the background script. Consistently high or spiking latency points to termination issues.
- **Wake Failure Rate:** Implement a heartbeat mechanism where a content script or popup periodically sends a message to the background script and expects a response. A high rate of timeouts is a direct measure of the 'dead background script' problem.
- **Background Script Restarts:** Log every `runtime.onStartup` event. An unusually high frequency of startup events for a given user session indicates the background script is being terminated and restarted often.

