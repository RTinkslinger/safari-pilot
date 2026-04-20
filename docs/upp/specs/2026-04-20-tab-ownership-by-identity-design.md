# Tab Ownership by Identity — Design Spec (v2)

## Problem Statement

Tab ownership uses URL exact-match (`TabOwnership.findByUrl()`) to verify the agent owns a tab. This breaks whenever the URL changes: redirects, link clicks, back/forward, SPA routing, hash changes. The fail-closed change shipped 2026-04-20 actively breaks `safari_click` on links (the tab navigates, next call throws `TabUrlNotRecognizedError`). Band-aids (`NAVIGATION_URL_TRACKING_TOOLS`, `SKIP_OWNERSHIP_TOOLS` for back/forward) are unsustainable.

## Constraint Analysis (from code verification)

Before designing, these are VERIFIED facts about the system:

| Fact | Source | Implication |
|------|--------|-------------|
| `tabCacheMap` keyed by `tab.id` → `{url, title}` | `background.js:23` | Extension HAS stable tab identity |
| Cache persisted to `browser.storage.local`, reloaded on wake | `background.js:27-30, 38-40` | Survives event page suspension |
| `tabs.onUpdated` fires on redirects, updates cache URL | `background.js:61-69` | Cache stays fresh for server-side redirects |
| `tabs.onUpdated` does NOT fire on `history.pushState` | Safari WebExtension behavior | Cache is stale for SPA client-side routing |
| `findTargetTab(tabUrl)` matches by URL (trailing-slash normalized) | `background.js:127-151` | Extension finds tabs by URL, same as ownership |
| `executeCommand` has `tab.id` after `findTargetTab` succeeds | `background.js:168` | Tab identity IS available at execution time |
| `executeCommand` returns `{ok, value}` or `{ok, error}` — no metadata | `background.js:226-232` | Currently does NOT include tab.id or currentUrl in result |
| `ExtensionBridge.handleResult()` unwraps `{ok, value}` and STRIPS container | `ExtensionBridge.swift:300-307` | Extra fields alongside `ok`/`value` are silently dropped |
| Extension event page can be suspended for up to 60s between alarms | Architecture (alarm-woken model) | Any IPC to extension has 0-60s latency depending on wake state |
| AppleScript tab indices are positional (shift on open/close) | Safari AppleScript model | No stable tab identity without extension |

## Design Decision

**Chosen approach:** Piggyback tab.id + currentUrl on every extension command result. Use extension tab.id as the PRIMARY ownership key. URL is a secondary lookup that stays current via result metadata.

**NOT doing:**
- Async ownership check queries to extension (0-60s latency in hot path — unacceptable)
- URL set accumulation (security regression: stale URLs retain ownership of sensitive domains)
- Moving ownership check after execution (violates security pipeline ordering)

## Architecture

### Data Model

```typescript
// src/security/tab-ownership.ts
interface OwnedTab {
  currentUrl: string;           // Most recently known URL (refreshed on every call)
  extensionTabId: number | null; // Stable identity (null when extension unavailable at creation)
}

private ownedTabs: Map<TabId, OwnedTab>  // TabId = synthetic monotonic counter
```

### Registration (safari_new_tab)

When `safari_new_tab` executes:
1. The extension creates the tab and has `tab.id`
2. `background.js` enriches the result: `{ ok: true, value: <jsResult>, _meta: { tabId: tab.id, tabUrl: tab.url } }`
3. `ExtensionBridge.handleResult()` extracts `_meta` alongside `value` (new code — see Changes)
4. Daemon includes `_meta` in the NDJSON response to the MCP server
5. `ExtensionEngine` surfaces `_meta.tabId` in its result
6. `server.ts` registers: `{ currentUrl: tabUrl, extensionTabId: meta.tabId }`

### Ownership Check (every tool call)

