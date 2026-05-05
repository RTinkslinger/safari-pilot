// src/skills/runner.ts
// Executes a Skill's procedure: walks steps, interpolates {{name}} from scope,
// dispatches each step's tool through a provided dispatch function. Supports
// `_loop` over an array, with a per-iteration alias variable.
import type { Skill, SkillStep } from './registry.js';

type ToolDispatch = (name: string, args: Record<string, unknown>) => Promise<unknown>;

function interp(template: unknown, scope: Record<string, unknown>): unknown {
  if (typeof template === 'string') {
    // Replace {{path.to.value}} with scope lookup. Whole-string replace if
    // the template is just one placeholder so we preserve types (numbers,
    // arrays, objects). Otherwise stringify.
    const wholeMatch = template.match(/^\{\{([^}]+)\}\}$/);
    if (wholeMatch) {
      const path = (wholeMatch[1] as string).trim().split('.');
      let v: unknown = scope;
      for (const p of path) {
        if (v && typeof v === 'object' && p in (v as Record<string, unknown>)) {
          v = (v as Record<string, unknown>)[p];
        } else { v = undefined; break; }
      }
      return v;
    }
    return template.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
      const path = expr.trim().split('.');
      let v: unknown = scope;
      for (const p of path) {
        if (v && typeof v === 'object' && p in (v as Record<string, unknown>)) {
          v = (v as Record<string, unknown>)[p];
        } else { return ''; }
      }
      return String(v);
    });
  }
  if (Array.isArray(template)) return template.map((t) => interp(t, scope));
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = interp(v, scope);
    }
    return out;
  }
  return template;
}

export async function runSkill(
  skill: Skill,
  inputs: Record<string, unknown>,
  dispatch: ToolDispatch,
): Promise<{ outputs: Record<string, unknown>; trace: Array<{ tool: string; args: unknown; result: unknown }> }> {
  const scope: Record<string, unknown> = { ...inputs };
  const trace: Array<{ tool: string; args: unknown; result: unknown }> = [];

  async function runStep(step: SkillStep): Promise<void> {
    if (step.tool === '_loop') {
      const list = interp(step.over!, scope) as unknown;
      const items = Array.isArray(list)
        ? list
        : (typeof list === 'string' ? (JSON.parse(list) as unknown[]) : []);
      for (const item of items) {
        scope[step.as!] = item;
        for (const inner of step.do ?? []) await runStep(inner);
      }
      return;
    }
    const args = (interp(step.args ?? {}, scope) as Record<string, unknown>);
    const result = await dispatch(step.tool, args);
    trace.push({ tool: step.tool, args, result });
    if (step.saveAs) scope[step.saveAs] = result;
  }

  for (const step of skill.steps) await runStep(step);
  return { outputs: scope, trace };
}
