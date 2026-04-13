/**
 * Shared MCP test client for e2e tests.
 * Spawns `node dist/index.js` and speaks JSON-RPC over stdin/stdout.
 * Response routing is ID-based (not FIFO) — safe for concurrent requests.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export class McpTestClient {
  private proc: ChildProcess;
  private buffer = '';
  private pending = new Map<number | string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(serverPath: string) {
    this.proc = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: join(import.meta.dirname, '../..'),
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

    this.proc.kill('SIGTERM');
    return new Promise((resolve) => {
      this.proc.on('close', () => resolve());
      setTimeout(resolve, 3000);
    });
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
  const resp = await client.send(
    { jsonrpc: '2.0', id: nextId, method: 'tools/call', params: { name, arguments: args } },
    timeoutMs,
  ) as Record<string, unknown>;

  if ('error' in resp) {
    const err = resp['error'] as Record<string, unknown>;
    throw new Error(`MCP protocol error ${err['code']}: ${err['message']}`);
  }

  const result = resp['result'] as Record<string, unknown>;
  const content = result['content'] as Array<Record<string, unknown>>;
  const text = content?.[0]?.['text'] as string | undefined;
  return text ? JSON.parse(text) as Record<string, unknown> : result;
}
