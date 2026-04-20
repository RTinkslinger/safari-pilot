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

**IMPORTANT:** `safari_new_tab` uses `AppleScriptEngine` directly (NavigationTools is constructed with AppleScriptEngine, not the EngineProxy). It does NOT route through the extension. Therefore, background.js never sees tab creation and cannot enrich the result with `tab.id`.

**Registration is URL-only initially:**
1. `safari_new_tab` executes via AppleScript → returns URL
2. `server.ts` registers: `{ currentUrl: tabUrl, extensionTabId: null }`

**extensionTabId is backfilled on FIRST extension-engine tool call:**
1. Agent calls any tool (e.g., `safari_get_text`) on the new tab
2. Extension engine routes through `background.js` → `findTargetTab(tabUrl)` finds the tab (it appeared in `tabCacheMap` via `tabs.onCreated` listener after the AppleScript created it)
3. `background.js` executes the command, returns result with `_meta: { tabId: tab.id, tabUrl: tab.url }`
4. Server receives `_meta.tabId`, finds the owned tab by URL (URL still matches at this point — no redirect yet), stores `extensionTabId`
5. From this point forward, the dual-key lookup works

**Why this is safe:** The FIRST tool call after `safari_new_tab` uses the SAME URL that was just registered. `findByUrl` succeeds on the fast path. The backfill piggybacks on this first call. The deferred ownership path only activates AFTER the URL has drifted — by which point `extensionTabId` is already backfilled.

### Ownership Check (every tool call)

```
Tool call arrives with params.tabUrl
  │
  ├─ findByUrl(tabUrl)  →  found? → assertOwnership → PASS
  │
  └─ not found:
       │
       ├─ Domain check: does tabUrl's hostname match ANY owned tab's hostname?
       │    NO  → throw TabUrlNotRecognizedError immediately (DoS protection)
       │
       ├─ Extension engine selected?
       │    YES → DEFER to post-execution
       │          (extension's findTargetTab has a fresher cache via tabs.onUpdated
       │           which fires on server-side redirects. The server's URL only updates
       │           from extension result metadata — so on first call after redirect,
       │           the extension IS fresher.)
       │          Tool executes. Result includes _meta.tabId.
       │          Post-verify: is that tabId owned? YES → pass. NO → throw + discard result.
       │
       └─ NO (AppleScript/daemon engine) → throw TabUrlNotRecognizedError
```

**DoS mitigation (domain check):** Before deferring, verify the URL's registrable domain (eTLD+1) matches at least one owned tab's registrable domain. Use hostname comparison with subdomain stripping: extract the last two segments (or last three for known two-part TLDs like `.co.uk`). For simplicity, compare the last two dot-separated segments of the hostname (e.g., `auth.example.com` → `example.com`, `app.example.com` → `example.com` — these match).

This catches the attack scenario (random URLs to non-owned tabs) while allowing legitimate scenarios (OAuth flows: `app.example.com` → `auth.example.com`, CDN subdomains, API subdomains).

**Known limitation:** Two-part TLDs (`.co.uk`, `.com.au`) would incorrectly match `evil.co.uk` against `bank.co.uk`. Acceptable for v1 — the primary threat model is cross-DOMAIN attacks, not cross-subdomain within the same TLD.

