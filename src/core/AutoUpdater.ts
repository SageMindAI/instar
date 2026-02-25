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

import { spawn, execFileSync } from 'node:child_process';
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

    // Detect npx cache — auto-apply and restart cause infinite loops when
    // running from npx because the cache still resolves to the old version
    // after npm installs the update. The restart finds the update again,
    // applies it again, restarts again — forever, killing all sessions each time.
    const scriptPath = process.argv[1] || '';
    const runningFromNpx = scriptPath.includes('.npm/_npx') || scriptPath.includes('/_npx/');
    if (runningFromNpx) {
      this.config.autoApply = false;
      this.config.autoRestart = false;
      console.warn(
        '[AutoUpdater] Running from npx cache. Auto-apply and auto-restart disabled to prevent restart loops.\n' +
        '[AutoUpdater] Run: npm install -g instar  (then restart with: instar server start)'
      );
    }

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
          `There's a new version available (v${info.latestVersion}). I'm currently on v${info.currentVersion}. ` +
          `Auto-updates are off, so I'll need you to apply it when you're ready.`
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
          `Heads up — I tried to update to v${info.latestVersion} but it didn't work out. ` +
          `I'm still running fine on v${result.previousVersion}, so nothing's broken. ` +
          `I'll try again next cycle.`
        );
        return;
      }

      // Step 4: Update succeeded
      this.lastApply = new Date().toISOString();
      this.pendingUpdate = null;
      this.saveState();

      console.log(`[AutoUpdater] Updated: v${result.previousVersion} → v${result.newVersion}`);

      // Step 5: Notify via Telegram (brief, conversational — the upgrade-notify session handles details)
      const restartNote = result.restartNeeded && this.config.autoRestart
        ? ' Restarting now to pick up the changes.'
        : result.restartNeeded
          ? ' A restart is needed to use the new version.'
          : '';

      // Only promise a summary if an upgrade guide exists for the new version.
      // Without a guide, the upgrade-notify session has nothing to report — don't
      // make a promise we can't keep.
      const guideExists = this.hasUpgradeGuide(result.newVersion);
      const summaryNote = guideExists
        ? ` I'll send you a summary of what's new once I'm back up.`
        : '';

      await this.notify(
        `Just updated to v${result.newVersion}.${restartNote}${summaryNote}`
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

    // After an update, prefer the global binary (which has the new version)
    // over process.argv (which may point to a stale npx cache).
    // Extract non-path args (server, start, --foreground, --dir, etc.)
    const cliArgs = process.argv.slice(2); // skip node + script path
    let instarBin: string | null = null;
    try {
      const which = execFileSync('which', ['instar'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (which && !which.includes('.npm/_npx')) {
        instarBin = which;
      }
    } catch { /* not found globally */ }

    // If `which instar` didn't find a global binary, try npm's prefix path directly.
    // This handles the common case where npm's global bin directory is not in PATH
    // (automation contexts, fresh shell sessions, custom npm prefixes).
    if (!instarBin) {
      try {
        const npmPrefix = execFileSync('npm', ['prefix', '-g'], {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const candidate = `${npmPrefix}/bin/instar`;
        if (fs.existsSync(candidate)) {
          instarBin = candidate;
          console.log(`[AutoUpdater] Found global binary via npm prefix: ${instarBin}`);
        }
      } catch { /* npm not available or prefix lookup failed */ }
    }

    let cmd: string;
    if (instarBin) {
      // Use the global binary — guaranteed to be the updated version
      const quotedArgs = cliArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
      cmd = `sleep 2 && exec '${instarBin.replace(/'/g, "'\\''")}' ${quotedArgs}`;
      console.log(`[AutoUpdater] Will restart from global binary: ${instarBin}`);
    } else {
      // No global binary found. If we were running from npx cache, restarting
      // from process.argv would loop (npx cache is the old version, which would
      // detect the update again and restart again indefinitely).
      const scriptPath = process.argv[1] || '';
      const isNpxCache = scriptPath.includes('.npm/_npx') || scriptPath.includes('/_npx/');
      if (isNpxCache) {
        console.error('[AutoUpdater] Update applied but cannot restart — global binary not found in PATH or npm prefix.');
        console.error('[AutoUpdater] Restarting from npx cache would cause a restart loop.');
        console.error('[AutoUpdater] Manual restart required: npm install -g instar && instar server start');
        void this.notify(
          `I've updated to the latest version, but I wasn't able to restart automatically. ` +
          `Could you restart me when you get a chance?`
        );
        return;
      }
      // Not from npx cache — safe to restart from current path
      const args = process.argv.slice(1)
        .map(a => `'${a.replace(/'/g, "'\\''")}'`)
        .join(' ');
      cmd = `sleep 2 && exec ${process.execPath} ${args}`;
      console.log('[AutoUpdater] No global binary found, restarting from current path');
    }

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
    const formatted = message;

    if (this.telegram) {
      try {
        const topicId = this.config.notificationTopicId || this.getNotificationTopicId();
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
   * Get the topic ID for update notifications.
   * Prefers the dedicated Agent Updates topic (informational), falls back to Agent Attention.
   */
  private getNotificationTopicId(): number {
    return this.state.get<number>('agent-updates-topic')
      || this.state.get<number>('agent-attention-topic')
      || 0;
  }

  /**
   * Get the server port from the update checker config (for notification messages).
   */
  private getPort(): number {
    // The port is available on the UpdateChecker config but not exposed.
    // Use a reasonable default — agents can find their port from config.
    return 4040;
  }

  // ── Upgrade guide detection ─────────────────────────────────────────

  /**
   * Check if an upgrade guide exists for the given version.
   * This is used to decide whether to promise a "what's new" summary
   * in the post-update notification — we should only make a promise
   * we can keep.
   */
  private hasUpgradeGuide(version: string): boolean {
    try {
      // This file is at dist/core/AutoUpdater.js after compilation.
      // The upgrades/ dir is at the package root (3 levels up).
      const moduleDir = path.resolve(
        new URL(import.meta.url).pathname,
        '..', '..', '..'
      );
      const guidePath = path.join(moduleDir, 'upgrades', `${version}.md`);
      return fs.existsSync(guidePath);
    } catch {
      return false;
    }
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
