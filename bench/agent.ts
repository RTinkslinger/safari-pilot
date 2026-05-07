/**
 * bench/agent.ts — Claude SDK agent loop for the safari-pilot benchmark harness.
 *
 * Invocation:
 *   node --import tsx bench/agent.ts \
 *     --task <path-to-task.json> \
 *     --out <output-dir> \
 *     --fixture-port <port> \
 *     --variant <tag>
 *
 * Side effects:
 *   <out>/score.json     — BenchScore JSON
 *   <out>/tool-calls.jsonl — one entry per tool call
 *
 * Exits 0 on completion (even if task failed by oracle), non-zero on internal error.
 *
 * Design notes:
 * - Inlines a minimal NDJSON stdio MCP client — does NOT import from test/helpers/
 *   because bench/ is shipped; test/ is not.
 * - Translates MCP inputSchema (camelCase) → input_schema (snake_case) for the
 *   Anthropic SDK's tool format.
 */

import Anthropic from '@anthropic-ai/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  createWriteStream,
  copyFileSync,
  existsSync,
  type WriteStream,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BenchTask, BenchScore } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DIST_INDEX = join(REPO_ROOT, 'dist/index.js');
const SAFARI_PILOT_DIR = join(homedir(), '.safari-pilot');

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  taskPath: string;
  outDir: string;
  fixturePort: number;
  variant: string;
  surface: 'full' | 'iter1' | 'hotset' | 'midset' | 'tinyset';
  model: string;
} {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith('--') && i + 1 < argv.length) {
      args[a.slice(2)] = argv[i + 1] as string;
      i++;
    }
  }
  if (!args['task']) throw new Error('Missing --task argument');
  if (!args['out']) throw new Error('Missing --out argument');
  if (!args['fixture-port']) throw new Error('Missing --fixture-port argument');
  if (!args['variant']) throw new Error('Missing --variant argument');
  const surface = (args['surface'] ?? 'full') as 'full' | 'iter1' | 'hotset' | 'midset' | 'tinyset';
  if (!['full', 'iter1', 'hotset', 'midset', 'tinyset'].includes(surface)) {
    throw new Error(`--surface must be 'full' | 'iter1' | 'hotset' | 'midset' | 'tinyset' (got: ${surface})`);
  }
  return {
    taskPath: args['task'] as string,
    outDir: args['out'] as string,
    fixturePort: parseInt(args['fixture-port'] as string, 10),
    variant: args['variant'] as string,
    surface,
    model: args['model'] ?? 'claude-haiku-4-5-20251001',
  };
}

// Tools added in iter-2 (tool_search) and iter-3 (skills). When --surface iter1
// is set, these are filtered from the tool list the agent sees so we measure
// the iter-1 cost-optimal config against today's stack.
const ITER3_DISCOVERY_TOOLS = new Set([
  'safari_tool_search',
  'safari_run_skill',
  'safari_list_skills',
]);

// Empirical hot-set: tools the agent actually used across 8 runs of the
// 6-task suite (232 calls). 11 unique tools observed; we add 3 defensive
// extras (close_tab for cleanup, health_check for preflight, wait_for for
// dynamic pages). 14 tools vs 86 = ~84% reduction in tool-list token cost.
const HOTSET_TOOLS = new Set([
  'safari_snapshot',
  'safari_new_tab',
  'safari_click',
  'safari_get_text',
  'safari_query_all',
  'safari_fill',
  'safari_paginate_scrape',
  'safari_list_tabs',
  'safari_navigate',
  'safari_evaluate',
  'safari_get_html',
  // Defensive — present for predictable failure modes
  'safari_close_tab',
  'safari_health_check',
  'safari_wait_for',
]);

