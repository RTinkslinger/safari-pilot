# Executive Summary

Migrating from a Manifest V3 service worker to a non-persistent event page (`"persistent": false`) in Safari 18.x is a recognized workaround for stability issues, but it does not grant the background script true persistence. Both service workers and non-persistent event pages are subject to aggressive termination by Safari after approximately 30 seconds of inactivity. Critically, this termination occurs even if there are in-flight `browser.runtime.sendNativeMessage` promises or other asynchronous operations pending. When the event page unloads, the JavaScript context is destroyed, causing any pending promises to either hang or have their responses silently dropped. Similarly, persistent connections established with `browser.runtime.connectNative` are terminated and are not automatically re-established by the browser upon waking. The primary architectural implication is that the background script must be treated as stateless. All critical information must be persisted using `browser.storage.local`, and any delayed or periodic tasks must be managed with the `browser.alarms` API, as these are the only mechanisms that reliably survive the unload/reload cycle. In-memory variables, `setTimeout`/`setInterval` timers, and the state of any ongoing operations are completely lost each time the script is terminated.

# Native Message Unload Behavior

## Primary Outcome

The .appex handler's `completeRequest` fires, but it is directed at a terminated JavaScript context, causing the response to be silently dropped.

## Explanation

Safari's memory management for non-persistent event pages prioritizes unloading idle scripts to conserve resources. An in-flight `browser.runtime.sendNativeMessage` promise is not considered an activity that prevents this unloading. When the event page's JavaScript context is terminated, the native .appex handler, which runs in a separate process, may still complete its operation and call `NSExtensionContext.completeRequest`. However, because the originating context no longer exists, there is nowhere for Safari to deliver the response. Consequently, the response is lost, and the promise from the original call will never be fulfilled.

## Promise State

The promise is effectively abandoned and will never resolve or reject. From the perspective of the code that made the call, it hangs indefinitely, as the context in which it existed is destroyed before it can be settled.

## Confidence Level

Medium to High. This conclusion is based on the documented behavior of non-persistent pages, multiple community reports, and empirical observations of service worker termination under similar conditions. While Apple's documentation does not explicitly detail this specific failure case, the described behavior is a logical consequence of the ephemeral nature of event pages.


# Persistent Port Unload Behavior

## Port Survives Unload

False

## Safari Auto Reconnects

False

## Recommended Reconnection Pattern

The recommended pattern is to treat the native port as ephemeral. The extension's background script should attempt to establish a connection using `browser.runtime.connectNative` during its initial, top-level execution every time it is loaded. It must also implement an `onDisconnect` listener. This listener can trigger a reconnection loop, often with an exponential backoff strategy to avoid overwhelming the system. Reconnection attempts should also be made in response to key lifecycle events like `runtime.onStartup` or the first time a message needs to be sent after a period of inactivity. All state required to re-initialize the connection and any pending tasks should be persisted in `browser.storage.local` to survive the unload/reload cycle.

## Known Bugs Or Issues

While no specific bug IDs for `connectNative` in Safari 18 are cited, community reports mention that ports can disappear upon event page unload. Additionally, related issues, such as background pages becoming unresponsive after approximately 30 seconds, were addressed in Safari 17.6. Although fixed, this history indicates the fragility of background script lifecycles, which directly impacts the stability of persistent connections.


# State Persistence Summary

## Persistent State

States and APIs that survive the unload and subsequent reload of a non-persistent event page include:

*   **`browser.storage.local`**: Data saved using this API is written to disk and persists across browser sessions and extension updates, not just event page reloads. It is the recommended method for maintaining state.
*   **`browser.alarms`**: Alarms created with `browser.alarms.create()` are managed by the browser itself, not the extension's JavaScript context. They persist even when the event page is unloaded and will trigger the page to wake up and execute the corresponding `onAlarm` listener when they fire.

## Reset State

When a non-persistent event page is unloaded, its entire JavaScript context is destroyed. The following are reset or lost:

