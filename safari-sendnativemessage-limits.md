# Executive Summary

For Safari Web Extensions using Manifest V3 (MV3), there is no officially documented numeric limit or per-wake budget for `browser.runtime.sendNativeMessage` calls. Instead, the practical limitation is imposed by the ephemeral lifecycle of the non-persistent background page (or service worker). Safari aggressively unloads these background contexts after approximately 30 seconds of inactivity or under system memory pressure (e.g., when RAM usage approaches 80%).

The primary cause of `SFErrorDomain error 3` is the termination of this background page while a native messaging request is in progress. When the background context is killed, the connection to the native host is severed, causing the pending operation to fail with this generic error. Other triggers include the native host process failing to launch or exiting prematurely. While Safari 17.6 release notes mentioned a fix for background pages stopping after 30 seconds, developer reports indicate the issue persists, particularly in complex extensions, on iOS, or under memory pressure. Therefore, developers should architect their extensions to be resilient to frequent and unpredictable background terminations.

# Send Native Message Limit Analysis

Apple's official documentation for Safari 18 does not define a specific numeric limit, such as a maximum number of calls per second or a total count per wake cycle, for `browser.runtime.sendNativeMessage`. The limitation is a practical one dictated by the lifecycle of the non-persistent background context (either an MV2-style event page or an MV3 service worker).

Key constraints are:
1.  **Background Page Lifetime**: Safari aggressively terminates non-persistent background pages to conserve memory and battery. Empirical evidence from developer forums and bug reports shows this termination typically occurs after about 30 seconds of inactivity (i.e., no extension API calls or events). While Safari 17.6 release notes mentioned a fix for this behavior, real-world reports indicate that complex extensions can still be terminated within this timeframe, especially on iOS or when the device is idle or locked.
2.  **Memory Pressure**: Independent of the idle timer, Safari may terminate the background page at any time if the system is under memory pressure. Developer reports note this can happen when device RAM usage approaches 80%.
3.  **Implicit Per-Wake Budget**: While not a formal quota, there is an effective "per-wake budget" determined by the amount of work that can be completed before the background page is terminated. A rapid burst of `sendNativeMessage` calls can lead to failures because each call involves overhead (launching the native host process, IPC), and the cumulative time can exceed the ~30-second active window.
4.  **Concurrency Behavior**: There is no documented concurrency cap. However, launching many parallel `sendNativeMessage` calls often results in failures. This is not due to a hard limit on parallel operations but because the high resource cost of spawning multiple native host processes simultaneously can accelerate the background page's termination. Community reports suggest that small bursts of 2-5 parallel calls may succeed, but larger bursts frequently fail.
5.  **Message Size Limit**: There is a hard-coded limit of 64 MB for a single message payload sent via `runtime.sendMessage` or `sendNativeMessage` on both macOS and iOS. Messages exceeding this size will fail.

In summary, the number of successful `sendNativeMessage` calls is not a fixed number but is variable, depending on the time taken to process each message, the frequency of calls, and external factors like system memory load.

# Sferrordomain Error 3 Explanation

## Error Code

SFErrorDomain error 3

## Official Description

The official description provided in SafariServices documentation is the generic message: “This operation cannot be completed.” There is no public mapping of this error code to a more specific named constant.

## Primary Causes

In the context of native messaging, this error is most frequently triggered when the communication channel between the extension's background script and the native host application is unexpectedly closed. The primary causes include:

*   **Background Page Termination**: The most common cause is the termination of the non-persistent background page or service worker by Safari. This happens due to either the ~30-second inactivity timeout being reached or the system coming under memory pressure. If a `sendNativeMessage` call is in flight when the background context is killed, the operation aborts and returns `SFErrorDomain error 3`.
*   **Native Host Failure**: The error can also occur if the native host process itself fails. This could be because it fails to launch, crashes, or exits prematurely before sending a response. This severs the communication pipe from the other end.
*   **Exceeding Per-Wake Budget**: A rapid succession of `sendNativeMessage` calls can exhaust the implicit time and resource budget of a single wake cycle, leading Safari to terminate the background page and cause subsequent or in-flight calls to fail with this error.
*   **Port Disconnection**: For extensions using `browser.runtime.connectNative`, this error signifies that the persistent connection port has been disconnected, which happens whenever the background page is terminated.

