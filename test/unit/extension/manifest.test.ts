import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const manifest = JSON.parse(
  readFileSync(resolve(ROOT, 'extension/manifest.json'), 'utf-8')
);

describe('Extension Manifest', () => {
  it('has manifest_version 3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('has required permissions', () => {
    const required = [
      'activeTab',
      'scripting',
      'cookies',
      'nativeMessaging',
      'declarativeNetRequest',
      'alarms',
    ];
    for (const perm of required) {
      expect(manifest.permissions).toContain(perm);
    }
  });

  it('has host_permissions with <all_urls>', () => {
    expect(manifest.host_permissions).toContain('<all_urls>');
  });

  it('has background as event page (scripts + persistent:false)', () => {
    expect(manifest.background).toBeDefined();
    expect(manifest.background).toEqual({
      scripts: ['background.js'],
      persistent: false,
    });
    expect(manifest.background.service_worker).toBeUndefined();
    expect(manifest.background.type).toBeUndefined();
  });

  it('has exactly two content_scripts', () => {
    expect(Array.isArray(manifest.content_scripts)).toBe(true);
    expect(manifest.content_scripts).toHaveLength(2);
  });

  it('has a MAIN world content script pointing to content-main.js', () => {
    const mainScript = manifest.content_scripts.find(
      (cs: { world?: string }) => cs.world === 'MAIN'
    );
    expect(mainScript).toBeDefined();
    expect(mainScript.js).toContain('content-main.js');
  });

  it('has an ISOLATED world content script pointing to content-isolated.js', () => {
    const isolatedScript = manifest.content_scripts.find(
      (cs: { world?: string }) => cs.world === 'ISOLATED'
    );
    expect(isolatedScript).toBeDefined();
    expect(isolatedScript.js).toContain('content-isolated.js');
  });

  it('all content scripts run at document_idle', () => {
    for (const cs of manifest.content_scripts) {
      expect(cs.run_at).toBe('document_idle');
    }
  });

  it('all content scripts match <all_urls>', () => {
    for (const cs of manifest.content_scripts) {
      expect(cs.matches).toContain('<all_urls>');
    }
  });
});
