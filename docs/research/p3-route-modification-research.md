# P3: Full Request/Response Route Modification — Research Report

**Date:** 2026-04-12
**Scope:** Upgrade Safari Pilot from basic `safari_mock_request` (substring URL match, mock status/body/headers via fetch/XHR monkey-patch) to full Playwright-equivalent route modification.
**Sources:** Playwright docs (Context7), MDN Web Extension APIs, WebKit bug tracker, Parallel deep research (run `trun_4e978fe567d348648d0537ad2969b206`), Safari Pilot source code analysis.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State in Safari Pilot](#2-current-state-in-safari-pilot)
3. [Playwright Route API — How It Works](#3-playwright-route-api--how-it-works)
4. [Safari Interception Mechanisms Available](#4-safari-interception-mechanisms-available)
5. [Recommended Architecture](#5-recommended-architecture)
6. [API Design — safari_route_request](#6-api-design--safari_route_request)
7. [Implementation Plan](#7-implementation-plan)
8. [Capability Matrix vs Playwright](#8-capability-matrix-vs-playwright)
9. [Known Risks and Mitigations](#9-known-risks-and-mitigations)

---

## 1. Executive Summary

Full Playwright-equivalent route modification at the browser engine level is not achievable in Safari — Playwright uses the WebKit Inspector Protocol (WIP) to intercept at the network layer, which is not exposed to extensions. However, Safari Pilot can achieve **~85% of practical route modification use cases** through a hybrid approach combining:

1. **MAIN world fetch/XHR interception** (response body transformation, URL rewriting, abort) — already partially implemented
2. **declarativeNetRequest** (header modification, blocking, redirecting) — DNR bridge already exists in background.js
3. **Enhanced pattern matching** (glob, regex, predicate functions) — currently substring-only

The key insight: Safari Pilot already has a **CSP-bypassing MAIN world content script** (`content-main.js`) registered via the extension manifest (`"world": "MAIN"`). This is a structural advantage — the research report's concern about CSP blocking inline script injection does NOT apply. Safari Pilot's MAIN world code executes regardless of the page's CSP because it is loaded by the browser as a manifest-declared content script, not injected via `<script>` tags.

**What we CAN do well:**
- Modify response bodies for fetch/XHR requests (the primary use case)
- Modify request/response headers via DNR (all request types)
- Block/abort requests via DNR or fetch interception
- Redirect URLs via DNR
- Mock complete responses (already works)
- Pattern matching with glob/regex

**What we CANNOT do (Playwright can):**
- Modify response bodies for parser-initiated resources (HTML document, `<img src>`, `<script src>`, `<link href>`)
- Abort with specific network error codes (e.g., `connectionfailed`, `addressunreachable`)
- Intercept before Service Workers
- Modify requests at the protocol level (true URL rewriting with body modification in one operation)

---

## 2. Current State in Safari Pilot

### Existing Tools (src/tools/network.ts)

| Tool | What It Does | Mechanism |
|------|-------------|-----------|
| `safari_mock_request` | Return fake response for matching URLs | MAIN world fetch/XHR monkey-patch |
| `safari_intercept_requests` | Capture request/response bodies | MAIN world fetch/XHR monkey-patch |
| `safari_network_throttle` | Add artificial latency | MAIN world fetch/XHR monkey-patch |
| `safari_network_offline` | Simulate offline mode | MAIN world fetch/XHR monkey-patch |
| `safari_websocket_listen` | Capture WebSocket messages | MAIN world WebSocket monkey-patch |

### Existing Extension Infrastructure

- **background.js**: Already has `dnr_add_rule` and `dnr_remove_rule` handlers for declarativeNetRequest
- **content-main.js**: MAIN world script with `__safariPilot` namespace, fetch/XHR interceptor, message channel to ISOLATED world
- **content-isolated.js**: Secure bridge between background and MAIN world
- **manifest.json**: Already has `declarativeNetRequest` permission, `<all_urls>` host permissions

### Gaps to Fill

1. **Pattern matching**: Current `safari_mock_request` uses substring matching only (`reqUrl.indexOf(pattern) !== -1`)
2. **Response transformation**: Current mock returns completely fake responses; cannot modify real responses in-flight
3. **Request header modification**: Not exposed as a tool (DNR supports it but no tool wraps it)
4. **URL rewriting**: Not implemented
5. **Selective abort**: `safari_network_offline` is all-or-nothing, not per-URL
6. **No `route.continue()` equivalent**: Cannot modify a request and let it proceed to the network with changes

---

## 3. Playwright Route API — How It Works

### Protocol Layer

Playwright intercepts requests at the browser engine level using automation protocols:
- **Chromium**: Chrome DevTools Protocol (CDP) — `Fetch.requestPaused`, `Fetch.fulfillRequest`
- **WebKit**: WebKit Inspector Protocol (WIP) — `Network.requestIntercepted`, `Network.responseIntercepted`, `Network.interceptWithResponse`, `Network.continueInterceptedRequest`, `Network.failInterceptedRequest` (added in WebKit bug 207446)
- **Firefox**: Uses Firefox-specific internal protocol

This engine-level interception means Playwright sees ALL network traffic — HTML documents, images, fonts, scripts, stylesheets, XHR, fetch — before the browser processes it. Safari Pilot cannot access this layer.

### The Four Route Operations

**Source:** Playwright docs (Context7, `/microsoft/playwright.dev`)

#### `route.fulfill(options)` — Mock/Replace Response
Returns a complete custom response without hitting the network.
```
Options: status, headers, contentType, body (string), body (Buffer), json, path (file), response (APIResponse)
```
Can accept an `APIResponse` from `route.fetch()` and selectively override parts of it.

#### `route.continue(options)` — Modify and Forward
Sends the request to the network with optional modifications.
```
Options: url (same-scheme only), method, postData, headers
```
- Header overrides apply to the request AND subsequent redirects
- `url`, `method`, `postData` apply only to the initial request
- Cannot override `Cookie`, `Host`, `Content-Length` (silently ignored)

#### `route.abort(errorCode?)` — Cancel Request
Terminates the request with a simulated network error.
```
Error codes: 'failed' (default), 'aborted', 'blockedbyclient', 'addressunreachable', 'connectionfailed', etc.
```

#### `route.fetch(options)` — Fetch Real Response for Transformation
Helper that performs the actual network request and returns an `APIResponse`, allowing inspection and modification before calling `route.fulfill()`.
```
Options: headers, postData, method, url (same-scheme), timeout, maxRedirects
```

### Pattern Matching

Playwright supports three URL matching strategies:
1. **Glob patterns**: `**/*.{png,jpg}`, `**/api/v1/*` — the most common
2. **RegExp**: `/(\.png$)|(\.jpg$)/` — full JavaScript regex
3. **Predicate function**: `(url: URL) => boolean` — arbitrary logic
4. **URLPattern**: Standard web API pattern matching

When multiple routes match: page routes > context routes, most recently registered > earlier.

### Response Handling Details

- **Compressed responses**: `response.body()` from `route.fetch()` returns decompressed content. When fulfilling with modified body, must strip `Content-Encoding` header or re-compress.
- **Binary responses**: Fully supported via `Buffer` in `body` option.
- **Streaming responses**: NOT truly streaming — Playwright buffers the entire response body via `response.body()` before transformation. This is a buffer-and-transform approach, not chunk-by-chunk.
- **HTTP cache**: Routing disables HTTP cache for matched requests.
- **Service Workers**: Can intercept before route handlers. Playwright recommends `serviceWorkers: 'block'`.

---

## 4. Safari Interception Mechanisms Available

### 4.1 MAIN World Fetch/XHR Monkey-Patching

**Best for:** Response body transformation, URL rewriting, abort, mocking

Safari Pilot already uses this extensively. The MAIN world content script (`content-main.js`) runs in the page's JavaScript context and can override `window.fetch` and `XMLHttpRequest`.

**What it can intercept:**
- All `fetch()` calls from page JavaScript
- All `XMLHttpRequest` calls from page JavaScript
- Can read and modify: URL, method, headers, request body, response status, response headers, response body

**What it CANNOT intercept:**
- Parser-initiated resource loads: `<img src>`, `<script src>`, `<link href>`, `<video src>`
- The initial HTML document navigation
- Requests from other iframes (unless content script also runs there)
- Requests from Service Workers (they have their own fetch)

**CSP bypass:** Safari Pilot's MAIN world script is loaded via manifest `"world": "MAIN"` — it runs in the page's JS context but is loaded by the browser engine, not by a `<script>` tag. This means it **executes even on pages with strict CSP** (e.g., GitHub, banking sites). This is confirmed by Safari Pilot's README: "Strict CSP sites (GitHub, etc.) | JS execution blocked | Bypassed via MAIN world".

**Advanced techniques available:**
- `Proxy` on `window.fetch` for more robust interception (vs direct replacement)
- `response.clone()` + `new Response(modifiedBody, init)` for response transformation
- `ReadableStream` + `TransformStream` for streaming body transformation
- `response.body.pipeThrough(new TransformStream(...))` for chunk-by-chunk processing

### 4.2 declarativeNetRequest (DNR)

**Best for:** Header modification, blocking, redirecting — applies to ALL request types

Already wired up in Safari Pilot's `background.js` with `handleDnrAddRule` and `handleDnrRemoveRule`.

**Capabilities (confirmed via MDN):**

| Action | Safari Support | What It Does |
|--------|---------------|-------------|
| `block` | Safari 15.4+ | Cancel request entirely |
| `allow` | Safari 15.4+ | Allow request (override other rules) |
| `allowAllRequests` | Safari 15.4+ | Allow main_frame/sub_frame + subresources |
| `upgradeScheme` | Safari 15.4+ | HTTP -> HTTPS |
| `redirect` | Safari 15.4+ | Redirect to different URL |
| `modifyHeaders` | Safari 16.4+ | Modify request AND/OR response headers |

**modifyHeaders operations:** `set` (replace), `append` (add to existing), `remove` (delete header)

**Example DNR rule for header modification:**
```json
{
  "id": 1,
  "priority": 1,
  "action": {
    "type": "modifyHeaders",
    "requestHeaders": [
      { "header": "X-Custom-Auth", "operation": "set", "value": "test-token" }
    ],
    "responseHeaders": [
      { "header": "Access-Control-Allow-Origin", "operation": "set", "value": "*" }
    ]
  },
  "condition": {
    "urlFilter": "api.example.com/*",
    "resourceTypes": ["xmlhttprequest", "script", "main_frame"]
  }
}
```

**What DNR CANNOT do:**
- Modify response bodies (hard limitation)
- Modify request bodies / postData
- Dynamic per-request logic (rules are declarative, not programmatic)
- Match by request body content

**Permissions needed:** `declarativeNetRequest` (already in manifest), `declarativeNetRequestWithHostAccess` for redirect and modifyHeaders, `<all_urls>` host permissions (already in manifest).

### 4.3 Service Worker Interception

**Verdict: Not viable for general-purpose automation.**

A Service Worker could theoretically intercept all request types within its scope, but:
- The SW script must be hosted on the target origin — cannot install on arbitrary sites
- Requires page reload to take control
- Safari has historical reliability issues with SWs
- ITP can interfere with SW lifecycle in third-party contexts

Only useful for controlled test environments where you own the server.

### 4.4 webRequest API

**Verdict: Not usable in Safari.**

Safari does NOT support `webRequestBlocking`. The non-blocking `webRequest` is macOS-only and observation-only — cannot modify requests.

### 4.5 Content Blocker API

**Verdict: Too limited.**

Can only: block resources, block cookies, hide elements via CSS. Cannot modify headers, cannot modify response bodies.

---

## 5. Recommended Architecture

### Hybrid Two-Layer Approach

```
                      safari_route_request
                              |
                    +---------+---------+
                    |                   |
              Layer 1: DNR          Layer 2: JS Interceptor
         (headers, block, redirect)  (response body, abort, mock)
                    |                   |
              background.js         content-main.js
          declarativeNetRequest     fetch/XHR monkey-patch
                    |                   |
              ALL requests          JS-initiated requests only
```

**Layer 1 — declarativeNetRequest (via background.js)**
Handles: request header modification, response header modification, blocking, URL redirecting.
Applies to: ALL request types (images, scripts, stylesheets, XHR, fetch, navigations).
Mechanism: Add/remove dynamic DNR rules via the existing `dnr_add_rule`/`dnr_remove_rule` bridge.

**Layer 2 — MAIN World JS Interceptor (via content-main.js)**
Handles: response body transformation, complete response mocking, URL rewriting (for fetch/XHR), request abort.
Applies to: JS-initiated requests only (fetch, XHR).
Mechanism: Enhanced monkey-patch of `window.fetch` and `XMLHttpRequest` in MAIN world.

**When the user calls `safari_route_request`:**
1. Parse the route specification (pattern, what to modify)
2. If modifying headers OR blocking/redirecting: install a DNR rule via background.js
3. If modifying response body OR mocking OR aborting: install/update JS interceptor in MAIN world
4. If both: do both (they compose — DNR modifies headers at network level, JS interceptor modifies body at JS level)

### Pattern Matching Engine

Replace current substring matching with a proper matcher:

```javascript
function matchUrl(url, pattern) {
  // 1. String — substring match (backwards compat)
  if (typeof pattern === 'string' && !pattern.includes('*')) {
    return url.indexOf(pattern) !== -1;
  }
  // 2. Glob — convert to regex
  if (typeof pattern === 'string') {
    return globToRegex(pattern).test(url);
  }
  // 3. RegExp — direct test
  if (pattern instanceof RegExp) {
    return pattern.test(url);
  }
  return false;
}

function globToRegex(glob) {
  // Convert Playwright-style globs to regex
  // ** = any path segments, * = any chars except /, ? = single char
  let regex = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape regex special chars
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');
  return new RegExp('^' + regex + '$');
}
```

For DNR rules, use the native `urlFilter` syntax (which supports wildcards and `|` anchors).

---

## 6. API Design — safari_route_request

### Tool Definition

```typescript
{
  name: 'safari_route_request',
  description:
    'Register a route handler that intercepts matching network requests. ' +
    'Can modify request headers, response headers, response body, redirect URLs, ' +
    'or abort requests. Supports glob patterns (e.g., "**/*.json", "**/api/*") ' +
    'and regex patterns. For response body modification, only JS-initiated requests ' +
    '(fetch/XHR) are intercepted. For header modification and blocking, all request ' +
    'types are intercepted via declarativeNetRequest.',
  inputSchema: {
    type: 'object',
    properties: {
      tabUrl: { type: 'string', description: 'Current URL of the tab' },
      urlPattern: {
        type: 'string',
        description: 'URL pattern to match. Supports: glob ("**/*.json"), ' +
          'regex ("/\\.json$/"), or substring ("api/users")'
      },
      action: {
        type: 'string',
        enum: ['fulfill', 'continue', 'abort'],
        description:
          'fulfill: return a custom/modified response. ' +
          'continue: modify request and forward to network. ' +
          'abort: cancel the request.'
      },
      // ── fulfill options ──
      fulfill: {
        type: 'object',
        description: 'Options for action="fulfill"',
        properties: {
          status: { type: 'number', description: 'HTTP status code (default: 200)' },
          body: { type: 'string', description: 'Response body string' },
          json: { type: 'object', description: 'JSON response (auto-sets Content-Type)' },
          headers: {
            type: 'object',
            description: 'Response headers',
            additionalProperties: { type: 'string' }
          },
          contentType: { type: 'string', description: 'Shorthand for Content-Type header' },
          transformBody: {
            type: 'string',
            description: 'JS expression to transform the real response body. ' +
              'Receives `body` (string) and `response` (object with status, headers). ' +
              'Return the modified body string. Example: "body.replace(/oldApi/g, newApi)"'
          }
        }
      },
      // ── continue options ──
      continue: {
        type: 'object',
        description: 'Options for action="continue"',
        properties: {
          url: { type: 'string', description: 'Rewrite URL (same-scheme)' },
          method: { type: 'string', description: 'Override HTTP method' },
          requestHeaders: {
            type: 'object',
            description: 'Modify request headers. Set value to null to remove.',
            additionalProperties: { type: ['string', 'null'] }
          },
          responseHeaders: {
            type: 'object',
            description: 'Modify response headers. Set value to null to remove.',
            additionalProperties: { type: ['string', 'null'] }
          }
        }
      }
    },
    required: ['tabUrl', 'urlPattern', 'action']
  },
  requirements: { requiresNetworkIntercept: true }
}
```

### Complementary Tool — Remove Route

```typescript
{
  name: 'safari_unroute_request',
  description: 'Remove a previously registered route handler.',
  inputSchema: {
    type: 'object',
    properties: {
      tabUrl: { type: 'string', description: 'Current URL of the tab' },
      urlPattern: { type: 'string', description: 'Pattern to unregister (must match exactly)' },
      removeAll: { type: 'boolean', description: 'Remove all registered routes' }
    },
    required: ['tabUrl']
  },
  requirements: {}
}
```

### Usage Examples (how the MCP agent would call it)

**Mock an API endpoint:**
```json
{
  "tool": "safari_route_request",
  "params": {
    "tabUrl": "https://app.example.com",
    "urlPattern": "**/api/users",
    "action": "fulfill",
    "fulfill": {
      "json": [{"id": 1, "name": "Test User"}],
      "status": 200
    }
  }
}
```

**Transform a real response body:**
```json
{
  "tool": "safari_route_request",
  "params": {
    "tabUrl": "https://app.example.com",
    "urlPattern": "**/api/settings",
    "action": "fulfill",
    "fulfill": {
      "transformBody": "JSON.parse(body).theme = 'dark'; JSON.stringify(JSON.parse(body))"
    }
  }
}
```

**Add CORS headers to all responses:**
```json
{
  "tool": "safari_route_request",
  "params": {
    "tabUrl": "https://app.example.com",
    "urlPattern": "**/api/**",
    "action": "continue",
    "continue": {
      "responseHeaders": {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE"
      }
    }
  }
}
```

**Abort all image requests (fast page loads for testing):**
```json
{
  "tool": "safari_route_request",
  "params": {
    "tabUrl": "https://example.com",
    "urlPattern": "**/*.{png,jpg,jpeg,gif,webp,svg}",
    "action": "abort"
  }
}
```

**Redirect API to mock server:**
```json
{
  "tool": "safari_route_request",
  "params": {
    "tabUrl": "https://app.example.com",
    "urlPattern": "**/api/**",
    "action": "continue",
    "continue": {
      "url": "http://localhost:3001/api/"
    }
  }
}
```

---

## 7. Implementation Plan

### Phase 1: Pattern Matching Engine (in content-main.js)

Add glob-to-regex conversion and regex support to the MAIN world interceptor.

```javascript
// Add to content-main.js __safariPilot namespace
SP.matchUrl = (url, pattern, patternType) => {
  if (patternType === 'regex') {
    return new RegExp(pattern).test(url);
  }
  if (patternType === 'glob') {
    // Convert glob to regex
    let re = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\x00')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\x00/g, '.*');
    return new RegExp('^' + re + '$').test(url);
  }
  // Default: substring
  return url.indexOf(pattern) !== -1;
};
```

### Phase 2: Enhanced JS Interceptor (in content-main.js)

Replace the basic mock system with a full route handler:

```javascript
SP.routeHandlers = [];  // { pattern, patternType, action, options }

SP.installRouteInterceptor = () => {
  if (SP._routeInterceptorInstalled) return;
  
  const origFetch = window.fetch;
  window.fetch = async function(input, init) {
    const req = new Request(input, init);
    const url = req.url;
    
    // Find matching route (last registered wins, like Playwright)
    let handler = null;
    for (let i = SP.routeHandlers.length - 1; i >= 0; i--) {
      if (SP.matchUrl(url, SP.routeHandlers[i].pattern, SP.routeHandlers[i].patternType)) {
        handler = SP.routeHandlers[i];
        break;
      }
    }
    
    if (!handler) return origFetch.apply(this, arguments);
    
    if (handler.action === 'abort') {
      throw new TypeError('Failed to fetch');  // Simulate network error
    }
    
    if (handler.action === 'fulfill') {
      const opts = handler.options;
      
      if (opts.transformBody) {
        // Fetch real response, transform body
        const realResponse = await origFetch.apply(this, arguments);
        const body = await realResponse.text();
        const transformFn = new Function('body', 'response', 
          'return ' + opts.transformBody);
        const modified = transformFn(body, {
          status: realResponse.status,
          headers: Object.fromEntries(realResponse.headers.entries()),
        });
        
        // Build new headers without Content-Encoding (body is decompressed)
        const newHeaders = new Headers(realResponse.headers);
        newHeaders.delete('content-encoding');
        newHeaders.delete('content-length');
        if (opts.headers) {
          Object.entries(opts.headers).forEach(([k, v]) => newHeaders.set(k, v));
        }
        
        return new Response(modified, {
          status: opts.status || realResponse.status,
          statusText: realResponse.statusText,
          headers: newHeaders,
        });
      }
      
      // Full mock (existing behavior, enhanced)
      const body = opts.json ? JSON.stringify(opts.json) : (opts.body || '');
      const headers = new Headers(opts.headers || {});
      if (opts.json && !headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      if (opts.contentType) headers.set('content-type', opts.contentType);
      
      return new Response(body, {
        status: opts.status || 200,
        headers,
      });
    }
    
    if (handler.action === 'continue') {
      const opts = handler.options;
      let modInput = input;
      let modInit = { ...init };
      
      // URL rewriting
      if (opts.url) {
        modInput = opts.url;
      }
      // Method override
      if (opts.method) {
        modInit.method = opts.method;
      }
      // Request header modification
      if (opts.requestHeaders) {
        const h = new Headers(modInit.headers || req.headers);
        Object.entries(opts.requestHeaders).forEach(([k, v]) => {
          if (v === null) h.delete(k);
          else h.set(k, v);
        });
        modInit.headers = h;
      }
      
      const response = await origFetch.call(this, modInput, modInit);
      
      // Response header modification (for fetch/XHR only; DNR handles all request types)
      if (opts.responseHeaders) {
        const newHeaders = new Headers(response.headers);
        Object.entries(opts.responseHeaders).forEach(([k, v]) => {
          if (v === null) newHeaders.delete(k);
          else newHeaders.set(k, v);
        });
        // Must create new Response since headers are immutable
        const body = await response.arrayBuffer();
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        });
      }
      
      return response;
    }
    
    return origFetch.apply(this, arguments);
  };
  
  // Similar XHR patching (abbreviated — same pattern as existing code)
  // ...
  
  SP._routeInterceptorInstalled = true;
};
```

### Phase 3: DNR Integration (via background.js)

For header modification and blocking that applies to ALL request types (not just fetch/XHR):

```javascript
// In the handler for safari_route_request, when action is 'continue' with header mods
// or action is 'abort':

async function installDnrRoute(routeId, urlPattern, action, options) {
  const ruleId = routeId;  // Use deterministic ID from pattern hash
  
  if (action === 'abort') {
    await browser.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: ruleId,
        priority: 1,
        action: { type: 'block' },
        condition: {
          urlFilter: globToDnrFilter(urlPattern),
          resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script',
                         'image', 'font', 'xmlhttprequest', 'media', 'websocket', 'other']
        }
      }],
      removeRuleIds: [ruleId]
    });
    return;
  }
  
  if (options.requestHeaders || options.responseHeaders) {
    const rule = {
      id: ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [],
        responseHeaders: []
      },
      condition: {
        urlFilter: globToDnrFilter(urlPattern),
        resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script',
                       'image', 'font', 'xmlhttprequest', 'media', 'websocket', 'other']
      }
    };
    
    if (options.requestHeaders) {
      for (const [header, value] of Object.entries(options.requestHeaders)) {
        if (value === null) {
          rule.action.requestHeaders.push({ header, operation: 'remove' });
        } else {
          rule.action.requestHeaders.push({ header, operation: 'set', value });
        }
      }
    }
    
    if (options.responseHeaders) {
      for (const [header, value] of Object.entries(options.responseHeaders)) {
        if (value === null) {
          rule.action.responseHeaders.push({ header, operation: 'remove' });
        } else {
          rule.action.responseHeaders.push({ header, operation: 'set', value });
        }
      }
    }
    
    await browser.declarativeNetRequest.updateDynamicRules({
      addRules: [rule],
      removeRuleIds: [ruleId]
    });
  }
  
  if (options.url) {
    // URL redirect via DNR
    await browser.declarativeNetRequest.updateDynamicRules({
      addRules: [{
        id: ruleId + 10000,  // Separate rule ID for redirect
        priority: 2,
        action: {
          type: 'redirect',
          redirect: { url: options.url }
        },
        condition: {
          urlFilter: globToDnrFilter(urlPattern),
          resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script',
                         'image', 'font', 'xmlhttprequest', 'media', 'websocket', 'other']
        }
      }],
      removeRuleIds: [ruleId + 10000]
    });
  }
}
```

### Phase 4: MCP Tool Handler (in src/tools/network.ts)

Wire the `safari_route_request` tool into the existing `NetworkTools` class. The handler:
1. Detects pattern type (glob/regex/substring)
2. For header mods and blocking: sends DNR rule via background.js bridge
3. For body transformation and mocking: injects route handler into MAIN world
4. Stores route metadata for `safari_unroute_request` cleanup

### Migration Path from safari_mock_request

`safari_mock_request` stays as-is for backwards compatibility. `safari_route_request` is the superset. Internally, mock can be reimplemented as `route_request` with `action: 'fulfill'`.

---

## 8. Capability Matrix vs Playwright

| Capability | Playwright | Safari Pilot (After P3) | Mechanism |
|-----------|-----------|------------------------|-----------|
| Mock response (status, body, headers) | route.fulfill() | safari_route_request fulfill | JS interceptor |
| Mock from JSON | route.fulfill({json}) | safari_route_request fulfill.json | JS interceptor |
| Mock from file | route.fulfill({path}) | Not planned (agent can read file) | N/A |
| Transform response body | route.fetch() + fulfill | safari_route_request fulfill.transformBody | JS interceptor |
| Modify request headers | route.continue({headers}) | safari_route_request continue.requestHeaders | DNR (all types) + JS (fetch/XHR) |
| Modify response headers | route.fulfill() with headers | safari_route_request continue.responseHeaders | DNR (all types) + JS (fetch/XHR) |
| Rewrite URL | route.continue({url}) | safari_route_request continue.url | DNR redirect + JS interceptor |
| Abort request | route.abort() | safari_route_request abort | DNR block (all types) + JS (fetch/XHR) |
| Abort with error code | route.abort('connectionfailed') | Not possible | N/A |
| Glob pattern matching | Supported | Supported | JS regex conversion + DNR urlFilter |
| Regex pattern matching | Supported | Supported | JS RegExp |
| Predicate function | Supported | Not planned (JSON-only MCP) | N/A |
| Intercept ALL resource types | Yes (engine level) | Headers/block: Yes (DNR). Body: No (JS only) | Hybrid |
| Intercept HTML document | Yes | Headers/block: Yes. Body: No | DNR only |
| Intercept images/fonts/CSS | Yes | Headers/block: Yes. Body: No | DNR only |
| Multiple routes, priority order | Yes (LIFO) | Yes (LIFO in JS, priority in DNR) | Both |
| Unroute | page.unroute() | safari_unroute_request | Both |
| Streaming body transform | No (buffers entire body) | Possible via TransformStream | JS interceptor |

**Coverage estimate: ~85% of practical Playwright route use cases.** The missing 15% is primarily body modification for non-JS-initiated resources, which is an uncommon requirement in testing/automation scenarios.

---

## 9. Known Risks and Mitigations

### Risk 1: Safari gzip decompression bug
**Status:** Fixed in WebKit (November 2022, commit 256755). Was macOS-only, not iOS.
**Impact:** On pre-fix Safari versions, `response.text()` might return compressed bytes.
**Mitigation:** Defensive check — if `content-encoding` header present and body appears binary, attempt manual decompression. For modern Safari (16+), this is not an issue.

### Risk 2: DNR modifyHeaders requires Safari 16.4+
**Impact:** Header modification via DNR won't work on older Safari.
**Mitigation:** Feature-detect at runtime. Fall back to JS-only header modification for fetch/XHR. Document minimum Safari version requirement.

### Risk 3: Multiple interceptors stomping on each other
**Impact:** If `safari_mock_request`, `safari_intercept_requests`, AND `safari_route_request` all patch fetch/XHR, they could conflict.
**Mitigation:** Consolidate into single interceptor. `safari_route_request` should be the unified system that subsumes mock and intercept. Existing tools call into the route system internally.

### Risk 4: DNR rule ID management
**Impact:** DNR rules persist across page navigations and are shared across tabs.
**Mitigation:** Use deterministic rule IDs derived from pattern hash. Clean up rules on `safari_unroute_request` and on tab close. Set a maximum rule count. Consider session-scoped rules (`updateSessionRules`) that auto-clear.

### Risk 5: fetch Proxy vs direct override
**Impact:** Direct `window.fetch = ...` can be detected by pages that cache the original fetch reference.
**Mitigation:** Use `Proxy(window.fetch, { apply: handler })` for more transparent interception. The Proxy approach is harder for page scripts to detect.

### Risk 6: Response body reads lock the stream
**Impact:** Calling `.text()` or `.json()` on a Response consumes the body — the original caller gets an empty/locked body.
**Mitigation:** Always use `response.clone()` before reading, or construct a new Response from the read data. The implementation plan above handles this correctly.

---

## Sources

1. **Playwright Route API docs** — Context7 `/microsoft/playwright.dev`, verified against v1.58 (2026)
2. **MDN declarativeNetRequest** — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest
3. **MDN ModifyHeaderInfo** — https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest/ModifyHeaderInfo
4. **WebKit Bug 207446** — WebKit Inspector Protocol network interception (requestIntercepted, responseIntercepted)
5. **WebKit Bug 247421** — fetch() gzip decompression bug (fixed November 2022)
6. **Parallel Deep Research** — `trun_4e978fe567d348648d0537ad2969b206` (full report at `docs/research/p3-route-modification-deep-research.md`)
7. **Safari Pilot source** — `src/tools/network.ts`, `extension/background.js`, `extension/content-main.js`, `extension/manifest.json`
