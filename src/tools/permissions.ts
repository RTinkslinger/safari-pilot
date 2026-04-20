import type { ToolResponse, ToolRequirements } from '../types.js';
import type { IEngine } from '../engines/engine.js';
import type { Engine } from '../types.js';
import { escapeForJsSingleQuote } from '../escape.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

const VALID_PERMISSIONS = [
  'geolocation',
  'notifications',
  'clipboard-read',
  'clipboard-write',
  'microphone',
  'camera',
  'payment-handler',
  'background-sync',
  'persistent-storage',
];

export class PermissionTools {
  private engine: IEngine;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: IEngine) {
    this.engine = engine;
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.handlers.set('safari_permission_get', this.handlePermissionGet.bind(this));
    this.handlers.set('safari_permission_set', this.handlePermissionSet.bind(this));
    this.handlers.set('safari_override_geolocation', this.handleOverrideGeolocation.bind(this));
    this.handlers.set('safari_override_timezone', this.handleOverrideTimezone.bind(this));
    this.handlers.set('safari_override_locale', this.handleOverrideLocale.bind(this));
    this.handlers.set('safari_override_useragent', this.handleOverrideUserAgent.bind(this));
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_permission_get',
        description:
          'Query the current permission state for a given API (e.g. geolocation, notifications). ' +
          'Uses the Permissions API (navigator.permissions.query) to return "granted", "denied", or "prompt".',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            permission: {
              type: 'string',
              enum: VALID_PERMISSIONS,
              description: 'Permission name to query',
            },
          },
          required: ['tabUrl', 'permission'],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_permission_set',
        description:
          'Attempt to set a browser permission. Note: Safari does not support programmatic permission ' +
          'granting via WebDriver or JavaScript. This tool returns guidance on how to configure ' +
          'permissions through Safari Settings instead.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            permission: {
              type: 'string',
              enum: VALID_PERMISSIONS,
              description: 'Permission name to configure',
            },
            state: {
              type: 'string',
              enum: ['granted', 'denied', 'prompt'],
              description: 'Desired permission state',
            },
          },
          required: ['tabUrl', 'permission', 'state'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_override_geolocation',
        description:
          'Override the browser\'s geolocation to return a fixed position. Patches navigator.geolocation.getCurrentPosition ' +
          'and watchPosition to return the specified coordinates. The override persists until the page navigates away.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            latitude: { type: 'number', description: 'Latitude in decimal degrees (-90 to 90)' },
            longitude: { type: 'number', description: 'Longitude in decimal degrees (-180 to 180)' },
            accuracy: { type: 'number', description: 'Position accuracy in metres', default: 10 },
          },
          required: ['tabUrl', 'latitude', 'longitude'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_override_timezone',
        description:
          'Override the timezone used by Intl.DateTimeFormat and Date operations. Patches ' +
          'Intl.DateTimeFormat to default to the specified IANA timezone string. Useful for testing ' +
          'locale-sensitive date/time rendering.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            timezone: {
              type: 'string',
              description: 'IANA timezone identifier, e.g. "America/New_York", "Asia/Tokyo", "UTC"',
            },
          },
          required: ['tabUrl', 'timezone'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_override_locale',
        description:
          'Override the browser locale reported by navigator.language and navigator.languages. ' +
          'Patches these properties so that locale-sensitive UI and formatting reflects the ' +
          'specified locale.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            locale: {
              type: 'string',
              description: 'BCP 47 language tag, e.g. "en-US", "fr-FR", "ja-JP"',
            },
          },
          required: ['tabUrl', 'locale'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_override_useragent',
        description:
          'Override the User-Agent string reported by navigator.userAgent. Patches the property ' +
          'so that UA-sniffing code sees the specified string. Does not affect the HTTP header ' +
          'sent to the server (that requires a network-layer proxy).',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            userAgent: {
              type: 'string',
              description: 'Full User-Agent string to report to scripts, e.g. a Chrome or mobile UA',
            },
          },
          required: ['tabUrl', 'userAgent'],
        },
        requirements: { idempotent: false },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handlePermissionGet(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const permission = params['permission'] as string;

    const escapedPermission = escapeForJsSingleQuote(permission);

    const js = `
      if (!navigator.permissions) {
        return { permission: '${escapedPermission}', state: 'unsupported', error: 'Permissions API not available' };
      }
      try {
        var result = await navigator.permissions.query({ name: '${escapedPermission}' });
        return { permission: '${escapedPermission}', state: result.state };
      } catch (e) {
        return { permission: '${escapedPermission}', state: 'unknown', error: e.message };
      }
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Permission query failed');

    return this.makeResponse(
      result.value ? JSON.parse(result.value) : { permission, state: 'unknown' },
      Date.now() - start,
    );
  }

  private async handlePermissionSet(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const permission = params['permission'] as string;
    const state = params['state'] as string;

    // Safari does not support programmatic permission setting — return guidance
    const guidance = {
      permission,
      requestedState: state,
      supported: false,
      message:
        'Safari does not allow programmatic permission granting via JavaScript or WebDriver. ' +
        'To configure permissions: open Safari > Settings > Websites and locate the relevant ' +
        'permission category (e.g. Location, Notifications, Camera). Set the permission for ' +
        'the specific site there, then reload the page.',
      alternatives: [
        'Use Safari Settings > Websites to grant/deny permissions per site',
        'For automated testing, use a WebDriver-based approach with safari --enable-automation',
        'For geolocation specifically, use safari_override_geolocation to mock coordinates instead',
      ],
    };

    return this.makeResponse(guidance, Date.now() - start);
  }

  private async handleOverrideGeolocation(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const latitude = params['latitude'] as number;
    const longitude = params['longitude'] as number;
    const accuracy = typeof params['accuracy'] === 'number' ? params['accuracy'] : 10;

    const js = `
      var _overridePosition = {
        coords: {
          latitude: ${latitude},
          longitude: ${longitude},
          accuracy: ${accuracy},
          altitude: null,
          altitudeAccuracy: null,
          heading: null,
          speed: null,
        },
        timestamp: Date.now(),
      };

      navigator.geolocation.getCurrentPosition = function(success, _error, _options) {
        success(_overridePosition);
      };

      navigator.geolocation.watchPosition = function(success, _error, _options) {
        success(_overridePosition);
        return 0;
      };

      return {
        overridden: true,
        position: {
          latitude: ${latitude},
          longitude: ${longitude},
          accuracy: ${accuracy},
        },
      };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Geolocation override failed');

    return this.makeResponse(
      result.value ? JSON.parse(result.value) : { overridden: true, position: { latitude, longitude, accuracy } },
      Date.now() - start,
    );
  }

  private async handleOverrideTimezone(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const timezone = params['timezone'] as string;

    const escapedTimezone = timezone.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const js = `
      var _OriginalDateTimeFormat = Intl.DateTimeFormat;

      Intl.DateTimeFormat = function(locales, options) {
        options = options || {};
        if (!options.timeZone) {
          options.timeZone = '${escapedTimezone}';
        }
        return new _OriginalDateTimeFormat(locales, options);
      };

      Intl.DateTimeFormat.prototype = _OriginalDateTimeFormat.prototype;
      Intl.DateTimeFormat.supportedLocalesOf = _OriginalDateTimeFormat.supportedLocalesOf.bind(_OriginalDateTimeFormat);

      return { overridden: true, timezone: '${escapedTimezone}' };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Timezone override failed');

    return this.makeResponse(
      result.value ? JSON.parse(result.value) : { overridden: true, timezone },
      Date.now() - start,
    );
  }

  private async handleOverrideLocale(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const locale = params['locale'] as string;

    const escapedLocale = locale.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const js = `
      Object.defineProperty(navigator, 'language', {
        get: function() { return '${escapedLocale}'; },
        configurable: true,
      });

      Object.defineProperty(navigator, 'languages', {
        get: function() { return ['${escapedLocale}']; },
        configurable: true,
      });

      return { overridden: true, locale: '${escapedLocale}' };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Locale override failed');

    return this.makeResponse(
      result.value ? JSON.parse(result.value) : { overridden: true, locale },
      Date.now() - start,
    );
  }

  private async handleOverrideUserAgent(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const userAgent = params['userAgent'] as string;

    const escapedUserAgent = userAgent.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const js = `
      Object.defineProperty(navigator, 'userAgent', {
        get: function() { return '${escapedUserAgent}'; },
        configurable: true,
      });

      return { overridden: true, userAgent: '${escapedUserAgent}' };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'User-Agent override failed');

    return this.makeResponse(
      result.value ? JSON.parse(result.value) : { overridden: true, userAgent },
      Date.now() - start,
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private makeResponse(data: unknown, latencyMs: number = 0): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript' as Engine, degraded: false, latencyMs },
    };
  }
}
