/**
 * Server Supervisor — manages the full Instar server as a child process.
 *
 * Starts, monitors, and auto-restarts the server. Reports health status
 * back to the lifeline so it can inform users via Telegram.
 *
 * The supervisor spawns the server in a tmux session (same as `instar server start`)
 * and monitors it via health checks.
 */

import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { detectTmuxPath } from '../core/Config.js';

export interface SupervisorEvents {
  serverUp: [];
  serverDown: [reason: string];
  serverRestarting: [attempt: number];
}

export class ServerSupervisor extends EventEmitter {
  private projectDir: string;
  private projectName: string;
  private port: number;
  private tmuxPath: string | null;
  private serverSessionName: string;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private restartAttempts = 0;
  private maxRestartAttempts = 5;
  private restartBackoffMs = 5000;
  private isRunning = false;
  private lastHealthy = 0;
  private startupGraceMs = 20_000; // 20 seconds grace period after spawn before health checks
  private spawnedAt = 0;
  private retryCooldownMs = 5 * 60_000; // 5 minutes cooldown after max retries exhausted
  private maxRetriesExhaustedAt = 0;
  private consecutiveFailures = 0; // Hysteresis: require 2 consecutive failures before marking unhealthy
  private readonly unhealthyThreshold = 2;
  private stateDir: string | null;

  constructor(options: {
    projectDir: string;
    projectName: string;
    port: number;
    stateDir?: string;
  }) {
    super();
    this.projectDir = options.projectDir;
    this.projectName = options.projectName;
    this.port = options.port;
    this.stateDir = options.stateDir ?? null;
    this.tmuxPath = detectTmuxPath();
    this.serverSessionName = `${this.projectName}-server`;
  }

  /**
   * Start the server and begin monitoring.
   */
  async start(): Promise<boolean> {
    if (!this.tmuxPath) {
      console.error('[Supervisor] tmux not found');
      return false;
    }

    // Check if already running
    if (this.isServerSessionAlive()) {
      console.log(`[Supervisor] Server already running in tmux session: ${this.serverSessionName}`);
      this.isRunning = true;
      this.lastHealthy = Date.now();
      this.startHealthChecks();
      return true;
    }

    return this.spawnServer();
  }