*   **In-Memory Variables**: All global and local variables, including constants, `let` variables (like a `nativeMessageChain` promise), and the contents of objects like `Map` and `Set`, are lost. The script is re-executed from the top on the next wake, re-initializing these variables.
*   **Timers**: Timers scheduled with `setTimeout()` and `setInterval()` are cancelled and will not fire if the page unloads before they complete. They are tied to the script's execution context.
*   **In-Flight Promises**: Any pending Promises, such as those from `browser.runtime.sendNativeMessage(...)` or `browser.tabs.sendMessage(...)`, are terminated. If the event page unloads while awaiting a response, the promise will not resolve, and the response from the native host or content script will be dropped as it returns to a non-existent context.

## Citation Summary

The provided research consistently confirms this behavior. Apple's documentation advises using the Storage API to save and restore state and the Alarms API to replace `setTimeout` for reliable wake-ups in non-persistent contexts. Community reports and empirical tests described in the findings corroborate that service workers and event pages are terminated after a period of inactivity (around 30 seconds), which clears all in-memory state, including pending promises and timers. The lifecycle model for non-persistent scripts necessitates re-registering event listeners at the top level of the script upon every load, as the previous registrations are lost with the old script context.


# Iife Wrapper Guidance

## Potential Issues

Using an Immediately Invoked Function Expression (IIFE) to wrap the entire background script can lead to issues when the non-persistent event page is re-evaluated upon waking. The primary risk is **listener double-binding or accumulation**. Because the entire script, including the IIFE, is executed from scratch every time the event page loads, any `addListener` calls inside the IIFE will run again. If the browser's event system does not automatically handle duplicate registrations of the same function reference, this can lead to the same event handler being called multiple times for a single event, causing unpredictable behavior and potential bugs.

## Apple Sample Code Pattern

The research indicates that Apple's own sample code for Safari Web Extensions generally does not use an IIFE to wrap the entire background script. Instead, the common and recommended pattern observed in official examples is to register event listeners (`runtime.onMessage.addListener`, `alarms.onAlarm.addListener`, etc.) at the top level of the script. This ensures they are re-established cleanly every time the event page is loaded by Safari.

## Recommendation

It is preferred to **drop the IIFE wrapper** and place all event listener registrations at the top level of your `background.js` file. This is the simplest and most robust pattern for non-persistent event pages, as it aligns with Apple's demonstrated practices and avoids the risk of listener duplication. If an IIFE is necessary for other reasons (e.g., managing a private scope for helper functions), you must ensure listener registration is idempotent. This can be achieved by using a flag to ensure initialization code runs only once or by checking if a listener is already registered using `browser.runtime.onMessage.hasListener()` before adding it, though the availability and behavior of `hasListener` should be verified for all relevant APIs in Safari.


# Promise Keepalive Analysis

## Finding

False

## Supporting Evidence

The conclusion is supported by multiple sources. Empirical reports from developers on forums like Stack Overflow and the Apple Developer Forums consistently show that both service workers and non-persistent background pages are terminated by Safari after about 30-45 seconds of inactivity, even when there are pending promises from operations like `sendNativeMessage` or long-polling `fetch` requests. Apple's own documentation encourages using the `browser.alarms` API for delayed or periodic tasks, implicitly discouraging reliance on timers or long-running asynchronous operations to maintain the script's lifecycle. The fix for background page responsiveness in Safari 17.6 addressed a specific bug but did not change this fundamental unload-when-idle policy.

## Reliable Wake Triggers

A non-persistent event page can be reliably woken from a suspended state by several mechanisms managed by the browser itself. These include: `browser.alarms` firing at their scheduled time; user interaction with the extension's UI (such as clicking a browser action popup or context menu); and the arrival of various extension events for which a listener has been registered at the top level of the script, such as `runtime.onMessage`, `tabs.onUpdated`, or `webRequest` events.


# Alarm Api Behavior

## Persistence Across Unloads

True

## Duplicate Name Behavior

replaces

## Safari Specific Caveats

Several specific behaviors and limitations for the `browser.alarms` API in Safari have been identified:

