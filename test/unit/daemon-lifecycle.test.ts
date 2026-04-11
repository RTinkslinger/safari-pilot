import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const PLIST_PATH = resolve(ROOT, 'daemon/com.safari-pilot.daemon.plist');

describe('Daemon LaunchAgent plist', () => {
  it('plist file exists at daemon/com.safari-pilot.daemon.plist', () => {
    expect(existsSync(PLIST_PATH)).toBe(true);
  });

  it('contains Label "com.safari-pilot.daemon"', () => {
    const content = readFileSync(PLIST_PATH, 'utf-8');
    expect(content).toContain('<string>com.safari-pilot.daemon</string>');
  });

  it('contains KeepAlive key', () => {
    const content = readFileSync(PLIST_PATH, 'utf-8');
    expect(content).toContain('<key>KeepAlive</key>');
  });

  it('contains ThrottleInterval key', () => {
    const content = readFileSync(PLIST_PATH, 'utf-8');
    expect(content).toContain('<key>ThrottleInterval</key>');
  });

  it('contains ProgramArguments key', () => {
    const content = readFileSync(PLIST_PATH, 'utf-8');
    expect(content).toContain('<key>ProgramArguments</key>');
  });

  it('contains __DAEMON_PATH__ placeholder for install-time substitution', () => {
    const content = readFileSync(PLIST_PATH, 'utf-8');
    expect(content).toContain('__DAEMON_PATH__');
  });

  it('contains __LOG_PATH__ placeholder for install-time substitution', () => {
    const content = readFileSync(PLIST_PATH, 'utf-8');
    expect(content).toContain('__LOG_PATH__');
  });

  it('has RunAtLoad set to false (daemon should not auto-start on install)', () => {
    const content = readFileSync(PLIST_PATH, 'utf-8');
    // RunAtLoad key must be followed by <false/>
    const runAtLoadIndex = content.indexOf('<key>RunAtLoad</key>');
    expect(runAtLoadIndex).toBeGreaterThan(-1);
    const afterKey = content.slice(runAtLoadIndex);
    expect(afterKey).toContain('<false/>');
  });

  it('has valid XML plist structure', () => {
    const content = readFileSync(PLIST_PATH, 'utf-8');
    expect(content).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(content).toContain('<plist version="1.0">');
    expect(content).toContain('</plist>');
  });
});
