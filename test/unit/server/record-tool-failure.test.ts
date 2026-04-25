/**
 * T12 / SD-08 — `SafariPilotServer.recordToolFailure()` must fire BOTH the
 * per-domain `recordFailure(domain)` and the per-engine
 * `recordEngineFailure(engine, code)` calls on the circuit breaker.
 *
 * Pre-T12 only the per-domain side fired from `executeToolWithSecurity`'s
 * catch block. The engine breaker existed (recordEngineFailure defined on
 * CircuitBreaker, checked by engine-selector.isEngineTripped) but the
 * server never called it — so EXTENSION_TIMEOUT / EXTENSION_UNCERTAIN /
 * EXTENSION_DISCONNECTED never tripped and the engine kept getting picked
 * indefinitely despite repeated failures.
 *
 * SD-08 refactor (2026-04-25): the original tests used `vi.spyOn` to
 * assert HOW the server wired the methods (called-with-specific-args).
 * Per upp:test-reviewer retro #1, that was behaviour-asserting-on-
 * implementation. Replaced with observable-state assertions: do N
 * failures → assert the breaker state the user would actually observe.
 * The T12 discrimination guarantee is preserved — reverting
 * `recordToolFailure` to call only one of the two breaker branches
 * fails at least one of the state assertions below.
 */
import { describe, it, expect } from 'vitest';
import { SafariPilotServer } from '../../../src/server.js';
import { DEFAULT_CONFIG } from '../../../src/config.js';

// SD-09: `server.circuitBreaker` is already a `readonly` public field on
// SafariPilotServer — no cast needed for the state read. Only the call
// to the private `recordToolFailure` method uses a cast, and that is
// test-only entry-point access (SD-09's scope is state reads, not
// method calls).
interface ServerInternals {
  recordToolFailure: (domain: string, engine: string, error: unknown) => void;
}

function internals(server: SafariPilotServer): ServerInternals {
  return server as unknown as ServerInternals;
}

describe('SafariPilotServer.recordToolFailure (T12 / SD-08)', () => {
  it('5 EXTENSION_TIMEOUT failures on one domain trip BOTH per-domain AND per-engine breakers', () => {
    // Single-test observable-state assertion covering both breaker scopes.
    // Replaces the pre-SD-08 `vi.spyOn(cb, 'recordFailure' | 'recordEngineFailure')`
    // pair which asserted on method-call-arguments. This version asserts on
    // the end-state the caller would see — any regression in wiring (either
    // branch missing, or engine code dropped) breaks at least one assertion.
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    const cb = server.circuitBreaker;

    const domain = 'example.com';
    const err = { code: 'EXTENSION_TIMEOUT', message: 'timeout' };

    // Baseline: both scopes start closed.
    expect(cb.getState(domain)).toBe('closed');
    expect(cb.isEngineTripped('extension')).toBe(false);

    for (let i = 0; i < 5; i++) {
      internals(server).recordToolFailure(domain, 'extension', err);
    }

    // Per-domain breaker opened → proves recordToolFailure → cb.recordFailure.
    // If SD-08 regression reverted recordToolFailure to skip the per-domain
    // branch, this assertion would fail (stays 'closed').
    expect(cb.getState(domain)).toBe('open');

    // Per-engine breaker tripped → proves recordToolFailure →
    // cb.recordEngineFailure WITH the error's code. If recordToolFailure
    // skipped the engine branch OR dropped the code, isEngineTripped stays
    // false (engine breaker triggers only on EXTENSION_* codes; a dropped
    // code becomes 'UNKNOWN' and is ignored by the engine-level filter).
    expect(cb.isEngineTripped('extension')).toBe(true);
  });

  it('engine breaker trips across different domains (engine scope independent of per-domain)', () => {
    // Preserves the original test 3 semantics: 5 failures across DIFFERENT
    // domains don't trip the per-domain breaker (each domain gets 1
    // failure, well under the 5-threshold), but DO trip the engine breaker
    // (which accumulates across all domains). This scope-independence is a
    // load-bearing property of T12's dual-scope design.
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    const cb = server.circuitBreaker;
    const err = { code: 'EXTENSION_TIMEOUT', message: 'timeout' };

    for (let i = 0; i < 5; i++) {
      internals(server).recordToolFailure(`d${i}.example`, 'extension', err);
    }

    // Engine tripped — accumulation across the 5 distinct domains.
    expect(cb.isEngineTripped('extension')).toBe(true);

    // No per-domain breaker tripped — each domain only saw 1 failure.
    for (let i = 0; i < 5; i++) {
      expect(cb.getState(`d${i}.example`)).toBe('closed');
    }
  });

  it('non-triggering error codes do not trip the engine breaker (filter is by code, not call count)', () => {
    // Engine breaker triggers only on EXTENSION_TIMEOUT / EXTENSION_UNCERTAIN /
    // EXTENSION_DISCONNECTED. Other codes (or a missing/UNKNOWN code from a
    // plain Error) must NOT accumulate toward the engine trip threshold.
    // This replaces the pre-SD-08 `it('defaults the engine-failure code to
    // UNKNOWN when ...')` spy test — observable via the state-not-tripped
    // invariant.
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    const cb = server.circuitBreaker;

    // 10 failures — 2x the threshold — with a non-triggering code.
    const err = { code: 'TIMEOUT', message: 'daemon timeout' };
    for (let i = 0; i < 10; i++) {
      internals(server).recordToolFailure(`d${i}.example`, 'daemon', err);
    }

    // Daemon engine breaker never trips on 'TIMEOUT' (not in the engine
    // breaker's trigger set). Per-domain still accumulates normally — but
    // each domain only saw 1 failure so none trip either.
    expect(cb.isEngineTripped('daemon')).toBe(false);

    // 5 plain Errors (no `code` field) map to 'UNKNOWN' and don't trip.
    for (let i = 0; i < 5; i++) {
      internals(server).recordToolFailure('x.example', 'extension', new Error('boom'));
    }
    expect(cb.isEngineTripped('extension')).toBe(false);
  });
});