*   **Persistence:** Alarms are managed by the browser and persist across event page unloads and reloads. You do not need to re-create them on every wake. However, persistence across a full browser restart is not guaranteed, so it is best practice to check for and create necessary alarms during the `runtime.onStartup` event.
*   **Minimum Interval:** Safari, like Chrome, enforces a minimum interval for alarms. While Chrome's is 30 seconds, community observations suggest Safari's minimum might be 1 minute. Alarms set with a `delayInMinutes` or `periodInMinutes` value less than this minimum will be automatically rounded up to the minimum allowed value.
*   **Behavior During System Sleep:** Alarms do not wake the device from sleep. If an alarm's scheduled time passes while the system is asleep, it will fire shortly after the system wakes up. For repeating alarms, they will fire at most once upon wake and then the schedule will be re-based from that wake time.
*   **Accuracy:** The Alarms API does not provide real-time guarantees. Delivery can be delayed by the browser, especially under heavy system load or power-saving conditions. It is suitable for periodic tasks but not for high-precision timing.


# In Flight Command Durability

## Response Outcome On Unload

If the event page unloads while awaiting a response from a `browser.tabs.sendMessage` call, the response from the content script will be lost. The JavaScript context of the event page, including the pending promise and its resolution callbacks, is terminated. When the content script eventually calls `sendResponse`, there is no active listener to receive it, so the message is silently dropped.

## Recovery Patterns

To ensure command durability, several patterns are recommended:

1.  **State Persistence & Command Queue:** Before sending a command, write its details (e.g., a unique ID, payload, target tab) to `browser.storage.local`. When the background script re-awakens, it can check this storage for any commands that were not completed and decide whether to retry them.
2.  **Idempotency:** Design commands so that executing them multiple times has the same result as executing them once. This prevents unintended side effects if a command is retried after the background page reloads.
3.  **Acknowledgement (Ack/Nack) System:** The content script can immediately send back a simple 'ack' message upon receiving a command, before starting the main work. If the background page doesn't receive this ack within a short timeout, it can assume the message was lost and retry. The final result is sent later.
4.  **Command IDs:** Assign a unique identifier to every message. The content script includes this ID in its response. This allows the background script to correlate responses with requests, especially important when managing a queue of pending commands in storage.


# Service Worker Vs Event Page Comparison

## Feature

Lifecycle, State, and Messaging Behavior

## Service Worker Behavior

In Safari 18.x, MV3 service workers are subject to an aggressive termination policy. They are generally suspended after approximately 30 seconds of inactivity, and this timer is not reliably paused by pending asynchronous operations like `sendNativeMessage` or long-polling. This can lead to the service worker being 'killed' mid-operation. A fix in Safari 17.6 addressed a critical bug where background pages would become unresponsive, but the fundamental ephemeral nature remains. Upon termination, all in-memory state (variables, timers, unresolved Promises) is lost. The service worker is only revived by specific events like alarms, user actions, or incoming messages. Debugging can be difficult due to this unpredictable termination. Native messaging ports (`connectNative`) are also terminated when the worker is suspended.

## Event Page Behavior

A non-persistent event page (using `"persistent": false`) is explicitly designed to be ephemeral, loading only to handle events and unloading shortly after becoming idle. Its behavior in Safari 18.x is functionally very similar to the observed behavior of service workers. It will unload even if a `browser.runtime.sendNativeMessage` Promise is in-flight; the response from the native host is typically sent to a terminated JavaScript context and silently dropped. Similarly, a `browser.runtime.connectNative` port is closed upon unload and is not automatically reconnected by Safari. All in-memory state, including variables, timers, and the contents of `Map` or `Set` objects, is reset on each wake. The primary advantage is a more predictable, albeit still ephemeral, lifecycle, which some developers find more stable for debugging than the service worker implementation.


# Known Safari Issues And Regressions

## Issue Summary

Background scripts (both MV3 service workers and non-persistent event pages) can become unresponsive or be terminated by Safari after approximately 30-45 seconds of inactivity, even with pending asynchronous operations.

## Reference Id Or Link

Safari 17.6 Release Notes (Bug ID 127681420), multiple Apple Developer Forum and Stack Overflow reports from 2024-2026.

## Impact

