/**
 * Health Checker — aggregates component health into a single status.
 *
 * Checks tmux availability, session state, scheduler health,
 * and disk space. Returns a HealthStatus object.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionManager } from '../core/SessionManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
import type { HealthStatus, ComponentHealth, InstarConfig } from '../core/types.js';
import type { SessionWatchdog } from './SessionWatchdog.js';
import type { StallTriageNurse } from './StallTriageNurse.js';
import type { MemoryPressureMonitor } from './MemoryPressureMonitor.js';

export class HealthChecker {
  private config: InstarConfig;
  private sessionManager: SessionManager;
  private scheduler: JobScheduler | null;
  private watchdog: SessionWatchdog | null;
  private triageNurse: StallTriageNurse | null;
  private memoryMonitor: MemoryPressureMonitor | null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private lastStatus: HealthStatus | null = null;

  constructor(
    config: InstarConfig,
    sessionManager: SessionManager,
    scheduler: JobScheduler | null = null,
    watchdog: SessionWatchdog | null = null,
    triageNurse: StallTriageNurse | null = null,
    memoryMonitor: MemoryPressureMonitor | null = null,
  ) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.scheduler = scheduler;
    this.watchdog = watchdog;
    this.triageNurse = triageNurse;
    this.memoryMonitor = memoryMonitor;
  }

  /**
   * Run all health checks and return aggregated status.
   */
  check(): HealthStatus {
    const components: Record<string, ComponentHealth> = {};

    components.tmux = this.checkTmux();
    components.sessions = this.checkSessions();
    components.stateDir = this.checkStateDir();
    components.memory = this.checkMemory();

    if (this.scheduler) {
      components.scheduler = this.checkScheduler();
    }

    if (this.watchdog) {
      const wdStatus = this.watchdog.getStatus();
      const intervening = wdStatus.sessions.filter(s => s.escalation && s.escalation.level > 0);
      components.watchdog = {
        status: intervening.length > 0 ? 'degraded' : 'healthy',
        message: intervening.length > 0
          ? `Intervening on ${intervening.length} session(s)`
          : `Monitoring${wdStatus.enabled ? '' : ' (disabled)'}`,
        lastCheck: new Date().toISOString(),
      };
    }

    if (this.triageNurse) {
      const triageStatus = this.triageNurse.getStatus();
      components.triage = {
        status: triageStatus.activeCases > 0 ? 'degraded' : 'healthy',
        message: triageStatus.activeCases > 0
          ? `Triaging ${triageStatus.activeCases} case(s)`
          : `Ready (${triageStatus.historyCount} past triages)`,
        lastCheck: new Date().toISOString(),
      };
    }

    // Aggregate: worst component status becomes overall status
    const statuses = Object.values(components).map(c => c.status);
    let overall: HealthStatus['status'] = 'healthy';
    if (statuses.includes('unhealthy')) overall = 'unhealthy';
    else if (statuses.includes('degraded')) overall = 'degraded';

    this.lastStatus = {
      status: overall,
      components,
      timestamp: new Date().toISOString(),
    };

    return this.lastStatus;
  }

  /**
   * Get the last computed health status without re-checking.
   */
  getLastStatus(): HealthStatus | null {
    return this.lastStatus;
  }

  /**
   * Start periodic health checks.
   */
  startPeriodicChecks(intervalMs?: number): void {
    if (this.checkInterval) return;

    const interval = intervalMs ?? this.config.monitoring.healthCheckIntervalMs;
    if (!interval || interval <= 0) {
      throw new Error(`Health check interval must be positive, got ${interval}`);
    }
    this.check(); // Run immediately
    this.checkInterval = setInterval(() => this.check(), interval);
  }

  /**
   * Stop periodic health checks.
   */
  stopPeriodicChecks(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private checkTmux(): ComponentHealth {
    const now = new Date().toISOString();
    try {
      execFileSync(this.config.sessions.tmuxPath, ['list-sessions'], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { status: 'healthy', message: 'tmux server responding', lastCheck: now };
    } catch {
      // tmux server not running is ok if no sessions needed
      try {
        execFileSync(this.config.sessions.tmuxPath, ['-V'], {
          encoding: 'utf-8',
          timeout: 3000,
        });
        return { status: 'healthy', message: 'tmux available (no server running)', lastCheck: now };
      } catch {
        return { status: 'unhealthy', message: 'tmux binary not found', lastCheck: now };
      }
    }
  }

  private checkSessions(): ComponentHealth {
    const now = new Date().toISOString();
    try {
      const running = this.sessionManager.listRunningSessions();
      const max = this.config.sessions.maxSessions;

      if (running.length >= max) {
        return {
          status: 'degraded',
          message: `At capacity: ${running.length}/${max} sessions`,
          lastCheck: now,
        };
      }

      return {
        status: 'healthy',
        message: `${running.length}/${max} sessions active`,
        lastCheck: now,
      };
    } catch (err) {
      return { status: 'unhealthy', message: `Session check failed: ${err instanceof Error ? err.message : String(err)}`, lastCheck: now };
    }
  }

  private checkScheduler(): ComponentHealth {
    const now = new Date().toISOString();
    if (!this.scheduler) {
      return { status: 'healthy', message: 'Scheduler not configured', lastCheck: now };
    }

    const status = this.scheduler.getStatus();

    if (!status.running) {
      return { status: 'degraded', message: 'Scheduler not running', lastCheck: now };
    }

    if (status.paused) {
      return { status: 'degraded', message: 'Scheduler paused', lastCheck: now };
    }

    return {
      status: 'healthy',
      message: `Running: ${status.enabledJobs} jobs, ${status.queueLength} queued`,
      lastCheck: now,
    };
  }

  private checkMemory(): ComponentHealth {
    const now = new Date().toISOString();
    try {
      // Prefer MemoryPressureMonitor's vm_stat-based calculation on macOS.
      // os.freemem() only counts "Pages free" and ignores reclaimable
      // inactive/purgeable pages, reporting wildly pessimistic numbers.
      let totalGB: number;
      let freeGB: number;
      let usedPercent: number;

      if (this.memoryMonitor) {
        const memState = this.memoryMonitor.getState();
        totalGB = memState.totalGB;
        freeGB = memState.freeGB;
        usedPercent = memState.pressurePercent;
      } else {
        const totalBytes = os.totalmem();
        const freeBytes = os.freemem();
        totalGB = totalBytes / (1024 ** 3);
        freeGB = freeBytes / (1024 ** 3);
        usedPercent = ((totalBytes - freeBytes) / totalBytes) * 100;
      }

      if (usedPercent >= 90) {
        return { status: 'unhealthy', message: `Memory critical: ${usedPercent.toFixed(0)}% used (${freeGB.toFixed(1)}GB free)`, lastCheck: now };
      }
      if (usedPercent >= 75) {
        return { status: 'degraded', message: `Memory elevated: ${usedPercent.toFixed(0)}% used (${freeGB.toFixed(1)}GB free)`, lastCheck: now };
      }
      return { status: 'healthy', message: `${usedPercent.toFixed(0)}% used (${freeGB.toFixed(1)}GB free / ${totalGB.toFixed(0)}GB total)`, lastCheck: now };
    } catch (err) {
      return { status: 'degraded', message: `Memory check failed: ${err instanceof Error ? err.message : String(err)}`, lastCheck: now };
    }
  }

  private checkStateDir(): ComponentHealth {
    const now = new Date().toISOString();
    try {
      const exists = fs.existsSync(this.config.stateDir);
      if (!exists) {
        return { status: 'unhealthy', message: 'State directory missing', lastCheck: now };
      }

      // Check we can write — fixed name prevents orphaned files on crash
      const testFile = path.join(this.config.stateDir, '.health-check-probe');
      fs.writeFileSync(testFile, 'ok');
      // safe-git-allow: incremental-migration
      fs.unlinkSync(testFile);

      return { status: 'healthy', message: 'State directory writable', lastCheck: now };
    } catch (err) {
      return { status: 'unhealthy', message: `State dir error: ${err instanceof Error ? err.message : String(err)}`, lastCheck: now };
    }
  }
}
