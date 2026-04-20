# Executive Summary

Reliably executing JavaScript in Safari tabs from an alarm-woken, non-persistent background script is challenging due to Safari-specific lifecycle bugs and race conditions. When an alarm wakes the background service worker, API calls like `browser.tabs.query`, `browser.scripting.executeScript`, and `browser.tabs.sendMessage` often fail silently—returning empty arrays, null, or undefined—because the worker's communication channels to the tabs are not yet fully initialized. This is a known issue rooted in Safari/WebKit's unique and sometimes fragile process management.

The most effective solutions involve a multi-layered, defensive architecture. For maximum reliability, especially for complex extensions like 1Password or Grammarly, the recommended pattern is to use a native companion app to handle persistent state and long-running tasks, with the extension's background script acting as a lightweight mediator. For extensions without a native component, the most robust pattern is to implement a storage-based message bus: the background script writes a command object to `browser.storage.local`, and content scripts, listening via `browser.storage.onChanged`, execute the command and write results back. To solve the issue of finding tabs when `tabs.query` fails, content scripts should proactively register their `tabId` and URL in a storage-based registry. Finally, all direct API calls from an alarm handler should be wrapped in resilient logic that includes short delays and exponential backoff retries, treating empty or null results as transient 'not-ready' states rather than definitive failures.

# Problem Root Cause Analysis

## Race Condition Details

When a `browser.alarms` event wakes Safari's non-persistent background service worker, the worker's JavaScript code begins executing almost immediately. However, a critical race condition occurs because the browser's internal infrastructure—specifically the Inter-Process Communication (IPC) proxies and tab/frame routing tables that connect the worker to the content processes of open tabs—is not yet fully initialized and bound to the newly spawned worker. API calls like `tabs.query` or `tabs.sendMessage` made within this brief, unready window are dispatched before the routing is complete. The browser process, not yet having a valid communication route from the worker to any tabs, consequently returns empty (`[]`), `null`, or `undefined` results without throwing an error. This is a synchronization failure, not a permissions issue.

## Lifecycle Regression Details

Safari's service worker lifecycle has been historically fragile and prone to regressions that exacerbate these timing issues. Multiple community and official reports confirm bugs where service workers are aggressively or permanently killed. For instance, in some Safari 17.4–17.5 builds, workers were reportedly terminated when device memory usage reached approximately 80% and would not recover on their own, severing the connection to the extension. Another significant issue, which Apple noted as fixed in Safari 17.6 (Bug ID 127681420), caused background pages to become completely unresponsive after about 30 seconds. Despite this fix, developers report that complex extensions can still experience lifecycle instability, and the lack of robust service worker debugging tools in Safari makes diagnosing these 'disappearing worker' issues particularly challenging.

## Api Timing Issues

There is a distinct and brief timing window immediately following an alarm-triggered worker startup during which standard WebExtension APIs fail silently. This window can last from a few milliseconds to several hundred. Calls to `tabs.query` within this window return an empty array `[]` even when matching tabs are open. `scripting.executeScript` returns `null` or an array containing `[null]` instead of the expected injection results. `tabs.sendMessage` returns `undefined` immediately, and its callback, if provided, is invoked with `undefined`, indicating the message was not delivered. These are not exceptions but empty success values, making them difficult to detect without explicitly checking the return values. Empirical evidence from developers shows that introducing a small delay (e.g., 100–300ms) or implementing a retry loop often provides enough time for Safari's internal bindings to complete, after which the API calls begin to succeed.

## Supporting Evidence Links

Apple Developer Forum (Service Worker killed): https://developer.apple.com/forums/thread/721222
StackOverflow (30-second crash): https://stackoverflow.com/questions/78570837/non-persistent-background-script-seems-to-crash-after-30-seconds-in-safari-web-extension
WebKit Bug Tracker (Blank frame issues): https://bugs.webkit.org/show_bug.cgi?id=296702
GitHub Issue (Extension breakage): https://github.com/dessant/search-by-image/issues/325
GitHub Reproduction (Service worker crash): https://github.com/getchardy/safari-extension-bug-service-worker-crash
Apple Developer Forum (sendMessage returns null): https://developer.apple.com/forums/thread/758346
WebKit Bug Tracker (Service Worker freezing): https://bugs.webkit.org/show_bug.cgi?id=211018


# Recommended Fallback Strategy

## Rank

1.0

## Strategy Name

Content-Script-Led Storage Registry for Tab Discovery

## Description

This strategy works by inverting the responsibility of tab discovery. Instead of the background script querying for tabs, each content script actively registers its presence and details upon loading. When a content script loads in a tab, it writes a record to `browser.storage.local`. This record typically includes the `tabId`, `frameId`, a `canonicalURL`, and a `lastSeen` timestamp. When the background script is woken by an alarm and needs to find a tab by its URL, it queries this storage registry instead of calling `browser.tabs.query`. It can iterate through the stored records to find a match based on the URL or other criteria. This provides a persistent and reliable source of truth about open tabs that is not affected by the background script's ephemeral nature.

## Reliability Notes

This is the most reliable pattern for tab discovery in Safari's non-persistent background context because it bypasses the race conditions that cause `tabs.query` to fail. It leverages the stable, in-page context of content scripts. However, it introduces some complexity and trade-offs. The registry can contain stale data if a tab crashes or is closed without the content script's `beforeunload` event firing, necessitating a garbage-collection mechanism based on the `lastSeen` timestamp. There is also a minor latency between a tab opening and its registration in storage. Privacy must be considered, as storing full URLs can have implications; for some use cases, storing only the origin or a hashed URL may be preferable.


# Storage Backed Tab Discovery Pattern

## Registration Scheme

