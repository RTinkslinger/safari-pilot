import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

describe('Project Scaffold', () => {
  it('has package.json with correct name and version', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('safari-pilot');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('has plugin manifest with correct MCP server config', () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, '.claude-plugin/plugin.json'), 'utf-8'));
    expect(manifest.name).toBe('safari-pilot');
    expect(manifest.components.mcpServers.safari).toBeDefined();
    expect(manifest.components.mcpServers.safari.command).toBe('node');
    expect(manifest.requirements.os).toContain('darwin');
  });

  it('has MCP configuration', () => {
    const mcp = JSON.parse(readFileSync(resolve(ROOT, '.mcp.json'), 'utf-8'));
    expect(mcp.mcpServers.safari).toBeDefined();
    expect(mcp.mcpServers.safari.command).toBe('node');
  });

  it('has TypeScript configuration with strict mode', () => {
    const tsconfig = JSON.parse(readFileSync(resolve(ROOT, 'tsconfig.json'), 'utf-8'));
    expect(tsconfig.compilerOptions.outDir).toBe('./dist');
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.module).toBe('Node16');
  });

  it('has main entry point', () => {
    expect(existsSync(resolve(ROOT, 'src/index.ts'))).toBe(true);
  });

  it('has shared types file with Engine type', () => {
    const typesContent = readFileSync(resolve(ROOT, 'src/types.ts'), 'utf-8');
    expect(typesContent).toContain("export type Engine = 'extension' | 'daemon' | 'applescript'");
    expect(typesContent).toContain('export interface ToolError');
    expect(typesContent).toContain('export interface TabInfo');
  });

  it('has directory structure for all components', () => {
    const dirs = [
      'src/engines', 'src/security', 'src/tools',
      'daemon/Sources/SafariPilotd',
      'extension',
      'skills/safari-pilot',
      'hooks', 'scripts', 'bin',
      'test/unit', 'test/integration', 'test/e2e', 'test/security', 'test/fixtures'
    ];
    for (const dir of dirs) {
      expect(existsSync(resolve(ROOT, dir))).toBe(true);
    }
  });

  it('MCP server name stays under 64-char tool name limit', () => {
    const manifest = JSON.parse(readFileSync(resolve(ROOT, '.claude-plugin/plugin.json'), 'utf-8'));
    const serverNames = Object.keys(manifest.components.mcpServers);
    for (const name of serverNames) {
      // mcp__<server>__<longest_tool> must be < 64 chars
      // Longest tool: safari_list_network_requests (28 chars)
      const longestToolName = `mcp__${name}__safari_list_network_requests`;
      expect(longestToolName.length).toBeLessThan(64);
    }
  });
});
