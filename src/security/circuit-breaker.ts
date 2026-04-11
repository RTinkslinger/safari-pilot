import { CircuitBreakerOpenError } from '../errors.js';

// ─── CircuitBreaker ───────────────────────────────────────────────────────────
//
// Per-domain circuit breaker using the standard three-state model:
//
//   closed  → normal operation, failures accumulate
//   open    → circuit tripped, all calls rejected for cooldownMs
//   half-open → one probe allowed after cooldown; success → closed, fail → open

export type CircuitState = 'closed' | 'open' | 'half-open';

const FAILURE_THRESHOLD = 5; // consecutive failures to trip the circuit
const WINDOW_MS = 60_000;    // failure tracking window (60 s)
const COOLDOWN_MS = 120_000; // open → half-open cooldown (120 s)

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

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Record a successful call. Resets the failure counter and closes the circuit.
   */
  recordSuccess(domain: string): void {
    const state = this.getState_(domain);
    state.failures = 0;
    state.firstFailureAt = 0;
    state.openedAt = null;
    state.probeAllowed = false;
    state.probeInFlight = false;
    this.states.set(domain, state);
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
      state.failures = FAILURE_THRESHOLD;
      state.firstFailureAt = now;
      this.states.set(domain, state);
      return;
    }

    // Reset failure count if previous run is outside the tracking window
    if (state.failures > 0 && now - state.firstFailureAt > WINDOW_MS) {
      state.failures = 0;
      state.firstFailureAt = 0;
    }

    if (state.failures === 0) {
      state.firstFailureAt = now;
    }

    state.failures += 1;

    if (state.failures >= FAILURE_THRESHOLD) {
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

    if (elapsed >= COOLDOWN_MS) {
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
      const remaining = COOLDOWN_MS - (Date.now() - (state.openedAt ?? 0));
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

  // ── Internal ─────────────────────────────────────────────────────────────────

  private getState_(domain: string): DomainState {
    if (!this.states.has(domain)) {
      this.states.set(domain, emptyState());
    }
    return this.states.get(domain)!;
  }
}
