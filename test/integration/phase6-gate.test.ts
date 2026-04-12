/**
 * Phase 6 Integration Gate
 *
 * Verifies that:
 *  1. SKILL.md exists and has valid YAML frontmatter
 *  2. SKILL.md has name: safari-pilot
 *  3. SKILL.md has allowed-tools list with all 74 tools
 *  4. README.md exists with Installation section
 *  5. LICENSE exists with MIT
 *  6. Session hooks are executable
 *  7. plugin.json is valid and references hooks + skills
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, statSync, accessSync, constants } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Path resolution ───────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function rootPath(...parts: string[]): string {
  return resolve(ROOT, ...parts);
}

// ── YAML frontmatter parser (minimal — no external deps) ──────────────────────

interface SkillFrontmatter {
  name?: string;
  description?: string;
  'allowed-tools'?: string[];
}

function parseFrontmatter(content: string): SkillFrontmatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const yaml = match[1];
  const result: SkillFrontmatter = {};

  // Parse name
  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  // Parse description (multi-line with > or single line)
  const descMatch = yaml.match(/^description:\s*[>|]?\s*\n?([\s\S]*?)(?=\n\w|\n---)/m);
  if (descMatch) result.description = descMatch[1].trim();

  // Parse allowed-tools list
  const toolsSection = yaml.match(/^allowed-tools:\n((?:\s+-\s+.+\n?)+)/m);
  if (toolsSection) {
    result['allowed-tools'] = toolsSection[1]
      .split('\n')
      .map((line) => line.replace(/^\s+-\s+/, '').trim())
      .filter((line) => line.length > 0);
  }

  return result;
}

// ── Gate 1 & 2: SKILL.md exists and has valid frontmatter ────────────────────

describe('Phase 6 Gate — SKILL.md', () => {
  const skillPath = rootPath('skills/safari-pilot/SKILL.md');

  it('SKILL.md exists', () => {
    expect(() => statSync(skillPath)).not.toThrow();
  });

  it('SKILL.md has valid YAML frontmatter', () => {
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toMatch(/\n---/);
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
  });

  it('SKILL.md frontmatter has name: safari-pilot', () => {
    const content = readFileSync(skillPath, 'utf-8');
    const fm = parseFrontmatter(content);
    expect(fm?.name).toBe('safari-pilot');
  });

  it('SKILL.md frontmatter has description', () => {
    const content = readFileSync(skillPath, 'utf-8');
    const fm = parseFrontmatter(content);
    expect(fm?.description).toBeTruthy();
  });

  it('SKILL.md has allowed-tools list', () => {
    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toContain('allowed-tools:');
    const fm = parseFrontmatter(content);
    const tools = fm?.['allowed-tools'] ?? [];
    expect(tools.length, `Expected tools in allowed-tools list, got ${tools.length}`).toBeGreaterThan(0);
  });

  it('allowed-tools list contains all 74 tool names', () => {
    const content = readFileSync(skillPath, 'utf-8');
    const fm = parseFrontmatter(content);
    const tools = fm?.['allowed-tools'] ?? [];
    expect(
      tools.length,
      `Expected 74 tools in allowed-tools, got ${tools.length}: ${tools.join(', ')}`,
    ).toBe(74);
  });

  it('all allowed-tools entries have mcp__safari__ prefix', () => {
    const content = readFileSync(skillPath, 'utf-8');
    const fm = parseFrontmatter(content);
    const tools = fm?.['allowed-tools'] ?? [];
    for (const tool of tools) {
      expect(
        tool,
        `Tool "${tool}" must start with mcp__safari__`,
      ).toMatch(/^mcp__safari__safari_/);
    }
  });

  it('SKILL.md body has content sections', () => {
    const content = readFileSync(skillPath, 'utf-8');
    // Must have body content after the closing ---
    const bodyStart = content.indexOf('---', content.indexOf('---') + 3) + 3;
    const body = content.slice(bodyStart).trim();
    expect(body.length, 'SKILL.md body should have content').toBeGreaterThan(100);
  });
});

// ── Gate 3: README.md ─────────────────────────────────────────────────────────

describe('Phase 6 Gate — README.md', () => {
  const readmePath = rootPath('README.md');

  it('README.md exists', () => {
    expect(() => statSync(readmePath)).not.toThrow();
  });

  it('README.md has Installation section', () => {
    const content = readFileSync(readmePath, 'utf-8');
    expect(content).toMatch(/##\s+Installation/i);
  });

  it('README.md has plugin install command', () => {
    const content = readFileSync(readmePath, 'utf-8');
    expect(content).toContain('claude plugin add --from npm safari-pilot');
  });

  it('README.md has Setup section', () => {
    const content = readFileSync(readmePath, 'utf-8');
    expect(content).toMatch(/##\s+Setup/i);
  });

  it('README.md has macOS version requirement', () => {
    const content = readFileSync(readmePath, 'utf-8');
    expect(content).toMatch(/macOS\s+1[2-9]/);
  });
});

// ── Gate 4: LICENSE ───────────────────────────────────────────────────────────

describe('Phase 6 Gate — LICENSE', () => {
  const licensePath = rootPath('LICENSE');

  it('LICENSE exists', () => {
    expect(() => statSync(licensePath)).not.toThrow();
  });

  it('LICENSE contains MIT', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('MIT');
  });

  it('LICENSE contains copyright holder', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toMatch(/Copyright.+Aakash Kumar/i);
  });

  it('LICENSE contains 2026 copyright year', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('2026');
  });
});

// ── Gate 5: Session hooks are executable ─────────────────────────────────────

describe('Phase 6 Gate — Session hooks', () => {
  const sessionStartPath = rootPath('hooks/session-start.sh');
  const sessionEndPath = rootPath('hooks/session-end.sh');

  it('hooks/session-start.sh exists', () => {
    expect(() => statSync(sessionStartPath)).not.toThrow();
  });

  it('hooks/session-end.sh exists', () => {
    expect(() => statSync(sessionEndPath)).not.toThrow();
  });

  it('session-start.sh is executable', () => {
    expect(() => accessSync(sessionStartPath, constants.X_OK)).not.toThrow();
  });

  it('session-end.sh is executable', () => {
    expect(() => accessSync(sessionEndPath, constants.X_OK)).not.toThrow();
  });

  it('session-start.sh has OS gate for macOS', () => {
    const content = readFileSync(sessionStartPath, 'utf-8');
    expect(content).toContain('Darwin');
  });

  it('session-start.sh checks macOS version', () => {
    const content = readFileSync(sessionStartPath, 'utf-8');
    expect(content).toMatch(/sw_vers|OS_VERSION|OS_MAJOR/);
  });

  it('session-end.sh has audit log handling', () => {
    const content = readFileSync(sessionEndPath, 'utf-8');
    expect(content).toMatch(/audit/i);
  });
});

// ── Gate 6: plugin.json is valid ──────────────────────────────────────────────

describe('Phase 6 Gate — plugin.json', () => {
  const pluginPath = rootPath('.claude-plugin/plugin.json');

  it('plugin.json exists', () => {
    expect(() => statSync(pluginPath)).not.toThrow();
  });

  it('plugin.json is valid JSON', () => {
    const content = readFileSync(pluginPath, 'utf-8');
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it('plugin.json has name: safari-pilot', () => {
    const content = readFileSync(pluginPath, 'utf-8');
    const json = JSON.parse(content);
    expect(json.name).toBe('safari-pilot');
  });

  it('plugin.json references SKILL.md in components.skills', () => {
    const content = readFileSync(pluginPath, 'utf-8');
    const json = JSON.parse(content);
    const skills: string[] = json.components?.skills ?? [];
    expect(skills.some((s) => s.includes('SKILL.md'))).toBe(true);
  });

  it('plugin.json references session-start hook', () => {
    const content = readFileSync(pluginPath, 'utf-8');
    const json = JSON.parse(content);
    const hooks: Array<{ event: string; script: string }> = json.components?.hooks ?? [];
    expect(hooks.some((h) => h.script.includes('session-start'))).toBe(true);
  });

  it('plugin.json references session-end hook', () => {
    const content = readFileSync(pluginPath, 'utf-8');
    const json = JSON.parse(content);
    const hooks: Array<{ event: string; script: string }> = json.components?.hooks ?? [];
    expect(hooks.some((h) => h.script.includes('session-end'))).toBe(true);
  });

  it('plugin.json has darwin OS requirement', () => {
    const content = readFileSync(pluginPath, 'utf-8');
    const json = JSON.parse(content);
    const osReqs: string[] = json.requirements?.os ?? [];
    expect(osReqs).toContain('darwin');
  });
});
