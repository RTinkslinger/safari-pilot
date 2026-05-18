import type { IEngine } from '../engines/engine.js';
import { wrapEngineError } from '../errors.js';
import { escapeForJsSingleQuote, escapeForTemplateLiteral } from '../escape.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';
import { entriesToHar, harToMockRules, type HarLog, type HarToMockOptions, type InterceptEntry } from './har.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class NetworkTools {
  private engine: IEngine;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: IEngine) {
    this.engine = engine;
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.handlers.set('safari_list_network_requests', this.handleListNetworkRequests.bind(this));
    this.handlers.set('safari_get_network_request', this.handleGetNetworkRequest.bind(this));
    this.handlers.set('safari_intercept_requests', this.handleInterceptRequests.bind(this));
    this.handlers.set('safari_network_throttle', this.handleNetworkThrottle.bind(this));
    this.handlers.set('safari_network_offline', this.handleNetworkOffline.bind(this));
    this.handlers.set('safari_mock_request', this.handleMockRequest.bind(this));
    this.handlers.set('safari_websocket_listen', this.handleWebSocketListen.bind(this));
    this.handlers.set('safari_websocket_filter', this.handleWebSocketFilter.bind(this));
    this.handlers.set('safari_dump_har', this.handleDumpHar.bind(this));
    this.handlers.set('safari_route_from_har', this.handleRouteFromHar.bind(this));
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_list_network_requests',
        description:
          'List all network requests captured for a tab since enable. Use when verifying an XHR/fetch fired, checking request headers, or correlating UI events with backend calls.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            filter: {
              type: 'object',
              description: 'Optional filter criteria',
              properties: {
                type: {
                  type: 'string',
                  enum: ['fetch', 'xmlhttprequest', 'script', 'stylesheet', 'img', 'other'],
                  description: 'Filter by resource type',
                },
                status: { type: 'number', description: 'Filter by HTTP status code' },
                urlPattern: { type: 'string', description: 'Filter by URL substring match' },
              },
            },
            limit: { type: 'number', description: 'Maximum requests to return', default: 100 },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_get_network_request',
        description:
          'Read a single network request by URL with full request/response detail. Use after safari_list_network_requests narrows down the target.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            url: { type: 'string', description: 'The request URL to look up (exact match or substring)' },
            matchMode: {
              type: 'string',
              enum: ['exact', 'contains', 'endsWith'],
              description: 'How to match the URL',
              default: 'contains',
            },
          },
          required: ['tabUrl', 'url'],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_intercept_requests',
        description:
          'Install a fetch/XHR interceptor in the page to capture request and response bodies. ' +
          'The interceptor monkey-patches window.fetch and XMLHttpRequest. ' +
          'Captured data is stored in window.__safariPilotNetwork and retrievable with safari_list_network_requests. ' +
          'Note: only captures JS-initiated requests (not navigations, images, etc.). ' +
          'Full declarativeNetRequest interception is available in Phase 3 (extension engine).',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            urlPattern: {
              type: 'string',
              description: 'Only capture requests whose URL matches this substring. Omit to capture all.',
            },
            captureBody: {
              type: 'boolean',
              description: 'Capture request and response bodies (may be large)',
              default: false,
            },
            maxEntries: {
              type: 'number',
              description: 'Maximum intercepted entries to store in the buffer',
              default: 200,
            },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_network_throttle',
        description:
          'Throttle the tab to a named profile (Slow3G, Fast3G, etc) or custom bandwidth. Use when testing slow-network UX or reproducing latency-dependent bugs.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            latencyMs: {
              type: 'number',
              description: 'Artificial latency to add per request in milliseconds. Set to 0 to disable.',
            },
            downloadKbps: {
              type: 'number',
              description: 'Simulated download speed in kilobytes per second (optional). Omit for latency-only.',
            },
          },
          required: ['tabUrl', 'latencyMs'],
        },
        requirements: { idempotent: false, requiresNetworkIntercept: true },
      },
      {
        name: 'safari_network_offline',
        description:
          'Toggle offline mode for the tab. Use when testing offline UI, retry logic, or service-worker caching behavior.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            offline: { type: 'boolean', description: 'true to go offline, false to restore connectivity' },
          },
          required: ['tabUrl', 'offline'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_mock_request',
        description:
          'Mock a specific URL\'s response so that any fetch or XHR to a matching URL returns the provided ' +
          'status, body, and headers instead of making a real network request. ' +
          'urlPattern is matched as a substring of the request URL. ' +
          'Call without response to remove the mock for that pattern.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            urlPattern: { type: 'string', description: 'Substring to match against request URLs' },
            response: {
              type: 'object',
              description: 'Mock response to return for matching requests',
              properties: {
                status: { type: 'number', description: 'HTTP status code', default: 200 },
                body: { type: 'string', description: 'Response body string (JSON, text, etc.)' },
                headers: {
                  type: 'object',
                  description: 'Response headers as key-value pairs',
                  additionalProperties: { type: 'string' },
                },
              },
            },
          },
          required: ['tabUrl', 'urlPattern'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_websocket_listen',
        description:
          'Start capturing WebSocket frames for a tab. Use when validating realtime traffic — chat, live updates, collaborative editing.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            urlPattern: {
              type: 'string',
              description: 'Only capture WebSockets whose URL matches this substring. Omit to capture all.',
            },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false, requiresNetworkIntercept: true },
      },
      {
        name: 'safari_websocket_filter',
        description:
          'Filter a captured WebSocket stream by direction and content. Use to find a specific frame in a noisy stream.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            pattern: { type: 'string', description: 'Filter messages whose data contains this substring' },
            direction: {
              type: 'string',
              enum: ['sent', 'received', 'both'],
              description: 'Filter by message direction',
              default: 'both',
            },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_dump_har',
        description:
          'Dump captured network as a HAR archive. Use when downstream analysis tools expect HAR format, or for sharing a repro with a backend team.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab whose intercept buffer to dump' },
            creatorVersion: {
              type: 'string',
              description: 'Override the HAR log.creator.version (default: Safari Pilot package version)',
            },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_route_from_har',
        description:
          'Install in-page mocks from a HAR 1.2 log so subsequent fetch/XHR requests matching captured URLs ' +
          'return the captured responses. Each surviving rule installs into window.__safariPilotMocks via the same ' +
          'path safari_mock_request uses. Defaults: GET-only (most replay flows are read-only), 3xx redirects and ' +
          'status-0 errors skipped (unreplayable). Returns { installed, rules }.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab to install mocks into' },
            har: {
              type: 'object',
              description: 'HAR 1.2 log object as produced by safari_dump_har or any HAR-compliant exporter',
            },
            methods: {
              type: 'array',
              items: { type: 'string' },
              description: 'HTTP methods whose entries to replay. Default: ["GET"] only. ' +
                'Pass e.g. ["GET","POST"] to also replay POST captures (caveat: same-URL different-method ' +
                'captures collide on the URL-keyed mock store; first-occurrence wins).',
            },
            urlPatterns: {
              type: 'array',
              items: { type: 'string' },
              description: 'Substring filters; only captured URLs containing at least one of these strings will be installed. Omit to include all captured URLs.',
            },
            includeErrors: {
              type: 'boolean',
              description: 'Include status:0 (network-error) entries. Default: false.',
              default: false,
            },
            includeRedirects: {
              type: 'boolean',
              description: 'Include 1xx interim and 3xx redirect entries. Default: false. Mock layer cannot honor Location semantics, so opting in produces non-redirecting mock responses.',
              default: false,
            },
          },
          required: ['tabUrl', 'har'],
        },
        requirements: { idempotent: false },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleListNetworkRequests(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const limit = typeof params['limit'] === 'number' ? params['limit'] : 100;
    const filter = params['filter'] as Record<string, unknown> | undefined;
    const filterType = filter?.['type'] as string | undefined;
    const filterStatus = filter?.['status'] as number | undefined;
    const filterUrlPattern = filter?.['urlPattern'] as string | undefined;

    const js = `
      // Merge Performance API entries with interceptor buffer
      var perfEntries = performance.getEntriesByType('resource').map(function(e) {
        return {
          url: e.name,
          method: 'GET',
          status: 0,
          type: e.initiatorType,
          timestamp: performance.timeOrigin + e.startTime,
          duration: e.duration,
          transferSize: e.transferSize || 0,
          encodedBodySize: e.encodedBodySize || 0,
          source: 'performance',
        };
      });

      var intercepted = window.__safariPilotNetwork ? window.__safariPilotNetwork.entries.slice() : [];
      intercepted = intercepted.map(function(e) { return Object.assign({}, e, { source: 'interceptor' }); });

      // Merge: prefer interceptor entries (have status codes), dedupe by URL
      var seen = {};
      var interceptedUrls = {};
      intercepted.forEach(function(e) { interceptedUrls[e.url] = true; });

      var merged = intercepted.slice();
      perfEntries.forEach(function(e) {
        if (!interceptedUrls[e.url]) merged.push(e);
      });

      // Apply filters
      var filterType = ${filterType ? `'${escapeForJsSingleQuote(filterType)}'` : 'null'};
      var filterStatus = ${filterStatus != null ? filterStatus : 'null'};
      var filterUrlPattern = ${filterUrlPattern ? `'${escapeForJsSingleQuote(filterUrlPattern)}'` : 'null'};
      var limit = ${limit};

      var filtered = merged.filter(function(e) {
        if (filterType && e.type !== filterType) return false;
        if (filterStatus !== null && e.status !== filterStatus) return false;
        if (filterUrlPattern && e.url.indexOf(filterUrlPattern) === -1) return false;
        return true;
      });

      var limited = filtered.slice(-limit);
      return { requests: limited, count: limited.length, total: filtered.length };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw wrapEngineError(result.error, 'List network requests failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { requests: [], count: 0, total: 0 }, Date.now() - start);
  }

  private async handleGetNetworkRequest(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const url = params['url'] as string;
    const matchMode = (params['matchMode'] as string | undefined) ?? 'contains';

    const escapedUrl = escapeForJsSingleQuote(url);

    const js = `
      var targetUrl = '${escapedUrl}';
      var matchMode = '${matchMode}';

      function urlMatches(entryUrl) {
        if (matchMode === 'exact') return entryUrl === targetUrl;
        if (matchMode === 'endsWith') return entryUrl.endsWith(targetUrl);
        return entryUrl.indexOf(targetUrl) !== -1;
      }

      // Check interceptor buffer first (has more detail)
      if (window.__safariPilotNetwork) {
        var found = null;
        var entries = window.__safariPilotNetwork.entries;
        for (var i = entries.length - 1; i >= 0; i--) {
          if (urlMatches(entries[i].url)) { found = entries[i]; break; }
        }
        if (found) return { request: found, source: 'interceptor' };
      }

      // Fall back to Performance API
      var perfEntries = performance.getEntriesByType('resource');
      var perfMatch = null;
      for (var j = perfEntries.length - 1; j >= 0; j--) {
        if (urlMatches(perfEntries[j].name)) { perfMatch = perfEntries[j]; break; }
      }

      if (!perfMatch) {
        throw Object.assign(new Error('Network request not found: ' + targetUrl), { name: 'NOT_FOUND' });
      }

      var e = perfMatch;
      return {
        request: {
          url: e.name,
          method: 'GET',
          status: 0,
          type: e.initiatorType,
          timestamp: performance.timeOrigin + e.startTime,
          duration: e.duration,
          transferSize: e.transferSize || 0,
          encodedBodySize: e.encodedBodySize || 0,
          timing: {
            dns: e.domainLookupEnd - e.domainLookupStart,
            connect: e.connectEnd - e.connectStart,
            ttfb: e.responseStart - e.requestStart,
            download: e.responseEnd - e.responseStart,
          },
        },
        source: 'performance',
      };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Get network request failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleInterceptRequests(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const urlPattern = params['urlPattern'] as string | undefined;
    const captureBody = params['captureBody'] === true;
    const maxEntries = typeof params['maxEntries'] === 'number' ? params['maxEntries'] : 200;

    const escapedPattern = urlPattern ? escapeForJsSingleQuote(urlPattern) : '';

    const js = `
      var urlPattern = ${urlPattern ? `'${escapedPattern}'` : 'null'};
      var captureBody = ${captureBody};
      var maxEntries = ${maxEntries};

      if (!window.__safariPilotNetwork) {
        window.__safariPilotNetwork = { entries: [], installed: false };
      }

      if (window.__safariPilotNetwork.installed) {
        return { status: 'already_installed', buffered: window.__safariPilotNetwork.entries.length };
      }

      // Helper: normalize fetch's init.headers (Headers / plain object / [name,value][])
      // into a plain {name: value} record and assign to entry.requestHeaders.
      // Path B: required for HAR record/replay so entriesToHar can roundtrip headers.
      function __sp_captureRequestHeaders(entry, init) {
        if (!init || !init.headers) return;
        var reqHeaders = {};
        if (typeof init.headers.forEach === 'function') {
          // Headers instance — forEach signature is (value, name, parent)
          init.headers.forEach(function(value, name) { reqHeaders[name] = value; });
        } else if (Array.isArray(init.headers)) {
          for (var i = 0; i < init.headers.length; i++) {
            var pair = init.headers[i];
            if (pair && pair.length >= 2) reqHeaders[pair[0]] = String(pair[1]);
          }
        } else {
          var keys = Object.keys(init.headers);
          for (var k = 0; k < keys.length; k++) {
            reqHeaders[keys[k]] = String(init.headers[keys[k]]);
          }
        }
        entry.requestHeaders = reqHeaders;
      }

      // Helper: capture response.headers (Headers instance) into a plain record.
      function __sp_captureResponseHeaders(entry, response) {
        if (!response || !response.headers || typeof response.headers.forEach !== 'function') return;
        var respHeaders = {};
        response.headers.forEach(function(value, name) { respHeaders[name] = value; });
        entry.responseHeaders = respHeaders;
      }

      // Helper: parse XHR's getAllResponseHeaders() CRLF-delimited string into a record.
      function __sp_parseXhrResponseHeaders(xhr) {
        var raw = '';
        try { raw = xhr.getAllResponseHeaders() || ''; } catch (e) { return {}; }
        var out = {};
        var lines = raw.split(/\\r?\\n/);
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line) continue;
          var idx = line.indexOf(':');
          if (idx <= 0) continue;
          var name = line.slice(0, idx).trim();
          var value = line.slice(idx + 1).trim();
          if (name) out[name] = value;
        }
        return out;
      }

      // Patch window.fetch
      var origFetch = window.fetch;
      window.fetch = function(input, init) {
        var reqUrl = typeof input === 'string' ? input : (input.url || String(input));
        var method = (init && init.method) ? init.method.toUpperCase() : 'GET';

        if (!urlPattern || reqUrl.indexOf(urlPattern) !== -1) {
          var entry = {
            url: reqUrl,
            method: method,
            status: 0,
            type: 'fetch',
            timestamp: Date.now(),
            duration: 0,
            requestBody: captureBody && init && init.body ? String(init.body).slice(0, 4096) : undefined,
          };
          __sp_captureRequestHeaders(entry, init);
          var startTime = performance.now();

          return origFetch.apply(this, arguments).then(function(response) {
            entry.status = response.status;
            entry.duration = performance.now() - startTime;
            __sp_captureResponseHeaders(entry, response);
            if (captureBody) {
              return response.clone().text().then(function(body) {
                entry.responseBody = body.slice(0, 4096);
                if (window.__safariPilotNetwork.entries.length >= maxEntries) {
                  window.__safariPilotNetwork.entries.shift();
                }
                window.__safariPilotNetwork.entries.push(entry);
                return response;
              });
            }
            if (window.__safariPilotNetwork.entries.length >= maxEntries) {
              window.__safariPilotNetwork.entries.shift();
            }
            window.__safariPilotNetwork.entries.push(entry);
            return response;
          }, function(err) {
            entry.status = 0;
            entry.error = err.message;
            entry.duration = performance.now() - startTime;
            if (window.__safariPilotNetwork.entries.length >= maxEntries) {
              window.__safariPilotNetwork.entries.shift();
            }
            window.__safariPilotNetwork.entries.push(entry);
            throw err;
          });
        }
        return origFetch.apply(this, arguments);
      };

      // Patch XMLHttpRequest
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      var origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

      XMLHttpRequest.prototype.open = function(method, xhrUrl) {
        this.__safariMethod = method.toUpperCase();
        this.__safariUrl = String(xhrUrl);
        // Reset captured headers on open() — same XHR object can be reused
        this.__safariReqHeaders = {};
        return origOpen.apply(this, arguments);
      };

      // Override setRequestHeader to record headers into a per-XHR map BEFORE
      // the request fires (XHR exposes no post-send way to read request headers).
      XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        if (!this.__safariReqHeaders) this.__safariReqHeaders = {};
        this.__safariReqHeaders[name] = String(value);
        return origSetRequestHeader.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function(body) {
        var self = this;
        var reqUrl = this.__safariUrl || '';
        var method = this.__safariMethod || 'GET';

        if (!urlPattern || reqUrl.indexOf(urlPattern) !== -1) {
          var entry = {
            url: reqUrl,
            method: method,
            status: 0,
            type: 'xmlhttprequest',
            timestamp: Date.now(),
            duration: 0,
            requestBody: captureBody && body ? String(body).slice(0, 4096) : undefined,
          };
          entry.requestHeaders = self.__safariReqHeaders || {};
          var startTime = performance.now();

          this.addEventListener('loadend', function() {
            entry.status = self.status;
            entry.duration = performance.now() - startTime;
            entry.responseHeaders = __sp_parseXhrResponseHeaders(self);
            if (captureBody) {
              entry.responseBody = (self.responseText || '').slice(0, 4096);
            }
            if (window.__safariPilotNetwork.entries.length >= maxEntries) {
              window.__safariPilotNetwork.entries.shift();
            }
            window.__safariPilotNetwork.entries.push(entry);
          });
        }
        return origSend.apply(this, arguments);
      };

      window.__safariPilotNetwork.installed = true;
      return { status: 'installed', urlPattern: urlPattern, captureBody: captureBody, maxEntries: maxEntries };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Intercept requests failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleNetworkThrottle(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const latencyMs = typeof params['latencyMs'] === 'number' ? params['latencyMs'] : 0;
    const downloadKbps = typeof params['downloadKbps'] === 'number' ? params['downloadKbps'] : null;

    const js = `
      var latencyMs = ${latencyMs};
      var downloadKbps = ${downloadKbps !== null ? downloadKbps : 'null'};

      if (!window.__safariPilotThrottle) {
        window.__safariPilotThrottle = { origFetch: window.fetch, origOpen: XMLHttpRequest.prototype.open, origSend: XMLHttpRequest.prototype.send };
      }

      if (latencyMs === 0 && downloadKbps === null) {
        // Remove throttling — restore originals
        window.fetch = window.__safariPilotThrottle.origFetch;
        XMLHttpRequest.prototype.open = window.__safariPilotThrottle.origOpen;
        XMLHttpRequest.prototype.send = window.__safariPilotThrottle.origSend;
        return { status: 'disabled', latencyMs: 0, downloadKbps: null };
      }

      var origFetch = window.__safariPilotThrottle.origFetch;
      window.fetch = function(input, init) {
        return new Promise(function(resolve) {
          setTimeout(function() { resolve(null); }, latencyMs);
        }).then(function() {
          return origFetch.apply(window, [input, init]).then(function(response) {
            if (!downloadKbps) return response;
            // Simulate bandwidth by reading the body and delaying proportionally
            return response.clone().arrayBuffer().then(function(buf) {
              var bytes = buf.byteLength;
              var delayMs = (bytes / (downloadKbps * 1024)) * 1000;
              return new Promise(function(resolve) {
                setTimeout(function() { resolve(response); }, delayMs);
              });
            });
          });
        });
      };

      var origXhrSend = window.__safariPilotThrottle.origSend;
      XMLHttpRequest.prototype.send = function(body) {
        var self = this;
        setTimeout(function() {
          origXhrSend.call(self, body);
        }, latencyMs);
      };

      return { status: 'enabled', latencyMs: latencyMs, downloadKbps: downloadKbps };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Network throttle failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleNetworkOffline(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const offline = params['offline'] === true;

    const js = `
      var offline = ${offline};

      if (!window.__safariPilotOffline) {
        window.__safariPilotOffline = { origFetch: window.fetch, origOpen: XMLHttpRequest.prototype.open };
      }

      if (!offline) {
        // Restore connectivity
        window.fetch = window.__safariPilotOffline.origFetch;
        XMLHttpRequest.prototype.open = window.__safariPilotOffline.origOpen;
        return { offline: false };
      }

      // Intercept fetch
      window.fetch = function() {
        return Promise.reject(Object.assign(new TypeError('Failed to fetch'), { name: 'NetworkError' }));
      };

      // Intercept XHR
      var origXhrOpen = window.__safariPilotOffline.origOpen;
      XMLHttpRequest.prototype.open = function() {
        var self = this;
        origXhrOpen.apply(this, arguments);
        setTimeout(function() {
          self.dispatchEvent(new ProgressEvent('error'));
        }, 0);
      };

      return { offline: true };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Network offline failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleMockRequest(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const urlPattern = params['urlPattern'] as string;
    const response = params['response'] as Record<string, unknown> | undefined;

    const escapedPattern = escapeForJsSingleQuote(urlPattern);
    const responseJson = response ? escapeForTemplateLiteral(JSON.stringify(response)) : 'null';

    const js = `
      var urlPattern = '${escapedPattern}';
      var mockResponse = ${responseJson !== 'null' ? `JSON.parse(\`${responseJson}\`)` : 'null'};

      if (!window.__safariPilotMocks) {
        window.__safariPilotMocks = {};

        // Patch fetch once
        var origFetch = window.fetch;
        window.fetch = function(input, init) {
          var reqUrl = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
          var matched = null;
          var patterns = Object.keys(window.__safariPilotMocks);
          for (var i = 0; i < patterns.length; i++) {
            if (reqUrl.indexOf(patterns[i]) !== -1) { matched = patterns[i]; break; }
          }
          if (matched !== null) {
            var mock = window.__safariPilotMocks[matched];
            var status = mock.status || 200;
            var body = mock.body || '';
            var headers = mock.headers || {};
            var resp = new Response(body, { status: status, headers: headers });
            return Promise.resolve(resp);
          }
          return origFetch.apply(this, arguments);
        };

        // Patch XHR once
        var origOpen = XMLHttpRequest.prototype.open;
        var origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, xhrUrl) {
          this.__safariMockUrl = String(xhrUrl);
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function(body) {
          var reqUrl = this.__safariMockUrl || '';
          var matched = null;
          var patterns = Object.keys(window.__safariPilotMocks);
          for (var i = 0; i < patterns.length; i++) {
            if (reqUrl.indexOf(patterns[i]) !== -1) { matched = patterns[i]; break; }
          }
          if (matched !== null) {
            var mock = window.__safariPilotMocks[matched];
            var self = this;
            Object.defineProperty(self, 'status', { get: function() { return mock.status || 200; }, configurable: true });
            Object.defineProperty(self, 'responseText', { get: function() { return mock.body || ''; }, configurable: true });
            Object.defineProperty(self, 'readyState', { get: function() { return 4; }, configurable: true });
            setTimeout(function() { self.dispatchEvent(new ProgressEvent('load')); self.dispatchEvent(new ProgressEvent('loadend')); }, 0);
            return;
          }
          return origSend.apply(this, arguments);
        };
      }

      if (mockResponse === null) {
        delete window.__safariPilotMocks[urlPattern];
        return { status: 'removed', urlPattern: urlPattern };
      }

      window.__safariPilotMocks[urlPattern] = mockResponse;
      return { status: 'installed', urlPattern: urlPattern, response: mockResponse, totalMocks: Object.keys(window.__safariPilotMocks).length };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Mock request failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleWebSocketListen(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const urlPattern = params['urlPattern'] as string | undefined;

    const escapedPattern = urlPattern ? escapeForJsSingleQuote(urlPattern) : '';

    const js = `
      var urlPattern = ${urlPattern ? `'${escapedPattern}'` : 'null'};

      if (window.__safariPilotWS && window.__safariPilotWS.installed) {
        return { status: 'already_installed', buffered: window.__safariPilotWS.messages.length };
      }

      window.__safariPilotWS = { messages: [], installed: false, urlPattern: urlPattern };

      var OrigWebSocket = window.WebSocket;
      function PatchedWebSocket(url, protocols) {
        var ws = protocols !== undefined ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
        var shouldCapture = !urlPattern || String(url).indexOf(urlPattern) !== -1;

        if (shouldCapture) {
          var origSend = ws.send.bind(ws);
          ws.send = function(data) {
            window.__safariPilotWS.messages.push({
              direction: 'sent',
              data: typeof data === 'string' ? data : '[binary]',
              timestamp: Date.now(),
              url: String(url),
            });
            return origSend(data);
          };

          ws.addEventListener('message', function(event) {
            window.__safariPilotWS.messages.push({
              direction: 'received',
              data: typeof event.data === 'string' ? event.data : '[binary]',
              timestamp: Date.now(),
              url: String(url),
            });
          });
        }

        return ws;
      }

      PatchedWebSocket.prototype = OrigWebSocket.prototype;
      PatchedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
      PatchedWebSocket.OPEN = OrigWebSocket.OPEN;
      PatchedWebSocket.CLOSING = OrigWebSocket.CLOSING;
      PatchedWebSocket.CLOSED = OrigWebSocket.CLOSED;
      window.WebSocket = PatchedWebSocket;
      window.__safariPilotWS.installed = true;

      return { status: 'installed', urlPattern: urlPattern };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw wrapEngineError(result.error, 'WebSocket listen failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleWebSocketFilter(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const pattern = params['pattern'] as string | undefined;
    const direction = (params['direction'] as string | undefined) ?? 'both';

    const escapedPattern = pattern ? escapeForJsSingleQuote(pattern) : '';

    const js = `
      var filterPattern = ${pattern ? `'${escapedPattern}'` : 'null'};
      var filterDirection = '${direction}';

      if (!window.__safariPilotWS) {
        return { messages: [], count: 0, error: 'WebSocket listener not installed. Call safari_websocket_listen first.' };
      }

      var msgs = window.__safariPilotWS.messages.slice();

      if (filterDirection !== 'both') {
        msgs = msgs.filter(function(m) { return m.direction === filterDirection; });
      }

      if (filterPattern) {
        msgs = msgs.filter(function(m) { return String(m.data).indexOf(filterPattern) !== -1; });
      }

      return { messages: msgs, count: msgs.length, total: window.__safariPilotWS.messages.length };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw wrapEngineError(result.error, 'WebSocket filter failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleDumpHar(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const creatorVersion = params['creatorVersion'] as string | undefined;

    // Read the in-page interceptor buffer. If safari_intercept_requests has
    // not run, __safariPilotNetwork is undefined → return empty array.
    const js = `
      return window.__safariPilotNetwork && window.__safariPilotNetwork.entries
        ? window.__safariPilotNetwork.entries.slice()
        : [];
    `;
    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw wrapEngineError(result.error, 'Dump HAR failed');

    const raw = result.value ? JSON.parse(result.value) : null;
    const entries: InterceptEntry[] = Array.isArray(raw) ? (raw as InterceptEntry[]) : [];
    const har = entriesToHar(entries, creatorVersion ? { creatorVersion } : undefined);

    return this.makeResponse({ har, entryCount: entries.length }, Date.now() - start);
  }

  private async handleRouteFromHar(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const har = params['har'] as HarLog;
    const methods = params['methods'] as string[] | undefined;
    const urlPatterns = params['urlPatterns'] as string[] | undefined;
    const includeErrors = params['includeErrors'] === true;
    const includeRedirects = params['includeRedirects'] === true;

    // The MCP wire is JSON; callbacks aren't transferable. Translate the
    // string[] form into the callback shape harToMockRules expects, leaving
    // each option undefined so the helper applies its own defaults
    // (methodFilter: GET-only, urlFilter: include all).
    const harOptions: HarToMockOptions = { includeErrors, includeRedirects };
    if (methods) harOptions.methodFilter = (m: string): boolean => methods.includes(m);
    if (urlPatterns) {
      harOptions.urlFilter = (u: string): boolean => urlPatterns.some((p) => u.includes(p));
    }

    const rules = harToMockRules(har, harOptions);

    // Install each rule via the existing mock-request handler — same dispatch
    // path, same in-page state (__safariPilotMocks). Per-rule round-trip is
    // simpler than building a batch script and adequate for typical HAR
    // sizes; optimize to batch if profiling identifies a hotspot.
    for (const rule of rules) {
      await this.handleMockRequest({
        tabUrl,
        urlPattern: rule.urlPattern,
        response: rule.response,
      });
    }

    return this.makeResponse({ installed: rules.length, rules }, Date.now() - start);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private makeResponse(data: unknown, latencyMs: number = 0): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript' as Engine, degraded: false, latencyMs },
    };
  }
}
