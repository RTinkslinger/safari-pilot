import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class StorageTools {
  private engine: IEngine;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: IEngine) {
    this.engine = engine;
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.handlers.set('safari_get_cookies', this.handleGetCookies.bind(this));
    this.handlers.set('safari_set_cookie', this.handleSetCookie.bind(this));
    this.handlers.set('safari_delete_cookie', this.handleDeleteCookie.bind(this));
    this.handlers.set('safari_storage_state_export', this.handleStorageStateExport.bind(this));
    this.handlers.set('safari_storage_state_import', this.handleStorageStateImport.bind(this));
    this.handlers.set('safari_local_storage_get', this.handleLocalStorageGet.bind(this));
    this.handlers.set('safari_local_storage_set', this.handleLocalStorageSet.bind(this));
    this.handlers.set('safari_session_storage_get', this.handleSessionStorageGet.bind(this));
    this.handlers.set('safari_session_storage_set', this.handleSessionStorageSet.bind(this));
    this.handlers.set('safari_idb_list', this.handleIdbList.bind(this));
    this.handlers.set('safari_idb_get', this.handleIdbGet.bind(this));
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_get_cookies',
        description:
          'Get cookies accessible via document.cookie for the current page. ' +
          'Returns name, value, domain, path, and security flags. ' +
          'Note: httpOnly cookies are not accessible via JS — use the extension engine (Phase 3) for full cookie access. ' +
          'Optionally filter by domain substring.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab to read cookies from' },
            domain: { type: 'string', description: 'Filter cookies to those matching this domain substring' },
          },
          required: [],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_set_cookie',
        description:
          'Set a cookie on the current page via document.cookie. ' +
          'Supports name, value, domain, path, expiry, and security flags. ' +
          'httpOnly cookies cannot be set via JS — requires extension engine (Phase 3).',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab to set the cookie on' },
            name: { type: 'string', description: 'Cookie name' },
            value: { type: 'string', description: 'Cookie value' },
            domain: { type: 'string', description: 'Cookie domain (defaults to current domain)' },
            path: { type: 'string', description: 'Cookie path', default: '/' },
            expires: {
              type: 'string',
              description: 'Expiry as ISO date string or number of seconds from now (e.g. "3600" for 1 hour)',
            },
            httpOnly: {
              type: 'boolean',
              description: 'Set httpOnly flag (note: has no effect via document.cookie — requires extension)',
              default: false,
            },
            secure: { type: 'boolean', description: 'Set Secure flag', default: false },
            sameSite: {
              type: 'string',
              enum: ['strict', 'lax', 'none'],
              description: 'SameSite policy',
              default: 'lax',
            },
          },
          required: ['tabUrl', 'name', 'value'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_delete_cookie',
        description:
          'Delete a cookie by name on the current page. ' +
          'Optionally specify domain and path to target the exact cookie. ' +
          'Works by setting the expiry to the past via document.cookie.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab' },
            name: { type: 'string', description: 'Cookie name to delete' },
            domain: { type: 'string', description: 'Cookie domain (optional, helps target the right cookie)' },
            path: { type: 'string', description: 'Cookie path', default: '/' },
          },
          required: ['tabUrl', 'name'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_storage_state_export',
        description:
          'Export the full storage state of the current page: cookies (via document.cookie), ' +
          'localStorage, and sessionStorage. Useful for saving authenticated session state ' +
          'to restore later with safari_storage_state_import.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab to export state from' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_storage_state_import',
        description:
          'Import a previously exported storage state into the current page. ' +
          'Restores cookies (via document.cookie), localStorage, and sessionStorage. ' +
          'Typically used to restore an authenticated session without re-logging in. ' +
          'Pass the state object returned by safari_storage_state_export.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab to import state into' },
            state: {
              type: 'object',
              description: 'Storage state object from safari_storage_state_export',
              properties: {
                cookies: { type: 'array', items: { type: 'object' } },
                localStorage: { type: 'object' },
                sessionStorage: { type: 'object' },
              },
            },
          },
          required: ['tabUrl', 'state'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_local_storage_get',
        description: 'Get a single localStorage value by key from the current page.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab' },
            key: { type: 'string', description: 'localStorage key to retrieve' },
          },
          required: ['tabUrl', 'key'],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_local_storage_set',
        description: 'Set a localStorage key to the given value on the current page.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab' },
            key: { type: 'string', description: 'localStorage key to set' },
            value: { type: 'string', description: 'Value to store (will be coerced to string by localStorage)' },
          },
          required: ['tabUrl', 'key', 'value'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_session_storage_get',
        description: 'Get a single sessionStorage value by key from the current page.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab' },
            key: { type: 'string', description: 'sessionStorage key to retrieve' },
          },
          required: ['tabUrl', 'key'],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_session_storage_set',
        description: 'Set a sessionStorage key to the given value on the current page.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab' },
            key: { type: 'string', description: 'sessionStorage key to set' },
            value: { type: 'string', description: 'Value to store' },
          },
          required: ['tabUrl', 'key', 'value'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_idb_list',
        description:
          'List all IndexedDB databases available on the current origin. ' +
          'Returns an array of database descriptors with name and version.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_idb_get',
        description:
          'Read records from an IndexedDB object store. ' +
          'Optionally filter with a key range query. ' +
          'Returns up to 100 records by default.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'URL of the tab' },
            database: { type: 'string', description: 'IndexedDB database name' },
            store: { type: 'string', description: 'Object store name within the database' },
            query: {
              type: 'object',
              description: 'Optional key range query',
              properties: {
                lower: { description: 'Lower bound of key range (any serializable value)' },
                upper: { description: 'Upper bound of key range (any serializable value)' },
                lowerOpen: { type: 'boolean', description: 'Exclude lower bound', default: false },
                upperOpen: { type: 'boolean', description: 'Exclude upper bound', default: false },
                only: { description: 'Exact key to retrieve (overrides lower/upper)' },
              },
            },
            limit: { type: 'number', description: 'Maximum records to return', default: 100 },
          },
          required: ['tabUrl', 'database', 'store'],
        },
        requirements: { idempotent: true },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleGetCookies(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string | undefined;
    const domain = params['domain'] as string | undefined;
    const escapedDomain = domain ? domain.replace(/'/g, "\\'") : '';

    const js = `
      var rawCookies = document.cookie;
      var cookies = [];

      if (rawCookies) {
        rawCookies.split('; ').forEach(function(pair) {
          var idx = pair.indexOf('=');
          var name = idx !== -1 ? pair.slice(0, idx) : pair;
          var value = idx !== -1 ? pair.slice(idx + 1) : '';

          // Infer basic info from current page context
          var cookie = {
            name: name.trim(),
            value: value,
            domain: window.location.hostname,
            path: '/',
            httpOnly: false,
            secure: window.location.protocol === 'https:',
            sameSite: 'lax',
          };
          cookies.push(cookie);
        });
      }

      var domainFilter = ${domain ? `'${escapedDomain}'` : 'null'};
      if (domainFilter) {
        cookies = cookies.filter(function(c) { return c.domain.indexOf(domainFilter) !== -1; });
      }

      return { cookies: cookies, count: cookies.length };
    `;

    const result = await this.engine.executeJsInTab(tabUrl ?? '', js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Get cookies failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { cookies: [], count: 0 }, Date.now() - start);
  }

  private async handleSetCookie(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const name = params['name'] as string;
    const value = params['value'] as string;
    const domain = params['domain'] as string | undefined;
    const path = (params['path'] as string | undefined) ?? '/';
    const expires = params['expires'] as string | undefined;
    const secure = params['secure'] === true;
    const sameSite = (params['sameSite'] as string | undefined) ?? 'lax';

    const escapedName = name.replace(/'/g, "\\'");
    const escapedValue = value.replace(/'/g, "\\'");
    const escapedDomain = domain ? domain.replace(/'/g, "\\'") : '';
    const escapedPath = path.replace(/'/g, "\\'");
    const escapedSameSite = sameSite.replace(/'/g, "\\'");

    const js = `
      var cookieName = '${escapedName}';
      var cookieValue = '${escapedValue}';
      var cookieDomain = ${domain ? `'${escapedDomain}'` : 'null'};
      var cookiePath = '${escapedPath}';
      var cookieSecure = ${secure};
      var cookieSameSite = '${escapedSameSite}';
      var expiresParam = ${expires ? `'${expires.replace(/'/g, "\\'")}'` : 'null'};

      var parts = [cookieName + '=' + cookieValue];

      if (cookieDomain) parts.push('domain=' + cookieDomain);
      parts.push('path=' + cookiePath);

      if (expiresParam) {
        var expDate;
        if (/^\\d+$/.test(expiresParam)) {
          // Seconds from now
          expDate = new Date(Date.now() + parseInt(expiresParam, 10) * 1000);
        } else {
          // ISO date string
          expDate = new Date(expiresParam);
        }
        parts.push('expires=' + expDate.toUTCString());
      }

      if (cookieSecure) parts.push('Secure');
      parts.push('SameSite=' + cookieSameSite.charAt(0).toUpperCase() + cookieSameSite.slice(1));

      document.cookie = parts.join('; ');

      // Verify the cookie was set by reading it back
      var set = document.cookie.split('; ').some(function(pair) {
        return pair.split('=')[0].trim() === cookieName;
      });

      return { set: set, name: cookieName, cookie: parts.join('; ') };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Set cookie failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleDeleteCookie(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const name = params['name'] as string;
    const domain = params['domain'] as string | undefined;
    const path = (params['path'] as string | undefined) ?? '/';

    const escapedName = name.replace(/'/g, "\\'");
    const escapedDomain = domain ? domain.replace(/'/g, "\\'") : '';
    const escapedPath = path.replace(/'/g, "\\'");

    const js = `
      var cookieName = '${escapedName}';
      var cookieDomain = ${domain ? `'${escapedDomain}'` : 'null'};
      var cookiePath = '${escapedPath}';

      // Check if the cookie exists before deleting
      var existed = document.cookie.split('; ').some(function(pair) {
        return pair.split('=')[0].trim() === cookieName;
      });

      // Delete by setting expiry to the past
      var parts = [cookieName + '='];
      if (cookieDomain) parts.push('domain=' + cookieDomain);
      parts.push('path=' + cookiePath);
      parts.push('expires=Thu, 01 Jan 1970 00:00:00 GMT');

      document.cookie = parts.join('; ');

      // Verify deletion
      var stillExists = document.cookie.split('; ').some(function(pair) {
        return pair.split('=')[0].trim() === cookieName;
      });

      return { deleted: existed && !stillExists, existed: existed, name: cookieName };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Delete cookie failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleStorageStateExport(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    const js = `
      // Export cookies
      var cookies = [];
      var rawCookies = document.cookie;
      if (rawCookies) {
        rawCookies.split('; ').forEach(function(pair) {
          var idx = pair.indexOf('=');
          var name = idx !== -1 ? pair.slice(0, idx).trim() : pair.trim();
          var value = idx !== -1 ? pair.slice(idx + 1) : '';
          cookies.push({
            name: name,
            value: value,
            domain: window.location.hostname,
            path: '/',
            httpOnly: false,
            secure: window.location.protocol === 'https:',
            sameSite: 'lax',
          });
        });
      }

      // Export localStorage
      var localStorageData = {};
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var lsKey = localStorage.key(i);
          if (lsKey !== null) localStorageData[lsKey] = localStorage.getItem(lsKey);
        }
      } catch (e) {
        // localStorage may be unavailable (e.g. file:// or cross-origin)
      }

      // Export sessionStorage
      var sessionStorageData = {};
      try {
        for (var j = 0; j < sessionStorage.length; j++) {
          var ssKey = sessionStorage.key(j);
          if (ssKey !== null) sessionStorageData[ssKey] = sessionStorage.getItem(ssKey);
        }
      } catch (e) {
        // sessionStorage may be unavailable
      }

      return {
        state: {
          url: window.location.href,
          cookies: cookies,
          localStorage: localStorageData,
          sessionStorage: sessionStorageData,
          exportedAt: new Date().toISOString(),
        },
      };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Storage state export failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleStorageStateImport(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const state = params['state'] as Record<string, unknown>;

    // Serialise the state to inject into JS safely
    const stateJson = JSON.stringify(state).replace(/\\/g, '\\\\').replace(/`/g, '\\`');

    const js = `
      var state = JSON.parse(\`${stateJson}\`);
      var imported = { cookies: 0, localStorage: 0, sessionStorage: 0, errors: [] };

      // Import cookies
      if (state.cookies && Array.isArray(state.cookies)) {
        state.cookies.forEach(function(cookie) {
          try {
            var parts = [cookie.name + '=' + cookie.value];
            if (cookie.domain) parts.push('domain=' + cookie.domain);
            parts.push('path=' + (cookie.path || '/'));
            if (cookie.secure) parts.push('Secure');
            if (cookie.sameSite) parts.push('SameSite=' + cookie.sameSite.charAt(0).toUpperCase() + cookie.sameSite.slice(1));
            document.cookie = parts.join('; ');
            imported.cookies++;
          } catch (e) {
            imported.errors.push('cookie:' + cookie.name + ':' + e.message);
          }
        });
      }

      // Import localStorage
      if (state.localStorage && typeof state.localStorage === 'object') {
        try {
          Object.keys(state.localStorage).forEach(function(key) {
            localStorage.setItem(key, state.localStorage[key]);
            imported.localStorage++;
          });
        } catch (e) {
          imported.errors.push('localStorage:' + e.message);
        }
      }

      // Import sessionStorage
      if (state.sessionStorage && typeof state.sessionStorage === 'object') {
        try {
          Object.keys(state.sessionStorage).forEach(function(key) {
            sessionStorage.setItem(key, state.sessionStorage[key]);
            imported.sessionStorage++;
          });
        } catch (e) {
          imported.errors.push('sessionStorage:' + e.message);
        }
      }

      return { imported: imported, success: imported.errors.length === 0 };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Storage state import failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleLocalStorageGet(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const key = params['key'] as string;

    const escapedKey = key.replace(/'/g, "\\'");

    const js = `
      var key = '${escapedKey}';
      var value = null;
      var exists = false;
      try {
        value = localStorage.getItem(key);
        exists = value !== null;
      } catch (e) {
        throw new Error('localStorage not available: ' + e.message);
      }
      return { key: key, value: value, exists: exists };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'localStorage get failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleLocalStorageSet(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const key = params['key'] as string;
    const value = params['value'] as string;

    const escapedKey = key.replace(/'/g, "\\'");
    const escapedValue = value.replace(/'/g, "\\'");

    const js = `
      var key = '${escapedKey}';
      var value = '${escapedValue}';
      try {
        localStorage.setItem(key, value);
      } catch (e) {
        throw new Error('localStorage set failed: ' + e.message);
      }
      return { key: key, value: value, set: true };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'localStorage set failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleSessionStorageGet(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const key = params['key'] as string;

    const escapedKey = key.replace(/'/g, "\\'");

    const js = `
      var key = '${escapedKey}';
      var value = null;
      var exists = false;
      try {
        value = sessionStorage.getItem(key);
        exists = value !== null;
      } catch (e) {
        throw new Error('sessionStorage not available: ' + e.message);
      }
      return { key: key, value: value, exists: exists };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'sessionStorage get failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleSessionStorageSet(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const key = params['key'] as string;
    const value = params['value'] as string;

    const escapedKey = key.replace(/'/g, "\\'");
    const escapedValue = value.replace(/'/g, "\\'");

    const js = `
      var key = '${escapedKey}';
      var value = '${escapedValue}';
      try {
        sessionStorage.setItem(key, value);
      } catch (e) {
        throw new Error('sessionStorage set failed: ' + e.message);
      }
      return { key: key, value: value, set: true };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'sessionStorage set failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : {}, Date.now() - start);
  }

  private async handleIdbList(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    const js = `
      return new Promise(function(resolve, reject) {
        if (!indexedDB.databases) {
          // Fallback: indexedDB.databases() not available in all environments
          resolve({ databases: [], count: 0, note: 'indexedDB.databases() not supported in this context' });
          return;
        }
        indexedDB.databases().then(function(dbs) {
          resolve({ databases: dbs.map(function(db) { return { name: db.name, version: db.version }; }), count: dbs.length });
        }).catch(function(err) {
          reject(err);
        });
      });
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'IndexedDB list failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { databases: [], count: 0 }, Date.now() - start);
  }

  private async handleIdbGet(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const database = params['database'] as string;
    const store = params['store'] as string;
    const query = params['query'] as Record<string, unknown> | undefined;
    const limit = typeof params['limit'] === 'number' ? params['limit'] : 100;

    const queryJson = query ? JSON.stringify(query).replace(/\\/g, '\\\\').replace(/`/g, '\\`') : 'null';

    const js = `
      var dbName = ${JSON.stringify(database)};
      var storeName = ${JSON.stringify(store)};
      var queryParam = ${queryJson !== 'null' ? `JSON.parse(\`${queryJson}\`)` : 'null'};
      var limit = ${limit};

      return new Promise(function(resolve, reject) {
        var req = indexedDB.open(dbName);
        req.onerror = function() { reject(new Error('Failed to open database: ' + dbName)); };
        req.onsuccess = function(event) {
          var db = event.target.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.close();
            reject(new Error('Object store not found: ' + storeName));
            return;
          }

          var tx = db.transaction([storeName], 'readonly');
          var objectStore = tx.objectStore(storeName);

          // Build key range if query provided
          var keyRange = null;
          if (queryParam) {
            try {
              if (queryParam.only !== undefined) {
                keyRange = IDBKeyRange.only(queryParam.only);
              } else if (queryParam.lower !== undefined && queryParam.upper !== undefined) {
                keyRange = IDBKeyRange.bound(queryParam.lower, queryParam.upper, !!queryParam.lowerOpen, !!queryParam.upperOpen);
              } else if (queryParam.lower !== undefined) {
                keyRange = IDBKeyRange.lowerBound(queryParam.lower, !!queryParam.lowerOpen);
              } else if (queryParam.upper !== undefined) {
                keyRange = IDBKeyRange.upperBound(queryParam.upper, !!queryParam.upperOpen);
              }
            } catch(e) {
              db.close();
              reject(new Error('Invalid key range: ' + e.message));
              return;
            }
          }

          var records = [];
          var cursorReq = keyRange ? objectStore.openCursor(keyRange) : objectStore.openCursor();

          cursorReq.onerror = function() {
            db.close();
            reject(new Error('Cursor error on store: ' + storeName));
          };

          cursorReq.onsuccess = function(event) {
            var cursor = event.target.result;
            if (cursor && records.length < limit) {
              records.push({ key: cursor.key, value: cursor.value });
              cursor.continue();
            } else {
              db.close();
              resolve({ records: records, count: records.length, database: dbName, store: storeName });
            }
          };
        };
      });
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'IndexedDB get failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { records: [], count: 0 }, Date.now() - start);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private makeResponse(data: unknown, latencyMs: number = 0): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript' as Engine, degraded: false, latencyMs },
    };
  }
}
