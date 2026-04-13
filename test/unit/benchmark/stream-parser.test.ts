import { describe, it, expect } from 'vitest';
import { parseStreamEvents, extractFinalOutput, extractToolCalls, extractReasoningExcerpts } from '../../../src/benchmark/stream-parser.js';

describe('parseStreamEvents', () => {
  it('parses tool_use events', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_1', name: 'safari_navigate', input: { url: 'https://example.com' } }],
        },
      }),
    ];
    const events = parseStreamEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_use');
    expect(events[0].toolName).toBe('safari_navigate');
    expect(events[0].toolInput).toEqual({ url: 'https://example.com' });
  });

  it('parses tool_result events', () => {
    const lines = [
      JSON.stringify({
        type: 'tool',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"title":"Example Domain"}' }],
      }),
    ];
    const events = parseStreamEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('tool_result');
    expect(events[0].toolResultContent).toContain('Example Domain');
  });

  it('parses text events', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'I found the page title.' }] },
      }),
    ];
    const events = parseStreamEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('text');
    expect(events[0].textContent).toBe('I found the page title.');
  });

  it('handles mixed event types in order', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Starting' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'safari_navigate', input: {} }] } }),
      JSON.stringify({ type: 'tool', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } }),
    ];
    const events = parseStreamEvents(lines);
    expect(events).toHaveLength(4);
    expect(events.map((e) => e.type)).toEqual(['text', 'tool_use', 'tool_result', 'text']);
  });

  it('skips malformed JSON lines', () => {
    const lines = ['not json', JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } })];
    const events = parseStreamEvents(lines);
    expect(events).toHaveLength(1);
  });

  it('handles result type events', () => {
    const lines = [
      JSON.stringify({ type: 'result', message: { role: 'assistant', content: [{ type: 'text', text: '{"result":"done"}' }] } }),
    ];
    const events = parseStreamEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('text');
  });
});

describe('extractFinalOutput', () => {
  it('extracts last text content', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working...' }] } }),
      JSON.stringify({ type: 'result', message: { role: 'assistant', content: [{ type: 'text', text: '{"result":"Example Domain"}' }] } }),
    ];
    const events = parseStreamEvents(lines);
    const output = extractFinalOutput(events);
    expect(output).toBe('{"result":"Example Domain"}');
  });
});

describe('extractToolCalls', () => {
  it('counts tool calls by name', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'safari_navigate', input: {} }] } }),
      JSON.stringify({ type: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'safari_snapshot', input: {} }] } }),
      JSON.stringify({ type: 'tool', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'safari_navigate', input: {} }] } }),
      JSON.stringify({ type: 'tool', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'ok' }] }),
    ];
    const events = parseStreamEvents(lines);
    const tools = extractToolCalls(events);
    expect(tools).toEqual(['safari_navigate', 'safari_snapshot', 'safari_navigate']);
  });
});

describe('extractReasoningExcerpts', () => {
  it('extracts text content between 20 and 500 chars', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'short' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'This is a reasoning excerpt that is long enough to be captured by the filter.' }] } }),
    ];
    const events = parseStreamEvents(lines);
    const excerpts = extractReasoningExcerpts(events);
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]).toContain('reasoning excerpt');
  });
});
