import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, buildSystemPrompt, parseTaskOutput } from '../../../src/benchmark/worker.js';
import type { BenchmarkTask } from '../../../src/benchmark/types.js';

const task: BenchmarkTask = {
  id: 'nav-001',
  category: 'navigation',
  difficulty: 'easy',
  intent: 'Navigate to https://example.com and extract the page title',
  start_url: 'https://example.com',
  requires: { tools: [], engines: [], auth_domains: [], features: [], competitive: false },
  eval: { type: 'exact_match', expected: 'Example Domain' },
  timeout_ms: 30000,
  max_budget_usd: 0.25,
  tags: ['navigation'],
};

describe('buildSystemPrompt', () => {
  it('includes the task intent', () => {
    const prompt = buildSystemPrompt(task, 1);
    expect(prompt).toContain(task.intent);
  });

  it('includes start_url when present', () => {
    const prompt = buildSystemPrompt(task, 1);
    expect(prompt).toContain('https://example.com');
  });

  it('includes window assignment', () => {
    const prompt = buildSystemPrompt(task, 3);
    expect(prompt).toContain('window 3');
  });

  it('instructs JSON output for structured_output eval', () => {
    const structTask: BenchmarkTask = {
      ...task,
      eval: {
        type: 'structured_output',
        schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      },
    };
    const prompt = buildSystemPrompt(structTask, 1);
    expect(prompt).toContain('JSON');
  });
});

describe('buildClaudeArgs', () => {
  it('includes required flags', () => {
    const args = buildClaudeArgs(task, 'sonnet', 1, undefined);
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--no-session-persistence');
  });

  it('includes max-budget-usd from task', () => {
    const args = buildClaudeArgs(task, 'sonnet', 1, undefined);
    const budgetIdx = args.indexOf('--max-budget-usd');
    expect(budgetIdx).toBeGreaterThan(-1);
    expect(args[budgetIdx + 1]).toBe('0.25');
  });

  it('uses strict mcp config', () => {
    const args = buildClaudeArgs(task, 'sonnet', 1, undefined);
    expect(args).toContain('--strict-mcp-config');
  });

  it('uses custom mcp config when provided', () => {
    const args = buildClaudeArgs(task, 'sonnet', 1, '/path/to/playwright.json');
    const configIdx = args.indexOf('--mcp-config');
    expect(args[configIdx + 1]).toBe('/path/to/playwright.json');
  });
});

describe('parseTaskOutput', () => {
  it('extracts steps and tools from stream events', () => {
    const streamOutput = [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'safari_navigate', input: { url: 'https://example.com' } }] } }),
      JSON.stringify({ type: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }] }),
      JSON.stringify({ type: 'result', message: { role: 'assistant', content: [{ type: 'text', text: 'Example Domain' }] } }),
    ].join('\n');

    const result = parseTaskOutput(streamOutput);
    expect(result.steps).toBe(1);
    expect(result.toolsUsed).toEqual(['safari_navigate']);
    expect(result.finalOutput).toBe('Example Domain');
  });

  it('handles empty output', () => {
    const result = parseTaskOutput('');
    expect(result.steps).toBe(0);
    expect(result.finalOutput).toBe('');
  });
});
