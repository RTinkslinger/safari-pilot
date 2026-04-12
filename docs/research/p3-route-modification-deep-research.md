# Executive Summary

Achieving full Playwright-equivalent route modification in Safari for general-purpose automation is not feasible using current Web Extension APIs. Playwright leverages low-level automation protocols (like the WebKit Inspector Protocol) to gain complete control over network traffic, allowing arbitrary modification of request/response headers, bodies, and status. In contrast, Safari Web Extensions offer more limited tools. The primary API, `declarativeNetRequest`, supports efficient, rule-based blocking, redirection, and header modification but explicitly lacks the ability to inspect or alter response bodies. The alternative, intercepting requests at the JavaScript level via monkey-patching `fetch`/`XHR` or using a Service Worker, provides a path to body modification but is constrained by the Same-Origin Policy, Content Security Policy (CSP), and is generally limited to requests initiated by JavaScript or within the scope of a first-party Service Worker. Therefore, a complete solution for arbitrary sites remains out of reach, and any attempt must rely on a complex, hybrid approach with significant capability gaps, particularly in modifying parser-initiated, cross-origin resources.

# Playwright Route Api Internals

Playwright's `page.route()` and `context.route()` APIs provide powerful, engine-level network interception by communicating directly with the browser's debugging protocols. The specific protocol varies by browser engine. For Chromium-based browsers, Playwright utilizes the Chrome DevTools Protocol (CDP). Playwright even exposes a method, `browserContext.newCDPSession`, specifically for Chromium to allow direct CDP communication. For WebKit (the engine behind Safari), Playwright uses the WebKit Inspector Protocol (WIP). The necessary capabilities for network interception were added to WIP, as detailed in WebKit bug 207446, which introduced events like `requestIntercepted` and `responseIntercepted`, and commands such as `continueInterceptedRequest`, `interceptWithResponse`, and `failInterceptedRequest`. This allows Playwright to intercept a request, provide a custom response without a network call, or modify it before continuing. When routing is enabled for a URL, Playwright disables the browser's HTTP cache for matching requests to ensure the handler is always executed. It's also important to note that service workers can intercept requests before Playwright's routing handler. Therefore, Playwright's documentation recommends disabling service workers (`serviceWorkers: 'block'`) for reliable network modification.

# Playwright Route Modification Capabilities

## Route Fulfill

The `route.fulfill()` method is used to complete an intercepted request with a custom or modified response, effectively mocking the server's reply. It offers a wide range of options to construct the response, including setting the `status` code, `headers`, and `contentType`. The response body can be provided directly as a string or a `Buffer` for binary data (`body`), as a JSON object (`json`), or by pointing to a local file (`path`). A particularly powerful feature is its ability to accept an `APIResponse` object, typically obtained from `route.fetch()`, and then selectively override parts of it, such as its body or headers. This is the primary mechanism for modifying a live response from the network.

## Route Continue

The `route.continue()` method allows an intercepted request to proceed to the network, but with potential modifications. It supports optional overrides for the request's `url` (URL rewriting, though same-scheme only unless using `route.fetch`), `method` (e.g., changing GET to POST), `postData`, and `headers`. It's important to note that header overrides apply to the original request and any subsequent redirects, while `url`, `method`, and `postData` overrides only apply to the initial request. Playwright forbids overriding certain sensitive request headers like `Cookie`, `Host`, and `Content-Length`; any attempts to modify them are ignored. For cookie manipulation, `context.addCookies` should be used instead. Playwright also offers `route.fallback()`, which functions similarly but passes the (potentially modified) request to the next matching route handler in the chain, rather than directly to the network.

## Route Abort

The `route.abort()` method terminates an intercepted request, preventing it from reaching the network or returning a response to the page. It simulates a network failure. The method accepts an optional `errorCode` string to specify the reason for the failure. If no code is provided, it defaults to `'failed'`. Other possible error codes include `'aborted'`, `'blockedbyclient'`, `'addressunreachable'`, and `'connectionfailed'`, allowing for the simulation of various network error conditions.

## Route Fetch