The registration scheme is led by content scripts injected into each web page. These scripts are responsible for announcing their presence and state to a central registry in `browser.storage.local`. The registration is triggered by several key lifecycle events:
1.  **Initial Load**: Upon `DOMContentLoaded` or `window.load`, the content script gathers information about its tab and frame and writes a record to storage. To get its own `tabId` and `frameId`, which are not directly available to content scripts, it sends a message to the background script (e.g., `browser.runtime.sendMessage({ action: "getTabFrameId" })`), which can access this information from the `sender` object of the message.
2.  **Visibility Change**: The script listens for the `visibilitychange` event. When the tab becomes visible (`document.visibilityState === 'visible'`), it updates its record in storage, primarily to refresh the `lastSeen` timestamp. This acts as a heartbeat, indicating the tab is still active.
3.  **Unload/Cleanup**: The script listens for `beforeunload` and `pagehide` events to attempt to remove its record from storage. This cleanup is considered best-effort, as these events are not always guaranteed to fire (e.g., in a browser crash).

## Tab Record Schema

Each tab or frame is represented by a structured object in `browser.storage.local`, typically stored under a key like `"tab_{tabId}_{frameId}"`. The schema for this record includes:
- `tabId` (integer): The unique identifier for the tab, crucial for targeting it with other browser APIs.
- `frameId` (integer): The identifier for the frame within the tab. The top-level frame is typically `0`.
- `isTopFrame` (boolean): A flag indicating if the script is running in the top-level document (`window.self === window.top`), which helps in filtering for main tabs versus iframes.
- `canonicalURL` (string): The final, resolved URL of the page, which should account for any redirects. This is the primary field used for lookups.
- `lastSeen` (integer): A `Date.now()` timestamp that is updated whenever the content script reports its presence. This is essential for the garbage collection of stale entries.
- `title` (string): The `document.title` of the page, useful for display or debugging purposes.
- `favIconUrl` (string): The URL of the page's favicon, if available.
- `originPermissions` (array of strings): An optional field listing the origins for which the extension has permissions, which can be used for security and privacy checks before acting on a tab.

## Garbage Collection Strategy

A multi-layered garbage collection strategy is necessary to prevent the storage from filling with stale entries, especially since `beforeunload` cleanup is not guaranteed. The strategy consists of:
1.  **Active Cleanup by Content Script**: The content script attempts to remove its own entry from `browser.storage.local` during the `beforeunload` or `pagehide` events. This is the most immediate form of cleanup for normally closed tabs.
2.  **Periodic Background Cleanup (TTL-based)**: A recurring `browser.alarms` job runs in the background script (e.g., once every few hours). This job iterates through all tab records in storage and checks the `lastSeen` timestamp. If a record has not been updated within a predefined Time-To-Live (TTL) period (e.g., 24 hours), it is considered stale and is removed. This handles cases where a tab or the browser crashed, preventing the content script's cleanup from running.
3.  **On-Demand Refresh**: When a browser session is restored, content scripts in the restored tabs will re-register themselves, automatically updating their `lastSeen` timestamps and overwriting any old data for that `tabId`/`frameId`.

## Privacy Considerations

Storing a registry of visited URLs has significant privacy implications that must be managed carefully:
- **Data Minimization**: Only the minimum necessary information should be stored. If the full URL path is not needed for discovery, store only the origin (`https://example.com`).
- **Hashing**: For more sensitive use cases, instead of storing the URL or origin in plaintext, store a cryptographic hash (e.g., SHA-256) of it. The background script can then compute the hash of a target URL to find a match, without ever storing the browsed URL directly.
- **Permission Gating**: The content script should verify that the extension has been granted host permissions for the current page's origin before writing any record to storage. This prevents the extension from collecting data from sites the user has not authorized.
- **Private/Incognito Windows**: `browser.storage.local` is typically isolated for private windows and cleared when they are closed. The content script can check `browser.extension.inIncognitoContext` and choose to disable registration entirely in private mode to further protect user privacy.


# Storage Onchanged Message Bus Pattern

## Command Protocol Definition

A well-defined command protocol is essential for the message bus. A command is a structured object written to a unique key in `browser.storage.local` (e.g., `"cmd:{tabId}:{nonce}"`). The protocol includes:
- `nonce` (string): A unique identifier (e.g., a UUID) for the command, used for tracking, deduplication, and correlating replies.
- `action` (string): A string identifying the function or task the content script should perform (e.g., 'GET_PAGE_METADATA').
- `args` (any): An object containing the arguments for the specified action. This must be a structured-cloneable value.
- `tabId` (integer): The ID of the tab the command is intended for, allowing content scripts to ignore commands not meant for them.
- `replyKey` (string): The specific storage key (e.g., `"reply:{tabId}:{nonce}"`) where the content script must write the result of the command. This allows the background script to listen for a specific change.
- `timestamp` (integer): The creation time of the command, used for metrics and for expiring stale commands.
- `deadline` (integer): A timestamp after which the content script should ignore the command, preventing execution of outdated requests.
- `idempotencyKey` (string, optional): A key that remains constant across retries of the same logical operation, ensuring the action is only performed once even if the command is sent multiple times.

## Background Script Implementation

The background script acts as the command initiator. Its responsibilities are:
1.  **Command Creation and Writing**: When an action needs to be performed in a tab, the background script constructs a command object according to the protocol, including a unique `nonce` and a designated `replyKey`. It then writes this object to `browser.storage.local` under a unique command key.
2.  **Persisting Inflight Commands**: To survive worker crashes, the background script can write a small marker to storage (e.g., `"inflight:{nonce}"`) before sending a command. This allows a newly started worker to scan for inflight commands and resume waiting for their replies.
3.  **Awaiting Replies**: The background script uses a `Promise`-based wrapper around the `browser.storage.onChanged` listener. It listens specifically for changes to the `replyKey` it generated. The promise resolves when the reply is written or rejects after a configurable timeout.
4.  **Cleanup**: Once a reply is received or the command times out, the background script is responsible for cleaning up the command, reply, and any inflight marker keys from storage to prevent bloat.

