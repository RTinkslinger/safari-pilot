import { describe, it, expect } from 'vitest';
import { SkillRegistry } from '../../../src/skills/registry.js';

describe('SkillRegistry', () => {
  it('loads SKILL.md files from skills/ dir', async () => {
    const reg = await SkillRegistry.fromDir('skills');
    expect(reg.list().length).toBeGreaterThanOrEqual(3);
    const names = reg.list().map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['login', 'paginate-and-scrape', 'robust-form-fill']));
  });

  it('parses YAML frontmatter for description and inputs', async () => {
    const reg = await SkillRegistry.fromDir('skills');
    const login = reg.get('login');
    expect(login).toBeTruthy();
    expect(login!.description).toMatch(/log/i);
    expect(login!.inputs).toEqual(expect.arrayContaining(['url', 'username', 'password']));
  });

  it('returns the procedure body as a parseable steps array', async () => {
    const reg = await SkillRegistry.fromDir('skills');
    const login = reg.get('login');
    expect(login!.steps).toBeInstanceOf(Array);
    expect(login!.steps.length).toBeGreaterThan(0);
    expect(login!.steps[0]).toHaveProperty('tool');
  });

  it('returns empty registry when skills dir missing', async () => {
    const reg = await SkillRegistry.fromDir('nonexistent-dir-xyz');
    expect(reg.list().length).toBe(0);
  });
});
