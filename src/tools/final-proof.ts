/**
 * v0.1.35 Task 7 — safari_compose_final_evidence
 *
 * Pre-answer evidence composer. Scrolls to a (locator-identified) evidence
 * element, captures a screenshot of the visible viewport, and extracts the
 * matching DOM snippet. The agent is expected to call this immediately
 * before producing a final answer that references on-page evidence — the
 * resulting screenshot + DOM snippet visually grounds the answer for any
 * downstream screenshot-based judge.
 *
 * Routing: `requiresCspBypass: 'preferred'` — prefer the extension engine
 * (which actually owns the __SP_COMPOSE_FINAL_EVIDENCE__ sentinel handler in
 * content-main.js) but allow degradation to AppleScript/Daemon rather than
 * throwing on extension-down paths.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';

const execFileP = promisify(execFile);

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

export class FinalProofTools {
  constructor(private readonly engine: IEngine) {}

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_compose_final_evidence',
        description:
          'Compose evidence for a claim before answering. Scrolls to the claim element ' +
          '(if locator given), captures a screenshot, and extracts the matching DOM snippet. ' +
          'Use before answering when your final response references on-page evidence — the ' +
          'screenshot will visually confirm your claim to a screenshot-based judge.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            claim: {
              type: 'string',
              description: 'The textual claim you intend to make in your answer.',
            },
            evidence_locator: {
              type: 'object',
              description:
                'Optional: locator pointing to the DOM element that contains the evidence. ' +
                'If omitted, the full page is sampled.',
            },
          },
          required: ['tabUrl', 'claim'],
        },
        requirements: { idempotent: true, requiresCspBypass: 'preferred' },
      },
    ];
  }

  getHandler(name: string): ((params: Record<string, unknown>) => Promise<ToolResponse>) | undefined {
    if (name !== 'safari_compose_final_evidence') return undefined;
    return async (params) => {
      const start = Date.now();
      const tabUrl = params['tabUrl'] as string;
      const claim = params['claim'] as string;
      const evidence_locator = params['evidence_locator'] as Record<string, unknown> | undefined;

      const sentinel =
        '__SP_COMPOSE_FINAL_EVIDENCE__:' + JSON.stringify({ claim, locator: evidence_locator });

      const evalResult = await this.engine.executeJsInTab(tabUrl, sentinel, 10_000);
      if (!evalResult.ok) {
        const err = new Error(
          `safari_compose_final_evidence failed: ${evalResult.error?.message ?? 'unknown'}`,
        );
        if (evalResult.error?.code) (err as Error & { code?: string }).code = evalResult.error.code;
        throw err;
      }

      const parsed = evalResult.value
        ? (JSON.parse(evalResult.value) as { dom_snippet?: string; claim_grounded?: boolean })
        : {};
      const dom_snippet = typeof parsed.dom_snippet === 'string' ? parsed.dom_snippet : '';
      const claim_grounded = parsed.claim_grounded === true;

      // Capture screenshot via macOS `screencapture` to a temp PNG. We use the
      // shell tool (rather than the daemon's tab-capture path) because this is
      // an "evidence package for the judge" — a whole-screen PNG is acceptable
      // and matches the pre-existing fallback in handleTakeScreenshot.
      let screenshot_path = '';
      try {
        const dir = mkdtempSync(join(tmpdir(), 'sp-final-proof-'));
        screenshot_path = join(dir, 'evidence.png');
        await execFileP('screencapture', ['-x', '-t', 'png', screenshot_path], { timeout: 8000 });
      } catch (e) {
        // Screenshot failure is degrading but not fatal — the DOM snippet +
        // claim_grounded result are still useful evidence on their own.
        screenshot_path = '';
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                screenshot_path: '',
                dom_snippet,
                claim_grounded,
                screenshot_error: msg,
              }),
            },
          ],
          metadata: {
            engine: 'extension' as Engine,
            degraded: true,
            degradedReason: 'screenshot_capture_failed',
            latencyMs: Date.now() - start,
            screenshot_path: '',
            dom_snippet,
            claim_grounded,
          },
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ screenshot_path, dom_snippet, claim_grounded }),
          },
        ],
        metadata: {
          engine: 'extension' as Engine,
          degraded: false,
          latencyMs: Date.now() - start,
          screenshot_path,
          dom_snippet,
          claim_grounded,
        },
      };
    };
  }
}