## Content Script Implementation

The content script acts as the command executor. Its responsibilities are:
1.  **Listening for Changes**: The content script adds a listener to `browser.storage.onChanged` at startup. This listener fires whenever an item in `browser.storage.local` is changed.
2.  **Command Validation**: Inside the listener, it filters for incoming changes that are command objects intended for its tab (by checking the key prefix and `tabId`). It validates the command by checking if the `nonce` has already been processed (to ensure idempotency) and if the command is within its `deadline`.
3.  **Executing Work**: If the command is valid, the content script executes the specified `action` with the provided `args`. For actions that need access to the page's own JavaScript context (the 'main world'), the content script can inject a `<script>` tag into the DOM and use `window.postMessage` to communicate results back from the page to the isolated content script world.
4.  **Writing Results**: After execution, the content script writes the result (or an error object) back to the `replyKey` specified in the command object. This write action is what triggers the background script's `onChanged` listener, completing the communication loop.

## Reliability Safeguards

Several safeguards are crucial for making the message bus robust:
- **Idempotency**: Content scripts must track processed `nonce` or `idempotencyKey` values (e.g., in a `Set` or `storage.session`) to prevent executing the same command multiple times if the background script retries.
- **Timeouts and Retries**: The background script must implement a timeout when waiting for a reply. If a timeout occurs, it can retry sending the command, potentially with an incremented `retryCount` field. Exponential backoff with jitter should be used for retries to avoid thundering herd problems.
- **Rate Limiting**: To prevent overwhelming `browser.storage` and causing performance issues or crashes in Safari, the background script should implement rate limiting on how frequently it writes commands.
- **Crash-Safe Recovery**: By persisting a list of 'inflight' commands, the background script can recover from a crash or unload. On startup, it can check storage for any commands that were sent but never received a reply, and then either resume waiting or retry them.
- **Stale Command Cleanup**: Both the background and content scripts should ignore and eventually clean up commands that have passed their `deadline` or a reasonable TTL, preventing storage bloat and execution of outdated tasks.


# Safari Specific Hardening Patterns

## Pattern Name

Top-Level Listener Registration

## Justification

This pattern is essential to counter Safari's aggressive unloading of non-persistent background workers (MV2 event pages or MV3 service workers). When an event like an alarm fires, Safari may start a completely new, fresh instance of the background script. If event listeners (e.g., `browser.alarms.onAlarm`, `browser.runtime.onMessage`) are registered asynchronously or nested inside other functions, the event that woke the worker may be missed because the listener is not attached during the initial, synchronous turn of the event loop. Registering all listeners at the top-level, global scope ensures they are attached immediately as the script is parsed, guaranteeing that the extension is ready to handle the incoming event.

## Implementation Summary

In the background script file (e.g., `background.js`), all calls to `browser.*.addListener()` or `chrome.*.addListener()` for persistent event sources must be placed in the top-level scope. They should not be located inside an `if` block, a function call, a Promise `.then()` block, or an `async` function. This ensures they are registered synchronously and immediately upon the script's execution, making the extension resilient to the ephemeral nature of the background context.


# Successful Extension Case Studies

## Extension Name

1Password

## Architecture Summary

1Password's architecture is fundamentally centered around a native companion desktop application that handles all persistent state, security operations, and biometric unlocking. The Safari extension's background script acts as a lightweight mediator, orchestrating communication between the robust native app and the content scripts running in tabs. It uses native messaging to maintain a secure connection to the native core. For tab interactions, it relies on pre-registered content scripts to perform DOM-level work, with the background script dispatching commands and forwarding results. State and queued commands are persisted in `browser.storage` to survive background worker terminations, ensuring that upon being woken by an alarm, the extension can restore context and process pending tasks.

## Uses Native App

True

## Key Takeaway For Alarms

Offload all critical, long-lived state and privileged operations (like biometrics and secure storage) to a native companion app. Use the alarm-woken background script purely as an ephemeral mediator that re-establishes a connection to the native app and dispatches commands from a storage-backed queue to content scripts. This pattern makes the native app the source of truth, bypassing the background worker's lifecycle instability.

## Extension Name

Grammarly

## Architecture Summary

Grammarly employs a persistent native helper process on macOS (e.g., 'Grammarly Desktop Helper'), which is managed by the OS (`launchd`) to ensure it's always running. This native component acts as the stable backend, handling heavy computational tasks, managing user configuration, and maintaining long-lived state. The Safari extension's background script functions as a relay, forwarding requests from content scripts to the native helper via native messaging and sending responses back. This three-tiered architecture (content script <-> background script <-> native helper) isolates the ephemeral background script from state management, relying on it only for message routing. For alarm-triggered tasks, this means the worker can wake up, query the always-on native helper for instructions, and forward them to the appropriate tab.

## Uses Native App

True

## Key Takeaway For Alarms

Utilize a persistent native helper process as the authoritative source for state and complex logic. The alarm-woken background script should perform a quick handshake with the native helper to fetch queued work or configuration, then relay it to content scripts. This makes the background worker's role a simple, stateless relay, minimizing the impact of its ephemeral nature.

## Extension Name

AdBlock/Adblock Plus

## Architecture Summary

