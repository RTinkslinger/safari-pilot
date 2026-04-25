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
  windowId: number | null;       // Safari window id — stable positional identity
  tabIndex: number | null;       // 1-based position within the window
}

export class TabOwnership {
  private ownedTabs: Map<TabId, OwnedTab> = new Map();

  // ── Static helpers ──────────────────────────────────────────────────────────

  /**
   * Compute a numeric TabId from Safari's 1-based window/tab indices.
   * Formula: windowIndex * 1000 + tabIndex
   */
  static makeTabId(windowIndex: number, tabIndex: number): TabId {
    return windowIndex * 1000 + tabIndex;
  }

  // ── Ownership lifecycle ─────────────────────────────────────────────────────

  /**
   * Register a tab as agent-opened. Call this immediately after safari_new_tab.
   * extensionTabId is null initially — backfilled on first extension-engine call.
   * windowId + tabIndex provide positional identity for AppleScript targeting.
   */
  registerTab(tabId: TabId, url: string, opts?: {
    extensionTabId?: number;
    windowId?: number;
    tabIndex?: number;
  }): void {
    this.ownedTabs.set(tabId, {
      currentUrl: url,
      extensionTabId: opts?.extensionTabId ?? null,
      windowId: opts?.windowId ?? null,
      tabIndex: opts?.tabIndex ?? null,
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

  getUrl(tabId: TabId): string | undefined {
    return this.ownedTabs.get(tabId)?.currentUrl;
  }

  /**
   * Get positional identity for AppleScript targeting.
   * Returns null if the tab isn't owned or identity wasn't captured.
   */
  getPosition(tabId: TabId): { windowId: number; tabIndex: number } | null {
    const entry = this.ownedTabs.get(tabId);
    if (entry?.windowId != null && entry?.tabIndex != null) {
      return { windowId: entry.windowId, tabIndex: entry.tabIndex };
    }
    return null;
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

// ── Module-level helpers ───────────────────────────────────────────────────────

