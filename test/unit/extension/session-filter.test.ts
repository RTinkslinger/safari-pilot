import { describe, it, expect } from 'vitest';
import { filterCandidatesBySession } from '../../../extension/lib/session-filter.js';

// v0.1.36 reviewer F1.2 — session-scoped tab cache.
//
// Bug being fixed: extension/background.js findTargetTab() calls
// browser.tabs.query({}) which returns ALL tabs across ALL Safari windows
// regardless of which MCP session opened them. At bench concurrency 4 (or
// any time two MCP sessions share a Safari instance), the 4-tier URL
// matcher could match a tab opened by a different session — silently
// routing one agent's command into another agent's tab. Tab ownership
// fails CLOSED at the TS layer (TabUrlNotRecognizedError), but only if
// the extension returns the wrong tab; the extension itself currently
// never filters by session.
//
// Fix: every daemon → extension command now carries the originating
// session's window id (`sessionWindowId`). The matcher's candidate pool
// is pre-filtered to tabs whose `windowId === sessionWindowId` BEFORE
// any URL-tier compares fire. Back-compat: when `sessionWindowId` is
// undefined (e.g., commands issued before the session window initialises,
// or legacy callers), candidates are NOT filtered — current behaviour
// preserved.
//
// The matcher itself (tab-url-matcher.js, F1.1) is left untouched; the
// session filter sits one layer above as a pure list transform.

describe('filterCandidatesBySession (F1.2)', () => {
  it('returns the input verbatim when sessionWindowId is undefined (back-compat)', () => {
    const candidates = [
      { id: 1, url: 'https://x.test/', windowId: 100 },
      { id: 2, url: 'https://y.test/', windowId: 200 },
    ];
    expect(filterCandidatesBySession(candidates, undefined)).toEqual(candidates);
  });

  it('returns the input verbatim when sessionWindowId is null (defensive)', () => {
    const candidates = [
      { id: 1, url: 'https://x.test/', windowId: 100 },
    ];
    expect(filterCandidatesBySession(candidates, null)).toEqual(candidates);
  });

  it('keeps only candidates whose windowId matches sessionWindowId', () => {
    const candidates = [
      { id: 1, url: 'https://x.test/page', windowId: 100 },
      { id: 2, url: 'https://x.test/page', windowId: 200 },
      { id: 3, url: 'https://x.test/page', windowId: 100 },
    ];
    const out = filterCandidatesBySession(candidates, 100);
    expect(out).toEqual([
      { id: 1, url: 'https://x.test/page', windowId: 100 },
      { id: 3, url: 'https://x.test/page', windowId: 100 },
    ]);
  });

  it('returns an empty list when no candidate matches the session', () => {
    const candidates = [
      { id: 1, url: 'https://x.test/', windowId: 200 },
      { id: 2, url: 'https://y.test/', windowId: 300 },
    ];
    expect(filterCandidatesBySession(candidates, 100)).toEqual([]);
  });

  it('drops candidates missing a windowId — they are pre-cache-rebuild entries we cannot attribute to a session', () => {
    const candidates = [
      { id: 1, url: 'https://x.test/' },  // no windowId — legacy cache entry
      { id: 2, url: 'https://y.test/', windowId: 100 },
    ];
    const out = filterCandidatesBySession(candidates, 100);
    expect(out).toEqual([{ id: 2, url: 'https://y.test/', windowId: 100 }]);
  });

  it('treats undefined sessionWindowId as the no-op filter (separate from null/0)', () => {
    const candidates = [{ id: 1, url: 'https://x.test/', windowId: 100 }];
    expect(filterCandidatesBySession(candidates, undefined)).toEqual(candidates);
  });

  it('handles an empty candidate list', () => {
    expect(filterCandidatesBySession([], 100)).toEqual([]);
  });
});
