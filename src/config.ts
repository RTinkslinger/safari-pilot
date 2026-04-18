import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── SafariPilotConfig ───────────────────────────────────────────────────────
//
// Typed configuration for all tunable Safari Pilot settings.
// Loaded from safari-pilot.config.json at startup; missing keys fall back to
// sensible defaults. Security-critical values (tab ownership, IDPI patterns,
// extension bundle ID) are intentionally NOT configurable.

export interface RateLimitConfig {
  maxActionsPerMinute: number;
  windowMs: number;
}

export interface CircuitBreakerConfig {
  errorThreshold: number;
  windowMs: number;
  cooldownMs: number;
}

export interface DomainPolicyConfig {
  defaultMaxActionsPerMinute: number;
  blocked: string[];
  trusted: string[];
}

export interface KillSwitchConfig {
  autoActivation: boolean;
  maxErrors: number;
  windowSeconds: number;
}

export interface AuditConfig {
  maxEntries: number;
  logPath: string;
}

export interface DaemonConfig {
  timeoutMs: number;
}

export interface HealthCheckConfig {
  timeoutMs: number;
}

export interface ExtensionConfig {
  enabled: boolean;
  killSwitchVersion: string;
}

export interface SafariPilotConfig {
  schemaVersion: string;
  rateLimit: RateLimitConfig;
  circuitBreaker: CircuitBreakerConfig;
  domainPolicy: DomainPolicyConfig;
  killSwitch: KillSwitchConfig;
  audit: AuditConfig;
  daemon: DaemonConfig;
  healthCheck: HealthCheckConfig;
  extension: ExtensionConfig;
}

export const DEFAULT_CONFIG: SafariPilotConfig = {
  schemaVersion: '1.0',
  rateLimit: {
    maxActionsPerMinute: 120,
    windowMs: 60_000,
  },
  circuitBreaker: {
    errorThreshold: 5,
    windowMs: 60_000,
    cooldownMs: 120_000,
  },
  domainPolicy: {
    defaultMaxActionsPerMinute: 60,
    blocked: [],
    trusted: [],
  },
  killSwitch: {
    autoActivation: false,
    maxErrors: 5,
    windowSeconds: 60,
  },
  audit: {
    maxEntries: 10_000,
    logPath: '~/.safari-pilot/audit.log',
  },
  daemon: {
    timeoutMs: 30_000,
  },
  healthCheck: {
    timeoutMs: 3_000,
  },
  extension: {
    enabled: true,
    killSwitchVersion: '0.1.5',
  },
};

// ─── Deep merge ──────────────────────────────────────────────────────────────

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (!(key in base)) continue;
    const baseVal = (base as Record<string, unknown>)[key];
    const overVal = override[key];
    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      (result as Record<string, unknown>)[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal,
      );
    } else if (overVal !== undefined) {
      (result as Record<string, unknown>)[key] = overVal;
    }
  }
  return result;
}

// ─── Validation ──────────────────────────────────────────────────────────────

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

function assertPositiveNumber(path: string, value: unknown): void {
  if (typeof value !== 'number' || value <= 0 || !Number.isFinite(value)) {
    throw new ConfigValidationError(`${path} must be a positive number, got ${JSON.stringify(value)}`);
  }
}

function assertBoolean(path: string, value: unknown): void {
  if (typeof value !== 'boolean') {
    throw new ConfigValidationError(`${path} must be a boolean, got ${JSON.stringify(value)}`);
  }
}

function assertStringArray(path: string, value: unknown): void {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new ConfigValidationError(`${path} must be an array of strings`);
  }
}

function assertString(path: string, value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigValidationError(`${path} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
}

function assertSection(path: string, value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ConfigValidationError(`${path} must be an object, got ${JSON.stringify(value)}`);
  }
}

function validate(config: SafariPilotConfig): void {
  if (config.schemaVersion !== '1.0') {
    throw new ConfigValidationError(
      `Unsupported schemaVersion "${config.schemaVersion}". Expected "1.0".`,
    );
  }

  assertSection('rateLimit', config.rateLimit);
  assertPositiveNumber('rateLimit.maxActionsPerMinute', config.rateLimit.maxActionsPerMinute);
  assertPositiveNumber('rateLimit.windowMs', config.rateLimit.windowMs);

  assertSection('circuitBreaker', config.circuitBreaker);
  assertPositiveNumber('circuitBreaker.errorThreshold', config.circuitBreaker.errorThreshold);
  assertPositiveNumber('circuitBreaker.windowMs', config.circuitBreaker.windowMs);
  assertPositiveNumber('circuitBreaker.cooldownMs', config.circuitBreaker.cooldownMs);

  assertSection('domainPolicy', config.domainPolicy);
  assertPositiveNumber('domainPolicy.defaultMaxActionsPerMinute', config.domainPolicy.defaultMaxActionsPerMinute);
  assertStringArray('domainPolicy.blocked', config.domainPolicy.blocked);
  assertStringArray('domainPolicy.trusted', config.domainPolicy.trusted);

  assertSection('killSwitch', config.killSwitch);
  assertBoolean('killSwitch.autoActivation', config.killSwitch.autoActivation);
  assertPositiveNumber('killSwitch.maxErrors', config.killSwitch.maxErrors);
  assertPositiveNumber('killSwitch.windowSeconds', config.killSwitch.windowSeconds);

  assertSection('audit', config.audit);
  assertPositiveNumber('audit.maxEntries', config.audit.maxEntries);
  assertString('audit.logPath', config.audit.logPath);

  assertSection('daemon', config.daemon);
  assertPositiveNumber('daemon.timeoutMs', config.daemon.timeoutMs);

  assertSection('healthCheck', config.healthCheck);
  assertPositiveNumber('healthCheck.timeoutMs', config.healthCheck.timeoutMs);

  assertSection('extension', config.extension);
  assertBoolean('extension.enabled', config.extension.enabled);
  assertString('extension.killSwitchVersion', config.extension.killSwitchVersion);
}

// ─── Path resolution ─────────────────────────────────────────────────────────

function resolveTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1));
  }
  return p;
}

function resolveConfigPaths(config: SafariPilotConfig): SafariPilotConfig {
  return {
    ...config,
    audit: {
      ...config.audit,
      logPath: resolveTilde(config.audit.logPath),
    },
  };
}

// ─── Loader ──────────────────────────────────────────────────────────────────

function getPackageRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(dirname(thisFile), '..');
}

export function loadConfig(configPath?: string): SafariPilotConfig {
  const path = configPath
    ?? process.env['SAFARI_PILOT_CONFIG']
    ?? join(getPackageRoot(), 'safari-pilot.config.json');

  let userConfig: Record<string, unknown> = {};

  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new ConfigValidationError('Config file must contain a JSON object');
    }
    userConfig = parsed;
  } catch (err) {
    if (err instanceof ConfigValidationError) throw err;
    if (err instanceof SyntaxError) {
      throw new ConfigValidationError(`Invalid JSON in config file: ${err.message}`);
    }
    // File not found or unreadable → use defaults silently
  }

  const merged = deepMerge(
    DEFAULT_CONFIG as unknown as Record<string, unknown>,
    userConfig,
  ) as unknown as SafariPilotConfig;

  validate(merged);

  return deepFreeze(resolveConfigPaths(merged));
}

function deepFreeze<T extends object>(obj: T): Readonly<T> {
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (typeof val === 'object' && val !== null && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}
