import type { AppleScriptEngine } from '../engines/applescript.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class NetworkTools {
  private engine: AppleScriptEngine;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: AppleScriptEngine) {
    this.engine = engine;
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.handlers.set('safari_list_network_requests', this.handleListNetworkRequests.bind(this));
    this.handlers.set('safari_get_network_request', this.handleGetNetworkRequest.bind(this));
    this.handlers.set('safari_intercept_requests', this.handleInterceptRequests.bind(this));
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_list_network_requests',
        description:
          'List recent network requests captured via the Performance Resource Timing API. ' +
          'Returns URL, method, status, type, duration, and timing for each request. ' +
          'Only captures requests made after page load or after interceptor is installed. ' +
          'For full request/response bodies, use safari_intercept_requests first.',
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
        requirements: {},
      },
      {
        name: 'safari_get_network_request',
        description:
          'Get detailed timing and metadata for a specific network request by URL. ' +
          'Returns transfer size, encoded size, duration breakdown (DNS, connect, TTFB, etc.), ' +
          'and initiator type. Useful for diagnosing slow API calls or large asset loads.',
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
        requirements: {},
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
        requirements: {},
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
      var filterType = ${filterType ? `'${filterType.replace(/'/g, "\\'")}'` : 'null'};
      var filterStatus = ${filterStatus != null ? filterStatus : 'null'};
      var filterUrlPattern = ${filterUrlPattern ? `'${filterUrlPattern.replace(/'/g, "\\'")}'` : 'null'};
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
    if (!result.ok) throw new Error(result.error?.message ?? 'List network requests failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { requests: [], count: 0, total: 0 }, Date.now() - start);
  }

  private async handleGetNetworkRequest(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const url = params['url'] as string;
    const matchMode = (params['matchMode'] as string | undefined) ?? 'contains';

    const escapedUrl = url.replace(/'/g, "\\'");

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
    if (!result.ok) throw new Error(result.error?.message ?? 'Get network request failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleInterceptRequests(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const urlPattern = params['urlPattern'] as string | undefined;
    const captureBody = params['captureBody'] === true;
    const maxEntries = typeof params['maxEntries'] === 'number' ? params['maxEntries'] : 200;

    const escapedPattern = urlPattern ? urlPattern.replace(/'/g, "\\'") : '';

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
          var startTime = performance.now();

          return origFetch.apply(this, arguments).then(function(response) {
            entry.status = response.status;
            entry.duration = performance.now() - startTime;
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

      XMLHttpRequest.prototype.open = function(method, xhrUrl) {
        this.__safariMethod = method.toUpperCase();
        this.__safariUrl = String(xhrUrl);
        return origOpen.apply(this, arguments);
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
          var startTime = performance.now();

          this.addEventListener('loadend', function() {
            entry.status = self.status;
            entry.duration = performance.now() - startTime;
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
    if (!result.ok) throw new Error(result.error?.message ?? 'Intercept requests failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private makeResponse(data: unknown, latencyMs: number = 0): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript' as Engine, degraded: false, latencyMs },
    };
  }
}
