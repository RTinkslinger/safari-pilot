import type { StreamEvent } from './types.js';

// ─── Internal helpers ────────────────────────────────────────────────────────

interface RawContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
}

interface RawLine {
  type: string;
  message?: {
    role?: string;
    content?: RawContentBlock[];
  };
  content?: RawContentBlock[];
  [key: string]: unknown;
}

function parseLine(line: string): RawLine | null {
  try {
    return JSON.parse(line) as RawLine;
  } catch {
    return null;
  }
}

function processContentBlocks(
  blocks: RawContentBlock[],
  raw: unknown
): StreamEvent[] {
  const events: StreamEvent[] = [];
  const timestamp = Date.now();

  for (const block of blocks) {
    if (block.type === 'tool_use') {
      events.push({
        type: 'tool_use',
        timestamp,
        toolName: block.name,
        toolInput: block.input,
        raw,
      });
    } else if (block.type === 'text') {
      events.push({
        type: 'text',
        timestamp,
        textContent: block.text ?? '',
        raw,
      });
    } else if (block.type === 'tool_result') {
      const content = block.content;
      const contentStr = typeof content === 'string' ? content : JSON.stringify(content);
      events.push({
        type: 'tool_result',
        timestamp,
        toolResultContent: contentStr,
        raw,
      });
    }
  }

  return events;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse Claude Code `--output-format stream-json` lines into structured StreamEvents.
 * Malformed JSON lines are silently skipped.
 */
export function parseStreamEvents(lines: string[]): StreamEvent[] {
  const events: StreamEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = parseLine(trimmed);
    if (parsed === null) continue;

    const { type } = parsed;

    if (type === 'assistant' || type === 'result') {
      // Content is inside parsed.message.content
      const content = parsed.message?.content;
      if (Array.isArray(content)) {
        events.push(...processContentBlocks(content, parsed));
      }
    } else if (type === 'tool') {
      // Content is inside parsed.content (top-level)
      const content = parsed.content;
      if (Array.isArray(content)) {
        events.push(...processContentBlocks(content, parsed));
      }
    } else if (type === 'error') {
      events.push({
        type: 'error',
        timestamp: Date.now(),
        raw: parsed,
      });
    }
    // All other types are ignored (system, unknown, etc.)
  }

  return events;
}

/**
 * Return the textContent of the last text event, or '' if none.
 */
export function extractFinalOutput(events: StreamEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type === 'text') {
      return ev.textContent ?? '';
    }
  }
  return '';
}

/**
 * Return an ordered array of tool names from all tool_use events.
 */
export function extractToolCalls(events: StreamEvent[]): string[] {
  return events
    .filter((ev) => ev.type === 'tool_use' && ev.toolName !== undefined)
    .map((ev) => ev.toolName as string);
}

/**
 * Return textContent of text events whose length is strictly between 20 and 500 characters.
 */
export function extractReasoningExcerpts(events: StreamEvent[]): string[] {
  return events
    .filter((ev) => ev.type === 'text')
    .map((ev) => ev.textContent ?? '')
    .filter((text) => text.length > 20 && text.length < 500);
}

/**
 * Architecture trace: extract engine metadata from tool_result events.
 * MCP tool results include _meta with engine, degraded, latencyMs.
 * Returns per-call records for the architecture report.
 */
export interface ArchitectureTraceEntry {
  tool: string;
  engine: string;
  degraded: boolean;
  latencyMs: number;
  success: boolean;
  order: number;
}

export function extractArchitectureTrace(events: StreamEvent[]): ArchitectureTraceEntry[] {
  const trace: ArchitectureTraceEntry[] = [];
  let order = 0;
  let lastToolName = '';

  for (const ev of events) {
    if (ev.type === 'tool_use' && ev.toolName) {
      lastToolName = ev.toolName;
    }
    if (ev.type === 'tool_result') {
      let engine = 'unknown';
      let degraded = false;
      let latencyMs = 0;
      let success = true;

      const searchForMeta = (obj: unknown): void => {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          for (const item of obj) searchForMeta(item);
          return;
        }
        const dict = obj as Record<string, unknown>;
        if (dict['_meta'] && typeof dict['_meta'] === 'object') {
          const meta = dict['_meta'] as Record<string, unknown>;
          if (meta['engine'] !== undefined) engine = meta['engine'] as string;
          if (meta['degraded'] !== undefined) degraded = meta['degraded'] as boolean;
          if (meta['latencyMs'] !== undefined) latencyMs = meta['latencyMs'] as number;
        }
        if (dict['content'] && Array.isArray(dict['content'])) {
          for (const c of dict['content'] as Array<Record<string, unknown>>) {
            if (c['text'] && typeof c['text'] === 'string') {
              try {
                const inner = JSON.parse(c['text'] as string);
                if (inner?.error) success = false;
              } catch { /* not JSON */ }
            }
          }
        }
        for (const v of Object.values(dict)) {
          if (v && typeof v === 'object') searchForMeta(v);
        }
      };

      // Search tool_result content
      if (ev.toolResultContent) {
        const content = typeof ev.toolResultContent === 'string'
          ? ev.toolResultContent : JSON.stringify(ev.toolResultContent);
        try { searchForMeta(JSON.parse(content)); } catch { /* not JSON */ }
      }
      // Search raw event (Claude CLI may embed _meta at different levels)
      if (ev.raw) {
        searchForMeta(ev.raw);
      }

      const toolName = lastToolName.replace(/^mcp__[^_]+__/, '');
      if (toolName) {
        trace.push({ tool: toolName, engine, degraded, latencyMs, success, order: order++ });
      }
    }
  }

  return trace;
}

/**
 * Aggregate engine usage counts from architecture trace.
 */
export function aggregateEngineUsage(trace: ArchitectureTraceEntry[]): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const entry of trace) {
    usage[entry.engine] = (usage[entry.engine] ?? 0) + 1;
  }
  return usage;
}
