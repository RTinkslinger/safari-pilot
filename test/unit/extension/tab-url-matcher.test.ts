import { describe, it, expect } from 'vitest';
import { matchTabUrl, normalizeForMatch } from '../../../extension/lib/tab-url-matcher.js';

// v0.1.36 Track A Fix 1 — tab ownership cache 4-tier URL matcher.
//
// Bug being fixed: extension/background.js findTargetTab() did exact-string
// match against tabUrl (with only trailing-slash strip). When the agent's
// stored tabUrl drifted from the tab's actual URL — common on SPAs where
// pushState navigation changes the URL without a full reload, or where
// www-prefix / fragment / tracking params differ — the lookup returned
// null, triggering TAB_NOT_FOUND. ~1,317 errors (41% of all errors) in the
// v0.1.35 single-run bench.
//
// Contract enforced here:
//   matchTabUrl(requestedUrl, candidates) → string|null
//
//   Tier 0 (exact, after trailing-slash strip) — fastest path.
//   Tier 1 (normalized: strip fragment, tracking query params, www-prefix,
//           scheme-normalize) — same logical page across stylistic drift.
//   Tier 2 (origin + path-prefix among candidates) — SPA navigation where
//           current URL is original + a path segment (e.g.
//           /learn/x → /learn/x/lecture/3). Returns the LONGEST matching
//           prefix; if ≥2 candidates tie, returns null (ambiguous).
//
//   Returns null if no tier matches. Never falls back to origin-only —
//   that's too permissive and could route an agent's call to a tab the
//   agent did not create.
//
// `candidates` is an array of `{ id, url }`. Return value is the matched
// candidate's id (or null).

describe('normalizeForMatch — URL canonicalization for tab matching', () => {
  it('strips trailing slash', () => {
    expect(normalizeForMatch('https://x.test/path/')).toBe(normalizeForMatch('https://x.test/path'));
  });

  it('strips fragment', () => {
    expect(normalizeForMatch('https://x.test/p#anchor')).toBe(normalizeForMatch('https://x.test/p'));
  });

  it('strips utm_* and other tracking params but keeps content params', () => {
    const n = normalizeForMatch('https://x.test/p?utm_source=foo&gclid=bar&q=search&fbclid=baz');
    expect(n).toContain('q=search');
    expect(n).not.toContain('utm_source');
    expect(n).not.toContain('gclid');
    expect(n).not.toContain('fbclid');
  });

  it('normalizes www-prefix (strips www. from host)', () => {
    expect(normalizeForMatch('https://www.x.test/p')).toBe(normalizeForMatch('https://x.test/p'));
  });

  it('lower-cases scheme and host but preserves path case', () => {
    expect(normalizeForMatch('HTTPS://X.Test/SomePath')).toBe(normalizeForMatch('https://x.test/SomePath'));
  });

  it('returns input unchanged when URL is malformed (does not throw)', () => {
    expect(() => normalizeForMatch('not a url')).not.toThrow();
  });
});

describe('matchTabUrl — 3-tier ladder (v0.1.36 Fix 1)', () => {
  // ── Tier 0: exact ──────────────────────────────────────────────────────
  it('tier 0: exact match returns the id', () => {
    const m = matchTabUrl('https://x.test/p', [
      { id: 1, url: 'https://x.test/p' },
      { id: 2, url: 'https://y.test/q' },
    ]);
    expect(m).toBe(1);
  });

  it('tier 0: exact match with trailing slash drift', () => {
    expect(matchTabUrl('https://x.test/p', [{ id: 7, url: 'https://x.test/p/' }])).toBe(7);
  });

  // ── Tier 1: normalized ─────────────────────────────────────────────────
  it('tier 1: www-prefix difference still matches', () => {
    expect(matchTabUrl('https://coursera.org/learn/x', [
      { id: 3, url: 'https://www.coursera.org/learn/x' },
    ])).toBe(3);
  });

  it('tier 1: fragment difference matches', () => {
    expect(matchTabUrl('https://x.test/p', [
      { id: 4, url: 'https://x.test/p#section-2' },
    ])).toBe(4);
  });

  it('tier 1: tracking query-param difference matches', () => {
    expect(matchTabUrl('https://x.test/p', [
      { id: 5, url: 'https://x.test/p?utm_source=email&gclid=abc' },
    ])).toBe(5);
  });

  // ── Tier 2: path-prefix among candidates ───────────────────────────────
  it('tier 2: SPA push appended a path segment — matches by longest prefix', () => {
    expect(matchTabUrl('https://www.coursera.org/learn/spacesafety', [
      { id: 9, url: 'https://www.coursera.org/learn/spacesafety/lecture/3' },
      { id: 8, url: 'https://www.coursera.org/' },
    ])).toBe(9);
  });

  it('tier 2: ambiguous (2 candidates with same path-prefix) returns null', () => {
    // Both candidates extend the requested path equally — cannot disambiguate.
    expect(matchTabUrl('https://x.test/learn', [
      { id: 1, url: 'https://x.test/learn/a' },
      { id: 2, url: 'https://x.test/learn/b' },
    ])).toBe(null);
  });

  it('tier 2: picks the candidate with deepest matching path prefix when unambiguous', () => {
    // /learn/x is a more specific prefix of /learn/x/y/z than /learn is.
    expect(matchTabUrl('https://x.test/learn/x', [
      { id: 10, url: 'https://x.test/learn/x/y/z' },
      { id: 11, url: 'https://x.test/' },
    ])).toBe(10);
  });

  // ── Negative space ──────────────────────────────────────────────────────
  it('returns null when no candidate is on the same origin', () => {
    expect(matchTabUrl('https://x.test/p', [
      { id: 1, url: 'https://y.test/p' },
    ])).toBe(null);
  });

  it('does NOT origin-match (returns null even if a candidate shares origin but has unrelated path)', () => {
    // x.test/learn/spacesafety vs x.test/about — same origin, different paths.
    // Origin-only matching would return id 1; correct behavior is null.
    expect(matchTabUrl('https://x.test/learn/spacesafety', [
      { id: 1, url: 'https://x.test/about' },
    ])).toBe(null);
  });

  it('empty candidate list returns null', () => {
    expect(matchTabUrl('https://x.test/p', [])).toBe(null);
  });

  it('tier priority — exact match beats prefix match (no over-aggressive tier 2)', () => {
    // Candidate 1 is an exact match; candidate 2 is a longer prefix match.
    // Tier 0 must win; tier 2 must not be consulted.
    expect(matchTabUrl('https://x.test/learn', [
      { id: 1, url: 'https://x.test/learn' },
      { id: 2, url: 'https://x.test/learn/extra' },
    ])).toBe(1);
  });
});
