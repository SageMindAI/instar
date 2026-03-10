/**
 * Server Supervisor — manages the full Instar server as a child process.
 *
 * Starts, monitors, and auto-restarts the server. Reports health status
 * back to the lifeline so it can inform users via Telegram.
 *
 * The supervisor spawns the server in a tmux session (same as `instar server start`)
 * and monitors it via health checks.
 *
 * RESTART ARCHITECTURE (v0.9.63):
 * The server NEVER restarts itself. When the AutoUpdater installs an update,
 * it writes a `restart-requested.json` flag. The supervisor detects this flag
 * during its health check polling and performs a graceful restart. This eliminates
 * the entire category of self-restart bugs (PATH mismatch, launchd confusion,
 * binary resolution failures, restart loops).
 */

import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { detectTmuxPath } from '../core/Config.js';

/** Execute a shell command safely, returning stdout. */
function shellExec(cmd: string, timeout = 5000): string {
  return spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf-8', timeout }).stdout ?? '';
}

export interface SupervisorEvents {
  serverUp: [];
  serverDown: [reason: string];
  serverRestarting: [attempt: number];
  circuitBroken: [totalFailures: number, lastCrashOutput: string];
  debugRestartRequested: [request: { fixDescription: string; requestedBy: string }];
  debugRestartSkipped: [info: { fixDescription: string; reason: string }];
}

export class ServerSupervisor extends EventEmitter {
  private projectDir: string;
  private projectName: string;
  private port: number;
  private tmuxPath: string | null;
  private serverSessionName: string;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private lastHealthCheckAt = 0; // Wall-clock ms for sleep/wake detection
  private readonly sleepWakeGapMs = 2 * 60_000; // Gap > 2 min between 10s intervals = machine was suspended
  private restartAttempts = 0;
  private maxRestartAttempts = 5;
  private restartBackoffMs = 5000;
  private isRunning = false;
  private lastHealthy = 0;
  private startupGraceMs = 90_000; // 90 seconds grace period — allows time for native module auto-rebuild on first start
  private spawnedAt = 0;
  private retryCooldownMs = 5 * 60_000; // 5 minutes cooldown after max retries exhausted
  private maxRetriesExhaustedAt = 0;
  private consecutiveFailures = 0; // Hysteresis: require 2 consecutive failures before marking unhealthy
  private readonly unhealthyThreshold = 2;
  private stateDir: string | null;

  // Planned restart / maintenance wait — suppress alerts during expected downtime
  private maintenanceWaitStartedAt = 0;
  private maintenanceWaitMs = 5 * 60_000; // 5 minutes default (configurable via maintenanceWaitMinutes)

  // Circuit breaker — give up after too many total failures, but retry periodically
  private totalFailures = 0;
  private totalFailureWindowStart = 0;
  private readonly circuitBreakerThreshold = 20; // Total failures before tripping
  private readonly circuitBreakerWindowMs = 60 * 60_000; // 1-hour window
  private circuitBroken = false;
  private circuitBreakerTrippedAt = 0;
  private circuitBreakerRetryCount = 0;
  private readonly circuitBreakerRetryIntervalMs = 30 * 60_000; // 30 min between retries
  private readonly maxCircuitBreakerRetries = 3; // Try 3 times before truly giving up
  private lastCrashOutput = ''; // Last captured crash output for diagnostics
  private doctorSessionSecret: string | null = null; // HMAC secret for doctor restart requests

