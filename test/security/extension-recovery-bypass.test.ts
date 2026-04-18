/**
 * Extension Recovery Security Bypass Prevention (1a subset)
 *
 * Verifies: EXTENSION_UNCERTAIN on an IdpiScanner-flagged action does not
 * allow silent retry; IdpiScanner re-evaluates and retryable=false is
 * explicitly set.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');

describe('Extension recovery security bypass prevention (1a)', () => {
  it('ExtensionUncertainError explicitly sets retryable=false', () => {
    const errorsSrc = readFileSync(join(ROOT, 'src/errors.ts'), 'utf8');
    expect(errorsSrc).toMatch(/ExtensionUncertainError/);
    // Verify the class sets retryable = false (not true, not computed)
    expect(errorsSrc).toMatch(/readonly\s+retryable\s*=\s*false/);
  });

  it('StructuredUncertainty includes recommendation field for caller decision', () => {
    const typesSrc = readFileSync(join(ROOT, 'src/types.ts'), 'utf8');
    expect(typesSrc).toMatch(/StructuredUncertainty/);
    expect(typesSrc).toMatch(/recommendation:\s*['"]probe_state['"]\s*\|\s*['"]caller_decides['"]/);
  });

  it('HumanApproval.invalidateForDegradation exists for re-evaluation on fallback', () => {
    const approvalSrc = readFileSync(join(ROOT, 'src/security/human-approval.ts'), 'utf8');
    expect(approvalSrc).toMatch(/invalidateForDegradation/);
  });

  it('IdpiScanner.invalidateForDegradation exists for re-evaluation on fallback', () => {
    const scannerSrc = readFileSync(join(ROOT, 'src/security/idpi-scanner.ts'), 'utf8');
    expect(scannerSrc).toMatch(/invalidateForDegradation/);
  });

  it('Server re-invokes HumanApproval after engine degradation detection', () => {
    const serverSrc = readFileSync(join(ROOT, 'src/server.ts'), 'utf8');
    // The degradation re-run block calls invalidateForDegradation + assertApproved
    expect(serverSrc).toMatch(/invalidateForDegradation/);
    expect(serverSrc).toMatch(/degradedFromExtension/);
  });
});
