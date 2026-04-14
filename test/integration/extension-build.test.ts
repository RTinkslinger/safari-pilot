import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');
const EXT_DIR = join(ROOT, 'extension');
const APP_PATH = join(ROOT, 'bin', 'Safari Pilot.app');
const APPEX_PATH = join(APP_PATH, 'Contents/PlugIns/Safari Pilot Extension.appex');

describe('Extension Build Artifacts', () => {
  it('extension source files exist', () => {
    expect(existsSync(join(EXT_DIR, 'manifest.json'))).toBe(true);
    expect(existsSync(join(EXT_DIR, 'background.js'))).toBe(true);
    expect(existsSync(join(EXT_DIR, 'content-main.js'))).toBe(true);
    expect(existsSync(join(EXT_DIR, 'content-isolated.js'))).toBe(true);
  });

  it('custom TCP handler source exists', () => {
    const handlerPath = join(EXT_DIR, 'native', 'SafariWebExtensionHandler.swift');
    expect(existsSync(handlerPath)).toBe(true);
    const source = readFileSync(handlerPath, 'utf8');
    expect(source).toContain('NWConnection');
    expect(source).toContain('forwardToDaemon');
    expect(source).not.toContain('echo');
  });

  it('manifest declares required permissions', () => {
    const manifest = JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8'));
    expect(manifest.permissions).toContain('nativeMessaging');
    expect(manifest.permissions).toContain('scripting');
    expect(manifest.host_permissions).toContain('<all_urls>');
  });

  it('manifest declares content scripts', () => {
    const manifest = JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8'));
    expect(manifest.content_scripts).toBeDefined();
    expect(manifest.content_scripts.length).toBeGreaterThanOrEqual(2);
    const worlds = manifest.content_scripts.map((cs: { world?: string }) => cs.world ?? 'ISOLATED');
    expect(worlds).toContain('MAIN');
  });

  it('built .app exists in bin/', () => {
    expect(existsSync(APP_PATH)).toBe(true);
  });

  it('extension .appex exists within .app', () => {
    expect(existsSync(APPEX_PATH)).toBe(true);
  });

  it('.app is code-signed', () => {
    const result = execSync(`codesign --verify --deep --strict "${APP_PATH}" 2>&1`, { encoding: 'utf8' });
    expect(result).not.toContain('invalid');
  });

  it('extension .appex has app-sandbox entitlement', () => {
    const result = execSync(
      `codesign -d --entitlements - "${APPEX_PATH}" 2>&1`,
      { encoding: 'utf8' },
    );
    expect(result).toContain('com.apple.security.app-sandbox');
  });

  it('extension .appex has network.client entitlement', () => {
    const result = execSync(
      `codesign -d --entitlements - "${APPEX_PATH}" 2>&1`,
      { encoding: 'utf8' },
    );
    expect(result).toContain('com.apple.security.network.client');
  });

  it('build script preserves custom handler (not stub)', () => {
    const appexBinary = join(APPEX_PATH, 'Contents/MacOS/Safari Pilot Extension');
    expect(existsSync(appexBinary)).toBe(true);
    const strings = execSync(`strings "${appexBinary}" 2>/dev/null`, { encoding: 'utf8' });
    expect(strings).toContain('daemon connection timed out');
    expect(strings).not.toContain('"echo"');
  });
});