This is a high-risk issue that causes premature termination of background tasks, loss of state, and dropped responses from native messaging calls. It severely impacts the reliability of any extension that performs long-running or asynchronous background operations.

## Affected Versions

Safari 17.4.x–17.6 (especially on iOS), with reports indicating the underlying aggressive termination behavior persists in Safari 18.x / macOS 26.

## Status

Partially Fixed. A specific bug causing unresponsiveness was fixed in Safari 17.6, but the core policy of aggressive, time-based termination of idle background contexts remains. Community reports indicate it is still a significant issue.

## Recommended Workaround

Design the extension for an ephemeral background context. Use `browser.alarms` for periodic tasks instead of `setTimeout` or long-polling. Persist all critical state to `browser.storage.local`. For native messaging, implement robust retry logic and state management to handle dropped responses, assuming any in-flight call can be interrupted.

## Issue Summary

WebExtensions cannot apply rules or reliably interact with content in blank frames (`about:blank` or `about:srcdoc`).

## Reference Id Or Link

WebKit Bugzilla ID 296702

## Impact

This limitation can break functionality that relies on content scripts to initiate or mediate native messaging from within sandboxed iframes or newly created blank tabs, requiring more complex workarounds.

## Affected Versions

Recent Safari versions, including 18.x, as the bug is reported as 'Open'.

## Status

Open

## Recommended Workaround

Avoid designs that require initiating native communication from `about:blank` frames. If necessary, use the background script as the central coordinator for native messaging, communicating with content scripts in valid frames to trigger actions.

## Issue Summary

WebSocket connections to localhost (`127.0.0.1`) are broken in Safari.

## Reference Id Or Link

WebKit Bugzilla ID 171934

## Impact

This prevents developers from using a local WebSocket server as a fallback or alternative communication channel between the web extension and a native daemon, a pattern sometimes used for more complex interactions than `sendNativeMessage` allows.

## Affected Versions

Recent Safari versions, including 18.x, as the bug is reported as 'Open'.

## Status

Open

## Recommended Workaround

Rely exclusively on the `browser.runtime.sendNativeMessage` and `browser.runtime.connectNative` APIs for communication with the native host application. Do not implement fallbacks that depend on local WebSockets.


# Safari Version Behavior Timeline

## Safari Version

Safari 17.6 to 18.x

## Release Date

2024 - 2026

## Relevant Changes

This period is defined by Apple's efforts to manage the lifecycle of MV3 background scripts. A critical milestone was the release of Safari 17.6 (July 2024), which included a fix for a widely reported bug (127681420) where background pages would become unresponsive after about 30 seconds. While this improved stability, the fundamental model for both service workers and non-persistent event pages in Safari 18.x (released late 2024 and updated through 2025-2026) remains ephemeral. The browser aggressively unloads idle background contexts to conserve resources. Reports indicate that pending Promises from `sendNativeMessage` or other async operations do not prevent this unloading. Native messaging continues to be routed through the containing app's .appex handler. Developers targeting Safari 18.x must design for this idle-unload behavior, using `browser.alarms` for scheduling and `browser.storage` for state persistence, as the background script's in-memory state is not guaranteed to survive beyond a brief period of inactivity.


# Porting Checklist

## Step

1.0

## Action

Modify the `manifest.json` to switch from a service worker to a non-persistent background script.

## Justification

This is the fundamental change to adopt the event page model. The `service_worker` key is replaced with `scripts`, and `persistent: false` explicitly tells Safari to use the non-persistent, event-driven model, which has been observed to be more stable than the service worker implementation in recent Safari versions. The `type: "module"` key is no longer applicable and must be removed.

## Step

2.0

## Action

Refactor the background script to remove ES module syntax (`import`/`export`).

## Justification

Non-persistent background scripts (`"scripts": [...]`) do not support ES module syntax. Any dependencies previously loaded via `import` must be either included in the same file or loaded using `importScripts()` at the top of the script.

## Step

3.0

## Action

Ensure all event listeners (`runtime.onMessage`, `alarms.onAlarm`, etc.) are registered idempotently at the top level of the script.

## Justification