## Detection Strategy

Developers can programmatically detect and handle this error through the following strategies:

1.  **Inspect Callback Errors**: In the callback function for `browser.runtime.sendNativeMessage`, check for `browser.runtime.lastError`. The error object will contain the domain (`SFErrorDomain`) and code (`3`).
2.  **Listen for Port Disconnection**: When using `browser.runtime.connectNative`, add a listener to the port's `onDisconnect` event. The `port.error` object available in the listener will contain the error details.
3.  **Implement Retry Logic**: Treat `SFErrorDomain error 3` as a transient failure. Upon detection, use the `browser.alarms` API to schedule a retry attempt after a short delay (e.g., using an exponential backoff strategy). This is more reliable than `setTimeout`, as alarms persist even if the background page is terminated.
4.  **Re-establish Connection**: On the next wake event (e.g., triggered by an alarm or user action), the extension should attempt to re-establish the native messaging connection if one is needed.


# Background Page Lifecycle Details

## Context Type

In Safari 18, both Manifest V3 service workers and Manifest V2 non-persistent event pages (`persistent:false`) are treated as ephemeral background contexts. They are designed to be short-lived and are not persistently active, being created on-demand and unloaded to conserve system resources.

## Wake Triggers

The background page is activated or 'woken' from a suspended state by a variety of events. These triggers include: incoming extension messages (e.g., `runtime.onMessage`, `sendMessage`), attempts to establish a native messaging connection (`browser.runtime.connectNative`) or send a one-time message (`browser.runtime.sendNativeMessage`), scheduled events from the Alarms API, callbacks from the `webRequest` API, user interactions with the extension's UI (like toolbar clicks), and messages dispatched from the containing native application via Safari’s `dispatchMessage` API.

## Idle Timeout Duration

Empirical evidence from multiple developer reports and an acknowledgment in Safari 17.6 release notes indicate that Safari unloads the background page after approximately 30 seconds of inactivity. This timer is reset each time an event is received or a relevant extension API is called. It is not a guaranteed duration and can be shorter under certain conditions.

## Termination Conditions

Beyond the idle timeout, Safari may terminate the background page at any time due to system resource constraints. The primary conditions cited in developer reports are high system memory pressure (e.g., when device RAM usage approaches 80%) and battery pressure. The background page may also be terminated more aggressively when the device is idle or locked, or when the Safari browser itself is backgrounded.


# Per Wake Budget Analysis

While Apple's official documentation does not define a formal, numeric 'per-wake budget' for `sendNativeMessage` calls, the practical behavior of Safari's non-persistent backgrounds creates a de facto budget. This budget is not a fixed number of calls but rather a limit on the total amount of work that can be performed within a single activation cycle before the background page is terminated. Each wake cycle starts an approximate 30-second countdown to termination due to inactivity, and the page can be killed even sooner due to memory or battery pressure. Since each `sendNativeMessage` call involves the overhead of launching a native host process, a rapid series of calls consumes significant time and resources within this limited window. If the cumulative work exceeds what can be completed before termination, the background page is unloaded, and any subsequent or in-flight native messaging calls will fail, often resulting in `SFErrorDomain error 3`. Therefore, developers must architect their extensions to operate within this implicit time and resource budget for each activation.

# Concurrency And Rate Limit Findings

There are no officially documented concurrency or rate limits for `browser.runtime.sendNativeMessage` calls. However, empirical findings from developer reports provide practical guidance:

*   **Parallel Calls:** Small bursts of parallel `sendNativeMessage` calls (typically 2-5 simultaneous calls) are reported to often succeed. However, larger bursts (e.g., tens of simultaneous calls) frequently lead to failures. This is attributed not to a specific concurrency quota, but to the high resource cost of launching many native host processes at once, which can quickly exhaust the background page's implicit time and resource budget.

*   **Sequential Calls:** The number of calls that can be made in rapid sequence is primarily limited by the background page's ~30-second active window. Developer tests show a direct relationship between call frequency and failure. For example, one report noted that making a call every 2 seconds resulted in failure after 15 calls (totaling 30 seconds), and a call every 3 seconds failed after 10 calls (also 30 seconds). This demonstrates that the limit is time-based, not a fixed count of calls.