AdBlock and similar content blockers heavily prioritize Safari's declarative `declarativeNetRequest` API for most of their work. This offloads the bulk of blocking decisions to the browser engine itself, which is highly efficient and avoids the need for per-tab JavaScript execution, thus bypassing background script lifecycle issues entirely for blocking. For dynamic functionality that requires tab interaction (like cosmetic filtering or UI elements), they use a hybrid model: content scripts handle DOM manipulation, and a containing native app component is used for storing and looking up complex rules and managing persistent state. The background script acts as a coordinator and cache, fetching rules from the native host and providing them to content scripts.

## Uses Native App

True

## Key Takeaway For Alarms

Minimize the need for alarm-triggered arbitrary JavaScript execution by leveraging declarative APIs (`declarativeNetRequest`) wherever possible. For necessary periodic tasks, use alarms to trigger cache updates from a native host or storage, rather than for direct, immediate tab interaction. This reduces the extension's exposure to Safari's background lifecycle fragility.

## Extension Name

Bitwarden

## Architecture Summary

As an open-source project, Bitwarden's architecture is well-documented. It uses a WebExtension packaged within a native desktop app, which handles all cryptographic operations and biometric authentication via native messaging. The background script is a central mediator that rehydrates its state from `browser.storage.local` upon every startup, making it resilient to non-persistent lifecycles. It uses messaging abstractions and robust handshake patterns with explicit acknowledgments (ACKs), retries, and timeouts. If direct messaging fails, it has a fallback mechanism to write commands to a storage-based queue, which content scripts monitor and process.

## Uses Native App

True

## Key Takeaway For Alarms

Implement a multi-layered reliability pattern for alarm-triggered execution. First, attempt a direct message to the content script with a short timeout and retry logic. If this fails, fall back to injecting a bootstrap script. If all else fails, write the command to a persistent queue in `browser.storage.local` for the content script to pick up later. This ensures eventual execution even if immediate communication is impossible.


# Role Of Native Companion Apps

Native companion applications play a critical and stabilizing role for Safari Web Extensions by providing a persistent execution environment that completely bypasses the ephemeral lifecycle of the extension's background service worker. Safari, especially on iOS, aggressively terminates idle background scripts to conserve resources, leading to loss of state and unreliable execution of timed events. A native app, however, runs as a separate, long-lived process managed by the operating system. This allows it to reliably handle persistent tasks, maintain long-term state (like an unlocked vault or user settings), and manage secure operations such as cryptographic functions or biometric authentication (Touch ID/Face ID) that are inaccessible to the sandboxed web extension. The extension's background script can then act as a simple, lightweight mediator. When woken by an alarm, it can immediately connect to the stable native app via native messaging (`browser.runtime.connectNative` or `sendNativeMessage`) to retrieve its state, fetch queued commands, or offload heavy processing. This architecture transforms the unreliable, ephemeral background worker into a resilient component that leverages the stability of the native host, a pattern adopted by nearly all major extensions like 1Password, Bitwarden, and Grammarly to ensure robust functionality.

# Summary Of Apple Official Guidance

## Guidance Topic

Managing Non-Persistent Backgrounds

## Recommendation

Apple's core guidance for managing the ephemeral lifecycle of background scripts is to: 1) Register all event listeners (like `alarms.onAlarm`) at the top level of the script to ensure they are attached immediately upon worker startup. 2) Use the `Storage` API (`browser.storage.local`) to persist and restore state, as in-memory global variables are unreliable across worker unloads. 3) Use the `Alarms` API for any scheduled or delayed work, as it is designed to wake the non-persistent worker, unlike `setTimeout` which may not fire if the worker is terminated.

## Source Citation

Apple Developer Documentation: 'Optimizing your web extension for Safari'


# Api Reliability Analysis

In the context of a Safari non-persistent background script woken by an alarm, the reliability of various APIs for tab script injection differs significantly due to platform-specific lifecycle issues and race conditions.

1.  **`tabs.sendMessage` / `runtime.sendMessage`**: This API is highly unreliable in this context. It frequently returns `undefined` without throwing an error, indicating the message was dropped and the connection to the content script was not established. This failure is a direct symptom of the background worker executing the call before its communication channel to the tab's process is fully initialized. **Pros**: It's a standard, simple API for direct communication. **Cons**: Extremely prone to silent failure in alarm-woken Safari workers, making it unsuitable for critical tasks without extensive retry logic and fallbacks. The response promise may never resolve, and the callback may never be invoked.

2.  **`scripting.executeScript`**: This API is more reliable than `sendMessage` for injection but suffers from similar issues regarding its return value. It often returns `null` or an array of `[null]` instead of the expected script execution results. **Pros**: It can directly inject and execute code or files into a target tab. Using the `files` property to inject a script file is generally more robust across Safari versions than using the `func` property for an inline function. **Cons**: The return value is unreliable in the alarm context, so it cannot be used to retrieve data directly from the page. It is also subject to the same startup race condition and can fail on special pages like `about:blank` or pages with restrictive Content Security Policies (CSPs). **Caveat**: While reliability has improved in Safari 17.6+, it should not be used with the expectation of receiving a return value immediately after an alarm fires.

3.  **`storage.onChanged` as a Message Bus**: This is the most reliable and community-recommended pattern for communication in this scenario. The background script writes a command object to `browser.storage.local`, and the content script listens for the `storage.onChanged` event. **Pros**: It is highly resilient to the background worker's lifecycle because `storage` is persistent and the event is reliably delivered to active content scripts. It decouples the background from the content script, avoiding the direct IPC race condition. **Cons**: It has higher latency than direct messaging and is more complex to implement, requiring a well-defined command/reply protocol, unique nonces for idempotency, and a garbage collection strategy to prevent storage bloat. It cannot wake a sleeping background worker; it is only for communication once the worker is already active (e.g., via an alarm).

# Minimal Reproducible Example Guide

