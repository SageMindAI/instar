/**
 * ForegroundRestartWatcher — Detects restart-requested signals in foreground mode.
 *
 * ROOT CAUSE (v0.9.71 investigation):
 * The AutoUpdater writes `restart-requested.json` after installing an update.
 * The ServerSupervisor (lifeline) polls this file and performs the restart.
 * BUT: when the server runs in `--foreground` mode (which ALL agents currently do),
 * there IS no supervisor — nobody picks up the restart signal, it expires after
 * the TTL, and the process runs forever on old code.
 *
 * This module fills that gap for foreground mode:
 * 1. Polls for `restart-requested.json` every 10 seconds (matching supervisor cadence)
 * 2. When detected: sends IMMEDIATE notification, logs loudly, exits cleanly
 * 3. The process exit allows the tmux session or wrapper to respawn
 *
 * This module is ONLY used in foreground mode. When a supervisor is running,
 * it handles restarts and this watcher should not be started.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export interface RestartRequest {
  requestedAt: string;
  requestedBy: string;
  targetVersion: string;
  previousVersion: string;
  plannedRestart?: boolean;
  expiresAt?: string;
  pid?: number;
}

export interface ForegroundRestartWatcherConfig {
  stateDir: string;
  /** Callback to send a notification before exiting. */
  onRestartDetected?: (request: RestartRequest) => void | Promise<void>;
  /** Poll interval in ms. Default: 10_000 (10 seconds). */
  pollIntervalMs?: number;
  /** Graceful shutdown delay in ms after notification. Default: 3_000 (3 seconds). */
  shutdownDelayMs?: number;
  /** If true, exit the process after detecting restart. Default: true. */
  exitOnRestart?: boolean;
  /** Process exit code. Default: 0. */
  exitCode?: number;
}

export class ForegroundRestartWatcher extends EventEmitter {
  private config: ForegroundRestartWatcherConfig;
  private interval: ReturnType<typeof setInterval> | null = null;
  private flagPath: string;
  private isShuttingDown = false;

  constructor(config: ForegroundRestartWatcherConfig) {
    super();
    this.config = config;
    this.flagPath = path.join(config.stateDir, 'state', 'restart-requested.json');
  }

  start(): void {
    if (this.interval) return;

    const pollMs = this.config.pollIntervalMs ?? 10_000;
    this.interval = setInterval(() => this.check(), pollMs);
    this.interval.unref(); // Don't keep process alive just for polling

    console.log(`[ForegroundRestartWatcher] Watching for restart signals (every ${pollMs / 1000}s)`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Check for a restart-requested signal. If found and valid, trigger shutdown.
   */
  private async check(): Promise<void> {
    if (this.isShuttingDown) return;

    try {
      if (!fs.existsSync(this.flagPath)) return;

      const raw = fs.readFileSync(this.flagPath, 'utf-8');
      const data: RestartRequest = JSON.parse(raw);

      // Check TTL — but DON'T silently ignore expired requests.
      // In foreground mode, the restart is critical. If the flag expired,
      // it means we've been stale for too long. Still restart.
      const isExpired = data.expiresAt && new Date(data.expiresAt).getTime() < Date.now();

      if (isExpired) {
        console.warn(`[ForegroundRestartWatcher] Restart request EXPIRED but still acting on it — stale process is worse than late restart`);
      }

      console.log(`[ForegroundRestartWatcher] Restart requested by ${data.requestedBy} for v${data.targetVersion} (from v${data.previousVersion})`);

      // Clear the flag to prevent re-triggering on next startup
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(this.flagPath); } catch { /* ignore */ }

      // Write a planned-exit marker so the supervisor (if running) knows this
      // was a planned restart, not a crash. Solves the race condition where we
      // consume restart-requested.json before the supervisor sees it.
      if (data.plannedRestart) {
        const markerPath = path.join(path.dirname(this.flagPath), 'planned-exit-marker.json');
        try {
          fs.writeFileSync(markerPath, JSON.stringify({
            exitedAt: new Date().toISOString(),
            targetVersion: data.targetVersion,
            previousVersion: data.previousVersion,
            pid: process.pid,
          }));
        } catch { /* best effort */ }
      }

      this.isShuttingDown = true;
      this.emit('restartDetected', data);

      // Notify via callback (e.g., Telegram)
      if (this.config.onRestartDetected) {
        try {
          await this.config.onRestartDetected(data);
        } catch (err) {
          console.error(`[ForegroundRestartWatcher] Notification callback failed:`, err);
        }
      }

      // Graceful shutdown delay — let notifications flush
      const shouldExit = this.config.exitOnRestart ?? true;
      if (shouldExit) {
        const delayMs = this.config.shutdownDelayMs ?? 3_000;
        console.log(`[ForegroundRestartWatcher] Exiting in ${delayMs / 1000}s for restart...`);
        setTimeout(() => {
          console.log(`[ForegroundRestartWatcher] Goodbye. Restart to load v${data.targetVersion}.`);
          process.exit(this.config.exitCode ?? 0);
        }, delayMs);
      }
    } catch {
      // Malformed flag — clean up
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(this.flagPath); } catch { /* ignore */ }
    }
  }
}
