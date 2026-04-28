/**
 * DegradationReporter — makes fallback activations LOUD, not silent.
 *
 * When a feature falls back to a secondary path, that's a bug. The fallback
 * keeps the system running, but someone needs to know the primary path failed.
 * Silent fallbacks are almost as bad as silent failures — the user gets a
 * degraded experience and nobody knows about it.
 *
 * This reporter:
 *   1. Logs visibly to console with [DEGRADATION] prefix
 *   2. Queues reports until downstream systems (feedback, telegram) are ready
 *   3. Drains to FeedbackManager (files bug report back to Instar)
 *   4. Sends Telegram alert to agent-attention topic
 *   5. Stores all degradations in a structured file for health checks
 *
 * Usage:
 *   const reporter = DegradationReporter.getInstance();
 *   reporter.report({
 *     feature: 'TopicMemory',
 *     primary: 'SQLite-backed context with summaries',
 *     fallback: 'JSONL-based last 20 messages',
 *     reason: 'better-sqlite3 failed to load',
 *     impact: 'Sessions start without conversation summaries',
 *   });
 *
 * Born from the insight: "Fallbacks should only and always be associated
 * with a bug report back to Instar." — Justin, 2026-02-25
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectJargon } from '../core/JargonDetector.js';
import type { MessagingToneGate } from '../core/MessagingToneGate.js';

export interface DegradationEvent {
  /** Which feature degraded */
  feature: string;
  /** What the primary path does */
  primary: string;
  /** What the fallback does (the degraded path) */
  fallback: string;
  /** Why the primary path failed */
  reason: string;
  /** User-facing impact of the degradation */
  impact: string;
  /** When the degradation was detected */
  timestamp: string;
  /** Whether this was reported to the feedback system */
  reported: boolean;
  /** Whether this was sent as a Telegram alert */
  alerted: boolean;
}

type TelegramSender = (topicId: number, text: string) => Promise<unknown>;
/**
 * Self-heal callback. Returns true if the heal succeeded and the user
 * message should be suppressed; false if the heal failed or was not
 * possible. Producers register one healer per feature name. If no healer
 * is registered for a feature, the alert path proceeds without an
 * attempt and the selfHeal signal reports `attempted: false`.
 */
export type SelfHealer = (event: DegradationEvent) => Promise<boolean>;
/**
 * Safe fallback template used when the tone gate blocks the candidate
 * health-alert message. Plain English, ends with a yes/no the user can
 * answer in one word.
 */
const SAFE_HEALTH_ALERT_TEMPLATE = 'Something on my end stopped working and I haven\'t been able to fix it on my own. Want me to dig in?';
type FeedbackSubmitter = (item: {
  type: 'bug';
  title: string;
  description: string;
  agentName: string;
  instarVersion: string;
  nodeVersion: string;
  os: string;
  context?: string;
}) => Promise<unknown>;

