// extension/lib/tab-url-matcher.js
//
// v0.1.36 Track A Fix 1 — tolerant URL→tab matcher for findTargetTab.
//
// The v0.1.35 single-run patched bench had 1,317 errors (41% of all errors)
// of "No agent-owned tab matches url=<X> (extension cache miss)". Root cause:
// the agent's stored tabUrl and the tab's actual URL drift across stylistic
// (www-prefix, fragment, tracking-param), structural (SPA pushState appended
// a path segment), and trivial (trailing slash) variations. The matcher
// was an exact string compare with only trailing-slash strip.
//
// This module implements a 3-tier ladder. Tier priority is strict: tier 0
// returns immediately on a hit; tier 1 only runs if tier 0 missed; tier 2
// only runs if tier 1 missed.
//
//   Tier 0 — exact match (after trailing-slash strip). Fastest path.
//   Tier 1 — normalized: drop fragment, drop tracking query params, drop
//            www-prefix, lower-case scheme + host. Same logical page across
//            stylistic drift.
//   Tier 2 — origin + path-prefix among candidates. SPA navigated from
//            /learn/x to /learn/x/lecture/3; agent's stored URL is the
//            shorter form. Returns the LONGEST-prefix match. Ambiguous
//            (≥2 candidates tie at the longest prefix) → null.
//
// Tier 3 (origin-only) is intentionally NOT implemented. It would route the
// agent's call to a tab the agent did not target if the path drifted
// arbitrarily — too permissive for an ownership-fail-closed system.
//
// Contract:
//   matchTabUrl(requestedUrl: string, candidates: Array<{id, url}>) → id | null
//   normalizeForMatch(url: string) → string  (export for transparency / tests)
//
// `id` is whatever shape the caller stores (typically Safari's tabId number).
// `candidates` is the list of open tabs (with their current URLs).
// `requestedUrl` is what the agent passed as tabUrl.

const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAM_EXACT = new Set([
  'gclid', 'fbclid', 'msclkid', 'mc_eid', 'mc_cid',
  'ref', 'referrer', 'source', 'campaign',
  '_ga', '_gl', 'igshid', 'yclid', 'twclid', 'dclid',
]);

function stripTrailingSlash(s) {
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

/** Normalize a URL for tier-1 matching. Returns the input unchanged if
 *  parsing fails (caller falls back to string compare). */
export function normalizeForMatch(url) {
  if (typeof url !== 'string' || url.length === 0) return url || '';
  let u;
  try { u = new URL(url); } catch { return stripTrailingSlash(url); }
  // Lower-case scheme and host.
  const scheme = u.protocol.toLowerCase();
  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);
  // Drop fragment.
  const fragment = '';
  // Filter query params: drop tracking, keep content.
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    const lk = k.toLowerCase();
    if (TRACKING_PARAM_EXACT.has(lk)) continue;
    if (TRACKING_PARAM_PREFIXES.some((p) => lk.startsWith(p))) continue;
    params.append(k, v);
  }
  const queryStr = params.toString();
  const port = u.port ? ':' + u.port : '';
  const path = stripTrailingSlash(u.pathname || '/');
  return `${scheme}//${host}${port}${path}${queryStr ? '?' + queryStr : ''}${fragment}`;
}

/** Return origin+path prefix tuple for tier-2 comparison.
 *  Returns null if the URL can't be parsed (caller skips this candidate). */
function originAndPath(url) {
  try {
    const u = new URL(url);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return {
      origin: `${u.protocol.toLowerCase()}//${host}${u.port ? ':' + u.port : ''}`,
      path: stripTrailingSlash(u.pathname || '/'),
    };
  } catch { return null; }
}

/** Returns true if `candidatePath` extends `requestedPath` at a path-segment
 *  boundary (so /learn/x matches /learn/x/y but NOT /learn/xtra). */
function pathIsPrefix(requestedPath, candidatePath) {
  if (candidatePath === requestedPath) return true;
  if (!candidatePath.startsWith(requestedPath)) return false;
  return candidatePath.charAt(requestedPath.length) === '/';
}

/** Main entry point. Returns the matched candidate's `id`, or `null`. */
export function matchTabUrl(requestedUrl, candidates) {
  if (typeof requestedUrl !== 'string' || requestedUrl.length === 0) return null;
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  // ── Tier 0: exact match (trailing-slash tolerant) ───────────────────────
  const targetExact = stripTrailingSlash(requestedUrl);
  for (const c of candidates) {
    if (stripTrailingSlash(c.url || '') === targetExact) return c.id;
  }

  // ── Tier 1: normalized match (ambiguity guard, F1.1) ────────────────────
  // First-match-wins would route into a stale or dead tab when two
  // candidates normalize-identically (e.g. live SPA-drifted tab + stale
  // closed-tab leftover). Mirror Tier 2's ambiguity contract: return id
  // only when exactly one candidate matches; null otherwise.
  const targetNorm = normalizeForMatch(requestedUrl);
  let tier1Id = null;
  let tier1Count = 0;
  for (const c of candidates) {
    if (normalizeForMatch(c.url || '') === targetNorm) {
      tier1Id = c.id;
      tier1Count += 1;
    }
  }
  if (tier1Count === 1) return tier1Id;

  // ── Tier 2: origin + path-prefix (longest unambiguous match) ───────────
  const reqOriginPath = originAndPath(requestedUrl);
  if (!reqOriginPath) return null;
  // Collect candidates whose origin matches AND whose path is an extension
  // of the requested path. Find the one with the longest path; reject if
  // multiple candidates tie at that length.
  let bestId = null;
  let bestLen = -1;
  let bestCount = 0;
  for (const c of candidates) {
    const cop = originAndPath(c.url || '');
    if (!cop) continue;
    if (cop.origin !== reqOriginPath.origin) continue;
    if (!pathIsPrefix(reqOriginPath.path, cop.path)) continue;
    if (cop.path.length > bestLen) {
      bestLen = cop.path.length;
      bestId = c.id;
      bestCount = 1;
    } else if (cop.path.length === bestLen) {
      bestCount += 1;
    }
  }
  if (bestId !== null && bestCount === 1) return bestId;

  return null;
}