This guide provides a minimal reproducible example (MRE) that first demonstrates the API failure symptoms in Safari and then presents the corrected version using a storage-based message bus.

### Part 1: Reproducing the Failure

This setup will demonstrate `tabs.query`, `scripting.executeScript`, and `tabs.sendMessage` failing when called immediately from an alarm handler.

**1. `manifest.json`**
```json
{
  "manifest_version": 3,
  "name": "Safari Alarm Failure MRE",
  "version": "1.0",
  "permissions": [
    "alarms",
    "tabs",
    "scripting",
    "storage"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background_fail.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"]
    }
  ]
}
```

**2. `background_fail.js`**
```javascript
// This script demonstrates the failing pattern.
chrome.runtime.onInstalled.addListener(() => {
  console.log('Extension installed. Creating alarm.');
  // Schedule an alarm to fire in 3 seconds for demonstration.
  chrome.alarms.create('mre-alarm', { delayInMinutes: 0.05 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'mre-alarm') return;

  console.log('ALARM FIRED - Attempting direct API calls...');

  // Symptom 1: tabs.query returns an empty array
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    console.log('tabs.query result:', tabs); // Often logs: []
    if (!tabs || tabs.length === 0) {
      console.error('tabs.query failed to find any tabs.');
      return;
    }
    const tabId = tabs[0].id;

    // Symptom 2: scripting.executeScript returns null
    chrome.scripting.executeScript({
      target: { tabId: tabId, allFrames: false },
      func: () => document.title,
    }).then(results => {
      console.log('scripting.executeScript result:', results); // Often logs: null or [null]
    }).catch(e => {
      console.error('scripting.executeScript error:', e);
    });

    // Symptom 3: tabs.sendMessage's callback receives undefined
    chrome.tabs.sendMessage(tabId, { greeting: 'hello' }, (response) => {
      console.log('tabs.sendMessage response:', response); // Often logs: undefined
      if (chrome.runtime.lastError) {
        console.error('tabs.sendMessage lastError:', chrome.runtime.lastError.message);
      }
    });
  });
});
```

**3. `content.js`**
```javascript
console.log('Content script loaded.');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Content script received message:', message);
  if (message.greeting === 'hello') {
    sendResponse({ farewell: 'goodbye' });
  }
  // Return true to indicate an asynchronous response.
  return true;
});
```

### Part 2: The Storage-Based Solution

This version corrects the issue by using `browser.storage.local` as a message bus.

**1. `manifest.json`** (Same as above, just point to the new background script)
```json
{
  "manifest_version": 3,
  "name": "Safari Alarm Solution MRE",
  "version": "1.1",
  "permissions": ["alarms", "tabs", "scripting", "storage"],
  "host_permissions": ["<all_urls>"],
  "background": {
    "service_worker": "background_solution.js" // Point to the solution script
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content_solution.js"]
    }
  ]
}
```

**2. `background_solution.js`**
```javascript
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('mre-solution-alarm', { delayInMinutes: 0.05 });
});

// Helper to get the active tab ID, with a small retry for robustness
async function getActiveTabId() {
  for (let i = 0; i < 3; i++) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs && tabs.length > 0) {
      return tabs[0].id;
    }
    await new Promise(resolve => setTimeout(resolve, 150 * (i + 1)));
  }
  return null;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'mre-solution-alarm') return;

  console.log('ALARM FIRED - Using storage bus to send command...');

  const tabId = await getActiveTabId();
  if (!tabId) {
    console.error('Could not find active tab even with retries.');
    return;
  }

  const nonce = Date.now().toString();
  const commandKey = `cmd:${tabId}:${nonce}`;
  const replyKey = `reply:${tabId}:${nonce}`;

  const command = {
    action: 'get-title',
    args: {},
    replyKey: replyKey
  };

  // Write the command to storage to trigger the content script
  await chrome.storage.local.set({ [commandKey]: command });
  console.log(`Command sent to tab ${tabId} via storage key ${commandKey}`);

  // Listen for the reply
  const onStorageChange = (changes, area) => {
    if (area === 'local' && changes[replyKey]) {
      const reply = changes[replyKey].newValue;
      console.log('Received reply from content script:', reply);
      // Clean up storage
      chrome.storage.local.remove([commandKey, replyKey]);
      chrome.storage.onChanged.removeListener(onStorageChange);
    }
  };
  chrome.storage.onChanged.addListener(onStorageChange);
});
```

**3. `content_solution.js`**
```javascript
console.log('Content script (solution) loaded.');

// We need the tab ID for key matching. Get it via a reliable message.
let myTabId = null;
browser.runtime.sendMessage({ action: 'getTabId' }, response => {
  if (response && response.tabId) {
    myTabId = response.tabId;
    console.log('My tab ID is:', myTabId);
  }
});

// Background script handler for the initial handshake
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getTabId') {
    // This message is only received by the background script, but we need a listener for it.
    // The content script will get its tabId from the sender object in the background.
  }
});

// The main listener for storage-based commands
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !myTabId) return;

  for (const key in changes) {
    if (key.startsWith(`cmd:${myTabId}:`)) {
      const command = changes[key].newValue;
      if (!command) continue; // Command was deleted

      console.log('Received command via storage:', command);

      if (command.action === 'get-title') {
        const result = { title: document.title };
        // Write the result to the specified reply key
        chrome.storage.local.set({ [command.replyKey]: { result } });
      }
    }
  }
});

// Add this to the background script to complete the handshake for the content script to get its tabId
/* In background_solution.js */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getTabId') {
    sendResponse({ tabId: sender.tab.id });
  }
});
```

# Background Script Best Practices

### Checklist for a Robust Safari Background Script

