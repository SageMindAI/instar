/**
 * ReflectionMetrics — Usage-based reflection trigger.
 *
 * Tracks cumulative metrics (tool calls, sessions, minutes) since the last
 * reflection and suggests reflection when thresholds are crossed.
 *
 * Ported from Dawn's battle-tested two-hook pattern:
 * - Deterministic metrics collection (every PostToolUse event, zero LLM cost)
 * - Threshold-based reflection suggestion (agent decides whether to reflect)
 *
 * The key insight: time-based reflection (every 4 hours) misses busy periods
 * that need reflection and triggers during idle periods that don't.
 * Usage-based reflection triggers when the agent has actually DONE enough
 * to have something worth reflecting on.
 *
 * Storage: {stateDir}/state/reflection-metrics.json
 * Thresholds: self-tunable by the agent (stored in the metrics file)
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ──────────────────────────────────────────────────────────

export interface ReflectionThresholds {
  /** Trigger reflection after this many tool calls */
  toolCalls: number;
  /** Trigger reflection after this many sessions */
  sessions: number;
  /** Trigger reflection after this many minutes */
  minutes: number;
}

export interface ReflectionMetricsData {
  /** Tool calls since last reflection */
  toolCallsSinceReflection: number;
  /** Sessions since last reflection */
  sessionsSinceReflection: number;
  /** Timestamp when metrics tracking started (or last reflection) */
  trackingSince: string;
  /** Timestamp of last reflection */
  lastReflectionTimestamp: string | null;
  /** Type of last reflection (e.g., 'quick', 'deep', 'grounding') */
  lastReflectionType: string | null;
  /** Self-tunable thresholds */
  thresholds: ReflectionThresholds;
  /** Reflection history (most recent 20) */
  history: ReflectionHistoryEntry[];
}

export interface ReflectionHistoryEntry {
  timestamp: string;
  type: string;
  toolCallsAtReflection: number;
  sessionsAtReflection: number;
  minutesAtReflection: number;
}

export interface ReflectionCheck {
  /** Whether reflection is suggested */
  suggested: boolean;
  /** Which thresholds were exceeded */
  exceededThresholds: string[];
  /** Current metrics */
  metrics: {
    toolCalls: number;
    sessions: number;
    minutesSinceReflection: number;
  };
  /** Current thresholds */
  thresholds: ReflectionThresholds;
}

// ── Default Thresholds ─────────────────────────────────────────────

const DEFAULT_THRESHOLDS: ReflectionThresholds = {
  toolCalls: 50,
  sessions: 3,
  minutes: 120,
};

const MAX_HISTORY = 20;

// ── Implementation ─────────────────────────────────────────────────

export class ReflectionMetrics {
  private file: string;
  private data: ReflectionMetricsData;

  constructor(stateDir: string) {
    const stateSubDir = path.join(stateDir, 'state');
    if (!fs.existsSync(stateSubDir)) {
      fs.mkdirSync(stateSubDir, { recursive: true });
    }
    this.file = path.join(stateSubDir, 'reflection-metrics.json');
    this.data = this.load();
  }

  /**
   * Increment tool call counter. Called on every PostToolUse event.
   */
  recordToolCall(): void {
    this.data.toolCallsSinceReflection++;
    this.save();
  }

  /**
   * Increment session counter. Called when a new session starts.
   */
  recordSessionStart(): void {
    this.data.sessionsSinceReflection++;
    this.save();
  }

  /**
   * Check if reflection is suggested based on current metrics.
   * This is a pure check — doesn't modify state.
   */
  check(): ReflectionCheck {
    const minutesSince = this.minutesSinceReflection();
    const exceeded: string[] = [];

    if (this.data.toolCallsSinceReflection >= this.data.thresholds.toolCalls) {
      exceeded.push('toolCalls');
    }
    if (this.data.sessionsSinceReflection >= this.data.thresholds.sessions) {
      exceeded.push('sessions');
    }
    if (minutesSince >= this.data.thresholds.minutes) {
      exceeded.push('minutes');
    }

    return {
      suggested: exceeded.length > 0,
      exceededThresholds: exceeded,
      metrics: {
        toolCalls: this.data.toolCallsSinceReflection,
        sessions: this.data.sessionsSinceReflection,
        minutesSinceReflection: minutesSince,
      },
      thresholds: { ...this.data.thresholds },
    };
  }

  /**
   * Record that reflection occurred. Resets all counters.
   */
  recordReflection(type: string): void {
    const now = new Date().toISOString();

    // Add to history
    this.data.history.push({
      timestamp: now,
      type,
      toolCallsAtReflection: this.data.toolCallsSinceReflection,
      sessionsAtReflection: this.data.sessionsSinceReflection,
      minutesAtReflection: this.minutesSinceReflection(),
    });

    // Trim history
    if (this.data.history.length > MAX_HISTORY) {
      this.data.history = this.data.history.slice(-MAX_HISTORY);
    }

    // Reset counters
    this.data.toolCallsSinceReflection = 0;
    this.data.sessionsSinceReflection = 0;
    this.data.trackingSince = now;
    this.data.lastReflectionTimestamp = now;
    this.data.lastReflectionType = type;

    this.save();
  }

  /**
   * Update thresholds (self-tuning by the agent).
   */
  updateThresholds(thresholds: Partial<ReflectionThresholds>): void {
    if (thresholds.toolCalls !== undefined) this.data.thresholds.toolCalls = thresholds.toolCalls;
    if (thresholds.sessions !== undefined) this.data.thresholds.sessions = thresholds.sessions;
    if (thresholds.minutes !== undefined) this.data.thresholds.minutes = thresholds.minutes;
    this.save();
  }

  /**
   * Get current metrics data (for API/display).
   */
  getData(): ReflectionMetricsData {
    return { ...this.data };
  }

  // ── Internal ───────────────────────────────────────────────────────

  private minutesSinceReflection(): number {
    const since = this.data.lastReflectionTimestamp ?? this.data.trackingSince;
    return Math.round((Date.now() - new Date(since).getTime()) / 60000);
  }

  private load(): ReflectionMetricsData {
    if (fs.existsSync(this.file)) {
      try {
        const raw = fs.readFileSync(this.file, 'utf-8');
        const parsed = JSON.parse(raw) as ReflectionMetricsData;
        // Ensure all fields exist (forward compat)
        return {
          toolCallsSinceReflection: parsed.toolCallsSinceReflection ?? 0,
          sessionsSinceReflection: parsed.sessionsSinceReflection ?? 0,
          trackingSince: parsed.trackingSince ?? new Date().toISOString(),
          lastReflectionTimestamp: parsed.lastReflectionTimestamp ?? null,
          lastReflectionType: parsed.lastReflectionType ?? null,
          thresholds: { ...DEFAULT_THRESHOLDS, ...parsed.thresholds },
          history: parsed.history ?? [],
        };
      } catch {
        // Corrupted file — start fresh
      }
    }

    return {
      toolCallsSinceReflection: 0,
      sessionsSinceReflection: 0,
      trackingSince: new Date().toISOString(),
      lastReflectionTimestamp: null,
      lastReflectionType: null,
      thresholds: { ...DEFAULT_THRESHOLDS },
      history: [],
    };
  }

  private save(): void {
    try {
      const tmpPath = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmpPath, this.file);
    } catch (err) {
      console.error('[ReflectionMetrics] Failed to save:', err);
    }
  }
}
