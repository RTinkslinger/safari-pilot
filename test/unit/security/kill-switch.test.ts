import { describe, it, expect, beforeEach } from 'vitest';
import { KillSwitch } from '../../../src/security/kill-switch.js';
import { KillSwitchActiveError } from '../../../src/errors.js';

describe('KillSwitch', () => {
  let ks: KillSwitch;

  beforeEach(() => {
    ks = new KillSwitch();
  });

  it('starts inactive', () => {
    expect(ks.isActive()).toBe(false);
  });

  it('activate sets active state with reason', () => {
    ks.activate('test emergency stop');
    expect(ks.isActive()).toBe(true);
    const state = ks.getActivation();
    expect(state.active).toBe(true);
    expect(state.reason).toBe('test emergency stop');
  });

  it('activate records activatedAt timestamp', () => {
    const before = new Date().toISOString();
    ks.activate('timestamp test');
    const after = new Date().toISOString();
    const state = ks.getActivation();
    expect(state.activatedAt).toBeDefined();
    expect(state.activatedAt! >= before).toBe(true);
    expect(state.activatedAt! <= after).toBe(true);
  });

  it('isActive returns true after activation', () => {
    ks.activate('active check');
    expect(ks.isActive()).toBe(true);
  });

  it('checkBeforeAction throws KillSwitchActiveError when active', () => {
    ks.activate('blocking automation');
    expect(() => ks.checkBeforeAction()).toThrow(KillSwitchActiveError);
  });

  it('checkBeforeAction includes reason in error message', () => {
    ks.activate('specific reason');
    expect(() => ks.checkBeforeAction()).toThrow('specific reason');
  });

  it('checkBeforeAction passes without error when inactive', () => {
    expect(() => ks.checkBeforeAction()).not.toThrow();
  });

  it('deactivate resets state', () => {
    ks.activate('to be deactivated');
    ks.deactivate();
    expect(ks.isActive()).toBe(false);
  });

  it('getActivation returns active:false after deactivation', () => {
    ks.activate('temp stop');
    ks.deactivate();
    const state = ks.getActivation();
    expect(state.active).toBe(false);
    expect(state.reason).toBeUndefined();
    expect(state.activatedAt).toBeUndefined();
  });

  it('getActivation returns full details when active', () => {
    ks.activate('full detail check');
    const state = ks.getActivation();
    expect(state.active).toBe(true);
    expect(state.reason).toBe('full detail check');
    expect(state.activatedAt).toBeDefined();
  });

  it('handles multiple activate/deactivate cycles', () => {
    // Cycle 1
    ks.activate('cycle 1');
    expect(ks.isActive()).toBe(true);
    ks.deactivate();
    expect(ks.isActive()).toBe(false);

    // Cycle 2
    ks.activate('cycle 2');
    expect(ks.isActive()).toBe(true);
    expect(ks.getActivation().reason).toBe('cycle 2');
    ks.deactivate();
    expect(ks.isActive()).toBe(false);

    // After cycle 2, checkBeforeAction should pass
    expect(() => ks.checkBeforeAction()).not.toThrow();
  });

  it('auto-activates when error threshold is exceeded', () => {
    const autoKs = new KillSwitch({
      autoActivation: { maxErrors: 3, windowSeconds: 30 },
    });

    autoKs.recordError();
    autoKs.recordError();
    expect(autoKs.isActive()).toBe(false); // not yet at threshold

    autoKs.recordError();
    expect(autoKs.isActive()).toBe(true); // threshold hit
    expect(autoKs.getActivation().reason).toContain('Auto-activated');
  });

  it('deactivate clears error window (auto-activation resets)', () => {
    const autoKs = new KillSwitch({
      autoActivation: { maxErrors: 2, windowSeconds: 30 },
    });

    autoKs.recordError();
    autoKs.recordError();
    expect(autoKs.isActive()).toBe(true);

    autoKs.deactivate();
    autoKs.recordError(); // window should be empty after deactivation
    expect(autoKs.isActive()).toBe(false);
  });
});
