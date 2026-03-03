/**
 * System Reviewer (`instar doctor`) — functional verification for agent infrastructure.
 *
 * The existing monitoring (HealthChecker, CoherenceMonitor, etc.) tells us if the
 * engine is running. The SystemReviewer tells us if the car can drive.
 *
 * Runs lightweight probes that verify features work end-to-end at runtime.
 * Distinct from unit tests (build-time), health checks (liveness), and
 * integration tests (wiring). Probes test actual feature functionality.
 *
 * Key design decisions (from spec review):
 *   - Startup sweep: deletes orphaned __probe_* artifacts on init
 *   - Dead-letter fallback: file-append error path independent of all monitored infra
 *   - Own timer: does NOT depend on the scheduler (which it tests)
 *   - History persistence: JSONL file survives restarts for trend analysis
 *   - Concurrency: parallel within tier, serial for same serialGroup
 *   - Feedback: opt-in only (autoSubmitFeedback defaults to false)
 *
 * Born from the insight: "A system can be healthy while being broken."
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

// ── Types ─────────────────────────────────────────────────────────

export interface ProbeResult {
  /** Probe identifier */
  probeId: string;
  /** Human-readable name */
  name: string;
  /** Which tier this probe belongs to */
  tier: 1 | 2 | 3 | 4 | 5;
  /** Pass or fail */
  passed: boolean;
  /** What was tested */
  description: string;
  /** How long the probe took (ms) */
  durationMs: number;
  /** On failure: what went wrong */
  error?: string;
  /** On failure: the full error stack */
  stack?: string;
  /** On failure: what was expected vs. what happened */
  expected?: string;
  actual?: string;
  /** On failure: suggested remediation steps */
  remediation?: string[];
  /** Probe-specific diagnostic data */
  diagnostics?: Record<string, unknown>;
}

export interface ReviewReport {
  /** When the review ran */
  timestamp: string;
  /** Overall result */
  status: 'all-clear' | 'degraded' | 'critical';
  /** Probes that ran */
  results: ProbeResult[];
  /** Probes that were skipped (prerequisites not met) */
  skipped: Array<{ probeId: string; reason: string }>;
  /** Aggregate stats */
  stats: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
  };
  /** For failed probes: structured summary for feedback submission */
  failureSummary?: string;
}

export interface ReviewTrend {
  /** How many reviews in the analysis window */
  window: number;
  /** Is health score improving, stable, or declining? */
  direction: 'improving' | 'stable' | 'declining';
  /** Probes that are consistently failing (3+ consecutive) */
  persistentFailures: string[];
  /** Probes that recently started failing */
  newFailures: string[];
  /** Probes that recently recovered */
  recovered: string[];
}

export interface Probe {
  /** Unique probe identifier (namespaced, e.g., 'instar.session.list') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Criticality tier (1 = most critical) */
  tier: 1 | 2 | 3 | 4 | 5;
  /** Which feature/module this probes */
  feature: string;
  /**
   * Serialization group. Probes in the same group run sequentially
   * to avoid resource contention (e.g., SQLite write locks).
   * Probes in different groups run concurrently within a tier.
   */
  serialGroup?: string;
  /** Per-probe timeout override (ms). Falls back to config.probeTimeoutMs. */
  timeoutMs?: number;
  /**
   * Whether this probe requires specific infrastructure to be active.
   * Probes with unmet prerequisites are skipped (not failed).
   */
  prerequisites: () => boolean;
  /** Run the probe. Must clean up after itself. */
  run: () => Promise<ProbeResult>;
}

