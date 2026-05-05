// src/skills/registry.ts
// Loads SKILL.md files: YAML frontmatter (name, description, triggers, inputs)
// + a single ```json``` code block declaring { steps: [...] }.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SkillStep {
  tool: string;
  args?: Record<string, unknown>;
  saveAs?: string;
  over?: string;
  as?: string;
  do?: SkillStep[];
}

export interface Skill {
  name: string;
  description: string;
  triggers: string[];
  inputs: string[];
  steps: SkillStep[];
}

export class SkillRegistry {
  private skills: Map<string, Skill> = new Map();

  static async fromDir(dir: string): Promise<SkillRegistry> {
    const reg = new SkillRegistry();
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.SKILL.md'));
    } catch {
      return reg;
    }
    for (const f of files) {
      try {
        const raw = await readFile(join(dir, f), 'utf8');
        const skill = SkillRegistry.parse(raw);
        if (skill) reg.skills.set(skill.name, skill);
      } catch { /* skip malformed */ }
    }
    return reg;
  }

  static parse(raw: string): Skill | null {
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    const codeMatch = raw.match(/```json\n([\s\S]*?)\n```/);
    if (!fmMatch || !codeMatch) return null;
    const fm = fmMatch[1] as string;

    const get = (key: string): string => {
      const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m?.[1]?.trim() ?? '';
    };
    const getList = (key: string): string[] => {
      const m = fm.match(new RegExp(`^${key}:\\n((?:\\s+-\\s+.+\\n?)+)`, 'm'));
      if (!m) return [];
      return (m[1] as string)
        .split('\n')
        .map((l) => l.replace(/^\s+-\s+/, '').trim())
        .filter(Boolean);
    };

    let body: { steps?: SkillStep[] };
    try {
      body = JSON.parse(codeMatch[1] as string);
    } catch { return null; }

    return {
      name: get('name'),
      description: get('description'),
      triggers: getList('triggers'),
      inputs: getList('inputs'),
      steps: body.steps ?? [],
    };
  }

  list(): Skill[] {
    return [...this.skills.values()];
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }
}
