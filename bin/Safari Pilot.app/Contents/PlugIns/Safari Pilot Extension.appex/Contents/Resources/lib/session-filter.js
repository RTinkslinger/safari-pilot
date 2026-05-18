// extension/lib/session-filter.js
//
// v0.1.36 reviewer F1.2 — session-scoped tab cache.
//
// 2026-05-18 evening rework: contract changed from
// `(candidates, sessionWindowId)` (numeric AppleScript window id, broken
// because the WebExtension API's `tab.windowId` lives in a different
// integer namespace — they never match) to
// `(candidates, sessionDashboardUrl, urlToWidMap)` — a stable string
// identifier that crosses the AppleScript / WebExtension boundary safely.
// Background.js owns the Map; it observes tabs.onUpdated/onCreated for the
// dashboard URL pattern and stores `dashboardUrl → tab.windowId`
// (WebExtension namespace).
//
// Contract:
//   filterCandidatesBySession(candidates, sessionDashboardUrl, urlToWidMap) → Array
//
//   When `sessionDashboardUrl` is undefined OR null, returns `candidates`
//   unchanged. Preserves pre-F1.2 behaviour for commands that arrive
//   before a session window is associated (health probes, legacy callers,
//   the daemon's own bookkeeping calls).
//
//   When `sessionDashboardUrl` is a string AND the Map has NOT yet
//   registered it (startup race: dashboard tab opened but tabs.onUpdated
//   hasn't fired), returns `candidates` unchanged. Fail-OPEN by design —
//   TabOwnershipRegistry on the TS side still enforces per-session
//   isolation by URL, so the worst case is the pre-F1.2 behaviour, never
//   accidentally broader.
//
//   When `sessionDashboardUrl` resolves to a windowId via the Map, returns
//   the subset of candidates whose `windowId === <resolved>`. Candidates
//   missing `windowId` are dropped — legacy cache entries that predate
//   F1.2 and cannot be attributed to any session.

export function filterCandidatesBySession(candidates, sessionDashboardUrl, urlToWidMap) {
  if (sessionDashboardUrl === undefined || sessionDashboardUrl === null) {
    return candidates;
  }
  const wid = urlToWidMap && typeof urlToWidMap.get === 'function'
    ? urlToWidMap.get(sessionDashboardUrl)
    : undefined;
  if (wid === undefined) {
    // Startup race or unknown session — fail open (see header).
    return candidates;
  }
  return candidates.filter((c) => c.windowId === wid);
}
