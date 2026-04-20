# Tab Ownership by Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill when implementing this plan. Each task has exact code diffs, verification commands, and commit messages. Execute sequentially — tasks depend on prior completions.

**Goal:** Replace URL-based tab ownership with extension tab.id identity — tabs stay owned regardless of URL changes (redirects, clicks, back/forward).

**Architecture:** Piggyback tab.id + currentUrl on every extension command result. Deferred ownership verification for extension engine (post-execution). Pipeline reordering: engine selection before ownership check.

**Tech Stack:** TypeScript, Swift, JavaScript (Safari Web Extension)

**Branch:** `feat/tab-ownership-by-identity` (from main)

---

## Task 0: Branch + Baseline

**Depends on:** nothing

### Steps

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
git checkout -b feat/tab-ownership-by-identity main
npm run build
npm run test:unit
```

### Verify

- Build completes with exit 0
- Unit tests pass (1428+ tests)
- No uncommitted changes

### Commit

No commit — baseline verification only.

---

## Task 1: Add `meta` Field to EngineResult Type

**Depends on:** Task 0

### File: `src/types.ts` (lines 33-38)

### OLD (lines 33-38)

```typescript
export interface EngineResult {
  ok: boolean;
  value?: string;
  error?: EngineError;
  elapsed_ms: number;
}
```

### NEW

```typescript
export interface EngineResult {
  ok: boolean;
  value?: string;
  error?: EngineError;
  elapsed_ms: number;
  meta?: { tabId?: number; tabUrl?: string };
}
```

### Verify

```bash
npm run lint  # tsc --noEmit — verifies no type errors introduced
```

### Commit

```
feat(types): add meta field to EngineResult for tab identity propagation

Extension engine will populate meta.tabId and meta.tabUrl from background.js
results, enabling stable tab identity tracking through URL changes.
```

---

## Task 2: Rewrite `src/security/tab-ownership.ts`

**Depends on:** Task 1 (uses TabId type which is unchanged, but conceptually after types are set)

### File: `src/security/tab-ownership.ts`

### OLD (entire file, lines 1-103)

```typescript
import type { TabId } from '../types.js';
import { TabNotOwnedError } from '../errors.js';

// ─── TabOwnership ─────────────────────────────────────────────────────────────
//
// Tracks which tabs the agent opened vs. tabs that already existed when the
// session started. Only agent-owned tabs may be interacted with.

export class TabOwnership {
  private ownedTabs: Map<TabId, string> = new Map(); // tabId -> url
  private preExistingTabs: Set<TabId> = new Set();

  // ── Static helpers ──────────────────────────────────────────────────────────

  /**
   * Compute a numeric TabId from Safari's 1-based window/tab indices.
   * Formula: windowIndex * 1000 + tabIndex
   */
  static makeTabId(windowIndex: number, tabIndex: number): TabId {
    return windowIndex * 1000 + tabIndex;
  }

  // ── Session initialisation ──────────────────────────────────────────────────

  /**
   * Record a tab that existed before this agent session started.
   * Pre-existing tabs are NOT agent-owned and cannot be interacted with.
   */
  recordPreExisting(tabId: TabId): void {
    this.preExistingTabs.add(tabId);
  }

  // ── Ownership lifecycle ─────────────────────────────────────────────────────

  /**
   * Register a tab as agent-opened. Call this immediately after open_tab.
   */
  registerTab(tabId: TabId, url: string): void {
    this.ownedTabs.set(tabId, url);
  }

  /**
   * Remove a tab from the registry when it is closed.
   */
  removeTab(tabId: TabId): void {
    this.ownedTabs.delete(tabId);
  }

