/**
 * SessionMigrator — Orchestrates session halt, account switch, and restart
 * when quota approaches reserve thresholds.
 *
 * Ported from Dawn's dawn-server equivalent for general Instar use.
 * Adapted to use Instar's SessionManager, StateManager, and EventEmitter.
 *
 * Migration flow:
 * 1. Pause scheduler (prevent new spawns)
 * 2. Find best alternative account
 * 3. Gracefully halt running sessions (Ctrl+C → wait → kill)
 * 4. Switch account credentials
 * 5. Restart halted sessions on new account
 * 6. Resume scheduler
 *
 * Part of the Instar Quota Migration spec (Phase 3).
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { DegradationReporter } from './DegradationReporter.js';

// ── Types ────────────────────────────────────────────────────────────

export interface MigrationThresholds {
  /** 5-hour rate limit trigger (default 88%) */
  fiveHourPercent: number;
  /** Weekly budget trigger (default 92%) */
  weeklyPercent: number;
  /** Cooldown between migrations in ms (default 10 min) */
  cooldownMs: number;
  /** Minimum weekly headroom required on target account (default 20) */
  minimumHeadroom: number;
  /** Grace period for session shutdown in ms (default 5000) */
  gracePeriodMs: number;
}

export interface MigrationEvent {
  triggeredAt: string;
  reason: string;
  previousAccount: string | null;
  newAccount: string | null;
  sessionsHalted: string[];
  sessionsRestarted: string[];
  result: 'success' | 'partial' | 'failed' | 'no_alternative' | 'rolled_back' | 'enforced_pause' | 'enforced_kill';
  completedAt: string;
  durationMs: number;
  error?: string;
}

export interface MigrationState {
  status: 'idle' | 'halting' | 'switching' | 'restarting' | 'complete' | 'failed' | 'rolling_back';
  startedAt?: string;
  sourceAccount: string;
  targetAccount: string;
  haltedSessions: Array<{ sessionId: string; jobSlug: string; haltedAt: string }>;
  restartedSessions: Array<{ sessionId: string; jobSlug: string; startedAt: string }>;
  error?: string;
}

export interface MigrationHistory {
  lastMigration: MigrationEvent | null;
  migrations: MigrationEvent[];
}

export interface AccountSnapshot {
  email: string;
  name: string | null;
  isActive: boolean;
  hasToken: boolean;
  tokenExpired: boolean;
  isStale: boolean;
  weeklyPercent: number;
  fiveHourPercent: number | null;
  weeklyResetsAt?: string | null;
}

export interface HaltableSession {
  id: string;
  tmuxSession: string;
  jobSlug?: string;
  name: string;
}

/** Callbacks for integration with JobScheduler and SessionManager */
export interface SessionMigratorDeps {
  /** List running sessions that can be halted */
  listRunningSessions: () => HaltableSession[];
  /** Send Ctrl+C to a session for graceful shutdown */
  sendKey: (tmuxSession: string, key: string) => boolean;
  /** Kill a session by its ID */
  killSession: (sessionId: string) => boolean;
  /** Check if a session is still alive */
  isSessionAlive: (tmuxSession: string) => boolean;
  /** Pause the scheduler to prevent new spawns */
  pauseScheduler: () => void;
  /** Resume the scheduler */
  resumeScheduler: () => void;
  /** Respawn a job by slug */
  respawnJob: (slug: string) => Promise<void>;
  /** Get all account statuses from the account switcher */
  getAccountStatuses: () => AccountSnapshot[];
  /** Switch to a target account */
  switchAccount: (email: string) => Promise<{ success: boolean; message: string }>;
}

export interface SessionMigratorConfig {
  /** Directory for state persistence (migration state, lock file, history) */
  stateDir: string;
  /** Migration thresholds (all optional, has defaults) */
  thresholds?: Partial<MigrationThresholds>;
}

// ── Events ───────────────────────────────────────────────────────────

