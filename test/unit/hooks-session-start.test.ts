import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const HOOK_PATH = join(import.meta.dirname, '..', '..', 'hooks', 'session-start.sh');

describe('SessionStart hook — date injection (v0.1.31 Task 17)', () => {
  it('emits parseable JSON to stdout containing additionalContext with current date', () => {
    const output = execSync(`bash "${HOOK_PATH}" 2>/dev/null`, { encoding: 'utf-8' });
    const lines = output.trim().split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const lastLine = lines[lines.length - 1];
    const parsed = JSON.parse(lastLine);
    expect(parsed).toHaveProperty('hookSpecificOutput.additionalContext');
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/^Current date: \d{4}-\d{2}-\d{2}$/);
  });

  it('preserves existing stderr log output (does not break stderr discipline)', () => {
    if (process.platform === 'darwin') {
      // On Darwin the existing "safari-pilot:" stderr lines must still emit
      // alongside the new stdout JSON. Capture stderr by routing 2>&1 1>/dev/null.
      const result = execSync(`bash "${HOOK_PATH}" 2>&1 1>/dev/null`, { encoding: 'utf-8' });
      expect(result).toMatch(/safari-pilot:/);
    } else {
      // Non-Darwin path early-exits; nothing to assert.
      expect(true).toBe(true);
    }
  });

  it('exits 0', () => {
    const result = execSync(`bash "${HOOK_PATH}" >/dev/null 2>&1; echo "EXIT:$?"`, { encoding: 'utf-8' });
    expect(result.trim()).toBe('EXIT:0');
  });
});