The `route.fetch()` method is a helper designed specifically for the use case of modifying a live network response. Instead of fulfilling or aborting the route directly, it performs the actual network request under interception and returns the resulting `APIResponse` object to the handler. This allows the script to inspect the real response (its status, headers, and body) and then use that information to construct a modified response with `route.fulfill()`. The `route.fetch()` call itself can also modify the outgoing request by accepting options to change `headers`, `postData`, `method`, `url` (same protocol), `timeout`, and `maxRedirects`.


# Playwright Pattern Matching And Response Handling

## Url Matching Methods

Playwright's routing API provides flexible mechanisms for matching request URLs. Handlers can be registered using glob patterns, such as `**/*.js` to catch all JavaScript files or `**/api/v1/*` for specific API endpoints. For more complex matching, it supports standard JavaScript `RegExp` (regular expressions). Additionally, it can accept a predicate function which receives the `URL` object of the request and must return a boolean value, allowing for arbitrary custom logic to decide if a request should be intercepted. The `context.route` method also supports the `URLPattern` standard. When multiple routes match a request, page-specific routes (`page.route()`) take precedence over browser context-wide routes (`context.route()`).

## Streaming Response Handling

Playwright does not expose a direct API for transforming streaming responses chunk-by-chunk in-flight within a route handler. Instead, it materializes the response body when methods like `response.body()`, `response.text()`, or `response.json()` are called. The typical workflow for modifying a streaming response is to first use `route.fetch()` to get the `APIResponse`, then await `response.body()` to get the entire response content as a `Buffer`. After transforming this buffered data, the handler then calls `route.fulfill()` with the new, modified body. This is a buffer-and-transform approach, which may have memory implications for very large responses, rather than a true streaming transformation.

## Compressed Response Handling

Playwright's handling of compressed responses (e.g., `Content-Encoding: gzip` or `br`) requires careful attention. When a handler receives an `APIResponse` object (from `route.fetch()`), the `response.body()` method automatically returns the *decompressed* response body as a `Buffer`. A common pitfall is to then fulfill the route using the original response object while also providing a modified body, or simply passing the original response object through directly (`route.fulfill({ response })`). This can lead to a mismatch where the `content-encoding` header from the original response is preserved, but the body being sent is uncompressed, causing the browser to fail parsing it. As discussed in a Playwright GitHub issue (39292), developers must either manually strip the `content-encoding` header before fulfilling or re-compress the modified body to match the header.

## Binary Response Handling

Binary response bodies, such as images, fonts, or file downloads, are fully supported by the routing API. When fulfilling a request with `route.fulfill()`, binary content can be provided as a Node.js `Buffer` to the `body` option. Similarly, when inspecting a response via `route.fetch()`, the `response.body()` method returns a `Buffer` containing the raw binary data of the response body, which can then be manipulated before being used in a subsequent `route.fulfill()` call.


# Safari Declarative Net Request Analysis

## Can Block Requests

True

## Can Redirect Requests

True

## Can Modify Headers

True

## Can Modify Response Body

False

## Rule Limitations

The declarativeNetRequest (DNR) API in Safari cannot modify response bodies. To use the API, an extension must request the `declarativeNetRequest` permission in its manifest. For actions like `redirect` (supported in Safari 15.4+) and `modifyHeaders` (supported in Safari 16.4+), the extension requires the `declarativeNetRequestWithHostAccess` permission and explicit host permissions for both the source and destination sites. Supported rule actions include `block`, `allow`, `upgradeScheme`, and `allowAllRequests`. The rules can be applied to various resource types such as `main_frame`, `sub_frame`, `stylesheet`, `script`, `image`, `font`, `xmlhttprequest`, `ping`, `media`, `websocket`, and `other`. Safari also provides APIs to dynamically enable or disable rulesets and manage session-specific rules.


# Safari Webrequest Api Support

## Is Blocking Supported

False

## Is Response Modification Supported

False

## Availability Status

Not supported. Apple's compatibility documentation explicitly states that `permissions.webRequestBlocking` is not supported. While a non-blocking `webRequest` permission exists for observation, it is limited to macOS only and does not allow for request modification. Blocking requests via this API is not supported on iOS.

## Comparison To Chrome Firefox

