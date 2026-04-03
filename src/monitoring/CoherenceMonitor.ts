/**
 * Coherence Monitor — runtime self-awareness for agent infrastructure.
 *
 * Prevention stops bugs we've seen. Homeostasis stops bugs we haven't seen yet.
 *
 * This monitor periodically checks the agent's own state for coherence:
 *   1. Config Coherence — do in-memory values match disk?
 *   2. State Durability — did runtime changes survive the last restart?
 *   3. Output Sanity — is user-facing output valid?
 *   4. Feature Readiness — are all expected features properly configured?
 *
 * Where possible, it self-corrects. Where it can't, it notifies.
 * The goal: converge toward natural self-led homeostasis.
 *
 * Integrates with HealthChecker via ComponentHealth results.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { LiveConfig } from '../config/LiveConfig.js';
import type { ComponentHealth } from '../core/types.js';
import { ProcessIntegrity } from '../core/ProcessIntegrity.js';

// ── Types ─────────────────────────────────────────────────────────

export interface CoherenceCheckResult {
  /** Check name */
  name: string;
  /** Did it pass? */
  passed: boolean;
  /** Human-readable description */
  message: string;
  /** Was the issue self-corrected? */
  corrected?: boolean;
  /** Correction details */
  correctionDetail?: string;
}

export interface CoherenceReport {
  /** When the check was run */
  timestamp: string;
  /** Overall status */
  status: 'coherent' | 'corrected' | 'incoherent';
  /** Individual check results */
  checks: CoherenceCheckResult[];
  /** Summary counts */
  passed: number;
  failed: number;
  corrected: number;
}

export interface CoherenceMonitorConfig {
  /** State directory (.instar/) */
  stateDir: string;
  /** LiveConfig instance for dynamic config checking */
  liveConfig: LiveConfig;
  /** Check interval in ms. Default: 300_000 (5 minutes) */
  checkIntervalMs?: number;
  /** Port the server is running on */
  port?: number;
  /** Notification callback — fires when an incoherence can't be self-corrected */
  onIncoherence?: (report: CoherenceReport) => void;
}

// Known-bad output patterns that should never appear in user-facing messages
const BAD_OUTPUT_PATTERNS = [
  { pattern: 'localhost', context: 'URL', description: 'localhost URL in remote-accessible message' },
  { pattern: '(check your config)', context: 'PIN', description: 'placeholder text instead of actual value' },
  { pattern: '127.0.0.1', context: 'URL', description: 'loopback address in remote-accessible message' },
  { pattern: 'undefined', context: 'variable', description: 'literal "undefined" in user-facing text' },
  { pattern: '[object Object]', context: 'serialization', description: 'unserialized object in output' },
];

export class CoherenceMonitor extends EventEmitter {
  private config: CoherenceMonitorConfig;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastReport: CoherenceReport | null = null;
  private correctionLog: Array<{ timestamp: string; check: string; detail: string }> = [];
  /** Track which failure signatures have already been notified (signature → timestamp ms) */
  private notifiedFailures: Map<string, number> = new Map();
  /** Don't re-notify about the same failure within this window */
  private static readonly NOTIFY_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

  constructor(config: CoherenceMonitorConfig) {
    super();
    this.config = config;
  }

