# Tab Ownership by Identity — Design Spec

## Problem

Tab ownership uses URL exact-match to determine if the agent owns a tab. URLs change on every redirect, click-navigation, back/forward, SPA routing, hash change, and `pushState`. The current approach is fundamentally broken — we've been adding band-aids (`NAVIGATION_URL_TRACKING_TOOLS`, `SKIP_OWNERSHIP_TOOLS` for back/forward) that will never converge.

Today's fail-closed ownership (shipped 2026-04-20) actively breaks:
- `safari_click` on a link → page navigates → next tool call throws `TabUrlNotRecognizedError`
- Any redirect (HTTP 301/302, meta refresh, JS location.href) → same failure
- `safari_navigate_back/forward` → workaround: added to SKIP_OWNERSHIP_TOOLS (bypasses ownership entirely)

## Root Cause

The extension's `browser.tabs` API provides a **stable integer `tab.id`** that persists for the lifetime of a tab regardless of URL changes, redirects, or history navigation. This identity is already tracked in `background.js`'s `tabCacheMap` (persisted to `browser.storage.local`, survives event page suspension). But it's never surfaced upstream — the server never receives it.

## Solution: Ownership by Tab Identity

### Core Principle

Once Safari Pilot opens a tab, that tab is **owned for the entire session** — regardless of URL changes. Ownership is keyed by the extension's stable `tab.id`, not by URL.

### Design

**Registration:** When `safari_new_tab` executes via the extension, `background.js` includes the `tab.id` of the created tab in the result. The server stores it in the ownership registry alongside the URL.

**Lookup (synchronous, zero IPC):**
```
Tool call arrives with params.tabUrl
  → findByUrl(tabUrl)           // fast path: O(n) Map scan, microseconds
  → if not found:
      findByExtensionTabId(???) // BUT: we don't know the tab.id from the URL alone
```

**The critical insight:** We can't look up by `extensionTabId` on the ownership check because we don't HAVE the tab.id at that point — we only have the URL the agent passed. The tab.id is stored in the registry keyed by our synthetic ID. We need URL → syntheticId → verify ownership.

**Revised lookup:**
```
Tool call arrives with params.tabUrl
  → findByUrl(tabUrl)                    // fast path: URL matches registry
  → if not found AND extension available:
      scan ownedTabs for entry where extensionTabId matches
      what the extension reports for this URL
```

**Wait — that's the circular async query again.** Let me think differently.

**The REAL fix:** The problem isn't the ownership CHECK — it's that the registry's URL goes STALE. If we keep the URL current, `findByUrl()` always works.

### Revised Design: Proactive URL Refresh

**On every extension-engine tool execution:**
1. `background.js` finds the target tab (via `findTargetTab(tabUrl)` — scans cache for URL match)
2. `background.js` executes the command in that tab
3. `background.js` includes `{ executedInTabId: tab.id, currentUrl: tab.url }` in the result
4. Server receives result, reads `executedInTabId` + `currentUrl`
5. Server calls `tabOwnership.updateUrlByExtensionTabId(executedInTabId, currentUrl)`
6. Registry URL is now current for the NEXT call

**The first-call-after-URL-change problem:** The FIRST call after a redirect still fails because the URL hasn't been refreshed yet. To solve this:

**On `safari_new_tab`:** Store `extensionTabId` in the registry alongside the URL.

**On ownership check failure:** Instead of throwing immediately, do a SYNCHRONOUS scan of owned tabs:
```typescript
// If findByUrl fails, check if ANY owned tab has this extensionTabId
// But we still don't know the extensionTabId from the URL...
```

**This is the fundamental tension:** The ownership check receives a URL. The registry has tab.ids. Without asking the extension "what tab.id is at this URL?", there's no synchronous path from URL → tab.id.

### Final Design: Accept First-Call Failure OR Preemptive Extension Query

**Option chosen: Accept first-call failure for non-extension paths. For extension paths, piggyback the lookup on the tool execution itself.**