Unlike Chrome and Firefox, which offer robust support for the blocking version of the `webRequest` API, allowing extensions to intercept, block, redirect, and modify requests and headers in-flight, Safari's support is severely limited. Safari does not support blocking `webRequest` at all, pushing developers towards the `declarativeNetRequest` API for blocking, redirecting, and header modification tasks. This represents a significant divergence in extension capabilities, as Safari extensions lack the programmatic, on-the-fly request interception power that `webRequest` provides in other browsers.


# Safari Content Blocker Api Capabilities

Safari's Content Blocker API is a highly performant but limited system for blocking web content. It functions by having the extension provide a set of rules in a JSON file. Safari compiles these rules into an efficient, native bytecode format, which allows the browser's network subsystem to evaluate them with minimal latency, without waiting for the extension to respond. The capabilities are strictly defined by the available rule actions, which include `block` (to prevent a resource from loading), `block-cookies` (to strip cookies from a request before it is sent), and `css-display-none` (to provide a CSS selector for hiding elements on the page). While it can prevent resources from loading and hide elements from view, its primary limitation is that it cannot perform arbitrary modifications. Specifically, the Content Blocker API cannot modify response bodies, nor can it arbitrarily add, remove, or change request or response headers beyond the specific actions provided (e.g., `block-cookies`). It is a declarative system focused on blocking and hiding, not transformation.

# Javascript Fetch Xhr Interception Patterns

Advanced interception of `window.fetch` and `XMLHttpRequest` in the main world requires overriding the global objects to insert custom logic. 

**Fetch API Interception:**
A robust method for intercepting `fetch` is to use a JavaScript `Proxy` on `window.fetch`. This allows for transparently trapping calls to the function. The interception logic typically involves:
1.  Capturing the `input` (URL or Request object) and `init` (options) arguments.
2.  If the request needs modification (e.g., changing headers or body), a new `Request` object must be constructed, as the original may be immutable: `new Request(input, overrideOptions)`. 
3.  The original `fetch` is then called with the (potentially modified) request.
4.  To modify the response, the interceptor must `await` the promise returned by the real `fetch` call. Since `Response` objects are immutable and their bodies can only be read once, the response must be cloned using `response.clone()` before its body is accessed.
5.  The body can be read using methods like `response.text()`, `response.json()`, or `response.arrayBuffer()`. After transforming the body content, a `new Response(modifiedBody, initOptions)` is created and returned to the original caller. The `initOptions` can be derived from the original response to preserve status, headers, etc., but headers like `Content-Encoding` and `Content-Length` may need to be removed or recalculated.

**XMLHttpRequest (XHR) Interception:**
Monkey-patching XHR is more complex as it's a stateful object. The approach involves overriding methods on `XMLHttpRequest.prototype`:
*   `open()`: Capture the `method` and `url`.
*   `setRequestHeader()`: Capture request headers.
*   `send()`: Capture the request body. This is the point where the actual network request could be initiated by a wrapped instance of the original XHR.
*   Wrappers must be placed around event handlers like `onreadystatechange` and `onload` to intercept the response. The `responseText` and `response` properties can be overridden with getters to return modified data after the request completes. Careful implementation is needed to correctly handle `responseType`, `binaryTypes`, synchronous requests, and to forward progress events.

**Edge Cases and Object Handling:**
*   **ReadableStream Responses:** When a response body is a stream, it can be consumed only once. To modify it, you can use `response.body.pipeThrough(new TransformStream(...))` to apply transformations on the fly and return a `new Response` with the new stream. Alternatively, the stream can be cloned using `response.body.tee()`, which creates two new streams. One can be used for modification, and the other can be passed along if needed. The `bodyUsed` flag on the original response will be `true` after reading, so cloning is essential.
*   **FormData, Blob, ArrayBuffer Bodies:** When constructing a new `Request` with these body types, the browser typically handles setting the correct `Content-Length`. For `FormData`, it's best to let the browser set the `Content-Type` header to ensure the multipart boundary is correctly generated.