  /**
   * Start periodic coherence monitoring.
   */
  start(): void {
    if (this.interval) return;

    const intervalMs = this.config.checkIntervalMs ?? 300_000; // 5 minutes

    // Run initial check after a delay (let everything initialize)
    setTimeout(() => {
      this.runCheck();
    }, 30_000);

    // Then run periodically
    this.interval = setInterval(() => this.runCheck(), intervalMs);
    this.interval.unref();

    console.log(`[CoherenceMonitor] Started (every ${Math.round(intervalMs / 60_000)}m)`);
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Run all coherence checks and return a report.
   */
  runCheck(): CoherenceReport {
    const checks: CoherenceCheckResult[] = [];

    // Run all check categories
    checks.push(...this.checkProcessIntegrity());
    checks.push(...this.checkShadowInstallation());
    checks.push(...this.checkConfigCoherence());
    checks.push(...this.checkStateDurability());
    checks.push(...this.checkOutputSanity());
    checks.push(...this.checkFeatureReadiness());

    const passed = checks.filter(c => c.passed).length;
    const corrected = checks.filter(c => c.corrected).length;
    const failed = checks.filter(c => !c.passed && !c.corrected).length;

    let status: CoherenceReport['status'];
    if (failed > 0) status = 'incoherent';
    else if (corrected > 0) status = 'corrected';
    else status = 'coherent';

    const report: CoherenceReport = {
      timestamp: new Date().toISOString(),
      status,
      checks,
      passed,
      failed,
      corrected,
    };

    this.lastReport = report;
    this.emit('check', report);

    // Cooldown-based: expired entries are cleaned up rather than clearing all on coherent.
    // This prevents flapping (coherent → incoherent → coherent) from spamming notifications.
    const now = Date.now();
    for (const [sig, ts] of this.notifiedFailures) {
      if (now - ts > CoherenceMonitor.NOTIFY_COOLDOWN_MS) {
        this.notifiedFailures.delete(sig);
      }
    }

    // Log non-coherent results
    if (status !== 'coherent') {
      const failedChecks = checks.filter(c => !c.passed);
      const correctedChecks = checks.filter(c => c.corrected);

      if (correctedChecks.length > 0) {
        console.log(`[CoherenceMonitor] Self-corrected ${correctedChecks.length} issue(s): ${correctedChecks.map(c => c.name).join(', ')}`);
      }
      if (failed > 0) {
        console.warn(`[CoherenceMonitor] ${failed} incoherence(s) detected: ${failedChecks.map(c => `${c.name}: ${c.message}`).join('; ')}`);

        // Deduplicate notifications: only notify if this failure signature hasn't been
        // notified within the cooldown window. Prevents flapping from generating spam.
        const failureSignature = failedChecks.map(c => c.name).sort().join(',');
        const lastNotified = this.notifiedFailures.get(failureSignature);
        const isNewFailure = !lastNotified || (now - lastNotified > CoherenceMonitor.NOTIFY_COOLDOWN_MS);

        if (isNewFailure && this.config.onIncoherence) {
          try {
            this.config.onIncoherence(report);
            this.notifiedFailures.set(failureSignature, now);
          } catch (err) {
            console.error(`[CoherenceMonitor] Notification callback failed:`, err);
          }
        }
      }
    }

    // Persist report
    this.persistReport(report);

    return report;
  }

  /**
   * Get the last coherence report.
   */
  getLastReport(): CoherenceReport | null {
    return this.lastReport;
  }

  /**
   * Get ComponentHealth for integration with HealthChecker.
   */
  getHealth(): ComponentHealth {
    if (!this.lastReport) {
      return { status: 'healthy', message: 'Not yet checked', lastCheck: new Date().toISOString() };
    }

    const { status, passed, failed, corrected } = this.lastReport;

    switch (status) {
      case 'coherent':
        return { status: 'healthy', message: `All ${passed} checks passed`, lastCheck: this.lastReport.timestamp };
      case 'corrected':
        return { status: 'healthy', message: `${passed} passed, ${corrected} self-corrected`, lastCheck: this.lastReport.timestamp };
      case 'incoherent':
        return { status: 'degraded', message: `${failed} incoherence(s) detected`, lastCheck: this.lastReport.timestamp };
    }
  }

  /**
   * Get correction history.
   */
  getCorrectionLog(): Array<{ timestamp: string; check: string; detail: string }> {
    return [...this.correctionLog];
  }

  // ── Check Categories ────────────────────────────────────────────

  /**
   * Check 0: Process Integrity
   * Is this process running the code it claims to be running?
   * Detects the "stale process" bug where npm install -g updates the binary
   * on disk but the running process still has old code in memory.
   */
  private checkProcessIntegrity(): CoherenceCheckResult[] {
    const results: CoherenceCheckResult[] = [];
    const integrity = ProcessIntegrity.getInstance();

    if (!integrity) {
      // ProcessIntegrity not initialized — skip gracefully
      return results;
    }

    if (integrity.versionMismatch) {
      // If the AutoUpdater has already applied this version and a restart is pending,
      // don't flag the mismatch — it's expected and the restart will resolve it.
      // This prevents the CoherenceMonitor from creating noise while the AutoUpdater
      // is deferring the restart for active sessions.
      const autoUpdaterState = this.readAutoUpdaterState();
      if (autoUpdaterState?.lastAppliedVersion === integrity.diskVersion) {
        results.push({
          name: 'process-version-mismatch',
          passed: true,
          message: `Running v${integrity.runningVersion} — update to v${integrity.diskVersion} applied, restart pending`,
        });
      } else {
        results.push({
          name: 'process-version-mismatch',
          passed: false,
          message: `Running v${integrity.runningVersion} but disk has v${integrity.diskVersion} — restart needed`,
        });
      }
    } else {
      results.push({
        name: 'process-version-mismatch',
        passed: true,
        message: `Running v${integrity.runningVersion} (matches disk)`,
      });
    }

    return results;
  }

  /**
   * Check 0b: Shadow Installation Detection
   * Is there a local node_modules/instar that shadows the global binary?
   * The Luna Incident (v0.9.70): a local `npm install instar` created a shadow
   * that prevented auto-updates from taking effect. Detect this at runtime.
   */
  private checkShadowInstallation(): CoherenceCheckResult[] {
    const localBin = path.join(process.cwd(), 'node_modules', '.bin', 'instar');
    const localPkg = path.join(process.cwd(), 'node_modules', 'instar', 'package.json');

    if (fs.existsSync(localBin) || fs.existsSync(localPkg)) {
      let localVersion = 'unknown';
      try {
        const pkg = JSON.parse(fs.readFileSync(
          path.join(process.cwd(), 'node_modules', 'instar', 'package.json'), 'utf-8'));
        localVersion = pkg.version || 'unknown';
      } catch { /* ignore */ }

      return [{
        name: 'shadow-installation',
        passed: false,
        message: `Local node_modules/instar v${localVersion} shadows global binary — auto-updates won't take effect. Remove: rm -rf node_modules package.json package-lock.json`,
      }];
    }

    return [{
      name: 'shadow-installation',
      passed: true,
      message: 'No local shadow installation detected',
    }];
  }

  /**
   * Check 1: Config Coherence
   * Do in-memory config values match what's on disk?
   */
  private checkConfigCoherence(): CoherenceCheckResult[] {
    const results: CoherenceCheckResult[] = [];
    const { liveConfig, stateDir } = this.config;

    // Check that config.json exists and is parseable
    const configPath = path.join(stateDir, 'config.json');
    try {
      if (!fs.existsSync(configPath)) {
        results.push({
          name: 'config-file-exists',
          passed: false,
          message: 'config.json missing from state directory',
        });
        return results;
      }

      JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      results.push({
        name: 'config-file-valid',
        passed: true,
        message: 'config.json exists and is valid JSON',
      });
    } catch (err) {
      results.push({
        name: 'config-file-valid',
        passed: false,
        message: `config.json is corrupt: ${err instanceof Error ? err.message : String(err)}`,
      });
      return results;
    }

    // Check critical dynamic values via LiveConfig
    // autoApply should generally be true (default) — if false, verify it's intentional
    const autoApply = liveConfig.get<boolean>('updates.autoApply', true);
    results.push({
      name: 'config-auto-apply',
      passed: true, // Just report the value — both true and false are valid
      message: `updates.autoApply = ${autoApply}`,
    });

    return results;
  }

  /**
   * Check 2: State Durability
   * Did runtime changes survive restarts? Are state files intact?
   */
  private checkStateDurability(): CoherenceCheckResult[] {
    const results: CoherenceCheckResult[] = [];
    const { stateDir } = this.config;
    const stateSubDir = path.join(stateDir, 'state');

    // Check state directory exists
    if (!fs.existsSync(stateSubDir)) {
      results.push({
        name: 'state-dir-exists',
        passed: false,
        message: 'state/ subdirectory missing',
        corrected: true,
        correctionDetail: 'Created state/ directory',
      });
      try {
        fs.mkdirSync(stateSubDir, { recursive: true });
        this.logCorrection('state-dir-exists', 'Created missing state/ directory');
      } catch { /* best effort */ }
      return results;
    }

    // Check auto-updater state file
    const autoUpdaterState = path.join(stateSubDir, 'auto-updater.json');
    if (fs.existsSync(autoUpdaterState)) {
      try {
        const data = JSON.parse(fs.readFileSync(autoUpdaterState, 'utf-8'));
        const hasSavedAt = typeof data.savedAt === 'string';
        results.push({
          name: 'state-auto-updater',
          passed: hasSavedAt,
          message: hasSavedAt ? `Auto-updater state persisted (saved: ${data.savedAt})` : 'Auto-updater state file corrupt',
        });
      } catch {
        results.push({
          name: 'state-auto-updater',
          passed: false,
          message: 'Auto-updater state file corrupt',
        });
      }
    }

    // Check topic-session registry
    const registryPath = path.join(stateDir, 'topic-session-registry.json');
    if (fs.existsSync(registryPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        const topicCount = Array.isArray(data.topics) ? data.topics.length : Object.keys(data).length;
        results.push({
          name: 'state-topic-registry',
          passed: true,
          message: `Topic registry intact (${topicCount} entries)`,
        });
      } catch {
        results.push({
          name: 'state-topic-registry',
          passed: false,
          message: 'Topic registry corrupt',
        });
      }
    }

    // Check memory thresholds persistence
    const thresholdsPath = path.join(stateSubDir, 'memory-thresholds.json');
    if (fs.existsSync(thresholdsPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(thresholdsPath, 'utf-8'));
        const valid = typeof data.warning === 'number' && typeof data.elevated === 'number' && typeof data.critical === 'number';
        results.push({
          name: 'state-memory-thresholds',
          passed: valid,
          message: valid
            ? `Thresholds persisted: warning=${data.warning}%, elevated=${data.elevated}%, critical=${data.critical}%`
            : 'Threshold file exists but values are invalid',
        });
      } catch {
        results.push({
          name: 'state-memory-thresholds',
          passed: false,
          message: 'Memory thresholds file corrupt',
        });
      }
    }

    return results;
  }