```
Tool call arrives with params.tabUrl
  │
  ├─ findByUrl(tabUrl)  →  found? → assertOwnership → PASS
  │
  └─ not found:
       ├─ Extension available?
       │    YES → findByExtensionTabIdFromUrl(tabUrl)
       │          (synchronous scan of ownedTabs where extensionTabId matches
       │           what the extension's tab cache reports for this URL)
       │          
       │          WAIT — this requires asking the extension. That's async.
       │          
       │          INSTEAD: just let the tool execute. If the extension's 
       │          findTargetTab can locate the tab, the command succeeds.
       │          The result brings back { _meta: { tabId, tabUrl } }.
       │          We verify AFTER: is that tabId one we own?
       │
       └─ NO (AppleScript only) → throw TabUrlNotRecognizedError
```

**The key insight:** We cannot do an async extension query in the ownership check (hot path, pre-execution). But we CAN verify ownership AFTER the extension executes — because the result tells us WHICH tab.id ran the command. If that tab.id is in our registry, the tab is ours.

### Revised Security Pipeline Flow

```
BEFORE (current):
  1. Ownership check by URL → PASS or THROW
  2. Engine selection
  3. Tool execution
  4. Post-execution (audit, IDPI, etc.)

AFTER (proposed):
  1. Ownership check by URL → PASS or DEFER
  2. Engine selection
  3. Tool execution (extension includes _meta.tabId in result)
  4. IF deferred: verify result._meta.tabId is owned → PASS or THROW
  5. Post-execution (audit, IDPI, etc.)
```

