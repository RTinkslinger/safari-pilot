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
