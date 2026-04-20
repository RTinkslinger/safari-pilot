import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TRACE_DIR = process.env['SAFARI_PILOT_TRACE_DIR'] ?? join(homedir(), '.safari-pilot');
const TRACE_FILE = join(TRACE_DIR, 'trace.ndjson');

try { mkdirSync(TRACE_DIR, { recursive: true }); } catch { /* exists */ }

export type TraceLayer = 'server' | 'engine-proxy' | 'extension-engine' | 'daemon-engine';
export type TraceLevel = 'event' | 'error';

export function trace(
  id: string,
  layer: TraceLayer,
  event: string,
  data: Record<string, unknown>,
  level: TraceLevel = 'event',
  elapsed_ms?: number,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    id,
    layer,
    level,
    event,
    data,
    ...(elapsed_ms !== undefined && { elapsed_ms }),
  });
  try {
    appendFileSync(TRACE_FILE, line + '\n');
  } catch {
    // Never break the product — telemetry failure is silent
  }
}