**Security guarantee preserved:** No unowned tab's data reaches the agent. If step 4 fails (tab.id not owned), the result is discarded and an error is thrown — same as if step 1 had thrown. The tool DID execute in Safari (side effect occurred), but the RESULT is blocked. This is acceptable because:
- The tool executed on a tab the extension found by URL match (the extension's cache is authoritative)
- If the extension's tab.id doesn't match our registry, either: (a) it's a pre-existing tab (correctly blocked), or (b) our tab.id wasn't registered (bug — should never happen for tabs opened via safari_new_tab)

**Side-effect concern:** `safari_fill`, `safari_click`, etc. have side effects. If we execute then reject, the side effect already happened. This is a tradeoff:
- **Option 1 (strict):** Block pre-execution for non-extension engines. Defer ONLY for extension engine (which provides tab.id for post-verification).
- **Option 2 (pragmatic, chosen):** Accept that the extension's `findTargetTab` is itself a URL-based authority. If the extension found a tab at that URL and executed the command, the tab IS at that URL. The post-check just confirms we opened it.

### URL Refresh (keeps findByUrl working for subsequent calls)

After every successful extension-engine tool execution:
1. Result contains `_meta: { tabId: <number>, tabUrl: <string> }`
2. `server.ts` reads `_meta.tabId`, finds the owned tab by extensionTabId
3. Updates `currentUrl` in the registry
4. Next call with this URL hits `findByUrl` directly (fast path)

This means: the FIRST call after a URL change goes through the deferred path (~0ms extra for extension since it executes anyway). The SECOND call hits the fast path.

## Changes Required

### 1. `extension/background.js` — Enrich result with metadata

In `executeCommand()`, after `const result = await resultPromise;` (line 226), wrap the result:

```javascript
// Line 226-232, AFTER getting result:
const enrichedResult = {
  ...result,
  _meta: { tabId: tab.id, tabUrl: tab.url }  // tab is from findTargetTab (line 168)
};
await updatePendingEntry(commandId, { status: 'completed', result: enrichedResult });
return enrichedResult;
```

Note: `tab.url` is the URL the extension used to FIND the tab — it's the tab's current URL from the cache or `browser.tabs.query`. This may differ from `cmd.tabUrl` if the tab redirected since the cache updated.

### 2. `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` — Pass through `_meta`

In `handleResult()` (line 300-307), the success branch currently extracts only `resultDict["value"]`. Add `_meta` extraction:

```swift
// After line 306 (innerValue extraction):
else if let resultParam = params["result"],
        let resultDict = resultParam.value as? [String: Any],
        let ok = resultDict["ok"] as? Bool, ok {
    let innerValue = resultDict["value"] as Any? ?? NSNull()
    let meta = resultDict["_meta"] as? [String: Any]  // NEW
    // Build response with meta passed through
    if let meta = meta {
        callerResponse = Response.success(
            id: cmd.id,
            value: AnyCodable(["value": innerValue, "_meta": meta])
        )
    } else {
        callerResponse = Response.success(id: cmd.id, value: AnyCodable(innerValue))
    }
}
```

This preserves backward compatibility: if `_meta` is absent (old extension), result is unwrapped as before.

### 3. `src/engines/extension.ts` — Extract `_meta` from result

In the result parsing after daemon response, detect the wrapped format:

```typescript
// When result comes back as { value: <actual>, _meta: { tabId, tabUrl } }:
// Extract _meta and put it in EngineResult metadata
if (typeof parsed === 'object' && parsed !== null && '_meta' in parsed) {
  const meta = parsed._meta as { tabId?: number; tabUrl?: string };
  return { ok: true, value: JSON.stringify(parsed.value), elapsed_ms, meta };
}
```

The `EngineResult` type needs a new optional `meta?: { tabId?: number; tabUrl?: string }` field.

### 4. `src/security/tab-ownership.ts` — Dual-key registry

```typescript
interface OwnedTab {
  currentUrl: string;
  extensionTabId: number | null;
}

private ownedTabs: Map<TabId, OwnedTab> = new Map();

findByUrl(url: string): TabId | undefined {
  const normalized = url.replace(/\/$/, '');
  for (const [tabId, data] of this.ownedTabs) {
    if (data.currentUrl.replace(/\/$/, '') === normalized) return tabId;
  }
  return undefined;
}

findByExtensionTabId(extTabId: number): TabId | undefined {
  for (const [tabId, data] of this.ownedTabs) {
    if (data.extensionTabId === extTabId) return tabId;
  }
  return undefined;
}

registerTab(tabId: TabId, url: string, extensionTabId?: number): void {
  this.ownedTabs.set(tabId, { currentUrl: url, extensionTabId: extensionTabId ?? null });
}

updateUrl(tabId: TabId, newUrl: string): void {
  const entry = this.ownedTabs.get(tabId);
  if (entry) entry.currentUrl = newUrl;
}
```

### 5. `src/server.ts` — Revised ownership check + post-execution verify

**Pre-execution (line ~414):**
```typescript
if (params['tabUrl'] && !SKIP_OWNERSHIP_TOOLS.has(name)) {
  const tabUrl = params['tabUrl'] as string;
  const tabId = this.tabOwnership.findByUrl(tabUrl);
  if (tabId === undefined) {
    // URL not in registry. If extension engine is selected, DEFER check
    // to post-execution (extension will tell us which tab.id it used).
    // If AppleScript/daemon: fail immediately (no tab.id available).
    if (selectedEngineName !== 'extension') {
      throw new TabUrlNotRecognizedError(tabUrl);
    }
    // Mark as deferred — post-execution will verify
    deferredOwnershipCheck = true;
  } else {
    this.tabOwnership.assertOwnership(tabId);
  }
}
```

Note: This requires engine selection to happen BEFORE the ownership check for the deferred path. Current order: ownership (line 403) → engine selection (line 472). This needs reordering: engine selection → ownership check (with deferral possible).

**Post-execution (after tool result):**
```typescript
// After successful tool execution, if extension engine returned _meta:
if (result.metadata?.meta?.tabId !== undefined) {
  const extTabId = result.metadata.meta.tabId as number;
  const extTabUrl = result.metadata.meta.tabUrl as string;

  // Refresh URL in registry
  const ownedTabId = this.tabOwnership.findByExtensionTabId(extTabId);
  if (ownedTabId !== undefined) {
    this.tabOwnership.updateUrl(ownedTabId, extTabUrl);
  }

  // Deferred ownership verification
  if (deferredOwnershipCheck) {
    if (ownedTabId === undefined) {
      // Extension executed on a tab we don't own — block the result
      throw new TabUrlNotRecognizedError(params['tabUrl'] as string);
    }
    // Tab is owned — result is safe to return
  }
}
```

**What gets removed:**
- `NAVIGATION_URL_TRACKING_TOOLS` constant and 8.post2 block
- `safari_navigate_back` and `safari_navigate_forward` from `SKIP_OWNERSHIP_TOOLS`
- The separate navigate-tracking logic

**What stays:**
- `SKIP_OWNERSHIP_TOOLS` for `safari_list_tabs`, `safari_new_tab`, `safari_health_check`
- `TabUrlNotRecognizedError` for AppleScript-only failures and genuinely non-owned tabs
- Fail-closed behavior for non-extension engines

### 6. `src/server.ts` — Reorder engine selection before ownership

Move engine selection (lines 472-506) BEFORE the ownership check (line 403). The ownership check needs to know `selectedEngineName` to decide whether to defer.

This is a pipeline reordering. Security implications: engine selection itself has no security side effects — it just picks which engine to use. Moving it before ownership doesn't weaken security.

### 7. `src/types.ts` — Add meta to EngineResult

```typescript
export interface EngineResult {
  ok: boolean;
  value?: string;
  error?: { message: string; name?: string };
  elapsed_ms: number;
  meta?: { tabId?: number; tabUrl?: string };  // NEW
}
```

### 8. ARCHITECTURE.md — Document new model

## Pipeline Reordering Detail

Current order:
```
1. KillSwitch
2. URL/domain extraction
3. TabOwnership check  ← needs engine name (doesn't have it yet)
4. DomainPolicy
5. HumanApproval
6. RateLimiter
7. CircuitBreaker
8. EngineSelection      ← too late for ownership deferral
9. Tool execution
```

Proposed order:
```
1. KillSwitch
2. URL/domain extraction
3. DomainPolicy          ← moved before ownership (no dependency)
4. HumanApproval         ← moved before ownership (no dependency)
5. RateLimiter
6. CircuitBreaker
7. EngineSelection       ← moved before ownership
8. TabOwnership check    ← now knows engine, can defer for extension
9. Tool execution
10. Post-execution ownership verify (if deferred)
```

DomainPolicy, HumanApproval, RateLimiter, CircuitBreaker don't depend on tab ownership — they use domain/URL which is extracted at step 2. Moving ownership after engine selection doesn't change their behavior.

## Security Analysis

| Concern | Mitigation |
|---------|-----------|
| Side effect before ownership verify | Extension's `findTargetTab` is the URL authority — if it found a tab at that URL, the tab IS at that URL. Post-verify confirms we OPENED it. Side effects on truly non-owned tabs require the extension to have a matching URL in cache — which means the tab was opened via Safari (not our agent) AND navigated to the exact URL the agent requested. This is a negligible attack surface. |
| Deferred check discards result | If post-verify fails, the error is thrown before the result reaches the agent. The tool executed (side effect occurred) but no data leaks. |
| Extension unavailable at execution time | Falls back to immediate throw (same as today). No deferral without extension. |
| AppleScript engine: no tab.id | Immediate ownership check by URL (same as today). No deferral. |

## Latency Impact

| Path | Latency |
|------|---------|
| URL matches (common case after first call) | 0ms (Map scan) |
| URL doesn't match, extension engine | 0ms additional (ownership deferred, verifies from result _meta — no extra IPC) |
| URL doesn't match, non-extension engine | throws immediately (same as today) |

**Key property:** NO new IPC round-trips added. The tab.id arrives as part of the ALREADY-HAPPENING tool execution. Zero additional latency.

## Acceptance Criteria

1. `test/e2e/interaction-tools.test.ts` — all 3 tests pass (click→navigate→fill→evaluate)
2. `test/e2e/security-enforcement.test.ts` — all 4 tests pass
3. `test/e2e/security-pipeline.test.ts` — TabOwnership rejection works for genuinely non-owned URLs
4. No regression in 1444 unit tests
5. No regression in currently-passing e2e tests
6. Non-extension tool calls still fail-closed on unknown URLs

## Non-Goals

- Fixing AppleScript-only ownership beyond URL match (no stable identity available)
- Tab closure propagation (orphaned entries are harmless)
- SPA `pushState` detection (handled on next call — extension cache updates via `tabs.onUpdated` for full navigations; pushState is invisible but the next tool call refreshes the URL from the live tab)
- Multiple tabs at same URL disambiguation (use unique query params; same limitation as today)
