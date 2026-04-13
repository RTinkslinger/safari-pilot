import { spawn } from 'child_process';
import { join } from 'path';
import type { BenchmarkTask, TaskResult, EvalType } from './types.js';
import {
  parseStreamEvents,
  extractFinalOutput,
  extractToolCalls,
  extractReasoningExcerpts,
} from './stream-parser.js';
import { evaluate, evaluateWithLlmJudge } from './eval.js';

// ─── ParsedOutput ─────────────────────────────────────────────────────────────

export interface ParsedOutput {
  steps: number;
  toolsUsed: string[];
  finalOutput: string;
  reasoningExcerpts: string[];
  rawLines: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Project root: dist/benchmark/worker.js is 2 levels below project root.
 * In source (vitest), import.meta.dirname is src/benchmark/ — still 2 levels up.
 */
const projectRoot = join(import.meta.dirname, '..', '..');

const DEFAULT_MCP_CONFIG = join(projectRoot, 'benchmark', 'mcp-configs', 'safari-only.json');

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the system prompt passed to the Claude CLI for a benchmark task.
 * Includes: task intent, start URL, window assignment, and output instructions.
 */
export function buildSystemPrompt(task: BenchmarkTask, windowIndex: number): string {
  const lines: string[] = [];

  lines.push(`You are a Safari browser automation agent assigned to window ${windowIndex}.`);
  lines.push('');
  lines.push('Task:');
  lines.push(task.intent);

  if (task.start_url) {
    lines.push('');
    lines.push(`Start URL: ${task.start_url}`);
  }

  lines.push('');

  if (task.eval.type === 'structured_output' && task.eval.schema) {
    lines.push('Output format: Respond with a single JSON object matching the schema below. Do not include any prose — only the JSON.');
    lines.push('');
    lines.push('Schema:');
    lines.push(JSON.stringify(task.eval.schema, null, 2));
  } else {
    lines.push('Output format: Respond with only the raw answer — no explanation, no prose. One line.');
  }

  return lines.join('\n');
}

/**
 * Build the argument array for spawning the Claude CLI.
 * Uses --print (non-interactive), stream-json output, and bypassPermissions mode.
 */
export function buildClaudeArgs(
  task: BenchmarkTask,
  model: string,
  windowIndex: number,
  mcpConfigPath: string | undefined
): string[] {
  const prompt = buildSystemPrompt(task, windowIndex);
  const resolvedConfig = mcpConfigPath ?? DEFAULT_MCP_CONFIG;

  const args = [
    '--print', prompt,
    '--output-format', 'stream-json',
    '--model', model,
    '--bare',
    '--permission-mode', 'bypassPermissions',
    '--no-session-persistence',
    '--max-budget-usd', String(task.max_budget_usd),
    '--strict-mcp-config',
    '--mcp-config', resolvedConfig,
  ];

  if (task.eval.type === 'structured_output' && task.eval.schema) {
    args.push('--json-schema', JSON.stringify(task.eval.schema));
  }

  return args;
}

/**
 * Parse raw stream-json stdout from the Claude CLI into structured output.
 */
export function parseTaskOutput(streamOutput: string): ParsedOutput {
  if (!streamOutput.trim()) {
    return { steps: 0, toolsUsed: [], finalOutput: '', reasoningExcerpts: [], rawLines: [] };
  }

  const rawLines = streamOutput.split('\n').filter((l) => l.trim() !== '');
  const events = parseStreamEvents(rawLines);

  const toolsUsed = extractToolCalls(events);
  const finalOutput = extractFinalOutput(events);
  const reasoningExcerpts = extractReasoningExcerpts(events);
  const steps = events.filter((ev) => ev.type === 'tool_use').length;

  return { steps, toolsUsed, finalOutput, reasoningExcerpts, rawLines };
}

/**
 * Spawn a Claude CLI process, collect its stdout, evaluate the result, and
 * return a TaskResult. Handles timeout and spawn errors gracefully.
 *
 * Not unit tested — requires the Claude CLI and network access.
 */
export async function executeTask(
  task: BenchmarkTask,
  model: string,
  windowIndex: number,
  mcpConfigPath: string | undefined,
  timeoutMultiplier: number
): Promise<TaskResult> {
  const startMs = Date.now();
  const timeoutMs = task.timeout_ms * timeoutMultiplier;

  let stdout = '';
  let timedOut = false;

  try {
    await new Promise<void>((resolve, reject) => {
      const args = buildClaudeArgs(task, model, windowIndex, mcpConfigPath);
      const proc = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        timer = null;
      }, timeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.on('close', (code) => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (timedOut) {
          reject(new Error(`Task timed out after ${timeoutMs}ms`));
        } else if (code !== 0 && code !== null) {
          reject(new Error(`Claude CLI exited with code ${code}`));
        } else {
          resolve();
        }
      });

      proc.on('error', (err) => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        reject(err);
      });
    });
  } catch (err) {
    const durationMs = Date.now() - startMs;
    return {
      taskId: task.id,
      model,
      success: false,
      evalMethod: task.eval.type,
      evalDetails: timedOut ? `Timeout after ${timeoutMs}ms` : String(err),
      fallbackUsed: false,
      skipped: false,
      steps: 0,
      durationMs,
      toolsUsed: [],
      enginesUsed: {},
      reasoningExcerpts: [],
      error: timedOut ? `Timeout after ${timeoutMs}ms` : String(err),
      rawOutput: stdout || undefined,
    };
  }

  const durationMs = Date.now() - startMs;
  const parsed = parseTaskOutput(stdout);

  // Run primary eval
  let evalResult = evaluate(task.eval, parsed.finalOutput);
  let fallbackUsed = false;
  let evalMethod: EvalType = task.eval.type;

  // Resolve pending LLM judge
  if (evalResult.pending && task.eval.type === 'llm_judge') {
    evalResult = await evaluateWithLlmJudge(task.eval.criteria ?? '', parsed.finalOutput);
  }

  // Try fallback if primary failed and fallback is configured
  if (!evalResult.passed && task.eval_fallback) {
    const fallbackResult = evaluate(task.eval_fallback, parsed.finalOutput);
    const resolvedFallback =
      fallbackResult.pending && task.eval_fallback.type === 'llm_judge'
        ? await evaluateWithLlmJudge(task.eval_fallback.criteria ?? '', parsed.finalOutput)
        : fallbackResult;

    if (resolvedFallback.passed) {
      evalResult = resolvedFallback;
      fallbackUsed = true;
      evalMethod = task.eval_fallback.type;
    }
  }

  return {
    taskId: task.id,
    model,
    success: evalResult.passed,
    evalMethod,
    evalDetails: JSON.stringify(evalResult.details),
    fallbackUsed,
    skipped: false,
    steps: parsed.steps,
    durationMs,
    toolsUsed: parsed.toolsUsed,
    enginesUsed: {},
    reasoningExcerpts: parsed.reasoningExcerpts,
    rawOutput: stdout,
  };
}
