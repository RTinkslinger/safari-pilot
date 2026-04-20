import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_TRACE_DIR = join(tmpdir(), `safari-pilot-trace-test-${Date.now()}`);
process.env['SAFARI_PILOT_TRACE_DIR'] = TEST_TRACE_DIR;

const { trace } = await import('../../src/trace.js');

describe('trace', () => {
  const traceFile = join(TEST_TRACE_DIR, 'trace.ndjson');

  afterEach(() => {
    try { unlinkSync(traceFile); } catch { /* may not exist */ }
  });

  it('appends NDJSON line to trace file', () => {
    trace('req-test-1', 'server', 'tool_received', { tool: 'safari_click' });
    const content = readFileSync(traceFile, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]);
    expect(event.id).toBe('req-test-1');
    expect(event.layer).toBe('server');
    expect(event.event).toBe('tool_received');
    expect(event.data.tool).toBe('safari_click');
    expect(event.level).toBe('event');
    expect(event.ts).toBeDefined();
  });

  it('supports error level', () => {
    trace('req-test-2', 'server', 'ownership_rejected', { tabUrl: 'https://evil.com' }, 'error');
    const content = readFileSync(traceFile, 'utf-8');
    const event = JSON.parse(content.trim());
    expect(event.level).toBe('error');
  });

  it('includes elapsed_ms when provided', () => {
    trace('req-test-3', 'server', 'tool_result', { ok: true }, 'event', 42);
    const content = readFileSync(traceFile, 'utf-8');
    const event = JSON.parse(content.trim());
    expect(event.elapsed_ms).toBe(42);
  });

  it('omits elapsed_ms when not provided', () => {
    trace('req-test-4', 'server', 'engine_selected', { engine: 'extension' });
    const content = readFileSync(traceFile, 'utf-8');
    const event = JSON.parse(content.trim());
    expect(event.elapsed_ms).toBeUndefined();
  });

  it('appends multiple events to same file', () => {
    trace('req-test-5', 'server', 'event_a', {});
    trace('req-test-5', 'server', 'event_b', {});
    const content = readFileSync(traceFile, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('silently handles write failure (never throws)', () => {
    expect(() => {
      trace('req-test-6', 'server', 'test', { circular: undefined });
    }).not.toThrow();
  });
});