  /**
   * Check 3: Output Sanity
   * Scan recent agent messages for known-bad patterns.
   */
  private checkOutputSanity(): CoherenceCheckResult[] {
    const results: CoherenceCheckResult[] = [];
    const { stateDir } = this.config;

    // Scan last 50 agent messages from the JSONL log
    const logPath = path.join(stateDir, 'telegram-messages.jsonl');
    if (!fs.existsSync(logPath)) {
      results.push({
        name: 'output-sanity',
        passed: true,
        message: 'No message log to check (new agent)',
      });
      return results;
    }

    try {
      const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
      // Check last 50 agent messages (fromUser: false)
      const agentMessages: Array<{ text: string; timestamp: string }> = [];
      for (let i = lines.length - 1; i >= 0 && agentMessages.length < 50; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (!entry.fromUser && entry.text) {
            agentMessages.push({ text: entry.text, timestamp: entry.timestamp });
          }
        } catch { /* skip malformed lines */ }
      }

      const violations: string[] = [];
      for (const msg of agentMessages) {
        for (const bad of BAD_OUTPUT_PATTERNS) {
          if (msg.text.includes(bad.pattern)) {
            // Exception: localhost in "locally at" phrasing is intentional
            if (bad.pattern === 'localhost' && msg.text.includes('locally at')) continue;
            // Exception: localhost in code blocks or instructions
            if (bad.pattern === 'localhost' && (msg.text.includes('```') || msg.text.includes('curl'))) continue;
            // Exception: "undefined" as part of technical descriptions (property paths,
            // quoted terms, code discussions) — only flag standalone undefined that looks
            // like a leaked JS value (e.g., "Hello undefined" or "value: undefined")
            if (bad.pattern === 'undefined') {
              const inCodeBlock = msg.text.includes('```');
              const isPropertyPath = /\.\s*undefined|undefined\s*[.=]/.test(msg.text);
              const isQuoted = /"undefined"|'undefined'|`undefined`/.test(msg.text);
              if (inCodeBlock || isPropertyPath || isQuoted) continue;
            }
            violations.push(`"${bad.pattern}" found in agent message (${bad.description})`);
          }
        }
      }

      if (violations.length === 0) {
        results.push({
          name: 'output-sanity',
          passed: true,
          message: `Last ${agentMessages.length} agent messages clean`,
        });
      } else {
        // Deduplicate violations
        const unique = [...new Set(violations)];
        results.push({
          name: 'output-sanity',
          passed: false,
          message: `${unique.length} bad pattern(s) in recent output: ${unique.join('; ')}`,
        });
      }
    } catch (err) {
      results.push({
        name: 'output-sanity',
        passed: false,
        message: `Failed to scan message log: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    return results;
  }

  /**
   * Check 4: Feature Readiness
   * Verify features that should be configured actually are.
   */
  private checkFeatureReadiness(): CoherenceCheckResult[] {
    const results: CoherenceCheckResult[] = [];
    const { liveConfig, stateDir } = this.config;

    // If a dashboard topic is registered, PIN should exist
    try {
      const stateFile = path.join(stateDir, 'state', 'kv.json');
      let dashboardTopicExists = false;

      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        dashboardTopicExists = typeof state['dashboard-topic'] === 'number' && state['dashboard-topic'] > 0;
      }

      if (dashboardTopicExists) {
        const pin = liveConfig.get<string>('dashboardPin', '');
        if (pin) {
          results.push({
            name: 'readiness-dashboard-pin',
            passed: true,
            message: 'Dashboard PIN configured',
          });
        } else {
          // Self-correct: generate a PIN
          const newPin = String(Math.floor(100000 + Math.random() * 900000));
          liveConfig.set('dashboardPin', newPin);
          results.push({
            name: 'readiness-dashboard-pin',
            passed: false,
            message: 'Dashboard PIN was missing',
            corrected: true,
            correctionDetail: `Generated PIN: ${newPin}`,
          });
          this.logCorrection('readiness-dashboard-pin', `Generated missing dashboard PIN: ${newPin}`);
        }
      }
    } catch {
      // Can't check — not critical
    }

    // If Telegram is configured, check that messaging config has a token
    try {
      const messaging = liveConfig.get<Array<{ type: string; config?: { token?: string } }>>('messaging', []);
      const telegramConfig = messaging.find(m => m.type === 'telegram');

      if (telegramConfig) {
        const hasToken = typeof telegramConfig.config?.token === 'string' && telegramConfig.config.token.length > 0;
        results.push({
          name: 'readiness-telegram-token',
          passed: hasToken,
          message: hasToken ? 'Telegram bot token configured' : 'Telegram configured but token missing',
        });
      }
    } catch {
      // Can't check — not critical
    }

    // Check that authToken exists (needed for API security)
    const authToken = liveConfig.get<string>('authToken', '');
    if (authToken) {
      results.push({
        name: 'readiness-auth-token',
        passed: true,
        message: 'Auth token configured',
      });
    } else {
      results.push({
        name: 'readiness-auth-token',
        passed: false,
        message: 'No auth token — API is unauthenticated',
      });
    }

    return results;
  }

  // ── Internal ────────────────────────────────────────────────────

  /** Read the AutoUpdater state file to check if a restart is already pending. */
  private readAutoUpdaterState(): { lastAppliedVersion?: string } | null {
    try {
      const statePath = path.join(this.config.stateDir, 'state', 'auto-updater.json');
      if (!fs.existsSync(statePath)) return null;
      return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    } catch {
      return null;
    }
  }

  private logCorrection(check: string, detail: string): void {
    this.correctionLog.push({
      timestamp: new Date().toISOString(),
      check,
      detail,
    });

    // Keep last 100 corrections
    if (this.correctionLog.length > 100) {
      this.correctionLog = this.correctionLog.slice(-100);
    }
  }

  private persistReport(report: CoherenceReport): void {
    try {
      const reportDir = path.join(this.config.stateDir, 'state');
      fs.mkdirSync(reportDir, { recursive: true });
      const reportPath = path.join(reportDir, 'coherence-report.json');
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    } catch {
      // @silent-fallback-ok — report persistence is nice-to-have
    }
  }
}
