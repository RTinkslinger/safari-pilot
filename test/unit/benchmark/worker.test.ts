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

  it('instructs to use Safari Pilot MCP tools', () => {
    const prompt = buildSystemPrompt(task, 1);
    expect(prompt).toContain('mcp__safari__safari_');
    expect(prompt).toContain('safari_new_tab');
  });

  it('forbids Bash and WebFetch', () => {
    const prompt = buildSystemPrompt(task, 1);
    expect(prompt).toContain('NEVER use Bash');
    expect(prompt).toContain('WebFetch');
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
    const args = buildClaudeArgs(task, 'sonnet', 1, '/tmp/test-config.json');
    expect(args).toContain('--print');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('bypassPermissions');
    expect(args).toContain('--no-session-persistence');
  });

  it('restricts built-in tools to ToolSearch only', () => {
    const args = buildClaudeArgs(task, 'sonnet', 1, '/tmp/test-config.json');
    const toolsIdx = args.indexOf('--tools');
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(args[toolsIdx + 1]).toBe('ToolSearch');
  });

  it('does not include budget cap (subscription mode)', () => {
    const args = buildClaudeArgs(task, 'sonnet', 1, '/tmp/test-config.json');
    expect(args).not.toContain('--max-budget-usd');
  });

  it('uses strict mcp config', () => {
    const args = buildClaudeArgs(task, 'sonnet', 1, '/tmp/test-config.json');
    expect(args).toContain('--strict-mcp-config');
  });

  it('uses provided mcp config path', () => {
    const args = buildClaudeArgs(task, 'sonnet', 1, '/path/to/playwright.json');
    const configIdx = args.indexOf('--mcp-config');
    expect(args[configIdx + 1]).toBe('/path/to/playwright.json');
  });

  it('does not include --bare or --disable-slash-commands', () => {
    const args = buildClaudeArgs(task, 'sonnet', 1, '/tmp/test-config.json');
    expect(args).not.toContain('--bare');
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