*   **Workarounds and Throttling:** Based on these observations, developers have found that throttling messages is a successful mitigation strategy. Spacing `sendNativeMessage` calls out to approximately one every 4 seconds has been reported to avoid triggering the termination and associated failures.

# Official Documentation Summary

Apple and WebKit's official documentation for Safari 18 on macOS mandates that Manifest V3 Web Extensions must use a non-persistent background context, which can be either an event page (`"persistent": false`) or a service worker. The documentation, particularly the "Optimizing Your Web Extension for Safari" guide, explains that Safari unloads these background pages when the user is not actively interacting with the extension. This behavior is a deliberate design choice to conserve memory and battery life. 

Regarding native messaging, the documentation specifies that `browser.runtime.sendNativeMessage` and `browser.runtime.connectNative` calls are routed to a native app extension bundled within the main macOS application, not a standalone executable defined by `application.id` as in Chrome. Communication occurs via App Extension APIs (`NSExtensionContext`) rather than stdin/stdout pipes.

Notably, there is a complete absence of official documentation defining explicit numeric limits for native messaging. Apple does not publish any per-wake budget, call-rate caps, concurrency limits, or a guaranteed idle timeout for event pages or service workers. The only official numeric reference to a specific timeframe is in the Safari 17.6 release notes, which mention a fix for an issue where background pages would stop responding after about 30 seconds (Bug ID 127681420). This, however, describes a bug fix and is not presented as a formal, guaranteed lifecycle timeout.

Concerning error codes, while `SFErrorDomain` is documented as the error domain for Safari extension-related failures, there is no official public mapping or description for what `error 3` specifically signifies. Its meaning is inferred from empirical evidence rather than official sources.

# Empirical Evidence From Developers

## Source Type

Stack Overflow

## Source Link

https://stackoverflow.com/questions/tagged/safari-web-extension

## Summary Of Report

A developer reported in June 2024 that their Safari Web Extension's background script becomes unresponsive after approximately 30 seconds on iOS 17.6 and iOS 18 betas. The failure was consistently reproducible when sending messages at a fixed interval.

## Observed Behavior Or Limit

The developer provided a minimal reproducible example with specific measurements: sending a message every 1 second caused unresponsiveness after 30 seconds. An interval of 2 seconds led to failure after 15 calls (30 seconds total), and an interval of 3 seconds failed after 10 calls (30 seconds total), strongly indicating a time-based termination window of around 30 seconds.

## Source Type

GitHub

## Source Link

https://github.com/AdguardTeam/AdguardForSafari/issues

## Summary Of Report

In multiple issue threads, including one from March 2025, developers for the AdGuard extension reported receiving `SFErrorDomain error 3` when native messaging calls fail. These failures were linked to the background service worker being terminated.

## Observed Behavior Or Limit

The error consistently appeared under conditions of heavy or frequent messaging, or after a period of inactivity, leading to the conclusion that `SFErrorDomain error 3` is a direct symptom of attempting a native message call after the background context has been killed by Safari's resource management.

## Source Type

Apple Developer Forum

## Source Link

https://discussions.apple.com/community/developer/safari

## Summary Of Report

Multiple threads discuss the termination of non-persistent background pages and service workers. Developers confirm a typical lifetime of 30-45 seconds before termination. One thread (ID 721222) specifically notes that workers killed due to memory pressure (e.g., device RAM usage near 80%) do not automatically restart. Apple staff have participated in these threads, acknowledging the behavior.

## Observed Behavior Or Limit

The primary observed behavior is the background script being killed, which severs any open native messaging ports and causes subsequent `sendNativeMessage` calls to fail. Apple staff suggested workarounds such as throttling message frequency (e.g., spacing calls to ~4 seconds), using the `browser.alarms` API for periodic tasks, and designing the extension to re-establish connections on each new wake event.

## Source Type

GitHub

## Source Link

https://github.com/dessant/search-by-image/issues

## Summary Of Report

An issue titled “Extension no longer works in Safari 18” was opened on September 17, 2024, indicating that changes in Safari 18's background lifecycle management broke the functionality of an existing extension.

## Observed Behavior Or Limit

