import { describe, it, expect } from 'vitest';
import { pickSpCmdKeys, makeSpCmdKey, makeSpResultKey, parseCommandIdFromKey } from '../../../extension/lib/storage-keys.js';

describe('storage-keys helpers (T55a)', () => {
  it('pickSpCmdKeys finds all sp_cmd_<id> keys', () => {
    const obj = {
      sp_cmd_a: { commandId: 'a' },
      sp_cmd_b: { commandId: 'b' },
      sp_result_a: { commandId: 'a' },
      sp_unrelated: { x: 1 },
    };
    expect(pickSpCmdKeys(obj).sort()).toEqual(['sp_cmd_a', 'sp_cmd_b']);
  });

  it('pickSpCmdKeys returns empty for object with no sp_cmd_*', () => {
    expect(pickSpCmdKeys({ sp_result_a: {}, foo: 'bar' })).toEqual([]);
  });

  it('makeSpCmdKey/makeSpResultKey produce expected shapes', () => {
    expect(makeSpCmdKey('xyz')).toBe('sp_cmd_xyz');
    expect(makeSpResultKey('xyz')).toBe('sp_result_xyz');
  });

  it('parseCommandIdFromKey extracts id from sp_cmd_ and sp_result_', () => {
    expect(parseCommandIdFromKey('sp_cmd_abc')).toBe('abc');
    expect(parseCommandIdFromKey('sp_result_def')).toBe('def');
    expect(parseCommandIdFromKey('foo')).toBe(null);
  });

  it('parseCommandIdFromKey handles ids containing underscores', () => {
    expect(parseCommandIdFromKey('sp_cmd_uuid_v4_part1_part2')).toBe('uuid_v4_part1_part2');
  });
});
