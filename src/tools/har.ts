/**
 * HAR 1.2 transformer (Phase 5A · 5A.7).
 *
 * Pure transforms between Safari Pilot's in-page interceptor buffer
 * (window.__safariPilotNetwork.entries — see network.ts handleInterceptRequests)
 * and the HAR 1.2 log format defined at
 * http://www.softwareishard.com/blog/har-12-spec/.
 *
 * Two directions are supported:
 *   - entriesToHar(entries, options?)  → HAR log (this cycle, GREEN-1)
 *   - harToMockRules(harLog, options?) → mock rules consumable by the existing
 *                                        __safariPilotMocks pattern (next cycle)
 *
 * The transformer is deliberately permissive for legacy capture data: entries
 * predating the path-B header-capture enhancement (no requestHeaders /
 * responseHeaders fields) emit `headers: []` rather than crashing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface InterceptEntry {
  url: string;
  method: string;
  status: number;
  type: string;
  timestamp: number;
  duration: number;
  requestBody?: string;
  responseBody?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  error?: string;
}

export interface HarHeader {
  name: string;
  value: string;
}

export interface HarQueryString {
  name: string;
  value: string;
}

export interface HarCookie {
  name: string;
  value: string;
}

export interface HarPostData {
  mimeType: string;
  text: string;
}

export interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarHeader[];
  queryString: HarQueryString[];
  postData?: HarPostData;
  headersSize: number;
  bodySize: number;
}

export interface HarContent {
  size: number;
  mimeType: string;
  text?: string;
}

export interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: HarCookie[];
  headers: HarHeader[];
  content: HarContent;
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

export interface HarTimings {
  send: number;
  wait: number;
  receive: number;
  blocked: number;
  dns: number;
  connect: number;
  ssl: number;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: Record<string, unknown>;
  timings: HarTimings;
}

export interface HarLog {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    entries: HarEntry[];
  };
}

const STATUS_TEXTS: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols',
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict',
  410: 'Gone', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const PKG_DEFAULT_VERSION = ((): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/tools/har.ts and dist/tools/har.js both sit two dirs below project root
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8')) as { version: string };
  return pkg.version;
})();

function statusTextFor(status: number): string {
  if (status === 0) return '';
  return STATUS_TEXTS[status] ?? '';
}

function headersFromRecord(record?: Record<string, string>): HarHeader[] {
  if (!record) return [];
  return Object.entries(record).map(([name, value]) => ({ name, value }));
}

function findHeaderCaseInsensitive(record: Record<string, string> | undefined, name: string): string | undefined {
  if (!record) return undefined;
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

function decodeQueryComponent(s: string): string {
  // Application/x-www-form-urlencoded uses `+` for space, then percent-encoding.
  // decodeURIComponent throws on malformed sequences; fall back to the +→space
  // step alone so a single bad pair doesn't poison the whole query string.
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s.replace(/\+/g, ' ');
  }
}

function parseQueryString(url: string): HarQueryString[] {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return [];
  let queryAndHash = url.slice(qIdx + 1);
  const hashIdx = queryAndHash.indexOf('#');
  if (hashIdx !== -1) queryAndHash = queryAndHash.slice(0, hashIdx);
  if (queryAndHash === '') return [];

  const result: HarQueryString[] = [];
  for (const pair of queryAndHash.split('&')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) {
      result.push({ name: decodeQueryComponent(pair), value: '' });
    } else {
      result.push({
        name: decodeQueryComponent(pair.slice(0, eqIdx)),
        value: decodeQueryComponent(pair.slice(eqIdx + 1)),
      });
    }
  }
  return result;
}

function buildHarEntry(entry: InterceptEntry): HarEntry {
  const startedDateTime = new Date(entry.timestamp).toISOString();
  const time = entry.duration;

  const requestContentType = findHeaderCaseInsensitive(entry.requestHeaders, 'content-type') ?? '';
  const responseContentType = findHeaderCaseInsensitive(entry.responseHeaders, 'content-type') ?? '';

  const request: HarRequest = {
    method: entry.method,
    url: entry.url,
    httpVersion: 'HTTP/1.1',
    cookies: [],
    headers: headersFromRecord(entry.requestHeaders),
    queryString: parseQueryString(entry.url),
    headersSize: -1,
    bodySize: -1,
  };

  if (entry.requestBody !== undefined) {
    request.postData = {
      mimeType: requestContentType,
      text: entry.requestBody,
    };
  }

  const content: HarContent = {
    size: entry.responseBody !== undefined ? entry.responseBody.length : 0,
    mimeType: responseContentType,
  };
  if (entry.responseBody !== undefined) {
    content.text = entry.responseBody;
  }

  const response: HarResponse = {
    status: entry.status,
    statusText: statusTextFor(entry.status),
    httpVersion: 'HTTP/1.1',
    cookies: [],
    headers: headersFromRecord(entry.responseHeaders),
    content,
    redirectURL: '',
    headersSize: -1,
    bodySize: -1,
  };

  if (entry.error !== undefined) {
    // HAR spec section 2.4 allows custom underscore-prefixed keys.
    (response as unknown as Record<string, unknown>)['_errorMessage'] = entry.error;
  }

  const timings: HarTimings = {
    send: 0,
    wait: time,
    receive: 0,
    blocked: -1,
    dns: -1,
    connect: -1,
    ssl: -1,
  };

  return {
    startedDateTime,
    time,
    request,
    response,
    cache: {},
    timings,
  };
}

export function entriesToHar(
  entries: InterceptEntry[],
  options?: { creatorVersion?: string },
): HarLog {
  return {
    log: {
      version: '1.2',
      creator: {
        name: 'Safari Pilot',
        version: options?.creatorVersion ?? PKG_DEFAULT_VERSION,
      },
      entries: entries.map(buildHarEntry),
    },
  };
}