// How long before the same feature can trigger another Telegram alert (ms)
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export class DegradationReporter {
  private static instance: DegradationReporter | null = null;

  private events: DegradationEvent[] = [];
  private stateDir: string | null = null;
  private agentName: string = 'unknown';
  private instarVersion: string = '0.0.0';

  // Downstream systems — connected once the server is fully up
  private feedbackSubmitter: FeedbackSubmitter | null = null;
  private telegramSender: TelegramSender | null = null;
  private alertTopicId: number | null = null;
  private toneGate: MessagingToneGate | null = null;
  private healers: Map<string, SelfHealer> = new Map();

  // Dedup: track last alert time per feature to avoid spamming Telegram
  private lastAlertTime: Map<string, number> = new Map();

  private constructor() {}

  static getInstance(): DegradationReporter {
    if (!DegradationReporter.instance) {
      DegradationReporter.instance = new DegradationReporter();
    }
    return DegradationReporter.instance;
  }

  /**
   * Reset singleton for testing.
   */
  static resetForTesting(): void {
    DegradationReporter.instance = null;
  }

  /**
   * Configure with agent identity and storage.
   * Called during server startup before features initialize.
   */
  configure(opts: {
    stateDir: string;
    agentName: string;
    instarVersion: string;
  }): void {
    this.stateDir = opts.stateDir;
    this.agentName = opts.agentName;
    this.instarVersion = opts.instarVersion;
  }

  /**
   * Connect downstream reporting systems.
   * Called once the server is fully started and feedback/telegram are available.
   * Drains any queued events that were reported before downstream was ready.
   */
  connectDownstream(opts: {
    feedbackSubmitter?: FeedbackSubmitter;
    telegramSender?: TelegramSender;
    alertTopicId?: number | null;
    toneGate?: MessagingToneGate | null;
  }): void {
    this.feedbackSubmitter = opts.feedbackSubmitter ?? null;
    this.telegramSender = opts.telegramSender ?? null;
    this.alertTopicId = opts.alertTopicId ?? null;
    this.toneGate = opts.toneGate ?? null;

    // Drain queued events that weren't reported yet
    this.drainQueue();
  }

  /**
   * Register a self-heal callback for a feature. When a degradation for
   * that feature is reported, the callback is invoked BEFORE the user
   * alert path runs. If it returns true, the user alert is suppressed
   * (the issue is already fixed). If it returns false, the alert proceeds.
   *
   * Healers should be idempotent — they may be invoked on every report
   * for that feature.
   */
  registerHealer(feature: string, healer: SelfHealer): void {
    this.healers.set(feature, healer);
  }

  /**
   * Report a degradation event.
   *
   * This is the primary API. Call this whenever a fallback activates.
   * If downstream systems aren't ready yet, the event is queued.
   */
  report(event: Omit<DegradationEvent, 'timestamp' | 'reported' | 'alerted'>): void {
    const full: DegradationEvent = {
      ...event,
      timestamp: new Date().toISOString(),
      reported: false,
      alerted: false,
    };

    // Always log to console — never silent
    console.warn(
      `[DEGRADATION] ${event.feature}: ${event.reason}\n` +
      `  Primary: ${event.primary}\n` +
      `  Fallback: ${event.fallback}\n` +
      `  Impact: ${event.impact}`
    );

    this.events.push(full);
    this.persistToDisk(full);

    // Try to report immediately if downstream is connected
    this.reportEvent(full);
  }

  /**
   * Get all degradation events (for health check API).
   */
  getEvents(): DegradationEvent[] {
    return [...this.events];
  }

  /**
   * Generate a human-readable narrative for a degradation event.
   * Used for Telegram alerts and health endpoint summaries.
   * No technical identifiers, no structured fields — just plain language.
   */
  static narrativeFor(event: DegradationEvent): string {
    const impact = event.impact.replace(/\.$/, '');
    const fallbackLower = event.fallback.toLowerCase();

    // Detect failure-state fallbacks (no real alternative, just broken)
    // These describe what ISN'T working, not what IS being used instead
    const isFailureState = /^no |unavailable|never |lost|undiagnosed|unreachable|not running|not delivered|cannot|won't/i.test(fallbackLower)
      || /goes undiagnosed|left halted|in memory only|only in memory|never delivered/i.test(fallbackLower);

    if (isFailureState) {
      return `${impact}. I'll keep trying, but this may need a restart to fully resolve.`;
    }

    // Positive fallback — describe the backup approach being used
    // Strip prefixes like "Falling back to", "Message only in", etc.
    let fallback = event.fallback
      .replace(/^Falling back to /i, '')
      .replace(/^Message only in /i, 'the ')
      .replace(/\.$/, '');

    // Strip parenthetical caveats — the user doesn't need "(no search, no summary updates)"
    fallback = fallback.replace(/\s*\([^)]*\)\s*/g, ' ').trim();

    return `${impact}. Using ${fallback} in the meantime — everything else is working fine.`;
  }

  /**
   * Get unreported events (for monitoring).
   */
  getUnreportedEvents(): DegradationEvent[] {
    return this.events.filter(e => !e.reported);
  }

  /**
   * Mark events as reported by feature-name match. Used by the
   * guardian-pulse daily digest consumer (PR0c — context-death-pitfall-
   * prevention spec) after surfacing them to the attention queue. The
   * built-in feedback / Telegram pipeline marks events automatically;
   * this method is for *external* consumers that close the loop manually.
   *
   * Returns the count of events actually flipped (already-reported events
   * are not counted again — idempotent).
   *
   * `featurePattern` may be either an exact feature-name string or a
   * RegExp. The string form is exact-match; pass a RegExp for prefixes
   * (e.g. /^unjustifiedStopGate/).
   */
  markReported(featurePattern: string | RegExp): number {
    const matcher = typeof featurePattern === 'string'
      ? (name: string) => name === featurePattern
      : (name: string) => featurePattern.test(name);
    let flipped = 0;
    for (const event of this.events) {
      if (!event.reported && matcher(event.feature)) {
        event.reported = true;
        flipped++;
      }
    }
    return flipped;
  }

  /**
   * Check if any degradations have occurred.
   */
  hasDegradations(): boolean {
    return this.events.length > 0;
  }

  // ── Internal ──────────────────────────────────────────────

  private async reportEvent(event: DegradationEvent): Promise<void> {
    // Submit to feedback system
    if (this.feedbackSubmitter && !event.reported) {
      try {
        await this.feedbackSubmitter({
          type: 'bug',
          title: `[DEGRADATION] ${event.feature}: ${event.reason}`,
          description: [
            `A feature fallback was activated, indicating the primary path is broken.`,
            ``,
            `**Feature**: ${event.feature}`,
            `**Primary path**: ${event.primary}`,
            `**Fallback used**: ${event.fallback}`,
            `**Reason**: ${event.reason}`,
            `**Impact**: ${event.impact}`,
            `**Timestamp**: ${event.timestamp}`,
          ].join('\n'),
          agentName: this.agentName,
          instarVersion: this.instarVersion,
          nodeVersion: process.version,
          os: `${os.platform()} ${os.release()}`,
          context: JSON.stringify({
            feature: event.feature,
            reason: event.reason,
            nodeArch: process.arch,
            nodeVersion: process.version,
          }),
        });
        event.reported = true;
      } catch (err) {
        // @silent-fallback-ok — self-referential (cannot report own failures)
        // Don't fail on reporting failures — the console log is the safety net
        console.error(`[DEGRADATION] Failed to submit feedback: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Send Telegram alert (with per-feature cooldown to avoid spam)
    if (this.telegramSender && this.alertTopicId && !event.alerted) {
      const lastAlert = this.lastAlertTime.get(event.feature) ?? 0;
      const now = Date.now();

      if (now - lastAlert >= ALERT_COOLDOWN_MS) {
        // Self-heal-first. Try the registered healer (if any) before
        // bothering the user. If it succeeds, suppress the alert.
        const healResult = await this.attemptSelfHeal(event);
        if (healResult.succeeded === true) {
          event.alerted = true;
          this.lastAlertTime.set(event.feature, now);
          console.warn(
            `[DEGRADATION] ${event.feature}: self-heal succeeded after ${healResult.attempts} attempt(s); user alert suppressed.`
          );
        } else {
          // Compose the narrative, route it through the tone gate with
          // health-alert signals, fall back to the safe template if blocked.
          const candidate = DegradationReporter.narrativeFor(event);
          const finalText = await this.gateHealthAlert(candidate, healResult);
          try {
            await this.telegramSender(this.alertTopicId, finalText);
            event.alerted = true;
            this.lastAlertTime.set(event.feature, now);
          } catch {
            // Don't fail on alerting failures
          }
        }
      } else {
        // Within cooldown — suppress the alert but mark as handled
        event.alerted = true;
      }
    }

    // Update persisted state
    this.persistToDisk(event);
  }

  /**
   * Attempt the registered self-healer for a feature, if any. Returns the
   * structured signal payload the tone gate expects.
   *
   * No healer registered → `{attempted: false, succeeded: null, attempts: 0}`
   * Healer threw         → `{attempted: true,  succeeded: false, attempts: 1}`
   * Healer returned      → `{attempted: true,  succeeded: result, attempts: 1}`
   */
  private async attemptSelfHeal(event: DegradationEvent): Promise<{
    attempted: boolean;
    succeeded: boolean | null;
    attempts: number;
  }> {
    const healer = this.healers.get(event.feature);
    if (!healer) {
      return { attempted: false, succeeded: null, attempts: 0 };
    }
    try {
      const ok = await healer(event);
      return { attempted: true, succeeded: !!ok, attempts: 1 };
    } catch (err) {
      console.warn(
        `[DEGRADATION] ${event.feature}: self-healer threw — ${err instanceof Error ? err.message : err}`
      );
      return { attempted: true, succeeded: false, attempts: 1 };
    }
  }

  /**
   * Route a candidate health-alert message through the MessagingToneGate
   * with the jargon + selfHeal signals attached. If the gate blocks (rule
   * B12/B13/B14) the candidate is replaced with the safe-template fallback.
   *
   * The gate is the single authority. If no gate is wired (early startup,
   * tests, etc.) the candidate is sent unchanged — fail-open is consistent
   * with how the rest of the outbound surface treats gate-unavailable.
   */
  private async gateHealthAlert(
    candidate: string,
    healSignal: { attempted: boolean; succeeded: boolean | null; attempts: number },
  ): Promise<string> {
    if (!this.toneGate) {
      return candidate;
    }
    const jargon = detectJargon(candidate);
    try {
      const result = await this.toneGate.review(candidate, {
        channel: 'telegram',
        messageKind: 'health-alert',
        signals: {
          jargon: { detected: jargon.detected, terms: jargon.terms, score: jargon.score },
          selfHeal: healSignal,
        },
      });
      if (result.pass) {
        return candidate;
      }
      return SAFE_HEALTH_ALERT_TEMPLATE;
    } catch {
      // Fail-open on unexpected gate errors — at least the user hears
      // SOMETHING about the degradation.
      return candidate;
    }
  }

  private drainQueue(): void {
    for (const event of this.events) {
      if (!event.reported || !event.alerted) {
        this.reportEvent(event);
      }
    }
  }

  private persistToDisk(event: DegradationEvent): void {
    if (!this.stateDir) return;

    try {
      const filePath = path.join(this.stateDir, 'degradations.json');
      let existing: DegradationEvent[] = [];
      try {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch { /* first write */ }

      // Update or append
      const idx = existing.findIndex(
        e => e.feature === event.feature && e.timestamp === event.timestamp
      );
      if (idx >= 0) {
        existing[idx] = event;
      } else {
        existing.push(event);
      }

      // Keep only last 100 events
      if (existing.length > 100) {
        existing = existing.slice(-100);
      }

      fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
    } catch {
      // Disk persistence is best-effort
    }
  }
}
