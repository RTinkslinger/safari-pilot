import { describe, it, expect } from 'vitest';
import { filterCandidatesBySession } from '../../../extension/lib/session-filter.js';

// v0.1.36 reviewer F1.2 — session-scoped tab cache, refactored 2026-05-18.
//
// Original v0.1.36 design (dev.10): daemon passed an AppleScript window id
// (Int from `id of window N`) and the filter compared it against the
// WebExtension API's `tab.windowId` from `browser.tabs.query`. These are
// two different integer namespaces — the WebExtension ID is a small int
// scoped per browser session; AppleScript's ID is Safari's internal window
// identifier. They never match. The 2026-05-18 22:53 IST per-window smoke
// caught it: every same-session safari_get_text / safari_snapshot returned
// TAB_NOT_FOUND because spFilterBySession's strict-equality compare dropped
// every candidate before the URL matcher could run.
//
// Fix: identify a session by the URL of its dashboard tab
// (`http://127.0.0.1:19475/session?id=sess_<n>`) — a stable string that
// crosses the AppleScript / WebExtension boundary safely. Background.js
// watches tabs.onUpdated / onCreated for that URL pattern and stores
// dashboardUrl → tab.windowId (WebExtension namespace) in a Map. The
// filter resolves the URL to a windowId via that Map, then filters in
// the WebExtension namespace where the cache entries live.
//
// Back-compat: when sessionDashboardUrl is undefined OR the URL has not
// yet been registered (race during session-window startup), the filter
// returns candidates unchanged. The TS-side TabOwnershipRegistry still
// enforces per-session isolation by URL, so the worst case is the
// pre-F1.2 behaviour — never accidentally tighter, never accidentally
// broader.

describe('filterCandidatesBySession (F1.2, dashboard-URL handshake)', () => {
  it('returns the input verbatim when sessionDashboardUrl is undefined (back-compat)', () => {
    const candidates = [
      { id: 1, url: 'https://x.test/', windowId: 100 },
      { id: 2, url: 'https://y.test/', windowId: 200 },
    ];
    expect(filterCandidatesBySession(candidates, undefined, new Map())).toEqual(candidates);
  });

  it('returns the input verbatim when sessionDashboardUrl is null (defensive)', () => {
    const candidates = [{ id: 1, url: 'https://x.test/', windowId: 100 }];
    expect(filterCandidatesBySession(candidates, null, new Map())).toEqual(candidates);
  });

  it('returns the input verbatim when sessionDashboardUrl is set but unregistered (startup race)', () => {
    // The dashboard tab opens via `make new document` in ensureSessionWindow,
    // but the extension's tabs.onUpdated for that tab may not have fired by
    // the time the first command lands. Failing OPEN here is a deliberate
    // choice: failing closed would stall every legitimate first-call.
    // TabOwnershipRegistry still enforces session isolation in that window.
    const candidates = [
      { id: 1, url: 'https://x.test/', windowId: 100 },
      { id: 2, url: 'https://y.test/', windowId: 200 },
    ];
    const map = new Map<string, number>(); // empty — URL not yet registered
    const url = 'http://127.0.0.1:19475/session?id=sess_unknown';
    expect(filterCandidatesBySession(candidates, url, map)).toEqual(candidates);
  });

  it('keeps only candidates whose windowId matches the resolved sessionDashboardUrl', () => {
    const sessUrl = 'http://127.0.0.1:19475/session?id=sess_A';
    const map = new Map<string, number>([[sessUrl, 100]]);
    const candidates = [
      { id: 1, url: 'https://x.test/page', windowId: 100 }, // in session A's window
      { id: 2, url: 'https://x.test/page', windowId: 200 }, // in some other session's window
      { id: 3, url: 'https://x.test/page', windowId: 100 }, // also in session A's window
    ];
    const out = filterCandidatesBySession(candidates, sessUrl, map);
    expect(out).toEqual([
      { id: 1, url: 'https://x.test/page', windowId: 100 },
      { id: 3, url: 'https://x.test/page', windowId: 100 },
    ]);
  });

  it('returns an empty list when the resolved windowId matches no candidate', () => {
    // Strong cross-session-isolation check: session A's dashboard URL maps
    // to windowId 100; the only candidates live in window 200 (session B).
    // The filter MUST drop them — anything looser is cross-session pollution.
    const sessAUrl = 'http://127.0.0.1:19475/session?id=sess_A';
    const map = new Map<string, number>([
      [sessAUrl, 100],
      ['http://127.0.0.1:19475/session?id=sess_B', 200],
    ]);
    const candidates = [
      { id: 1, url: 'https://x.test/', windowId: 200 },
      { id: 2, url: 'https://y.test/', windowId: 200 },
    ];
    expect(filterCandidatesBySession(candidates, sessAUrl, map)).toEqual([]);
  });

  it('drops candidates missing a windowId — legacy entries cannot be attributed to a session', () => {
    const sessUrl = 'http://127.0.0.1:19475/session?id=sess_A';
    const map = new Map<string, number>([[sessUrl, 100]]);
    const candidates = [
      { id: 1, url: 'https://x.test/' }, // no windowId — pre-rebuild entry
      { id: 2, url: 'https://y.test/', windowId: 100 },
    ];
    const out = filterCandidatesBySession(candidates, sessUrl, map);
    expect(out).toEqual([{ id: 2, url: 'https://y.test/', windowId: 100 }]);
  });

  it('handles an empty candidate list', () => {
    const sessUrl = 'http://127.0.0.1:19475/session?id=sess_A';
    const map = new Map<string, number>([[sessUrl, 100]]);
    expect(filterCandidatesBySession([], sessUrl, map)).toEqual([]);
  });

  it('does not confuse two sessions whose dashboard URLs differ only by session id', () => {
    // Both URLs share the same path/origin; differ only in the id query
    // parameter. The map keys are full URLs so this MUST distinguish them.
    const sessA = 'http://127.0.0.1:19475/session?id=sess_aaa';
    const sessB = 'http://127.0.0.1:19475/session?id=sess_bbb';
    const map = new Map<string, number>([[sessA, 100], [sessB, 200]]);
    const candidates = [
      { id: 1, url: 'https://shared.test/', windowId: 100 },
      { id: 2, url: 'https://shared.test/', windowId: 200 },
    ];
    expect(filterCandidatesBySession(candidates, sessA, map)).toEqual([
      { id: 1, url: 'https://shared.test/', windowId: 100 },
    ]);
    expect(filterCandidatesBySession(candidates, sessB, map)).toEqual([
      { id: 2, url: 'https://shared.test/', windowId: 200 },
    ]);
  });
});
