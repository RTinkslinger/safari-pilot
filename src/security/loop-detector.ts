/**
 * v0.1.35 Task 5 — Anti-thrash controls.
 *
 * Two related detectors that catch an agent stuck in a degenerate loop:
 *
 *   1. LOOP: same (tool, key-args) called LOOP_THRESHOLD times in a row,
 *      regardless of result. Caught PRE-execution so the loop is broken
 *      before the next wasted call lands in Safari.
 *
 *   2. THRASH: safari_snapshot returns identical content THRASH_THRESHOLD
 *      times in a row. Caught POST-execution since we need the result to
 *      compare. The page is fundamentally not changing — agent strategy
 *      must change.
 *
 * Both detectors throw concrete SafariPilotError subclasses
 * (LoopDetectedError, ThrashDetectedError). Both errors are classified as
 * security-pipeline errors in `server.ts isSecurityPipelineError`, so they
 * do NOT feed the kill-switch auto-activation rolling window — they're
 * guardrails, not tool failures.
 *
 * State is session-scoped (per LoopDetector instance) and reset on
 * safari_health_check (interpreted as a deliberate session-restart signal).
 */
import { LoopDetectedError, ThrashDetectedError } from '../errors.js';

const LOOP_THRESHOLD = 5;
const THRASH_THRESHOLD = 4;

interface CallRecord {
  tool: string;
  keyArgs: string;
}

export class LoopDetector {
  private callHistory: CallRecord[] = [];
  private snapshotResultHistory: string[] = [];

  /**
   * Called BEFORE the tool executes. If the last LOOP_THRESHOLD calls all
   * share the same (tool, keyArgs) — including this new one — throw.
   */
  preCheck(tool: string, params: Record<string, unknown>): void {
    const keyArgs = this.extractKeyArgs(params);
    this.callHistory.push({ tool, keyArgs });
    if (this.callHistory.length > LOOP_THRESHOLD) {
      this.callHistory.shift();
    }
    if (this.callHistory.length === LOOP_THRESHOLD) {
      const allEqual = this.callHistory.every(
        (c) => c.tool === tool && c.keyArgs === keyArgs,
      );
      if (allEqual) {
        // Keep history populated — if the agent keeps making the same
        // call, every subsequent attempt also trips. The detector only
        // clears on `reset()` (safari_health_check).
        throw new LoopDetectedError(tool, LOOP_THRESHOLD);
      }
    }
  }

  /**
   * Called AFTER safari_snapshot succeeds. If the last THRASH_THRESHOLD
   * snapshot results are byte-identical, throw.
   *
   * Caller is responsible for passing a STABLE serialization of the result
   * — volatile fields (timestamps, latency, request IDs) must be stripped
   * before this is called. See server.ts post-execution hook.
   */
  recordSnapshotResult(serializedResult: string): void {
    this.snapshotResultHistory.push(serializedResult);
    if (this.snapshotResultHistory.length > THRASH_THRESHOLD) {
      this.snapshotResultHistory.shift();
    }
    if (this.snapshotResultHistory.length === THRASH_THRESHOLD) {
      const allEqual = this.snapshotResultHistory.every(
        (r) => r === serializedResult,
      );
      if (allEqual) {
        // Keep history; every subsequent identical snapshot trips too.
        // Detector only clears on `reset()` (safari_health_check).
        throw new ThrashDetectedError(THRASH_THRESHOLD);
      }
    }
  }

  /**
   * Reset both windows. Called on safari_health_check (treated as a
   * deliberate session-restart signal by the agent).
   */
  reset(): void {
    this.callHistory = [];
    this.snapshotResultHistory = [];
  }

  /**
   * Build a stable string key from the params shape we care about.
   *
   * Excludes ephemeral fields (timeout, _windowId, _tabIndex, _sessionWindowId)
   * that the security pipeline injects, and that vary across otherwise-identical
   * agent calls. Targets the same identity an agent would consider the
   * "same call": the tab + the locator.
   */
  private extractKeyArgs(params: Record<string, unknown>): string {
    const tabUrl = (params['tabUrl'] ?? params['url'] ?? params['tabId'] ?? '') as unknown;
    const locator = params['locator'] as Record<string, unknown> | undefined;
    // Pick the dominant locator key — agents typically use one of these
    // at a time. JSON.stringify on the whole locator would also vary on
    // key ordering between calls, so we extract a flat string.
    const locKey =
      locator?.['selector']
      ?? locator?.['text']
      ?? locator?.['role']
      ?? locator?.['testId']
      ?? locator?.['ref']
      ?? '';
    // Flat-locator forms (selector / role / text / ref passed directly).
    const flatKey =
      (params['selector'] as unknown)
      ?? (params['ref'] as unknown)
      ?? (params['role'] as unknown)
      ?? (params['testId'] as unknown)
      ?? '';
    return JSON.stringify({ tabUrl, locKey, flatKey });
  }
}
