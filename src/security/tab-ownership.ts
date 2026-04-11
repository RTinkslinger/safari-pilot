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