**Why extension is fresher than server:** The extension's `tabCacheMap` updates via `tabs.onUpdated` which fires immediately on server-side redirects. The server's `currentUrl` field only updates from extension result `_meta` — meaning it's one call behind the extension. On the FIRST call after a redirect, the extension has the new URL (from `onUpdated`) but the server doesn't (hasn't received a result yet). This is the precise window where deferral is valuable.

**The key insight:** We cannot do an async extension query in the ownership check (hot path, pre-execution). But we CAN verify ownership AFTER the extension executes — because the result tells us WHICH tab.id ran the command. If that tab.id is in our registry, the tab is ours.

### Revised Security Pipeline Flow

```
BEFORE (current):
  1. KillSwitch
  2. URL/domain extraction
  3. TabOwnership check by URL → PASS or THROW
  4. DomainPolicy, HumanApproval, RateLimiter, CircuitBreaker
  5. Engine selection
  6. Tool execution
  7. Post-execution (audit, IDPI, etc.)

AFTER (proposed):
  1. KillSwitch
  2. URL/domain extraction
  3. DomainPolicy, HumanApproval, RateLimiter, CircuitBreaker
  4. Engine selection
  5. TabOwnership check by URL → PASS or DEFER (uses selectedEngineName)
  6. Tool execution (extension includes _meta in result)
  7. IF deferred: verify _meta.tabId is owned → PASS or THROW (discard result)
  8. Post-execution (audit, IDPI, etc.)
```

**Security guarantee preserved:** No unowned tab's data reaches the agent. If step 4 fails (tab.id not owned), the result is discarded and an error is thrown — same as if step 1 had thrown. The tool DID execute in Safari (side effect occurred), but the RESULT is blocked. This is acceptable because:
- The tool executed on a tab the extension found by URL match (the extension's cache is authoritative)
- If the extension's tab.id doesn't match our registry, either: (a) it's a pre-existing tab (correctly blocked), or (b) our tab.id wasn't registered (bug — should never happen for tabs opened via safari_new_tab)

**Side-effect concern:** `safari_fill`, `safari_click`, etc. have side effects. If we execute then reject, the side effect already happened. This is a tradeoff:
- **Option 1 (strict):** Block pre-execution for non-extension engines. Defer ONLY for extension engine (which provides tab.id for post-verification).
- **Option 2 (pragmatic, chosen):** Accept that the extension's `findTargetTab` is itself a URL-based authority. If the extension found a tab at that URL and executed the command, the tab IS at that URL. The post-check just confirms we opened it.
- **Domain-check mitigation:** The DoS/side-effect risk is bounded by the pre-deferral domain check. An attacker cannot trigger side effects on a domain the agent never opened a tab on.

### Error Paths

| Scenario | Behavior |
|----------|----------|
| Tool executes successfully, post-verify passes | Normal flow — result returned to agent |
| Tool executes successfully, post-verify FAILS (tab.id not owned) | Result DISCARDED, `TabUrlNotRecognizedError` thrown. Side effect occurred but data doesn't leak. |
| Tool THROWS (handler error, timeout, network failure) | Post-verify is SKIPPED. Tool error propagates normally. No data leaked (tool failed). `deferredOwnershipCheck` is irrelevant — nothing to verify. |
| Extension returns result WITHOUT `_meta` (old extension, or extension crashed mid-execution) | If `deferredOwnershipCheck` is true and no `_meta` in result: throw `TabUrlNotRecognizedError`. Cannot confirm ownership without tab.id. |
| `EngineUnavailableError` during engine selection | Ownership check never runs (engine selection is before ownership in proposed order). Error returned to agent. No tool executes. Safe. |

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

**Complete _meta propagation path (end-to-end):**

```
background.js executeCommand()
  returns: { ok: true, value: "jsResult", _meta: { tabId: 42, tabUrl: "https://..." } }
       ↓ (via HTTP POST /result → ExtensionBridge.handleResult)
ExtensionBridge.swift
  extracts _meta, wraps: Response.success(value: AnyCodable(["value": innerValue, "_meta": meta]))
       ↓ (NDJSON stdout from daemon)
DaemonEngine.execute() / tryTcpConnection()
  parses NDJSON response: { id, ok: true, value: {"value": "jsResult", "_meta": {...}} }
  returns EngineResult: { ok: true, value: '{"value":"jsResult","_meta":{...}}', elapsed_ms }
       ↓
ExtensionEngine.executeJsInTab()
  receives EngineResult from DaemonEngine
  PARSES result.value as JSON
  DETECTS the wrapper: if parsed has "_meta" key → extract separately
  returns: { ok: true, value: JSON.stringify(parsed.value), elapsed_ms, meta: parsed._meta }
       ↓
server.ts callTool() → tool handler (receives EngineResult via proxy)
  tool handler builds ToolResponse: { content: [...], metadata: { engine, ... } }
       ↓
server.ts executeToolWithSecurity() receives ToolResponse
  READS meta FROM the EngineResult (not from ToolResponse.metadata)
```

**The key detail:** `meta` lives on the `EngineResult` returned by `ExtensionEngine`, NOT inside `ToolResponse.metadata` (which is set by the tool handler). The server must read it from the engine result directly. This means the `callTool()` method (or the EngineProxy) must expose the engine's `meta` field alongside the tool's response.

**Implementation in ExtensionEngine (exact location):**

In `src/engines/extension.ts`, in `executeJsInTab()`, after receiving the result from `DaemonEngine.execute()`:

```typescript
// Current: returns the daemon result directly
// NEW: parse value, detect wrapper, extract _meta

const daemonResult = await this.daemonEngine.execute(sentinel, timeout);
if (!daemonResult.ok) return daemonResult;

// Check if the value is a _meta wrapper from the bridge
try {
  const parsed = JSON.parse(daemonResult.value ?? '');
  if (typeof parsed === 'object' && parsed !== null && '_meta' in parsed) {
    return {
      ok: true,
      value: typeof parsed.value === 'string' ? parsed.value : JSON.stringify(parsed.value),
      elapsed_ms: daemonResult.elapsed_ms,
      meta: parsed._meta as { tabId?: number; tabUrl?: string },
    };
  }
} catch { /* not JSON or not wrapped — fall through */ }

return daemonResult;
```

**Server-side access:** `server.ts` needs access to `EngineResult.meta` AFTER tool execution. Currently `callTool()` returns `ToolResponse` (from the handler), losing the engine result. The fix: the EngineProxy stores the last result's `meta` field, and the server reads it after `callTool()`:

```typescript
// In server.ts, after const result = await this.callTool(name, params):
const engineMeta = this.engineProxy?.getLastMeta();  // { tabId?, tabUrl? } or undefined
```

This requires adding `getLastMeta()` to EngineProxy that returns the `meta` from the most recent `executeJsInTab` call.

The `EngineResult` type needs a new optional field:
```typescript
meta?: { tabId?: number; tabUrl?: string };
```

**DaemonEngine NDJSON handling (verified at `daemon.ts:179`):** When the Swift bridge returns `value` as a JSON object (the `{"value": innerValue, "_meta": {...}}` wrapper), DaemonEngine handles it via the existing branch: `typeof response.value === 'object' ? JSON.stringify(response.value)`. This produces a stringified wrapper that ExtensionEngine can `JSON.parse` and detect. **No DaemonEngine changes needed** — the middle link already works.
```

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

setExtensionTabId(tabId: TabId, extTabId: number): void {
  const entry = this.ownedTabs.get(tabId);
  if (entry && entry.extensionTabId === null) {
    entry.extensionTabId = extTabId;
  }
}

domainMatches(url: string): boolean {
  // Extract registrable domain (last 2 segments of hostname)
  try {
    const target = new URL(url).hostname.split('.').slice(-2).join('.');
    for (const [, data] of this.ownedTabs) {
      const owned = new URL(data.currentUrl).hostname.split('.').slice(-2).join('.');
      if (owned === target) return true;
    }
  } catch { /* malformed URL */ }
  return false;
}
```

### 4b. `src/engines/engine-proxy.ts` — Add getLastMeta() with reset

**Assumption:** MCP stdio transport is sequential (one request at a time). `_lastMeta` relies on this — if MCP ever adds batched/concurrent execution, replace with a per-request correlation mechanism (e.g., pass a request ID through the engine call and return meta keyed by it).

```typescript
private _lastMeta: { tabId?: number; tabUrl?: string } | undefined;

// Reset at start of each tool call to prevent stale reads from tools
// that use execute() instead of executeJsInTab() (e.g., navigation tools
// that run AppleScript directly).
resetMeta(): void {
  this._lastMeta = undefined;
}

async executeJsInTab(tabUrl: string, jsCode: string, timeout?: number): Promise<EngineResult> {
  // Note: method becomes async (was passthrough return) to capture meta
  const result = await this.delegate.executeJsInTab(tabUrl, jsCode, timeout);
  this._lastMeta = result.meta;
  return result;
}

getLastMeta(): { tabId?: number; tabUrl?: string } | undefined {
  return this._lastMeta;
}
```

**Server.ts must call `this.engineProxy.resetMeta()` at the start of `executeToolWithSecurity()` before any tool execution.** This prevents a stale `_lastMeta` from a previous call being misread if the current tool doesn't go through `executeJsInTab`.

### 5. `src/server.ts` — Revised ownership check + post-execution verify

**Pre-execution (after engine selection, before tool execution):**
```typescript
// Declare at top of executeToolWithSecurity:
let deferredOwnershipCheck = false;

// Reset engine meta to prevent stale reads from previous calls:
this.engineProxy?.resetMeta();

// ... (killswitch, domain policy, human approval, rate limiter, circuit breaker, engine selection above) ...

// Ownership check (now has selectedEngineName available):
if (params['tabUrl'] && !SKIP_OWNERSHIP_TOOLS.has(name)) {
  const tabUrl = params['tabUrl'] as string;
  const tabId = this.tabOwnership.findByUrl(tabUrl);
  if (tabId === undefined) {
    // URL not in registry. If extension engine selected AND domain matches
    // an owned tab, DEFER to post-execution. Otherwise fail immediately.
    if (selectedEngineName === 'extension' && this.tabOwnership.domainMatches(tabUrl)) {
      deferredOwnershipCheck = true;
    } else {
      throw new TabUrlNotRecognizedError(tabUrl);
    }
  } else {
    this.tabOwnership.assertOwnership(tabId);
  }
}
```

Note: This requires engine selection to happen BEFORE the ownership check for the deferred path. Current order: ownership (line 403) → engine selection (line 472). This needs reordering: engine selection → ownership check (with deferral possible).

**Post-execution (after tool result):**
```typescript
// After successful tool execution, read engine meta from the proxy:
const engineMeta = this.engineProxy?.getLastMeta(); // { tabId?, tabUrl? } | undefined

if (engineMeta?.tabId !== undefined) {
  const extTabId = engineMeta.tabId;
  const extTabUrl = engineMeta.tabUrl;

  // Backfill extensionTabId if this is the first extension call for this tab
  const ownedByUrl = this.tabOwnership.findByUrl(params['tabUrl'] as string);
  if (ownedByUrl !== undefined) {
    this.tabOwnership.setExtensionTabId(ownedByUrl, extTabId);
  }

  // Refresh URL in registry (keeps findByUrl working for next call)
  const ownedTabId = this.tabOwnership.findByExtensionTabId(extTabId);
  if (ownedTabId !== undefined && extTabUrl) {
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
- SPA `pushState` detection — `pushState` does NOT fire `tabs.onUpdated`. The FIRST call after a pushState route change will fail (extension's `findTargetTab` also uses the stale URL and won't find the tab). The SECOND call succeeds IF the first call somehow refreshed the URL. In practice: SPA routing breaks the first tool call after route change. This is a known limitation requiring either (a) extension content script detecting pushState and reporting URL changes, or (b) the agent using `safari_evaluate` with `return location.href` to discover the current URL before other calls. Deferred to future work.
- Multiple tabs at same URL disambiguation (use unique query params; same limitation as today)