// Tinyset: the 10 tools the agent provably USES across all 8 prior runs.
// Drops defensive extras (close_tab, health_check, wait_for) — none were
// observed in tool-calls.jsonl. Floor test: how small can the surface get
// before tasks fail? Note: safari_health_check is still callable by the
// preflight (uses MCP directly, bypassing the agent's filtered tool list).
const TINYSET_TOOLS = new Set([
  'safari_snapshot',
  'safari_new_tab',
  'safari_navigate',
  'safari_click',
  'safari_fill',
  'safari_get_text',
  'safari_get_html',
  'safari_query_all',
  'safari_evaluate',
  'safari_paginate_scrape',
]);

// Midset: HOTSET + 16 reasonable defaults that aren't in current task usage
// but are likely needed for any general browser-automation task. Tests
// whether the cliff is below 14 or somewhere between 14 and 86.
const MIDSET_TOOLS = new Set<string>([
  ...HOTSET_TOOLS,
  // Interaction primitives
  'safari_hover',
  'safari_type',
  'safari_press_key',
  'safari_scroll',
  'safari_double_click',
  'safari_select_option',
  'safari_check',
  'safari_drag',
  'safari_file_upload',
  // Extraction
  'safari_get_attribute',
  'safari_extract_links',
  'safari_extract_tables',
  'safari_extract_metadata',
  // Navigation/observation
  'safari_navigate_back',
  'safari_navigate_forward',
  'safari_take_screenshot',
]);

// ---------------------------------------------------------------------------
// Minimal inline NDJSON/stdio MCP client
// ---------------------------------------------------------------------------

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

class InlineMcpClient {
  private proc: ChildProcess;
  private buf = '';
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private nextIdCounter = 1;
  private stderrStream: WriteStream;
  private traceDir: string;

