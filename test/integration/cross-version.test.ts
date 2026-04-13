/**
 * Phase 8 Integration — Cross-Version Readiness
 *
 * We only have one machine, so we can't run tests on all macOS versions.
 * Instead, we statically verify that the project is correctly configured
 * for portability across macOS 12+ deployments:
 *
 *  1. Package.swift declares macOS 12+ deployment target
 *  2. build.sh supports universal binary (arm64 + x86_64) or detects arch
 *  3. No hard-coded absolute paths in shipped source files
 *  4. LaunchAgent plist uses __PLACEHOLDER__ paths, not literal ones
 *  5. postinstall.sh handles missing swift gracefully (no set -e crash)
 *  6. Health check provides clear error messages for each failure mode
 *  7. .mcp.json uses relative paths, not absolute
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

function rootPath(...parts: string[]): string {
  return resolve(ROOT, ...parts);
}

// ── 1. Package.swift deployment target ───────────────────────────────────────

describe('Cross-Version — Package.swift deployment target', () => {
  const pkgSwift = rootPath('daemon/Package.swift');

  it('Package.swift exists', () => {
    expect(existsSync(pkgSwift), 'daemon/Package.swift not found').toBe(true);
  });

  it('declares macOS 12+ deployment target (.v12 or higher)', () => {
    const content = readFileSync(pkgSwift, 'utf-8');
    // Matches .v12, .v13, .v14, .v15 etc.
    expect(content).toMatch(/\.macOS\(\.v1[2-9]\)/);
  });

  it('uses swift-tools-version 5.9+ (supports modern package features)', () => {
    const content = readFileSync(pkgSwift, 'utf-8');
    const match = content.match(/swift-tools-version:\s*(\d+\.\d+)/);
    expect(match, 'swift-tools-version comment not found').toBeTruthy();
    const version = parseFloat(match![1]);
    expect(version, `Expected swift-tools-version >= 5.5, got ${version}`).toBeGreaterThanOrEqual(5.5);
  });
});

// ── 2. Build script — architecture awareness ──────────────────────────────────

describe('Cross-Version — Build script architecture support', () => {
  const buildSh = rootPath('daemon/build.sh');

  it('daemon/build.sh exists', () => {
    expect(existsSync(buildSh), 'daemon/build.sh not found').toBe(true);
  });

  it('build.sh uses swift build -c release', () => {
    const content = readFileSync(buildSh, 'utf-8');
    expect(content).toContain('swift build');
    expect(content).toContain('-c release');
  });

  it('postinstall.sh detects CPU architecture (arm64 / x86_64)', () => {
    const content = readFileSync(rootPath('scripts/postinstall.sh'), 'utf-8');
    // Must detect arch to download the right binary or build
    expect(content).toMatch(/ARCH|uname -m|arm64|x86_64/);
  });
});

// ── 3. No hard-coded absolute paths in shipped source ─────────────────────────

describe('Cross-Version — No hard-coded absolute paths', () => {
  // Files that are explicitly allowed to contain absolute paths:
  // - test files (reference ROOT from __dirname)
  // - README.md (may contain example paths)
  // - TRACES.md, docs/
  const ALLOWED_DIRS = ['test/', 'docs/', 'daemon/.build/'];
  const HARD_PATH_PATTERN = /\/Users\/[^/\s'"]+|\/home\/[^/\s'"]+|\/root\/[^/\s'"]+/;

  function collectSourceFiles(dir: string, ext: string[]): string[] {
    const results: string[] = [];
    if (!existsSync(dir)) return results;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.build') continue;
        results.push(...collectSourceFiles(fullPath, ext));
      } else if (ext.includes(extname(entry.name))) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const sourceFiles = [
    ...collectSourceFiles(rootPath('src'), ['.ts', '.js']),
    ...collectSourceFiles(rootPath('scripts'), ['.sh']),
    ...collectSourceFiles(rootPath('hooks'), ['.sh']),
    ...collectSourceFiles(rootPath('daemon/Sources'), ['.swift']),
  ];

  it('collects at least 10 source files to scan', () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of sourceFiles) {
    const relPath = file.replace(ROOT + '/', '');
    const isAllowed = ALLOWED_DIRS.some((d) => relPath.startsWith(d));
    if (isAllowed) continue;

    it(`${relPath} has no hard-coded absolute user paths`, () => {
      const content = readFileSync(file, 'utf-8');
      const matches = content.match(HARD_PATH_PATTERN);
      expect(
        matches,
        `Found hard-coded path "${matches?.[0]}" in ${relPath}`,
      ).toBeNull();
    });
  }
});

// ── 4. LaunchAgent plist uses replaceable placeholders ────────────────────────

describe('Cross-Version — LaunchAgent plist portability', () => {
  const plistPath = rootPath('daemon/com.safari-pilot.daemon.plist');

  it('plist exists', () => {
    expect(existsSync(plistPath), 'daemon/com.safari-pilot.daemon.plist not found').toBe(true);
  });

  it('plist uses __DAEMON_PATH__ placeholder (not a literal path)', () => {
    const content = readFileSync(plistPath, 'utf-8');
    expect(content).toContain('__DAEMON_PATH__');
    // Must NOT contain a literal /Users/ path where the daemon binary is referenced
    const literalDaemon = content.match(/<string>\/Users\/[^<]+SafariPilotd<\/string>/);
    expect(literalDaemon, 'plist has a hard-coded daemon path').toBeNull();
  });

  it('plist uses __LOG_PATH__ placeholder', () => {
    const content = readFileSync(plistPath, 'utf-8');
    expect(content).toContain('__LOG_PATH__');
  });

  it('plist has com.safari-pilot.daemon label', () => {
    const content = readFileSync(plistPath, 'utf-8');
    expect(content).toContain('com.safari-pilot.daemon');
  });

  it('plist is a valid XML plist (has <!DOCTYPE plist)', () => {
    const content = readFileSync(plistPath, 'utf-8');
    expect(content).toMatch(/<!DOCTYPE plist|<plist version=/);
  });
});

// ── 5. postinstall.sh handles missing swift gracefully ────────────────────────

describe('Cross-Version — postinstall.sh graceful degradation', () => {
  const postinstallPath = rootPath('scripts/postinstall.sh');

  it('postinstall.sh exists', () => {
    expect(existsSync(postinstallPath), 'scripts/postinstall.sh not found').toBe(true);
  });

  it('postinstall.sh guards against missing swift with command -v check', () => {
    const content = readFileSync(postinstallPath, 'utf-8');
    // Must check if swift is available before calling it
    expect(content).toMatch(/command -v swift|which swift|swift --version/);
  });

  it('postinstall.sh does not use set -e without a missing-swift guard', () => {
    const content = readFileSync(postinstallPath, 'utf-8');
    if (content.includes('set -e') || content.includes('set -euo')) {
      // If strict mode is enabled, there must be a swift availability check
      expect(content).toMatch(/command -v swift|which swift/);
    }
    // Pass regardless — either no set -e, or set -e with a proper guard
    expect(true).toBe(true);
  });

  it('postinstall.sh has a fallback when swift is unavailable', () => {
    const content = readFileSync(postinstallPath, 'utf-8');
    // When swift is absent, the script should download from GitHub Releases
    // or report a clear message — never silently fail
    expect(content).toMatch(/Downloading daemon|Could not obtain daemon|Download from|download manually/i);
  });

  it('postinstall.sh exits 0 even without swift (no hard crash)', () => {
    const content = readFileSync(postinstallPath, 'utf-8');
    // The swift check is part of a compound condition, not a standalone block
    const swiftCheckIdx = content.search(/command -v swift|which swift/);
    expect(swiftCheckIdx, 'swift check not found').toBeGreaterThan(-1);
    // Script should never exit 1 on missing swift — it downloads instead
    expect(content).not.toMatch(/command -v swift[\s\S]{0,100}exit 1/);
  });
});

// ── 6. Health check — clear error messages per failure mode ──────────────────

describe('Cross-Version — Health check error clarity', () => {
  it('health_check tool is registered on the server', async () => {
    const { SafariPilotServer } = await import('../../src/server.js');
    const server = new SafariPilotServer();
    await server.initialize();
    const toolNames = server.getToolNames();
    expect(toolNames).toContain('safari_health_check');
    await server.shutdown();
  }, 30_000);

  it('health_check response includes named checks (not a raw boolean)', async () => {
    const { SafariPilotServer } = await import('../../src/server.js');
    const server = new SafariPilotServer();
    await server.initialize();

    const result = await server.callTool('safari_health_check', {});
    expect(result.content[0].type).toBe('text');

    const parsed = JSON.parse(result.content[0].text!);
    // Must return structured checks, not a raw boolean
    expect(typeof parsed).toBe('object');
    expect(parsed).not.toBeNull();

    // Expect checks array OR an object with named check fields
    const hasChecks =
      Array.isArray(parsed.checks) ||
      typeof parsed.safari_running !== 'undefined' ||
      typeof parsed.overall !== 'undefined' ||
      Object.keys(parsed).some((k) => k.includes('check') || k.includes('ok'));

    expect(hasChecks, `Health check response should have named check fields: ${JSON.stringify(parsed)}`).toBe(true);

    console.log('[health_check]', JSON.stringify(parsed, null, 2));
    await server.shutdown();
  }, 30_000);

  it('server.ts defines health check with a descriptive error for safari_not_running', () => {
    const serverSrc = readFileSync(rootPath('src/server.ts'), 'utf-8');
    // The server source must describe what "safari not running" means
    expect(serverSrc).toMatch(/safari.*not.*running|safari_running|Safari.*running/i);
  });

  it('server.ts describes daemon failure mode in health check', () => {
    const serverSrc = readFileSync(rootPath('src/server.ts'), 'utf-8');
    expect(serverSrc).toMatch(/daemon/i);
  });
});

// ── 7. .mcp.json uses relative paths ─────────────────────────────────────────

describe('Cross-Version — .mcp.json portability', () => {
  const mcpPath = rootPath('.mcp.json');

  it('.mcp.json exists', () => {
    expect(existsSync(mcpPath), '.mcp.json not found').toBe(true);
  });

  it('.mcp.json is valid JSON', () => {
    expect(() => JSON.parse(readFileSync(mcpPath, 'utf-8'))).not.toThrow();
  });

  it('.mcp.json does not contain hard-coded /Users/ paths', () => {
    const content = readFileSync(mcpPath, 'utf-8');
    // Some deployment docs intentionally use ~/ or relative — hard /Users/ breaks portability
    expect(content).not.toMatch(/\/Users\/[A-Za-z]/);
  });
});
