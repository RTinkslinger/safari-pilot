// ─── Constants ────────────────────────────────────────────────────────────────

export const CATEGORIES = [
  'navigation',
  'forms',
  'extraction',
  'workflows',
  'dom-complexity',
  'auth-flows',
  'accessibility',
  'error-recovery',
  'safari-specific',
  'intelligence',
  'competitive',
] as const;

export const DIFFICULTIES = ['easy', 'medium', 'hard', 'intelligence'] as const;

export const EVAL_TYPES = [
  'exact_match',
  'contains',
  'structured_output',
  'llm_judge',
] as const;

// ─── Derived Types ─────────────────────────────────────────────────────────────

export type Category = (typeof CATEGORIES)[number];
export type Difficulty = (typeof DIFFICULTIES)[number];
export type EvalType = (typeof EVAL_TYPES)[number];

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface TaskRequires {
  tools: string[];
  engines: string[];
  auth_domains: string[];
  features: string[];
  competitive: boolean;
}

export interface TaskEval {
  type: EvalType;
  expected?: string;
  must_include?: string[];
  schema?: Record<string, unknown>;
  criteria?: string;
  case_insensitive?: boolean;
}

export interface BenchmarkTask {
  id: string;
  category: Category;
  difficulty: Difficulty;
  intent: string;
  intent_template?: string;
  instantiation_dict?: Record<string, string>;
  start_url?: string;
  requires: TaskRequires;
  eval: TaskEval;
  reference_answers?: Record<string, unknown>;
  eval_fallback?: TaskEval;
  timeout_ms: number;
  max_budget_usd: number;
  tags: string[];
  roadmap_gate?: string | null;
  enabled_after?: string | null;
}

export interface TaskResult {
  taskId: string;
  model: string;
  success: boolean;
  evalMethod: EvalType;
  evalDetails: string;
  fallbackUsed: boolean;
  skipped: boolean;
  skipReason?: string;
  steps: number;
  durationMs: number;
  toolsUsed: string[];
  enginesUsed: string[];
  reasoningExcerpts: string[];
  error?: string;
  rawOutput?: string;
}

export interface StreamEvent {
  type: 'tool_use' | 'tool_result' | 'text' | 'system' | 'error' | 'unknown';
  timestamp: number;
  toolName?: string;
  toolInput?: unknown;
  toolResultContent?: unknown;
  toolResultError?: string;
  textContent?: string;
  raw: unknown;
}

export interface RunConfig {
  models: string[];
  parallel: number;
  categories: Category[];
  taskIds: string[];
  competitive: boolean;
  dryRun: boolean;
  timeoutMultiplier: number;
  fixturePort: number;
}

export interface CategoryResult {
  passed: number;
  failed: number;
  skipped: number;
  rate: number;
}

export interface CompetitiveResult {
  taskId: string;
  safariPilotSuccess: boolean;
  safariPilotSteps: number;
  safariPilotDurationMs: number;
  playwrightSuccess: boolean;
  playwrightSteps: number;
  playwrightDurationMs: number;
  winner: 'safari-pilot' | 'playwright' | 'tie' | 'both-failed';
}

export interface RunReport {
  id: string;
  model: string;
  commit: string;
  branch: string;
  timestamp: string;
  eligible: number;
  skipped: number;
  passed: number;
  failed: number;
  overallRate: number;
  byCategory: Record<string, CategoryResult>;
  intelligenceRate: number;
  competitiveWinRate: number;
  competitive: CompetitiveResult[];
  meanSteps: number;
  p50DurationMs: number;
  p95DurationMs: number;
  flakyCount: number;
  perTask: TaskResult[];
}

export interface HistoryFile {
  runs: RunReport[];
}

export interface PreflightResult {
  availableTools: string[];
  healthyEngines: string[];
  authenticatedDomains: string[];
  competitiveReady: boolean;
  fixtureServerRunning: boolean;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateTask(task: BenchmarkTask): string[] {
  const errors: string[] = [];

  // Guard against null/undefined/non-object input from JSON parsing
  if (!task || typeof task !== 'object') {
    return ['task must be a non-null object'];
  }

  if (!task.id || task.id.trim() === '') {
    errors.push('id is required');
  }

  if (!CATEGORIES.includes(task.category as Category)) {
    errors.push(`category must be one of: ${CATEGORIES.join(', ')} (got "${task.category}")`);
  }

  if (!DIFFICULTIES.includes(task.difficulty as Difficulty)) {
    errors.push(
      `difficulty must be one of: ${DIFFICULTIES.join(', ')} (got "${task.difficulty}")`
    );
  }

  if (!task.intent || task.intent.trim() === '') {
    errors.push('intent is required');
  }

  if (!EVAL_TYPES.includes(task.eval?.type as EvalType)) {
    errors.push(
      `eval.type must be one of: ${EVAL_TYPES.join(', ')} (got "${task.eval?.type}")`
    );
  }

  if (typeof task.timeout_ms !== 'number' || task.timeout_ms <= 0) {
    errors.push(`timeout_ms must be positive (got ${task.timeout_ms})`);
  }

  if (typeof task.max_budget_usd !== 'number' || task.max_budget_usd < 0) {
    errors.push(`max_budget_usd must be non-negative (got ${task.max_budget_usd})`);
  }

  return errors;
}
