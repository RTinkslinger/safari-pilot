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

    it('matches localhost against localhost', () => {
      const local = new TabOwnership();
      local.registerTab(2001, 'http://localhost:3000/page');
      expect(local.domainMatches('http://localhost:3000/other')).toBe(true);
    });

    it('matches IP address against same IP', () => {
      const ipOwner = new TabOwnership();
      ipOwner.registerTab(3001, 'http://192.168.1.100:8080/app');
      expect(ipOwner.domainMatches('http://192.168.1.100:8080/other')).toBe(true);
    });
  });
});