  constructor(traceDir: string) {
    this.traceDir = traceDir;
    this.stderrStream = createWriteStream(join(traceDir, 'stderr.log'));

    this.proc = spawn('node', [DIST_INDEX], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
      env: { ...process.env },
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString();
      const lines = this.buf.split('\n');
      this.buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg['id'] as number | string | undefined;
          if (id !== undefined && this.pending.has(id)) {
            const entry = this.pending.get(id)!;
            clearTimeout(entry.timer);
            this.pending.delete(id);
            entry.resolve(msg);
          }
        } catch { /* skip non-JSON */ }
      }
    });

    this.proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderrStream.write(chunk);
    });
  }

  nextId(): number {
    return this.nextIdCounter++;
  }

  send(msg: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const id = msg['id'] as number | string;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout ${timeoutMs}ms for id=${id} method=${msg['method']}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  notify(msg: Record<string, unknown>): void {
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  async initialize(): Promise<void> {
    const id = this.nextId();
    await this.send({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bench-agent', version: '1.0' },
      },
    });
    this.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools(): Promise<McpTool[]> {
    const id = this.nextId();
    const resp = await this.send({
      jsonrpc: '2.0',
      id,
      method: 'tools/list',
      params: {},
    }) as Record<string, unknown>;
    const result = resp['result'] as Record<string, unknown> | undefined;
    return (result?.['tools'] as McpTool[]) ?? [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId();
    const resp = await this.send(
      { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
      timeoutMs,
    ) as Record<string, unknown>;

    if ('error' in resp) {
      const err = resp['error'] as Record<string, unknown>;
      return { _error: true, code: err['code'], message: err['message'] };
    }
    const result = resp['result'] as Record<string, unknown>;
    const content = result['content'] as Array<Record<string, unknown>> | undefined;
    const text = content?.[0]?.['text'] as string | undefined;
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : result;
    } catch {
      return { _rawText: text };
    }
  }

  close(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Client closed'));
    }
    this.pending.clear();

    // Copy NDJSON trace files from the run window into the trace directory.
    // Best-effort — never throw out of close().
    try {
      const serverTrace = join(SAFARI_PILOT_DIR, 'trace.ndjson');
      const daemonTrace = join(SAFARI_PILOT_DIR, 'daemon-trace.ndjson');
      if (existsSync(serverTrace)) copyFileSync(serverTrace, join(this.traceDir, 'server-trace.ndjson'));
      if (existsSync(daemonTrace)) copyFileSync(daemonTrace, join(this.traceDir, 'daemon-trace.ndjson'));
    } catch { /* best-effort */ }

    this.stderrStream.end();
    this.proc.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------------------
// Oracle evaluation
// ---------------------------------------------------------------------------

function evaluateOracle(
  task: BenchTask,
  toolCallLog: Array<{ tool: string; args: Record<string, unknown>; result: unknown }>,
  finalText: string,
  strictViolation: boolean,
): { success: boolean; failure_reason?: string } {
  const oracle = task.successOracle;

  if (oracle.type === 'no_strict_violation') {
    if (strictViolation) {
      return { success: false, failure_reason: 'strict_violation' };
    }
    return { success: true };
  }

  if (oracle.type === 'final_text_contains') {
    if (!oracle.text) return { success: false, failure_reason: 'oracle.text missing' };
    if (finalText.includes(oracle.text)) return { success: true };
    return { success: false, failure_reason: `final text did not contain: ${oracle.text}` };
  }

  if (oracle.type === 'tool_called_with') {
    if (!oracle.tool) return { success: false, failure_reason: 'oracle.tool missing' };
    const match = toolCallLog.find((tc) => {
      if (tc.tool !== oracle.tool) return false;
      if (!oracle.argMatch) return true;
      for (const [k, v] of Object.entries(oracle.argMatch)) {
        if (tc.args[k] !== v) return false;
      }
      return true;
    });
    if (match) return { success: true };
    return { success: false, failure_reason: `tool ${oracle.tool} was not called with expected args` };
  }

  return { success: false, failure_reason: `unknown oracle type: ${oracle.type}` };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { taskPath, outDir, fixturePort, variant, surface, model } = parseArgs(process.argv.slice(2));

  mkdirSync(outDir, { recursive: true });

  const task = JSON.parse(readFileSync(taskPath, 'utf-8')) as BenchTask;

  const toolCallsPath = join(outDir, 'tool-calls.jsonl');
  const scorePath = join(outDir, 'score.json');

  const client = new InlineMcpClient(outDir);
  const anthropic = new Anthropic({
    apiKey: process.env['ANTHROPIC_API_KEY'],
  });

  try {
    await client.initialize();

    // Pre-flight: extension MUST be online. Benchmark measures the shipped
    // extension-first product; AppleScript fallback success is a false
    // positive — different engine path than what users experience.
    const health = await client.callTool('safari_health_check', {}, 30_000);
    const checks = (health['checks'] as Array<{ name: string; ok: boolean }> | undefined) ?? [];
    const extCheck = checks.find((c) => c.name === 'extension');
    if (!extCheck || !extCheck.ok) {
      const score: BenchScore = {
        task_id: task.id,
        variant,
        success: false,
        tool_calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        wall_ms: 0,
        tt: 0,
        failure_reason: 'extension_offline',
      };
      writeFileSync(scorePath, JSON.stringify(score, null, 2));
      process.stdout.write(`[bench] ${task.id} variant=${variant} ABORT extension_offline\n`);
      return;
    }

    const allMcpTools = await client.listTools();
    let mcpTools: McpTool[];
    if (surface === 'iter1') {
      mcpTools = allMcpTools.filter((t) => !ITER3_DISCOVERY_TOOLS.has(t.name));
    } else if (surface === 'hotset') {
      mcpTools = allMcpTools.filter((t) => HOTSET_TOOLS.has(t.name));
    } else if (surface === 'midset') {
      mcpTools = allMcpTools.filter((t) => MIDSET_TOOLS.has(t.name));
    } else if (surface === 'tinyset') {
      mcpTools = allMcpTools.filter((t) => TINYSET_TOOLS.has(t.name));
    } else {
      mcpTools = allMcpTools;
    }

    // Translate MCP inputSchema → Anthropic SDK input_schema
    const anthropicTools: Anthropic.Tool[] = mcpTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));

    // Load opinionated system prompt from bench/prompts/system.md.
    // Falls back to a minimal inline prompt if the file is missing.
    const fixtureUrl = `http://127.0.0.1:${fixturePort}${task.fixtureRoute}`;
    let systemBody: string;
    try {
      const promptPath = `${process.cwd()}/bench/prompts/system.md`;
      systemBody = readFileSync(promptPath, 'utf8');
    } catch {
      systemBody =
        `You are a browser automation agent using the Safari Pilot MCP tools. ` +
        `You have access to safari_* tools to control Safari.`;
    }
    const systemPrompt = `${systemBody}\n\n## This task\n\nFixture URL: ${fixtureUrl}\nComplete efficiently. When done, summarize what you found in plain text without a tool call.`;

    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: task.description },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let toolCallCount = 0;
    let finalText = '';
    let strictViolation = false;
    let budgetExceeded = false;
    const toolCallLog: Array<{ tool: string; args: Record<string, unknown>; result: unknown }> = [];

    const wallStart = Date.now();

    for (let iter = 0; iter < task.maxIterations; iter++) {
      // Cumulative budget guard — checked at top so iter 0 always runs.
      // Once cumulative spend exceeds the budget we stop BEFORE the next
      // API call. Soft cap: actual spend can overshoot by one round.
      if (totalInputTokens + totalOutputTokens > task.budgetTokens) {
        budgetExceeded = true;
        break;
      }

      const response = await anthropic.messages.create({
        model,
        max_tokens: Math.min(task.budgetTokens, 4096),
        // temperature: 0 for deterministic measurement across iterations.
        // Stochastic agent loops + 6 tasks made baseline TT swing ±35%
        // run-to-run, masking real interventions. Temp 0 makes per-task
        // outcomes a function of (system prompt × tool surface × task)
        // rather than a function of (random seed).
        temperature: 0,
        system: systemPrompt,
        tools: anthropicTools,
        messages,
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      // Extract text from this turn
      for (const block of response.content) {
        if (block.type === 'text') {
          finalText = block.text;
        }
      }

      // Collect tool use blocks
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        // No more tool calls — done
        break;
      }

      // Execute each tool call
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tb of toolUseBlocks) {
        toolCallCount++;
        const args = tb.input as Record<string, unknown>;
        const callStart = Date.now();

        let result: Record<string, unknown>;
        try {
          result = await client.callTool(tb.name, args, 30_000);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result = { _error: true, message: msg };
          if (msg.includes('STRICTNESS_VIOLATION')) strictViolation = true;
        }

        const elapsed = Date.now() - callStart;

        // Detect strict violation signals in result
        if (result['_error'] && typeof result['message'] === 'string' && result['message'].includes('STRICTNESS_VIOLATION')) {
          strictViolation = true;
        }

        // Write to tool-calls.jsonl
        const entry = {
          ts: new Date().toISOString(),
          tool: tb.name,
          args,
          result,
          elapsed_ms: elapsed,
        };
        appendFileSync(toolCallsPath, JSON.stringify(entry) + '\n');
        toolCallLog.push({ tool: tb.name, args, result });

        const resultText =
          typeof result === 'object' ? JSON.stringify(result) : String(result);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tb.id,
          content: resultText,
        });
      }

      // Add assistant turn + tool results to messages
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    const wallMs = Date.now() - wallStart;

    let { success, failure_reason } = evaluateOracle(
      task,
      toolCallLog,
      finalText,
      strictViolation,
    );
    if (budgetExceeded) {
      success = false;
      failure_reason = 'budget_exceeded';
    }

    const score: BenchScore = {
      task_id: task.id,
      variant,
      success,
      tool_calls: toolCallCount,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      wall_ms: wallMs,
      tt: wallMs * (totalInputTokens + totalOutputTokens),
      ...(failure_reason ? { failure_reason } : {}),
    };

    writeFileSync(scorePath, JSON.stringify(score, null, 2));
    process.stdout.write(`[bench] ${task.id} variant=${variant} success=${success} tt=${score.tt}\n`);
  } finally {
    client.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[bench] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
