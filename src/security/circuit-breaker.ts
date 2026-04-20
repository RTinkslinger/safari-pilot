import { CircuitBreakerOpenError } from '../errors.js';

// ─── CircuitBreaker ───────────────────────────────────────────────────────────
//
// Per-domain circuit breaker using the standard three-state model:
//
//   closed  → normal operation, failures accumulate
//   open    → circuit tripped, all calls rejected for cooldownMs
//   half-open → one probe allowed after cooldown; success → closed, fail → open

export type CircuitState = 'closed' | 'open' | 'half-open';

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 120_000;

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  windowMs?: number;
  cooldownMs?: number;
}

interface DomainState {
  failures: number;        // consecutive failure count
  firstFailureAt: number;  // timestamp of the first failure in the current run
  openedAt: number | null; // when the circuit was opened (null if closed)
  probeAllowed: boolean;   // half-open: whether the single probe has been issued
  probeInFlight: boolean;  // true while the half-open probe call is outstanding
}

function emptyState(): DomainState {
  return {
    failures: 0,
    firstFailureAt: 0,
    openedAt: null,
    probeAllowed: false,
    probeInFlight: false,
  };
}

export class CircuitBreaker {
  private states: Map<string, DomainState> = new Map();
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;

  // Engine scope state (independent from per-domain state)
  private engineFailures: Map<string, number[]> = new Map();
  private engineTrippedUntil: Map<string, number> = new Map();

  private readonly engineErrorThreshold = 5;
  private readonly engineWindowMs = 120_000;
  private readonly engineCooldownMs = 120_000;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Record a successful call. Resets the failure counter and closes the circuit.
   */
  recordSuccess(domain: string): void {
    // Delete instead of zeroing — getState_() recreates fresh emptyState() on
    // next access (openedAt: null → 'closed', probeAllowed: false). Prevents
    // unbounded Map growth from accumulating entries for every visited domain.
    this.states.delete(domain);
  }

  /**
   * Record a failed call. May open the circuit if the threshold is reached.
   */
  recordFailure(domain: string): void {
    const now = Date.now();
    const state = this.getState_(domain);

    // A probe failure in half-open state immediately re-opens the circuit,
    // bypassing the normal threshold, and resets the cooldown clock.
    if (state.probeInFlight) {
      state.openedAt = now;
      state.probeAllowed = false;
      state.probeInFlight = false;
      // Keep failures at threshold so the circuit stays open on next check
      state.failures = this.failureThreshold;
      state.firstFailureAt = now;
      this.states.set(domain, state);
      return;
    }

    // Reset failure count if previous run is outside the tracking window
    if (state.failures > 0 && now - state.firstFailureAt > this.windowMs) {
      state.failures = 0;
      state.firstFailureAt = 0;
    }

    if (state.failures === 0) {
      state.firstFailureAt = now;
    }

    state.failures += 1;

    if (state.failures >= this.failureThreshold) {
      state.openedAt = now;
      state.probeAllowed = false;
    }

    this.states.set(domain, state);
  }

  /**
   * Returns true when the circuit is open (calls should be rejected).
   * Half-open circuits return false — a probe is permitted.
   */
  isOpen(domain: string): boolean {
    return this.getState(domain) === 'open';
  }

  /**
   * Compute the current circuit state for a domain.
   */
  getState(domain: string): CircuitState {
    const state = this.getState_(domain);

    if (state.openedAt === null) {
      return 'closed';
    }

    const elapsed = Date.now() - state.openedAt;

    if (elapsed >= this.cooldownMs) {
      return 'half-open';
    }

    return 'open';
  }

  /**
   * Assert the circuit is not open before executing a call.
   * Call this at the entry point of any guarded operation.
   * Throws CircuitBreakerOpenError when the circuit is open.
   * In half-open state, marks the probe as issued and allows one call through.
   */
  assertClosed(domain: string): void {
    const circuitState = this.getState(domain);
    const state = this.getState_(domain);

    if (circuitState === 'open') {
      const remaining = this.cooldownMs - (Date.now() - (state.openedAt ?? 0));
      throw new CircuitBreakerOpenError(domain, Math.ceil(remaining / 1000));
    }

    if (circuitState === 'half-open') {
      if (state.probeAllowed) {
        // Already issued a probe — reject subsequent calls until success/fail
        throw new CircuitBreakerOpenError(domain, 0);
      }
      state.probeAllowed = true;
      state.probeInFlight = true;
      this.states.set(domain, state);
    }
  }

  // ── Engine scope API (independent from per-domain state) ────────────────────

  /**
   * Record a failure attributable to a specific engine. Only extension-lifecycle
   * error codes (EXTENSION_TIMEOUT / EXTENSION_UNCERTAIN / EXTENSION_DISCONNECTED)
   * count toward the engine breaker; other codes are ignored.
   *
   * Trips at 5 failures within a rolling 120s window; stays tripped for 120s.
   */
  recordEngineFailure(engine: string, errorCode: string): void {
    const triggering = new Set([
      'EXTENSION_TIMEOUT',
      'EXTENSION_UNCERTAIN',
      'EXTENSION_DISCONNECTED',
    ]);
    if (!triggering.has(errorCode)) return;

    const now = Date.now();
    const list = this.engineFailures.get(engine) ?? [];
    const recent = list.filter((t) => now - t < this.engineWindowMs);
    recent.push(now);
    this.engineFailures.set(engine, recent);

    if (recent.length >= this.engineErrorThreshold) {
      this.engineTrippedUntil.set(engine, now + this.engineCooldownMs);
    }
  }

  /**
   * True when the given engine's breaker is currently tripped. Self-heals on
   * read: once the cooldown expires, the tripped state and failure history are
   * cleared so the engine starts fresh.
   */
  isEngineTripped(engine: string): boolean {
    const until = this.engineTrippedUntil.get(engine);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      this.engineTrippedUntil.delete(engine);
      this.engineFailures.delete(engine);
      return false;
    }
    return true;
  }

  /**
   * Read-only state accessor for the engine scope. Used by extension_health
   * snapshot's `engineCircuitBreakerState` field.
   */
  getEngineState(engine: string): 'closed' | 'open' {
    return this.isEngineTripped(engine) ? 'open' : 'closed';
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  private getState_(domain: string): DomainState {
    if (!this.states.has(domain)) {
      this.states.set(domain, emptyState());
    }
    return this.states.get(domain)!;
  }
}
