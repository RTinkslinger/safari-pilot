// extension/lib/session-filter.js
//
// v0.1.36 reviewer F1.2 — session-scoped tab cache.
//
// Pure list-transform helper: filter a candidate list to only the tabs
// belonging to the current MCP session's window. Invoked by
// extension/background.js findTargetTab() BEFORE the URL matcher
// (extension/lib/tab-url-matcher.js) runs, so cross-session tabs never
// enter the matcher's candidate pool.
//
// Contract:
//   filterCandidatesBySession(candidates, sessionWindowId) → Array
//
//   When `sessionWindowId` is undefined OR null, returns `candidates`
//   unchanged. This preserves the pre-F1.2 behaviour for commands that
//   arrive before a session window is associated (e.g. health probes,
//   legacy callers, the daemon's own bookkeeping calls).
//
//   When `sessionWindowId` is a number, returns the subset of candidates
//   whose `windowId === sessionWindowId`. Candidates missing `windowId`
//   are dropped — they're legacy cache entries that predate the
//   sessionWindowId field and cannot be attributed to any session.
//
// `candidates` is the same shape passed to matchTabUrl: `{id, url}` —
// extended in F1.2 with an optional `windowId` number.

export function filterCandidatesBySession(candidates, sessionWindowId) {
  if (sessionWindowId === undefined || sessionWindowId === null) {
    return candidates;
  }
  return candidates.filter((c) => c.windowId === sessionWindowId);
}
