/**
 * Auto Updater — built-in periodic update mechanism.
 *
 * Runs inside the server process (no Claude session needed).
 * Periodically checks for updates, auto-applies when available,
 * notifies via Telegram, and handles server restart.
 *
 * This replaces the heavyweight prompt-based update-check job.
 * Updates should never depend on the job scheduler — they're
 * core infrastructure that must run independently.
 *
 * Flow:
 *   check → apply → migrate → notify → restart
 *
 * Restart strategy:
 *   After npm update replaces the CLI on disk, spawn a replacement
 *   server process and exit. The new process binds to the port after
 *   the old one releases it during shutdown.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { UpdateChecker } from './UpdateChecker.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { StateManager } from './StateManager.js';
import type { LiveConfig } from '../config/LiveConfig.js';
import { UpdateGate } from './UpdateGate.js';
import { cleanupGlobalInstalls } from './GlobalInstallCleanup.js';
import type { SessionManagerLike, SessionMonitorLike } from './UpdateGate.js';

export interface AutoUpdaterConfig {
  /** How often to check for updates, in minutes. Default: 30 */
  checkIntervalMinutes?: number;
  /** Whether to auto-apply updates. Default: true */
  autoApply?: boolean;
  /** Telegram topic ID for update notifications (uses Agent Attention if not set) */
  notificationTopicId?: number;
  /** Whether to auto-restart after applying an update. Default: true */
  autoRestart?: boolean;
  /** Delay before applying an update, in minutes. Allows coalescing rapid-fire publishes. Default: 5 */
  applyDelayMinutes?: number;
  /** Seconds to wait after sending pre-restart notification before actually restarting. Default: 60 */
  preRestartDelaySecs?: number;
  /**
   * Preferred restart window (24h format, local time). When set, restarts only
   * happen during this window unless triggered manually via POST /updates/apply.
   * Updates are still downloaded immediately — only the restart is deferred.
   * Example: { start: "02:00", end: "05:00" }
   */
  restartWindow?: { start: string; end: string } | null;
}

export interface AutoUpdaterStatus {
  /** Whether the auto-updater is running */
  running: boolean;
  /** Last time we checked for updates */
  lastCheck: string | null;
  /** Last time we applied an update */
  lastApply: string | null;
  /** The version that was last successfully applied */
  lastAppliedVersion: string | null;
  /** Current configuration */
  config: Required<AutoUpdaterConfig>;
  /** Any pending update that hasn't been applied yet */
  pendingUpdate: string | null;
  /** Last error if any */
  lastError: string | null;
  /** ISO timestamp: coalescing timer expires at this time (null = not coalescing) */
  coalescingUntil: string | null;
  /** ISO timestamp: when the pending update was first detected */
  pendingUpdateDetectedAt: string | null;
  /** Whether restart is being deferred for active sessions */
  deferralReason: string | null;
  /** How long we've been deferring, in minutes */
  deferralElapsedMinutes: number;
  /** Max deferral before forced restart */
  maxDeferralHours: number;
}

export class AutoUpdater {
  private updateChecker: UpdateChecker;
  private telegram: TelegramAdapter | null;
  private state: StateManager;
  private config: Required<AutoUpdaterConfig>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastCheck: string | null = null;
  private lastApply: string | null = null;
  private lastAppliedVersion: string | null = null;
  private lastError: string | null = null;
  private pendingUpdate: string | null = null;
  private isApplying = false;
  private stateDir: string;
  private stateFile: string;
  private liveConfig: LiveConfig | null = null;

  // Update coalescing — batch rapid-fire publishes into a single restart
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUpdateDetectedAt: string | null = null;
  private coalescingUntil: string | null = null;

  // Session-aware restart gating
  private gate: UpdateGate;
  private sessionManager: SessionManagerLike | null = null;
  private sessionMonitor: SessionMonitorLike | null = null;
  private deferralTimer: ReturnType<typeof setTimeout> | null = null;

