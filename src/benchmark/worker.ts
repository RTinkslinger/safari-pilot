import { spawn } from 'child_process';
import { join } from 'path';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const projectRoot = join(import.meta.dirname, '..', '..');

/**
 * Generate a temporary MCP config file with absolute paths so the Safari Pilot
 * MCP server starts in the correct working directory regardless of where
 * Claude Code spawns it. Returns the path to the temp config file.
 */
export function generateMcpConfig(serverEntryPoint: string): string {
  const config = {
    mcpServers: {
      safari: {
        command: 'node',
        args: [serverEntryPoint],
        cwd: projectRoot,
        env: { NODE_ENV: 'production' },
      },
    },
  };
  const dir = join(tmpdir(), 'safari-pilot-bench');
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, `mcp-config-${process.pid}.json`);
  writeFileSync(configPath, JSON.stringify(config), 'utf-8');
  return configPath;
}

export function cleanupMcpConfig(configPath: string): void {
  try { unlinkSync(configPath); } catch { /* ignore */ }
}

let _cachedMcpConfig: string | null = null;

export function getDefaultMcpConfig(): string {
  if (!_cachedMcpConfig) {
    _cachedMcpConfig = generateMcpConfig(join(projectRoot, 'dist', 'index.js'));
  }
  return _cachedMcpConfig;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildSystemPrompt(task: BenchmarkTask, windowIndex: number): string {
  const lines: string[] = [];

  lines.push('You are a benchmark agent testing Safari Pilot, a Safari browser automation tool.');
  lines.push('You have Safari Pilot MCP tools available. All tool names start with mcp__safari__safari_.');
  lines.push('');
  lines.push('RULES:');
  lines.push('1. First, load the Safari tools: ToolSearch with query "select:mcp__safari__safari_new_tab,mcp__safari__safari_navigate,mcp__safari__safari_get_text,mcp__safari__safari_snapshot,mcp__safari__safari_click,mcp__safari__safari_fill"');
  lines.push('2. If ToolSearch returns no safari tools, the MCP server is still starting. Call ToolSearch again with the same query — it will be ready within seconds.');
  lines.push('3. ALWAYS start by creating a new tab with the safari_new_tab tool.');
  lines.push('4. Then navigate, interact, and extract using Safari Pilot tools ONLY.');
  lines.push('5. NEVER use Bash, WebFetch, Read, or any non-Safari tool.');
  lines.push('');
  lines.push('TASK:');
  lines.push(task.intent);

  if (task.start_url) {
    lines.push('');
    lines.push(`START URL: ${task.start_url}`);
    lines.push('After creating a new tab, navigate to this URL with mcp__safari__safari_navigate.');
  }

  lines.push('');

  if (task.eval.type === 'structured_output' && task.eval.schema) {
    lines.push('OUTPUT: Respond with a single JSON object matching this schema (no prose):');
    lines.push(JSON.stringify(task.eval.schema, null, 2));
  } else {
    lines.push('OUTPUT: Respond with only the raw answer — no explanation, no prose. One line.');
  }

  return lines.join('\n');
}

export function buildClaudeArgs(
  task: BenchmarkTask,
  model: string,
  windowIndex: number,
  mcpConfigPath: string | undefined
): string[] {
  const prompt = buildSystemPrompt(task, windowIndex);
  const resolvedConfig = mcpConfigPath ?? getDefaultMcpConfig();

  const args = [
    '--print', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--permission-mode', 'bypassPermissions',
    '--no-session-persistence',
    '--tools', 'ToolSearch',
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
  const SESSION_OVERHEAD_MS = 30_000;
  const timeoutMs = Math.max(task.timeout_ms * timeoutMultiplier, 60_000) + SESSION_OVERHEAD_MS;

  let stdout = '';
  let timedOut = false;

  try {
    await new Promise<void>((resolve, reject) => {
      const args = buildClaudeArgs(task, model, windowIndex, mcpConfigPath);
      const proc = spawn('claude', args, { stdio: ['ignore', 'pipe', 'inherit'] });
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
      }, timeoutMs);

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.on('close', (code) => {
        if (timedOut) settle(() => reject(new Error(`Task timed out after ${timeoutMs}ms`)));
        else if (code !== 0 && code !== null) settle(() => reject(new Error(`Claude CLI exited with code ${code}`)));
        else settle(resolve);
      });

      proc.on('error', (err) => settle(() => reject(err)));
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
