import type { ToolResponse, ToolRequirements } from '../types.js';
import type { IEngine } from '../engines/engine.js';
import type { ToolDefinition } from './navigation.js';

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

/**
 * JS that reads clipboard text.
 * navigator.clipboard.readText() requires a user gesture in Safari; if it
 * rejects, we surface a capability flag so callers can branch accordingly.
 */
const CLIPBOARD_READ_JS = `
(async () => {
  try {
    const text = await navigator.clipboard.readText();
    return JSON.stringify({ text, clipboardAvailable: true });
  } catch (err) {
    return JSON.stringify({ text: null, clipboardAvailable: false, error: String(err) });
  }
})()
`.trim();

/** JS that writes text to the clipboard. */
function buildClipboardWriteJs(text: string): string {
  const escaped = JSON.stringify(text);
  return `
(async () => {
  try {
    await navigator.clipboard.writeText(${escaped});
    return JSON.stringify({ written: true, text: ${escaped} });
  } catch (err) {
    return JSON.stringify({ written: false, error: String(err) });
  }
})()
`.trim();
}

export class ClipboardTools {
  constructor(private readonly engine: IEngine) {}

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_clipboard_read',
        description:
          'Read the current clipboard text content from the page context. ' +
          'Returns the clipboard text and a clipboardAvailable flag. ' +
          'Note: navigator.clipboard.readText() requires a prior user gesture in Safari — ' +
          'if unavailable, clipboardAvailable will be false.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab to read clipboard from' },
          },
          required: ['tabUrl'],
        },
        requirements: {} as ToolRequirements,
      },
      {
        name: 'safari_clipboard_write',
        description: 'Write text to the clipboard from the page context via navigator.clipboard.writeText().',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab to execute clipboard write in' },
            text: { type: 'string', description: 'Text to write to the clipboard' },
          },
          required: ['tabUrl', 'text'],
        },
        requirements: {} as ToolRequirements,
      },
    ];
  }

  getHandler(name: string): Handler {
    switch (name) {
      case 'safari_clipboard_read':
        return (p) => this.handleClipboardRead(p);
      case 'safari_clipboard_write':
        return (p) => this.handleClipboardWrite(p);
      default:
        throw new Error(`ClipboardTools: unknown tool "${name}"`);
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleClipboardRead(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    const result = await this.engine.executeJsInTab(tabUrl, CLIPBOARD_READ_JS);

    if (!result.ok) {
      return this.errorResponse(result.error?.message ?? 'Clipboard read failed', start);
    }

    const data = this.parseJson(result.value) ?? { text: null, clipboardAvailable: false };
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  private async handleClipboardWrite(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const text = params['text'] as string;

    const js = buildClipboardWriteJs(text);
    const result = await this.engine.executeJsInTab(tabUrl, js);

    if (!result.ok) {
      return this.errorResponse(result.error?.message ?? 'Clipboard write failed', start);
    }

    const data = this.parseJson(result.value) ?? { written: false };
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript', degraded: false, latencyMs: Date.now() - start },
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private parseJson(value?: string): Record<string, unknown> | undefined {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  private errorResponse(message: string, start: number): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
      metadata: { engine: 'applescript', degraded: true, latencyMs: Date.now() - start },
    };
  }
}