  constructor(options: {
    projectDir: string;
    projectName: string;
    port: number;
    stateDir?: string;
    /** How long to wait for server recovery during a planned restart before alerting. Default: 5 minutes. */
    maintenanceWaitMinutes?: number;
  }) {
    super();
    this.projectDir = options.projectDir;
    this.projectName = options.projectName;
    this.port = options.port;
    this.stateDir = options.stateDir ?? null;
    this.tmuxPath = detectTmuxPath();
    this.serverSessionName = `${this.projectName}-server`;

    if (options.maintenanceWaitMinutes !== undefined) {
      this.maintenanceWaitMs = options.maintenanceWaitMinutes * 60_000;
    }
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
    circuitBroken: boolean;
    totalFailures: number;
    lastCrashOutput: string;
    circuitBreakerRetryCount: number;
    maxCircuitBreakerRetries: number;
    inMaintenanceWait: boolean;
    maintenanceWaitElapsedMs: number;
  } {
    const coolingDown = this.maxRetriesExhaustedAt > 0;
    const cooldownRemainingMs = coolingDown
      ? Math.max(0, this.retryCooldownMs - (Date.now() - this.maxRetriesExhaustedAt))
      : 0;
    const inMaintenanceWait = this.maintenanceWaitStartedAt > 0;
    return {
      running: this.isRunning,
      healthy: this.healthy,
      restartAttempts: this.restartAttempts,
      lastHealthy: this.lastHealthy,
      serverSession: this.serverSessionName,
      coolingDown,
      cooldownRemainingMs,
      circuitBroken: this.circuitBroken,
      totalFailures: this.totalFailures,
      lastCrashOutput: this.lastCrashOutput,
      circuitBreakerRetryCount: this.circuitBreakerRetryCount,
      maxCircuitBreakerRetries: this.maxCircuitBreakerRetries,
      inMaintenanceWait,
      maintenanceWaitElapsedMs: inMaintenanceWait ? Date.now() - this.maintenanceWaitStartedAt : 0,
    };
  }

  /**
   * Reset the circuit breaker — allows restart attempts to resume.
   * Call this after fixing the underlying issue (e.g., via /lifeline restart).
   */
  resetCircuitBreaker(): void {
    this.circuitBroken = false;
    this.circuitBreakerTrippedAt = 0;
    this.circuitBreakerRetryCount = 0;
    this.totalFailures = 0;
    this.totalFailureWindowStart = 0;
    this.restartAttempts = 0;
    this.maxRetriesExhaustedAt = 0;
    console.log('[Supervisor] Circuit breaker reset');
  }

  /**
   * Set the HMAC secret for validating doctor session restart requests.
   * Called by TelegramLifeline when a doctor session is spawned.
   */
  setDoctorSessionSecret(secret: string): void {
    this.doctorSessionSecret = secret;
  }

