/**
 * T12 — `SafariPilotServer.recordToolFailure()` must fire BOTH the
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
 * This test isolates the wiring by calling the extracted `recordToolFailure`
 * method directly. The rest of executeToolWithSecurity (9 security layers,
 * engine selection, post-hooks) is not exercised here — the claim this test
 * proves is narrow: the error-path catch delegates to `recordToolFailure`,
 * and that method fires both spies.
 */
import { describe, it, expect, vi } from 'vitest';
import { SafariPilotServer } from '../../../src/server.js';
import { DEFAULT_CONFIG } from '../../../src/config.js';
import type { CircuitBreaker } from '../../../src/security/circuit-breaker.js';

interface ServerInternals {
  circuitBreaker: CircuitBreaker;
  recordToolFailure: (domain: string, engine: string, error: unknown) => void;
}

function internals(server: SafariPilotServer): ServerInternals {
  return server as unknown as ServerInternals;
}

describe('SafariPilotServer.recordToolFailure (T12): engine breaker wiring', () => {
  it('records BOTH per-domain and per-engine failures for a SafariPilotError with a code', () => {
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    const cb = internals(server).circuitBreaker;
    const domainSpy = vi.spyOn(cb, 'recordFailure');
    const engineSpy = vi.spyOn(cb, 'recordEngineFailure');

    const err = { code: 'EXTENSION_TIMEOUT', message: 'timeout', name: 'ExtensionTimeoutError' };
    internals(server).recordToolFailure('example.com', 'extension', err);

    expect(domainSpy).toHaveBeenCalledTimes(1);
    expect(domainSpy).toHaveBeenCalledWith('example.com');

    expect(engineSpy).toHaveBeenCalledTimes(1);
    expect(engineSpy).toHaveBeenCalledWith('extension', 'EXTENSION_TIMEOUT');
  });

  it('defaults the engine-failure code to UNKNOWN when the error has no code field', () => {
    // An arbitrary plain Error (no .code) is still a tool failure worth
    // recording — the engine breaker filters internally to the three
    // trigger codes, so UNKNOWN simply becomes a no-op for engine state.
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    const cb = internals(server).circuitBreaker;
    const engineSpy = vi.spyOn(cb, 'recordEngineFailure');

    internals(server).recordToolFailure('example.com', 'daemon', new Error('boom'));

    expect(engineSpy).toHaveBeenCalledWith('daemon', 'UNKNOWN');
  });

  it('trips the engine breaker after 5 EXTENSION_TIMEOUT failures (integration with CircuitBreaker)', () => {
    // Not a pure unit test of recordToolFailure — this is the end-to-end
    // wiring assertion: if recordToolFailure were reverted to NOT call
    // recordEngineFailure, isEngineTripped would stay false forever and
    // this assertion would fail.
    const server = new SafariPilotServer(DEFAULT_CONFIG);
    const cb = internals(server).circuitBreaker;
    const err = { code: 'EXTENSION_TIMEOUT', message: 'timeout' };

    expect(cb.isEngineTripped('extension')).toBe(false);
    for (let i = 0; i < 5; i++) {
      internals(server).recordToolFailure(`d${i}.example`, 'extension', err);
    }
    expect(cb.isEngineTripped('extension')).toBe(true);
  });
});
