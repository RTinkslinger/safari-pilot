/**
 * SD-04 unit coverage for the KillSwitch security layer.
 *
 * The KillSwitch is layer 1 of the 9-layer pipeline (per CLAUDE.md). When
 * activated, every subsequent tool call must throw `KillSwitchActiveError`
 * via `checkBeforeAction()` — this test asserts that contract.
 *
 * Coverage previously: zero (CLAUDE.md litmus "delete a critical component
 * — does any test fail?" was failing for KillSwitch).
 *
 * Discrimination: revert the throw inside `checkBeforeAction` (or remove the
 * `_active` guard) → test 2 fails because the call returns instead of
 * throwing.
 */
import { describe, it, expect } from 'vitest';
import { KillSwitch } from '../../../src/security/kill-switch.js';
import { KillSwitchActiveError } from '../../../src/errors.js';

describe('KillSwitch (SD-04)', () => {
  it('checkBeforeAction returns silently when not activated', () => {
    const ks = new KillSwitch();
    expect(() => ks.checkBeforeAction()).not.toThrow();
    expect(ks.isActive()).toBe(false);
  });

  it('activate() flips state and checkBeforeAction throws KillSwitchActiveError with the reason', () => {
    const ks = new KillSwitch();
    ks.activate('test reason');
    expect(ks.isActive()).toBe(true);

    expect(() => ks.checkBeforeAction()).toThrow(KillSwitchActiveError);
    try {
      ks.checkBeforeAction();
      expect.fail('checkBeforeAction should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(KillSwitchActiveError);
      expect((err as KillSwitchActiveError).message).toContain('test reason');
      expect((err as KillSwitchActiveError).code).toBe('KILL_SWITCH_ACTIVE');
    }
  });

  it('deactivate() restores normal operation', () => {
    const ks = new KillSwitch();
    ks.activate('temporarily off');
    expect(() => ks.checkBeforeAction()).toThrow();
    ks.deactivate();
    expect(ks.isActive()).toBe(false);
    expect(() => ks.checkBeforeAction()).not.toThrow();
  });

  it('auto-activates when recordError exceeds threshold within rolling window', () => {
    const ks = new KillSwitch({ autoActivation: { maxErrors: 3, windowSeconds: 60 } });
    ks.recordError();
    ks.recordError();
    expect(ks.isActive()).toBe(false);
    ks.recordError(); // 3rd error trips the threshold
    expect(ks.isActive()).toBe(true);
    expect(() => ks.checkBeforeAction()).toThrow(KillSwitchActiveError);
    const activation = ks.getActivation();
    expect(activation.reason).toMatch(/Auto-activated/);
  });

  it('recordError without configured threshold is a no-op', () => {
    const ks = new KillSwitch();
    for (let i = 0; i < 100; i++) ks.recordError();
    expect(ks.isActive()).toBe(false);
  });
});