The event page is re-evaluated every time it wakes up. Registering listeners at the top level ensures they are active immediately. However, simply calling `addListener` on every load can lead to duplicate listeners. While modern APIs often handle this, it's safer to either use a pattern that prevents re-registration (e.g., `if (!browser.runtime.onMessage.hasListener(handler))`) or structure the code to avoid re-defining the listener function within a re-executed scope like an IIFE.

## Step

4.0

## Action

Replace the `while(pollLoopRunning) { await pollForCommands(); }` pattern and any other long-running asynchronous loops with `browser.alarms`.

## Justification

Research confirms that a pending Promise, including from `sendNativeMessage` or a long-poll, does *not* prevent Safari from unloading an event page or service worker. `browser.alarms` is the only reliable, browser-managed mechanism to guarantee code execution after a period of inactivity, as it will wake the event page.

## Step

5.0

## Action

Re-architect the native messaging promise chain (`nativeMessageChain`) to be resilient to page unloads.

## Justification

The current `let nativeMessageChain = Promise.resolve()` pattern is an in-memory variable and will be reset every time the event page unloads, losing the serialization state. Furthermore, if the page unloads while a `sendNativeMessage` promise is in-flight, the response will be lost. A robust solution involves persisting the request queue to `browser.storage.local` before sending and re-checking this queue on startup to handle any interrupted messages.

## Step

6.0

## Action

For all communication with the native host, switch from one-shot `sendNativeMessage` to using `browser.runtime.connectNative` for more robust error handling.

## Justification

`connectNative` provides an `onDisconnect` event, which is crucial for detecting when the connection to the native host is lost, either due to the event page unloading or the native process crashing. This allows for implementing a reliable reconnection strategy with exponential backoff.

## Step

7.0

## Action

Persist all critical application state, including connection flags and pending command identifiers, to `browser.storage.local` instead of relying on in-memory variables.

## Justification

All in-memory state, including variables, `Map`s, and `Set`s, is completely wiped when the event page unloads. `browser.storage.local` is the designated persistent storage mechanism that survives unloads and browser restarts.

## Step

8.0

## Action

Wrap `browser.tabs.sendMessage` calls with logic to handle lost responses.

## Justification

If the event page unloads while awaiting a response from a content script, the promise will be rejected or the callback will never fire. To ensure command durability, the background script should persist the command's state before sending and implement a timeout/retry mechanism to re-issue the command if a response isn't received.


# Code Modification Examples

## Area

Manifest (`manifest.json`)

## Description

Change the background script definition from a service worker to a non-persistent event page.

## Code Snippet

"background": {
  "scripts": ["background.js"],
  "persistent": false
}

## Area

Listener Registration

## Description

Ensure listeners are not added multiple times. This can be done by moving listener registration to the top-level scope and avoiding re-declaration within functions, or by using a flag.

## Code Snippet

let listenersAttached = false;

function initialize() {
  if (listenersAttached) return;

  browser.runtime.onMessage.addListener(handleMessage);
  browser.alarms.onAlarm.addListener(handleAlarm);
  // ... other listeners

  listenersAttached = true;
}

initialize();

## Area

Native Messaging

## Description

Replace the simple `sendNativeMessage` promise chain with a more robust pattern using `connectNative` that handles disconnection and timeouts, making it suitable for a non-persistent environment.

## Code Snippet

let nativePort = null;

function connect() {
  nativePort = browser.runtime.connectNative('com.your.app.id');
  console.log('Connecting to native host...');

  nativePort.onMessage.addListener((message) => {
    console.log('Received native message:', message);
    // Handle incoming messages from native host
  });

  nativePort.onDisconnect.addListener(() => {
    console.error('Native port disconnected. Reconnecting in 5 seconds...');
    nativePort = null;
    setTimeout(connect, 5000);
  });
}

// Initial connection
connect();

