import { execSync } from 'child_process';
import type { TaskEval, EvalType } from './types.js';

// ─── EvalResult ───────────────────────────────────────────────────────────────

export interface EvalResult {
  passed: boolean;
  evalType: EvalType;
  details: Record<string, unknown>;
  pending?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Try to parse output as JSON and return the `.result` field if present.
 * Falls back to the raw string if parsing fails or `.result` is absent.
 */
export function extractResult(output: string): string {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj['result'] === 'string') {
        return obj['result'];
      }
    }
  } catch {
    // not JSON — use as-is
  }
  return output;
}

/**
 * Minimal JSON Schema validator for object schemas.
 * Checks: required fields, string/number/boolean/array types, array minItems.
 * Returns an array of error messages (empty = valid).
 */
export function validateSchemaSimple(
  schema: Record<string, unknown>,
  data: unknown
): string[] {
  const errors: string[] = [];

  if (schema['type'] === 'object') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      errors.push('expected an object');
      return errors;
    }

    const obj = data as Record<string, unknown>;

    // Check required fields
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const field of required as string[]) {
        if (!(field in obj)) {
          errors.push(`missing required field: ${field}`);
        }
      }
    }

    // Check property types
    const properties = schema['properties'];
    if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
      const props = properties as Record<string, Record<string, unknown>>;
      for (const [key, propSchema] of Object.entries(props)) {
        if (!(key in obj)) continue; // already caught by required check if needed

        const value = obj[key];
        const expectedType = propSchema['type'];

        if (expectedType === 'string' && typeof value !== 'string') {
          errors.push(`field "${key}" must be a string`);
        } else if (expectedType === 'number' && typeof value !== 'number') {
          errors.push(`field "${key}" must be a number`);
        } else if (expectedType === 'boolean' && typeof value !== 'boolean') {
          errors.push(`field "${key}" must be a boolean`);
        } else if (expectedType === 'array') {
          if (!Array.isArray(value)) {
            errors.push(`field "${key}" must be an array`);
          } else {
            const minItems = propSchema['minItems'];
            if (typeof minItems === 'number' && value.length < minItems) {
              errors.push(
                `field "${key}" must have at least ${minItems} items (got ${value.length})`
              );
            }
          }
        }
      }
    }
  } else if (schema['type'] === 'array') {
    if (!Array.isArray(data)) {
      errors.push('expected an array');
      return errors;
    }
    const minItems = schema['minItems'];
    if (typeof minItems === 'number' && data.length < minItems) {
      errors.push(`array must have at least ${minItems} items (got ${data.length})`);
    }
  }

  return errors;
}

// ─── Eval Dispatch ────────────────────────────────────────────────────────────

function evalExactMatch(evalDef: TaskEval, output: string): EvalResult {
  const expected = evalDef.expected ?? '';
  const candidate = extractResult(output);

  const lhs = evalDef.case_insensitive ? candidate.toLowerCase() : candidate;
  const rhs = evalDef.case_insensitive ? expected.toLowerCase() : expected;

  const passed = lhs === rhs;
  return {
    passed,
    evalType: 'exact_match',
    details: { expected, actual: candidate },
  };
}

function evalContains(evalDef: TaskEval, output: string): EvalResult {
  const mustInclude = evalDef.must_include ?? [];

  if (mustInclude.length === 0) {
    // Nothing required but field was missing — treat as failure to surface misconfiguration
    return {
      passed: false,
      evalType: 'contains',
      details: { error: 'must_include is empty or undefined', missing: [] },
    };
  }

  const lowerOutput = output.toLowerCase();
  const missing = mustInclude.filter(
    (s) => !lowerOutput.includes(s.toLowerCase())
  );

  return {
    passed: missing.length === 0,
    evalType: 'contains',
    details: { mustInclude, missing },
  };
}

function evalStructuredOutput(evalDef: TaskEval, output: string): EvalResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return {
      passed: false,
      evalType: 'structured_output',
      details: { error: 'output is not valid JSON', rawOutput: output },
    };
  }

  const schema = (evalDef.schema ?? {}) as Record<string, unknown>;
  const schemaErrors = validateSchemaSimple(schema, parsed);

  return {
    passed: schemaErrors.length === 0,
    evalType: 'structured_output',
    details: { schemaErrors },
  };
}

function evalLlmJudge(evalDef: TaskEval, _output: string): EvalResult {
  return {
    passed: false,
    pending: true,
    evalType: 'llm_judge',
    details: { criteria: evalDef.criteria ?? '' },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Synchronous evaluator. Dispatches to the correct eval strategy based on type.
 * For llm_judge, returns a pending result — call evaluateWithLlmJudge separately.
 */
export function evaluate(evalDef: TaskEval, output: string): EvalResult {
  switch (evalDef.type) {
    case 'exact_match':
      return evalExactMatch(evalDef, output);
    case 'contains':
      return evalContains(evalDef, output);
    case 'structured_output':
      return evalStructuredOutput(evalDef, output);
    case 'llm_judge':
      return evalLlmJudge(evalDef, output);
    default: {
      const exhaustive: never = evalDef.type;
      return {
        passed: false,
        evalType: exhaustive,
        details: { error: `unknown eval type: ${String(exhaustive)}` },
      };
    }
  }
}

/**
 * Async LLM-based judge. Spawns the claude CLI and parses YES/NO from the
 * first line of its response.
 *
 * Not covered by unit tests — requires the Claude CLI and network access.
 */
export async function evaluateWithLlmJudge(
  criteria: string,
  output: string
): Promise<EvalResult> {
  const prompt = [
    'You are an evaluation judge. Given the following criteria and output, respond with YES if the output satisfies the criteria, or NO if it does not.',
    '',
    `Criteria: ${criteria}`,
    '',
    `Output: ${output}`,
    '',
    'Respond with YES or NO on the first line, followed by a brief explanation.',
  ].join('\n');

  let responseText = '';
  try {
    responseText = execSync(
      `claude -p ${JSON.stringify(prompt)} --model claude-haiku-4-5 --output-format text --no-session-persistence --max-budget-usd 0.02`,
      { encoding: 'utf-8', timeout: 30_000 }
    );
  } catch (err) {
    return {
      passed: false,
      evalType: 'llm_judge',
      details: { error: String(err), criteria },
    };
  }

  const firstLine = responseText.trim().split('\n')[0]?.trim().toUpperCase() ?? '';
  const passed = firstLine.startsWith('YES');

  return {
    passed,
    evalType: 'llm_judge',
    details: { criteria, firstLine, fullResponse: responseText.trim() },
  };
}