1.  **Use the Correct Manifest Configuration:**
    *   For MV3, use `"background": { "service_worker": "background.js" }`.
    *   For MV2, ensure `"persistent": false` is set for the background script.

2.  **Register All Event Listeners at the Top Level:**
    *   Place all `chrome.*.addListener(...)` calls (e.g., `onInstalled`, `onStartup`, `onAlarm`, `onMessage`) in the global scope of your script. Do not place them inside asynchronous functions or callbacks. This ensures they are registered the moment the worker starts, preventing missed events.

3.  **Persist and Re-create Alarms:**
    *   Alarms may not persist across browser sessions or crashes. On `onInstalled` and `onStartup`, check and re-create all necessary alarms using `chrome.alarms.create()`. Treat a list in `chrome.storage` as the source of truth for which alarms should exist.

4.  **Persist and Rehydrate State:**
    *   Never rely on global variables to maintain state across worker invocations. Use `chrome.storage.local` or `IndexedDB` to store all critical state (e.g., user settings, pending command queues, tab registries).
    *   On worker startup (e.g., at the beginning of an `onAlarm` handler), perform a fast, lightweight rehydration of the essential state needed for the current task.

5.  **Implement a Job Pump Model for Asynchronous Tasks:**
    *   Keep the `onAlarm` handler itself minimal. Its only job should be to enqueue a task into a persistent queue (in `chrome.storage`) and then trigger a processing loop (the 'pump').
    *   The pump runs asynchronously, dequeues tasks, and attempts to execute them. This model allows for centralized management of retries, backoffs, and timeouts for failing API calls.

6.  **Use a Fallback Chain for Tab Interaction:**
    *   Do not assume `tabs.query` or `scripting.executeScript` will work on the first try. Implement a fallback sequence:
        1.  **Attempt 1 (Optimistic):** Call the API directly.
        2.  **Attempt 2 (Retry with Delay):** If the first attempt fails (returns `null`/`[]`/`undefined`), wait for a short period (e.g., 150-300ms) and retry. Use exponential backoff for subsequent retries.
        3.  **Fallback (Storage Bus):** If direct calls continue to fail, write a command to `chrome.storage.local` for the content script to pick up via `storage.onChanged`.
        4.  **Escalation (User Action/Native Host):** For critical failures, notify the user to trigger an action or, if applicable, delegate the task to a native companion app via native messaging.

7.  **Handle High-Frequency Wakes Carefully:**
    *   Avoid scheduling alarms at very high frequencies (e.g., less than every 5-10 seconds). Rapid wakes have been linked to instability and crashes in Safari.
    *   Batch multiple operations into a single alarm event to reduce wake frequency.

### Template for a Robust Background Script (Service Worker)

This template demonstrates the startup process, alarm handling, and a job pump model.

```javascript
// 1. TOP-LEVEL LISTENER REGISTRATION
browser.runtime.onInstalled.addListener(handleInstallOrStartup);
browser.runtime.onStartup?.addListener(handleInstallOrStartup);
browser.alarms.onAlarm.addListener(handleAlarm);

const ALARM_NAME = 'periodic-job-alarm';
const JOB_QUEUE_KEY = 'job_queue';

// 2. ALARM AND STATE INITIALIZATION
async function handleInstallOrStartup() {
  console.log('Worker starting up or installed. Ensuring alarm exists.');
  // Idempotently create the alarm. `create` does nothing if the alarm already exists.
  browser.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  // On startup, immediately try to process any leftover jobs.
  processJobQueue();
}

// 3. MINIMAL ALARM HANDLER (ENQUEUE JOB)
async function handleAlarm(alarm) {
  if (alarm.name === ALARM_NAME) {
    console.log('Alarm triggered. Enqueuing a new job.');
    // Example job: find a specific tab and inject a script
    const job = {
      id: `job-${Date.now()}`,
      type: 'inject-script',
      targetUrl: 'https://example.com/',
      scriptFile: 'tasks/my-task.js',
      attempts: 0
    };
    await enqueueJob(job);
    // Trigger the job pump to process the queue
    processJobQueue();
  }
}

async function enqueueJob(job) {
  const data = await browser.storage.local.get(JOB_QUEUE_KEY);
  const queue = data[JOB_QUEUE_KEY] || [];
  queue.push(job);
  await browser.storage.local.set({ [JOB_QUEUE_KEY]: queue });
}

// 4. JOB PUMP MODEL FOR ASYNCHRONOUS TASKS
let isPumpRunning = false;
async function processJobQueue() {
  if (isPumpRunning) return; // Prevent concurrent runs
  isPumpRunning = true;

  const data = await browser.storage.local.get(JOB_QUEUE_KEY);
  let queue = data[JOB_QUEUE_KEY] || [];

  if (queue.length === 0) {
    isPumpRunning = false;
    return;
  }

  // Process one job from the queue
  const job = queue.shift();

  try {
    const success = await executeJob(job);
    if (!success) {
      // If job failed and can be retried, re-enqueue it
      job.attempts++;
      if (job.attempts < 3) {
        console.warn(`Job ${job.id} failed, re-enqueueing for another attempt.`);
        queue.push(job); // Re-add to the end of the queue
      } else {
        console.error(`Job ${job.id} failed after 3 attempts.`);
      }
    }
  } catch (error) {
    console.error(`Critical error executing job ${job.id}:`, error);
  }

  // Persist the modified queue
  await browser.storage.local.set({ [JOB_QUEUE_KEY]: queue });
  isPumpRunning = false;

  // If there are more jobs, continue processing
  if (queue.length > 0) {
    setTimeout(processJobQueue, 1000); // Process next job after a short delay
  }
}

// 5. JOB EXECUTION WITH RETRIES AND FALLBACKS
async function executeJob(job) {
  console.log(`Executing job: ${job.id}`);
  if (job.type === 'inject-script') {
    // Fallback Chain in action
    // 1. Try to find tab with retries
    let tabs = [];
    for (let i = 0; i < 3; i++) {
      tabs = await browser.tabs.query({ url: job.targetUrl });
      if (tabs && tabs.length > 0) break;
      await new Promise(r => setTimeout(r, 200 * (i + 1)));
    }

    if (!tabs || tabs.length === 0) {
      console.warn(`Could not find tab for URL: ${job.targetUrl}`);
      return false; // Signal failure
    }

    const tabId = tabs[0].id;

    // 2. Try to execute script
    try {
      const results = await browser.scripting.executeScript({
        target: { tabId: tabId },
        files: [job.scriptFile]
      });
      // In Safari, a successful injection might still yield null/empty results.
      // We consider it a success if no error is thrown.
      console.log(`Job ${job.id} executed on tab ${tabId}.`);
      return true; // Signal success
    } catch (e) {
      console.error(`Failed to execute script for job ${job.id} on tab ${tabId}:`, e);
      return false; // Signal failure
    }
  }
  return true;
}
```

