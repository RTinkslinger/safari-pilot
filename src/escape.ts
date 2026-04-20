// src/escape.ts

/**
 * Escape a string for safe embedding inside a JS single-quoted string literal ('...').
 *
 * Escaping order matters — backslash MUST be first, otherwise the subsequent
 * replacements produce double-escaped sequences.
 *
 * Handles: \, ', \n, \r, \0, U+2028 (line separator), U+2029 (paragraph separator)
 */
export function escapeForJsSingleQuote(s: string): string {
  return s
    .replace(/\\/g, '\\\\')       // backslash → \\  (MUST be first)
    .replace(/'/g, "\\'")          // quote → \'
    .replace(/\n/g, '\\n')         // newline → \n
    .replace(/\r/g, '\\r')         // carriage return → \r
    .replace(/\0/g, '\\0')         // null byte → \0
    .replace(/\u2028/g, '\\u2028') // line separator
    .replace(/\u2029/g, '\\u2029'); // paragraph separator
}

/**
 * Escape a string for safe embedding inside a JS template literal (`...`).
 *
 * Escapes: \, `, and ${ (template interpolation start sequence).
 * Does NOT escape lone $ (safe — only ${...} triggers interpolation).
 */
export function escapeForTemplateLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')   // backslash → \\  (MUST be first)
    .replace(/`/g, '\\`')      // backtick → \`
    .replace(/\$\{/g, '\\${'); // ${ → \${ (only the dangerous sequence)
}
