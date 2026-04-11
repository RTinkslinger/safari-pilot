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
});
