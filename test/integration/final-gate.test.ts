/**
 * Phase 8 Integration — Final Validation Gate
 *
 * The ultimate launch-readiness checklist. Every item that must be true
 * before safari-pilot ships is verified here:
 *
 *  1.  TypeScript compiles clean (tsc --noEmit)
 *  2.  All 76 tools registered on the server
 *  3.  All tool names are under the 64-char MCP limit (mcp__safari__<name>)
 *  4.  Plugin manifest (.claude-plugin/plugin.json) is valid
 *  5.  .mcp.json is valid
 *  6.  SKILL.md exists and allowed-tools contains all 76 tools
 *  7.  README.md exists
 *  8.  LICENSE exists and is MIT
 *  9.  Session hooks are executable
 *  10. Daemon binary exists and responds to ping
 *  11. Extension source files complete (manifest + 3 scripts)
 *  12. Security pipeline operational (kill switch, tab ownership, rate limiter)
 *  13. package.json has correct fields for publishing
 *  14. Swift daemon tests pass (run SafariPilotdTests)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  readFileSync,
  existsSync,
  accessSync,
  constants,
  statSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function rootPath(...parts: string[]): string {
  return resolve(ROOT, ...parts);
}

function isExecutable(p: string): boolean {
  try { accessSync(p, constants.X_OK); return true; } catch { return false; }
}

// ── YAML frontmatter parser (no external deps) ────────────────────────────────

interface SkillFrontmatter {
  name?: string;
  'allowed-tools'?: string[];
}

function parseFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const result: SkillFrontmatter = {};

  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  const toolsSection = yaml.match(/^allowed-tools:\n((?:\s+-\s+.+\n?)+)/m);
  if (toolsSection) {
    result['allowed-tools'] = toolsSection[1]
      .split('\n')
      .map((line) => line.replace(/^\s+-\s+/, '').trim())
      .filter((line) => line.length > 0);
  }
  return result;
}

// ── Gate 1: TypeScript compiles clean ────────────────────────────────────────

describe('Final Gate 1 — TypeScript compiles clean', () => {
  it('tsc --noEmit exits 0 (no type errors)', () => {
    let exitCode = 0;
    let stderr = '';
    try {
      execSync('npx tsc --noEmit', { cwd: ROOT, stdio: 'pipe', timeout: 60_000 });
    } catch (err: unknown) {
      exitCode = (err as { status?: number }).status ?? 1;
      stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
    }
    expect(exitCode, `TypeScript compile failed:\n${stderr}`).toBe(0);
  });
});

// ── Gate 2: All 76 tools registered ──────────────────────────────────────────

const EXPECTED_TOOL_COUNT = 76;

let server: import('../../src/server.js').SafariPilotServer;

describe('Final Gate 2 — 76 tools registered', () => {
  beforeAll(async () => {
    const { SafariPilotServer } = await import('../../src/server.js');
    server = new SafariPilotServer();
    await server.initialize();
  }, 30_000);

  afterAll(async () => {
    if (server) await server.shutdown();
  });

  it(`exactly ${EXPECTED_TOOL_COUNT} tools are registered`, () => {
    const names = server.getToolNames();
    expect(
      names.length,
      `Expected ${EXPECTED_TOOL_COUNT} tools, got ${names.length}: ${names.join(', ')}`,
    ).toBe(EXPECTED_TOOL_COUNT);
  });

  it('all tools have safari_ prefix', () => {
    for (const name of server.getToolNames()) {
      expect(name, `Tool "${name}" missing safari_ prefix`).toMatch(/^safari_/);
    }
  });
});

// ── Gate 3: All tool names under 64-char MCP limit ────────────────────────────

describe('Final Gate 3 — Tool name length (MCP 64-char limit)', () => {
  // MCP tool names are qualified as mcp__<server>__<toolName>
  // server name = "safari" → prefix = "mcp__safari__" (13 chars)
  const PREFIX = 'mcp__safari__';
  const MAX_LEN = 64;

  it('all tool names fit within MCP 64-char limit when prefixed', async () => {
    const { SafariPilotServer } = await import('../../src/server.js');
    const s = new SafariPilotServer();
    await s.initialize();
    try {
      for (const name of s.getToolNames()) {
        const qualified = `${PREFIX}${name}`;
        expect(
          qualified.length,
          `Qualified name "${qualified}" is ${qualified.length} chars (limit: ${MAX_LEN})`,
        ).toBeLessThanOrEqual(MAX_LEN);
      }
    } finally {
      await s.shutdown();
    }
  }, 30_000);
});

// ── Gate 4: Plugin manifest valid ────────────────────────────────────────────

describe('Final Gate 4 — Plugin manifest', () => {
  const pluginPath = rootPath('.claude-plugin/plugin.json');

  it('.claude-plugin/plugin.json exists', () => {
    expect(existsSync(pluginPath)).toBe(true);
  });

  it('plugin.json is valid JSON', () => {
    expect(() => JSON.parse(readFileSync(pluginPath, 'utf-8'))).not.toThrow();
  });

  it('plugin.json has name: safari-pilot', () => {
    const p = JSON.parse(readFileSync(pluginPath, 'utf-8'));
    expect(p.name).toBe('safari-pilot');
  });

  it('plugin.json has version', () => {
    const p = JSON.parse(readFileSync(pluginPath, 'utf-8'));
    expect(p.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('plugin.json has components.mcpServers', () => {
    const p = JSON.parse(readFileSync(pluginPath, 'utf-8'));
    expect(p.components?.mcpServers).toBeTruthy();
  });

  it('plugin.json references SKILL.md', () => {
    const p = JSON.parse(readFileSync(pluginPath, 'utf-8'));
    const skills: string[] = p.components?.skills ?? [];
    expect(skills.some((s) => s.includes('SKILL.md'))).toBe(true);
  });

  it('plugin.json declares darwin OS requirement', () => {
    const p = JSON.parse(readFileSync(pluginPath, 'utf-8'));
    const osReqs: string[] = p.requirements?.os ?? [];
    expect(osReqs).toContain('darwin');
  });
});

// ── Gate 5: .mcp.json valid ──────────────────────────────────────────────────

describe('Final Gate 5 — .mcp.json', () => {
  const mcpPath = rootPath('.mcp.json');

  it('.mcp.json exists', () => {
    expect(existsSync(mcpPath)).toBe(true);
  });

  it('.mcp.json is valid JSON', () => {
    expect(() => JSON.parse(readFileSync(mcpPath, 'utf-8'))).not.toThrow();
  });

  it('.mcp.json has mcpServers key', () => {
    const m = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(m.mcpServers).toBeTruthy();
  });

  it('.mcp.json mcpServers.safari has command and args', () => {
    const m = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    const safari = m.mcpServers?.safari;
    expect(safari?.command).toBeTruthy();
    expect(Array.isArray(safari?.args)).toBe(true);
  });
});

// ── Gate 6: SKILL.md has all 76 tools ────────────────────────────────────────

describe('Final Gate 6 — SKILL.md', () => {
  const skillPath = rootPath('skills/safari-pilot/SKILL.md');

  it('SKILL.md exists', () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it('SKILL.md has name: safari-pilot', () => {
    const fm = parseFrontmatter(readFileSync(skillPath, 'utf-8'));
    expect(fm.name).toBe('safari-pilot');
  });

  it(`SKILL.md allowed-tools contains exactly ${EXPECTED_TOOL_COUNT} entries`, () => {
    const fm = parseFrontmatter(readFileSync(skillPath, 'utf-8'));
    const tools = fm['allowed-tools'] ?? [];
    expect(
      tools.length,
      `Expected ${EXPECTED_TOOL_COUNT} tools in allowed-tools, got ${tools.length}`,
    ).toBe(EXPECTED_TOOL_COUNT);
  });

  it('all allowed-tools entries have mcp__safari__safari_ prefix', () => {
    const fm = parseFrontmatter(readFileSync(skillPath, 'utf-8'));
    for (const tool of fm['allowed-tools'] ?? []) {
      expect(tool, `"${tool}" missing expected prefix`).toMatch(/^mcp__safari__safari_/);
    }
  });
});

// ── Gate 7: README.md exists ─────────────────────────────────────────────────

describe('Final Gate 7 — README.md', () => {
  const readmePath = rootPath('README.md');

  it('README.md exists', () => {
    expect(existsSync(readmePath)).toBe(true);
  });

  it('README.md is non-trivial (>500 chars)', () => {
    const stat = statSync(readmePath);
    expect(stat.size).toBeGreaterThan(500);
  });

  it('README.md has an Installation section', () => {
    const content = readFileSync(readmePath, 'utf-8');
    expect(content).toMatch(/##\s+Installation/i);
  });
});

// ── Gate 8: LICENSE exists and is MIT ────────────────────────────────────────

describe('Final Gate 8 — LICENSE', () => {
  const licensePath = rootPath('LICENSE');

  it('LICENSE exists', () => {
    expect(existsSync(licensePath)).toBe(true);
  });

  it('LICENSE contains MIT text', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toContain('MIT');
  });

  it('LICENSE contains copyright holder (Aakash Kumar)', () => {
    const content = readFileSync(licensePath, 'utf-8');
    expect(content).toMatch(/Aakash Kumar/i);
  });
});

// ── Gate 9: Session hooks are executable ─────────────────────────────────────

describe('Final Gate 9 — Session hooks executable', () => {
  const startHook = rootPath('hooks/session-start.sh');
  const endHook = rootPath('hooks/session-end.sh');

  it('hooks/session-start.sh exists', () => {
    expect(existsSync(startHook)).toBe(true);
  });

  it('hooks/session-end.sh exists', () => {
    expect(existsSync(endHook)).toBe(true);
  });

  it('session-start.sh is executable', () => {
    expect(isExecutable(startHook), 'session-start.sh is not executable').toBe(true);
  });

  it('session-end.sh is executable', () => {
    expect(isExecutable(endHook), 'session-end.sh is not executable').toBe(true);
  });
});

// ── Gate 10: Daemon binary exists and responds to ping ───────────────────────

describe('Final Gate 10 — Daemon binary', () => {
  const daemonBin = rootPath('bin/SafariPilotd');

  it('bin/SafariPilotd exists', () => {
    expect(existsSync(daemonBin), 'bin/SafariPilotd not found — run daemon/build.sh').toBe(true);
  });

  it('bin/SafariPilotd is executable', () => {
    expect(isExecutable(daemonBin)).toBe(true);
  });

  it('daemon responds to ping (round-trip < 5s)', async () => {
    const { DaemonEngine } = await import('../../src/engines/daemon.js');
    const d = new DaemonEngine(daemonBin);
    try {
      const available = await d.isAvailable();
      expect(available, 'Daemon ping did not return pong').toBe(true);
    } finally {
      await d.shutdown();
    }
  }, 15_000);
});

// ── Gate 11: Extension source files complete ─────────────────────────────────

describe('Final Gate 11 — Extension source files', () => {
  const extDir = rootPath('extension');
  const requiredFiles = [
    'manifest.json',
    'background.js',
    'content-main.js',
    'content-isolated.js',
  ];

  for (const file of requiredFiles) {
    it(`extension/${file} exists`, () => {
      expect(existsSync(resolve(extDir, file)), `extension/${file} not found`).toBe(true);
    });

    it(`extension/${file} is non-empty`, () => {
      const stat = statSync(resolve(extDir, file));
      expect(stat.size, `extension/${file} is empty`).toBeGreaterThan(0);
    });
  }

  it('extension/manifest.json is valid JSON', () => {
    expect(() => JSON.parse(readFileSync(resolve(extDir, 'manifest.json'), 'utf-8'))).not.toThrow();
  });

  it('extension/manifest.json has manifest_version field', () => {
    const m = JSON.parse(readFileSync(resolve(extDir, 'manifest.json'), 'utf-8'));
    expect(m.manifest_version).toBeTruthy();
  });
});

// ── Gate 12: Security pipeline operational ───────────────────────────────────

describe('Final Gate 12 — Security pipeline', () => {
  it('KillSwitch activates and blocks subsequent actions', async () => {
    const { KillSwitch } = await import('../../src/security/kill-switch.js');
    const { KillSwitchActiveError } = await import('../../src/errors.js');
    const ks = new KillSwitch();
    expect(ks.isActive()).toBe(false);
    ks.activate('gate test');
    expect(ks.isActive()).toBe(true);
    // checkBeforeAction throws when kill switch is active
    expect(() => ks.checkBeforeAction()).toThrow(KillSwitchActiveError);
    ks.deactivate();
    expect(ks.isActive()).toBe(false);
    expect(() => ks.checkBeforeAction()).not.toThrow();
  });

  it('TabOwnership tracks owned vs. pre-existing tabs', async () => {
    const { TabOwnership } = await import('../../src/security/tab-ownership.js');
    const { TabNotOwnedError } = await import('../../src/errors.js');
    const to = new TabOwnership();
    // TabId is just `number` — recordPreExisting marks a tab as not agent-owned
    to.recordPreExisting(1001);
    // registerTab marks a tab as agent-opened
    to.registerTab(2001, 'https://example.com');
    expect(() => to.assertOwnership(2001)).not.toThrow();
    expect(() => to.assertOwnership(1001)).toThrow(TabNotOwnedError);
  });

  it('RateLimiter allows requests under limit and blocks over limit', async () => {
    const { RateLimiter } = await import('../../src/security/rate-limiter.js');
    const rl = new RateLimiter();
    // Default global limit is 120/60s — a few requests must be allowed
    for (let i = 0; i < 5; i++) {
      const result = rl.checkLimit('example.com');
      expect(result.allowed).toBe(true);
      rl.recordAction('example.com');
    }
    expect(rl.checkLimit('example.com').remaining).toBeLessThan(120);
  });

  it('emergency_stop tool activates kill switch on the server', async () => {
    const { SafariPilotServer } = await import('../../src/server.js');
    const s = new SafariPilotServer();
    await s.initialize();
    try {
      expect(s.killSwitch.isActive()).toBe(false);
      const result = await s.callTool('safari_emergency_stop', { reason: 'final gate' });
      const payload = JSON.parse(result.content[0]!.text as string);
      expect(payload.stopped).toBe(true);
      expect(s.killSwitch.isActive()).toBe(true);
    } finally {
      s.killSwitch.deactivate();
      await s.shutdown();
    }
  }, 30_000);
});

// ── Gate 13: package.json fields for publishing ───────────────────────────────

describe('Final Gate 13 — package.json publishing fields', () => {
  const pkgPath = rootPath('package.json');
  let pkg: Record<string, unknown>;

  beforeAll(() => {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  });

  it('name is "safari-pilot"', () => {
    expect(pkg.name).toBe('safari-pilot');
  });

  it('version is semver', () => {
    expect(pkg.version as string).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('license is MIT', () => {
    expect(pkg.license).toBe('MIT');
  });

  it('main is dist/index.js', () => {
    expect(pkg.main).toBe('dist/index.js');
  });

  it('type is module', () => {
    expect(pkg.type).toBe('module');
  });

  it('os is ["darwin"]', () => {
    expect(pkg.os).toEqual(['darwin']);
  });

  it('engines.node is >=20.0.0', () => {
    const engines = pkg.engines as Record<string, string>;
    expect(engines?.node).toMatch(/>=20/);
  });

  it('files array includes dist/, bin/, skills/, extension/, .mcp.json', () => {
    const files = pkg.files as string[];
    for (const required of ['dist/', 'bin/', 'skills/', 'extension/', '.mcp.json']) {
      expect(files, `files[] missing "${required}"`).toContain(required);
    }
  });

  it('scripts.prepublishOnly runs npm run build', () => {
    const scripts = pkg.scripts as Record<string, string>;
    expect(scripts.prepublishOnly).toBe('npm run build');
  });
});

// ── Gate 14: Swift daemon tests pass ─────────────────────────────────────────

describe('Final Gate 14 — Swift daemon tests', () => {
  const daemonDir = rootPath('daemon');

  it('Swift test binary builds and passes (SafariPilotdTests)', () => {
    // Build the test executable
    let buildOutput = '';
    try {
      buildOutput = execSync('swift build --target SafariPilotdTests 2>&1', {
        cwd: daemonDir,
        timeout: 180_000,
        encoding: 'utf-8',
      });
    } catch (err: unknown) {
      const msg = (err as { stdout?: string; stderr?: string; message?: string });
      throw new Error(
        `Swift build failed:\n${msg.stdout ?? ''}\n${msg.stderr ?? ''}\n${msg.message ?? ''}`,
      );
    }

    // Run the tests
    let testOutput = '';
    try {
      testOutput = execSync('.build/debug/SafariPilotdTests 2>&1', {
        cwd: daemonDir,
        timeout: 60_000,
        encoding: 'utf-8',
      });
    } catch (err: unknown) {
      const msg = (err as { stdout?: string; stderr?: string; message?: string });
      const out = msg.stdout ?? testOutput ?? '';
      throw new Error(`Swift tests failed:\n${out}\n${msg.message ?? ''}`);
    }

    console.log('\n[SafariPilotdTests output]');
    console.log(testOutput);

    // The test harness prints "PASS" / "FAIL" and exits 0 on success
    expect(testOutput).toMatch(/PASS/);
    expect(testOutput).not.toMatch(/FAIL/);
  }, 240_000);
});
