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

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { UpdateChecker } from './UpdateChecker.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { StateManager } from './StateManager.js';

export interface AutoUpdaterConfig {
  /** How often to check for updates, in minutes. Default: 30 */
  checkIntervalMinutes?: number;
  /** Whether to auto-apply updates. Default: true */
  autoApply?: boolean;
  /** Telegram topic ID for update notifications (uses Agent Attention if not set) */
  notificationTopicId?: number;
  /** Whether to auto-restart after applying an update. Default: true */
  autoRestart?: boolean;
}

export interface AutoUpdaterStatus {
  /** Whether the auto-updater is running */
  running: boolean;
  /** Last time we checked for updates */
  lastCheck: string | null;
  /** Last time we applied an update */
  lastApply: string | null;
  /** Current configuration */
  config: Required<AutoUpdaterConfig>;
  /** Any pending update that hasn't been applied yet */
  pendingUpdate: string | null;
  /** Last error if any */
  lastError: string | null;
}

export class AutoUpdater {
  private updateChecker: UpdateChecker;
  private telegram: TelegramAdapter | null;
  private state: StateManager;
  private config: Required<AutoUpdaterConfig>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastCheck: string | null = null;
  private lastApply: string | null = null;
  private lastError: string | null = null;
  private pendingUpdate: string | null = null;
  private isApplying = false;
  private stateFile: string;

  constructor(
    updateChecker: UpdateChecker,
    state: StateManager,
    stateDir: string,
    config?: AutoUpdaterConfig,
    telegram?: TelegramAdapter | null,
  ) {
    this.updateChecker = updateChecker;
    this.state = state;
    this.telegram = telegram ?? null;
    this.stateFile = path.join(stateDir, 'state', 'auto-updater.json');

    this.config = {
      checkIntervalMinutes: config?.checkIntervalMinutes ?? 30,
      autoApply: config?.autoApply ?? true,
      autoRestart: config?.autoRestart ?? true,
      notificationTopicId: config?.notificationTopicId ?? 0,
    };

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
      `autoApply: ${this.config.autoApply}, autoRestart: ${this.config.autoRestart})`
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
  }

  /**
   * Get current auto-updater status.
   */
  getStatus(): AutoUpdaterStatus {
    return {
      running: this.interval !== null,
      lastCheck: this.lastCheck,
      lastApply: this.lastApply,
      config: { ...this.config },
      pendingUpdate: this.pendingUpdate,
      lastError: this.lastError,
    };
  }

  /**
   * Set the Telegram adapter (may be wired after construction).
   */
  setTelegram(telegram: TelegramAdapter): void {
    this.telegram = telegram;
  }

  /**
   * One tick of the update loop.
   * Check → optionally apply → notify → optionally restart.
   */
  private async tick(): Promise<void> {
    if (this.isApplying) {
      console.log('[AutoUpdater] Skipping tick — update already in progress');
      return;
    }

    try {
      // Step 1: Check for updates
      const info = await this.updateChecker.check();
      this.lastCheck = new Date().toISOString();
      this.lastError = null;

      if (!info.updateAvailable) {
        this.pendingUpdate = null;
        this.saveState();
        return;
      }

      console.log(`[AutoUpdater] Update available: ${info.currentVersion} → ${info.latestVersion}`);
      this.pendingUpdate = info.latestVersion;
      this.saveState();

      // Step 2: Auto-apply if configured
      if (!this.config.autoApply) {
        // Just notify — don't apply
        await this.notify(
          `Update available: v${info.currentVersion} → v${info.latestVersion}\n\n` +
          (info.changeSummary ? `Changes: ${info.changeSummary}\n\n` : '') +
          `Auto-apply is disabled. Apply manually:\n` +
          `curl -X POST http://localhost:${this.getPort()}/updates/apply`
        );
        return;
      }

      // Step 3: Apply the update
      this.isApplying = true;
      console.log(`[AutoUpdater] Applying update to v${info.latestVersion}...`);

      const result = await this.updateChecker.applyUpdate();
      this.isApplying = false;

      if (!result.success) {
        this.lastError = result.message;
        this.saveState();
        console.error(`[AutoUpdater] Update failed: ${result.message}`);
        await this.notify(
          `Update to v${info.latestVersion} failed: ${result.message}\n\n` +
          `The current version (v${result.previousVersion}) is still running.`
        );
        return;
      }

      // Step 4: Update succeeded
      this.lastApply = new Date().toISOString();
      this.pendingUpdate = null;
      this.saveState();

      console.log(`[AutoUpdater] Updated: v${result.previousVersion} → v${result.newVersion}`);

      // Step 5: Notify via Telegram
      const restartNote = result.restartNeeded && this.config.autoRestart
        ? 'Server is restarting now...'
        : result.restartNeeded
          ? 'A server restart is needed to use the new version.'
          : '';

      await this.notify(
        `Updated: v${result.previousVersion} → v${result.newVersion}\n\n` +
        (info.changeSummary ? `What changed:\n${info.changeSummary}\n\n` : '') +
        restartNote
      );

      // Step 6: Self-restart if needed and configured
      if (result.restartNeeded && this.config.autoRestart) {
        // Brief delay to let the Telegram notification send
        await new Promise(r => setTimeout(r, 2000));
        this.selfRestart();
      }
    } catch (err) {
      this.isApplying = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.saveState();
      console.error(`[AutoUpdater] Tick error: ${this.lastError}`);
    }
  }

