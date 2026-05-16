// src/security/wall-cap.ts
//
// v0.1.36 — session-level wall-clock cap enforcer.
//
// Pre-v0.1.36, bench/webvoyager/run-one-task.sh exported MAX_WALL_MS with
// the comment "the in-process LoopDetector + ThrashDetector in
// src/security/loop-detector.ts is the enforcement." That claim was
// false: no source file ever read the env var, and the ERROR_CODES
// entries WALL_CAP_EXCEEDED / STEP_CAP_EXCEEDED were declared but no
// SafariPilotError subclass threw them. Bench tasks regularly ran 25-30+
// minutes past the "20 minute" budget, blowing up the projected wall
// clock of the 50-task probe to 5-6 hours and corrupting the full
// 641-task bench's runtime estimate.
//
// WallCapEnforcer is the missing layer. The MCP server constructs one
// per session in its `start()` path (after reading
// `process.env.MAX_WALL_MS`); `executeToolWithSecurity` calls
// `assertWithinCap()` at the top of every tool dispatch, BEFORE the
// security pipeline runs other expensive checks. If the elapsed wall
// since session start exceeds the cap, throws WallCapExceededError; the
// agent receives a JSON-RPC error and (per its prompt instructions and
// our hint payload) voluntarily ABSTAINs.
//
// Design notes:
//   - Strictly checks `elapsed > cap` (inclusive boundary at cap value).
//   - When the cap is undefined / zero / negative / non-numeric, the
//     enforcer is a no-op: production behaviour pre-v0.1.36, and tests
//     that don't set MAX_WALL_MS see no change.
//   - Clock is injected (default `Date.now`) so unit tests can drive
//     elapsed time deterministically without timing flakes.
//   - `remainingMs()` is provided so callers can include the agent's
//     remaining budget in higher-level error messages or telemetry.
//
// Step cap (MAX_TURNS) is intentionally NOT enforced server-side. Tool
// calls per agent-turn vary wildly (0..N), so the MCP server can't
// meaningfully count turns. The agent prompt already advises a 25-turn
// budget; the LoopDetector catches degenerate same-call loops; further
// step enforcement would require coupling to the claude CLI's turn
// counter, which is out of scope for v0.1.36.

import { WallCapExceededError } from '../errors.js';

export type ClockFn = () => number;

export class WallCapEnforcer {
  private readonly maxMs: number | undefined;
  private readonly clock: ClockFn;
  private readonly startedAt: number;

  /**
   * @param maxMs - Wall-clock cap in milliseconds. `undefined` disables enforcement.
   * @param clock - Time source. Defaults to `Date.now`. Injectable for tests.
   */
  constructor(maxMs: number | undefined, clock: ClockFn = Date.now) {
    this.maxMs = maxMs;
    this.clock = clock;
    this.startedAt = clock();
  }

  /**
   * Construct an enforcer from a process.env-like map. Parses MAX_WALL_MS.
   * Non-numeric / zero / negative / missing values produce a no-op enforcer.
   */
  static fromEnv(env: Record<string, string | undefined>, clock: ClockFn = Date.now): WallCapEnforcer {
    const raw = env['MAX_WALL_MS'];
    if (raw === undefined) return new WallCapEnforcer(undefined, clock);
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return new WallCapEnforcer(undefined, clock);
    return new WallCapEnforcer(parsed, clock);
  }

  /**
   * Throws WallCapExceededError when elapsed wall (relative to construction
   * time) exceeds maxMs. When the cap is undefined, never throws. Boundary
   * is inclusive at the cap value — calls right at maxMs still pass.
   *
   * @param elapsedMsOverride - Explicit elapsed value, used by tests. In
   *   production, callers pass nothing and the enforcer derives elapsed
   *   from `clock() - startedAt`.
   */
  assertWithinCap(elapsedMsOverride?: number): void {
    if (this.maxMs === undefined) return;
    const elapsedMs = elapsedMsOverride !== undefined
      ? elapsedMsOverride
      : this.clock() - this.startedAt;
    if (elapsedMs > this.maxMs) {
      throw new WallCapExceededError(this.maxMs, elapsedMs);
    }
  }

  /**
   * How many milliseconds remain before the cap fires. Returns +Infinity
   * when uncapped. Clamps at zero when already over (never negative —
   * "remaining" is semantically a budget, not a deficit).
   */
  remainingMs(elapsedMsOverride?: number): number {
    if (this.maxMs === undefined) return Number.POSITIVE_INFINITY;
    const elapsedMs = elapsedMsOverride !== undefined
      ? elapsedMsOverride
      : this.clock() - this.startedAt;
    const remaining = this.maxMs - elapsedMs;
    return remaining > 0 ? remaining : 0;
  }
}
