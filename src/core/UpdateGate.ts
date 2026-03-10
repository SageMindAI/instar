/**
 * UpdateGate — Session-aware restart gating.
 *
 * Checks whether it's safe to restart the server for an update.
 * Only 'healthy' (actively producing output) sessions block restarts.
 * 'unresponsive', 'idle', and 'dead' sessions don't — blocking an update
 * for a broken session serves no user interest.
 *
 * Healthy sessions are NEVER killed for an update. The gate defers indefinitely
 * while healthy sessions exist, sending warnings at the configured thresholds.
 */

export interface SessionInfo {
  name: string;
  topicId?: number;
}

export interface SessionHealthEntry {
  topicId: number;
  sessionName: string;
  status: string;   // 'healthy' | 'idle' | 'unresponsive' | 'dead'
  idleMinutes: number;
}

export interface GateResult {
  allowed: boolean;
  reason?: string;
  retryInMs?: number;
  /** Sessions that are actively blocking the restart */
  blockingSessions?: string[];
  /** Sessions that are unresponsive (warned but not blocking) */
  unresponsiveSessions?: string[];
}

export interface UpdateGateConfig {
  /** Maximum hours to defer a restart for active sessions. Default: 4 */
  maxDeferralHours?: number;
  /** Minutes before forced restart to send first warning. Default: 30 */
  firstWarningMinutes?: number;
  /** Minutes before forced restart to send final warning. Default: 5 */
  finalWarningMinutes?: number;
  /** How often to re-check sessions during deferral, in ms. Default: 5 * 60_000 (5 min) */
  retryIntervalMs?: number;
}

export interface UpdateGateStatus {
  /** Whether a restart is currently being deferred */
  deferring: boolean;
  /** When deferral started */
  deferralStartedAt: string | null;
  /** How long we've been deferring, in minutes */
  deferralElapsedMinutes: number;
  /** Max deferral before forced restart */
  maxDeferralHours: number;
  /** Reason for current deferral */
  deferralReason: string | null;
  /** Whether the first warning (T-30min) has been sent */
  firstWarningSent: boolean;
  /** Whether the final warning (T-5min) has been sent */
  finalWarningSent: boolean;
}

/** Minimal interface for SessionManager — only what we need */
export interface SessionManagerLike {
  listRunningSessions(): SessionInfo[];
}

/** Minimal interface for SessionMonitor — only what we need */
export interface SessionMonitorLike {
  getStatus(): {
    sessionHealth: SessionHealthEntry[];
  };
}

export class UpdateGate {
  private config: Required<UpdateGateConfig>;
  private deferralStartedAt: number | null = null;
  private deferralReason: string | null = null;
  private firstWarningSent = false;
  private firstWarningPending = false;
  private finalWarningSent = false;
  private finalWarningPending = false;

  constructor(config?: UpdateGateConfig) {
    this.config = {
      maxDeferralHours: config?.maxDeferralHours ?? 4,
      firstWarningMinutes: config?.firstWarningMinutes ?? 30,
      finalWarningMinutes: config?.finalWarningMinutes ?? 5,
      retryIntervalMs: config?.retryIntervalMs ?? 5 * 60_000,
    };
  }

