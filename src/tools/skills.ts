// src/tools/skills.ts
import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';
import type { SkillRegistry } from '../skills/registry.js';
import { runSkill } from '../skills/runner.js';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}
type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;
type ToolDispatch = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export class SkillTools {
  private engine: IEngine;
  private registry: SkillRegistry;
  private dispatch: ToolDispatch;

  constructor(engine: IEngine, registry: SkillRegistry, dispatch: ToolDispatch) {
    this.engine = engine;
    this.registry = registry;
    this.dispatch = dispatch;
  }

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_run_skill',
        description: 'Execute a registered Skill (composed multi-tool workflow). Use when the task matches a skill\'s trigger phrase — login, paginate-and-scrape, robust-form-fill. Replaces 4-6 raw tool calls with one. Skills are visible via safari_list_skills.',
        inputSchema: {
          type: 'object',
          properties: {
            skill: { type: 'string', description: 'Skill name from safari_list_skills' },
            inputs: { type: 'object', description: 'Skill-specific inputs object' },
          },
          required: ['skill', 'inputs'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_list_skills',
        description: 'List available Skills with their triggers, descriptions, and required inputs. Use when starting a task — lets you discover whether a Skill matches before reaching for raw tools.',
        inputSchema: { type: 'object', properties: {} },
        requirements: { idempotent: true },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    if (name === 'safari_run_skill') {
      return async (params) => {
        const start = Date.now();
        const skillName = params['skill'] as string;
        const inputs = (params['inputs'] as Record<string, unknown>) ?? {};
        const skill = this.registry.get(skillName);
        if (!skill) throw new Error(`Unknown skill: ${skillName}`);
        const { outputs, trace } = await runSkill(skill, inputs, this.dispatch);
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, outputs, trace }) }],
          metadata: {
            engine: this.engine.name as Engine,
            degraded: false,
            latencyMs: Date.now() - start,
          },
        };
      };
    }
    if (name === 'safari_list_skills') {
      return async () => {
        const list = this.registry.list().map((s) => ({
          name: s.name,
          description: s.description,
          triggers: s.triggers,
          inputs: s.inputs,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify({ skills: list }) }],
          metadata: { engine: this.engine.name as Engine, degraded: false, latencyMs: 0 },
        };
      };
    }
    return undefined;
  }
}
