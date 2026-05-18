// src/tools/batch.ts
//
// v0.1.36 — safari_batch: execute up to 4 safari_* actions sequentially in
// one MCP round-trip.
//
// Why this exists. Browser-Use's "max_actions_per_step=4" pattern is the
// single biggest lever after timeout tuning for WebVoyager-style tasks
// (per deep research 2026-05-17). Median task uses ~28 tool calls; if the
// agent groups them in batches of 3-4, that's ~7-10 LLM round-trips
// instead of 28. With per-LLM round-trip latency ~10-30s on a Max-billed
// session, that saves ~5 minutes per task in raw model time.
//
// Contract:
//   safari_batch({ actions: [{ tool, args }, ...], stopOnError })
//   -> { content: [{ type: "text", text: JSON.stringify({ results: [...] }) }] }
//
// Each sub-action runs through the FULL security pipeline (kill switch,
// tab ownership, domain policy, rate limit, circuit breaker, engine
// selection, F3.1 catch-block). This is intentional: each sub-action
// consumes its own rate-limit budget, contributes to loop-detector
// history, gets its own audit-log entry. Batching is a transport
// optimization, NOT a way to bypass security.
//
// stopOnError defaults to false. The agent often wants to capture as
// much state as possible even if one mid-batch op fails (e.g., navigate
// + multiple extracts: if one extract fails, the others should still
// run). When stopOnError is true, the loop short-circuits at the first
// failure — appropriate when subsequent ops depend on earlier ones.

import type { ToolResponse, ToolRequirements } from '../types.js';
import type { SafariPilotServer } from '../server.js';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export const MAX_BATCH_ACTIONS = 4;

interface BatchAction {
  tool: string;
  args?: Record<string, unknown>;
}

interface BatchSubResult {
  tool: string;
  ok: boolean;
  isError?: boolean;
  content: ToolResponse['content'];
  metadata?: ToolResponse['metadata'];
  /** Populated when the sub-action throws (non-SafariPilotError) — bare error info. */
  error?: { message: string; code?: string };
}

export class BatchTools {
  private server: SafariPilotServer;
  private handlers: Map<string, Handler> = new Map();

  constructor(server: SafariPilotServer) {
    this.server = server;
    this.handlers.set('safari_batch', this.handleBatch.bind(this));
  }

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_batch',
        description:
          'Execute up to 4 safari_* actions sequentially in ONE MCP round-trip. '
          + 'Use when planning a known sequence (e.g., new_tab + snapshot + click + take_screenshot) '
          + 'to cut LLM round-trips by 3-4x. Each sub-action goes through the full security pipeline; '
          + 'results array is returned in order. Sub-actions cannot themselves call safari_batch (nesting rejected).',
        inputSchema: {
          type: 'object',
          properties: {
            actions: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_BATCH_ACTIONS,
              description: `List of actions to execute (max ${MAX_BATCH_ACTIONS}). Each: { tool: "safari_xxx", args: {...} }.`,
              items: {
                type: 'object',
                properties: {
                  tool: { type: 'string', description: 'Tool name (must start with "safari_", excluding safari_batch itself).' },
                  args: { type: 'object', description: 'Arguments dict for the tool. Same shape as direct invocation.' },
                },
                required: ['tool'],
              },
            },
            stopOnError: {
              type: 'boolean',
              default: false,
              description: 'When true, stop at first sub-action failure. When false (default), continue and collect all results.',
            },
          },
          required: ['actions'],
        },
        requirements: { idempotent: false },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  private async handleBatch(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const actions = params['actions'] as BatchAction[] | undefined;
    const stopOnError = params['stopOnError'] === true;

    if (!Array.isArray(actions) || actions.length === 0) {
      throw Object.assign(new Error('safari_batch: actions array is required and must be non-empty'), { code: 'INVALID_PARAMS' });
    }
    if (actions.length > MAX_BATCH_ACTIONS) {
      throw Object.assign(
        new Error(`safari_batch: max ${MAX_BATCH_ACTIONS} actions per batch (got ${actions.length})`),
        { code: 'INVALID_PARAMS' },
      );
    }
    // Reject nested batches eagerly so the loop detector / rate limiter
    // can't see a hidden multiplier.
    for (const [i, a] of actions.entries()) {
      if (!a || typeof a.tool !== 'string') {
        throw Object.assign(new Error(`safari_batch: actions[${i}].tool must be a string`), { code: 'INVALID_PARAMS' });
      }
      if (a.tool === 'safari_batch') {
        throw Object.assign(new Error('safari_batch: nested safari_batch calls are not allowed'), { code: 'INVALID_PARAMS' });
      }
      if (!a.tool.startsWith('safari_')) {
        throw Object.assign(new Error(`safari_batch: tool "${a.tool}" must start with "safari_"`), { code: 'INVALID_PARAMS' });
      }
    }

    const results: BatchSubResult[] = [];
    for (const action of actions) {
      try {
        const subResponse = await this.server.executeToolWithSecurity(action.tool, action.args ?? {});
        results.push({
          tool: action.tool,
          ok: !subResponse.isError,
          isError: subResponse.isError,
          content: subResponse.content,
          metadata: subResponse.metadata,
        });
        if (subResponse.isError && stopOnError) break;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: unknown })?.code;
        results.push({
          tool: action.tool,
          ok: false,
          content: [{ type: 'text', text: message }],
          error: { message, code: typeof code === 'string' ? code : undefined },
        });
        if (stopOnError) break;
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results,
            executed: results.length,
            total: actions.length,
            stopOnError,
          }),
        },
      ],
      metadata: {
        engine: 'extension',
        degraded: false,
        latencyMs: Date.now() - start,
      },
    };
  }
}