  /**
   * Check if it's safe to restart now.
   *
   * Returns { allowed: true } if restart can proceed.
   * Returns { allowed: false, retryInMs, reason } if sessions are blocking.
   */
  canRestart(
    sessionManager: SessionManagerLike,
    sessionMonitor?: SessionMonitorLike | null,
  ): GateResult {
    const sessions = sessionManager.listRunningSessions();

    // No sessions → restart immediately
    if (sessions.length === 0) {
      this.reset();
      return { allowed: true };
    }

    // Check session health if monitor is available
    const health = sessionMonitor?.getStatus().sessionHealth ?? [];
    const healthMap = new Map(health.map(h => [h.sessionName, h]));

    const activeSessions: string[] = [];
    const unresponsiveSessions: string[] = [];

    for (const session of sessions) {
      const h = healthMap.get(session.name);
      if (!h) {
        // No health data — be conservative, treat as active
        activeSessions.push(session.name);
      } else if (h.status === 'healthy') {
        activeSessions.push(session.name);
      } else if (h.status === 'unresponsive') {
        unresponsiveSessions.push(session.name);
      }
      // 'idle' and 'dead' sessions don't block
    }

    // No active sessions → restart (idle/dead/unresponsive don't block)
    if (activeSessions.length === 0) {
      this.reset();
      return {
        allowed: true,
        unresponsiveSessions: unresponsiveSessions.length > 0 ? unresponsiveSessions : undefined,
      };
    }

    // Active sessions exist — start or continue deferral
    if (!this.deferralStartedAt) {
      this.deferralStartedAt = Date.now();
    }

    const elapsedMs = Date.now() - this.deferralStartedAt;
    const maxDeferralMs = this.config.maxDeferralHours * 60 * 60_000;
    const remainingMs = maxDeferralMs - elapsedMs;

    this.deferralReason = `${activeSessions.length} active session(s): ${activeSessions.join(', ')}`;

    // Max deferral exceeded — but only force restart if no HEALTHY sessions.
    // Active, healthy sessions should NEVER be killed for an update.
    // The update can wait — the user's work cannot.
    if (remainingMs <= 0) {
      console.log(`[UpdateGate] Max deferral (${this.config.maxDeferralHours}h) exceeded, but ${activeSessions.length} healthy session(s) still running — continuing to defer`);
    }

    // Check warning thresholds
    const remainingMinutes = remainingMs / 60_000;

    if (remainingMinutes <= this.config.finalWarningMinutes && !this.finalWarningSent) {
      this.finalWarningSent = true;
      this.finalWarningPending = true;
    }

    if (remainingMinutes <= this.config.firstWarningMinutes && !this.firstWarningSent) {
      this.firstWarningSent = true;
      this.firstWarningPending = true;
    }

    return {
      allowed: false,
      reason: this.deferralReason,
      retryInMs: this.config.retryIntervalMs,
      blockingSessions: activeSessions,
      unresponsiveSessions: unresponsiveSessions.length > 0 ? unresponsiveSessions : undefined,
    };
  }

  /**
   * Get current gate status for observability.
   */
  getStatus(): UpdateGateStatus {
    const elapsedMs = this.deferralStartedAt ? Date.now() - this.deferralStartedAt : 0;
    return {
      deferring: this.deferralStartedAt !== null,
      deferralStartedAt: this.deferralStartedAt ? new Date(this.deferralStartedAt).toISOString() : null,
      deferralElapsedMinutes: Math.round(elapsedMs / 60_000),
      maxDeferralHours: this.config.maxDeferralHours,
      deferralReason: this.deferralReason,
      firstWarningSent: this.firstWarningSent,
      finalWarningSent: this.finalWarningSent,
    };
  }

  /**
   * Whether the first warning (T-30min before forced restart) should fire.
   * Returns true exactly once — consumes the flag on read.
   */
  shouldSendFirstWarning(): boolean {
    if (this.firstWarningPending) {
      this.firstWarningPending = false;
      return true;
    }
    return false;
  }

  /**
   * Whether the final warning (T-5min before forced restart) should fire.
   * Returns true exactly once — consumes the flag on read.
   */
  shouldSendFinalWarning(): boolean {
    if (this.finalWarningPending) {
      this.finalWarningPending = false;
      return true;
    }
    return false;
  }

  /**
   * Reset deferral state (called after restart proceeds or update is cancelled).
   */
  reset(): void {
    this.deferralStartedAt = null;
    this.deferralReason = null;
    this.firstWarningSent = false;
    this.firstWarningPending = false;
    this.finalWarningSent = false;
    this.finalWarningPending = false;
  }
}