  // Loop prevention — track version mismatch notifications to avoid spam
  private notifiedVersionMismatch: string | null = null;
  // Restart notification dedup — only notify once per version
  private lastNotifiedRestartVersion: string | null = null;
  // Restart cooldown — prevent rapid restart cycling (e.g., binary path mismatch)
  private lastRestartRequestedAt: string | null = null;
  private lastRestartRequestedVersion: string | null = null;
  // npx cache detection — legacy field, no longer used. Updates now install to
  // a local shadow directory, so npx cache location is irrelevant.
  private isNpxCached = false;

  constructor(
    updateChecker: UpdateChecker,
    state: StateManager,
    stateDir: string,
    config?: AutoUpdaterConfig,
    telegram?: TelegramAdapter | null,
    liveConfig?: LiveConfig | null,
  ) {
    this.updateChecker = updateChecker;
    this.state = state;
    this.telegram = telegram ?? null;
    this.stateDir = stateDir;
    this.stateFile = path.join(stateDir, 'state', 'auto-updater.json');
    this.liveConfig = liveConfig ?? null;

    this.config = {
      checkIntervalMinutes: config?.checkIntervalMinutes ?? 30,
      autoApply: config?.autoApply ?? true,
      autoRestart: config?.autoRestart ?? true,
      notificationTopicId: config?.notificationTopicId ?? 0,
      applyDelayMinutes: config?.applyDelayMinutes ?? 5,
      preRestartDelaySecs: config?.preRestartDelaySecs ?? 60,
      restartWindow: config?.restartWindow ?? null,
    };

    this.gate = new UpdateGate();

    // npx cache detection is no longer needed — updates install to a local
    // shadow directory ({stateDir}/shadow-install/) instead of globally.
    // The supervisor resolves the shadow install on restart, so npx cache
    // vs global vs asdf no longer matters. Each agent owns its version.

    // Load persisted state (survives restarts)
    this.loadState();
  }

  /**
   * Start the periodic update checker.
   * Idempotent — calling start() when already running is a no-op.
   */
  start(): void {
    if (this.interval) return;

    const intervalMs = this.config.checkIntervalMinutes * 60 * 1000;

    console.log(
      `[AutoUpdater] Started (every ${this.config.checkIntervalMinutes}m, ` +
      `autoApply: ${this.config.autoApply})`
    );

    // Run first check after a short delay (don't block startup)
    setTimeout(() => this.tick(), 10_000);

    // Then run periodically
    this.interval = setInterval(() => this.tick(), intervalMs);
    this.interval.unref(); // Don't prevent process exit
  }

  /**
   * Stop the periodic checker.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.applyTimer) {
      clearTimeout(this.applyTimer);
      this.applyTimer = null;
      this.coalescingUntil = null;
    }
    if (this.deferralTimer) {
      clearTimeout(this.deferralTimer);
      this.deferralTimer = null;
    }
    this.gate.reset();
  }

  /**
   * Get current auto-updater status.
   */
  getStatus(): AutoUpdaterStatus {
    const gateStatus = this.gate.getStatus();
    return {
      running: this.interval !== null,
      lastCheck: this.lastCheck,
      lastApply: this.lastApply,
      lastAppliedVersion: this.lastAppliedVersion,
      config: { ...this.config },
      pendingUpdate: this.pendingUpdate,
      lastError: this.lastError,
      coalescingUntil: this.coalescingUntil,
      pendingUpdateDetectedAt: this.pendingUpdateDetectedAt,
      deferralReason: gateStatus.deferralReason,
      deferralElapsedMinutes: gateStatus.deferralElapsedMinutes,
      maxDeferralHours: gateStatus.maxDeferralHours,
    };
  }

  /**
   * Set the Telegram adapter (may be wired after construction).
   */
  setTelegram(telegram: TelegramAdapter): void {
    this.telegram = telegram;
  }

  /**
   * Set session dependencies for session-aware restart gating.
   * May be wired after construction (like Telegram).
   */
  setSessionDeps(sessionManager: SessionManagerLike, sessionMonitor?: SessionMonitorLike | null): void {
    this.sessionManager = sessionManager;
    this.sessionMonitor = sessionMonitor ?? null;
  }