  /**
   * Update the tracked URL for an owned tab after navigation.
   * No-op if the tab is not owned (avoids silently adopting foreign tabs).
   */
  updateUrl(tabId: TabId, newUrl: string): void {
    if (this.ownedTabs.has(tabId)) {
      this.ownedTabs.set(tabId, newUrl);
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  isOwned(tabId: TabId): boolean {
    return this.ownedTabs.has(tabId);
  }

  isPreExisting(tabId: TabId): boolean {
    return this.preExistingTabs.has(tabId);
  }

  getUrl(tabId: TabId): string | undefined {
    return this.ownedTabs.get(tabId);
  }

  /**
   * Find the TabId for an owned tab by its current URL.
   * Returns undefined if no owned tab matches the URL.
   */
  findByUrl(url: string): TabId | undefined {
    for (const [tabId, tabUrl] of this.ownedTabs) {
      if (tabUrl === url) return tabId;
    }
    return undefined;
  }

  getOwnedCount(): number {
    return this.ownedTabs.size;
  }

  getAllOwned(): Array<{ tabId: TabId; url: string }> {
    return Array.from(this.ownedTabs.entries()).map(([tabId, url]) => ({ tabId, url }));
  }

  // ── Guard ────────────────────────────────────────────────────────────────────

  /**
   * Throws TabNotOwnedError if the tab was not opened by this agent session.
   * Use this as a pre-condition check before every tool that mutates a tab.
   */
  assertOwnership(tabId: TabId): void {
    if (!this.ownedTabs.has(tabId)) {
      throw new TabNotOwnedError(tabId);
    }
  }
}
```

### NEW (complete replacement)

```typescript
import type { TabId } from '../types.js';
import { TabNotOwnedError } from '../errors.js';

// ─── TabOwnership (Identity-Based) ───────────────────────────────────────────
//
// Dual-key registry: tabs are tracked by both their synthetic TabId (positional)
// and their stable extension tab.id. URL is mutable and refreshed on every
// extension-engine result.

interface OwnedTab {
  currentUrl: string;
  extensionTabId: number | null; // null until first extension-engine call backfills it
}

export class TabOwnership {
  private ownedTabs: Map<TabId, OwnedTab> = new Map();
  private preExistingTabs: Set<TabId> = new Set();

  // ── Static helpers ──────────────────────────────────────────────────────────

  /**
   * Compute a numeric TabId from Safari's 1-based window/tab indices.
   * Formula: windowIndex * 1000 + tabIndex
   */
  static makeTabId(windowIndex: number, tabIndex: number): TabId {
    return windowIndex * 1000 + tabIndex;
  }

  // ── Session initialisation ──────────────────────────────────────────────────

  /**
   * Record a tab that existed before this agent session started.
   * Pre-existing tabs are NOT agent-owned and cannot be interacted with.
   */
  recordPreExisting(tabId: TabId): void {
    this.preExistingTabs.add(tabId);
  }

  // ── Ownership lifecycle ─────────────────────────────────────────────────────

  /**
   * Register a tab as agent-opened. Call this immediately after safari_new_tab.
   * extensionTabId is null initially — backfilled on first extension-engine call.
   */
  registerTab(tabId: TabId, url: string, extensionTabId?: number): void {
    this.ownedTabs.set(tabId, {
      currentUrl: url,
      extensionTabId: extensionTabId ?? null,
    });
  }

  /**
   * Remove a tab from the registry when it is closed.
   */
  removeTab(tabId: TabId): void {
    this.ownedTabs.delete(tabId);
  }

  /**
   * Update the tracked URL for an owned tab.
   * No-op if the tab is not owned (avoids silently adopting foreign tabs).
   */
  updateUrl(tabId: TabId, newUrl: string): void {
    const entry = this.ownedTabs.get(tabId);
    if (entry) {
      entry.currentUrl = newUrl;
    }
  }

  /**
   * Backfill the extension tab.id after the first extension-engine call succeeds.
   * Only writes if extensionTabId is currently null (prevents overwrite from stale data).
   */
  setExtensionTabId(tabId: TabId, extTabId: number): void {
    const entry = this.ownedTabs.get(tabId);
    if (entry && entry.extensionTabId === null) {
      entry.extensionTabId = extTabId;
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  isOwned(tabId: TabId): boolean {
    return this.ownedTabs.has(tabId);
  }

  isPreExisting(tabId: TabId): boolean {
    return this.preExistingTabs.has(tabId);
  }

  getUrl(tabId: TabId): string | undefined {
    return this.ownedTabs.get(tabId)?.currentUrl;
  }

  /**
   * Find the TabId for an owned tab by its current URL.
   * Trailing-slash normalized comparison.
   * Returns undefined if no owned tab matches the URL.
   */
  findByUrl(url: string): TabId | undefined {
    const normalized = url.replace(/\/$/, '');
    for (const [tabId, data] of this.ownedTabs) {
      if (data.currentUrl.replace(/\/$/, '') === normalized) return tabId;
    }
    return undefined;
  }

  /**
   * Find the TabId for an owned tab by its extension tab.id (stable identity).
   * Returns undefined if no owned tab has this extensionTabId.
   */
  findByExtensionTabId(extTabId: number): TabId | undefined {
    for (const [tabId, data] of this.ownedTabs) {
      if (data.extensionTabId === extTabId) return tabId;
    }
    return undefined;
  }

  /**
   * Check if the given URL's registrable domain matches any owned tab's domain.
   * Used as a DoS guard before deferring ownership to post-execution.
   * Compares the last two dot-separated segments of the hostname.
   */
  domainMatches(url: string): boolean {
    try {
      const targetHost = new URL(url).hostname;
      const targetDomain = targetHost.split('.').slice(-2).join('.');
      for (const [, data] of this.ownedTabs) {
        const ownedHost = new URL(data.currentUrl).hostname;
        const ownedDomain = ownedHost.split('.').slice(-2).join('.');
        if (ownedDomain === targetDomain) return true;
      }
    } catch { /* malformed URL */ }
    return false;
  }

  getOwnedCount(): number {
    return this.ownedTabs.size;
  }

  getAllOwned(): Array<{ tabId: TabId; url: string }> {
    return Array.from(this.ownedTabs.entries()).map(([tabId, data]) => ({
      tabId,
      url: data.currentUrl,
    }));
  }

  // ── Guard ────────────────────────────────────────────────────────────────────

  /**
   * Throws TabNotOwnedError if the tab was not opened by this agent session.
   * Use this as a pre-condition check before every tool that mutates a tab.
   */
  assertOwnership(tabId: TabId): void {
    if (!this.ownedTabs.has(tabId)) {
      throw new TabNotOwnedError(tabId);
    }
  }
}
```

### Verify

```bash
npm run lint  # type-check — verify interface compat with all consumers
```

### Commit

```
feat(security): rewrite tab-ownership with dual-key identity registry

Replace Map<TabId, string> with Map<TabId, OwnedTab> supporting both URL
lookup and stable extension tab.id identity. Add findByExtensionTabId(),
setExtensionTabId(), domainMatches(). Trailing-slash normalization on
findByUrl(). Backward-compatible public API (registerTab, getUrl, getAllOwned).
```

---

## Task 3: Add `resetMeta()` and `getLastMeta()` to EngineProxy

**Depends on:** Task 1 (EngineResult now has `meta` field)

### File: `src/engines/engine-proxy.ts`

### OLD (entire file, lines 1-42)

```typescript
import type { Engine, EngineResult } from '../types.js';
import type { IEngine } from './engine.js';

/**
 * A proxy engine that delegates to whichever engine is currently selected.
 * Tool modules receive this at construction time. Before each tool call,
 * the server sets the active engine via setDelegate(). This way engine
 * selection actually affects which engine executes the JS, not just metadata.
 */
export class EngineProxy implements IEngine {
  readonly name: Engine = 'applescript';
  private delegate: IEngine;

  constructor(defaultEngine: IEngine) {
    this.delegate = defaultEngine;
  }

  setDelegate(engine: IEngine): void {
    this.delegate = engine;
    (this as { name: Engine }).name = engine.name;
  }

  getDelegate(): IEngine {
    return this.delegate;
  }

  isAvailable(): Promise<boolean> {
    return this.delegate.isAvailable();
  }

  execute(script: string, timeout?: number): Promise<EngineResult> {
    return this.delegate.execute(script, timeout);
  }

  executeJsInTab(tabUrl: string, jsCode: string, timeout?: number): Promise<EngineResult> {
    return this.delegate.executeJsInTab(tabUrl, jsCode, timeout);
  }

  async shutdown(): Promise<void> {
    // Don't shut down the delegate — it's shared
  }
}
```

### NEW (complete replacement)

```typescript
import type { Engine, EngineResult } from '../types.js';
import type { IEngine } from './engine.js';

/**
 * A proxy engine that delegates to whichever engine is currently selected.
 * Tool modules receive this at construction time. Before each tool call,
 * the server sets the active engine via setDelegate(). This way engine
 * selection actually affects which engine executes the JS, not just metadata.
 *
 * Also captures the `meta` field from the most recent executeJsInTab() result,
 * allowing the server to read tab identity after tool execution without
 * requiring changes to the tool handler return type.
 */
export class EngineProxy implements IEngine {
  readonly name: Engine = 'applescript';
  private delegate: IEngine;
  private _lastMeta: { tabId?: number; tabUrl?: string } | undefined;

  constructor(defaultEngine: IEngine) {
    this.delegate = defaultEngine;
  }

  setDelegate(engine: IEngine): void {
    this.delegate = engine;
    (this as { name: Engine }).name = engine.name;
  }

  getDelegate(): IEngine {
    return this.delegate;
  }

  /**
   * Reset meta before each tool call to prevent stale reads from a previous call.
   * Must be called at the start of executeToolWithSecurity().
   */
  resetMeta(): void {
    this._lastMeta = undefined;
  }

  /**
   * Returns the meta from the most recent executeJsInTab() call, or undefined
   * if the last call was execute() or no call has been made since resetMeta().
   */
  getLastMeta(): { tabId?: number; tabUrl?: string } | undefined {
    return this._lastMeta;
  }

  isAvailable(): Promise<boolean> {
    return this.delegate.isAvailable();
  }

  execute(script: string, timeout?: number): Promise<EngineResult> {
    return this.delegate.execute(script, timeout);
  }

  async executeJsInTab(tabUrl: string, jsCode: string, timeout?: number): Promise<EngineResult> {
    const result = await this.delegate.executeJsInTab(tabUrl, jsCode, timeout);
    this._lastMeta = result.meta;
    return result;
  }

  async shutdown(): Promise<void> {
    // Don't shut down the delegate — it's shared
  }
}
```

### Verify

```bash
npm run lint  # type-check
```

### Commit

```
feat(engine-proxy): add resetMeta/getLastMeta for tab identity capture

EngineProxy now captures the meta field from executeJsInTab results and
exposes it via getLastMeta(). resetMeta() prevents stale reads between
tool calls. Server uses this to read extension tab.id after execution.
```

---

## Task 4: Extract `_meta` Wrapper in ExtensionEngine

**Depends on:** Task 1 (EngineResult.meta type must exist)

### File: `src/engines/extension.ts` (lines 74-91, `executeJsInTab`)

### OLD (lines 74-91)

```typescript
  async executeJsInTab(tabUrl: string, jsCode: string, timeout?: number): Promise<EngineResult> {
    const start = Date.now();
    try {
      const payload = JSON.stringify({ script: jsCode, tabUrl });
      const result = await this.daemon.execute(
        `${INTERNAL_PREFIX} extension_execute ${payload}`,
        Math.max(timeout ?? EXTENSION_TIMEOUT_MS, EXTENSION_TIMEOUT_MS),
      );
      return { ...result, elapsed_ms: Date.now() - start };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: { code: 'EXTENSION_ERROR', message, retryable: true },
        elapsed_ms: Date.now() - start,
      };
    }
  }
```

### NEW (replacement for lines 74-91)

```typescript
  async executeJsInTab(tabUrl: string, jsCode: string, timeout?: number): Promise<EngineResult> {
    const start = Date.now();
    try {
      const payload = JSON.stringify({ script: jsCode, tabUrl });
      const daemonResult = await this.daemon.execute(
        `${INTERNAL_PREFIX} extension_execute ${payload}`,
        Math.max(timeout ?? EXTENSION_TIMEOUT_MS, EXTENSION_TIMEOUT_MS),
      );
      const elapsed_ms = Date.now() - start;

      if (!daemonResult.ok) {
        return { ...daemonResult, elapsed_ms };
      }

      // Check if the daemon result contains a _meta wrapper from ExtensionBridge.
      // When present, the value is JSON: {"value": <innerValue>, "_meta": {tabId, tabUrl}}
      // Extract _meta into EngineResult.meta and return the inner value unwrapped.
      try {
        const parsed = JSON.parse(daemonResult.value ?? '');
        if (typeof parsed === 'object' && parsed !== null && '_meta' in parsed) {
          const innerValue = parsed.value;
          const meta = parsed._meta as { tabId?: number; tabUrl?: string };
          return {
            ok: true,
            value: typeof innerValue === 'string'
              ? innerValue
              : innerValue === null || innerValue === undefined
                ? undefined
                : JSON.stringify(innerValue),
            elapsed_ms,
            meta,
          };
        }
      } catch { /* not JSON or not a _meta wrapper — fall through */ }

      return { ...daemonResult, elapsed_ms };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: { code: 'EXTENSION_ERROR', message, retryable: true },
        elapsed_ms: Date.now() - start,
      };
    }
  }
```

### Verify

```bash
npm run lint  # type-check
npx vitest run test/unit/engines/  # if engine unit tests exist
```

### Commit

```
feat(extension-engine): extract _meta wrapper from bridge results

When ExtensionBridge passes through _meta (tabId + tabUrl), the extension
engine now detects the wrapper format, extracts meta into EngineResult.meta,
and unwraps the inner value. Backward-compatible: non-wrapped results pass
through unchanged.
```

---

## Task 5: Modify `extension/background.js` — Enrich Results with `_meta`

**Depends on:** Task 6 (Swift must pass through `_meta`, but can be committed independently since the old Swift code just ignores unknown keys)

### File: `extension/background.js` (lines 226-232 in `executeCommand()`)

### OLD (lines 226-232)

```javascript
  // Step 3: Wait for result
  const result = await resultPromise;

  // Cleanup storage keys (safe — result already captured in `result` variable)
  try { await browser.storage.local.remove(['sp_cmd', 'sp_result']); } catch { /* ignore cleanup errors */ }

  await updatePendingEntry(commandId, { status: 'completed', result });
  return result;
```

### NEW (replacement for lines 226-232)

```javascript
  // Step 3: Wait for result
  const result = await resultPromise;

  // Enrich result with tab identity metadata.
  // `tab` is from findTargetTab (line 168) — has the stable tab.id and current URL.
  // _meta is a sideband channel: ExtensionBridge passes it through alongside the value,
  // and ExtensionEngine extracts it into EngineResult.meta on the TypeScript side.
  const enrichedResult = result && typeof result === 'object'
    ? { ...result, _meta: { tabId: tab.id, tabUrl: tab.url } }
    : result;

  // Cleanup storage keys (safe — result already captured in `result` variable)
  try { await browser.storage.local.remove(['sp_cmd', 'sp_result']); } catch { /* ignore cleanup errors */ }

  await updatePendingEntry(commandId, { status: 'completed', result: enrichedResult });
  return enrichedResult;
```

### Why `tab` is in scope

At line 168: `const tab = await findTargetTab(cmd.tabUrl);`
At line 169: null-check and early return if no tab.
By line 226, `tab` is guaranteed non-null and has `tab.id` (number) and `tab.url` (string).

### Verify

No automated test for extension JS in isolation — verified via e2e in Task 8.

### Commit

```
feat(extension): enrich command results with _meta tab identity

Every successful executeCommand() result now includes _meta.tabId (stable
Safari tab ID) and _meta.tabUrl (tab's current URL at execution time).
This enables the server to track tab identity through URL changes.
```

---

## Task 6: Modify `ExtensionBridge.swift` — Pass Through `_meta`

**Depends on:** nothing (can be done in parallel with Tasks 4-5, but logically in the data flow it's between background.js and ExtensionEngine)

### File: `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` (lines 300-307)

### OLD (lines 300-307)

```swift
        // Unwrap success: background.js sends {result: {ok:true, value:<jsResult>}}
        // Extract the inner value so the caller gets the raw JS result, not the wrapper.
        else if let resultParam = params["result"],
                let resultDict = resultParam.value as? [String: Any],
                let ok = resultDict["ok"] as? Bool, ok {
            // Preserve null/nil faithfully — don't convert to empty string
            let innerValue = resultDict["value"] as Any? ?? NSNull()
            callerResponse = Response.success(id: cmd.id, value: AnyCodable(innerValue))
```

### NEW (replacement for lines 300-307)

```swift
        // Unwrap success: background.js sends {result: {ok:true, value:<jsResult>, _meta:{...}}}
        // Extract the inner value. If _meta is present (tab identity), wrap as
        // {"value": innerValue, "_meta": meta} so ExtensionEngine can extract it.
        // If _meta is absent (old extension), return innerValue directly (backward compat).
        else if let resultParam = params["result"],
                let resultDict = resultParam.value as? [String: Any],
                let ok = resultDict["ok"] as? Bool, ok {
            // Preserve null/nil faithfully — don't convert to empty string
            let innerValue = resultDict["value"] as Any? ?? NSNull()
            if let meta = resultDict["_meta"] as? [String: Any] {
                // Pass through _meta alongside the value in a wrapper object.
                // ExtensionEngine detects this wrapper via the "_meta" key presence.
                callerResponse = Response.success(
                    id: cmd.id,
                    value: AnyCodable(["value": innerValue, "_meta": meta])
                )
            } else {
                callerResponse = Response.success(id: cmd.id, value: AnyCodable(innerValue))
            }
```

### How this flows through DaemonEngine

1. `Response.success(value: AnyCodable(["value": innerValue, "_meta": meta]))` encodes as JSON: `{"id":"...","ok":true,"value":{"value":"jsResult","_meta":{"tabId":42,"tabUrl":"https://..."}}}`
2. DaemonEngine.execute() receives this NDJSON line, parses `response.value` which is an object `{"value":"jsResult","_meta":{...}}`
3. DaemonEngine hits the branch at line 179: `typeof response.value === 'object' && response.value !== null ? JSON.stringify(response.value)` — stringifies the wrapper
4. ExtensionEngine receives `EngineResult.value = '{"value":"jsResult","_meta":{"tabId":42,"tabUrl":"https://..."}}'`
5. ExtensionEngine `JSON.parse`s it, detects `_meta` key, extracts meta and inner value

### Build verification

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
bash scripts/update-daemon.sh
```

### Commit

```
feat(daemon): pass through _meta in ExtensionBridge handleResult

When background.js includes _meta in the result (tab identity metadata),
the bridge now wraps the response as {"value": innerValue, "_meta": meta}
instead of returning just innerValue. ExtensionEngine detects and extracts
the wrapper. Backward-compatible: absent _meta returns innerValue directly.
```

---

## Task 7: Rewrite Ownership Check + Post-Execution Verify in `server.ts`

**Depends on:** Tasks 1-4 (needs EngineResult.meta, new TabOwnership API, EngineProxy.resetMeta/getLastMeta)

This is the largest task. Three changes to `server.ts`:

### Change 7A: Remove `NAVIGATION_URL_TRACKING_TOOLS` and update `SKIP_OWNERSHIP_TOOLS`

**File:** `src/server.ts` (lines 106-120)

#### OLD (lines 106-120)

```typescript
// ── Tool names that skip ownership enforcement ──────────────────────────────
const SKIP_OWNERSHIP_TOOLS = new Set([
  'safari_list_tabs',
  'safari_new_tab',
  'safari_health_check',
  'safari_navigate_back',    // handler queries tab by stale URL after history.back() — can't enforce ownership reliably
  'safari_navigate_forward', // same — handler returns stale URL, subsequent calls would be stranded
]);

// Tools whose successful execution updates the tab's URL in the ownership registry.
// EXCLUDES safari_navigate_back/forward: those handlers query the tab by OLD URL after
// history.back()/forward(), which fails because Safari can't re-locate the tab by a URL
// it no longer has. The handlers fall back to returning the old URL, making tracking
// impossible. This is a pre-existing handler-level limitation — fixing it requires
// tab-index-based queries in the navigation handlers (separate PR).
const NAVIGATION_URL_TRACKING_TOOLS = new Set(['safari_navigate']);
```

#### NEW (replacement for lines 106-120)

```typescript
// ── Tool names that skip ownership enforcement ──────────────────────────────
// Tab identity tracking now handles back/forward via extension tab.id — no
// need to skip ownership for those tools. They go through the deferred path.
const SKIP_OWNERSHIP_TOOLS = new Set([
  'safari_list_tabs',
  'safari_new_tab',
  'safari_health_check',
]);
```

### Change 7B: Pipeline Reorder — Move Engine Selection Before Ownership Check

**File:** `src/server.ts`

The current pipeline in `executeToolWithSecurity()` is:
1. Kill switch (line 402)
2. URL/domain extraction (lines 405-411)
3. **Tab ownership check (lines 413-421)** <-- currently here
4. Domain policy (line 424)
5. Human approval (after domain policy)
6. Rate limiter (lines 471-475)
7. Circuit breaker (line 479)
8. **Engine selection (lines 482-515)** <-- currently here
9. Set proxy delegate (lines 518-521)
10. Engine degradation re-run (lines 529-572)
11. Tool execution (line 576)

New order:
1. Kill switch
2. URL/domain extraction
3. Domain policy
4. Human approval
5. Rate limiter
6. Circuit breaker
7. **Engine selection** (moved up)
8. Set proxy delegate
9. Engine degradation re-run
10. **Tab ownership check with deferral** (moved down, uses selectedEngineName)
11. Tool execution
12. **Post-execution ownership verify** (new)

#### Specific edit: Remove old ownership check (lines 413-421)

##### OLD (lines 413-421)

```typescript
    // 3. Tab ownership check — skip for tools that operate without a specific tab
    if (params['tabUrl'] && !SKIP_OWNERSHIP_TOOLS.has(name)) {
      const tabUrl = params['tabUrl'] as string;
      const tabId = this.tabOwnership.findByUrl(tabUrl);
      if (tabId === undefined) {
        throw new TabUrlNotRecognizedError(tabUrl);
      }
      this.tabOwnership.assertOwnership(tabId);
    }
```

##### NEW (replace with empty — ownership moves after engine selection)

```typescript
    // 3. (Ownership check moved to after engine selection — needs selectedEngineName for deferral)
```

#### Specific edit: Add `resetMeta()` + ownership check after engine proxy setup (after line 521)

Insert AFTER line 521 (`this.engineProxy.setDelegate(selectedEngine);` closing brace) and BEFORE the engine-degradation block (line 523):

##### INSERT (new block between proxy setup and degradation re-run)

```typescript
    // 7c. Reset engine meta to prevent stale reads from previous tool calls
    if (this.engineProxy) {
      this.engineProxy.resetMeta();
    }

    // 7d. Tab ownership check (moved here from step 3 — needs selectedEngineName)
    let deferredOwnershipCheck = false;
    if (params['tabUrl'] && !SKIP_OWNERSHIP_TOOLS.has(name)) {
      const tabUrl = params['tabUrl'] as string;
      const tabId = this.tabOwnership.findByUrl(tabUrl);
      if (tabId === undefined) {
        // URL not found. If extension engine selected AND domain matches an owned tab,
        // defer verification to post-execution (extension result includes tab.id).
        // Otherwise fail immediately (AppleScript has no stable identity to verify).
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

#### Specific edit: Replace `8.post2` block and add post-execution ownership verify

##### OLD (lines 594-608 — the `8.post2` block)

```typescript
      // 8.post2: Update ownership URL after navigation succeeds.
      // Only safari_navigate is tracked — see NAVIGATION_URL_TRACKING_TOOLS comment for why.
      if (NAVIGATION_URL_TRACKING_TOOLS.has(name) && result.content?.[0]?.type === 'text') {
        try {
          const navData = JSON.parse((result.content[0] as { type: 'text'; text: string }).text);
          const oldUrl = params['tabUrl'] as string | undefined;
          const newUrl = navData.url as string | undefined;
          if (oldUrl && newUrl && oldUrl !== newUrl) {
            const tabId = this.tabOwnership.findByUrl(oldUrl);
            if (tabId !== undefined) {
              this.tabOwnership.updateUrl(tabId, newUrl);
            }
          }
        } catch { /* URL update is best-effort */ }
      }
```

##### NEW (replacement — post-execution ownership via engine meta)

```typescript
      // 8.post2: Post-execution ownership — read engine meta for tab identity.
      // Extension results include _meta.tabId (stable) + _meta.tabUrl (current URL).
      // Use this to: (a) backfill extensionTabId, (b) refresh URL, (c) verify deferred ownership.
      const engineMeta = this.engineProxy?.getLastMeta();
      if (engineMeta?.tabId !== undefined) {
        const extTabId = engineMeta.tabId;
        const extTabUrl = engineMeta.tabUrl;

        // Backfill extensionTabId on first extension call for this tab
        const tabUrl = params['tabUrl'] as string | undefined;
        if (tabUrl) {
          const ownedByUrl = this.tabOwnership.findByUrl(tabUrl);
          if (ownedByUrl !== undefined) {
            this.tabOwnership.setExtensionTabId(ownedByUrl, extTabId);
          }
        }

        // Refresh URL in registry (keeps findByUrl working for subsequent calls)
        const ownedByExtId = this.tabOwnership.findByExtensionTabId(extTabId);
        if (ownedByExtId !== undefined && extTabUrl) {
          this.tabOwnership.updateUrl(ownedByExtId, extTabUrl);
        }

        // Deferred ownership verification — was the tab actually ours?
        if (deferredOwnershipCheck) {
          if (ownedByExtId === undefined) {
            // Extension executed on a tab we don't own — block the result from reaching agent
            throw new TabUrlNotRecognizedError(params['tabUrl'] as string);
          }
          // Tab is owned — result is safe to return
        }
      } else if (deferredOwnershipCheck) {
        // Extension didn't return _meta — cannot confirm ownership, fail closed
        throw new TabUrlNotRecognizedError(params['tabUrl'] as string);
      }
```

### Important: `deferredOwnershipCheck` scope

The variable `deferredOwnershipCheck` is declared in the new block after engine proxy setup (7d). It must be declared at a scope visible to both the ownership check and the post-execution block. Since both are inside `executeToolWithSecurity()`, declaring it inside the function body (before the try-catch that wraps tool execution) is correct. Verify that the `try {` at line 575 comes AFTER the ownership check — it does (the try wraps `callTool`).

**Important scope note:** The `deferredOwnershipCheck` variable is declared in block 7d (after engine proxy setup). The post-execution block (8.post2) is inside the `try` block that starts at line 575. The variable declaration must be OUTSIDE this try block to be in scope for both. Since block 7d is between the proxy setup (line 521) and the try (line 575), this works correctly.

### Verify

```bash
npm run build
npm run lint
npm run test:unit
```

### Commit

```
feat(server): identity-based ownership with deferred extension verification

Pipeline reorder: engine selection before ownership check. When URL lookup
fails but extension engine is selected AND domain matches, defer ownership
to post-execution. Extension result _meta.tabId verifies the tab is owned.
Removes NAVIGATION_URL_TRACKING_TOOLS (superseded by _meta URL refresh).
Removes back/forward from SKIP_OWNERSHIP_TOOLS (handled by deferral).
```

---

## Task 8: Update Tests

**Depends on:** Tasks 1-7 (all code changes must be in place)

### 8A: Update `test/unit/security/tab-ownership.test.ts`

Replace the entire file with tests covering the new API:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { TabOwnership } from '../../../src/security/tab-ownership.js';
import { TabNotOwnedError } from '../../../src/errors.js';

describe('TabOwnership', () => {
  let ownership: TabOwnership;

  beforeEach(() => {
    ownership = new TabOwnership();
  });

  it('tracks pre-existing tabs on initialize', () => {
    ownership.recordPreExisting(1);
    ownership.recordPreExisting(2);
    expect(ownership.isPreExisting(1)).toBe(true);
    expect(ownership.isPreExisting(2)).toBe(true);
  });

  it('registers agent-owned tabs', () => {
    ownership.registerTab(1001, 'https://example.com');
    expect(ownership.isOwned(1001)).toBe(true);
  });

  it('pre-existing tabs are NOT owned', () => {
    ownership.recordPreExisting(1);
    expect(ownership.isOwned(1)).toBe(false);
  });

  it('assertOwnership passes for owned tabs', () => {
    ownership.registerTab(1001, 'https://example.com');
    expect(() => ownership.assertOwnership(1001)).not.toThrow();
  });

  it('assertOwnership throws TabNotOwnedError for non-owned tabs', () => {
    ownership.recordPreExisting(1);
    expect(() => ownership.assertOwnership(1)).toThrow(TabNotOwnedError);
  });

  it('assertOwnership throws for unknown tab IDs', () => {
    expect(() => ownership.assertOwnership(9999)).toThrow(TabNotOwnedError);
  });

  it('removes tab on close', () => {
    ownership.registerTab(1001, 'https://example.com');
    expect(ownership.isOwned(1001)).toBe(true);
    ownership.removeTab(1001);
    expect(ownership.isOwned(1001)).toBe(false);
  });

  it('updates URL without changing ownership', () => {
    ownership.registerTab(1001, 'https://example.com/page1');
    ownership.updateUrl(1001, 'https://example.com/page2');
    expect(ownership.isOwned(1001)).toBe(true);
    expect(ownership.getUrl(1001)).toBe('https://example.com/page2');
  });

  it('generates TabId from window and tab indices', () => {
    const tabId = TabOwnership.makeTabId(2, 3);
    expect(tabId).toBe(2003);
  });

  it('resolves TabId by URL for owned tabs', () => {
    ownership.registerTab(1001, 'https://example.com');
    expect(ownership.findByUrl('https://example.com')).toBe(1001);
  });

  it('resolves TabId by URL with trailing-slash normalization', () => {
    ownership.registerTab(1001, 'https://example.com/path');
    expect(ownership.findByUrl('https://example.com/path/')).toBe(1001);
  });

  it('resolves TabId by URL when registered URL has trailing slash', () => {
    ownership.registerTab(1001, 'https://example.com/path/');
    expect(ownership.findByUrl('https://example.com/path')).toBe(1001);
  });

  it('returns undefined for URL of non-owned tabs', () => {
    ownership.recordPreExisting(1);
    expect(ownership.findByUrl('https://example.com')).toBeUndefined();
  });

  it('getAllOwned returns all registered tabs', () => {
    ownership.registerTab(1001, 'https://example.com');
    ownership.registerTab(2001, 'https://other.com');
    const owned = ownership.getAllOwned();
    expect(owned).toHaveLength(2);
    expect(owned.map((o) => o.tabId)).toContain(1001);
    expect(owned.map((o) => o.tabId)).toContain(2001);
  });

  it('getOwnedCount reflects live registry size', () => {
    expect(ownership.getOwnedCount()).toBe(0);
    ownership.registerTab(1001, 'https://example.com');
    expect(ownership.getOwnedCount()).toBe(1);
    ownership.removeTab(1001);
    expect(ownership.getOwnedCount()).toBe(0);
  });

  // ── New: extension tab.id identity ──────────────────────────────────────────

  describe('extension tab.id identity', () => {
    it('registers tab with null extensionTabId by default', () => {
      ownership.registerTab(1001, 'https://example.com');
      expect(ownership.findByExtensionTabId(42)).toBeUndefined();
    });

    it('registers tab with explicit extensionTabId', () => {
      ownership.registerTab(1001, 'https://example.com', 42);
      expect(ownership.findByExtensionTabId(42)).toBe(1001);
    });

    it('backfills extensionTabId via setExtensionTabId', () => {
      ownership.registerTab(1001, 'https://example.com');
      ownership.setExtensionTabId(1001, 42);
      expect(ownership.findByExtensionTabId(42)).toBe(1001);
    });

    it('setExtensionTabId is no-op if already set (prevents overwrite)', () => {
      ownership.registerTab(1001, 'https://example.com', 42);
      ownership.setExtensionTabId(1001, 99); // should NOT overwrite
      expect(ownership.findByExtensionTabId(42)).toBe(1001);
      expect(ownership.findByExtensionTabId(99)).toBeUndefined();
    });

    it('setExtensionTabId is no-op for non-owned tabs', () => {
      ownership.setExtensionTabId(9999, 42);
      expect(ownership.findByExtensionTabId(42)).toBeUndefined();
    });

    it('findByExtensionTabId returns correct tab after URL change', () => {
      ownership.registerTab(1001, 'https://example.com');
      ownership.setExtensionTabId(1001, 42);
      ownership.updateUrl(1001, 'https://example.com/new-page');
      expect(ownership.findByExtensionTabId(42)).toBe(1001);
    });
  });

  // ── New: domain matching ────────────────────────────────────────────────────

  describe('domainMatches', () => {
    beforeEach(() => {
      ownership.registerTab(1001, 'https://app.example.com/page');
    });

    it('matches same domain', () => {
      expect(ownership.domainMatches('https://app.example.com/other')).toBe(true);
    });

    it('matches subdomain of same registrable domain', () => {
      expect(ownership.domainMatches('https://auth.example.com/login')).toBe(true);
    });

    it('matches bare domain against subdomain', () => {
      expect(ownership.domainMatches('https://example.com/page')).toBe(true);
    });

    it('does NOT match different domain', () => {
      expect(ownership.domainMatches('https://evil.com/page')).toBe(false);
    });

    it('does NOT match similar-sounding domain', () => {
      expect(ownership.domainMatches('https://notexample.com/page')).toBe(false);
    });

    it('returns false for malformed URL', () => {
      expect(ownership.domainMatches('not-a-url')).toBe(false);
    });

    it('returns false when no tabs are owned', () => {
      const empty = new TabOwnership();
      expect(empty.domainMatches('https://example.com')).toBe(false);
    });
  });
});
```

### 8B: Verify e2e tests pass

```bash
npm run build
npm run test:unit
npm run test:e2e  # requires Safari running + extension connected
```

Expected: all unit tests pass, e2e tests pass including:
- `test/e2e/interaction-tools.test.ts` (click → navigate → fill → evaluate)
- `test/e2e/security-enforcement.test.ts` (ownership rejection for non-owned URLs)

### Commit

```
test: update tab-ownership tests for identity-based registry

Add tests for findByExtensionTabId, setExtensionTabId, domainMatches,
and trailing-slash normalization. Existing tests adapted to new internal
data model (same public behavior).
```

---

## Task 9: Update ARCHITECTURE.md + TRACES.md

**Depends on:** Tasks 1-8

### ARCHITECTURE.md changes

Add/update these sections:

1. **Security Pipeline** section — update the pipeline order diagram to show engine selection before ownership
2. **Tab Ownership** section — document the new dual-key model:
   - `OwnedTab` interface with `currentUrl` + `extensionTabId`
   - Registration flow (URL-only initially, backfill on first extension call)
   - Ownership check flow (findByUrl fast path, deferred extension path, domain guard)
   - Post-execution verify flow
3. **Extension IPC** section — add `_meta` to the result format documentation

### TRACES.md

Add iteration entry documenting:
- What: Tab ownership by identity — extension tab.id replaces URL-only matching
- Changes: `types.ts`, `tab-ownership.ts`, `engine-proxy.ts`, `extension.ts`, `background.js`, `ExtensionBridge.swift`, `server.ts`, test file
- Context: Fixes click→navigate→interact breakage from fail-closed ownership. Pipeline reordered. Deferred verification for extension engine. Zero additional IPC latency.

### Commit

```
docs: update ARCHITECTURE.md and TRACES.md for identity-based ownership

Document new pipeline order, dual-key registry, _meta propagation path,
deferred ownership verification, and known limitations (SPA pushState).
```

---

## Task 10: Final Verification

**Depends on:** Task 9

### Steps

```bash
cd /Users/Aakash/Claude\ Projects/Skills\ Factory/safari-pilot
npm run build          # TypeScript compiles clean
npm run lint           # tsc --noEmit passes
npm run test:unit      # 1428+ unit tests pass
npm run test:e2e       # all e2e tests pass (requires production stack)
```

### Acceptance criteria (from spec)

1. `test/e2e/interaction-tools.test.ts` — all 3 tests pass (click on link → page navigates → fill form on new page → evaluate succeeds)
2. `test/e2e/security-enforcement.test.ts` — all 4 tests pass (non-owned URL still rejected)
3. No regression in unit test count
4. Non-extension tool calls still fail-closed on unknown URLs
5. Build produces no warnings

### No commit — verification only.

---

## Known Limitations (document but do not fix)

1. **SPA pushState** — `history.pushState` does NOT fire `tabs.onUpdated`. The extension's `tabCacheMap` and server's `currentUrl` both go stale. First call after pushState will fail. Requires content script detection of pushState (future work).

2. **Two-part TLDs** — `domainMatches` comparing last two hostname segments incorrectly equates `evil.co.uk` with `bank.co.uk`. Acceptable for v1 — primary threat is cross-domain.

3. **Multiple tabs at same URL** — If two owned tabs have the same URL, `findByUrl` returns the first one found. `findByExtensionTabId` is unambiguous but only works after backfill. Same limitation as today.

4. **AppleScript-only sessions** — If the extension never connects, no tab.id is ever backfilled. Ownership remains URL-only (same as current behavior). No regression.

---

## Summary of Files Changed

| File | Change |
|------|--------|
| `src/types.ts:33-38` | Add `meta?` field to `EngineResult` |
| `src/security/tab-ownership.ts` | Complete rewrite — dual-key registry |
| `src/engines/engine-proxy.ts` | Add `_lastMeta`, `resetMeta()`, `getLastMeta()` |
| `src/engines/extension.ts:74-91` | Extract `_meta` wrapper from daemon results |
| `extension/background.js:226-232` | Enrich results with `_meta: {tabId, tabUrl}` |
| `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift:300-307` | Pass through `_meta` in wrapper |
| `src/server.ts:106-120` | Remove `NAVIGATION_URL_TRACKING_TOOLS`, slim `SKIP_OWNERSHIP_TOOLS` |
| `src/server.ts:413-421` | Remove old ownership check (moved) |
| `src/server.ts` (after 521) | Add `resetMeta()` + deferred ownership check |
| `src/server.ts:594-608` | Replace URL tracking with `_meta`-based post-execution verify |
| `test/unit/security/tab-ownership.test.ts` | Complete rewrite for new API |
| `ARCHITECTURE.md` | Document new model |
| `TRACES.md` | Add iteration entry |