# Content Script Best Practices

### Guide to Implementing Resilient Content Scripts in Safari

This guide provides patterns for building content scripts that are resilient to Safari's non-persistent background model.

### 1. Tab Information Registration Pattern

To solve the problem of `tabs.query` failing in the background, content scripts should announce their presence and details to a shared registry in `browser.storage.local`.

**`content-registry.js`**
```javascript
// This script should be part of your content script bundle.

let myTabId = null;
let myFrameId = null;

// On load, get tab/frame info and register it.
async function registerSelf() {
  // Handshake with background to get IDs. Content scripts can't access this directly.
  if (myTabId == null) {
    try {
      const response = await browser.runtime.sendMessage({ action: 'getTabAndFrameId' });
      myTabId = response.tabId;
      myFrameId = response.frameId;
    } catch (e) {
      console.warn('Could not get tab/frame ID. Registration skipped.', e);
      return;
    }
  }

  const isTopFrame = (window.self === window.top);
  const record = {
    tabId: myTabId,
    frameId: myFrameId,
    isTopFrame: isTopFrame,
    url: window.location.href,
    title: document.title,
    lastSeen: Date.now()
  };

  const key = `tab-registry:${myTabId}:${myFrameId}`;
  await browser.storage.local.set({ [key]: record });
  console.log(`Tab registered/updated: ${key}`);
}

// Cleanup the registry entry when the page is unloaded.
async function unregisterSelf() {
  if (!myTabId) return;
  const key = `tab-registry:${myTabId}:${myFrameId}`;
  await browser.storage.local.remove(key);
  console.log(`Tab unregistered: ${key}`);
}

// Run registration on load and when the tab becomes visible.
window.addEventListener('load', registerSelf);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    registerSelf(); // Update the 'lastSeen' timestamp
  }
});

// Attempt to clean up on unload.
window.addEventListener('beforeunload', unregisterSelf);

// The background script needs to respond to the handshake.
// Add this to your background.js:
/*
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getTabAndFrameId') {
    sendResponse({ tabId: sender.tab.id, frameId: sender.frameId });
  }
});
*/
```

### 2. Listening for Commands via the Storage Bus

Instead of relying on `runtime.onMessage`, which can fail if the background is in a transient state, listen for commands written to `browser.storage.local`.

**`content-listener.js`**
```javascript
// This script should be part of your content script bundle.
// Assumes 'myTabId' is available from the registration pattern above.

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || myTabId == null) return;

  for (const key in changes) {
    // Check for commands targeted at this specific tab.
    if (key.startsWith(`cmd:${myTabId}:`)) {
      const command = changes[key].newValue;
      if (!command) continue; // Command was deleted, ignore.

      console.log('Received command via storage:', command);

      try {
        let result;
        // Execute the action based on the command protocol.
        switch (command.action) {
          case 'GET_PAGE_METADATA':
            result = { title: document.title, url: location.href };
            break;
          case 'EXECUTE_IN_PAGE':
            result = await executeInPageContext(command.args.funcStr, command.args.funcArgs, command.nonce);
            break;
          default:
            throw new Error(`Unknown action: ${command.action}`);
        }
        // Acknowledge with result.
        await acknowledgeCommand(command.replyKey, { result: result }, key);
      } catch (error) {
        // Acknowledge with error.
        await acknowledgeCommand(command.replyKey, { error: error.message }, key);
      }
    }
  }
});

async function acknowledgeCommand(replyKey, payload, originalCmdKey) {
  await browser.storage.local.set({ [replyKey]: payload });
  // Clean up the original command key to prevent re-execution.
  await browser.storage.local.remove(originalCmdKey);
}
```

### 3. Executing Code in the Page Context (`MAIN` World)

Content scripts run in an `ISOLATED` world. To access page-level JavaScript variables or functions, you must inject a script into the page's own context.

