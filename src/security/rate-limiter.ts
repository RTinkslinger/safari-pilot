import { RateLimitedError } from '../errors.js';

// ─── RateLimiter ──────────────────────────────────────────────────────────────
//
// Sliding-window rate limiter. Tracks action timestamps per domain in the last
// 60 seconds. Enforces a global default limit and per-domain overrides.

const WINDOW_MS = 60_000; // 60-second sliding window
const GLOBAL_DEFAULT_LIMIT = 120; // actions per 60 seconds

export interface CheckResult {
  allowed: boolean;
  remaining: number;
  resetMs: number; // ms until the oldest entry falls out of the window
}

export class RateLimiter {
  // domain → sorted list of timestamp (ms) entries within the window
  private windows: Map<string, number[]> = new Map();
  // per-domain limit overrides (set from DomainPolicy)
  private domainLimits: Map<string, number> = new Map();

  // ── Configuration ───────────────────────────────────────────────────────────

  setDomainLimit(domain: string, limit: number): void {
    this.domainLimits.set(domain, limit);
  }

  // ── Core operations ─────────────────────────────────────────────────────────

  /**
   * Check if an action is allowed for the given domain.
   * Does NOT record the action — call recordAction() separately.
   */
  checkLimit(domain: string): CheckResult {
    const now = Date.now();
    const entries = this.prune(domain, now);
    const limit = this.limitFor(domain);
    const count = entries.length;
    const allowed = count < limit;
    const remaining = Math.max(0, limit - count);

    // Time until the oldest entry would fall out of the window
    const resetMs = entries.length > 0 ? Math.max(0, entries[0]! + WINDOW_MS - now) : 0;

    return { allowed, remaining, resetMs };
  }

  /**
   * Record an action for the given domain.
   * Throws RateLimitedError if the limit has already been reached.
   */
  recordAction(domain: string): void {
    const now = Date.now();
    const entries = this.prune(domain, now);
    const limit = this.limitFor(domain);

    if (entries.length >= limit) {
      throw new RateLimitedError(domain, limit);
    }

    entries.push(now);
    this.windows.set(domain, entries);
  }

  /**
   * Returns the count of recorded actions for a domain in the current window.
   */
  getCount(domain: string): number {
    const now = Date.now();
    return this.prune(domain, now).length;
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private limitFor(domain: string): number {
    return this.domainLimits.get(domain) ?? GLOBAL_DEFAULT_LIMIT;
  }

  /**
   * Remove entries older than the 60-second window and return the live list.
   * Mutates the map in-place for efficiency.
   */
  private prune(domain: string, now: number): number[] {
    const entries = this.windows.get(domain) ?? [];
    const cutoff = now - WINDOW_MS;
    const pruned = entries.filter((ts) => ts > cutoff);
    this.windows.set(domain, pruned);
    return pruned;
  }
}