  /**
   * Re-read dynamic config values from disk via LiveConfig.
   * Sessions or external edits may have changed them since startup.
   *
   * Uses LiveConfig if available (the preferred path), falls back to
   * direct file read for backward compatibility.
   */
  private reloadDynamicConfig(): void {
    try {
      if (this.liveConfig) {
        // LiveConfig handles mtime checking and caching — just read
        const diskValue = this.liveConfig.get<boolean>('updates.autoApply', true);
        if (diskValue !== this.config.autoApply) {
          console.log(`[AutoUpdater] Config changed: autoApply ${this.config.autoApply} → ${diskValue}`);
          this.config.autoApply = diskValue;
        }
        return;
      }

      // Fallback: direct file read (for callers that haven't adopted LiveConfig yet)
      const configPath = path.join(this.stateDir, 'config.json');
      if (!fs.existsSync(configPath)) return;

      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const diskValue = raw?.updates?.autoApply;
      if (typeof diskValue === 'boolean' && diskValue !== this.config.autoApply) {
        console.log(`[AutoUpdater] Config changed on disk: autoApply ${this.config.autoApply} → ${diskValue}`);
        this.config.autoApply = diskValue;
      }
    } catch {
      // @silent-fallback-ok — config read failure shouldn't break update cycle
    }
  }

  /**
   * One tick of the update loop.
   * Check → detect update → start coalescing timer → apply after delay.
   *
   * The coalescing timer handles rapid-fire publishes: if 0.9.74, 0.9.75,
   * and 0.9.76 are published within 10 minutes, we apply only 0.9.76.
   * Each new version resets the timer.
   */
  private async tick(): Promise<void> {
    if (this.isApplying) {
      console.log('[AutoUpdater] Skipping tick — update already in progress');
      return;
    }

    // Re-read dynamic config — sessions may have toggled autoApply
    this.reloadDynamicConfig();

    try {
      // Step 1: Check for updates
      const info = await this.updateChecker.check();
      this.lastCheck = new Date().toISOString();
      this.lastError = null;

      if (!info.updateAvailable) {
        this.pendingUpdate = null;
        this.pendingUpdateDetectedAt = null;
        this.coalescingUntil = null;
        if (this.applyTimer) {
          clearTimeout(this.applyTimer);
          this.applyTimer = null;
        }
        this.saveState();
        return;
      }

      console.log(`[AutoUpdater] Update available: ${info.currentVersion} → ${info.latestVersion}`);

      // LOOP BREAKER: If we already applied this version, the binary resolution
      // is broken (e.g., npx cache vs global install). Don't keep re-applying.
      // This prevents the update→restart→detect→update→restart loop.
      if (this.lastAppliedVersion === info.latestVersion) {
        console.log(
          `[AutoUpdater] Skipping — v${info.latestVersion} was already applied ` +
          `(at ${this.lastApply}) but getInstalledVersion() still reports v${info.currentVersion}. ` +
          `Binary resolution mismatch — manual restart may be needed.`
        );
        // Only notify once about the mismatch
        if (!this.notifiedVersionMismatch) {
          this.notifiedVersionMismatch = info.latestVersion;
          // Check if restart is actively deferred — if so, clarify that's the reason
          const gateStatus = this.gate.getStatus();
          if (gateStatus.deferring) {
            await this.notify(
              `v${info.latestVersion} is downloaded and waiting for a restart — still running v${info.currentVersion}. ` +
              `Restart is being held back by ${gateStatus.deferralReason ?? 'active sessions'}. ` +
              `I'll switch over automatically once they finish.`
            );
          } else {
            await this.notify(
              `v${info.latestVersion} is downloaded but the process hasn't restarted yet — still running v${info.currentVersion}. ` +
              `A server restart will activate the new version.`
            );
          }
        }
        this.saveState();
        return;
      }

      // Track first detection time (don't reset on subsequent detections of newer versions)
      if (!this.pendingUpdateDetectedAt) {
        this.pendingUpdateDetectedAt = new Date().toISOString();
      }
      this.pendingUpdate = info.latestVersion;

      // Step 2: Auto-apply if configured
      if (!this.config.autoApply) {
        this.saveState();
        // Notify with actionable instructions — don't leave the user hanging
        // Only notify once per detected version (avoid spam on every tick)
        if (!this.coalescingUntil) {
          await this.notify(
            `There's a new version available (v${info.latestVersion}). I'm currently on v${info.currentVersion}.\n\n` +
            `Auto-updates are off. Just say "update" or "apply the update" and I'll handle it. ` +
            `Or to turn on auto-updates so this happens automatically, say "turn on auto-updates".`
          );
          // Set coalescingUntil as a "notified" marker to prevent re-notification
          this.coalescingUntil = 'notified';
        }
        return;
      }

      // Step 3: Start or reset coalescing timer
      const delayMs = this.config.applyDelayMinutes * 60_000;

      if (delayMs <= 0) {
        // No coalescing — apply immediately (legacy behavior)
        this.saveState();
        await this.applyPendingUpdate();
        return;
      }

      // Reset the coalescing timer (new version detected, wait for more)
      if (this.applyTimer) {
        clearTimeout(this.applyTimer);
        console.log(`[AutoUpdater] Coalescing: timer reset — newer version v${info.latestVersion} detected`);
      } else {
        console.log(`[AutoUpdater] Coalescing: waiting ${this.config.applyDelayMinutes}m before applying v${info.latestVersion}`);
      }

      this.coalescingUntil = new Date(Date.now() + delayMs).toISOString();
      this.saveState();

      this.applyTimer = setTimeout(async () => {
        this.applyTimer = null;
        this.coalescingUntil = null;
        await this.applyPendingUpdate();
      }, delayMs);
      this.applyTimer.unref(); // Don't prevent process exit
    } catch (err) {
      this.isApplying = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.saveState();
      console.error(`[AutoUpdater] Tick error: ${this.lastError}`);
    }
  }

