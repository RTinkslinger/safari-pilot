/**
 * Signing Validation Integration Test (Task G)
 *
 * Verifies the Safari Pilot.app is properly signed with Developer ID,
 * notarized by Apple, and has the stapled ticket attached.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const APP_PATH = path.join(PROJECT_ROOT, 'bin', 'Safari Pilot.app');
const APPEX_PATH = path.join(
  APP_PATH,
  'Contents',
  'PlugIns',
  'Safari Pilot Extension.appex',
);

// Helper: run a command and return stdout+stderr combined
function run(cmd: string): string {
  try {
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8' });
  } catch (err: unknown) {
    const spawnErr = err as { stdout?: string; stderr?: string };
    return (spawnErr.stdout ?? '') + (spawnErr.stderr ?? '');
  }
}

// ── Test 1: App bundle structure ────────────────────────────────────────────

describe('Signing Validation — App bundle structure', () => {
  it('Safari Pilot.app exists in bin/', () => {
    expect(existsSync(APP_PATH)).toBe(true);
  });

  it('.app contains a valid .appex plugin', () => {
    expect(existsSync(APPEX_PATH)).toBe(true);
  });

  it('.appex contains an executable', () => {
    const execPath = path.join(
      APPEX_PATH,
      'Contents',
      'MacOS',
      'Safari Pilot Extension',
    );
    expect(existsSync(execPath)).toBe(true);
  });
});

// ── Test 2: Code signature verification ─────────────────────────────────────

describe('Signing Validation — codesign --verify', () => {
  it('.app passes codesign --verify --deep --strict', () => {
    const output = run(
      `codesign --verify --deep --strict --verbose=2 "${APP_PATH}" 2>&1`,
    );
    expect(output).toContain('valid on disk');
    expect(output).toContain('satisfies its Designated Requirement');
  });

  it('.appex passes codesign --verify', () => {
    const output = run(
      `codesign --verify --strict --verbose=2 "${APPEX_PATH}" 2>&1`,
    );
    expect(output).toContain('valid on disk');
  });

  it('.app is signed with Developer ID (not adhoc)', () => {
    const output = run(`codesign -dvvv "${APP_PATH}" 2>&1`);
    expect(output).toContain(
      'Authority=Developer ID Application: Aakash Kumar (V37WLKRXUJ)',
    );
    expect(output).toContain('Authority=Developer ID Certification Authority');
    expect(output).toContain('Authority=Apple Root CA');
    expect(output).not.toContain('Signature=adhoc');
  });

  it('.app has Hardened Runtime enabled', () => {
    const output = run(`codesign -dvvv "${APP_PATH}" 2>&1`);
    // flags should include 'runtime' (0x10000) and NOT 'adhoc' (0x2)
    expect(output).toMatch(/flags=0x10000\(runtime\)/);
  });

  it('.app has correct TeamIdentifier', () => {
    const output = run(`codesign -dvvv "${APP_PATH}" 2>&1`);
    expect(output).toContain('TeamIdentifier=V37WLKRXUJ');
  });

  it('.app has a secure timestamp', () => {
    const output = run(`codesign -dvvv "${APP_PATH}" 2>&1`);
    // Timestamp format: "Timestamp=Apr 12, 2026 at 1:33:01 PM" or "Timestamp=2026-04-12..."
    expect(output).toMatch(/Timestamp=\S/);
  });
});

// ── Test 3: Gatekeeper (spctl) assessment ───────────────────────────────────

describe('Signing Validation — spctl (Gatekeeper)', () => {
  it('.app is accepted by Gatekeeper', () => {
    const output = run(`spctl -a -t exec -vv "${APP_PATH}" 2>&1`);
    expect(output).toContain('accepted');
    expect(output).toContain('Notarized Developer ID');
  });

  it('.app origin is the correct Developer ID', () => {
    const output = run(`spctl -a -t exec -vv "${APP_PATH}" 2>&1`);
    expect(output).toContain(
      'origin=Developer ID Application: Aakash Kumar (V37WLKRXUJ)',
    );
  });
});

// ── Test 4: Notarization staple ─────────────────────────────────────────────

describe('Signing Validation — Notarization staple', () => {
  it('stapler validate passes on .app', () => {
    const output = run(`xcrun stapler validate "${APP_PATH}" 2>&1`);
    expect(output).toContain('The validate action worked!');
  });

  it('codesign reports Notarization Ticket = stapled', () => {
    const output = run(`codesign -dvvv "${APP_PATH}" 2>&1`);
    expect(output).toContain('Notarization Ticket=stapled');
  });
});
