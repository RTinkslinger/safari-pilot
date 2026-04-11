import { KillSwitchActiveError } from '../errors.js';
import { AuditLog } from './audit-log.js';

// ─── KillSwitch ──────────────────────────────────────────────────────────────
//
// Emergency stop mechanism for the safari-pilot agent. When activated, all
// subsequent automation actions are blocked until explicitly deactivated.
//
// Activation is permanent within a session — deactivation requires a deliberate
// call. Every activation and deactivation event is written to the audit log.

export interface ActivationState {
  active: boolean;
  reason?: string;
  activatedAt?: string;
}

export interface AutoActivationThreshold {
  /** Number of errors that triggers auto-activation. */
  maxErrors: number;
  /** Rolling window (seconds) within which errors are counted. */
  windowSeconds: number;
}

interface ErrorTimestamp {
  at: number; // Date.now() ms
}

// ─── KillSwitch ──────────────────────────────────────────────────────────────

export class KillSwitch {
  private _active = false;
  private _reason: string | undefined;
  private _activatedAt: string | undefined;

  private readonly auditLog: AuditLog | undefined;
  private readonly threshold: AutoActivationThreshold | undefined;
  private readonly errorWindow: ErrorTimestamp[] = [];

  constructor(options?: {
    auditLog?: AuditLog;
    autoActivation?: AutoActivationThreshold;
  }) {
    this.auditLog = options?.auditLog;
    this.threshold = options?.autoActivation;
  }

  // ── Core API ────────────────────────────────────────────────────────────────

  /**
   * Activate the kill switch. All subsequent `checkBeforeAction` calls will
   * throw `KillSwitchActiveError` until `deactivate` is called.
   */
  activate(reason: string): void {
    this._active = true;
    this._reason = reason;
    this._activatedAt = new Date().toISOString();

    this.auditLog?.record({
      tool: 'kill_switch',
      tabUrl: '',
      engine: 'applescript',
      params: { action: 'activate', reason },
      result: 'ok',
      elapsed_ms: 0,
      session: 'kill-switch',
    });
  }

  /**
   * Deactivate the kill switch, re-enabling automation.
   */
  deactivate(): void {
    const wasActive = this._active;
    this._active = false;
    this._reason = undefined;
    this._activatedAt = undefined;
    this.errorWindow.length = 0;

    if (wasActive) {
      this.auditLog?.record({
        tool: 'kill_switch',
        tabUrl: '',
        engine: 'applescript',
        params: { action: 'deactivate' },
        result: 'ok',
        elapsed_ms: 0,
        session: 'kill-switch',
      });
    }
  }

  /**
   * Returns true if the kill switch is currently active.
   */
  isActive(): boolean {
    return this._active;
  }

  /**
   * Returns the current activation state including reason and timestamp.
   */
  getActivation(): ActivationState {
    if (!this._active) {
      return { active: false };
    }
    return {
      active: true,
      reason: this._reason,
      activatedAt: this._activatedAt,
    };
  }

  // ── Guard ────────────────────────────────────────────────────────────────────

  /**
   * Call before every automation action. Throws `KillSwitchActiveError` if the
   * kill switch is active, otherwise returns normally.
   */
  checkBeforeAction(): void {
    if (this._active) {
      throw new KillSwitchActiveError(this._reason ?? 'kill switch activated');
    }
  }

  // ── Auto-activation ──────────────────────────────────────────────────────────

  /**
   * Record an error event. If the configured threshold is exceeded within the
   * rolling window, the kill switch auto-activates.
   */
  recordError(): void {
    if (!this.threshold) return;

    const now = Date.now();
    const windowStart = now - this.threshold.windowSeconds * 1000;

    // Evict timestamps outside the rolling window
    while (this.errorWindow.length > 0 && this.errorWindow[0]!.at < windowStart) {
      this.errorWindow.shift();
    }

    this.errorWindow.push({ at: now });

    if (this.errorWindow.length >= this.threshold.maxErrors) {
      this.activate(
        `Auto-activated: ${this.errorWindow.length} errors in ${this.threshold.windowSeconds}s window`,
      );
    }
  }
}
