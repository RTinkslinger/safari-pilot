import type { AuditEntry } from '../types.js';

// ─── AuditLog ─────────────────────────────────────────────────────────────────
//
// In-memory append log for every tool call executed in this agent session.
// Sensitive parameter values are redacted before storage so logs are safe to
// write to disk or transmit.

export interface AuditLogOptions {
  maxEntries?: number;
  logPath?: string;
}

// Tools that pass a cleartext value that should always be redacted.
const REDACT_VALUE_TOOLS = new Set([
  'safari_fill',
  'safari_set_cookie',
  'safari_clipboard_write',
]);

// Tools whose script payloads are truncated (they can be megabytes long).
const TRUNCATE_SCRIPT_TOOLS = new Set([
  'safari_evaluate',
]);

const SCRIPT_MAX_LEN = 200;

export class AuditLog {
  private entries: AuditEntry[] = [];
  private readonly maxEntries: number;
  readonly logPath: string | undefined;

  constructor(options: AuditLogOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
    this.logPath = options.logPath;
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Record a tool invocation. timestamp is auto-injected; all other fields
   * must be provided by the caller.
   */
  record(entry: Omit<AuditEntry, 'timestamp'>): void {
    const redactedParams = this.redactParams(entry.tool, { ...entry.params });

    const fullEntry: AuditEntry = {
      ...entry,
      params: redactedParams,
      timestamp: new Date().toISOString(),
    };

    this.entries.push(fullEntry);

    // Evict oldest entries if over the cap
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /**
   * Return entries, optionally limited to the most-recent `limit` entries.
   */
  getEntries(limit?: number): AuditEntry[] {
    if (limit !== undefined && limit > 0) {
      return this.entries.slice(-limit);
    }
    return [...this.entries];
  }

  getEntriesForSession(session: string): AuditEntry[] {
    return this.entries.filter((e) => e.session === session);
  }

  clear(): void {
    this.entries = [];
  }

  // ── Redaction ───────────────────────────────────────────────────────────────

  private redactParams(
    tool: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    // Redact cleartext value fields (passwords, cookie values, clipboard)
    if (REDACT_VALUE_TOOLS.has(tool) && 'value' in params) {
      params['value'] = '[REDACTED]';
    }

    // Truncate long script payloads to keep log files manageable
    if (TRUNCATE_SCRIPT_TOOLS.has(tool) && typeof params['script'] === 'string') {
      const script = params['script'] as string;
      if (script.length > SCRIPT_MAX_LEN) {
        params['script'] = script.slice(0, SCRIPT_MAX_LEN) + '...';
      }
    }

    return params;
  }
}