**`content-exec.js`**
```javascript
// This function is called by the storage listener.
async function executeInPageContext(funcStr, funcArgs, nonce) {
  return new Promise((resolve, reject) => {
    const scriptId = `injected-script-${nonce}`;
    
    // Listen for the result from the page context via postMessage.
    const messageListener = (event) => {
      if (event.source === window && event.data.type === 'EXEC_RESULT' && event.data.nonce === nonce) {
        window.removeEventListener('message', messageListener);
        document.getElementById(scriptId)?.remove();
        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.result);
        }
      }
    };
    window.addEventListener('message', messageListener);

    // Create and inject the script element.
    const script = document.createElement('script');
    script.id = scriptId;
    script.textContent = `
      (async () => {
        try {
          const func = ${funcStr};
          const result = await func(...${JSON.stringify(funcArgs)});
          window.postMessage({ type: 'EXEC_RESULT', nonce: '${nonce}', result: result }, '*');
        } catch (e) {
          window.postMessage({ type: 'EXEC_RESULT', nonce: '${nonce}', error: e.message }, '*');
        }
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
  });
}
```

### 4. Command Acknowledgments and Cleanup

As shown in the `content-listener.js` example, it is critical for the content script to handle both success and error cases by writing a response to the `replyKey` provided in the command. After writing the reply, the content script should remove the original command key from storage. This prevents the command from being accidentally re-processed and signals to the background script that the job is done, allowing it to also clean up the reply key later.

# Safari Version Specific Behaviors

## Safari Version Range

17.0-17.5

## Observed Behavior

This period saw widespread reports of severe service worker lifecycle instability on both macOS and iOS. The most prominent issue was a bug causing background pages to become unresponsive or be terminated after approximately 30 seconds of inactivity. When woken by an alarm, workers in this state would frequently fail API calls, with `tabs.query` returning `[]`, `scripting.executeScript` returning `null`, and `tabs.sendMessage` returning `undefined`. Furthermore, reports indicated that Safari could permanently kill service workers under memory pressure (e.g., ~80% RAM usage), preventing them from recovering on their own, which is a deviation from the expected service worker lifecycle.

## Implication For Developers

Targeting these versions requires highly defensive architectural patterns. Developers cannot rely on the service worker remaining active or re-initializing correctly. The most robust solutions involve offloading state and logic to a native companion app. In-extension solutions must use storage-based message buses (`storage.onChanged`) instead of direct messaging, implement aggressive retry/backoff logic for all tab-related API calls, and maintain a separate tab registry in `browser.storage.local`. Some developers reported temporarily reverting to MV2 non-persistent background scripts as they were sometimes more stable than MV3 service workers on these specific builds.


# Comparison To Chrome And Firefox

The issues of silent API failures from alarm-woken service workers are predominantly specific to Safari's WebKit implementation. In contrast, Chrome and Firefox exhibit more predictable and robust behavior that aligns closely with the WebExtensions specification. Chrome has a well-documented service worker lifecycle where events like alarms reliably wake the worker, and its internal systems ensure that extension APIs are available and ready for use almost immediately. Chrome's 30-second inactivity timer for service workers is generally predictable, and API usage correctly resets it. Similarly, while Firefox has its own implementation nuances for background pages, it does not suffer from the same pattern of `tabs.query`, `executeScript`, and `sendMessage` silently returning empty or null values immediately upon a worker's revival. The absence of these specific race conditions and silent failures in Chromium and Gecko-based browsers strongly indicates that the root cause is not a flaw in the WebExtensions standard itself, but lies within Safari's unique and historically less stable management of service worker processes, their lifecycle, and the timing of their Inter-Process Communication (IPC) channel initialization.

# Security And Privacy Implications

The architectural patterns required for reliable execution in Safari have significant security and privacy considerations. Using a native companion app, as seen in extensions like 1Password and Bitwarden, is the most secure pattern for handling sensitive data. It allows cryptographic operations, secret storage (via the OS keychain), and biometric authentication (Touch ID/Face ID) to occur outside the more exposed browser environment. The extension's background script acts as a mediator, but the secrets themselves do not persist in browser storage or memory.

For patterns relying on `browser.storage`, privacy is a major concern. A storage-backed tab registry could inadvertently create a persistent browsing history accessible to the extension. To mitigate this, developers should practice data minimization: store only origins instead of full URLs, hash identifiers, or implement strict TTLs and garbage collection for all stored data. For private browsing windows, storage should be treated as ephemeral or avoided entirely.

The `storage.onChanged`-based message bus introduces a potential attack surface. If it's used to execute arbitrary JavaScript, it could be vulnerable to injection attacks. Therefore, commands must be rigorously validated and sanitized. A safer approach is to use an allow-list of predefined, named actions rather than executing arbitrary code strings. For autofill functionality, extensions must carefully manage execution contexts. While content scripts run in a secure `ISOLATED` world, they may need to inject code into the `MAIN` world to interact with page scripts. This should be done sparingly and with extreme caution. User gestures or explicit confirmation should always be required before filling credentials to prevent unauthorized data injection or exfiltration.

# Testing And Debugging Strategies

## Strategy Name

Simulate Worker Unloads and Wakes

## Description

This strategy involves manually forcing the non-persistent background script (service worker) to unload and then triggering an event, such as an alarm, to wake it. On macOS, developers can use Safari's Web Inspector by navigating to the `Develop` menu, selecting their extension's name, and then its background page. The inspector allows for observation of logs and can be used to manually reload the worker. The primary test involves setting a short alarm, allowing the extension to become idle so Safari unloads the worker, and then observing the background logs when the alarm fires. This process helps to reproduce the silent API failures. For more systematic testing, developers can use or create a minimal reproducible extension (MRE) that automates this cycle. For severe crash/reload loops, using community-provided reproduction projects from platforms like GitHub is an effective way to validate fixes against known buggy behaviors.

## Relevance To Safari

This strategy is particularly crucial for Safari because its aggressive and sometimes buggy lifecycle management is the root cause of the problem. Unlike other browsers with more predictable service worker behavior, Safari's worker can be terminated unexpectedly or fail to re-initialize correctly. Manually simulating this unload/wake cycle allows developers to directly observe the race conditions and silent API failures (`null`/`undefined` returns) that occur in the brief window after the worker starts. It is the most direct way to reproduce the transient 'not-ready' state of the browser’s internal APIs, enabling developers to test the effectiveness of their retry logic, state rehydration from storage, and other defensive mechanisms.