  /**
   * Self-restart the server after an update.
   *
   * Strategy:
   *   1. Spawn a shell that waits 2 seconds (for port release), then
   *      starts the new server version using the same CLI arguments.
   *   2. Send SIGTERM to ourselves to trigger graceful shutdown.
   *
   * The 2-second delay ensures the old process has time to release
   * the port before the new one tries to bind.
   *
   * If running in tmux, the replacement process inherits the PTY.
   * If running under a process manager (launchd, systemd), the
   * manager handles restart automatically after we exit.
   */
  private selfRestart(): void {
    console.log('[AutoUpdater] Initiating self-restart...');

    // Build the command to restart
    // process.argv[0] = node binary
    // process.argv[1..] = CLI args (e.g., /path/to/cli.js server start --foreground)
    const args = process.argv.slice(1)
      .map(a => `'${a.replace(/'/g, "'\\''")}'`)
      .join(' ');
    const cmd = `sleep 2 && exec ${process.execPath} ${args}`;

    try {
      const child = spawn('sh', ['-c', cmd], {
        detached: true,
        stdio: 'inherit',
        cwd: process.cwd(),
        env: process.env,
      });
      child.unref();

      console.log('[AutoUpdater] Replacement process spawned. Shutting down...');

      // Trigger graceful shutdown (the SIGTERM handler in server.ts will clean up)
      process.kill(process.pid, 'SIGTERM');
    } catch (err) {
      console.error(`[AutoUpdater] Self-restart failed: ${err}`);
      console.error('[AutoUpdater] Update was applied but manual restart is needed.');
    }
  }

  /**
   * Send a notification via Telegram (if configured).
   * Falls back to console logging if Telegram is not available.
   */
  private async notify(message: string): Promise<void> {
    const formatted = `🔄 *Auto-Update*\n\n${message}`;

    if (this.telegram) {
      try {
        const topicId = this.config.notificationTopicId || this.getAttentionTopicId();
        if (topicId) {
          await this.telegram.sendToTopic(topicId, formatted);
          return;
        }
      } catch (err) {
        console.error(`[AutoUpdater] Telegram notification failed: ${err}`);
      }
    }

    // Fallback: just log
    console.log(`[AutoUpdater] Notification: ${message}`);
  }

  /**
   * Get the Agent Attention topic ID from state (where infrastructure notifications go).
   */
  private getAttentionTopicId(): number {
    return this.state.get<number>('agent-attention-topic') ?? 0;
  }

  /**
   * Get the server port from the update checker config (for notification messages).
   */
  private getPort(): number {
    // The port is available on the UpdateChecker config but not exposed.
    // Use a reasonable default — agents can find their port from config.
    return 4040;
  }

  // ── State persistence ──────────────────────────────────────────────

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
        this.lastCheck = data.lastCheck ?? null;
        this.lastApply = data.lastApply ?? null;
        this.lastError = data.lastError ?? null;
        this.pendingUpdate = data.pendingUpdate ?? null;
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
      lastError: this.lastError,
      pendingUpdate: this.pendingUpdate,
      savedAt: new Date().toISOString(),
    };

    // Atomic write
    const tmpPath = this.stateFile + `.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, this.stateFile);
    } catch {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}
