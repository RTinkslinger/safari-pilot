/**
 * SD-04 unit coverage for the AuditLog post-execution layer.
 *
 * AuditLog is layer 10 of the 9-layer pipeline (the post-execution audit
 * record). Server.ts calls `auditLog.record(...)` on every tool call —
 * success and error paths both. Coverage previously: zero — deleting
 * `entries.push(...)` from the layer would leave no test failing.
 *
 * The redaction policy is a security contract:
 *   - Tools in REDACT_VALUE_TOOLS (safari_fill, safari_set_cookie,
 *     safari_clipboard_write) must have their `value` param redacted to
 *     `[REDACTED]` before storage. Without this, plaintext passwords land
 *     in the audit log.
 *   - safari_evaluate's `script` param is truncated to 200 chars so
 *     megabyte-size scripts don't bloat the log.
 *
 * Discrimination:
 *   - Comment out `entries.push(fullEntry)` → test 1 fails (no entries).
 *   - Remove the REDACT_VALUE_TOOLS branch in redactParams → test 2 fails
 *     (cleartext value lands in the log).
 *   - Remove the TRUNCATE_SCRIPT_TOOLS branch → test 3 fails (full script
 *     stored).
 */
import { describe, it, expect } from 'vitest';
import { AuditLog } from '../../../src/security/audit-log.js';
import type { Engine } from '../../../src/types.js';

const stub = {
  tabUrl: 'https://example.com',
  engine: 'extension' as Engine,
  result: 'ok' as const,
  elapsed_ms: 42,
  session: 'test-session',
};

describe('AuditLog (SD-04)', () => {
  it('record + getEntries round-trips a tool invocation', () => {
    const log = new AuditLog();
    log.record({
      ...stub,
      tool: 'safari_health_check',
      params: { verbose: true },
    });
    const entries = log.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tool).toBe('safari_health_check');
    expect(entries[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entries[0]?.params).toEqual({ verbose: true });
  });

  it('redacts the `value` parameter for REDACT_VALUE_TOOLS', () => {
    const log = new AuditLog();
    // safari_fill — cleartext form value
    log.record({
      ...stub,
      tool: 'safari_fill',
      params: { tabUrl: 'https://example.com', selector: '#pwd', value: 'super-secret-password' },
    });
    // safari_set_cookie — cleartext cookie value
    log.record({
      ...stub,
      tool: 'safari_set_cookie',
      params: { name: 'session', value: 'eyJ...super-jwt' },
    });
    // safari_clipboard_write — cleartext clipboard content
    log.record({
      ...stub,
      tool: 'safari_clipboard_write',
      params: { value: 'paste-buffer-content' },
    });

    const entries = log.getEntries();
    for (const e of entries) {
      expect(e.params['value']).toBe('[REDACTED]');
    }
  });

  it('truncates safari_evaluate scripts to 200 chars', () => {
    const log = new AuditLog();
    const longScript = 'a'.repeat(5000);
    log.record({
      ...stub,
      tool: 'safari_evaluate',
      params: { tabUrl: 'https://example.com', script: longScript },
    });
    const entry = log.getEntries()[0]!;
    const stored = entry.params['script'] as string;
    expect(stored.length).toBeLessThanOrEqual(203); // 200 + '...'
    expect(stored.endsWith('...')).toBe(true);
    expect(stored.slice(0, 200)).toBe('a'.repeat(200));
  });

  it('non-redacted tools keep their params unchanged', () => {
    const log = new AuditLog();
    log.record({
      ...stub,
      tool: 'safari_navigate',
      params: { tabUrl: 'https://a.test', url: 'https://b.test' },
    });
    const e = log.getEntries()[0]!;
    expect(e.params['url']).toBe('https://b.test');
    expect(e.params['tabUrl']).toBe('https://a.test');
  });

  it('caps entries at maxEntries (oldest evicted FIFO)', () => {
    const log = new AuditLog({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      log.record({
        ...stub,
        tool: 'safari_health_check',
        params: { i },
      });
    }
    const entries = log.getEntries();
    expect(entries).toHaveLength(3);
    // Oldest two evicted — first surviving entry is i=2
    expect(entries[0]?.params['i']).toBe(2);
    expect(entries[2]?.params['i']).toBe(4);
  });

  it('getEntriesForSession filters by session id', () => {
    const log = new AuditLog();
    log.record({ ...stub, tool: 'safari_health_check', params: {}, session: 'alpha' });
    log.record({ ...stub, tool: 'safari_health_check', params: {}, session: 'beta' });
    log.record({ ...stub, tool: 'safari_health_check', params: {}, session: 'alpha' });
    const alpha = log.getEntriesForSession('alpha');
    const beta = log.getEntriesForSession('beta');
    expect(alpha).toHaveLength(2);
    expect(beta).toHaveLength(1);
  });
});
