// extension/lib/cs-readiness.js
//
// v0.1.36 Track A Fix 3 — pure-logic core for content-script-readiness gating.
//
// In v0.1.35 patched bench, 499 errors (16% of all errors) were
// "Storage bus timeout (30000ms) — content script may not be loaded on
// target tab". Root cause: background.js dispatches sp_cmd_<id> immediately
// after a tab is created or navigated, but the content script takes
// 0.5–3 s to attach its storage.onChanged listener. The bus write succeeds,
// no listener consumes it, and we wait 30 s for nothing.
//
// Fix: track per-tab "content script ready" heartbeats. Content-isolated.js
// writes its load timestamp to storage on startup; background.js's storage
// listener records each heartbeat into a Map. Before dispatching a bus
// command, decide the timeout based on whether the script is known ready:
//   - ready  → use the caller's default timeout (typically 30 s)
//   - not ready → use a SHORT timeout (5 s) so the agent fast-fails and
//                 sees CONTENT_SCRIPT_NOT_READY instead of a 30 s wait.
//
// This module exports the pure decision functions. The integration in
// background.js wires up: (a) the heartbeat reader (storage.onChanged on
// keys named `sp_cs_ready_<tabId>`), (b) the dispatch-time check.

/** Max age (ms) for a "ready" heartbeat. After this, the script may have
 *  been swapped by a navigation; treat the tab as not-ready until a fresh
 *  heartbeat arrives. */
export const CS_READY_MAX_AGE_MS = 60_000;

/** Fast-fail floor when CS is not known ready. Long enough for ~99% of
 *  legitimate content-script-not-yet-ready races to resolve mid-wait; short
 *  enough that the agent sees the error quickly instead of stalling. */
export const CS_NOT_READY_FAST_FAIL_MS = 10_000;

/** Record a heartbeat. `readinessMap` is a Map<tabId, {timestamp}>. */
export function recordCsReady(readinessMap, tabId, now) {
  readinessMap.set(tabId, { timestamp: now });
}

/** Returns true iff a fresh heartbeat exists for the tab. */
export function isCsReady(readinessMap, tabId, now, maxAgeMs = CS_READY_MAX_AGE_MS) {
  const entry = readinessMap.get(tabId);
  if (!entry) return false;
  return (now - entry.timestamp) <= maxAgeMs;
}

/** Decide which timeout to use for a storage-bus dispatch.
 *  Returns `{ timeoutMs, reason }` where reason ∈ {'cs_ready', 'cs_not_ready'}.
 *  When not ready, returns min(callerDefault, FAST_FAIL_MS) — never raises
 *  above the caller's bound. */
export function decideStorageBusTimeout(readinessMap, tabId, now, callerDefaultMs) {
  if (isCsReady(readinessMap, tabId, now)) {
    return { timeoutMs: callerDefaultMs, reason: 'cs_ready' };
  }
  return {
    timeoutMs: Math.min(callerDefaultMs, CS_NOT_READY_FAST_FAIL_MS),
    reason: 'cs_not_ready',
  };
}
