/**
 * TelemetryHeartbeat — Opt-in anonymous usage telemetry for Instar.
 *
 * Sends periodic heartbeats with anonymous, aggregate usage data.
 * Default OFF. No PII. No conversation content. Agent owners opt in explicitly.
 *
 * What gets sent (basic level):
 *   - Instar version, Node version, OS/arch
 *   - Hashed installation ID (cannot be reversed)
 *   - Agent count, uptime
 *
 * What gets sent (usage level, in addition to basic):
 *   - Jobs run in last 24h (count only)
 *   - Sessions spawned in last 24h (count only)
 *   - Skills invoked in last 24h (count only)
 *
 * What is NEVER sent:
 *   - Agent names, prompts, or configuration
 *   - Conversation content or memory data
 *   - File paths, environment variables, or secrets
 *   - IP addresses (not logged server-side)
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { TelemetryConfig, TelemetryLevel } from '../core/types.js';

const DEFAULT_ENDPOINT = 'https://instar-telemetry.sagemind-ai.workers.dev/v1/heartbeat';
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const SEND_TIMEOUT_MS = 3000; // Fire-and-forget, never block agent operation
const HEARTBEAT_VERSION = 1;

export interface TelemetryHeartbeatConfig {
  enabled: boolean;
  level: TelemetryLevel;
  intervalMs: number;
  endpoint: string;
  stateDir: string;
  projectDir: string;
  version: string;
}

export interface HeartbeatPayload {
  v: number;
  id: string;
  ts: string;
  instar: string;
  node: string;
  os: string;
  arch: string;
  agents: number;
  uptime_hours: number;
  jobs_run_24h?: number;
  sessions_spawned_24h?: number;
  skills_invoked_24h?: number;
}

// Usage counters — other modules call these to record events
interface UsageCounters {
  jobsRun: number;
  sessionsSpawned: number;
  skillsInvoked: number;
  lastReset: number;
}

export class TelemetryHeartbeat extends EventEmitter {
  private config: TelemetryHeartbeatConfig;
  private interval: ReturnType<typeof setInterval> | null = null;
  private installId: string;
  private startTime: number;
  private counters: UsageCounters;
  private agentCountFn: (() => number) | null = null;

  constructor(telemetryConfig: TelemetryConfig, stateDir: string, projectDir: string, version: string) {
    super();
    this.config = {
      enabled: telemetryConfig.enabled,
      level: telemetryConfig.level ?? 'basic',
      intervalMs: telemetryConfig.intervalMs ?? DEFAULT_INTERVAL_MS,
      endpoint: telemetryConfig.endpoint ?? DEFAULT_ENDPOINT,
      stateDir,
      projectDir,
      version,
    };
    this.installId = this.computeInstallId();
    this.startTime = Date.now();
    this.counters = {
      jobsRun: 0,
      sessionsSpawned: 0,
      skillsInvoked: 0,
      lastReset: Date.now(),
    };
  }

  /**
   * Start the periodic heartbeat.
   * Sends first heartbeat after a short delay (not immediately on boot).
   */
  start(): void {
    if (!this.config.enabled) return;

    // First heartbeat after 60 seconds (let the server stabilize)
    setTimeout(() => {
      this.sendHeartbeat().catch(() => {});
    }, 60_000);

    this.interval = setInterval(() => {
      this.sendHeartbeat().catch(() => {});
    }, this.config.intervalMs);

    // Don't prevent process exit
    if (this.interval.unref) this.interval.unref();
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Register a function that returns the current agent count.
   * Called lazily at heartbeat time.
   */
  setAgentCountProvider(fn: () => number): void {
    this.agentCountFn = fn;
  }

  // ── Recording Methods (called by other modules) ──────────────────

  recordJobRun(): void {
    this.counters.jobsRun++;
  }

  recordSessionSpawned(): void {
    this.counters.sessionsSpawned++;
  }

  recordSkillInvoked(): void {
    this.counters.skillsInvoked++;
  }

  // ── Heartbeat Construction & Sending ─────────────────────────────

  buildPayload(): HeartbeatPayload {
    const payload: HeartbeatPayload = {
      v: HEARTBEAT_VERSION,
      id: this.installId,
      ts: new Date().toISOString(),
      instar: this.config.version,
      node: process.version.replace('v', ''),
      os: os.platform(),
      arch: os.arch(),
      agents: this.agentCountFn?.() ?? 0,
      uptime_hours: Math.round((Date.now() - this.startTime) / 3600000 * 10) / 10,
    };

    // Usage-level metrics (aggregate counts only)
    if (this.config.level === 'usage') {
      payload.jobs_run_24h = this.counters.jobsRun;
      payload.sessions_spawned_24h = this.counters.sessionsSpawned;
      payload.skills_invoked_24h = this.counters.skillsInvoked;
    }

    return payload;
  }

  async sendHeartbeat(): Promise<boolean> {
    if (!this.config.enabled) return false;

    const payload = this.buildPayload();

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

      const response = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      // Log locally for transparency
      this.logHeartbeat(payload, response.ok);

      // Reset 24h counters periodically
      if (Date.now() - this.counters.lastReset > 24 * 60 * 60 * 1000) {
        this.counters.jobsRun = 0;
        this.counters.sessionsSpawned = 0;
        this.counters.skillsInvoked = 0;
        this.counters.lastReset = Date.now();
      }

      this.emit('heartbeat', { success: response.ok, payload });
      return response.ok;
    } catch {
      // Fire-and-forget — telemetry failure NEVER affects agent operation
      this.logHeartbeat(payload, false);
      this.emit('heartbeat', { success: false, payload });
      return false;
    }
  }

  // ── Internal Helpers ─────────────────────────────────────────────

  /**
   * Compute a stable, anonymous installation ID.
   * Hash of machine ID + project directory = unique per install, not reversible.
   */
  private computeInstallId(): string {
    const machineId = this.getMachineId();
    const hash = createHash('sha256')
      .update(machineId)
      .update(this.config.projectDir)
      .digest('hex')
      .slice(0, 16); // 16 hex chars = 64 bits of entropy (plenty for dedup)
    return hash;
  }

  private getMachineId(): string {
    // Try reading machine-id (Linux)
    try {
      return fs.readFileSync('/etc/machine-id', 'utf-8').trim();
    } catch {}

    // macOS: use hardware UUID
    try {
      const output = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf-8' });
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } catch {}

    // Fallback: hostname + homedir (less unique but still useful)
    return `${os.hostname()}-${os.homedir()}`;
  }

  /**
   * Log heartbeats locally so users can verify exactly what's being sent.
   * Transparency is a core design principle.
   */
  private logHeartbeat(payload: HeartbeatPayload, success: boolean): void {
    try {
      const logDir = path.join(this.config.stateDir, 'telemetry');
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const logFile = path.join(logDir, 'heartbeats.jsonl');
      const entry = { ...payload, _sent: success, _at: new Date().toISOString() };
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');
    } catch {
      // Logging failure is not critical
    }
  }

  // ── Status / Inspection ──────────────────────────────────────────

  getStatus(): {
    enabled: boolean;
    level: TelemetryLevel;
    installId: string;
    intervalMs: number;
    endpoint: string;
    counters: UsageCounters;
  } {
    return {
      enabled: this.config.enabled,
      level: this.config.level,
      installId: this.installId,
      intervalMs: this.config.intervalMs,
      endpoint: this.config.endpoint,
      counters: { ...this.counters },
    };
  }
}