The extension already receives `tabUrl` with every command. It already runs `findTargetTab(tabUrl)` which scans its cache (which IS fresher than the server's — `tabs.onUpdated` fires on full navigations and redirects). If the extension finds the tab, the command executes. If not, it errors.

**The ownership check only needs to answer: "is this tab one we opened?"** It doesn't need to answer "what's the current URL?" — that's the tab FINDER's job (already handled by the extension/AppleScript engine).

**Simplest correct design:**

1. **Relax ownership to: "was this tab opened in this session?"**
2. **Store `extensionTabId` at creation. Store ALL URLs the tab has ever had.**
3. **`findByUrl` checks the history, not just current URL.**

Actually, even simpler:

### FINAL FINAL Design: URL Set Instead of URL String

```typescript
// OLD:
private ownedTabs: Map<TabId, string>  // tabId -> single URL

// NEW:
private ownedTabs: Map<TabId, { urls: Set<string>, extensionTabId?: number }>
```

**On registration:** Store initial URL in the set + extensionTabId.
**On URL refresh (from extension result):** ADD the new URL to the set (don't replace).
**On `findByUrl(url)`:** Check if ANY owned tab's URL set contains this URL.

This means: once a tab visits a URL while owned, that URL is permanently associated with the tab. No URL is ever "lost" from the registry.

**Why this works:**
- Tab opens at `example.com` → set: `{example.com}`
- Click navigates to `iana.org/domains/example` → extension result adds it → set: `{example.com, iana.org/domains/example}`
- Redirect lands at `www.iana.org/help/example-domains` → extension result adds it → set: `{example.com, iana.org/..., www.iana.org/...}`
- Agent calls with any of these URLs → found in set → ownership passes

**The first-call problem:** After a redirect, the FIRST call with the new URL will fail (URL not yet in set). This is solved by the extension-engine execution path:

When the extension receives a command with a URL that doesn't match the tab's current URL, it tries to find the tab anyway (its cache updates via `tabs.onUpdated`). If it finds the tab:
- The command executes successfully
- The result includes `{ executedInTabId, currentUrl }`
- Server adds `currentUrl` to the ownership set

**But the ownership check fires BEFORE the tool executes.** So the first call still fails.

### THE ACTUAL SOLUTION: Move ownership check AFTER extension tab resolution

```
Current flow:
  1. Ownership check (URL match) → PASS or THROW
  2. Engine selection
  3. Tool execution (extension finds tab by URL from its cache)

Proposed flow:
  1. Engine selection
  2. If extension engine: let the extension resolve the tab
     → extension returns { tabId, currentUrl } as part of execution
     → AFTER execution succeeds, verify tabId is owned
  3. If AppleScript engine: ownership check by URL (same as today)
```

**NO.** This violates the security pipeline's design: ownership MUST be checked BEFORE execution. We can't let an unowned tab execute and then check after — the damage is done.

### THE REAL ACTUAL SOLUTION (Final)

After extensive analysis, there are only two viable approaches:

---

## Approach A: Extension-Assisted Ownership Check (Chosen)

**Pre-execution:** When `findByUrl()` fails AND extension is available, make ONE synchronous-feeling IPC call to the extension asking "do you have a tab matching this URL? What's its tab.id?" This is the `query_tab_id` internal command the v3 auditor rejected as "50-200ms latency."

**Mitigation of the latency concern:** Use the daemon's TCP:19474 connection (direct NDJSON, not HTTP poll). The HTTP:19475 path has poll latency. TCP:19474 is immediate. The extension doesn't need to be involved — the DAEMON's own tab knowledge (from `tabs.onUpdated` events forwarded to it) might be sufficient.

**Actually:** The daemon doesn't track tabs. Only the extension does. So this requires the HTTP path. The latency concern is real.

**Mitigation 2:** Cache the extension's answer. Once we know "URL X → tab.id Y", store it. Next call with URL X hits the cache, no IPC.

**WAIT.** That's just... adding the URL to the owned set. Which is what the URL-set approach does.

---

## Approach B: URL Set + Accept First-Call Latency (Chosen — Simpler)

The first call after a URL change adds ~100ms latency (extension round-trip to confirm the tab). All subsequent calls are instant (URL is in the set).

**Implementation:**

1. **TabOwnership stores URL sets:**
```typescript
interface OwnedTab {
  urls: Set<string>;
  extensionTabId?: number;
}
private ownedTabs: Map<TabId, OwnedTab>
```

2. **Registration:** `safari_new_tab` result includes `extensionTabId`. Stored alongside initial URL.

3. **Ownership check (revised):**
```typescript
findByUrl(url: string): TabId | undefined {
  for (const [tabId, data] of this.ownedTabs) {
    if (data.urls.has(url)) return tabId;
  }
  return undefined;
}
```

4. **First-call-after-URL-change:** When `findByUrl` fails:
   - If `extensionTabId` is stored for ANY owned tab, ask extension "is URL X the current URL of tab.id Y?" for each owned tab. This is a LOCAL check in background.js — iterate owned extensionTabIds, check tabCacheMap. ONE IPC round-trip for ALL owned tabs, not per-tab.
   - If extension confirms: add URL to that tab's set, return tabId.
   - If extension unavailable or denies: throw `TabUrlNotRecognizedError`.

5. **URL refresh after every extension-engine tool call:**
   - `background.js` includes `{ executedInTabId, currentUrl }` in results
   - Server adds `currentUrl` to the owned tab's URL set (never removes)
   - After first successful call, subsequent calls hit the set directly

6. **Cleanup:** URLs accumulate. Cap the set at 20 entries per tab (drop oldest). A tab visiting 20+ unique URLs in one session is rare; if it happens, the oldest URLs being dropped is acceptable (they're unlikely to be used again).

---

## Changes Required

| File | Change | Complexity |
|------|--------|-----------|
| `extension/background.js` | Include `executedInTabId` + `currentUrl` in every command result. Add `query_owned_tabs` handler: given list of tab.ids, return their current URLs from tabCacheMap. | Medium |
| `daemon/Sources/.../ExtensionBridge.swift` | Pass through `executedInTabId` and `currentUrl` fields in result unwrapping. Route `query_owned_tabs` internal command. | Medium |
| `src/engines/extension.ts` | Extract `executedInTabId` + `currentUrl` from result metadata, expose upstream. | Small |
| `src/security/tab-ownership.ts` | Change `Map<TabId, string>` to `Map<TabId, OwnedTab>`. Add `findByExtensionTabId()`. Add URL set management. Cap at 20 URLs. | Medium |
| `src/server.ts` | Store extensionTabId on registration. Fallback ownership check (batch query extension for owned tab.ids). URL refresh after every extension call. Remove `NAVIGATION_URL_TRACKING_TOOLS`. Remove back/forward/click from SKIP_OWNERSHIP. | Medium |
| `src/tools/navigation.ts` | `handleNewTab` returns `extensionTabId` from result metadata. | Small |
| `ARCHITECTURE.md` | Document new ownership model. | Small |

## What Gets Removed

- `NAVIGATION_URL_TRACKING_TOOLS` constant and the 8.post2 block — replaced by universal URL refresh
- `safari_navigate_back` and `safari_navigate_forward` from `SKIP_OWNERSHIP_TOOLS` — tab.id is stable across history navigation
- The entire "URL tracking" concept — replaced by URL accumulation in a set

## What Stays

- `SKIP_OWNERSHIP_TOOLS` for: `safari_list_tabs`, `safari_new_tab`, `safari_health_check` (genuinely don't target a specific tab)
- `TabUrlNotRecognizedError` — still thrown when extension is unavailable and URL doesn't match
- Fail-closed behavior — unknown URLs are rejected (after extension fallback attempt)

## Graceful Degradation

| Condition | Behavior |
|-----------|----------|
| Extension connected (production) | Full dual-key: URL set + extensionTabId. First-call-after-redirect: ~100ms extension query, then instant. |
| Extension disconnected (fallback) | URL-set only. Works for URLs the tab has visited. Fails on first call after redirect (same as today). |
| AppleScript only (rare) | URL matching only. Same behavior as before this change. |

## Edge Cases

| Case | Handling |
|------|----------|
| Tab closed externally | Extension's `tabs.onRemoved` fires → could propagate via result metadata on next tool call. Acceptable: orphaned entries are harmless (just waste a map entry). |
| Multiple tabs at same URL | `findByUrl` returns first match. Agent should use the URL returned by `safari_new_tab` which may include unique params. Not a new problem — same behavior as today. |
| URL set overflow (>20 URLs) | Drop oldest URL from set. Extremely rare in practice. |
| Race: tab created by AppleScript, extension hasn't seen it yet | `tabs.onCreated` listener fires asynchronously. Server waits 100ms after `safari_new_tab` before the next call anyway (page load time). If extension hasn't registered it yet, the result won't include `executedInTabId` — store URL-only (graceful degradation). |
| `history.pushState` (invisible to `tabs.onUpdated`) | Extension cache is stale for SPA routing. First call with SPA URL fails fast path. Fallback: extension checks `tab.url` live (not cache) via `browser.tabs.get(tabId)`. This is synchronous within the extension context. |

## Acceptance Criteria

1. `test/e2e/interaction-tools.test.ts` — all 3 tests pass (click→navigate→fill→evaluate)
2. `test/e2e/security-enforcement.test.ts` — all 4 tests pass (including navigation tracking)
3. `test/e2e/security-pipeline.test.ts` — TabOwnership rejection test still works for genuinely non-owned URLs
4. No regression in the 1444 unit tests
5. No regression in the 88 currently-passing e2e tests

## Non-Goals

- Fixing AppleScript-only ownership (no stable identity available — URL matching is the only option)
- Tab closure propagation to server (orphaned entries are harmless)
- Supporting multiple tabs at the same URL (use unique query params)
- SPA deep-link detection without extension (impossible without stable tab identity)

## Performance Impact

| Path | Before | After |
|------|--------|-------|
| URL matches (common case) | ~0ms (Map.get) | ~0ms (Set.has per owned tab — typically 1-3 tabs) |
| URL doesn't match, extension available | throws immediately | ~100ms (one IPC to extension, then cached) |
| URL doesn't match, extension unavailable | throws immediately | throws immediately (same) |

The 100ms penalty happens ONCE per URL change per tab. After that, the URL is in the set and all subsequent calls are instant.
