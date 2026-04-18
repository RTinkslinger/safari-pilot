import { describe, it, expect } from 'vitest';
import { INFRA_MESSAGE_TYPES } from '../../src/server';

describe('INFRA_MESSAGE_TYPES (daemon↔extension coordination bypass set)', () => {
  const expected = [
    'extension_poll',
    'extension_drain',
    'extension_reconcile',
    'extension_connected',
    'extension_disconnected',
    'extension_log',
    'extension_result',
  ];

  it.each(expected)('contains %s', (method) => {
    expect(INFRA_MESSAGE_TYPES.has(method)).toBe(true);
  });

  it('does not contain any safari_* tool name', () => {
    for (const t of INFRA_MESSAGE_TYPES) {
      expect(t.startsWith('safari_')).toBe(false);
    }
  });

  it('is a ReadonlySet', () => {
    // Immutability — these entries should not be runtime-editable by consumers.
    expect(INFRA_MESSAGE_TYPES).toBeInstanceOf(Set);
    // TypeScript enforces readonly; at runtime a `delete` would still work but we
    // document intent via the type.
  });
});
