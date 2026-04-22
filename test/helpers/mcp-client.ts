/**
 * Shared MCP test client for e2e tests.
 * Spawns `node dist/index.js` and speaks JSON-RPC over stdin/stdout.
 * Response routing is ID-based (not FIFO) — safe for concurrent requests.
 *
 * Trace capture: every run creates a trace directory under test-results/traces/
 * with stderr log, tool call JSONL, and copies of the NDJSON trace files.
 * This data feeds the recipe system's learning pipeline.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, createWriteStream, copyFileSync, existsSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';

const TRACE_BASE = join(import.meta.dirname, '../../test-results/traces');
const SAFARI_PILOT_DIR = join(homedir(), '.safari-pilot');

function makeRunDir(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const dir = join(TRACE_BASE, ts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class McpTestClient {
  private proc: ChildProcess;
  private buffer = '';
  private pending = new Map<number | string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private traceDir: string;
  private stderrStream: WriteStream;
  private toolLog: WriteStream;

  constructor(serverPath: string) {
    this.traceDir = makeRunDir();
    this.stderrStream = createWriteStream(join(this.traceDir, 'stderr.log'));
    this.toolLog = createWriteStream(join(this.traceDir, 'tool-calls.jsonl'));

    this.proc = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: join(import.meta.dirname, '../..'),
    });

    // Capture stderr to file (init progress, warnings, errors)
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderrStream.write(chunk);
    });

    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop()!;
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
  }

  getTraceDir(): string {
    return this.traceDir;
  }

  async send(msg: Record<string, unknown>, timeoutMs = 15000): Promise<Record<string, unknown>> {
    const id = msg['id'] as number | string | undefined;
    if (id === undefined) {
      throw new Error('McpTestClient.send() requires a message with an id field');
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP response timeout (${timeoutMs}ms) for id=${id}, method=${msg['method']}`));
      }, timeoutMs);

      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer });
      this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  notify(msg: Record<string, unknown>): void {
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
  }

  async close(): Promise<void> {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Client closed'));
    }
    this.pending.clear();

    // Copy NDJSON trace files from the run window into the trace directory
    try {
      const serverTrace = join(SAFARI_PILOT_DIR, 'trace.ndjson');
      const daemonTrace = join(SAFARI_PILOT_DIR, 'daemon-trace.ndjson');
      if (existsSync(serverTrace)) copyFileSync(serverTrace, join(this.traceDir, 'server-trace.ndjson'));
      if (existsSync(daemonTrace)) copyFileSync(daemonTrace, join(this.traceDir, 'daemon-trace.ndjson'));
    } catch { /* best-effort trace copy */ }

    this.stderrStream.end();
    this.toolLog.end();

    this.proc.kill('SIGTERM');
    return new Promise((resolve) => {
      this.proc.on('close', () => resolve());
      setTimeout(resolve, 3000);
    });
  }

  /**
   * Log a tool call and its result to the JSONL trace file.
   * Called by callTool/rawCallTool helpers.
   */
  logToolCall(entry: { tool: string; args: Record<string, unknown>; result: unknown; engine?: string; latencyMs: number; error?: string }): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    });
    this.toolLog.write(line + '\n');
  }
}

export async function initClient(serverPath: string, startId = 1): Promise<{ client: McpTestClient; nextId: number }> {
  const client = new McpTestClient(serverPath);
  let nextId = startId;

  await client.send({
    jsonrpc: '2.0',
    id: nextId++,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test', version: '1.0' },
    },
  });

  client.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return { client, nextId };
}

export async function callTool(
  client: McpTestClient,
  name: string,
  args: Record<string, unknown>,
  nextId: number,
  timeoutMs = 15000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  const resp = await client.send(
    { jsonrpc: '2.0', id: nextId, method: 'tools/call', params: { name, arguments: args } },
    timeoutMs,
  ) as Record<string, unknown>;

  if ('error' in resp) {
    const err = resp['error'] as Record<string, unknown>;
    client.logToolCall({ tool: name, args, result: null, latencyMs: Date.now() - start, error: `${err['code']}: ${err['message']}` });
    throw new Error(`MCP protocol error ${err['code']}: ${err['message']}`);
  }

  const result = resp['result'] as Record<string, unknown>;
  const content = result['content'] as Array<Record<string, unknown>>;
  const meta = result['_meta'] as Record<string, unknown> | undefined;
  const text = content?.[0]?.['text'] as string | undefined;
  const parsed = text ? JSON.parse(text) as Record<string, unknown> : result;

  client.logToolCall({ tool: name, args, result: parsed, engine: meta?.engine as string, latencyMs: Date.now() - start });
  return parsed;
}

/**
 * Response from rawCallTool — includes parsed payload AND engine metadata.
 */
export interface RawToolResult {
  /** The parsed JSON from result.content[0].text */
  payload: Record<string, unknown>;
  /** The _meta object from the MCP result (engine, degraded, latencyMs, etc.) */
  meta: Record<string, unknown> | undefined;
  /** The full MCP result object for low-level inspection */
  result: Record<string, unknown>;
}

/**
 * Call a tool through MCP and return the full result including _meta engine metadata.
 * Unlike callTool(), this preserves the metadata that identifies which engine ran.
 * Does NOT throw on JSON-RPC errors — returns them in result for inspection.
 * Handles non-JSON content text gracefully (e.g., error messages from EngineUnavailableError).
 */
export async function rawCallTool(
  client: McpTestClient,
  name: string,
  args: Record<string, unknown>,
  nextId: number,
  timeoutMs = 15000,
): Promise<RawToolResult> {
  const start = Date.now();
  const resp = await client.send(
    { jsonrpc: '2.0', id: nextId, method: 'tools/call', params: { name, arguments: args } },
    timeoutMs,
  ) as Record<string, unknown>;

  if ('error' in resp) {
    const err = resp['error'] as Record<string, unknown>;
    client.logToolCall({ tool: name, args, result: null, latencyMs: Date.now() - start, error: `${err['code']}: ${err['message']}` });
    throw new Error(`MCP protocol error ${err['code']}: ${err['message']}`);
  }

  const result = resp['result'] as Record<string, unknown>;
  const content = result['content'] as Array<Record<string, unknown>>;
  const text = content?.[0]?.['text'] as string | undefined;

  // Attempt JSON parse; fall back to wrapping raw text in an object
  let payload: Record<string, unknown>;
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Non-JSON text (e.g., "Error: This operation requires...") — wrap it
      payload = { _rawText: text, _isError: text.toLowerCase().startsWith('error') };
    }
  } else {
    payload = {};
  }

  const meta = result['_meta'] as Record<string, unknown> | undefined;

  client.logToolCall({ tool: name, args, result: payload, engine: meta?.engine as string, latencyMs: Date.now() - start });

  return { payload, meta, result };
}