export interface SessionMigratorEvents {
  /** Migration started */
  migration_started: [event: { reason: string; sourceAccount: string; targetAccount: string }];
  /** Migration completed successfully */
  migration_complete: [event: MigrationEvent];
  /** Migration partially succeeded (some sessions failed to restart) */
  migration_partial: [event: MigrationEvent];
  /** Migration failed */
  migration_failed: [event: MigrationEvent];
  /** No alternative account available */
  migration_no_target: [event: { reason: string; sourceAccount: string }];
  /** Quota enforcement: sessions warned to pause (90%+) */
  enforced_pause: [event: { reason: string; fiveHourPercent: number; sessionsSignaled: number }];
  /** Quota enforcement: all sessions killed (95%+) */
  enforced_kill: [event: { reason: string; fiveHourPercent: number; sessionsKilled: string[] }];
  /** Migration was rolled back */
  migration_rollback: [event: MigrationEvent];
  /** State changed (for external monitoring) */
  state_changed: [state: MigrationState];
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: MigrationThresholds = {
  fiveHourPercent: 88,
  weeklyPercent: 92,
  cooldownMs: 10 * 60 * 1000, // 10 minutes
  minimumHeadroom: 20,
  gracePeriodMs: 5000,
};

const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes
const MAX_HISTORY = 50;
const ACCOUNT_SETTLE_MS = 2000; // Brief pause after account switch

// ── Implementation ───────────────────────────────────────────────────

export class SessionMigrator extends EventEmitter {
  private deps: SessionMigratorDeps | null = null;
  private thresholds: MigrationThresholds;
  private stateDir: string;
  private lockPath: string;
  private statePath: string;
  private historyPath: string;
  private migrationState: MigrationState | null = null;

  constructor(config: SessionMigratorConfig) {
    super();
    this.stateDir = config.stateDir;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...config.thresholds };
    this.lockPath = path.join(this.stateDir, 'migration.lock');
    this.statePath = path.join(this.stateDir, 'migration-state.json');
    this.historyPath = path.join(this.stateDir, 'migration-history.json');

    // Ensure state directory exists
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }

    // Check for incomplete migration from a crash
    this.recoverFromCrash();
  }

  /**
   * Set dependencies for integration with SessionManager and JobScheduler.
   * Must be called before checkAndMigrate().
   */
  setDeps(deps: SessionMigratorDeps): void {
    this.deps = deps;
  }

  /**
   * Main entry point — called after each quota refresh.
   * Checks if migration is needed and triggers it if so.
   */
  async checkAndMigrate(quotaState: {
    percentUsed: number;
    fiveHourPercent?: number | null;
    activeAccountEmail?: string | null;
  }): Promise<boolean> {
    if (!this.deps) {
      return false;
    }

    // Don't trigger if migration is in progress
    if (this.migrationState && this.migrationState.status !== 'idle' &&
        this.migrationState.status !== 'complete' && this.migrationState.status !== 'failed') {
      return false;
    }

    // Check cooldown — but bypass for escalation from enforced_pause to enforced_kill.
    // If the last event was a 90% warning and quota has risen to 95%+, the kill
    // must fire immediately regardless of cooldown.
    const history = this.loadHistory();
    if (history.lastMigration) {
      const elapsed = Date.now() - new Date(history.lastMigration.completedAt).getTime();
      if (elapsed < this.thresholds.cooldownMs) {
        const fiveHour = quotaState.fiveHourPercent ?? 0;
        const lastWasPause = history.lastMigration.result === 'enforced_pause';
        const nowCritical = fiveHour >= 95;

        if (!(lastWasPause && nowCritical)) {
          return false;
        }
        // Allow escalation from pause to kill
      }
    }

    // Check if migration is needed
    const reason = this.shouldMigrate(quotaState);
    if (!reason) {
      return false;
    }

    return await this.executeMigration(
      quotaState.activeAccountEmail || null,
      reason,
      quotaState.fiveHourPercent ?? 0,
    );
  }

  /**
   * Determine if migration should be triggered.
   */
  private shouldMigrate(quotaState: {
    percentUsed: number;
    fiveHourPercent?: number | null;
  }): string | null {
    // Check 5-hour rate limit (most urgent — causes immediate failures)
    const fiveHour = quotaState.fiveHourPercent;
    if (fiveHour != null && fiveHour >= this.thresholds.fiveHourPercent) {
      return `5-hour rate limit at ${fiveHour}% (threshold: ${this.thresholds.fiveHourPercent}%)`;
    }

    // Check weekly budget
    if (quotaState.percentUsed >= this.thresholds.weeklyPercent) {
      return `weekly quota at ${quotaState.percentUsed}% (threshold: ${this.thresholds.weeklyPercent}%)`;
    }

    return null;
  }

  /**
   * Execute the full migration flow with rollback support.
   */
  private async executeMigration(
    activeAccountEmail: string | null,
    reason: string,
    fiveHourPercent: number = 0,
  ): Promise<boolean> {
    // Acquire lock
    if (!this.acquireLock()) {
      return false;
    }

    const startTime = Date.now();
    const event: MigrationEvent = {
      triggeredAt: new Date().toISOString(),
      reason,
      previousAccount: activeAccountEmail,
      newAccount: null,
      sessionsHalted: [],
      sessionsRestarted: [],
      result: 'failed',
      completedAt: '',
      durationMs: 0,
    };

    try {
      // Step 1: Find best alternative account
      const target = this.selectMigrationTarget();
      if (!target) {
        // No alternative account — enforce quota protection based on severity.
        // The entire purpose of the quota system is to prevent hitting the limit,
        // so we MUST enforce, not just silently record.

        if (fiveHourPercent >= 95) {
          // CRITICAL: 95%+ — absolute stop. Kill everything to preserve quota.
          event.result = 'enforced_kill';
          event.completedAt = new Date().toISOString();
          event.durationMs = Date.now() - startTime;

          this.deps!.pauseScheduler();
          const killed = await this.haltRunningSessions();
          event.sessionsHalted = killed.map(s => s.jobSlug || s.name);

          this.emit('enforced_kill', {
            reason,
            fiveHourPercent,
            sessionsKilled: event.sessionsHalted,
          });

          this.recordMigration(event);
          return false;

        } else if (fiveHourPercent >= 90) {
          // WARNING: 90%+ — send graceful shutdown to sessions, pause scheduler.
          event.result = 'enforced_pause';
          event.completedAt = new Date().toISOString();
          event.durationMs = Date.now() - startTime;

          // Send Ctrl+C to all running sessions
          const sessions = this.deps!.listRunningSessions();
          for (const session of sessions) {
            try {
              this.deps!.sendKey(session.tmuxSession, 'C-c');
            } catch { /* @silent-fallback-ok — best-effort signal, session will be killed at 95% if still running */ }
          }

          this.deps!.pauseScheduler();

          this.emit('enforced_pause', {
            reason,
            fiveHourPercent,
            sessionsSignaled: sessions.length,
          });

          this.recordMigration(event);
          return false;

        } else {
          // Below 90% — warn but don't enforce yet
          event.result = 'no_alternative';
          event.completedAt = new Date().toISOString();
          event.durationMs = Date.now() - startTime;
          this.emit('migration_no_target', {
            reason,
            sourceAccount: activeAccountEmail || 'unknown',
          });
          this.recordMigration(event);
          return false;
        }
      }

      event.newAccount = target.email;

      // Initialize migration state
      this.migrationState = {
        status: 'halting',
        startedAt: new Date().toISOString(),
        sourceAccount: activeAccountEmail || 'unknown',
        targetAccount: target.email,
        haltedSessions: [],
        restartedSessions: [],
      };
      this.saveMigrationState();
      this.emit('state_changed', { ...this.migrationState });

      // Step 2: Emit start event
      this.emit('migration_started', {
        reason,
        sourceAccount: activeAccountEmail || 'unknown',
        targetAccount: target.email,
      });

      // Step 3: Pause scheduler
      this.deps!.pauseScheduler();

      // Step 4: Gracefully halt running sessions
      const haltedSessions = await this.haltRunningSessions();
      event.sessionsHalted = haltedSessions.map(s => s.jobSlug || s.name);
      this.migrationState.haltedSessions = haltedSessions.map(s => ({
        sessionId: s.id,
        jobSlug: s.jobSlug || s.name,
        haltedAt: new Date().toISOString(),
      }));
      this.saveMigrationState();

      // Step 5: Switch account
      this.migrationState.status = 'switching';
      this.saveMigrationState();
      this.emit('state_changed', { ...this.migrationState });

      const switchResult = await this.deps!.switchAccount(target.email);

      if (!switchResult.success) {
        // Rollback: halt succeeded but switch failed — restart on original account
        this.migrationState.status = 'rolling_back';
        this.migrationState.error = `Account switch failed: ${switchResult.message}`;
        this.saveMigrationState();
        this.emit('state_changed', { ...this.migrationState });

        await this.rollbackRestartSessions(haltedSessions);

        this.deps!.resumeScheduler();

        event.result = 'rolled_back';
        event.error = switchResult.message;
        event.completedAt = new Date().toISOString();
        event.durationMs = Date.now() - startTime;
        this.emit('migration_rollback', event);
        this.recordMigration(event);
        return false;
      }

      // Step 6: Brief pause to let credentials settle
      await this.sleep(ACCOUNT_SETTLE_MS);

      // Step 7: Restart halted sessions on new account
      this.migrationState.status = 'restarting';
      this.saveMigrationState();
      this.emit('state_changed', { ...this.migrationState });

      const restartedSlugs: string[] = [];
      for (const session of haltedSessions) {
        const slug = session.jobSlug || session.name;
        try {
          await this.deps!.respawnJob(slug);
          restartedSlugs.push(slug);
          this.migrationState.restartedSessions.push({
            sessionId: session.id,
            jobSlug: slug,
            startedAt: new Date().toISOString(),
          });
          this.saveMigrationState();
        } catch (err) {
          console.error(`[SessionMigrator] Failed to restart ${slug}:`, err);
        }
      }
      event.sessionsRestarted = restartedSlugs;

      // Step 8: Resume scheduler
      this.deps!.resumeScheduler();

      // Step 9: Determine result
      if (restartedSlugs.length === haltedSessions.length) {
        event.result = 'success';
        this.migrationState.status = 'complete';
      } else {
        event.result = 'partial';
        this.migrationState.status = 'complete';
        const failedSlugs = haltedSessions
          .map(s => s.jobSlug || s.name)
          .filter(slug => !restartedSlugs.includes(slug));
        this.migrationState.error = `Failed to restart: ${failedSlugs.join(', ')}`;
      }

      event.completedAt = new Date().toISOString();
      event.durationMs = Date.now() - startTime;
      this.saveMigrationState();

      // Step 10: Emit completion
      if (event.result === 'success') {
        this.emit('migration_complete', event);
      } else {
        this.emit('migration_partial', event);
      }

      this.recordMigration(event);
      return true;

    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'SessionMigrator.executeMigration',
        primary: 'Migrate sessions to alternative account on quota exhaustion',
        fallback: 'Migration failed, sessions may remain on exhausted account',
        reason: `Migration error: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Sessions may hit rate limits until migration succeeds or quota resets',
      });
      console.error('[SessionMigrator] Migration error:', err);
      event.result = 'failed';
      event.error = err instanceof Error ? err.message : String(err);
      event.completedAt = new Date().toISOString();
      event.durationMs = Date.now() - startTime;

      if (this.migrationState) {
        this.migrationState.status = 'failed';
        this.migrationState.error = event.error;
        this.saveMigrationState();
      }

      // Ensure scheduler is resumed even on error
      try { this.deps!.resumeScheduler(); } catch { // @silent-fallback-ok — best-effort scheduler resume after migration failure
      }

      this.emit('migration_failed', event);
      this.recordMigration(event);
      return false;

    } finally {
      this.releaseLock();
    }
  }

  /**
   * Gracefully halt running sessions:
   * 1. Send Ctrl+C to each session
   * 2. Wait grace period for them to flush state
   * 3. Kill any that are still alive
   */
  private async haltRunningSessions(): Promise<HaltableSession[]> {
    if (!this.deps) return [];

    const sessions = this.deps.listRunningSessions();
    if (sessions.length === 0) return [];

    // Phase 1: Send Ctrl+C to all sessions
    for (const session of sessions) {
      try {
        this.deps.sendKey(session.tmuxSession, 'C-c');
      } catch (err) {
        console.error(`[SessionMigrator] Failed to send C-c to ${session.tmuxSession}:`, err);
      }
    }

    // Phase 2: Wait for grace period
    await this.sleep(this.thresholds.gracePeriodMs);

    // Phase 3: Kill any sessions still alive
    const halted: HaltableSession[] = [];
    for (const session of sessions) {
      try {
        if (this.deps.isSessionAlive(session.tmuxSession)) {
          this.deps.killSession(session.id);
        }
        halted.push(session);
      } catch (err) {
        console.error(`[SessionMigrator] Failed to kill ${session.tmuxSession}:`, err);
        // Still record it as halted — it may have died from Ctrl+C
        halted.push(session);
      }
    }

    return halted;
  }

  /**
   * Rollback: restart sessions on the original account after a failed switch.
   */
  private async rollbackRestartSessions(sessions: HaltableSession[]): Promise<void> {
    if (!this.deps) return;

    for (const session of sessions) {
      const slug = session.jobSlug || session.name;
      try {
        await this.deps.respawnJob(slug);
      } catch (err) {
        DegradationReporter.getInstance().report({
          feature: 'SessionMigrator.rollbackRestartSessions',
          primary: `Restart session ${slug} during migration rollback`,
          fallback: `Session ${slug} left halted after failed rollback`,
          reason: `Rollback restart failed: ${err instanceof Error ? err.message : String(err)}`,
          impact: `Job ${slug} is not running and requires manual restart`,
        });
        console.error(`[SessionMigrator] Rollback restart failed for ${slug}:`, err);
      }
    }
  }

  /**
   * Select the best account to migrate to.
   *
   * Algorithm:
   * 1. Filter: Exclude stale, expired, current, and accounts without tokens
   * 2. Filter: Must have minimum headroom (default 20%)
   * 3. Score: 100 - weeklyPercent (lower usage = higher score)
   * 4. Tiebreak: Prefer account with later weeklyResetsAt
   */
  selectMigrationTarget(): AccountSnapshot | null {
    if (!this.deps) return null;

    const accounts = this.deps.getAccountStatuses();
    const maxUsage = 100 - this.thresholds.minimumHeadroom;

    const candidates = accounts
      .filter(a => !a.isActive && !a.isStale && a.hasToken && !a.tokenExpired)
      .filter(a => a.weeklyPercent <= maxUsage)
      .filter(a => {
        // Also check 5-hour rate limit has headroom
        if (a.fiveHourPercent != null && a.fiveHourPercent >= 70) return false;
        return true;
      })
      .sort((a, b) => {
        // Primary: lowest weekly usage
        if (a.weeklyPercent !== b.weeklyPercent) {
          return a.weeklyPercent - b.weeklyPercent;
        }
        // Tiebreak: later reset time (more time before reset)
        const aReset = a.weeklyResetsAt ? new Date(a.weeklyResetsAt).getTime() : 0;
        const bReset = b.weeklyResetsAt ? new Date(b.weeklyResetsAt).getTime() : 0;
        return bReset - aReset;
      });

    return candidates[0] ?? null;
  }

  // ── Lock Management ─────────────────────────────────────────────────

  private acquireLock(): boolean {
    try {
      if (fs.existsSync(this.lockPath)) {
        const lockData = JSON.parse(fs.readFileSync(this.lockPath, 'utf-8'));
        const lockAge = Date.now() - new Date(lockData.acquiredAt).getTime();
        if (lockAge < LOCK_STALE_MS) {
          console.log(`[SessionMigrator] Lock held by pid ${lockData.pid}, age ${Math.round(lockAge / 1000)}s — skipping`);
          return false;
        }
        console.log(`[SessionMigrator] Stale lock (${Math.round(lockAge / 1000)}s old) — taking over`);
      }

      fs.writeFileSync(this.lockPath, JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }), { mode: 0o600 });
      return true;
    } catch (err) {
      console.error('[SessionMigrator] Failed to acquire lock:', err);
      return false;
    }
  }

  private releaseLock(): void {
    try {
      if (fs.existsSync(this.lockPath)) {
        // safe-git-allow: incremental-migration
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // @silent-fallback-ok — lock may have been cleaned up already
    }
  }

  // ── Crash Recovery ──────────────────────────────────────────────────

  /**
   * On startup, check for incomplete migration state.
   * If found, attempt rollback by restarting halted sessions on the source account.
   */
  private recoverFromCrash(): void {
    const state = this.loadMigrationState();
    if (!state) return;

    if (state.status === 'idle' || state.status === 'complete' || state.status === 'failed') {
      return;
    }

    console.warn(`[SessionMigrator] Found incomplete migration (status: ${state.status}). Will attempt recovery when deps are set.`);
    this.migrationState = state;
  }

  /**
   * Called after deps are set to complete crash recovery if needed.
   * Should be called once after setDeps().
   */
  async completeRecovery(): Promise<void> {
    if (!this.migrationState || !this.deps) return;

    const state = this.migrationState;
    if (state.status === 'idle' || state.status === 'complete' || state.status === 'failed') {
      return;
    }

    console.log(`[SessionMigrator] Recovering from interrupted migration (status: ${state.status})`);

    // For any non-terminal state, try to restart halted sessions that weren't restarted
    const restartedIds = new Set(state.restartedSessions.map(s => s.sessionId));
    const needsRestart = state.haltedSessions.filter(s => !restartedIds.has(s.sessionId));

    if (needsRestart.length > 0) {
      console.log(`[SessionMigrator] Restarting ${needsRestart.length} sessions from crash recovery`);
      for (const session of needsRestart) {
        try {
          await this.deps.respawnJob(session.jobSlug);
        } catch (err) {
          console.error(`[SessionMigrator] Recovery restart failed for ${session.jobSlug}:`, err);
        }
      }
    }

    // Mark recovery complete
    this.migrationState = {
      status: 'complete',
      sourceAccount: state.sourceAccount,
      targetAccount: state.targetAccount,
      haltedSessions: state.haltedSessions,
      restartedSessions: state.restartedSessions,
      error: `Recovered from crash (previous status: ${state.status})`,
    };
    this.saveMigrationState();

    // Resume scheduler if it was left paused
    try { this.deps.resumeScheduler(); } catch { // @silent-fallback-ok — best-effort scheduler resume during crash recovery
    }
  }

  // ── State Persistence ───────────────────────────────────────────────

  private saveMigrationState(): void {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.migrationState, null, 2), { mode: 0o600 });
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'SessionMigrator.saveMigrationState',
        primary: 'Persist migration state to disk for crash recovery',
        fallback: 'Migration state exists in memory only',
        reason: `Write failed: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Crash recovery will not be able to resume this migration',
      });
      console.error('[SessionMigrator] Failed to save migration state:', err);
    }
  }

  private loadMigrationState(): MigrationState | null {
    try {
      if (!fs.existsSync(this.statePath)) return null;
      return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
    } catch {
      // @silent-fallback-ok — corrupt state file treated as no state; fresh start is safe
      return null;
    }
  }

  private loadHistory(): MigrationHistory {
    try {
      if (!fs.existsSync(this.historyPath)) {
        return { lastMigration: null, migrations: [] };
      }
      return JSON.parse(fs.readFileSync(this.historyPath, 'utf-8'));
    } catch {
      return { lastMigration: null, migrations: [] };
    }
  }

  private recordMigration(event: MigrationEvent): void {
    const history = this.loadHistory();
    history.lastMigration = event;
    history.migrations.push(event);
    if (history.migrations.length > MAX_HISTORY) {
      history.migrations = history.migrations.slice(-MAX_HISTORY);
    }
    try {
      fs.writeFileSync(this.historyPath, JSON.stringify(history, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error('[SessionMigrator] Failed to save migration history:', err);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Get current migration status for API/monitoring.
   */
  getMigrationStatus(): {
    inProgress: boolean;
    state: MigrationState | null;
    lastMigration: MigrationEvent | null;
    history: MigrationEvent[];
    config: MigrationThresholds;
  } {
    const history = this.loadHistory();
    return {
      inProgress: this.migrationState != null &&
        this.migrationState.status !== 'idle' &&
        this.migrationState.status !== 'complete' &&
        this.migrationState.status !== 'failed',
      state: this.migrationState,
      lastMigration: history.lastMigration,
      history: history.migrations,
      config: { ...this.thresholds },
    };
  }

  /**
   * Is migration currently in progress?
   */
  isMigrating(): boolean {
    return this.migrationState != null &&
      this.migrationState.status !== 'idle' &&
      this.migrationState.status !== 'complete' &&
      this.migrationState.status !== 'failed';
  }

  /**
   * Get thresholds (for external monitoring/display).
   */
  getThresholds(): MigrationThresholds {
    return { ...this.thresholds };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