**Service Worker Interception:**
A powerful alternative to monkey-patching is using a Service Worker. A script injected into the page can register a Service Worker (`navigator.serviceWorker.register()`) for that page's origin. The Service Worker can then listen for the `fetch` event, which intercepts both navigation and subresource requests within its scope. Using `event.respondWith()`, the Service Worker can return a completely custom `Response`, including one created by fetching the original resource, transforming its body, and then returning the modified version. This approach is subject to same-origin policies and requires the page to be reloaded once for the Service Worker to take control.

# Response Body Transformation Techniques Js

Intercepting and modifying response bodies in-flight with JavaScript requires handling the immutability of `Response` objects and the single-use nature of their bodies. The general strategy is to intercept the response, read and transform its body, and then construct a new, modified `Response` to pass back to the page's code.

**Buffering Strategy (for smaller responses):**
This approach involves reading the entire response body into memory, modifying it, and then creating a new response.
1.  **Intercept and Clone:** After receiving the original `Response` object from a `fetch` call, immediately clone it using `response.clone()`. This is crucial because reading the body of a response (e.g., with `.text()` or `.json()`) locks the stream, preventing it from being read again.
2.  **Read and Transform:** Use an appropriate method to read the body from the cloned response, such as `await clone.text()` for text-based content or `await clone.arrayBuffer()` for binary data.
3.  **Create New Response:** Once the body content is in a variable, it can be modified (e.g., string replacement, JSON manipulation, byte-level changes). A `new Response()` is then created, passing the modified body and an options object. The options should be based on the original response to preserve properties like `status`, `statusText`, and most headers. Headers that depend on the content, such as `Content-Length` and `Content-Encoding`, must be adjusted. It's safest to omit `Content-Encoding` unless you have re-compressed the body, and to let the browser calculate `Content-Length` for the new body.

**Streaming Strategy (for large responses):**
To avoid high memory usage from buffering large files, a streaming approach is preferable.
1.  **Access the Stream:** The body of a `Response` object is a `ReadableStream`, accessible via `response.body`.
2.  **Transform the Stream:** This `ReadableStream` can be piped through a `TransformStream`. The `TransformStream`'s logic can process the data in chunks as it arrives. For text, this might involve using `TextDecoderStream` to decode the chunks, a custom transform to modify the text, and `TextEncoderStream` to re-encode it. For binary data, transformations can be applied directly to the `Uint8Array` chunks.
3.  **Create New Streaming Response:** A `new Response()` is created with the output stream of the transformation pipeline as its body. This allows the browser to render the page or process the data as it's being downloaded and transformed, without waiting for the entire response to be buffered.

**Managing Immutability:**
The key takeaway is that you cannot modify a `Response` object or its body directly. The pattern is always to **read** from a clone of the original and **construct** a new `Response` with the desired modifications. When using streams, methods like `response.body.tee()` can be used to split a stream into two, allowing one to be consumed for transformation while the other could potentially be passed elsewhere, though creating a new response with the transformed stream is the most common use case.

# Handling Compressed And Binary Responses

Handling compressed and binary response bodies during interception requires understanding how browsers expose this data to JavaScript.

**Compressed Responses (Content-Encoding: gzip, br, deflate):**
The standard behavior for browsers, as implemented in Chrome and Firefox, is to automatically decompress the response body before making it available to JavaScript via the Fetch API. When you call `response.text()` or `response.arrayBuffer()`, you receive the decompressed content, even if the server sent it with a `Content-Encoding` header like `gzip` or `br`. The `response.headers` object will still report the original `Content-Encoding` header sent by the server.

**Implications for Modification:**
Because the body you access is decompressed, if you modify it and create a `new Response`, you must not include the original `Content-Encoding` header. Doing so would cause a mismatch, as you would be serving an uncompressed body while claiming it is compressed. The correct approach is to omit the `Content-Encoding` header from the new response, allowing the browser to handle the content as uncompressed. Alternatively, you could re-compress the modified body using the `CompressionStream` API and set the `Content-Encoding` header accordingly, but this adds complexity.

