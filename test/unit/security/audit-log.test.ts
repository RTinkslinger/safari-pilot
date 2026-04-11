import { describe, it, expect, beforeEach } from 'vitest';
import { AuditLog } from '../../../src/security/audit-log.js';

describe('AuditLog', () => {
  let log: AuditLog;

  beforeEach(() => {
    log = new AuditLog({ maxEntries: 100 });
  });

  it('records entries', () => {
    log.record({
      tool: 'safari_navigate',
      tabUrl: 'https://example.com',
      engine: 'applescript',
      params: { url: 'https://example.com' },
      result: 'ok',
      elapsed_ms: 80,
      session: 'sess_test',
    });
    expect(log.getEntries()).toHaveLength(1);
  });

  it('adds timestamp to entries', () => {
    log.record({
      tool: 'safari_click',
      tabUrl: 'https://example.com',
      engine: 'applescript',
      params: { selector: '#btn' },
      result: 'ok',
      elapsed_ms: 10,
      session: 'sess_test',
    });
    const entry = log.getEntries()[0];
    expect(entry.timestamp).toBeDefined();
    expect(new Date(entry.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('redacts value fields in safari_fill params', () => {
    log.record({
      tool: 'safari_fill',
      tabUrl: 'https://example.com',
      engine: 'applescript',
      params: { selector: '#password', value: 'secret123' },
      result: 'ok',
      elapsed_ms: 15,
      session: 'sess_test',
    });
    const entry = log.getEntries()[0];
    expect(entry.params['value']).toBe('[REDACTED]');
  });

  it('redacts script fields in safari_evaluate', () => {
    const longScript = 'x'.repeat(300);
    log.record({
      tool: 'safari_evaluate',
      tabUrl: 'https://example.com',
      engine: 'applescript',
      params: { script: longScript },
      result: 'ok',
      elapsed_ms: 5,
      session: 'sess_test',
    });
    const entry = log.getEntries()[0];
    expect((entry.params['script'] as string).length).toBeLessThanOrEqual(203); // 200 + "..."
  });

  it('redacts cookie values', () => {
    log.record({
      tool: 'safari_set_cookie',
      tabUrl: 'https://example.com',
      engine: 'applescript',
      params: { name: 'session', value: 'secret-token' },
      result: 'ok',
      elapsed_ms: 5,
      session: 'sess_test',
    });
    const entry = log.getEntries()[0];
    expect(entry.params['value']).toBe('[REDACTED]');
  });

  it('respects maxEntries limit', () => {
    const smallLog = new AuditLog({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      smallLog.record({
        tool: `safari_test_${i}`,
        tabUrl: 'https://example.com',
        engine: 'applescript',
        params: {},
        result: 'ok',
        elapsed_ms: 1,
        session: 'sess_test',
      });
    }
    expect(smallLog.getEntries()).toHaveLength(3);
  });

  it('getEntries with limit returns only the most recent N', () => {
    for (let i = 0; i < 5; i++) {
      log.record({
        tool: `safari_tool_${i}`,
        tabUrl: 'https://example.com',
        engine: 'applescript',
        params: { index: i },
        result: 'ok',
        elapsed_ms: i,
        session: 'sess_test',
      });
    }
    const recent = log.getEntries(2);
    expect(recent).toHaveLength(2);
    expect(recent[1].params['index']).toBe(4); // last entry
  });

  it('does not redact non-sensitive params in safari_fill', () => {
    log.record({
      tool: 'safari_fill',
      tabUrl: 'https://example.com',
      engine: 'applescript',
      params: { selector: '#name', value: 'John Doe' },
      result: 'ok',
      elapsed_ms: 5,
      session: 'sess_test',
    });
    const entry = log.getEntries()[0];
    // selector is preserved; value is redacted
    expect(entry.params['selector']).toBe('#name');
    expect(entry.params['value']).toBe('[REDACTED]');
  });

  it('does not redact short script payloads', () => {
    const shortScript = 'return document.title';
    log.record({
      tool: 'safari_evaluate',
      tabUrl: 'https://example.com',
      engine: 'applescript',
      params: { script: shortScript },
      result: 'ok',
      elapsed_ms: 5,
      session: 'sess_test',
    });
    const entry = log.getEntries()[0];
    expect(entry.params['script']).toBe(shortScript);
  });

  it('filters entries by session', () => {
    log.record({
      tool: 'safari_click',
      tabUrl: 'https://a.com',
      engine: 'applescript',
      params: {},
      result: 'ok',
      elapsed_ms: 1,
      session: 'sess_A',
    });
    log.record({
      tool: 'safari_navigate',
      tabUrl: 'https://b.com',
      engine: 'applescript',
      params: {},
      result: 'ok',
      elapsed_ms: 2,
      session: 'sess_B',
    });
    const sessA = log.getEntriesForSession('sess_A');
    expect(sessA).toHaveLength(1);
    expect(sessA[0].session).toBe('sess_A');
  });
});
