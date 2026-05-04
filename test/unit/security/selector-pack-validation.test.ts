import { describe, expect, test } from 'vitest';
import { validatePackName, validatePackBody, MAX_PACK_BODY_BYTES, MAX_PACK_NAME_LEN } from '../../../src/security/selector-pack-validator.js';

describe('T79 selectorPack validation', () => {
  test('validatePackName accepts alphanumeric+underscore', () => {
    expect(() => validatePackName('myPack')).not.toThrow();
    expect(() => validatePackName('my_pack_2')).not.toThrow();
    expect(() => validatePackName('_underscore_start')).not.toThrow();
  });

  test('validatePackName rejects empty / numeric-start / special chars', () => {
    expect(() => validatePackName('')).toThrow(/empty/i);
    expect(() => validatePackName('1startsWithDigit')).toThrow(/invalid/i);
    expect(() => validatePackName('has-dash')).toThrow(/invalid/i);
    expect(() => validatePackName('has space')).toThrow(/invalid/i);
    expect(() => validatePackName('has.dot')).toThrow(/invalid/i);
  });

  test('validatePackName rejects names exceeding 64 chars', () => {
    const tooLong = 'a'.repeat(65);
    expect(() => validatePackName(tooLong)).toThrow(/length/i);
  });

  test('validatePackBody accepts body under 32KB', () => {
    expect(() => validatePackBody('return root.querySelector(arg);')).not.toThrow();
  });

  test('validatePackBody rejects empty body', () => {
    expect(() => validatePackBody('')).toThrow(/empty/i);
  });

  test('validatePackBody rejects body over 32KB', () => {
    const tooLarge = 'a'.repeat(MAX_PACK_BODY_BYTES + 1);
    expect(() => validatePackBody(tooLarge)).toThrow(/size/i);
  });

  test('validatePackBody rejects body that mentions eval', () => {
    expect(() => validatePackBody('eval("alert(1)")')).toThrow(/eval/i);
  });

  test('validatePackBody rejects body that mentions Function constructor by name', () => {
    expect(() => validatePackBody('new Function("alert(1)")()')).toThrow(/Function/i);
  });

  test('MAX constants are exposed', () => {
    expect(MAX_PACK_BODY_BYTES).toBe(32 * 1024);
    expect(MAX_PACK_NAME_LEN).toBe(64);
  });
});
