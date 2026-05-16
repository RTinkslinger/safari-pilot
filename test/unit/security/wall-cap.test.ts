import { describe, expect, it } from 'vitest';
import { WallCapEnforcer } from '../../../src/security/wall-cap.js';
import { WallCapExceededError, ERROR_CODES } from '../../../src/errors.js';

// v0.1.36 — session-level wall-clock cap.
//
// Pre-v0.1.36, run-one-task.sh exported MAX_WALL_MS=1200000 with the
// comment "the in-process LoopDetector + ThrashDetector is the
// enforcement." That comment was a lie: no source file read MAX_WALL_MS,
// no error of type WALL_CAP_EXCEEDED was ever thrown, and bench tasks
// regularly ran 25-30 minutes past the 20-minute "limit". Confirmed
// during the v0.1.36 probe-C diagnosis (2026-05-17): four Allrecipes
// tasks ran 27-37 minutes each before hitting claude-CLI's own natural
// turn cap.
//
// WallCapEnforcer is the missing enforcement layer. Constructed once per
// MCP-server session with the configured cap (typically read from
// `process.env.MAX_WALL_MS`). assertWithinCap() runs at the top of every
// executeToolWithSecurity call; if elapsed > cap, it throws
// WallCapExceededError (retryable=false, hint to ABSTAIN). The agent's
// next tool call surfaces as JSON-RPC error and claude voluntarily
// terminates within a turn or two.

describe('WallCapEnforcer (v0.1.36)', () => {
  it('does nothing when maxWallMs is undefined (no env override)', () => {
    const enforcer = new WallCapEnforcer(undefined, () => 1_000);
    expect(() => enforcer.assertWithinCap(2_000_000)).not.toThrow();
  });

  it('does not throw when elapsed < cap', () => {
    const enforcer = new WallCapEnforcer(1_000, () => 0);
    expect(() => enforcer.assertWithinCap(500)).not.toThrow();
  });

  it('does not throw when elapsed equals cap (inclusive boundary)', () => {
    const enforcer = new WallCapEnforcer(1_000, () => 0);
    expect(() => enforcer.assertWithinCap(1_000)).not.toThrow();
  });

  it('throws WallCapExceededError when elapsed > cap', () => {
    const enforcer = new WallCapEnforcer(1_000, () => 0);
    expect(() => enforcer.assertWithinCap(1_001)).toThrow(WallCapExceededError);
  });

  it('thrown error carries code/retryable/hints', () => {
    const enforcer = new WallCapEnforcer(1_000, () => 0);
    let thrown: WallCapExceededError | undefined;
    try {
      enforcer.assertWithinCap(2_500);
    } catch (e) {
      thrown = e as WallCapExceededError;
    }
    expect(thrown).toBeInstanceOf(WallCapExceededError);
    expect(thrown?.code).toBe(ERROR_CODES.WALL_CAP_EXCEEDED);
    expect(thrown?.retryable).toBe(false);
    expect(thrown?.hints.length).toBeGreaterThan(0);
    // Includes the configured cap and actual elapsed for the agent's hint.
    expect(thrown?.message).toContain('1000');
    expect(thrown?.message).toContain('2500');
  });

  it('reports remaining budget while still under cap', () => {
    const enforcer = new WallCapEnforcer(10_000, () => 0);
    expect(enforcer.remainingMs(3_000)).toBe(7_000);
  });

  it('reports remaining budget as 0 when exactly at cap', () => {
    const enforcer = new WallCapEnforcer(10_000, () => 0);
    expect(enforcer.remainingMs(10_000)).toBe(0);
  });

  it('reports remaining budget as 0 when over cap (not negative)', () => {
    const enforcer = new WallCapEnforcer(10_000, () => 0);
    expect(enforcer.remainingMs(15_000)).toBe(0);
  });

  it('reports remaining as +Infinity when uncapped', () => {
    const enforcer = new WallCapEnforcer(undefined, () => 0);
    expect(enforcer.remainingMs(15_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it('uses provided now() function for default elapsed calculation', () => {
    // No now() arg -> uses the injected clock. Test rule: if elapsed exceeds
    // cap based on the injected clock, throw. This lets the production
    // server call assertWithinCap() with no args and have the enforcer
    // compute elapsed from its start time + the wall clock.
    let t = 0;
    const enforcer = new WallCapEnforcer(1_000, () => t);
    expect(() => enforcer.assertWithinCap()).not.toThrow();
    t = 999;
    expect(() => enforcer.assertWithinCap()).not.toThrow();
    t = 1_001;
    expect(() => enforcer.assertWithinCap()).toThrow(WallCapExceededError);
  });

  describe('fromEnv()', () => {
    it('returns an enforcer with no cap when MAX_WALL_MS is unset', () => {
      const enforcer = WallCapEnforcer.fromEnv({});
      expect(enforcer.remainingMs(1_000_000_000)).toBe(Number.POSITIVE_INFINITY);
    });

    it('parses MAX_WALL_MS from a numeric string', () => {
      const enforcer = WallCapEnforcer.fromEnv({ MAX_WALL_MS: '5000' }, () => 0);
      expect(() => enforcer.assertWithinCap(5_001)).toThrow(WallCapExceededError);
      expect(() => enforcer.assertWithinCap(4_999)).not.toThrow();
    });

    it('ignores non-numeric MAX_WALL_MS (defensive)', () => {
      const enforcer = WallCapEnforcer.fromEnv({ MAX_WALL_MS: 'banana' });
      expect(enforcer.remainingMs(1_000_000)).toBe(Number.POSITIVE_INFINITY);
    });

    it('ignores zero or negative MAX_WALL_MS (defensive — zero disables, never enforces)', () => {
      const e1 = WallCapEnforcer.fromEnv({ MAX_WALL_MS: '0' });
      expect(e1.remainingMs(1_000)).toBe(Number.POSITIVE_INFINITY);
      const e2 = WallCapEnforcer.fromEnv({ MAX_WALL_MS: '-500' });
      expect(e2.remainingMs(1_000)).toBe(Number.POSITIVE_INFINITY);
    });
  });
});