The failure of the extension implies that its architecture was not resilient to Safari 18's aggressive background termination policy. This serves as real-world evidence that extensions relying on a more persistent background state are prone to failure in recent Safari versions.


# Safari Version Specific Changes

## Safari Version

Safari 17.6

## Change Summary

A bug was fixed where non-persistent background pages in Web Extensions would become unresponsive or terminate after approximately 30 seconds of activity. This fix was intended to make the background lifecycle more predictable and align it closer to the documented behavior of unloading only when idle.

## Relevant Bug Id

127681420

## Impact On Developers

This fix was intended to improve the reliability of extensions that perform work in the background. However, multiple developer reports from forums and issue trackers indicate that the problem may persist intermittently, especially on iOS or under conditions of high memory pressure or when the device is idle/locked. Developers should upgrade to 17.6 or later to benefit from the fix but must still architect their extensions to be resilient to unexpected background termination.

## Safari Version

Safari 18

## Change Summary

Safari 18 introduced further lifecycle refinements and significantly improved the debugging experience by making service workers visible again in the Develop menu. This allows developers to inspect and debug their background scripts more effectively.

## Relevant Bug Id

Not specified

## Impact On Developers

The improved debugging visibility is a major quality-of-life improvement for developers building MV3 extensions. While Safari 18 continues to refine the background lifecycle, it does not change the fundamental non-persistent, event-driven model. Developers must continue to treat the background context as ephemeral and cannot rely on it staying alive for extended periods. The core architectural patterns for resilience remain necessary.

## Safari Version

Safari 17.x (prior to 17.6)

## Change Summary

In versions before 17.6, non-persistent background pages were subject to a widely reported bug causing them to be aggressively terminated after about 30-45 seconds, even during active work. This made reliable native messaging and other background tasks extremely difficult.

## Relevant Bug Id

127681420 (Fixed in 17.6)

## Impact On Developers

Developers targeting these older versions faced frequent `SFErrorDomain error 3` failures with native messaging and unpredictable behavior. The primary workaround was to minimize background activity, throttle messages heavily, and implement robust retry logic, but reliability remained a major issue. Upgrading to Safari 17.6 or newer is the recommended solution.


# Engineering Mitigation Patterns

## Pattern Name

Use Alarms API for Periodic Tasks

## Description

Replace traditional JavaScript timers like `setTimeout` and `setInterval` with the `browser.alarms` API for any periodic or delayed background work. Alarms are persistent across background script terminations. When an alarm fires, Safari will wake the background script if it's suspended, providing a reliable mechanism for scheduling future work without trying to keep the script alive indefinitely.

## Related Apis

browser.alarms

## Trade Offs

This pattern significantly improves the reliability of periodic tasks. The trade-off is a potential loss of precision compared to `setTimeout`, as the OS may slightly delay alarms to batch them for power efficiency. Chrome's documentation suggests a minimum period of 30 seconds or 1 minute for alarms, which is a good guideline to follow for cross-browser compatibility and energy efficiency.

## Pattern Name

Batch Native Messages

## Description

To avoid exceeding Safari's implicit per-wake work budget and reduce the overhead of launching multiple native host processes, collect multiple messages in a queue (either in-memory for a single session or using `browser.storage` for persistence) and send them as a single, consolidated payload in one `sendNativeMessage` call. This is especially effective for high-frequency, low-priority messages.

## Related Apis

browser.runtime.sendNativeMessage, browser.storage

## Trade Offs

Batching improves efficiency and reliability but adds complexity to the extension's logic for managing the queue. Developers must also be mindful of the maximum message size, which has been reported to be around 64 MB. It introduces latency, as messages are not sent immediately.

## Pattern Name

Use `connectNative` for Persistent Ports

## Description

For continuous or frequent two-way communication, prefer establishing a long-lived communication channel using `browser.runtime.connectNative` instead of making many individual `sendNativeMessage` calls. An open port can help keep the background script alive and avoids the performance cost of repeatedly launching the native host. It is critical to listen for the port's `onDisconnect` event to handle background termination and implement logic to re-establish the connection on the next wake event.

## Related Apis

browser.runtime.connectNative

## Trade Offs

This pattern is more efficient for chatty communication but requires more complex state management to handle the connection lifecycle, including disconnections and reconnections. A failure to properly handle disconnection can leave the extension in a broken state.