export interface SystemReviewerConfig {
  /** Whether the system reviewer is enabled */
  enabled: boolean;
  /** How often to run a full review (ms). Default: 6 hours */
  scheduleMs: number;
  /** Which tiers to include in scheduled runs */
  scheduledTiers: number[];
  /** Maximum time for a single probe (ms) */
  probeTimeoutMs: number;
  /** Maximum time for a full review run (ms) */
  reviewTimeoutMs: number;
  /** How many past reports to keep */
  historyLimit: number;
  /** Whether to auto-submit failures as feedback (requires feedbackConsentGiven) */
  autoSubmitFeedback: boolean;
  /** Whether the operator has explicitly consented to feedback submission */
  feedbackConsentGiven: boolean;
  /** Whether to send Telegram alerts for critical failures */
  alertOnCritical: boolean;
  /** Cooldown between repeated alerts for same probe (ms) */
  alertCooldownMs: number;
  /** Probes to skip (by probe ID) */
  disabledProbes: string[];
}

export interface ReviewOptions {
  tiers?: number[];
  probeIds?: string[];
  dryRun?: boolean;
}

export interface SystemReviewerEvents {
  'review:complete': (report: ReviewReport) => void;
  'review:probe-failed': (result: ProbeResult) => void;
  'review:error': (error: Error) => void;
}

// ── Default Config ────────────────────────────────────────────────

export const DEFAULT_SYSTEM_REVIEWER_CONFIG: SystemReviewerConfig = {
  enabled: true,
  scheduleMs: 6 * 60 * 60 * 1000, // 6 hours
  scheduledTiers: [1, 2, 3],
  probeTimeoutMs: 30_000,
  reviewTimeoutMs: 300_000,
  historyLimit: 50,
  autoSubmitFeedback: false,
  feedbackConsentGiven: false,
  alertOnCritical: true,
  alertCooldownMs: 3_600_000, // 1 hour
  disabledProbes: [],
};

// ── Dependencies ──────────────────────────────────────────────────

export interface SystemReviewerDeps {
  stateDir: string;
  /** Optional: submit feedback items */
  submitFeedback?: (item: {
    type: 'bug';
    title: string;
    description: string;
    agentName: string;
    instarVersion: string;
    nodeVersion: string;
  }) => Promise<unknown>;
  /** Optional: send Telegram alert */
  sendAlert?: (topicId: number | undefined, text: string) => Promise<unknown>;
  /** Optional: redact secrets from strings */
  redactSecrets?: (text: string) => string;
}

// ── Implementation ────────────────────────────────────────────────

export class SystemReviewer extends EventEmitter {
  private probes: Probe[] = [];
  private history: ReviewReport[] = [];
  private config: SystemReviewerConfig;
  private deps: SystemReviewerDeps;
  private historyFile: string;
  private deadLetterFile: string;
  private reviewInProgress = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAlertTimes: Map<string, number> = new Map();

  constructor(config: Partial<SystemReviewerConfig>, deps: SystemReviewerDeps) {
    super();
    this.config = { ...DEFAULT_SYSTEM_REVIEWER_CONFIG, ...config };
    this.deps = deps;
    this.historyFile = path.join(deps.stateDir, 'review-history.jsonl');
    this.deadLetterFile = path.join(deps.stateDir, 'doctor-dead-letter.jsonl');

    // Load persisted history
    this.loadHistory();
  }

  // ── Probe Registration ──────────────────────────────────────────

  /** Register a probe */
  register(probe: Probe): void {
    if (this.probes.some(p => p.id === probe.id)) {
      throw new Error(`Probe already registered: ${probe.id}`);
    }
    this.probes.push(probe);
  }

  /** Register multiple probes */
  registerAll(probes: Probe[]): void {
    for (const probe of probes) {
      this.register(probe);
    }
  }

