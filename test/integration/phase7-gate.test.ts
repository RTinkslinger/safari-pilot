/**
 * Phase 7 Integration Gate — Distribution Pipeline
 *
 * Verifies that:
 *  1. package.json has correct name, version, main, and files array
 *  2. postinstall.sh exists and is executable
 *  3. update-daemon.sh exists and is executable
 *  4. .claude-plugin/plugin.json exists and is valid JSON
 *  5. .mcp.json exists and is valid JSON
 *  6. LaunchAgent plist template exists (daemon/com.safari-pilot.daemon.plist)
 *  7. Build script (tsc) produces dist/ directory with index.js
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, statSync, accessSync, constants, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(__filename, '../../..');

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ── Gate 1: package.json correctness ─────────────────────────────────────────

describe('Phase 7 Gate — package.json', () => {
  const pkgPath = resolve(ROOT, 'package.json');
  let pkg: Record<string, unknown>;

  it('package.json exists and parses as JSON', () => {
    expect(existsSync(pkgPath), 'package.json not found').toBe(true);
    const raw = readFileSync(pkgPath, 'utf-8');
    pkg = JSON.parse(raw);
    expect(pkg).toBeTruthy();
  });

  it('name is "safari-pilot"', () => {
    const raw = readFileSync(pkgPath, 'utf-8');
    const p = JSON.parse(raw) as Record<string, unknown>;
    expect(p.name).toBe('safari-pilot');
  });

  it('version is present and semver-shaped', () => {
    const raw = readFileSync(pkgPath, 'utf-8');
    const p = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof p.version).toBe('string');
    expect(p.version as string).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('main is "dist/index.js"', () => {
    const raw = readFileSync(pkgPath, 'utf-8');
    const p = JSON.parse(raw) as Record<string, unknown>;
    expect(p.main).toBe('dist/index.js');
  });

  it('type is "module" (ES modules)', () => {
    const raw = readFileSync(pkgPath, 'utf-8');
    const p = JSON.parse(raw) as Record<string, unknown>;
    expect(p.type).toBe('module');
  });

  it('files array contains required distribution paths', () => {
    const raw = readFileSync(pkgPath, 'utf-8');
    const p = JSON.parse(raw) as Record<string, unknown>;
    const files = p.files as string[];
    expect(Array.isArray(files), 'files must be an array').toBe(true);
    const required = ['dist/', 'bin/', 'skills/', 'hooks/', 'extension/', '.claude-plugin/', '.mcp.json', 'README.md', 'LICENSE'];
    for (const entry of required) {
      expect(files, `files array missing "${entry}"`).toContain(entry);
    }
  });

  it('scripts.postinstall is set', () => {
    const raw = readFileSync(pkgPath, 'utf-8');
    const p = JSON.parse(raw) as Record<string, unknown>;
    const scripts = p.scripts as Record<string, string>;
    expect(scripts.postinstall, 'scripts.postinstall must be set').toBeTruthy();
  });

  it('scripts.prepublishOnly runs the build', () => {
    const raw = readFileSync(pkgPath, 'utf-8');
    const p = JSON.parse(raw) as Record<string, unknown>;
    const scripts = p.scripts as Record<string, string>;
    expect(scripts.prepublishOnly).toBe('npm run build');
  });
});

// ── Gate 2: postinstall.sh ────────────────────────────────────────────────────

describe('Phase 7 Gate — postinstall.sh', () => {
  const postinstallPath = resolve(ROOT, 'scripts/postinstall.sh');

  it('postinstall.sh exists', () => {
    expect(existsSync(postinstallPath), 'scripts/postinstall.sh not found').toBe(true);
  });

  it('postinstall.sh is executable', () => {
    expect(isExecutable(postinstallPath), 'scripts/postinstall.sh is not executable').toBe(true);
  });

  it('postinstall.sh has a shebang line', () => {
    const content = readFileSync(postinstallPath, 'utf-8');
    expect(content.startsWith('#!/bin/bash'), 'postinstall.sh must start with #!/bin/bash').toBe(true);
  });

  it('postinstall.sh guards macOS-only execution', () => {
    const content = readFileSync(postinstallPath, 'utf-8');
    expect(content).toContain('Darwin');
  });
});

// ── Gate 3: update-daemon.sh ──────────────────────────────────────────────────

describe('Phase 7 Gate — update-daemon.sh', () => {
  const updatePath = resolve(ROOT, 'scripts/update-daemon.sh');

  it('update-daemon.sh exists', () => {
    expect(existsSync(updatePath), 'scripts/update-daemon.sh not found').toBe(true);
  });

  it('update-daemon.sh is executable', () => {
    expect(isExecutable(updatePath), 'scripts/update-daemon.sh is not executable').toBe(true);
  });

  it('update-daemon.sh has a shebang line', () => {
    const content = readFileSync(updatePath, 'utf-8');
    expect(content.startsWith('#!/bin/bash'), 'update-daemon.sh must start with #!/bin/bash').toBe(true);
  });

  it('update-daemon.sh performs an atomic swap (mv)', () => {
    const content = readFileSync(updatePath, 'utf-8');
    expect(content).toContain('mv ');
  });

  it('update-daemon.sh uses launchctl to restart the daemon', () => {
    const content = readFileSync(updatePath, 'utf-8');
    expect(content).toContain('launchctl');
  });
});

// ── Gate 4: .claude-plugin/plugin.json ───────────────────────────────────────

describe('Phase 7 Gate — .claude-plugin/plugin.json', () => {
  const pluginPath = resolve(ROOT, '.claude-plugin/plugin.json');

  it('plugin.json exists', () => {
    expect(existsSync(pluginPath), '.claude-plugin/plugin.json not found').toBe(true);
  });

  it('plugin.json is valid JSON', () => {
    const raw = readFileSync(pluginPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('plugin.json has name and version', () => {
    const p = JSON.parse(readFileSync(pluginPath, 'utf-8')) as Record<string, unknown>;
    expect(p.name).toBeTruthy();
    expect(p.version).toBeTruthy();
  });

  it('plugin.json has components.mcpServers', () => {
    const p = JSON.parse(readFileSync(pluginPath, 'utf-8')) as Record<string, unknown>;
    const components = p.components as Record<string, unknown>;
    expect(components?.mcpServers).toBeTruthy();
  });
});

// ── Gate 5: .mcp.json ─────────────────────────────────────────────────────────

describe('Phase 7 Gate — .mcp.json', () => {
  const mcpPath = resolve(ROOT, '.mcp.json');

  it('.mcp.json exists', () => {
    expect(existsSync(mcpPath), '.mcp.json not found').toBe(true);
  });

  it('.mcp.json is valid JSON', () => {
    const raw = readFileSync(mcpPath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('.mcp.json has mcpServers key', () => {
    const m = JSON.parse(readFileSync(mcpPath, 'utf-8')) as Record<string, unknown>;
    expect(m.mcpServers).toBeTruthy();
  });
});

// ── Gate 6: LaunchAgent plist template ───────────────────────────────────────

describe('Phase 7 Gate — LaunchAgent plist template', () => {
  const plistPath = resolve(ROOT, 'daemon/com.safari-pilot.daemon.plist');

  it('plist template exists', () => {
    expect(existsSync(plistPath), 'daemon/com.safari-pilot.daemon.plist not found').toBe(true);
  });

  it('plist contains __DAEMON_PATH__ placeholder', () => {
    const content = readFileSync(plistPath, 'utf-8');
    expect(content).toContain('__DAEMON_PATH__');
  });

  it('plist contains __LOG_PATH__ placeholder', () => {
    const content = readFileSync(plistPath, 'utf-8');
    expect(content).toContain('__LOG_PATH__');
  });

  it('plist has com.safari-pilot.daemon label', () => {
    const content = readFileSync(plistPath, 'utf-8');
    expect(content).toContain('com.safari-pilot.daemon');
  });
});

// ── Gate 7: dist/ directory from tsc build ───────────────────────────────────

describe('Phase 7 Gate — dist/ build output', () => {
  const distPath = resolve(ROOT, 'dist');
  const distIndex = resolve(ROOT, 'dist/index.js');

  it('dist/ directory exists', () => {
    expect(existsSync(distPath), 'dist/ directory not found — run npm run build').toBe(true);
    const stat = statSync(distPath);
    expect(stat.isDirectory()).toBe(true);
  });

  it('dist/index.js exists', () => {
    expect(existsSync(distIndex), 'dist/index.js not found — build may have failed').toBe(true);
  });

  it('dist/index.js is non-empty', () => {
    const stat = statSync(distIndex);
    expect(stat.size, 'dist/index.js is empty').toBeGreaterThan(0);
  });

  it('dist/server.js exists (server module compiled)', () => {
    expect(existsSync(resolve(ROOT, 'dist/server.js'))).toBe(true);
  });
});