## Pattern Name

Implement Idempotent Host and Retry Logic

## Description

Design the native host application to be idempotent, meaning it can safely process the same message multiple times without causing errors or incorrect side effects. In the extension, wrap `sendNativeMessage` calls in logic that detects failures (like `SFErrorDomain error 3` or checking `browser.runtime.lastError`) and schedules a retry using the Alarms API, often with an exponential backoff strategy to avoid overwhelming the system.

## Related Apis

browser.alarms, browser.runtime.lastError

## Trade Offs

This creates a highly resilient system but significantly increases complexity on both the extension and native host sides. The native host must be carefully designed to handle duplicated requests, which may involve tracking message IDs or using transactional operations.

## Pattern Name

Persist State with the Storage API

## Description

Since the non-persistent background script's global variables and in-memory state are destroyed upon termination, all essential data must be saved to persistent storage. Use the `browser.storage` API to save application state, message queues, or user settings. When the background script is reawakened, its first action should be to rehydrate its state from storage.

## Related Apis

browser.storage

## Trade Offs

Using storage is fundamental for correctness in an event-driven model. The trade-off is that disk I/O is slower than accessing in-memory variables, which can have a minor performance impact. It requires disciplined coding to ensure state is consistently saved and loaded.


# Macos Native Host Constraints

## Communication Mechanism

On macOS, Safari WebExtensions do not use the traditional stdin/stdout pipe mechanism for native messaging. Instead, communication is handled through the native App Extension API. When an extension calls `browser.runtime.sendNativeMessage`, Safari routes the message to the `NSExtension` bundled within the containing macOS application. The native code receives the message within the `beginRequestWithExtensionContext:` method, where the message payload is available as an `NSExtensionItem`. This is an XPC-like Inter-Process Communication (IPC) model, not a persistent pipe.

## Host Lifetime

The native host process in a Safari WebExtension is designed to be short-lived. It is an app-extension that is launched by the system on-demand to handle a single incoming message request from the extension. After the native code processes the message and returns a response, the system is free to suspend or terminate the host process to conserve resources. There is no guarantee of a persistent daemon; the host's lifecycle is tied to individual transactions, not the extension's entire session.

## Key Requirements

For a native messaging host to function with a Safari WebExtension, several key requirements must be met. The extension's `manifest.json` must declare the `nativeMessaging` permission. The host itself must be implemented as a native App Extension target within a containing macOS application bundle. Both the containing app and its extension must be properly signed with a developer certificate for distribution, either through the App Store or as a developer-signed binary. The native extension must also have the correct entitlements configured, such as its `NSExtension` point, and may require App Groups for sharing data or files with its containing app.

## Impact Of Background Termination

The termination of the extension's non-persistent background page (or service worker) has a direct and critical impact on native messaging. Because communication relies on a per-request IPC transaction established by the background context, if that context is killed by Safari (due to the ~30-second idle timeout or memory pressure) while a native message is in-flight, the entire transaction is aborted. This cancellation is the primary cause of the `SFErrorDomain error 3` ('This operation cannot be completed.'), as the IPC endpoint on the extension side is destroyed, severing the connection to the native host process.


# Cross Browser Comparison

## Feature Area

Background Worker Lifetime and Native Messaging Quotas

## Safari Implementation

Safari enforces a strict, non-persistent background model for MV3 extensions, aggressively terminating the background script or service worker after approximately 30 seconds of inactivity or under system memory/energy pressure. It does not publish an official numeric quota for `sendNativeMessage` calls, but this short lifetime creates a de-facto 'per-wake budget'. Exceeding this time-based budget results in the background's termination, causing native messaging attempts to fail with `SFErrorDomain error 3`. While `runtime.connectNative` can be used, the port is still severed when the background is killed, requiring robust reconnection logic.

## Chrome Implementation

Chrome also uses an event-driven MV3 service worker that is terminated after a period of inactivity (typically documented as around 30 seconds, though it can be longer in practice). Chrome provides clearer keep-alive affordances; for instance, an active native messaging port established with `runtime.connectNative` is documented to keep the service worker alive. Like Safari, Chrome does not publish a hard numeric quota on native message calls, with practical limits being a function of the service worker's lifetime and host process performance.

