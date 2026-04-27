/**
 * Quota Tracker — reads usage state from a JSON file and provides
 * load-shedding decisions to the job scheduler.
 *
 * The quota state file is written externally (by a collector script,
 * an OAuth integration, or the agent itself). This class reads it
 * and translates usage percentages into scheduling decisions.
 *
 * The architecture mirrors Dawn's proven pattern:
 * - Collector writes quota-state.json (polling interval, OAuth, etc.)
 * - QuotaTracker reads it and exposes canRunJob(priority)
 * - JobScheduler calls canRunJob before spawning sessions
 */

import fs from 'node:fs';
import { DegradationReporter } from './DegradationReporter.js';
import path from 'node:path';
import type { QuotaState, JobPriority, JobSchedulerConfig } from '../core/types.js';

export interface QuotaTrackerConfig {
  /** Path to the quota state JSON file */
  quotaFile: string;
  /** Thresholds from scheduler config */
  thresholds: JobSchedulerConfig['quotaThresholds'];
  /** How stale (in ms) the quota data can be before we treat it as unknown */
  maxStalenessMs?: number;
}

export class QuotaTracker {
  private config: QuotaTrackerConfig;
  private cachedState: QuotaState | null = null;
  private lastRead: number = 0;
  private readCooldownMs = 5000; // Don't re-read more than every 5s

  constructor(config: QuotaTrackerConfig) {
    this.config = config;
  }

  /**
   * Read the current quota state from the file.
   * Returns null if file doesn't exist or is corrupted.
   */
  getState(): QuotaState | null {
    const now = Date.now();

    // Don't hit disk too frequently
    if (this.cachedState && (now - this.lastRead) < this.readCooldownMs) {
      return this.cachedState;
    }

    try {
      if (!fs.existsSync(this.config.quotaFile)) {
        if (!this.cachedState) {
          console.warn('[quota] No quota state file found — all jobs will run (fail-open)');
        }
        return null;
      }

      const raw = fs.readFileSync(this.config.quotaFile, 'utf-8');
      const state: QuotaState = JSON.parse(raw);

      // Check staleness — stale data should fail open (allow all jobs)
      const maxStale = this.config.maxStalenessMs ?? 30 * 60 * 1000; // 30 min default
      const lastUpdated = new Date(state.lastUpdated).getTime();
      if ((now - lastUpdated) > maxStale) {
        console.warn(`[quota] Stale data (${Math.round((now - lastUpdated) / 60000)}m old) — discarding, will fail open`);
        this.lastRead = now; // Prevent re-reading stale file on every call
        return null;
      }

      this.cachedState = state;
      this.lastRead = now;
      return state;
    } catch {
      this.lastRead = Date.now(); // Prevent hammering a corrupt file
      return this.cachedState; // Return last-known-good rather than null
    }
  }

  /**
   * Determine if a job at the given priority should run based on current quota.
   *
   * Checks BOTH weekly usage AND 5-hour rate limit:
   * - 5-hour >= 95%: block ALL spawns (sessions will immediately fail)
   * - 5-hour >= 80%: only critical priority
   * - Weekly >= shutdown (e.g. 95%): no jobs
   * - Weekly >= critical (e.g. 92%): critical only
   * - Weekly >= elevated (e.g. 85%): high+ only
   * - Weekly >= normal (e.g. 75%): medium+ only
   *
   * If quota data is unavailable or stale, defaults to allowing all jobs
   * (fail-open — better to run than to silently stop).
   */
  canRunJob(priority: JobPriority): boolean {
    const result = this.shouldSpawnSession(priority);
    return result.allowed;
  }

  /**
   * Check if a session should be spawned at the given priority.
   * Returns a structured result with reason — useful for logging and notifications.
   *
   * Checks both weekly AND 5-hour rate limits.
   */
  shouldSpawnSession(priority?: JobPriority): { allowed: boolean; reason: string } {
    const state = this.getState();
    if (!state) return { allowed: true, reason: 'No quota data — fail open' };

    // Check 5-hour rate limit first — these cause immediate session failures
    const fiveHour = state.fiveHourPercent;
    if (typeof fiveHour === 'number' && isFinite(fiveHour)) {
      if (fiveHour >= 95) {
        return { allowed: false, reason: `5-hour rate limit at ${fiveHour}% — sessions will fail immediately` };
      }
      if (fiveHour >= 80 && priority && priority !== 'critical') {
        return { allowed: false, reason: `5-hour rate limit at ${fiveHour}% — only critical priority allowed` };
      }
    }

    // Check weekly usage
    const rawUsage = state.usagePercent;
    if (typeof rawUsage !== 'number' || !isFinite(rawUsage)) {
      return { allowed: true, reason: 'Invalid weekly data — fail open' };
    }
    const usage = Math.max(0, Math.min(100, rawUsage));
    const { normal, elevated, critical, shutdown } = this.config.thresholds;

    if (usage >= shutdown) {
      return { allowed: false, reason: `Weekly quota at ${usage}% — all jobs stopped` };
    }

    if (usage >= critical) {
      const ok = !priority || priority === 'critical';
      return ok
        ? { allowed: true, reason: `Weekly at ${usage}% — critical only` }
        : { allowed: false, reason: `Weekly quota at ${usage}% — only critical priority runs` };
    }

    if (usage >= elevated) {
      const ok = !priority || priority === 'critical' || priority === 'high';
      return ok
        ? { allowed: true, reason: `Weekly at ${usage}% — high+ only` }
        : { allowed: false, reason: `Weekly quota at ${usage}% — only high+ priority runs` };
    }

    if (usage >= normal) {
      const ok = !priority || priority !== 'low';
      return ok
        ? { allowed: true, reason: `Weekly at ${usage}% — medium+ only` }
        : { allowed: false, reason: `Weekly quota at ${usage}% — low priority paused` };
    }

    return { allowed: true, reason: 'Quota normal' };
  }