**Safari-Specific Caveat:**
There is a known history of bugs in WebKit/Safari where this behavior was inconsistent. For example, WebKit bug 247421 reported that `fetch()` in Safari was exposing the raw, compressed body to JavaScript when `Content-Encoding: gzip` was present. Therefore, when writing interception code for Safari, it is prudent to be defensive. The code could check for the presence of a `Content-Encoding` header and, if found, potentially sniff the body to see if it appears compressed. If it is compressed, it would need to be decompressed manually (e.g., with `CompressionStream` or a WASM library) before transformation.

**Binary Response Modification:**
For binary data like images, fonts, or WASM files, the process is similar to the buffered strategy for text:
1.  Read the response body into an `ArrayBuffer` using `await response.arrayBuffer()`.
2.  Manipulate the bytes, for example by creating a `Uint8Array` view of the buffer.
3.  Create a `new Response(modifiedBuffer, { headers })` with the modified `ArrayBuffer` or a `Blob` created from it.

**TextDecoder and TextEncoder:**
When you need to treat binary data as text with a specific character set, `TextDecoder` and `TextEncoder` are essential. For example, if you receive a binary stream that you know is UTF-8 text, you can use a `TextDecoderStream` to convert the chunks to strings for modification, and then a `TextEncoderStream` to convert them back to `Uint8Array` chunks for the new response body.

# Service Worker Interception Feasibility

A Safari Web Extension can technically register a Service Worker, but with significant constraints. A content script injected by the extension can execute `navigator.serviceWorker.register('/sw.js', { scope: '/' })` within the page's context. However, this is subject to the same-origin policy and the page's Content Security Policy (CSP). The Service Worker script itself (e.g., `sw.js`) must be hosted on and served from the target website's origin, within the specified scope. This means an extension cannot register a Service Worker that intercepts requests for arbitrary third-party origins, as it cannot host the necessary script file on those origins. This approach is only feasible for first-party pages where the developer has control over the web server to place the Service Worker script. For general-purpose automation across any site, this method is not viable.

# Service Worker Api Capabilities And Limitations

The Service Worker `FetchEvent` API provides powerful network interception capabilities. When a fetch event is triggered for a request within the Service Worker's scope (which can include both navigation and subresource requests), the `event.respondWith()` method can be used to take control and provide a custom `Response`. This allows for complete modification of the response, including its status, headers, and body. It fully supports creating new responses from scratch or modifying fetched responses. The API is compatible with streaming, enabling the transformation of large response bodies in-flight by using `ReadableStream` and `TransformStream` without buffering the entire content in memory. 

However, there are notable limitations in Safari. Firstly, there is a performance overhead as all in-scope requests are routed through the Service Worker's JavaScript thread. Secondly, a Service Worker does not intercept requests on the very first page load; it must be registered and installed first, and it only takes control of the page upon the next navigation or reload. Furthermore, Safari's support for Service Workers has historically lagged behind other browsers, with some versions on both macOS and iOS exhibiting reduced reliability, bugs, or limitations in background processing and developer tools. Finally, features like Intelligent Tracking Prevention (ITP) and partitioned storage can affect the lifecycle and storage access of Service Workers, particularly those registered in the context of third-party iframes.

# Safari Specific Constraints Overview

Several Safari-specific constraints significantly impact network interception strategies. 

1.  **Intelligent Tracking Prevention (ITP):** ITP aggressively limits cross-site tracking by partitioning storage and restricting cookie access for third-party contexts. This can interfere with interception techniques that rely on cookies or storage for state management across different sites and can affect the lifecycle and capabilities of Service Workers registered in third-party iframes.

2.  **Cross-Origin Modification Rules:** Safari Web Extensions face strict limitations on modifying cross-origin requests. Content scripts run in an isolated world and cannot directly access or modify the response bodies of cross-origin resources. The primary network interception API, `declarativeNetRequest`, allows for blocking, redirecting, and modifying headers of requests, but it explicitly does not provide any mechanism for modifying response bodies.

3.  **Content Security Policy (CSP) Enforcement:** While extension content scripts run in an isolated world that is separate from the page's JavaScript context, any attempt to inject a script directly into the main world (e.g., by adding a `<script>` tag to the DOM) is subject to the page's CSP. A strict CSP can block this injection, preventing monkey-patching of `fetch` or `XHR` in the main world. To intercept the page's own API calls, code must run in the main world, creating a conflict with CSP that is a major hurdle.

