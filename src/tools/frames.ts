import type { ToolResponse, ToolRequirements } from '../types.js';
import type { IEngine } from '../engines/engine.js';
import type { Engine } from '../types.js';
import { escapeForJsSingleQuote, escapeForTemplateLiteral } from '../escape.js';
import { routeFrameAware } from './_frame-routing-helper.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class FrameTools {
  private engine: IEngine;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: IEngine) {
    this.engine = engine;
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.handlers.set('safari_list_frames', this.handleListFrames.bind(this));
    this.handlers.set('safari_eval_in_frame', this.handleEvalInFrame.bind(this));
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_list_frames',
        description:
          'List all iframes on the current page. Returns each frame\'s frameId+parentFrameId+url ' +
          '(extension engine) or src+name+id+dimensions with frameId=null (AppleScript engine).',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: true },
      },
      {
        name: 'safari_eval_in_frame',
        description:
          'Execute arbitrary JavaScript inside a specific iframe\'s context. ' +
          'Cross-origin frames require the extension engine and frameId (from safari_list_frames). ' +
          'Same-origin frames can use frameSelector. When both frameId and frameSelector are ' +
          'provided, frameId takes precedence.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            frameSelector: { type: 'string', description: 'CSS selector for the target iframe (same-origin only)' },
            frameId: { type: 'number', description: 'Numeric frameId from safari_list_frames (required for cross-origin frames)' },
            script: { type: 'string', description: 'JavaScript code to execute inside the frame' },
          },
          required: ['tabUrl', 'script'],
        },
        requirements: { idempotent: false, requiresFramesCrossOrigin: true },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleListFrames(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    // Extension path: use webNavigation.getAllFrames via the __SP_LIST_FRAMES__
    // sentinel. background.js intercepts this in executeCommand and returns the
    // frame topology directly — no DOM enumeration, no merge.
    if (this.engine.name === 'extension') {
      const result = await this.engine.executeJsInTab(tabUrl, '__SP_LIST_FRAMES__');
      if (!result.ok) throw new Error(result.error?.message ?? 'List frames failed');
      return this.makeResponse(
        result.value ? JSON.parse(result.value) : { count: 0, frames: [] },
        Date.now() - start,
      );
    }

    // AppleScript path: existing top-frame DOM enumeration; frameId is null
    // because no API exists from the AppleScript engine to resolve frameIds.
    const js = `
      var frames = Array.from(document.querySelectorAll('iframe'));
      return {
        count: frames.length,
        frames: frames.map(function(f, idx) {
          var rect = f.getBoundingClientRect();
          return {
            index: idx,
            frameId: null,
            parentFrameId: null,
            src: f.src || null,
            name: f.name || null,
            id: f.id || null,
            width: f.width || rect.width,
            height: f.height || rect.height,
            sandbox: f.sandbox ? f.sandbox.value : null,
          };
        }),
      };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'List frames failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { count: 0, frames: [] }, Date.now() - start);
  }

  private async handleEvalInFrame(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const frameId = params['frameId'] as number | undefined;
    const frameSelector = params['frameSelector'] as string | undefined;
    const script = params['script'] as string;

    // Cross-origin path: frameId set + extension engine. routeFrameAware
    // enforces engine === 'extension' and dispatches to executeJsInFrame.
    if (frameId != null && frameId !== 0) {
      const result = await routeFrameAware(this.engine, { tabUrl, frameId }, script);
      if (!result.ok) throw new Error(result.error?.message ?? 'Frame eval failed');
      return this.makeResponse(
        result.value ? JSON.parse(result.value) : { ok: false, error: 'No result' },
        Date.now() - start,
      );
    }

    // Same-origin path: existing contentWindow.Function dispatch via top-frame eval.
    if (!frameSelector) {
      throw new Error('safari_eval_in_frame requires either frameId (cross-origin) or frameSelector (same-origin)');
    }

    const escapedSelector = escapeForJsSingleQuote(frameSelector);
    // Escape the user script for embedding inside a JS string template
    const escapedScript = escapeForTemplateLiteral(script);

    const js = `
      var frame = document.querySelector('${escapedSelector}');
      if (!frame) throw Object.assign(new Error('Frame not found: ${escapedSelector}'), { name: 'ELEMENT_NOT_FOUND' });
      if (frame.tagName !== 'IFRAME') throw new Error('Element is not an iframe: ${escapedSelector}');

      var win = frame.contentWindow;
      if (!win) throw new Error('Cannot access frame contentWindow (detached or sandboxed)');

      var userScript = \`${escapedScript}\`;
      var result;
      try {
        // T20: dropped the eval-call pattern in favor of new Function — the
        // codebase convention. extension/content-main.js:11,323 captures
        // Function as _Function before any page script runs. User scripts
        // must use explicit \`return\` (matches content-main.js's contract).
        result = new win.Function(userScript)();
      } catch (e) {
        if (e instanceof DOMException && e.name === 'SecurityError') {
          throw new Error('Cross-origin frame eval blocked by browser security policy. Use safari_get_text with the frame URL directly instead.');
        }
        return { ok: false, error: e.message };
      }

      var serialized;
      try {
        serialized = JSON.stringify(result);
      } catch (_) {
        serialized = String(result);
      }

      return { ok: true, result: serialized !== undefined ? JSON.parse(serialized) : null };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Frame eval failed');

    return this.makeResponse(
      result.value ? JSON.parse(result.value) : { ok: false, error: 'No result' },
      Date.now() - start,
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private makeResponse(data: unknown, latencyMs: number = 0): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript' as Engine, degraded: false, latencyMs },
    };
  }
}