function sendNativeMessageWithCallback(message, callback) {
  if (!nativePort) {
    console.error('Native port not connected.');
    // Optionally, queue the message or attempt to reconnect immediately
    return;
  }
  // Implement a request/response mechanism with unique IDs
  const requestId = Date.now() + Math.random();
  message.requestId = requestId;

  const responseListener = (response) => {
    if (response.requestId === requestId) {
      nativePort.onMessage.removeListener(responseListener);
      callback(response);
    }
  };

  nativePort.onMessage.addListener(responseListener);
  nativePort.postMessage(message);
}

## Area

State Management

## Description

Demonstrates persisting command state to `storage.local` before sending a message to a content script to ensure recovery if the event page unloads before a response is received.

## Code Snippet

async function sendCommandToTab(tabId, command) {
  const commandId = `cmd_${Date.now()}`;
  const pendingCommands = (await browser.storage.local.get('pendingCommands')).pendingCommands || {};
  pendingCommands[commandId] = { tabId, command, status: 'sent' };
  await browser.storage.local.set({ pendingCommands });

  try {
    const response = await browser.tabs.sendMessage(tabId, { commandId, ...command });
    // On successful response, remove from pending
    const updatedPending = (await browser.storage.local.get('pendingCommands')).pendingCommands || {};
    delete updatedPending[commandId];
    await browser.storage.local.set({ pendingCommands: updatedPending });
    return response;
  } catch (error) {
    console.error(`Command ${commandId} failed or timed out. It will be retried on next startup.`, error);
    // The command remains in storage for a retry attempt later.
  }
}


# Testing And Validation Strategy

## Scenario Type

Manual QA

## Scenario Description

Test system sleep and wake cycle. Steps: 1. Perform an action that communicates with the native host. 2. Put the macOS device to sleep for several minutes. 3. Wake the device and perform another action that requires native communication.

## Expected Outcome

The extension should function correctly after waking. The `onDisconnect` handler for the native port should have fired, and the reconnection logic should have successfully re-established the connection to the native host, allowing the new action to complete successfully. Alarms scheduled before sleep should fire correctly after wake-up.


# Final Recommendations

To build a robust Safari Web Extension for Safari 18.x, it is crucial to adopt an architecture that fully embraces the ephemeral nature of non-persistent background scripts. The following principles and practices are recommended:

1.  **Assume a Stateless, Event-Driven Context:** Treat the background script as if it could be terminated at any moment between event handler executions. Do not rely on global variables or any in-memory state to persist across events. Every time the script is activated by an event, it should be treated as a fresh execution.

2.  **Use `browser.storage.local` for All State:** Any information that must survive an unload/reload cycle, such as user settings, session data, or the state of an ongoing multi-step operation, must be explicitly saved to `browser.storage.local`. The script should read from storage upon initialization to restore its state.

3.  **Rely on `browser.alarms` for Scheduling:** Replace all uses of `setTimeout` and `setInterval` for tasks that need to run after a period of inactivity. The `browser.alarms` API is the only reliable mechanism for scheduling future work, as alarms are managed by the browser itself and will wake the event page when they fire, even if it has been terminated.

4.  **Implement Idempotent and Resilient Messaging:**
    *   **For `sendNativeMessage` and `tabs.sendMessage`:** Since responses can be lost if the page unloads, design a robust request/response system. Before sending a critical message, save its details (e.g., a unique ID and payload) to `browser.storage.local`. When the response is received, remove the corresponding entry from storage. On every script startup, check the storage for any pending requests that were never completed and implement logic to retry or clean them up. This prevents lost operations.
    *   **For `browser.runtime.connectNative`:** Do not assume a connection port will remain open. Always register a handler for the `onDisconnect` event. The primary logic for establishing a connection should be executed upon script startup (e.g., in the `runtime.onStartup` listener) and potentially before any attempt to send a message, to ensure a connection is available or can be re-established.

5.  **Ensure Correct Listener Registration:** Register all event listeners (e.g., `runtime.onMessage`, `alarms.onAlarm`) at the top level of your background script. This ensures they are re-registered every time the script is re-evaluated upon waking. While an IIFE wrapper is not inherently harmful, it can complicate debugging and increase the risk of accidentally re-registering listeners incorrectly. For simplicity and robustness in an event-page model, placing listener registrations directly in the global scope is the safest pattern.