  /**
   * Write a quota state to the file (for collector scripts or manual updates).
   */
  updateState(state: QuotaState): void {
    if (typeof state.usagePercent !== 'number' || !isFinite(state.usagePercent)) {
      throw new Error(`Invalid usagePercent: ${state.usagePercent}`);
    }
    if (!state.lastUpdated || isNaN(new Date(state.lastUpdated).getTime())) {
      throw new Error(`Invalid lastUpdated: ${state.lastUpdated}`);
    }
    const dir = path.dirname(this.config.quotaFile);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: unique temp filename to prevent concurrent corruption
    const tmpPath = this.config.quotaFile + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
      fs.renameSync(tmpPath, this.config.quotaFile);
    } catch (err) {
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
    this.cachedState = state;
    this.lastRead = Date.now();
  }

  /**
   * Get the recommendation string for display purposes.
   */
  getRecommendation(): QuotaState['recommendation'] {
    const state = this.getState();
    if (!state) return 'normal';

    // 5-hour at 95%+ is always 'stop' regardless of weekly
    if (typeof state.fiveHourPercent === 'number' && state.fiveHourPercent >= 95) return 'stop';
    if (typeof state.fiveHourPercent === 'number' && state.fiveHourPercent >= 80) return 'critical';

    const usage = state.usagePercent;
    const { normal, elevated, critical, shutdown } = this.config.thresholds;

    if (usage >= shutdown) return 'stop';
    if (usage >= critical) return 'critical';
    if (usage >= elevated) return 'reduce';
    if (usage >= normal) return 'reduce';
    return 'normal';
  }

  /**
   * Fetch quota status from a remote API (e.g., Dawn's /api/instar/quota).
   * If the remote says canProceed=false, updates local state accordingly.
   *
   * This allows Instar agents to check a central quota authority before
   * spawning sessions, preventing wasted attempts on exhausted machines.
   *
   * @param url - Full URL to the quota API (e.g., "https://dawn.bot-me.ai/api/instar/quota")
   * @param apiKey - Authorization token (sent as Bearer header)
   * @param timeoutMs - Request timeout (default 5000ms)
   * @returns Remote quota status, or null on failure (fail-open)
   */
  async fetchRemoteQuota(
    url: string,
    apiKey: string,
    timeoutMs: number = 5000,
  ): Promise<RemoteQuotaResult | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok) {
        console.warn(`[quota] Remote quota API returned ${response.status}`);
        return null;
      }

      const data = await response.json() as RemoteQuotaResult;

      // If remote says blocked, update local state to reflect it
      if (!data.canProceed && typeof data.weeklyPercent === 'number') {
        const state = this.getState() ?? {
          usagePercent: 0,
          lastUpdated: new Date().toISOString(),
        };
        state.usagePercent = data.weeklyPercent;
        if (typeof data.fiveHourPercent === 'number') {
          state.fiveHourPercent = data.fiveHourPercent;
        }
        state.lastUpdated = new Date().toISOString();
        this.cachedState = state;
      }

      return data;
    } catch (err) {
      // Network failure, timeout, etc. — fail open but REPORT it
      console.warn(`[quota] Remote quota check failed: ${err instanceof Error ? err.message : err}`);
      DegradationReporter.getInstance().report({
        feature: 'QuotaTracker.remoteCheck',
        primary: 'Real-time quota monitoring via remote API',
        fallback: 'Fail open — assuming no quota limits (may overspend)',
        reason: `Remote quota check failed: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Quota limits not enforced. Agent may spawn sessions that exceed API limits.',
      });
      return null;
    }
  }
}

/** Result from a remote quota API (e.g., /api/instar/quota) */
export interface RemoteQuotaResult {
  canProceed: boolean;
  blockReason?: string | null;
  activeAccount?: string | null;
  weeklyPercent: number;
  fiveHourPercent?: number | null;
  canRunPriority?: string;
  recommendation?: string | null;
  stale?: boolean;
}
