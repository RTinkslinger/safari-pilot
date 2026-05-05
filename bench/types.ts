/**
 * bench/types.ts — shared type contracts for the agent benchmark harness
 */

export interface BenchTask {
  id: string;
  description: string;
  fixtureRoute: string;
  successOracle: {
    type: 'tool_called_with' | 'final_text_contains' | 'no_strict_violation';
    tool?: string;
    argMatch?: Record<string, unknown>;
    text?: string;
  };
  maxIterations: number;
  budgetTokens: number;
}

export interface BenchScore {
  task_id: string;
  variant: string;
  success: boolean;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  wall_ms: number;
  /** wall_ms * (input_tokens + output_tokens) — the primary optimization target */
  tt: number;
  failure_reason?: string;
}
