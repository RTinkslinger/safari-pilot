/**
 * Unit tests for src/escape.ts — focused regression guard for the 35-site
 * injection migration in Iter 21 (2026-04-23). Each assertion covers one
 * class of escape-critical input. If a new escape function replaces these,
 * it MUST preserve every behavior below or explain why.
 *
 * Strategy: eval the escaped output via `new Function(...)` to verify round-
 * trip behavior. If the escape is broken (e.g. missing backslash-first),
 * the Function constructor throws a SyntaxError or the returned value
 * differs from the input — both observable here without any mocks.
 */
import { describe, it, expect } from 'vitest';
import { escapeForJsSingleQuote, escapeForTemplateLiteral } from '../../src/escape.js';

/** Round-trip through a single-quoted JS literal. Throws on bad escape. */
function roundTripSingleQuote(raw: string): string {
  const escaped = escapeForJsSingleQuote(raw);
  return new Function(`return '${escaped}';`)() as string;
}

/** Round-trip through a template-literal. Throws on bad escape. */
function roundTripTemplate(raw: string): string {
  const escaped = escapeForTemplateLiteral(raw);
  return new Function(`return \`${escaped}\`;`)() as string;
}

describe('escapeForJsSingleQuote', () => {
  it('handles a backslash-then-quote sequence without double-escaping', () => {
    // The bug in pre-migration code (bare .replace(/'/g, "\\'")) produced
    // \\' from input \' — an escaped backslash followed by a literal quote,
    // ending the string literal one char early. Round-trip catches it.
    expect(roundTripSingleQuote("a\\'b")).toBe("a\\'b");
  });

  it('escapes single quotes so injection payloads stay inside the literal', () => {
    const payload = "'; alert(1); //";
    expect(roundTripSingleQuote(payload)).toBe(payload);
  });

  it('preserves newline, carriage return, and null byte across round-trip', () => {
    const s = 'line1\nline2\r\nzero\0end';
    expect(roundTripSingleQuote(s)).toBe(s);
  });

  it('escapes U+2028 / U+2029 which would otherwise terminate the JS line', () => {
    // Historical bug surface: JSON embedded in JS source breaks on LS/PS
    // because JS treats them as line terminators but JSON does not.
    //
    // Input uses String.fromCharCode so no raw LS/PS code points live in
    // this test file — they'd terminate lines in comments too, which was
    // how the first draft of this test broke its own esbuild parse.
    //
    // Round-trip alone is not sufficient here: ES2019 made raw LS/PS legal
    // in JS string literals, so removing the LS/PS replace lines from
    // escape.ts would still produce a round-trip-passing string. The
    // discriminating assertion is that the escaped output contains the
    // six-character sequences "\\u2028" and "\\u2029" — that only holds
    // when the replace lines are actually doing their job.
    const s = 'x' + String.fromCharCode(0x2028) + 'y' + String.fromCharCode(0x2029) + 'z';
    const escaped = escapeForJsSingleQuote(s);
    expect(escaped).toContain('\\u2028');
    expect(escaped).toContain('\\u2029');
    expect(roundTripSingleQuote(s)).toBe(s);
  });

  it('passes plain ASCII through unchanged', () => {
    const s = 'hello world 123';
    expect(escapeForJsSingleQuote(s)).toBe(s);
    expect(roundTripSingleQuote(s)).toBe(s);
  });
});

describe('escapeForTemplateLiteral', () => {
  it('escapes backtick so embedded user input cannot close the template', () => {
    const payload = '`; DROP TABLE users; `';
    expect(roundTripTemplate(payload)).toBe(payload);
  });

  it('escapes ${ to disable template interpolation of user input', () => {
    // Without this, `${process.env.HOME}` inside a template would expand
    // at eval time — a full arbitrary-code-execution vector.
    const payload = '${process.env.HOME}';
    expect(roundTripTemplate(payload)).toBe(payload);
  });

  it('leaves lone $ alone — only ${ is dangerous', () => {
    const s = 'cost is $5';
    expect(escapeForTemplateLiteral(s)).toBe(s);
    expect(roundTripTemplate(s)).toBe(s);
  });

  it('handles a literal backslash without producing a broken escape', () => {
    const s = 'path\\to\\file';
    expect(roundTripTemplate(s)).toBe(s);
  });
});