  /** Get all registered probes with their status */
  getProbes(): Array<{
    id: string;
    name: string;
    tier: number;
    feature: string;
    disabled: boolean;
    prerequisitesMet: boolean;
  }> {
    return this.probes.map(p => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      feature: p.feature,
      disabled: this.config.disabledProbes.includes(p.id),
      prerequisitesMet: p.prerequisites(),
    }));
  }

  // ── Review Execution ────────────────────────────────────────────

  /**
   * Run a review. Returns the report.
   *
   * Probes within a tier run concurrently (via Promise.allSettled),
   * except probes sharing a serialGroup which run sequentially.
   * Tiers run in order (1 → 2 → 3 → 4 → 5).
   */
  async review(options: ReviewOptions = {}): Promise<ReviewReport> {
    if (this.reviewInProgress) {
      throw new Error('Review already in progress. Use getHistory() to see past results.');
    }

    this.reviewInProgress = true;
    const reviewStart = Date.now();

    try {
      const results: ProbeResult[] = [];
      const skipped: Array<{ probeId: string; reason: string }> = [];

      // Determine which probes to run
      const eligibleProbes = this.getEligibleProbes(options);

      if (options.dryRun) {
        return this.buildDryRunReport(eligibleProbes);
      }

      // Group probes by tier
      const tiers = this.groupByTier(eligibleProbes);
      const tierKeys = Array.from(tiers.keys()).sort();

      for (const tier of tierKeys) {
        // Check review timeout
        if (Date.now() - reviewStart > this.config.reviewTimeoutMs) {
          // Mark remaining probes as timed out
          for (const remainingTier of tierKeys.filter(t => t >= tier)) {
            const remaining = tiers.get(remainingTier) ?? [];
            for (const probe of remaining) {
              if (!results.some(r => r.probeId === probe.id)) {
                results.push(this.buildTimeoutResult(probe, 'Review timeout exceeded'));
              }
            }
          }
          break;
        }

        const tierProbes = tiers.get(tier) ?? [];
        const tierResults = await this.runTier(tierProbes);

        for (const result of tierResults) {
          if (result.type === 'result') {
            results.push(result.value);
          } else {
            skipped.push(result.value);
          }
        }
      }

      const report = this.buildReport(results, skipped, reviewStart);

      // Persist and process
      this.addToHistory(report);
      this.persistHistory();
      await this.processFailures(report);

      this.emit('review:complete', report);
      return report;

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.writeDeadLetter('review-error', error.message, error.stack);
      this.emit('review:error', error);
      throw error;
    } finally {
      this.reviewInProgress = false;
    }
  }

  // ── Tier Execution ──────────────────────────────────────────────

  private async runTier(
    probes: Probe[],
  ): Promise<Array<
    | { type: 'result'; value: ProbeResult }
    | { type: 'skipped'; value: { probeId: string; reason: string } }
  >> {
    const output: Array<
      | { type: 'result'; value: ProbeResult }
      | { type: 'skipped'; value: { probeId: string; reason: string } }
    > = [];

    // Separate probes by serialGroup
    const groups = new Map<string, Probe[]>();
    const ungrouped: Probe[] = [];

    for (const probe of probes) {
      if (this.config.disabledProbes.includes(probe.id)) {
        output.push({ type: 'skipped', value: { probeId: probe.id, reason: 'Disabled in config' } });
        continue;
      }

      if (!probe.prerequisites()) {
        output.push({ type: 'skipped', value: { probeId: probe.id, reason: 'Prerequisites not met' } });
        continue;
      }

      if (probe.serialGroup) {
        const group = groups.get(probe.serialGroup) ?? [];
        group.push(probe);
        groups.set(probe.serialGroup, group);
      } else {
        ungrouped.push(probe);
      }
    }

    // Build concurrent execution units:
    // - Each ungrouped probe is its own unit
    // - Each serial group is one unit (probes run sequentially within)
    const units: Array<() => Promise<ProbeResult[]>> = [];

    // Ungrouped probes: each runs independently
    for (const probe of ungrouped) {
      units.push(async () => [await this.runProbe(probe)]);
    }

    // Serial groups: probes within a group run sequentially
    for (const [, groupProbes] of groups) {
      units.push(async () => {
        const groupResults: ProbeResult[] = [];
        for (const probe of groupProbes) {
          groupResults.push(await this.runProbe(probe));
        }
        return groupResults;
      });
    }

    // Run all units concurrently
    const settled = await Promise.allSettled(units.map(fn => fn()));

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        for (const probeResult of result.value) {
          output.push({ type: 'result', value: probeResult });
        }
      } else {
        // Unit-level failure — should be rare (probe-level errors are caught in runProbe)
        this.writeDeadLetter('unit-error', result.reason?.message ?? 'Unknown unit error');
      }
    }

    return output;
  }

  // ── Individual Probe Execution ──────────────────────────────────

  private async runProbe(probe: Probe): Promise<ProbeResult> {
    const timeoutMs = probe.timeoutMs ?? this.config.probeTimeoutMs;
    const start = Date.now();

    try {
      const result = await Promise.race([
        probe.run(),
        this.createTimeout(timeoutMs, probe.id),
      ]);

      // Ensure probe returned a valid result
      if (!result || typeof result.passed !== 'boolean') {
        return {
          probeId: probe.id,
          name: probe.name,
          tier: probe.tier,
          passed: false,
          description: `Probe returned invalid result`,
          durationMs: Date.now() - start,
          error: 'Probe run() did not return a valid ProbeResult',
          remediation: ['Check probe implementation — run() must return a ProbeResult with a boolean `passed` field'],
        };
      }

      // Override duration with our measurement (more accurate)
      result.durationMs = Date.now() - start;

      if (!result.passed) {
        this.emit('review:probe-failed', result);
      }

      return result;

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const result: ProbeResult = {
        probeId: probe.id,
        name: probe.name,
        tier: probe.tier,
        passed: false,
        description: `Probe threw an exception`,
        durationMs: Date.now() - start,
        error: error.message,
        stack: error.stack,
        remediation: ['Check probe implementation for unhandled exceptions'],
      };
      this.emit('review:probe-failed', result);
      return result;
    }
  }

  private createTimeout(ms: number, probeId: string): Promise<ProbeResult> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          probeId,
          name: probeId,
          tier: 1, // Will be overridden by caller context
          passed: false,
          description: 'Probe timed out',
          durationMs: ms,
          error: `Probe exceeded timeout of ${ms}ms`,
          remediation: [
            `Increase probeTimeoutMs in config (currently ${ms}ms)`,
            'Check if the feature being probed is hung or extremely slow',
          ],
        });
      }, ms);
    });
  }

  // ── History & Trend ─────────────────────────────────────────────

  /** Get the last N review reports */
  getHistory(limit?: number): ReviewReport[] {
    const n = limit ?? this.config.historyLimit;
    return this.history.slice(-n);
  }

  /** Get the number of registered probes */
  getProbeCount(): number {
    return this.probes.length;
  }

  /** Get the most recent review report */
  getLatest(): ReviewReport | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  /** Analyze trend across recent reviews */
  getTrend(): ReviewTrend {
    const recent = this.history.slice(-10);

    if (recent.length < 2) {
      return {
        window: recent.length,
        direction: 'stable',
        persistentFailures: [],
        newFailures: [],
        recovered: [],
      };
    }

    // Track per-probe pass/fail across recent reviews
    const probeHistory = new Map<string, boolean[]>();
    for (const report of recent) {
      for (const result of report.results) {
        const hist = probeHistory.get(result.probeId) ?? [];
        hist.push(result.passed);
        probeHistory.set(result.probeId, hist);
      }
    }

    const persistentFailures: string[] = [];
    const newFailures: string[] = [];
    const recovered: string[] = [];

    for (const [probeId, results] of probeHistory) {
      if (results.length < 2) continue;

      const last3 = results.slice(-3);
      const allFailing = last3.length >= 3 && last3.every(r => !r);
      const justStartedFailing = results.length >= 2
        && results[results.length - 1] === false
        && results[results.length - 2] === true;
      const justRecovered = results.length >= 2
        && results[results.length - 1] === true
        && results[results.length - 2] === false;

      if (allFailing) persistentFailures.push(probeId);
      if (justStartedFailing) newFailures.push(probeId);
      if (justRecovered) recovered.push(probeId);
    }

    // Direction: compare pass rates of first half vs second half
    const mid = Math.floor(recent.length / 2);
    const firstHalf = recent.slice(0, mid);
    const secondHalf = recent.slice(mid);

    const passRate = (reports: ReviewReport[]) => {
      const total = reports.reduce((sum, r) => sum + r.stats.total, 0);
      const passed = reports.reduce((sum, r) => sum + r.stats.passed, 0);
      return total > 0 ? passed / total : 1;
    };

    const firstRate = passRate(firstHalf);
    const secondRate = passRate(secondHalf);
    const delta = secondRate - firstRate;

    let direction: ReviewTrend['direction'] = 'stable';
    if (delta > 0.1) direction = 'improving';
    else if (delta < -0.1) direction = 'declining';

    return {
      window: recent.length,
      direction,
      persistentFailures,
      newFailures,
      recovered,
    };
  }

  // ── Scheduling ──────────────────────────────────────────────────

  /** Start the independent review timer (does NOT use the job scheduler) */
  start(): void {
    if (!this.config.enabled) return;
    if (this.timer) return;

    this.timer = setInterval(async () => {
      try {
        await this.review({ tiers: this.config.scheduledTiers });
      } catch (err) { // @silent-fallback-ok — dead-letter file IS the degradation path (independent of DegradationReporter by design)
        const error = err instanceof Error ? err : new Error(String(err));
        this.writeDeadLetter('scheduled-review-error', error.message, error.stack);
      }
    }, this.config.scheduleMs);

    // Don't prevent process exit
    if (this.timer.unref) this.timer.unref();
  }

  /** Stop the review timer */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Whether a review is currently in progress */
  isReviewing(): boolean {
    return this.reviewInProgress;
  }

  // ── Startup Sweep ───────────────────────────────────────────────

  /**
   * Clean up orphaned probe artifacts from all state stores.
   * Called on construction and before each review run.
   *
   * Uses the `cleanupProbeArtifacts` callback if provided.
   * Falls back to no-op if no cleanup mechanism is available.
   */
  private cleanupCallbacks: Array<() => Promise<void>> = [];

  /** Register a cleanup callback for probe artifacts */
  registerCleanup(fn: () => Promise<void>): void {
    this.cleanupCallbacks.push(fn);
  }

  async runStartupSweep(): Promise<number> {
    let cleaned = 0;
    for (const fn of this.cleanupCallbacks) {
      try {
        await fn();
        cleaned++;
      } catch (err) {
        this.writeDeadLetter(
          'startup-sweep-error',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return cleaned;
  }

  // ── HealthChecker Integration ───────────────────────────────────

  /** Get health status for HealthChecker integration */
  getHealthStatus(): { status: 'healthy' | 'degraded' | 'unhealthy'; message: string; lastCheck: string } {
    const latest = this.getLatest();
    if (!latest) {
      return {
        status: 'healthy',
        message: 'No reviews run yet',
        lastCheck: new Date().toISOString(),
      };
    }

    return {
      status: latest.status === 'all-clear' ? 'healthy'
        : latest.status === 'degraded' ? 'degraded'
        : 'unhealthy',
      message: `${latest.stats.passed}/${latest.stats.total} probes passed`,
      lastCheck: latest.timestamp,
    };
  }

  // ── Private Helpers ─────────────────────────────────────────────

  private getEligibleProbes(options: ReviewOptions): Probe[] {
    let probes = [...this.probes];

    if (options.probeIds && options.probeIds.length > 0) {
      probes = probes.filter(p => options.probeIds!.includes(p.id));
    } else if (options.tiers && options.tiers.length > 0) {
      probes = probes.filter(p => options.tiers!.includes(p.tier));
    }

    return probes;
  }

  private groupByTier(probes: Probe[]): Map<number, Probe[]> {
    const groups = new Map<number, Probe[]>();
    for (const probe of probes) {
      const tier = groups.get(probe.tier) ?? [];
      tier.push(probe);
      groups.set(probe.tier, tier);
    }
    return groups;
  }

  private buildReport(
    results: ProbeResult[],
    skipped: Array<{ probeId: string; reason: string }>,
    startTime: number,
  ): ReviewReport {
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const durationMs = Date.now() - startTime;

    let status: ReviewReport['status'] = 'all-clear';
    const tier1Failed = results.some(r => !r.passed && r.tier === 1);
    const anyFailed = results.some(r => !r.passed);

    if (tier1Failed) status = 'critical';
    else if (anyFailed) status = 'degraded';

    const failedResults = results.filter(r => !r.passed);
    const failureSummary = failedResults.length > 0
      ? failedResults.map(r => `[T${r.tier}] ${r.probeId}: ${r.error ?? 'failed'}`).join('\n')
      : undefined;

    return {
      timestamp: new Date().toISOString(),
      status,
      results,
      skipped,
      stats: {
        total: results.length,
        passed,
        failed,
        skipped: skipped.length,
        durationMs,
      },
      failureSummary,
    };
  }

  private buildDryRunReport(probes: Probe[]): ReviewReport {
    return {
      timestamp: new Date().toISOString(),
      status: 'all-clear',
      results: [],
      skipped: probes.map(p => ({
        probeId: p.id,
        reason: `Dry run — would ${p.prerequisites() ? 'run' : 'skip (prerequisites not met)'}`,
      })),
      stats: { total: 0, passed: 0, failed: 0, skipped: probes.length, durationMs: 0 },
    };
  }

  private buildTimeoutResult(probe: Probe, reason: string): ProbeResult {
    return {
      probeId: probe.id,
      name: probe.name,
      tier: probe.tier,
      passed: false,
      description: 'Skipped — review timeout exceeded',
      durationMs: 0,
      error: reason,
      remediation: ['Increase reviewTimeoutMs or reduce the number of probes per review run'],
    };
  }

  // ── History Persistence ─────────────────────────────────────────

  private loadHistory(): void {
    try {
      if (!fs.existsSync(this.historyFile)) return;

      const content = fs.readFileSync(this.historyFile, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      // Load only the last N entries
      const limit = this.config.historyLimit;
      const start = Math.max(0, lines.length - limit);

      for (let i = start; i < lines.length; i++) {
        try {
          this.history.push(JSON.parse(lines[i]));
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // History file doesn't exist or can't be read — start fresh
    }
  }

  private addToHistory(report: ReviewReport): void {
    this.history.push(report);

    // Trim to limit
    while (this.history.length > this.config.historyLimit) {
      this.history.shift();
    }
  }

  private persistHistory(): void {
    try {
      // Append the latest report only
      const latest = this.history[this.history.length - 1];
      if (!latest) return;

      fs.appendFileSync(this.historyFile, JSON.stringify(latest) + '\n');

      // Periodically compact the file (when it exceeds 2x limit)
      const lineCount = fs.readFileSync(this.historyFile, 'utf-8').trim().split('\n').length;
      if (lineCount > this.config.historyLimit * 2) {
        this.compactHistory();
      }
    } catch (err) {
      this.writeDeadLetter(
        'history-persist-error',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private compactHistory(): void {
    try {
      const content = this.history.map(r => JSON.stringify(r)).join('\n') + '\n';
      fs.writeFileSync(this.historyFile, content);
    } catch (err) { // @silent-fallback-ok — dead-letter file IS the degradation path
      this.writeDeadLetter(
        'history-compact-error',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // ── Dead Letter Fallback ────────────────────────────────────────

  /**
   * Write to the dead-letter file. This is the ONE error path that
   * does not depend on any monitored infrastructure. Uses only
   * fs.appendFileSync — no Telegram, no feedback, no SQLite.
   */
  private writeDeadLetter(type: string, message: string, stack?: string): void {
    try {
      // Inline size-based rotation — no imports, sync fs only (by design).
      // 10MB cap, keep last 25% (error log — aggressive trim is fine).
      try {
        const stat = fs.statSync(this.deadLetterFile);
        if (stat.size > 10 * 1024 * 1024) {
          const content = fs.readFileSync(this.deadLetterFile, 'utf-8');
          const lines = content.split('\n').filter(Boolean);
          const keep = lines.slice(-Math.max(1, Math.ceil(lines.length * 0.25)));
          const tmp = this.deadLetterFile + '.rotation-tmp';
          fs.writeFileSync(tmp, keep.join('\n') + '\n');
          fs.renameSync(tmp, this.deadLetterFile);
        }
      } catch {
        // Rotation failure is non-fatal — continue to append
      }

      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        type,
        message,
        stack,
      });
      fs.appendFileSync(this.deadLetterFile, entry + '\n');
    } catch {
      // If even file-append fails, the filesystem is gone. Nothing we can do.
      // eslint-disable-next-line no-console
      console.error(`[DOCTOR-DEAD-LETTER] ${type}: ${message}`);
    }
  }

  // ── Failure Processing ──────────────────────────────────────────

  private async processFailures(report: ReviewReport): Promise<void> {
    const failed = report.results.filter(r => !r.passed);
    if (failed.length === 0) return;

    // Telegram alerts for Tier 1/2 failures
    if (this.config.alertOnCritical && this.deps.sendAlert) {
      const alertable = failed.filter(r => r.tier <= 2);
      for (const result of alertable) {
        if (this.isAlertCoolingDown(result.probeId)) continue;

        const tierLabel = result.tier === 1 ? 'CRITICAL' : 'HIGH';
        // Only send summary — NOT full diagnostic data
        const alertText = `[DOCTOR] ${tierLabel}: ${result.name} failed\n` +
          `Probe: ${result.probeId} (Tier ${result.tier})\n` +
          `Error: ${result.error ?? 'unknown'}\n` +
          `Run \`instar doctor --probe ${result.probeId}\` for full diagnostics.`;

        try {
          await this.deps.sendAlert(undefined, alertText);
          this.lastAlertTimes.set(result.probeId, Date.now());
        } catch (err) {
          this.writeDeadLetter(
            'alert-send-error',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }

    // Feedback submission (opt-in only)
    if (
      this.config.autoSubmitFeedback
      && this.config.feedbackConsentGiven
      && this.deps.submitFeedback
    ) {
      for (const result of failed) {
        // Dedup: only one feedback per probe per 24h
        // (Tracked via probe history — if the probe failed in the previous review too, skip)
        if (this.wasRecentlyReported(result.probeId)) continue;

        let description = `Probe: ${result.probeId} (Tier ${result.tier})\n` +
          `Feature: ${result.name}\n` +
          `Error: ${result.error ?? 'unknown'}\n`;

        if (result.remediation) {
          description += `Remediation:\n${result.remediation.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n`;
        }

        // Sanitize through SecretRedactor if available
        if (this.deps.redactSecrets) {
          description = this.deps.redactSecrets(description);
        }

        try {
          await this.deps.submitFeedback({
            type: 'bug',
            title: `[DOCTOR] ${result.probeId} FAILED`,
            description,
            agentName: 'system-reviewer',
            instarVersion: process.env.npm_package_version ?? 'unknown',
            nodeVersion: process.version,
          });
        } catch (err) { // @silent-fallback-ok — dead-letter file IS the degradation path
          this.writeDeadLetter(
            'feedback-submit-error',
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }

  private isAlertCoolingDown(probeId: string): boolean {
    const lastAlert = this.lastAlertTimes.get(probeId);
    if (!lastAlert) return false;
    return Date.now() - lastAlert < this.config.alertCooldownMs;
  }

  private wasRecentlyReported(probeId: string): boolean {
    // Check if this probe failed in the previous review (24h dedup)
    if (this.history.length < 2) return false;
    const previous = this.history[this.history.length - 2];
    return previous.results.some(r => r.probeId === probeId && !r.passed);
  }
}