  /**
   * Stop the server and monitoring.
   */
  async stop(): Promise<void> {
    this.stopHealthChecks();

    if (this.tmuxPath && this.isServerSessionAlive()) {
      try {
        // Graceful: send C-c
        execFileSync(this.tmuxPath, ['send-keys', '-t', `=${this.serverSessionName}:`, 'C-c'], {
          stdio: 'ignore', timeout: 5000,
        });

        // Wait briefly for graceful shutdown
        await new Promise(r => setTimeout(r, 3000));

        // Force kill if still alive
        if (this.isServerSessionAlive()) {
          execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
            stdio: 'ignore',
          });
        }
      } catch { /* ignore */ }
    }

    this.isRunning = false;
  }

  /**
   * Check if the server is currently healthy.
   */
  get healthy(): boolean {
    return this.isRunning && (Date.now() - this.lastHealthy) < 30_000;
  }

  /**
   * Get supervisor status.
   */
  getStatus(): {
    running: boolean;
    healthy: boolean;
    restartAttempts: number;
    lastHealthy: number;
    serverSession: string;
    coolingDown: boolean;
    cooldownRemainingMs: number;
  } {
    const coolingDown = this.maxRetriesExhaustedAt > 0;
    const cooldownRemainingMs = coolingDown
      ? Math.max(0, this.retryCooldownMs - (Date.now() - this.maxRetriesExhaustedAt))
      : 0;
    return {
      running: this.isRunning,
      healthy: this.healthy,
      restartAttempts: this.restartAttempts,
      lastHealthy: this.lastHealthy,
      serverSession: this.serverSessionName,
      coolingDown,
      cooldownRemainingMs,
    };
  }

  private spawnServer(): boolean {
    if (!this.tmuxPath) return false;

    try {
      // Get the instar CLI path
      const cliPath = new URL('../cli.js', import.meta.url).pathname;

      // --no-telegram: lifeline owns the Telegram connection, server should not poll
      const nodeCmd = ['node', cliPath, 'server', 'start', '--foreground', '--no-telegram']
        .map(arg => `'${arg.replace(/'/g, "'\\''")}'`)
        .join(' ');

      execFileSync(this.tmuxPath, [
        'new-session', '-d',
        '-s', this.serverSessionName,
        '-c', this.projectDir,
        nodeCmd,
      ], { stdio: 'ignore' });

      console.log(`[Supervisor] Server started in tmux session: ${this.serverSessionName}`);
      this.isRunning = true;
      this.spawnedAt = Date.now();
      this.startHealthChecks();
      return true;
    } catch (err) {
      console.error(`[Supervisor] Failed to start server: ${err}`);
      return false;
    }
  }

  private isServerSessionAlive(): boolean {
    if (!this.tmuxPath) return false;
    try {
      execFileSync(this.tmuxPath, ['has-session', '-t', `=${this.serverSessionName}`], {
        stdio: 'ignore', timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private startHealthChecks(): void {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(async () => {
      // Skip health checks during startup grace period — server needs time to boot
      if (this.spawnedAt > 0 && (Date.now() - this.spawnedAt) < this.startupGraceMs) {
        return;
      }

      try {
        const healthy = await this.checkHealth();
        if (healthy) {
          if (!this.isRunning) {
            this.clearPlannedRestartFlag();
            this.emit('serverUp');
          }
          this.isRunning = true;
          this.lastHealthy = Date.now();
          this.restartAttempts = 0;
          this.consecutiveFailures = 0;
        } else {
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= this.unhealthyThreshold) {
            this.handleUnhealthy();
          }
        }
      } catch {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.unhealthyThreshold) {
          this.handleUnhealthy();
        }
      }
    }, 10_000); // Check every 10 seconds
  }

  private stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
          signal: controller.signal,
        });
        return response.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  private handleUnhealthy(): void {
    // Check if this is a planned restart (e.g., auto-update in progress).
    // If so, suppress the "server down" alert and don't auto-restart —
    // the replacement process will come up on its own.
    if (this.isPlannedRestart()) {
      console.log('[Supervisor] Health check failed but update-restart flag is active — suppressing alert');
      this.consecutiveFailures = 0;
      // Reset grace period so the replacement process has time to start
      this.spawnedAt = Date.now();
      return;
    }

    if (this.isRunning) {
      this.isRunning = false;
      this.emit('serverDown', 'Health check failed');
    }
    this.consecutiveFailures = 0; // Reset after triggering action

    // After max retries exhausted, wait for cooldown before trying again.
    // This prevents permanent death from transient issues (port conflicts, etc.)
    if (this.restartAttempts >= this.maxRestartAttempts) {
      if (this.maxRetriesExhaustedAt === 0) {
        this.maxRetriesExhaustedAt = Date.now();
        console.error(`[Supervisor] Max restart attempts (${this.maxRestartAttempts}) reached. Cooling down for ${this.retryCooldownMs / 1000}s before retrying.`);
      }

      if ((Date.now() - this.maxRetriesExhaustedAt) >= this.retryCooldownMs) {
        // Cooldown elapsed — reset and try again
        console.log(`[Supervisor] Cooldown elapsed. Resetting restart counter.`);
        this.restartAttempts = 0;
        this.maxRetriesExhaustedAt = 0;
        // Fall through to the restart logic below
      } else {
        return; // Still cooling down
      }
    }

    // Auto-restart with backoff
    this.restartAttempts++;
    const delay = this.restartBackoffMs * Math.pow(2, this.restartAttempts - 1);
    console.log(`[Supervisor] Server unhealthy. Restart attempt ${this.restartAttempts}/${this.maxRestartAttempts} in ${delay}ms`);
    this.emit('serverRestarting', this.restartAttempts);

    setTimeout(() => {
      // Kill stale session if it exists
      if (this.tmuxPath && this.isServerSessionAlive()) {
        try {
          execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
            stdio: 'ignore',
          });
        } catch { /* ignore */ }
      }

      this.spawnServer();
    }, delay);
  }

  // ── Update restart flag ──────────────────────────────────────────

  /**
   * Check if the server is in a planned restart (e.g., auto-update).
   * The AutoUpdater writes a flag file with a TTL before restarting.
   */
  private isPlannedRestart(): boolean {
    if (!this.stateDir) return false;
    const flagPath = path.join(this.stateDir, 'state', 'update-restart.json');
    try {
      if (!fs.existsSync(flagPath)) return false;
      const data = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
      if (data.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
        // Expired — clean up and treat as unplanned failure
        try { fs.unlinkSync(flagPath); } catch { /* ignore */ }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear the update-restart flag after the server comes back healthy.
   */
  private clearPlannedRestartFlag(): void {
    if (!this.stateDir) return;
    const flagPath = path.join(this.stateDir, 'state', 'update-restart.json');
    try {
      if (fs.existsSync(flagPath)) {
        fs.unlinkSync(flagPath);
        console.log('[Supervisor] Cleared update-restart flag — server recovered after update');
      }
    } catch { /* ignore */ }
  }
}
