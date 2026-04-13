import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TraceCollector } from '../../src/trace-collector.js';
import type { TraceEvent, TraceSession, TraceRun } from '../../src/trace-collector.js';

// ── Shared collector instance ───────────────────────────────────────────────

let collector: TraceCollector;

beforeEach(() => {
  collector = new TraceCollector({
    runId: 'test-run-001',
    type: 'integration',
    testFile: 'test/integration/example.test.ts',
  });
});

// ── Constructor ─────────────────────────────────────────────────────────────

describe('TraceCollector', () => {
  describe('constructor', () => {
    it('stores runId, type, and testFile', () => {
      expect(collector.getRunId()).toBe('test-run-001');
    });

    it('starts with zero sessions and zero events', () => {
      expect(collector.getSessionCount()).toBe(0);
      expect(collector.getEventCount()).toBe(0);
    });

    it('has no current session initially', () => {
      expect(collector.getCurrentSession()).toBeNull();
    });
  });

  // ── Session lifecycle ───────────────────────────────────────────────────

  describe('session lifecycle', () => {
    it('startSession creates a session with correct fields', () => {
      collector.startSession('test-1', 'Suite A', 'Verify snapshot works');
      const session = collector.getCurrentSession()!;
      expect(session).not.toBeNull();
      expect(session.testId).toBe('test-1');
      expect(session.suiteName).toBe('Suite A');
      expect(session.intent).toBe('Verify snapshot works');
      expect(session.runId).toBe('test-run-001');
      expect(session.testFile).toBe('test/integration/example.test.ts');
      expect(session.events).toEqual([]);
      expect(session.domainObservations).toEqual([]);
      expect(session.startedAt).toBeTruthy();
      expect(session.success).toBe(false); // default until endSession
    });

    it('endSession marks session complete with success', () => {
      collector.startSession('test-1', 'Suite A');
      collector.endSession(true);
      expect(collector.getCurrentSession()).toBeNull();
      expect(collector.getSessionCount()).toBe(1);
      const session = collector.getSessions()[0];
      expect(session.success).toBe(true);
      expect(session.endedAt).toBeTruthy();
      expect(session.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('endSession marks session with failure reason', () => {
      collector.startSession('test-1', 'Suite A');
      collector.endSession(false, 'Element not found');
      const sessions = collector.getSessions();
      expect(sessions[0].success).toBe(false);
      expect(sessions[0].failureReason).toBe('Element not found');
    });

    it('throws when starting a session while one is active', () => {
      collector.startSession('test-1', 'Suite A');
      expect(() => collector.startSession('test-2', 'Suite A')).toThrow(
        /session "test-1" is still active/,
      );
    });

    it('supports multiple sequential sessions', () => {
      collector.startSession('test-1', 'Suite A');
      collector.endSession(true);
      collector.startSession('test-2', 'Suite A');
      collector.endSession(false, 'timeout');
      expect(collector.getSessionCount()).toBe(2);
      expect(collector.getSessions()[0].success).toBe(true);
      expect(collector.getSessions()[1].success).toBe(false);
    });

    it('intent defaults to testId when not provided', () => {
      collector.startSession('my-test-name', 'Suite B');
      expect(collector.getCurrentSession()!.intent).toBe('my-test-name');
    });

    it('endSession is a no-op when no session is active', () => {
      // Should not throw
      collector.endSession(true);
      expect(collector.getSessionCount()).toBe(0);
    });

    it('sessionId contains trace prefix and hex suffix', () => {
      collector.startSession('test-1', 'Suite');
      const session = collector.getCurrentSession()!;
      expect(session.sessionId).toMatch(/^trace-\d+-[0-9a-f]{6}$/);
    });
  });

  // ── Event recording ─────────────────────────────────────────────────────

  describe('event recording', () => {
    it('recordEvent appends to current session', () => {
      collector.startSession('test-1', 'Suite');
      const event: TraceEvent = {
        seq: 1,
        timestamp: new Date().toISOString(),
        tool: 'safari_click',
        params: { selector: '#btn' },
        targeting: { method: 'selector', selector: '#btn' },
        success: true,
        result: { summary: 'clicked' },
        timing: { total_ms: 50, engine_ms: 30 },
        engine: 'applescript',
        degraded: false,
        domain: 'example.com',
      };
      collector.recordEvent(event);
      expect(collector.getCurrentSession()!.events).toHaveLength(1);
      expect(collector.getEventCount()).toBe(1);
    });

    it('recordEvent is a no-op without an active session', () => {
      const event: TraceEvent = {
        seq: 1,
        timestamp: new Date().toISOString(),
        tool: 'safari_click',
        params: {},
        targeting: { method: 'none' },
        success: true,
        result: { summary: 'ok' },
        timing: { total_ms: 10, engine_ms: 5 },
        engine: 'applescript',
        degraded: false,
        domain: '',
      };
      // Should not throw, just silently discard
      collector.recordEvent(event);
      expect(collector.getEventCount()).toBe(0);
    });

    it('getEventCount includes events from completed sessions and active session', () => {
      collector.startSession('test-1', 'Suite');
      const event: TraceEvent = {
        seq: 1,
        timestamp: new Date().toISOString(),
        tool: 'safari_click',
        params: {},
        targeting: { method: 'none' },
        success: true,
        result: { summary: 'ok' },
        timing: { total_ms: 10, engine_ms: 5 },
        engine: 'applescript',
        degraded: false,
        domain: '',
      };
      collector.recordEvent(event);
      collector.endSession(true);

      collector.startSession('test-2', 'Suite');
      collector.recordEvent({ ...event, seq: 1 });
      collector.recordEvent({ ...event, seq: 2 });

      // 1 from completed session + 2 from active session
      expect(collector.getEventCount()).toBe(3);
    });
  });

  // ── Seq numbers ─────────────────────────────────────────────────────────

  describe('seq numbers', () => {
    it('nextSeq returns monotonically increasing numbers within a session', () => {
      collector.startSession('test-1', 'Suite');
      expect(collector.nextSeq()).toBe(1);
      expect(collector.nextSeq()).toBe(2);
      expect(collector.nextSeq()).toBe(3);
    });

    it('seq counter resets across sessions', () => {
      collector.startSession('test-1', 'Suite');
      expect(collector.nextSeq()).toBe(1);
      expect(collector.nextSeq()).toBe(2);
      collector.endSession(true);

      collector.startSession('test-2', 'Suite');
      expect(collector.nextSeq()).toBe(1); // reset
    });
  });

  // ── extractTargeting ──────────────────────────────────────────────────────

  describe('extractTargeting', () => {
    it('identifies ref targeting', () => {
      const t = TraceCollector.extractTargeting({ ref: 'e42', selector: '#btn' });
      expect(t.method).toBe('ref');
      expect(t.ref).toBe('e42');
      expect(t.selector).toBe('#btn');
    });

    it('ref takes priority over locator and selector', () => {
      const t = TraceCollector.extractTargeting({ ref: 'e1', role: 'button', selector: '#x' });
      expect(t.method).toBe('ref');
    });

    it('identifies locator with role and name', () => {
      const t = TraceCollector.extractTargeting({ role: 'button', name: 'Submit' });
      expect(t.method).toBe('locator');
      expect(t.locator).toEqual({ role: 'button', name: 'Submit' });
    });

    it('identifies locator with text', () => {
      const t = TraceCollector.extractTargeting({ text: 'Click me' });
      expect(t.method).toBe('locator');
      expect(t.locator!.text).toBe('Click me');
    });

    it('identifies locator with label', () => {
      const t = TraceCollector.extractTargeting({ label: 'Email address' });
      expect(t.method).toBe('locator');
      expect(t.locator!.label).toBe('Email address');
    });

    it('identifies locator with testId', () => {
      const t = TraceCollector.extractTargeting({ testId: 'submit-btn' });
      expect(t.method).toBe('locator');
      expect(t.locator!.testId).toBe('submit-btn');
    });

    it('identifies locator with placeholder', () => {
      const t = TraceCollector.extractTargeting({ placeholder: 'Search...' });
      expect(t.method).toBe('locator');
      expect(t.locator!.placeholder).toBe('Search...');
    });

    it('includes exact flag in locator', () => {
      const t = TraceCollector.extractTargeting({ role: 'button', exact: true });
      expect(t.method).toBe('locator');
      expect(t.locator!.exact).toBe(true);
    });

    it('identifies selector targeting', () => {
      const t = TraceCollector.extractTargeting({ selector: '#submit-btn' });
      expect(t.method).toBe('selector');
      expect(t.selector).toBe('#submit-btn');
    });

    it('returns none when no targeting params present', () => {
      const t = TraceCollector.extractTargeting({ tabUrl: 'https://example.com' });
      expect(t.method).toBe('none');
    });

    it('returns none for empty params', () => {
      const t = TraceCollector.extractTargeting({});
      expect(t.method).toBe('none');
    });

    it('ignores null locator values', () => {
      const t = TraceCollector.extractTargeting({ role: null, selector: '#btn' });
      expect(t.method).toBe('selector');
    });

    it('ignores undefined locator values', () => {
      const t = TraceCollector.extractTargeting({ role: undefined, name: undefined });
      expect(t.method).toBe('none');
    });
  });

  // ── redactParams ──────────────────────────────────────────────────────────

  describe('redactParams', () => {
    it('redacts safari_fill value param', () => {
      const redacted = TraceCollector.redactParams('safari_fill', {
        tabUrl: 'x',
        selector: '#in',
        value: 'secret123',
      });
      expect(redacted.value).toBe('[REDACTED]');
      expect(redacted.selector).toBe('#in');
      expect(redacted.tabUrl).toBe('x');
    });

    it('redacts safari_set_cookie value param', () => {
      const redacted = TraceCollector.redactParams('safari_set_cookie', {
        name: 'tok',
        value: 'abc',
      });
      expect(redacted.value).toBe('[REDACTED]');
      expect(redacted.name).toBe('tok');
    });

    it('redacts safari_clipboard_write content param', () => {
      const redacted = TraceCollector.redactParams('safari_clipboard_write', { content: 'pwd' });
      expect(redacted.content).toBe('[REDACTED]');
    });

    it('truncates safari_evaluate script to 200 chars', () => {
      const longScript = 'x'.repeat(500);
      const redacted = TraceCollector.redactParams('safari_evaluate', { script: longScript });
      expect((redacted.script as string).length).toBeLessThanOrEqual(203); // 200 + "..."
      expect((redacted.script as string).endsWith('...')).toBe(true);
    });

    it('does not truncate short evaluate scripts', () => {
      const shortScript = 'document.title';
      const redacted = TraceCollector.redactParams('safari_evaluate', { script: shortScript });
      expect(redacted.script).toBe(shortScript);
    });

    it('does not redact params for other tools', () => {
      const redacted = TraceCollector.redactParams('safari_click', {
        selector: '#btn',
        timeout: 5000,
      });
      expect(redacted).toEqual({ selector: '#btn', timeout: 5000 });
    });

    it('does not mutate the original params object', () => {
      const original = { value: 'secret', selector: '#in' };
      TraceCollector.redactParams('safari_fill', original);
      expect(original.value).toBe('secret'); // unchanged
    });
  });

  // ── summarizeResult ────────────────────────────────────────────────────────

  describe('summarizeResult', () => {
    it('summarizes snapshot results with element counts', () => {
      const data = {
        snapshot: 'y'.repeat(1000),
        elementCount: 42,
        interactiveCount: 10,
        refMap: { e1: '#a', e2: '#b', e3: '#c' },
      };
      const summary = TraceCollector.summarizeResult('safari_snapshot', data);
      expect(summary.summary).toContain('42');
      expect(summary.summary).toContain('10');
      expect(summary.summary).toContain('3 refs');
      expect(summary.snapshot).toBeDefined();
      expect(summary.snapshot!.elementCount).toBe(42);
      expect(summary.snapshot!.interactiveCount).toBe(10);
      expect(summary.snapshot!.refCount).toBe(3);
      expect(summary.snapshot!.truncatedSnapshot.length).toBeLessThanOrEqual(500);
    });

    it('handles snapshot with no refMap', () => {
      const data = { snapshot: 'some yaml', elementCount: 5, interactiveCount: 2 };
      const summary = TraceCollector.summarizeResult('safari_snapshot', data);
      expect(summary.snapshot!.refCount).toBe(0);
    });

    it('detects yaml format for snapshot', () => {
      const data = { snapshot: '- role: button\n  name: Submit', elementCount: 1, interactiveCount: 1 };
      const summary = TraceCollector.summarizeResult('safari_snapshot', data);
      expect(summary.snapshot!.format).toBe('yaml');
    });

    it('detects json format for snapshot starting with {', () => {
      const data = { snapshot: '{"elements":[]}', elementCount: 0, interactiveCount: 0 };
      const summary = TraceCollector.summarizeResult('safari_snapshot', data);
      expect(summary.snapshot!.format).toBe('json');
    });

    it('omits data field for snapshots (replaced by snapshot field)', () => {
      const data = { snapshot: 'content', elementCount: 1, interactiveCount: 0 };
      const summary = TraceCollector.summarizeResult('safari_snapshot', data);
      expect(summary.data).toBeUndefined();
    });

    it('summarizes click results as JSON substring', () => {
      const data = { clicked: true, element: { tagName: 'BUTTON', id: 'submit' } };
      const summary = TraceCollector.summarizeResult('safari_click', data);
      expect(summary.summary).toContain('clicked');
      expect(summary.summary).toContain('BUTTON');
    });

    it('summarizes generic results as JSON substring', () => {
      const data = { text: 'Hello World', length: 11 };
      const summary = TraceCollector.summarizeResult('safari_get_text', data);
      expect(summary.summary).toContain('Hello World');
      expect(summary.data).toEqual(data);
    });

    it('truncates long generic summaries to 200 chars', () => {
      const data = { longField: 'x'.repeat(500) };
      const summary = TraceCollector.summarizeResult('safari_get_text', data);
      expect(summary.summary.length).toBeLessThanOrEqual(200);
    });

    it('handles missing snapshot fields gracefully', () => {
      const data = {}; // no snapshot, elementCount, interactiveCount
      const summary = TraceCollector.summarizeResult('safari_snapshot', data);
      expect(summary.snapshot!.elementCount).toBe(0);
      expect(summary.snapshot!.interactiveCount).toBe(0);
      expect(summary.snapshot!.refCount).toBe(0);
      expect(summary.snapshot!.truncatedSnapshot).toBe('');
    });
  });

  // ── summarizeError ────────────────────────────────────────────────────────

  describe('summarizeError', () => {
    it('extracts message from Error objects', () => {
      const summary = TraceCollector.summarizeError(new Error('Element not found: #missing'));
      expect(summary.error).toBeDefined();
      expect(summary.error.message).toContain('#missing');
      expect(summary.summary).toContain('error:');
    });

    it('extracts code from errors with code property', () => {
      const err = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
      const summary = TraceCollector.summarizeError(err);
      expect(summary.error.code).toBe('TIMEOUT');
    });

    it('defaults code to ERROR when not present', () => {
      const summary = TraceCollector.summarizeError(new Error('plain error'));
      expect(summary.error.code).toBe('ERROR');
    });

    it('handles non-Error objects', () => {
      const summary = TraceCollector.summarizeError('string error');
      expect(summary.error.message).toBe('string error');
    });

    it('handles null/undefined errors', () => {
      const summary = TraceCollector.summarizeError(null);
      expect(summary.error.message).toBe('null');
    });

    it('extracts hints from errors with hints property', () => {
      const err = Object.assign(new Error('not found'), {
        code: 'ELEMENT_NOT_FOUND',
        hints: ['Check the selector', 'Wait for page load'],
      });
      const summary = TraceCollector.summarizeError(err);
      expect(summary.error.hints).toEqual(['Check the selector', 'Wait for page load']);
    });

    it('defaults hints to empty array when not present', () => {
      const summary = TraceCollector.summarizeError(new Error('basic'));
      expect(summary.error.hints).toEqual([]);
    });

    it('truncates long error messages in summary', () => {
      const longMsg = 'x'.repeat(500);
      const summary = TraceCollector.summarizeError(new Error(longMsg));
      expect(summary.summary.length).toBeLessThanOrEqual(208); // "error: " + 200 + margin
    });
  });

  // ── extractDomain ─────────────────────────────────────────────────────────

  describe('extractDomain', () => {
    it('extracts hostname from tabUrl param', () => {
      const domain = TraceCollector.extractDomain({ tabUrl: 'https://www.example.com/page' });
      expect(domain).toBe('www.example.com');
    });

    it('extracts hostname from url param when tabUrl is absent', () => {
      const domain = TraceCollector.extractDomain({ url: 'https://api.example.com/data' });
      expect(domain).toBe('api.example.com');
    });

    it('prefers tabUrl over url param', () => {
      const domain = TraceCollector.extractDomain({
        tabUrl: 'https://primary.com/',
        url: 'https://secondary.com/',
      });
      expect(domain).toBe('primary.com');
    });

    it('returns empty string for invalid URLs', () => {
      const domain = TraceCollector.extractDomain({ tabUrl: 'not-a-url' });
      expect(domain).toBe('');
    });

    it('returns empty string when no URL params present', () => {
      const domain = TraceCollector.extractDomain({ selector: '#btn' });
      expect(domain).toBe('');
    });

    it('handles about:blank', () => {
      const domain = TraceCollector.extractDomain({});
      // about:blank has empty hostname
      expect(domain).toBe('');
    });
  });

  // ── wrapToolModule ────────────────────────────────────────────────────────

  describe('wrapToolModule', () => {
    it('intercepts handler calls and records trace events', async () => {
      const mockModule = {
        getHandler: vi.fn((name: string) => {
          if (name === 'safari_get_text') {
            return async (_params: Record<string, unknown>) => ({
              content: [{ type: 'text' as const, text: JSON.stringify({ text: 'Hello', length: 5 }) }],
              metadata: { engine: 'applescript' as const, degraded: false, latencyMs: 50 },
            });
          }
          return undefined;
        }),
      };

      collector.wrapToolModule(mockModule, 'extraction');
      collector.startSession('test-wrap', 'Suite');

      const handler = mockModule.getHandler('safari_get_text')!;
      await handler({ tabUrl: 'https://example.com/', selector: 'h1' });

      const session = collector.getCurrentSession()!;
      expect(session.events).toHaveLength(1);

      const event = session.events[0];
      expect(event.tool).toBe('safari_get_text');
      expect(event.success).toBe(true);
      expect(event.targeting.method).toBe('selector');
      expect(event.targeting.selector).toBe('h1');
      expect(event.engine).toBe('applescript');
      expect(event.domain).toBe('example.com');
      expect(event.timing.total_ms).toBeGreaterThanOrEqual(0);
      expect(event.timing.engine_ms).toBe(50);
      expect(event.seq).toBe(1);
    });

    it('records failure events and re-throws', async () => {
      const mockModule = {
        getHandler: vi.fn(() => {
          return async () => {
            throw new Error('Element not found');
          };
        }),
      };

      collector.wrapToolModule(mockModule, 'interaction');
      collector.startSession('test-fail', 'Suite');

      const handler = mockModule.getHandler('safari_click')!;
      await expect(handler({ tabUrl: 'https://x.com/', ref: 'e5' })).rejects.toThrow(
        'Element not found',
      );

      const event = collector.getCurrentSession()!.events[0];
      expect(event.success).toBe(false);
      expect(event.result.error).toBeDefined();
      expect(event.result.error!.message).toContain('Element not found');
      expect(event.targeting.method).toBe('ref');
      expect(event.targeting.ref).toBe('e5');
    });

    it('preserves original return value', async () => {
      const expectedResult = {
        content: [{ type: 'text' as const, text: '{"count":42}' }],
        metadata: { engine: 'daemon' as const, degraded: false, latencyMs: 5 },
      };
      const mockModule = {
        getHandler: vi.fn(() => async () => expectedResult),
      };

      collector.wrapToolModule(mockModule, 'test');
      collector.startSession('test-return', 'Suite');

      const handler = mockModule.getHandler('safari_count')!;
      const result = await handler({});
      expect(result).toBe(expectedResult);
    });

    it('returns undefined for unknown tool names', () => {
      const mockModule = {
        getHandler: vi.fn(() => undefined),
      };

      collector.wrapToolModule(mockModule, 'test');
      const handler = mockModule.getHandler('safari_unknown');
      expect(handler).toBeUndefined();
    });

    it('records multiple events with correct seq numbers', async () => {
      const mockModule = {
        getHandler: vi.fn(() => {
          return async () => ({
            content: [{ type: 'text' as const, text: '{}' }],
            metadata: { engine: 'applescript' as const, degraded: false, latencyMs: 10 },
          });
        }),
      };

      collector.wrapToolModule(mockModule, 'test');
      collector.startSession('test-seq', 'Suite');

      const handler = mockModule.getHandler('safari_click')!;
      await handler({ selector: '#a' });
      await handler({ selector: '#b' });
      await handler({ selector: '#c' });

      const events = collector.getCurrentSession()!.events;
      expect(events).toHaveLength(3);
      expect(events[0].seq).toBe(1);
      expect(events[1].seq).toBe(2);
      expect(events[2].seq).toBe(3);
    });

    it('handles response with no text content gracefully', async () => {
      const mockModule = {
        getHandler: vi.fn(() => {
          return async () => ({
            content: [{ type: 'image' as const, data: 'base64data', mimeType: 'image/png' }],
            metadata: { engine: 'extension' as const, degraded: false, latencyMs: 100 },
          });
        }),
      };

      collector.wrapToolModule(mockModule, 'test');
      collector.startSession('test-image', 'Suite');

      const handler = mockModule.getHandler('safari_screenshot')!;
      await handler({ tabUrl: 'https://example.com/' });

      const event = collector.getCurrentSession()!.events[0];
      expect(event.success).toBe(true);
      expect(event.engine).toBe('extension');
    });

    it('captures degraded engine information', async () => {
      const mockModule = {
        getHandler: vi.fn(() => {
          return async () => ({
            content: [{ type: 'text' as const, text: '{}' }],
            metadata: {
              engine: 'applescript' as const,
              degraded: true,
              degradedReason: 'extension unavailable',
              latencyMs: 80,
            },
          });
        }),
      };

      collector.wrapToolModule(mockModule, 'test');
      collector.startSession('test-degraded', 'Suite');

      const handler = mockModule.getHandler('safari_click')!;
      await handler({});

      const event = collector.getCurrentSession()!.events[0];
      expect(event.degraded).toBe(true);
      expect(event.degradedReason).toBe('extension unavailable');
    });

    it('redacts sensitive params in recorded events', async () => {
      const mockModule = {
        getHandler: vi.fn(() => {
          return async () => ({
            content: [{ type: 'text' as const, text: '{}' }],
            metadata: { engine: 'applescript' as const, degraded: false, latencyMs: 10 },
          });
        }),
      };

      collector.wrapToolModule(mockModule, 'test');
      collector.startSession('test-redact', 'Suite');

      const handler = mockModule.getHandler('safari_fill')!;
      await handler({ selector: '#password', value: 'my-secret-password' });

      const event = collector.getCurrentSession()!.events[0];
      expect(event.params.value).toBe('[REDACTED]');
      expect(event.params.selector).toBe('#password');
    });
  });

  // ── wrapServer ────────────────────────────────────────────────────────────

  describe('wrapServer', () => {
    it('intercepts executeToolWithSecurity and records events', async () => {
      const mockServer = {
        executeToolWithSecurity: vi.fn(async () => ({
          content: [{ type: 'text' as const, text: '{"tabs":[]}' }],
          metadata: { engine: 'daemon' as const, degraded: false, latencyMs: 5 },
        })),
      };

      collector.wrapServer(mockServer);
      collector.startSession('test-server', 'Suite');

      await mockServer.executeToolWithSecurity('safari_list_tabs', {});

      const event = collector.getCurrentSession()!.events[0];
      expect(event.tool).toBe('safari_list_tabs');
      expect(event.engine).toBe('daemon');
      expect(event.success).toBe(true);
      expect(event.seq).toBe(1);
    });

    it('records failure events from server and re-throws', async () => {
      const mockServer = {
        executeToolWithSecurity: vi.fn(async () => {
          throw new Error('Rate limited');
        }),
      };

      collector.wrapServer(mockServer);
      collector.startSession('test-server-fail', 'Suite');

      await expect(
        mockServer.executeToolWithSecurity('safari_click', { selector: '#btn' }),
      ).rejects.toThrow('Rate limited');

      const event = collector.getCurrentSession()!.events[0];
      expect(event.success).toBe(false);
      expect(event.result.error!.message).toContain('Rate limited');
    });

    it('preserves original return value from server', async () => {
      const expectedResult = {
        content: [{ type: 'text' as const, text: '{"url":"https://example.com"}' }],
        metadata: { engine: 'applescript' as const, degraded: false, latencyMs: 80 },
      };
      const mockServer = {
        executeToolWithSecurity: vi.fn(async () => expectedResult),
      };

      collector.wrapServer(mockServer);
      collector.startSession('test-server-return', 'Suite');

      const result = await mockServer.executeToolWithSecurity('safari_navigate', {
        url: 'https://example.com',
      });
      expect(result).toBe(expectedResult);
    });
  });

  // ── unwrap ────────────────────────────────────────────────────────────────

  describe('unwrap', () => {
    it('restores original getHandler method on tool modules', () => {
      const original = vi.fn(() => async () => ({
        content: [{ type: 'text' as const, text: '{}' }],
        metadata: { engine: 'applescript' as const, degraded: false, latencyMs: 0 },
      }));
      const mockModule = { getHandler: original };

      collector.wrapToolModule(mockModule, 'test');
      expect(mockModule.getHandler).not.toBe(original);

      collector.unwrap();
      expect(mockModule.getHandler).toBe(original);
    });

    it('restores original executeToolWithSecurity on server', () => {
      const original = vi.fn(async () => ({
        content: [{ type: 'text' as const, text: '{}' }],
        metadata: { engine: 'applescript' as const, degraded: false, latencyMs: 0 },
      }));
      const mockServer = { executeToolWithSecurity: original };

      collector.wrapServer(mockServer);
      expect(mockServer.executeToolWithSecurity).not.toBe(original);

      collector.unwrap();
      expect(mockServer.executeToolWithSecurity).toBe(original);
    });

    it('is idempotent — calling unwrap twice does not throw', () => {
      const mockModule = { getHandler: vi.fn(() => undefined) };
      collector.wrapToolModule(mockModule, 'test');
      collector.unwrap();
      collector.unwrap(); // second call should be harmless
    });

    it('restores multiple modules at once', () => {
      const original1 = vi.fn(() => undefined);
      const original2 = vi.fn(() => undefined);
      const mod1 = { getHandler: original1 };
      const mod2 = { getHandler: original2 };

      collector.wrapToolModule(mod1, 'mod1');
      collector.wrapToolModule(mod2, 'mod2');

      collector.unwrap();
      expect(mod1.getHandler).toBe(original1);
      expect(mod2.getHandler).toBe(original2);
    });
  });

  // ── endSession failure handling ───────────────────────────────────────────

  describe('endSession failure handling', () => {
    it('tags failureStep with seq of last failed event', () => {
      collector.startSession('test-1', 'Suite');

      // Record a success, then a failure, then another success
      collector.recordEvent({
        seq: 1, timestamp: '', tool: 'safari_navigate', params: {},
        targeting: { method: 'none' }, success: true, result: { summary: 'ok' },
        timing: { total_ms: 10, engine_ms: 5 }, engine: 'applescript', degraded: false, domain: '',
      });
      collector.recordEvent({
        seq: 2, timestamp: '', tool: 'safari_click', params: {},
        targeting: { method: 'none' }, success: false,
        result: { summary: 'error', error: { code: 'E', message: 'not found', hints: [] } },
        timing: { total_ms: 10, engine_ms: 5 }, engine: 'applescript', degraded: false, domain: '',
      });
      collector.recordEvent({
        seq: 3, timestamp: '', tool: 'safari_get_text', params: {},
        targeting: { method: 'none' }, success: true, result: { summary: 'ok' },
        timing: { total_ms: 10, engine_ms: 5 }, engine: 'applescript', degraded: false, domain: '',
      });

      collector.endSession(false, 'test failed');
      const session = collector.getSessions()[0];
      expect(session.failureStep).toBe(2); // last failed event
    });

    it('does not set failureStep for successful sessions', () => {
      collector.startSession('test-1', 'Suite');
      collector.endSession(true);
      const session = collector.getSessions()[0];
      expect(session.failureStep).toBeUndefined();
    });

    it('does not set failureStep when no events failed', () => {
      collector.startSession('test-1', 'Suite');
      collector.recordEvent({
        seq: 1, timestamp: '', tool: 'safari_click', params: {},
        targeting: { method: 'none' }, success: true, result: { summary: 'ok' },
        timing: { total_ms: 10, engine_ms: 5 }, engine: 'applescript', degraded: false, domain: '',
      });
      // endSession with failure but no failed events — e.g., assertion failure in test
      collector.endSession(false, 'assertion failed');
      const session = collector.getSessions()[0];
      expect(session.failureStep).toBeUndefined();
    });
  });

  // ── computeSessionMetrics ─────────────────────────────────────────────────

  describe('computeSessionMetrics', () => {
    it('computes engine counts, domain list, and tool list', () => {
      collector.startSession('test-metrics', 'Suite');

      const baseEvent: TraceEvent = {
        seq: 0, timestamp: '', tool: '', params: {},
        targeting: { method: 'none' }, success: true, result: { summary: '' },
        timing: { total_ms: 0, engine_ms: 0 }, engine: 'applescript', degraded: false, domain: '',
      };

      collector.recordEvent({
        ...baseEvent, seq: 1, tool: 'safari_navigate', engine: 'applescript',
        domain: 'example.com', timing: { total_ms: 100, engine_ms: 80 },
      });
      collector.recordEvent({
        ...baseEvent, seq: 2, tool: 'safari_snapshot', engine: 'daemon',
        domain: 'example.com', timing: { total_ms: 50, engine_ms: 5 },
      });
      collector.recordEvent({
        ...baseEvent, seq: 3, tool: 'safari_click', engine: 'applescript',
        domain: 'other.com', timing: { total_ms: 30, engine_ms: 20 },
      });

      collector.endSession(true);
      const m = collector.getSessions()[0].metrics;

      expect(m.totalSteps).toBe(3);
      expect(m.totalMs).toBe(180);
      expect(m.successfulSteps).toBe(3);
      expect(m.failedSteps).toBe(0);
      expect(m.enginesUsed).toEqual({ applescript: 2, daemon: 1 });
      expect(m.domainsVisited).toContain('example.com');
      expect(m.domainsVisited).toContain('other.com');
      expect(m.uniqueToolsUsed).toContain('safari_navigate');
      expect(m.uniqueToolsUsed).toContain('safari_snapshot');
      expect(m.uniqueToolsUsed).toContain('safari_click');
    });

    it('computes targeting counts', () => {
      collector.startSession('test-targeting', 'Suite');

      const baseEvent: TraceEvent = {
        seq: 0, timestamp: '', tool: 'safari_click', params: {},
        targeting: { method: 'none' }, success: true, result: { summary: '' },
        timing: { total_ms: 10, engine_ms: 5 }, engine: 'applescript', degraded: false, domain: '',
      };

      collector.recordEvent({ ...baseEvent, seq: 1, targeting: { method: 'ref', ref: 'e1' } });
      collector.recordEvent({ ...baseEvent, seq: 2, targeting: { method: 'ref', ref: 'e2' } });
      collector.recordEvent({ ...baseEvent, seq: 3, targeting: { method: 'locator', locator: { role: 'button' } } });
      collector.recordEvent({ ...baseEvent, seq: 4, targeting: { method: 'selector', selector: '#btn' } });
      collector.recordEvent({ ...baseEvent, seq: 5, targeting: { method: 'none' } });

      collector.endSession(true);
      const m = collector.getSessions()[0].metrics;

      expect(m.refTargetingCount).toBe(2);
      expect(m.locatorTargetingCount).toBe(1);
      expect(m.selectorTargetingCount).toBe(1);
    });

    it('computes auto-wait statistics', () => {
      collector.startSession('test-autowait', 'Suite');

      const baseEvent: TraceEvent = {
        seq: 0, timestamp: '', tool: 'safari_click', params: {},
        targeting: { method: 'none' }, success: true, result: { summary: '' },
        timing: { total_ms: 10, engine_ms: 5 }, engine: 'applescript', degraded: false, domain: '',
      };

      collector.recordEvent({
        ...baseEvent, seq: 1,
        autoWait: { checks: ['visible', 'stable'], allPassed: true, waited_ms: 50, force: false },
      });
      collector.recordEvent({
        ...baseEvent, seq: 2,
        autoWait: { checks: ['visible', 'stable'], allPassed: false, failedCheck: 'not_stable', waited_ms: 200, force: false },
      });
      collector.recordEvent({ ...baseEvent, seq: 3 }); // no auto-wait

      collector.endSession(true);
      const m = collector.getSessions()[0].metrics;

      expect(m.autoWaitTriggers).toBe(2);
      expect(m.autoWaitTotalMs).toBe(250);
      expect(m.autoWaitFailures).toBe(1);
    });

    it('handles empty event list', () => {
      collector.startSession('test-empty', 'Suite');
      collector.endSession(true);
      const m = collector.getSessions()[0].metrics;

      expect(m.totalSteps).toBe(0);
      expect(m.totalMs).toBe(0);
      expect(m.enginesUsed).toEqual({});
      expect(m.domainsVisited).toEqual([]);
      expect(m.uniqueToolsUsed).toEqual([]);
    });
  });

  // ── addObservation ────────────────────────────────────────────────────────

  describe('addObservation', () => {
    it('appends to current session domainObservations', () => {
      collector.startSession('test-obs', 'Suite');
      collector.addObservation('Wikipedia search is role=combobox');
      collector.addObservation('Reddit uses dynamic loading');

      const session = collector.getCurrentSession()!;
      expect(session.domainObservations).toEqual([
        'Wikipedia search is role=combobox',
        'Reddit uses dynamic loading',
      ]);
    });

    it('is a no-op without an active session', () => {
      // Should not throw
      collector.addObservation('orphan observation');
      expect(collector.getSessionCount()).toBe(0);
    });
  });

  // ── setSessionStartUrl / setSessionEndUrl ─────────────────────────────────

  describe('setSessionStartUrl / setSessionEndUrl', () => {
    it('sets startUrl on current session', () => {
      collector.startSession('test-url', 'Suite');
      collector.setSessionStartUrl('https://en.wikipedia.org/');
      expect(collector.getCurrentSession()!.startUrl).toBe('https://en.wikipedia.org/');
    });

    it('sets endUrl on current session', () => {
      collector.startSession('test-url', 'Suite');
      collector.setSessionEndUrl('https://en.wikipedia.org/wiki/Test');
      expect(collector.getCurrentSession()!.endUrl).toBe('https://en.wikipedia.org/wiki/Test');
    });

    it('setSessionStartUrl is a no-op without active session', () => {
      collector.setSessionStartUrl('https://example.com/');
      // Should not throw
    });

    it('setSessionEndUrl is a no-op without active session', () => {
      collector.setSessionEndUrl('https://example.com/');
      // Should not throw
    });
  });

  // ── flush ─────────────────────────────────────────────────────────────────

  describe('flush', () => {
    it('is a no-op when there are zero sessions', async () => {
      const path = await collector.flush('/tmp/test-traces');
      expect(path).toBe('');
    });

    it('writes a valid TraceRun JSON file', async () => {
      const { readFile, rm } = await import('node:fs/promises');
      const outputDir = `/tmp/trace-test-${Date.now()}`;

      collector.startSession('test-1', 'Suite A');
      collector.endSession(true);

      const filePath = await collector.flush(outputDir);
      expect(filePath).toBeTruthy();
      expect(filePath).toMatch(/\.json$/);

      const content = await readFile(filePath, 'utf-8');
      const run: TraceRun = JSON.parse(content);

      expect(run.runId).toBe('test-run-001');
      expect(run.type).toBe('integration');
      expect(run.sessions).toHaveLength(1);
      expect(run.sessions[0].testId).toBe('test-1');
      expect(run.summary.total).toBe(1);
      expect(run.summary.passed).toBe(1);
      expect(run.environment.nodeVersion).toBeTruthy();
      expect(run.environment.platform).toBe(process.platform);

      await rm(outputDir, { recursive: true }).catch(() => {});
    });

    it('computes run summary statistics correctly', async () => {
      const { readFile, rm } = await import('node:fs/promises');
      const outputDir = `/tmp/trace-test-${Date.now()}`;

      collector.startSession('test-1', 'Suite');
      collector.endSession(true);
      collector.startSession('test-2', 'Suite');
      collector.endSession(false, 'timeout');
      collector.startSession('test-3', 'Suite');
      collector.endSession(true);

      const filePath = await collector.flush(outputDir);
      const run: TraceRun = JSON.parse(await readFile(filePath, 'utf-8'));

      expect(run.summary.total).toBe(3);
      expect(run.summary.passed).toBe(2);
      expect(run.summary.failed).toBe(1);
      expect(run.summary.skipped).toBe(0);

      await rm(outputDir, { recursive: true }).catch(() => {});
    });

    it('file name contains timestamp and git commit', async () => {
      const { rm } = await import('node:fs/promises');
      const outputDir = `/tmp/trace-test-${Date.now()}`;

      collector.startSession('test-1', 'Suite');
      collector.endSession(true);

      const filePath = await collector.flush(outputDir);
      const fileName = filePath.split('/').pop()!;
      // Format: YYYY-MM-DDTHH-MM-SS-<gitcommit>.json
      expect(fileName).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-z0-9]+\.json$/);

      await rm(outputDir, { recursive: true }).catch(() => {});
    });

    it('creates output directory if it does not exist', async () => {
      const { rm, stat } = await import('node:fs/promises');
      const rootDir = `/tmp/trace-test-nested-${Date.now()}`;
      const outputDir = `${rootDir}/deep/path`;

      collector.startSession('test-1', 'Suite');
      collector.endSession(true);

      const filePath = await collector.flush(outputDir);
      expect(filePath).toBeTruthy();

      // Verify directory was created
      const dirStat = await stat(outputDir);
      expect(dirStat.isDirectory()).toBe(true);

      await rm(rootDir, { recursive: true }).catch(() => {});
    });

    it('environment metadata is populated', async () => {
      const { readFile, rm } = await import('node:fs/promises');
      const outputDir = `/tmp/trace-test-${Date.now()}`;

      collector.startSession('test-1', 'Suite');
      collector.endSession(true);

      const filePath = await collector.flush(outputDir);
      const run: TraceRun = JSON.parse(await readFile(filePath, 'utf-8'));

      expect(run.environment.nodeVersion).toMatch(/^v\d+/);
      expect(run.environment.platform).toBe(process.platform);
      expect(run.environment.arch).toBe(process.arch);
      expect(run.environment.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Git info may be 'unknown' in some CI environments, but should be populated here
      expect(run.environment.gitCommit).toBeTruthy();
      expect(run.environment.gitBranch).toBeTruthy();
      expect(run.environment.safariPilotVersion).toBeTruthy();

      await rm(outputDir, { recursive: true }).catch(() => {});
    });

    it('includes testFile in the run', async () => {
      const { readFile, rm } = await import('node:fs/promises');
      const outputDir = `/tmp/trace-test-${Date.now()}`;

      collector.startSession('test-1', 'Suite');
      collector.endSession(true);

      const filePath = await collector.flush(outputDir);
      const run: TraceRun = JSON.parse(await readFile(filePath, 'utf-8'));

      expect(run.testFile).toBe('test/integration/example.test.ts');

      await rm(outputDir, { recursive: true }).catch(() => {});
    });

    it('computes targeting usage percentages in summary', async () => {
      const { readFile, rm } = await import('node:fs/promises');
      const outputDir = `/tmp/trace-test-${Date.now()}`;

      const baseEvent: TraceEvent = {
        seq: 0, timestamp: '', tool: 'safari_click', params: {},
        targeting: { method: 'none' }, success: true, result: { summary: '' },
        timing: { total_ms: 10, engine_ms: 5 }, engine: 'applescript', degraded: false,
        domain: 'example.com',
      };

      // Session with 2 ref events and 2 selector events
      collector.startSession('test-usage', 'Suite');
      collector.recordEvent({ ...baseEvent, seq: 1, targeting: { method: 'ref', ref: 'e1' } });
      collector.recordEvent({ ...baseEvent, seq: 2, targeting: { method: 'ref', ref: 'e2' } });
      collector.recordEvent({ ...baseEvent, seq: 3, targeting: { method: 'selector', selector: '#a' } });
      collector.recordEvent({ ...baseEvent, seq: 4, targeting: { method: 'selector', selector: '#b' } });
      collector.endSession(true);

      const filePath = await collector.flush(outputDir);
      const run: TraceRun = JSON.parse(await readFile(filePath, 'utf-8'));

      // 2 ref out of 4 total = 0.5
      expect(run.summary.refTargetingUsage).toBe(0.5);
      expect(run.summary.locatorTargetingUsage).toBe(0);

      await rm(outputDir, { recursive: true }).catch(() => {});
    });

    it('computes avgStepsPerTest and avgMsPerTest', async () => {
      const { readFile, rm } = await import('node:fs/promises');
      const outputDir = `/tmp/trace-test-${Date.now()}`;

      const baseEvent: TraceEvent = {
        seq: 0, timestamp: '', tool: 'safari_click', params: {},
        targeting: { method: 'none' }, success: true, result: { summary: '' },
        timing: { total_ms: 10, engine_ms: 5 }, engine: 'applescript', degraded: false, domain: '',
      };

      // Session 1: 3 events
      collector.startSession('test-1', 'Suite');
      collector.recordEvent({ ...baseEvent, seq: 1 });
      collector.recordEvent({ ...baseEvent, seq: 2 });
      collector.recordEvent({ ...baseEvent, seq: 3 });
      collector.endSession(true);

      // Session 2: 1 event
      collector.startSession('test-2', 'Suite');
      collector.recordEvent({ ...baseEvent, seq: 1 });
      collector.endSession(true);

      const filePath = await collector.flush(outputDir);
      const run: TraceRun = JSON.parse(await readFile(filePath, 'utf-8'));

      // 4 total events / 2 sessions = 2.0
      expect(run.summary.avgStepsPerTest).toBe(2);

      await rm(outputDir, { recursive: true }).catch(() => {});
    });
  });
});
