/**
 * Internal CANONICAL judge verdict.
 *
 * The judge module (Task 4, future) is responsible for mapping upstream
 * gpt-4o tokens 'SUCCESS' / 'NOT SUCCESS' into this internal type
 * (e.g. 'NOT SUCCESS' → 'FAILURE'). Do NOT change this enum to upstream
 * tokens — that mapping is intentionally a Task 4 concern.
 */
export type JudgeVerdict = 'SUCCESS' | 'FAILURE' | 'UNKNOWN';

export interface WebVoyagerTask {
  id: string;
  site: string;
  url: string;
  question: string;
}

export interface WebVoyagerScore {
  task_id: string;
  variant: string;
  verdict: JudgeVerdict;
  judge_reasoning: string;
  agent_final_text: string;
  run_seq: number;
  wall_ms: number;
  screenshot_path: string;
  failure_reason?: string;
}

interface RawTask {
  web_name?: unknown;
  id?: unknown;
  ques?: unknown;
  web?: unknown;
}

export function parseWebVoyagerTask(line: string): WebVoyagerTask {
  let raw: RawTask;
  try {
    raw = JSON.parse(line) as RawTask;
  } catch (err) {
    throw new Error(`Failed to parse WebVoyager task line as JSON: ${(err as Error).message}`);
  }

  const missing: string[] = [];
  if (typeof raw.id !== 'string') missing.push('id');
  if (typeof raw.web_name !== 'string') missing.push('web_name');
  if (typeof raw.ques !== 'string') missing.push('ques');
  if (typeof raw.web !== 'string') missing.push('web');

  if (missing.length > 0) {
    throw new Error(`WebVoyager task is missing required field(s): ${missing.join(', ')}`);
  }

  return {
    id: raw.id as string,
    site: raw.web_name as string,
    url: raw.web as string,
    question: raw.ques as string,
  };
}