4.  **Content Script World Isolation:** Content scripts operate in an 'isolated world' by default. This prevents conflicts with the page's own JavaScript but also means that patching `window.fetch` in the isolated world does not affect the `window.fetch` used by the page's scripts. To intercept the page's own calls, the interception logic must be executed in the 'main world', which, as noted, can be blocked by CSP.

# Safari Content Script World Isolation

Safari Web Extensions, like those in Chrome, execute content scripts in an 'isolated world' by default. This is a separate JavaScript execution context from the web page's own 'main world'.

**Concept of Isolated Worlds:**
The primary purpose of world isolation is to prevent conflicts and enhance security. A content script running in an isolated world has its own global object (`window`), separate from the page's `window`. This means that JavaScript variables, functions, and prototypes defined by the content script do not clash with or overwrite those defined by the web page, and vice versa. For example, if both the page and the content script use a library like jQuery, they will be separate instances that do not interfere with each other.

**Critical Implications for Monkey-Patching:**
This isolation has a critical and direct impact on attempts to intercept network requests by monkey-patching global objects. 
*   If a content script running in the **isolated world** modifies `window.fetch` or `XMLHttpRequest.prototype`, it is only patching the versions of those objects that exist within its own isolated context.
*   Any `fetch` or `XHR` calls made by the web page's own scripts, which execute in the **main world**, will use the original, un-patched global objects.
*   Therefore, **monkey-patching from a default content script will not intercept the web page's network requests.**

**Solution and Associated Challenge:**
To successfully intercept `fetch` or `XHR` calls initiated by the page's JavaScript, the monkey-patching code **must** be executed in the main world. The standard technique to achieve this from a web extension is for the content script (running in the isolated world) to inject a `<script>` tag into the page's DOM. The JavaScript code contained within or referenced by this injected script tag will then execute in the context of the main world, allowing it to successfully patch the page's `window.fetch`.

**Content Security Policy (CSP) Limitation:**
The major drawback of this script injection technique is that it is subject to the web page's Content Security Policy (CSP). If the page has a strict CSP, such as `script-src 'self'`, it will block the execution of inline scripts or scripts from non-whitelisted origins. This can render the main-world injection method ineffective, preventing the interception from being installed. This makes robust, universal network interception via monkey-patching in Safari extensions challenging.

# Known Bugs And Api Limitations In Safari

## Fetch Content Encoding Bug

There is a known issue, documented in WebKit bug #247421, where Safari's `fetch()` API may not automatically decompress response bodies that have a `Content-Encoding` header (e.g., `gzip`, `br`). While other browsers consistently provide a decompressed body to the JavaScript `Response` object, Safari has been reported to sometimes expose the raw, compressed byte stream. This requires any interception logic to be defensive: it must check the `content-encoding` header and potentially handle decompression manually using APIs like `CompressionStream` or a WASM-based library if the body appears to be compressed.

## Readable Stream Support Status

Safari and WebKit support the `ReadableStream` API, which is essential for modern fetch handling and streaming response transformations. However, its reliability can be affected by other platform bugs. For instance, the `fetch_content_encoding_bug` directly impacts stream processing, as a stream that is expected to contain decoded text or data might instead contain a compressed byte stream, which would break transformation logic unless explicitly handled.

## Service Worker Limitations

Service Workers in Safari have several specific limitations. Support and reliability can vary across different Safari and iOS versions, with some having known bugs. There is a performance cost, as requests are funneled through the SW's JavaScript thread. A key operational limit is that a Service Worker only gains control of a page after it has been installed and the page is reloaded, meaning it cannot intercept the initial navigation. Furthermore, their lifecycle and storage access can be constrained by Intelligent Tracking Prevention (ITP), especially in third-party contexts.

## Web Extension Api Gaps

Safari's Web Extension API has significant gaps compared to Chrome and Firefox, primarily concerning network request modification. The most critical missing feature is an API to modify response bodies. The `webRequestBlocking` permission is not supported, meaning extensions cannot synchronously block and modify requests in flight as they can in other browsers. While the `declarativeNetRequest` API allows for efficient blocking, redirection, and (in recent versions) header modification, it offers no path for altering response content. The non-blocking `webRequest` API is available only on macOS and cannot be used to modify responses.