## Firefox Implementation

Firefox's implementation of MV3 has historically diverged from Chrome and Safari. It has been slower to adopt the service worker model for backgrounds, with its event pages having different lifecycle semantics. Consequently, the background lifetime guarantees and native messaging behaviors are not identical to the other browsers. Developers cannot assume that keep-alive mechanisms or performance characteristics will match Chrome or Safari, often requiring browser-specific code paths for reliable cross-browser functionality. Quotas and rate limits are implementation-dependent and less clearly defined.


# Platform Rationale

## Policy Goal

Apple's primary policy goals for its platform architecture, including WebExtensions, are centered on maximizing Energy Efficiency, Security, and user Privacy. These principles are especially critical for battery-powered devices like MacBooks and iPhones.

## Rationale

The strict, short lifetime of background scripts is a deliberate design choice to achieve these goals. By aggressively unloading idle extensions, Safari reduces persistent memory pressure and minimizes background CPU activity, which directly conserves battery life. From a security and privacy standpoint, limiting the time a privileged background context is active shrinks the attack surface and minimizes the window of opportunity for malicious or unwanted activities, such as silent data collection or running unauthorized computations. This forces extensions into a model where they only consume resources when actively providing value to the user.

## Abuse Scenario Mitigated

This policy effectively mitigates several potential abuse scenarios. These include: covert crypto-mining that consumes CPU cycles in the background; persistent network sockets used for botnet command-and-control; continuous data exfiltration by scraping web content or accessing device APIs (like location or microphone) and sending the data via native messaging; and significant battery drain caused by high-frequency, invisible wake-up loops.

## Implication For Developers

Developers must adopt a fully event-driven architecture, assuming the background context is ephemeral and can be terminated at any moment without warning. This necessitates registering all event listeners at the top level of the script, persisting all critical state using the `storage` API, and relying on the `alarms` API for periodic or delayed tasks instead of `setTimeout` or `setInterval`. For native messaging, developers must anticipate and handle `SFErrorDomain error 3` as a transient failure, implement robust retry logic, batch messages to fit within the short wake window, and be prepared to re-establish any connections on each new wake cycle.


# Key Takeaways For Developers

- **Embrace Ephemerality**: Architect your extension with the assumption that the background service worker or event page can be terminated at any moment after about 30 seconds of inactivity or under memory pressure. Do not rely on global variables to maintain state.
- **Use Storage for Persistence**: Persist all critical state and request queues using the `browser.storage` API (`local` or `session`). This allows the background script to rehydrate its state and resume work after being terminated and restarted.
- **Replace Timers with Alarms**: For any periodic or delayed tasks, use the `browser.alarms` API instead of `setTimeout` or `setInterval`. Alarms are designed to work with non-persistent backgrounds, as they will wake the service worker when they fire.
- **Prefer `connectNative` for Frequent Communication**: For chatty, ongoing communication, use `browser.runtime.connectNative` to establish a single, long-lived port. This is more efficient than repeated `sendNativeMessage` calls, which spawn a new native host process each time. However, you must still handle the port's `onDisconnect` event and be prepared to reconnect it when the background restarts.
- **Batch and Serialize `sendNativeMessage` Calls**: If using `sendNativeMessage`, avoid firing a large number of calls in a rapid burst. Instead, queue messages and send them in small batches or serialize them to stay within the background page's limited active window.
- **Implement Robust Error Handling**: Always check `browser.runtime.lastError` in your `sendNativeMessage` callbacks. Specifically detect `SFErrorDomain error 3` and treat it as a transient failure, triggering a retry mechanism (e.g., via the Alarms API with exponential backoff).
- **Design Idempotent Native Hosts**: Ensure your native host application can safely handle repeated messages. If the extension retries a message after a failure, the native host should not perform a duplicate action that corrupts state.
- **Return `true` for Asynchronous Responses**: In any `onMessage` event listener that performs an asynchronous operation (like calling `sendNativeMessage`), you must `return true` to keep the message channel open until your `sendResponse` callback is invoked.
- **Test on Physical Devices**: The background lifecycle, especially termination due to memory pressure, is most pronounced on physical iOS devices. Test your extension thoroughly on iPhones and iPads, not just on macOS, to ensure reliability.