  /**
   * Apply the pending update after coalescing delay.
   * Extracted from tick() so it can be called by the coalescing timer
   * and by manual trigger (POST /updates/apply).
   */
  async applyPendingUpdate(options?: { bypassWindow?: boolean }): Promise<void> {
    if (this.isApplying) {
      console.log('[AutoUpdater] Skipping apply — already in progress');
      return;
    }

    if (!this.pendingUpdate) {
      console.log('[AutoUpdater] No pending update to apply');
      return;
    }

    const targetVersion = this.pendingUpdate;

    try {
      this.isApplying = true;
      console.log(`[AutoUpdater] Applying update to v${targetVersion}...`);

      const result = await this.updateChecker.applyUpdate();
      this.isApplying = false;

      if (!result.success) {
        this.lastError = result.message;
        this.saveState();
        console.error(`[AutoUpdater] Update failed: ${result.message}`);
        await this.notify(
          `Heads up — I tried to update to v${targetVersion} but it didn't work out. ` +
          `I'm still running fine on v${result.previousVersion}, so nothing's broken. ` +
          `I'll try again next cycle.`
        );
        return;
      }

      // Update succeeded
      this.lastApply = new Date().toISOString();
      // CRITICAL: Use targetVersion for the loop breaker, not result.newVersion.
      // applyUpdate() may return newVersion=previousVersion when npm install -g
      // updates files in-place (making getInstalledVersion() return the new version
      // before the verification step). Using targetVersion ensures the loop breaker
      // always matches and prevents the update→apply→notify→restart spam loop.
      this.lastAppliedVersion = targetVersion;
      this.pendingUpdate = null;
      this.pendingUpdateDetectedAt = null;
      this.coalescingUntil = null;
      this.saveState();

      console.log(`[AutoUpdater] Updated: v${result.previousVersion} → v${result.newVersion} (target: v${targetVersion})`);

      // Clean up stale global installs after successful shadow install update.
      // Prevents version confusion where CLI commands resolve to an old global.
      try {
        const cleanup = cleanupGlobalInstalls();
        if (cleanup.removed.length > 0) {
          console.log(`[AutoUpdater] Cleaned up ${cleanup.removed.length} stale global install(s)`);
        }
      } catch (err) {
        console.warn(`[AutoUpdater] Global cleanup error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }

      // Always restart after a successful apply. The running process has OLD
      // code in memory regardless of what getInstalledVersion() reads from disk.
      // Even when applyUpdate() returns restartNeeded:false (because npm install -g
      // updated files in-place making getInstalledVersion() return the new version),
      // the in-memory code is stale and needs a restart.
      //
      // The loop breaker in tick() (checking lastAppliedVersion === latestVersion)
      // prevents this from becoming an infinite loop. After restart, the loop
      // breaker catches the next cycle and returns early.
      await this.gatedRestart(targetVersion, options?.bypassWindow ?? false);
    } catch (err) {
      this.isApplying = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.saveState();
      console.error(`[AutoUpdater] Apply error: ${this.lastError}`);
    }
  }

  /**
   * Check if the current local time is within the configured restart window.
   * Returns true if no window is configured (restart anytime).
   */
  private isInRestartWindow(): boolean {
    const window = this.config.restartWindow;
    if (!window) return true; // No window configured → always allowed

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const [startH, startM] = window.start.split(':').map(Number);
    const [endH, endM] = window.end.split(':').map(Number);
    const startMinutes = startH * 60 + (startM || 0);
    const endMinutes = endH * 60 + (endM || 0);

    if (startMinutes <= endMinutes) {
      // Simple range: e.g., 02:00 - 05:00
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
      // Wraps midnight: e.g., 23:00 - 05:00
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
  }

  /**
   * Calculate milliseconds until the start of the next restart window.
   */
  private msUntilRestartWindow(): number {
    const window = this.config.restartWindow;
    if (!window) return 0;

    const now = new Date();
    const [startH, startM] = window.start.split(':').map(Number);

    const target = new Date(now);
    target.setHours(startH, startM || 0, 0, 0);

    // If the window start is already past today, aim for tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    return target.getTime() - now.getTime();
  }

  /**
   * Attempt restart with session-aware gating.
   * If sessions are active, defers and retries on a timer.
   * After max deferral, restarts regardless with warnings.
   */
  private async gatedRestart(newVersion: string, bypassWindow = false): Promise<void> {
    // RESTART COOLDOWN: If we already requested a restart for this exact version
    // within the last 30 minutes, don't restart again. This is the safety net
    // for binary path mismatches (npx cache, etc.) where the loop breaker in
    // tick() should catch the loop but the process keeps cycling.
    if (this.lastRestartRequestedVersion === newVersion && this.lastRestartRequestedAt) {
      const elapsed = Date.now() - new Date(this.lastRestartRequestedAt).getTime();
      const cooldownMs = 30 * 60_000; // 30 minutes
      if (elapsed < cooldownMs) {
        console.log(
          `[AutoUpdater] Restart cooldown: already requested restart for v${newVersion} ` +
          `${Math.round(elapsed / 60_000)}m ago (cooldown: 30m). Skipping.`
        );
        return;
      }
    }

    // Restart window gate — defer restart until the configured window unless bypassed.
    // Updates are already downloaded; only the restart is held.
    if (!bypassWindow && !this.isInRestartWindow()) {
      const waitMs = this.msUntilRestartWindow();
      const waitH = Math.round(waitMs / 3600_000 * 10) / 10;
      console.log(`[AutoUpdater] Outside restart window (${this.config.restartWindow!.start}-${this.config.restartWindow!.end}). Deferring restart for v${newVersion} (~${waitH}h)`);

      // Schedule a retry at the window start
      if (this.deferralTimer) clearTimeout(this.deferralTimer);
      this.deferralTimer = setTimeout(() => {
        this.deferralTimer = null;
        console.log(`[AutoUpdater] Restart window reached — attempting restart for v${newVersion}`);
        this.gatedRestart(newVersion, false);
      }, waitMs);
      this.deferralTimer.unref();
      return;
    }

    // If no session manager is wired, skip gating — silent restart
    if (!this.sessionManager) {
      console.log(`[AutoUpdater] Silent restart — no session manager wired (updating to v${newVersion})`);
      this.lastRestartRequestedAt = new Date().toISOString();
      this.lastRestartRequestedVersion = newVersion;
      this.saveState();
      await new Promise(r => setTimeout(r, 2000));
      this.requestRestart(newVersion);
      return;
    }

    const result = this.gate.canRestart(this.sessionManager, this.sessionMonitor);

    if (result.unresponsiveSessions?.length) {
      console.log(`[AutoUpdater] Unresponsive sessions (not blocking): ${result.unresponsiveSessions.join(', ')}`);
    }

    if (result.allowed) {
      // Clear any deferral timer
      if (this.deferralTimer) {
        clearTimeout(this.deferralTimer);
        this.deferralTimer = null;
      }

      // Check if there are still running sessions (idle/unresponsive — not blocking)
      const runningSessions = this.sessionManager!.listRunningSessions();
      const hasRunningSessions = runningSessions.length > 0;

      if (result.reason?.includes('Max deferral')) {
        // Forced restart after max deferral — user needs to know
        await this.notify(
          `Update to v${newVersion} was deferred for active sessions, but the maximum wait has been reached. Restarting now.`
        );
      } else if (hasRunningSessions) {
        // Sessions exist but aren't blocking — user needs a heads-up.
        // But only notify ONCE per version to prevent spam in restart loops.
        if (this.lastNotifiedRestartVersion !== newVersion) {
          this.lastNotifiedRestartVersion = newVersion;
          await this.notify(
            `Just updated to v${newVersion}. Restarting to pick up the changes.`
          );
        }
        // Give sessions a moment to checkpoint
        const delaySecs = this.config.preRestartDelaySecs;
        if (delaySecs > 0) {
          console.log(`[AutoUpdater] Pre-restart delay: ${delaySecs}s for ${runningSessions.length} session(s)`);
          await new Promise(r => setTimeout(r, delaySecs * 1000));
        }
      } else {
        // No active sessions — silent restart. Don't notify the user.
        // Updates should be invisible when nobody's working.
        console.log(`[AutoUpdater] Silent restart — no active sessions (updating to v${newVersion})`);
      }
      // CRITICAL: Save state BEFORE requesting restart. The process may exit
      // immediately after requestRestart (ForegroundRestartWatcher picks up the
      // signal and calls process.exit). If we don't save here, the dedup state
      // (lastNotifiedRestartVersion, lastRestartRequestedVersion) is lost, and
      // the notification loop repeats on next restart. This was the root cause
      // of the v0.12.10 notification spam bug.
      this.lastRestartRequestedAt = new Date().toISOString();
      this.lastRestartRequestedVersion = newVersion;
      this.saveState();

      await new Promise(r => setTimeout(r, 2000));
      this.requestRestart(newVersion);
      return;
    }

    // Sessions are blocking — defer
    console.log(`[AutoUpdater] Restart deferred: ${result.reason}. Will retry in ${Math.round((result.retryInMs ?? 300_000) / 60_000)}m`);

    // Send warnings at thresholds
    if (this.gate.shouldSendFinalWarning()) {
      await this.notify(
        `Update to v${newVersion} installed. Server will restart in ~5 minutes regardless of active sessions.`
      );
    } else if (this.gate.shouldSendFirstWarning()) {
      await this.notify(
        `Update to v${newVersion} installed but restart is being deferred for ${result.blockingSessions?.length} active session(s). ` +
        `Will force restart in ~30 minutes if sessions don't finish.`
      );
    }

    // Schedule retry
    if (this.deferralTimer) {
      clearTimeout(this.deferralTimer);
    }
    this.deferralTimer = setTimeout(async () => {
      this.deferralTimer = null;
      await this.gatedRestart(newVersion);
    }, result.retryInMs ?? 300_000);
    this.deferralTimer.unref();
  }

  /**
   * Request a restart from the supervisor by writing a signal file.
   *
   * The AutoUpdater's job ends here — the supervisor handles the actual restart.
   * This eliminates the entire category of self-restart bugs (PATH mismatch,
   * launchd confusion, binary resolution failures, restart loops).
   *
   * Signal file: state/restart-requested.json
   * The supervisor polls this file during health checks and performs the restart.
   *
   * If no supervisor is running (standalone foreground mode), the server logs
   * a notice that a restart is needed. This is strictly better than attempting
   * self-restart, which can loop or leave the port bound.
   */
  private requestRestart(newVersion: string): void {
    const flagPath = path.join(this.stateDir, 'state', 'restart-requested.json');
    const data = {
      requestedAt: new Date().toISOString(),
      requestedBy: 'auto-updater',
      targetVersion: newVersion,
      previousVersion: this.updateChecker.getInstalledVersion(),
      plannedRestart: true, // Signals lifeline/supervisor: this is maintenance, not a crash
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour TTL (was 10 min — too short for foreground mode)
      pid: process.pid,
    };
    try {
      const dir = path.dirname(flagPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${flagPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, flagPath);
      console.log(`[AutoUpdater] Restart requested — supervisor or ForegroundRestartWatcher will handle (target: v${newVersion})`);
    } catch (err) {
      console.error(`[AutoUpdater] Failed to write restart request: ${err}`);
      console.error('[AutoUpdater] Update was applied but a manual restart is needed.');
    }
  }

  /**
   * Send a notification via Telegram (if configured).
   * Falls back to console logging if Telegram is not available.
   */
  private async notify(message: string): Promise<void> {
    const formatted = message;

    if (this.telegram) {
      try {
        const topicId = this.config.notificationTopicId || this.getNotificationTopicId();
        if (topicId) {
          await this.telegram.sendToTopic(topicId, formatted);
          return;
        }
      } catch (err) {
        // @silent-fallback-ok — notification fallback to console
        console.error(`[AutoUpdater] Telegram notification failed: ${err}`);
      }
    }

    // Fallback: just log
    console.log(`[AutoUpdater] Notification: ${message}`);
  }

  /**
   * Get the topic ID for update notifications.
   *
   * Update announcements are routed exclusively to the dedicated Agent Updates
   * topic. If it is not configured, notify() drops to console — we never fall
   * back to Attention or any other topic. This matches the /telegram/post-update
   * endpoint contract and closes the leak where update spam landed in whichever
   * topic happened to be provisioned.
   */
  private getNotificationTopicId(): number {
    return this.state.get<number>('agent-updates-topic') || 0;
  }

  // ── State persistence ──────────────────────────────────────────────

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
        this.lastCheck = data.lastCheck ?? null;
        this.lastApply = data.lastApply ?? null;
        this.lastAppliedVersion = data.lastAppliedVersion ?? null;
        this.lastError = data.lastError ?? null;
        this.pendingUpdate = data.pendingUpdate ?? null;
        this.pendingUpdateDetectedAt = data.pendingUpdateDetectedAt ?? null;
        // Restore dedup state — these MUST survive restarts to prevent notification loops.
        // Before v0.12.10, these were in-memory only, causing the notification spam
        // that repeated on every server restart.
        this.notifiedVersionMismatch = data.notifiedVersionMismatch ?? null;
        this.lastNotifiedRestartVersion = data.lastNotifiedRestartVersion ?? null;
        // Restart cooldown — prevents rapid restart cycling
        this.lastRestartRequestedAt = data.lastRestartRequestedAt ?? null;
        this.lastRestartRequestedVersion = data.lastRestartRequestedVersion ?? null;
        // Don't restore coalescingUntil — the timer is in-memory only.
        // On restart, if there's still a pendingUpdate, the next tick()
        // will re-detect it and start a fresh coalescing timer.
      }
    } catch {
      // Start fresh if state is corrupted
    }
  }

  private saveState(): void {
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true });

    const data = {
      lastCheck: this.lastCheck,
      lastApply: this.lastApply,
      lastAppliedVersion: this.lastAppliedVersion,
      lastError: this.lastError,
      pendingUpdate: this.pendingUpdate,
      pendingUpdateDetectedAt: this.pendingUpdateDetectedAt,
      coalescingUntil: this.coalescingUntil,
      // Persist dedup state — prevents notification loops across restarts
      notifiedVersionMismatch: this.notifiedVersionMismatch,
      lastNotifiedRestartVersion: this.lastNotifiedRestartVersion,
      // Restart cooldown — prevents rapid restart cycling
      lastRestartRequestedAt: this.lastRestartRequestedAt,
      lastRestartRequestedVersion: this.lastRestartRequestedVersion,
      savedAt: new Date().toISOString(),
    };

    // Atomic write
    const tmpPath = this.stateFile + `.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, this.stateFile);
    } catch {
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}