  /**
   * Gracefully restart the server: capture output, kill tmux session,
   * clean up child processes, then spawn fresh.
   *
   * Used by: restart-request handling (auto-update), /lifeline restart command.
   */
  async performGracefulRestart(reason: string): Promise<boolean> {
    console.log(`[Supervisor] Graceful restart initiated: ${reason}`);
    this.emit('serverRestarting', 0);

    if (this.tmuxPath && this.isServerSessionAlive()) {
      this.captureCrashOutput();
      this.cleanupChildProcesses();
      try {
        // Send C-c for graceful shutdown
        execFileSync(this.tmuxPath, ['send-keys', '-t', `=${this.serverSessionName}:`, 'C-c'], {
          stdio: 'ignore', timeout: 5000,
        });
        await new Promise(r => setTimeout(r, 3000));

        // Force kill if still alive
        if (this.isServerSessionAlive()) {
          execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
            stdio: 'ignore',
          });
        }
      } catch { /* ignore */ }
    }

    // Wait for port release
    await new Promise(r => setTimeout(r, 2000));

    // Spawn fresh server — uses the updated binary since spawnServer resolves
    // cli.js relative to import.meta.url (the globally installed package)
    this.restartAttempts = 0;
    return this.spawnServer();
  }

  private spawnServer(): boolean {
    if (!this.tmuxPath) return false;

    try {
      // Get the instar CLI path — resolution order:
      //   1. Shadow install (agent's own managed version from AutoUpdater)
      //   2. Current binary location (how the lifeline was started)
      //
      // Shadow install is the agent's private copy at {stateDir}/shadow-install/.
      // The AutoUpdater installs updates there instead of globally, so each agent
      // manages its own version independently.
      let cliPath = new URL('../cli.js', import.meta.url).pathname;

      // Check for shadow install first — this is the agent's own managed version
      if (this.stateDir) {
        const shadowCli = path.join(this.stateDir, 'shadow-install', 'node_modules', 'instar', 'dist', 'cli.js');
        if (fs.existsSync(shadowCli)) {
          console.log(`[Supervisor] Using shadow install: ${shadowCli}`);
          cliPath = shadowCli;
        }
      }

      // Stderr capture: tee to crash log file for fast-exit diagnostics
      const crashLogDir = this.stateDir ? path.join(this.stateDir, 'logs') : '/tmp';
      try { fs.mkdirSync(crashLogDir, { recursive: true }); } catch { /* ignore */ }
      const crashLogPath = path.join(crashLogDir, 'server-stderr.log');

      // --no-telegram: lifeline owns the Telegram connection, server should not poll
      const quotedCli = cliPath.replace(/'/g, "'\\''");
      const nodeCmd = `'node' '${quotedCli}' 'server' 'start' '--foreground' '--no-telegram' 2> >(tee '${crashLogPath}' >&2)`;

      execFileSync(this.tmuxPath, [
        'new-session', '-d',
        '-s', this.serverSessionName,
        '-c', this.projectDir,
        `bash`, '-c', nodeCmd,
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
      const now = Date.now();

      // Sleep/wake detection: if the gap between health checks is much larger than
      // the poll interval, the machine was likely suspended (e.g., lid close after
      // an auto-update restart). Reset failure counters so brief wake cycles don't
      // exhaust restart attempts before the machine is fully awake.
      if (this.lastHealthCheckAt > 0 && (now - this.lastHealthCheckAt) > this.sleepWakeGapMs) {
        const gapSec = Math.round((now - this.lastHealthCheckAt) / 1000);
        console.log(`[Supervisor] Sleep/wake detected (${gapSec}s gap). Resetting failure counters.`);
        this.restartAttempts = 0;
        this.maxRetriesExhaustedAt = 0;
        this.consecutiveFailures = 0;
        this.totalFailures = 0;
        this.totalFailureWindowStart = 0;
        // Give the server the full startup grace period from wake time
        this.spawnedAt = now;
      }
      this.lastHealthCheckAt = now;

      // Skip health checks during startup grace period — server needs time to boot
      if (this.spawnedAt > 0 && (now - this.spawnedAt) < this.startupGraceMs) {
        // But still check for restart requests during grace period
        this.checkRestartRequest();
        return;
      }

      try {
        const healthy = await this.checkHealth();
        if (healthy) {
          if (!this.isRunning) {
            if (this.maintenanceWaitStartedAt > 0) {
              // Recovering from planned restart — quiet recovery, no notification
              const elapsedMs = Date.now() - this.maintenanceWaitStartedAt;
              console.log(`[Supervisor] Server recovered after planned restart (${Math.round(elapsedMs / 1000)}s downtime)`);
              this.maintenanceWaitStartedAt = 0;
              this.clearPlannedExitMarker();
              // Still replay queued messages (important!) but skip serverDown notification
              this.emit('serverUp');
            } else {
              this.emit('serverUp');
            }
          }
          this.isRunning = true;
          this.lastHealthy = Date.now();
          this.restartAttempts = 0;
          this.consecutiveFailures = 0;

          // If circuit breaker was tripped and we recovered, reset it
          if (this.circuitBroken) {
            console.log('[Supervisor] Server recovered after circuit breaker — resetting');
            this.resetCircuitBreaker();
          }
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

      // Check for restart requests from the server (e.g., auto-updater)
      this.checkRestartRequest();
      // Check for debug restart requests from doctor sessions
      this.checkDebugRestartRequest();
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

  // ── Restart request handling ──────────────────────────────────────

  /**
   * Check if the server (AutoUpdater) has requested a restart.
   * Called during the health check loop. If a valid request exists,
   * initiate a graceful restart of the server tmux session.
   */
  private checkRestartRequest(): void {
    if (!this.stateDir) return;
    const flagPath = path.join(this.stateDir, 'state', 'restart-requested.json');

    try {
      if (!fs.existsSync(flagPath)) return;
      const data = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));

      // Check TTL
      if (data.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
        try { fs.unlinkSync(flagPath); } catch { /* ignore */ }
        console.log('[Supervisor] Expired restart request — ignoring');
        return;
      }

      console.log(`[Supervisor] Restart requested by ${data.requestedBy} for v${data.targetVersion}`);

      // RESTART LOOP DETECTION: If we've already restarted for this version,
      // the binary isn't actually updating (npx cache mismatch). Don't loop.
      const restartCountFile = path.join(this.stateDir!, 'state', 'restart-version-count.json');
      let restartCount = 0;
      try {
        if (fs.existsSync(restartCountFile)) {
          const countData = JSON.parse(fs.readFileSync(restartCountFile, 'utf-8'));
          if (countData.targetVersion === data.targetVersion) {
            restartCount = (countData.count ?? 0);
          }
        }
      } catch { /* fresh count */ }

      if (restartCount >= 2) {
        console.log(`[Supervisor] Restart loop detected — already restarted ${restartCount}x for v${data.targetVersion}. Skipping.`);
        try { fs.unlinkSync(flagPath); } catch { /* ignore */ }
        // Clean up the count file so it doesn't block future real updates
        try { fs.unlinkSync(restartCountFile); } catch { /* ignore */ }
        return;
      }

      // Increment restart count for this version
      try {
        const stateSubdir = path.join(this.stateDir!, 'state');
        fs.mkdirSync(stateSubdir, { recursive: true });
        fs.writeFileSync(restartCountFile, JSON.stringify({
          targetVersion: data.targetVersion,
          count: restartCount + 1,
          lastRestartAt: new Date().toISOString(),
        }));
      } catch { /* best-effort */ }

      // Enter maintenance wait if this is a planned restart (suppress serverDown alerts)
      if (data.plannedRestart) {
        this.maintenanceWaitStartedAt = Date.now();
        console.log(`[Supervisor] Planned restart — entering maintenance wait (${Math.round(this.maintenanceWaitMs / 60_000)}m window)`);
      }

      // Clear the flag BEFORE restarting to prevent re-triggering
      try { fs.unlinkSync(flagPath); } catch { /* ignore */ }

      // Also clean up legacy flag if present
      this.clearLegacyRestartFlag();

      // Clean up any planned-exit marker from ForegroundRestartWatcher
      this.clearPlannedExitMarker();

      // Initiate graceful restart
      this.performGracefulRestart(`update to v${data.targetVersion}`);
    } catch {
      // Malformed flag — clean up
      try { fs.unlinkSync(flagPath); } catch { /* ignore */ }
    }
  }

  // ── Debug restart request handling (doctor session) ─────────────

  /**
   * Check if a doctor session has requested a restart via HMAC-signed file.
   * Called during the health check loop alongside checkRestartRequest().
   */
  private checkDebugRestartRequest(): void {
    if (!this.stateDir) return;
    const requestPath = path.join(this.stateDir, 'debug-restart-request.json');

    try {
      if (!fs.existsSync(requestPath)) return;

      const raw = fs.readFileSync(requestPath, 'utf-8');
      fs.unlinkSync(requestPath); // consume the request immediately

      const request = JSON.parse(raw);

      // TTL check — reject requests older than 30 minutes
      const requestAge = Date.now() - new Date(request.requestedAt).getTime();
      if (requestAge > 30 * 60_000) {
        console.log(`[Supervisor] Stale debug restart request (${Math.round(requestAge / 60_000)}m old) — discarded`);
        return;
      }

      // HMAC validation
      if (!this.validateRestartHmac(request)) {
        console.warn(`[Supervisor] Invalid HMAC on debug restart request — rejected`);
        return;
      }

      // Sanitize fixDescription before display (self-reported, untrusted)
      const safeDescription = (request.fixDescription || 'no description')
        .replace(/[<>&"']/g, '') // strip HTML-like chars
        .slice(0, 200); // cap length

      console.log(`[Supervisor] Debug session fix (self-reported): ${safeDescription}`);

      // Check if server already recovered
      if (this.healthy) {
        console.log(`[Supervisor] Server already healthy — skipping restart, noting fix`);
        this.emit('debugRestartSkipped', { fixDescription: safeDescription, reason: 'server_already_healthy' });
        return;
      }

      this.emit('debugRestartRequested', { fixDescription: safeDescription, requestedBy: request.requestedBy || 'doctor-session' });

      // Reset circuit breaker and restart
      this.resetCircuitBreaker();
      this.stop().then(() => this.start());
    } catch (err) {
      console.error(`[Supervisor] Error processing debug restart request: ${err}`);
    }
  }

  /**
   * Validate HMAC on a debug restart request using the doctor session secret.
   */
  private validateRestartHmac(request: { requestedAt?: string; fixDescription?: string; hmac?: string }): boolean {
    if (!this.doctorSessionSecret || !request.hmac || !request.requestedAt) return false;

    try {
      const expectedPayload = request.requestedAt + (request.fixDescription || '');
      const expectedHmac = crypto
        .createHmac('sha256', this.doctorSessionSecret)
        .update(expectedPayload)
        .digest('hex');

      // Use timing-safe comparison to prevent timing attacks
      const hmacBuf = Buffer.from(request.hmac, 'hex');
      const expectedBuf = Buffer.from(expectedHmac, 'hex');

      if (hmacBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(hmacBuf, expectedBuf);
    } catch {
      return false;
    }
  }

  // ── Unhealthy handling ──────────────────────────────────────────

  private handleUnhealthy(): void {
    // Circuit breaker — periodic retry instead of permanent death
    if (this.circuitBroken) {
      if (this.circuitBreakerRetryCount >= this.maxCircuitBreakerRetries) {
        return; // Truly given up — needs manual intervention
      }

      const elapsed = Date.now() - this.circuitBreakerTrippedAt;
      const nextRetryAt = this.circuitBreakerRetryIntervalMs * (this.circuitBreakerRetryCount + 1);

      if (elapsed >= nextRetryAt) {
        this.circuitBreakerRetryCount++;
        console.log(`[Supervisor] Circuit breaker retry ${this.circuitBreakerRetryCount}/${this.maxCircuitBreakerRetries}`);
        this.emit('serverRestarting', this.circuitBreakerRetryCount);

        // Kill existing session if alive
        if (this.tmuxPath && this.isServerSessionAlive()) {
          this.captureCrashOutput();
          this.cleanupChildProcesses();
          try {
            execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
              stdio: 'ignore',
            });
          } catch { /* ignore */ }
        }

        this.spawnServer();
      }
      return;
    }

    // Check for legacy planned restart flag (backward compatibility with old AutoUpdater)
    if (this.isLegacyPlannedRestart()) {
      if (!this.isServerSessionAlive()) {
        console.log('[Supervisor] Legacy planned restart detected — server session dead. Respawning.');
        this.clearLegacyRestartFlag();
        this.consecutiveFailures = 0;
        this.spawnServer();
        return;
      }
      console.log('[Supervisor] Health check failed but legacy update-restart flag is active — suppressing alert');
      this.consecutiveFailures = 0;
      this.spawnedAt = Date.now();
      return;
    }

    // Check for planned restart (new AutoUpdater with plannedRestart: true, or
    // ForegroundRestartWatcher exit marker). Suppress serverDown during the
    // maintenance wait window — this is expected downtime, not a crash.
    if (this.isPendingPlannedRestart()) {
      if (!this.isServerSessionAlive()) {
        console.log('[Supervisor] Planned restart in progress — server session dead. Respawning.');
        this.consecutiveFailures = 0;
        this.spawnServer();
        return;
      }
      console.log('[Supervisor] Health check failed during planned restart — suppressing alert');
      this.consecutiveFailures = 0;
      return;
    }

    if (this.isRunning) {
      this.isRunning = false;
      this.emit('serverDown', 'Health check failed');
    }
    this.consecutiveFailures = 0; // Reset after triggering action

    // After max retries exhausted, wait for cooldown before trying again.
    // IMPORTANT: Check cooldown BEFORE incrementing totalFailures. Otherwise, passive health check
    // failures during cooldown accumulate and trip the circuit breaker, escalating a recoverable
    // 5-min cooldown into a 30-min circuit breaker stall. Only actual restart failures should
    // count toward the circuit breaker threshold.
    if (this.restartAttempts >= this.maxRestartAttempts) {
      if (this.maxRetriesExhaustedAt === 0) {
        this.maxRetriesExhaustedAt = Date.now();
        console.error(`[Supervisor] Max restart attempts (${this.maxRestartAttempts}) reached. Cooling down for ${this.retryCooldownMs / 1000}s before retrying.`);
      }

      if ((Date.now() - this.maxRetriesExhaustedAt) >= this.retryCooldownMs) {
        console.log(`[Supervisor] Cooldown elapsed. Resetting restart counter.`);
        this.restartAttempts = 0;
        this.maxRetriesExhaustedAt = 0;
      } else {
        return; // Still cooling down — skip totalFailures increment
      }
    }

    // Track total failures for circuit breaker (only incremented for active failure handling, not passive cooldown)
    const now = Date.now();
    if (this.totalFailureWindowStart === 0 || (now - this.totalFailureWindowStart) > this.circuitBreakerWindowMs) {
      // Reset window
      this.totalFailureWindowStart = now;
      this.totalFailures = 0;
    }
    this.totalFailures++;

    // Circuit breaker: too many total failures in the window → trip (but with periodic retry)
    if (this.totalFailures >= this.circuitBreakerThreshold) {
      this.circuitBroken = true;
      this.circuitBreakerTrippedAt = Date.now();
      this.circuitBreakerRetryCount = 0;
      console.error(`[Supervisor] CIRCUIT BREAKER: ${this.totalFailures} failures in ${Math.round(this.circuitBreakerWindowMs / 60000)}m window. Will retry every ${this.circuitBreakerRetryIntervalMs / 60000}m (${this.maxCircuitBreakerRetries}x).`);
      console.error(`[Supervisor] Last crash output:\n${this.lastCrashOutput}`);
      this.emit('circuitBroken', this.totalFailures, this.lastCrashOutput);
      return;
    }

    // Auto-restart with backoff
    this.restartAttempts++;
    const delay = this.restartBackoffMs * Math.pow(2, this.restartAttempts - 1);
    console.log(`[Supervisor] Server unhealthy. Restart attempt ${this.restartAttempts}/${this.maxRestartAttempts} in ${delay}ms`);
    this.emit('serverRestarting', this.restartAttempts);

    setTimeout(() => {
      // Capture crash output BEFORE killing the tmux session
      if (this.tmuxPath && this.isServerSessionAlive()) {
        this.captureCrashOutput();
        this.cleanupChildProcesses();
        try {
          execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
            stdio: 'ignore',
          });
        } catch { /* ignore */ }
      }

      this.spawnServer();
    }, delay);
  }

  // ── Crash diagnostics ──────────────────────────────────────────

  /**
   * Capture crash output from multiple sources:
   * 1. tmux pane capture (last 50 lines of terminal output)
   * 2. stderr crash log file (tee'd from server process)
   */
  private captureCrashOutput(): void {
    // Try tmux pane capture first
    if (this.tmuxPath) {
      try {
        const output = execFileSync(this.tmuxPath, [
          'capture-pane', '-t', `=${this.serverSessionName}:`, '-p', '-S', '-50',
        ], { encoding: 'utf-8', timeout: 5000 });
        if (output.trim()) {
          this.lastCrashOutput = output.trim();
          console.log(`[Supervisor] Crash output from tmux:\n${this.lastCrashOutput.slice(-500)}`);
          return;
        }
      } catch { // @silent-fallback-ok — capture may fail if session already dead
      }
    }

    // Fallback: read the stderr crash log
    if (this.stateDir) {
      const crashLogPath = path.join(this.stateDir, 'logs', 'server-stderr.log');
      try {
        if (fs.existsSync(crashLogPath)) {
          const content = fs.readFileSync(crashLogPath, 'utf-8');
          const last500 = content.slice(-500).trim();
          if (last500) {
            this.lastCrashOutput = last500;
            console.log(`[Supervisor] Crash output from stderr log:\n${last500}`);
          }
        }
      } catch { /* ignore */ }
    }
  }

  /**
   * Kill child processes (cloudflared, etc.) that were spawned by the server
   * but will become orphans when the tmux session is killed.
   */
  private cleanupChildProcesses(): void {
    if (!this.tmuxPath) return;
    try {
      const panePid = execFileSync(this.tmuxPath, [
        'list-panes', '-t', `=${this.serverSessionName}`, '-F', '#{pane_pid}',
      ], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0];

      if (!panePid) return;

      const descendants = shellExec(
        `pgrep -P ${panePid} 2>/dev/null; pgrep -g ${panePid} 2>/dev/null`,
      ).trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n));

      const unique = [...new Set(descendants)].filter(pid => pid !== parseInt(panePid));

      if (unique.length > 0) {
        console.log(`[Supervisor] Cleaning up ${unique.length} child process(es) before restart: ${unique.join(', ')}`);
        for (const pid of unique) {
          try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
        }
        setTimeout(() => {
          for (const pid of unique) {
            try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); } catch { /* dead */ }
          }
        }, 3000);
      }
    } catch { // @silent-fallback-ok — cleanup is best-effort
    }
  }

  // ── Legacy flag handling (backward compatibility) ──────────────

  /**
   * Check for the legacy update-restart.json flag (written by old AutoUpdater versions).
   * New versions write restart-requested.json instead, handled by checkRestartRequest().
   */
  private isLegacyPlannedRestart(): boolean {
    if (!this.stateDir) return false;
    const flagPath = path.join(this.stateDir, 'state', 'update-restart.json');
    try {
      if (!fs.existsSync(flagPath)) return false;
      const data = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
      if (data.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
        try { fs.unlinkSync(flagPath); } catch { /* ignore */ }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private clearLegacyRestartFlag(): void {
    if (!this.stateDir) return;
    const flagPath = path.join(this.stateDir, 'state', 'update-restart.json');
    try {
      if (fs.existsSync(flagPath)) {
        fs.unlinkSync(flagPath);
        console.log('[Supervisor] Cleared legacy update-restart flag');
      }
    } catch { /* ignore */ }
  }

  // ── Planned restart detection ──────────────────────────────

  /**
   * Check if a planned restart is in progress.
   *
   * Two sources of truth (covers both race scenarios):
   * 1. Internal state: set by checkRestartRequest() when it sees plannedRestart: true
   * 2. Planned-exit marker: written by ForegroundRestartWatcher before process.exit()
   *    when it consumed the restart-requested.json before us
   *
   * Auto-expires after maintenanceWaitMs (default 5 min). If the server doesn't
   * come back within the window, fall back to normal alerting.
   */
  private isPendingPlannedRestart(): boolean {
    // Source 1: Internal state (supervisor saw the flag directly)
    if (this.maintenanceWaitStartedAt > 0) {
      const elapsed = Date.now() - this.maintenanceWaitStartedAt;
      if (elapsed > this.maintenanceWaitMs) {
        console.warn(`[Supervisor] Maintenance wait expired after ${Math.round(elapsed / 1000)}s — falling back to normal alerting`);
        this.maintenanceWaitStartedAt = 0;
        return false;
      }
      return true;
    }

    // Source 2: Planned-exit marker (ForegroundRestartWatcher consumed the flag first)
    if (!this.stateDir) return false;
    const markerPath = path.join(this.stateDir, 'state', 'planned-exit-marker.json');
    try {
      if (!fs.existsSync(markerPath)) return false;
      const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));

      // Marker exists — enter maintenance wait mode
      console.log(`[Supervisor] Found planned-exit marker (target: v${data.targetVersion}) — entering maintenance wait`);
      this.maintenanceWaitStartedAt = new Date(data.exitedAt).getTime() || Date.now();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clean up the planned-exit marker written by ForegroundRestartWatcher.
   */
  private clearPlannedExitMarker(): void {
    if (!this.stateDir) return;
    const markerPath = path.join(this.stateDir, 'state', 'planned-exit-marker.json');
    try {
      if (fs.existsSync(markerPath)) {
        fs.unlinkSync(markerPath);
      }
    } catch { /* ignore */ }
  }
}