# Comparative Analysis Of Interception Methods

## Method Name

Safari Web Extension declarativeNetRequest (DNR)

## Request Modification Capability

Limited. Can block requests, upgrade scheme to HTTPS, and redirect URLs (requires Safari 15.4+). Can modify request headers (requires Safari 16.4+). It cannot modify request bodies (`postData`). All modifications are rule-based and declared in the manifest or added dynamically. Redirects and header modifications require the `declarativeNetRequestWithHostAccess` permission and explicit host permissions.

## Response Modification Capability

Very limited. Can modify response headers (requires Safari 16.4+). It cannot modify the response status code or, most critically, the response body. The blocking `webRequest` API, which allows for more dynamic modification in other browsers, is not supported in Safari.

## Safari Support Level

High, as it is the Apple-recommended API. However, key features like `redirect` and `modifyHeaders` are only available in recent versions of Safari (15.4+ and 16.4+, respectively). The non-blocking `webRequest` API has limited support on macOS only and is not available on iOS.

## Primary Use Case

Efficient, privacy-preserving content blocking and simple request modifications. It is designed to apply a declarative set of rules to network requests with minimal performance overhead, making it ideal for ad blockers and security tools that need to block, redirect, or strip headers without executing arbitrary JavaScript for every request.


# Recommended Strategy For Safari

## Primary Approach

For sites where you control the origin, the primary approach should be to use a Service Worker. A Service Worker, registered from a content script, can intercept network requests within its scope via the `fetch` event and use `event.respondWith()` to provide a completely modified response. This allows for rewriting headers, status, and body, including streaming transformations, making it the closest available method to Playwright's `route.fulfill` capability.

## Supporting Techniques

For automating arbitrary third-party sites where a Service Worker cannot be installed, a hybrid strategy is necessary. 
1. **declarativeNetRequest (DNR):** Use DNR for all network-level modifications that it supports: blocking requests, redirecting URLs, and modifying request/response headers. This is the most performant and reliable method for these specific tasks.
2. **JavaScript Interception:** Inject a content script into the page's MAIN world to monkey-patch `window.fetch` and `XMLHttpRequest`. This allows the interception of JavaScript-initiated requests, enabling the modification of response bodies before they are processed by the page's scripts. This involves cloning the response, transforming the body (e.g., using `response.text()` and creating a `new Response()`), and carefully managing headers like `Content-Encoding`.

## Key Challenges

The most significant challenges are:
1. **No Native Response Body Modification:** Safari's extension APIs provide no direct way to modify response bodies. The JS interception workaround only captures JS-initiated requests, failing to intercept parser-initiated resources like the initial HTML document, images in `<img>` tags, or scripts in `<script>` tags.
2. **Content Security Policy (CSP):** A page's CSP can block the injection of the inline scripts required to perform monkey-patching in the MAIN world, rendering the strategy ineffective.
3. **Cross-Origin Restrictions:** JS-level interception is subject to the Same-Origin Policy, preventing access to the bodies of cross-origin responses.
4. **Service Worker Logistics:** Service Workers require an initial page load to install and a subsequent reload to gain control, and their scope is limited to their origin, making them unsuitable for general-purpose, multi-site automation.

## Remaining Capability Gaps

Compared to a Playwright-equivalent solution, this strategy will still have major gaps:
1. **Inability to Modify All Resources:** There is no reliable way to modify the response body of parser-initiated, cross-origin resources (e.g., images, fonts, ad scripts from a CDN).
2. **No True URL Rewriting for Body Modification:** While DNR can redirect, you cannot dynamically rewrite a URL and then also modify the body of the response from the new URL at the network layer.
3. **Lack of Engine-Level Control:** The solution does not operate at the browser engine's network subsystem level like Playwright. It is subject to page-level constraints (CSP, SOP) and cannot intercept traffic with the same reliability or completeness.
4. **No Simple Abort with Error Code:** While requests can be aborted, mimicking Playwright's `route.abort()` with specific network error codes (e.g., `connectionfailed`) is not possible through these APIs.

