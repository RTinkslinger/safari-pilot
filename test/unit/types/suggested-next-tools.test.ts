import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('Cluster G — suggested_next_tools wiring (source-grep)', () => {
  it('ToolResponseMetadata declares suggested_next_tools field', async () => {
    const src = await readFile('src/types.ts', 'utf8');
    expect(src).toMatch(/suggested_next_tools/);
    expect(src).toMatch(/tool:\s*string;\s*reason:\s*string/);
  });

  it('safari_navigate suggests safari_snapshot in result metadata', async () => {
    const src = await readFile('src/tools/navigation.ts', 'utf8');
    expect(src).toMatch(/suggested_next_tools/);
    expect(src).toMatch(/safari_snapshot/);
  });

  it('HumanApproval block surfaces suggested_next_tools', async () => {
    const src = await readFile('src/security/human-approval.ts', 'utf8');
    expect(src).toMatch(/suggested_next_tools/);
  });
});
