/**
 * Message Sentinel — Intelligent interrupt interpreter for agent sessions.
 *
 * Sits between user messages and the active session, classifying every
 * incoming message to detect emergency signals that need immediate action.
 *
 * Born from the OpenClaw email deletion incident (2026-02-25): The user
 * typed "STOP" repeatedly but the agent continued deleting emails because
 * messages queued in the session's input buffer. By the time the session
 * processed "stop," 200+ emails were gone.
 *
 * The Sentinel solves this by running in the server process (separate from
 * the session). It can kill or pause the session immediately — before the
 * message even enters the session's queue.
 *
 * Two classification layers:
 * 1. Fast-path — regex patterns for obvious signals (<5ms)
 * 2. LLM classification — haiku-tier for ambiguous messages (<500ms)
 *
 * Design principle: The entity that evaluates whether to stop must be
 * separate from the entity performing the work.
 */

import type { IntelligenceProvider } from './types.js';

// ── Types ────────────────────────────────────────────────────────────

export type SentinelCategory = 'emergency-stop' | 'pause' | 'redirect' | 'normal';

export interface SentinelClassification {
  /** What category this message falls into */
  category: SentinelCategory;
  /** Confidence score (0-1) */
  confidence: number;
  /** Whether this was classified via fast-path or LLM */
  method: 'fast-path' | 'llm' | 'default';
  /** Classification latency in ms */
  latencyMs: number;
  /** The recommended action */
  action: SentinelAction;
  /** Optional reason for the classification */
  reason?: string;
}

export type SentinelAction =
  | { type: 'kill-session' }
  | { type: 'pause-session' }
  | { type: 'priority-inject'; message: string }
  | { type: 'pass-through' };

export interface MessageSentinelConfig {
  /** Intelligence provider for LLM classification */
  intelligence?: IntelligenceProvider;
  /** Additional fast-path stop patterns (merged with defaults) */
  customStopPatterns?: string[];
  /** Additional fast-path pause patterns (merged with defaults) */
  customPausePatterns?: string[];
  /** Whether the Sentinel is enabled (default: true) */
  enabled?: boolean;
  /** Skip LLM classification and use fast-path only (default: false) */
  fastPathOnly?: boolean;
}

export interface SentinelStats {
  /** Total messages classified */
  totalClassified: number;
  /** By category */
  byCategory: Record<SentinelCategory, number>;
  /** By method */
  byMethod: Record<string, number>;
  /** Average latency ms */
  avgLatencyMs: number;
  /** Emergency stops triggered */
  emergencyStops: number;
}

// ── Fast-Path Patterns ───────────────────────────────────────────────

/**
 * Exact-match patterns that bypass LLM classification.
 * These are unambiguous emergency signals.
 */
const FAST_STOP_EXACT: ReadonlySet<string> = new Set([
  'stop',
  'stop!',
  'stop!!',
  'stop!!!',
  'abort',
  'abort!',
  'cancel',
  'cancel!',
  'kill',
  'kill it',
  'stop now',
  'stop immediately',
  'cancel everything',
  'abort everything',
  'stop right now',
  'cease',
  'halt',
  'quit',
  'terminate',
]);

/**
 * Slash command patterns — always fast-path.
 */
const SLASH_STOP: ReadonlySet<string> = new Set([
  '/stop',
  '/kill',
  '/abort',
  '/cancel',
  '/terminate',
]);

const SLASH_PAUSE: ReadonlySet<string> = new Set([
  '/pause',
  '/wait',
  '/hold',
]);

/**
 * Regex patterns for fast-path stop detection.
 * Tested before LLM classification.
 */
const FAST_STOP_PATTERNS: readonly RegExp[] = [
  /^stop\b/i,                         // "stop" at start of message
  /^don'?t do (that|this|anything)/i,  // "don't do that/this/anything"
  /^no!?\s*stop/i,                     // "no stop", "no! stop"
  /^STOP/,                             // All caps STOP (without /i — caps matters)
  /^please stop/i,                     // "please stop"
  /^stop\s*(it|this|that|now)/i,       // "stop it", "stop this", "stop now"
];

const FAST_PAUSE_EXACT: ReadonlySet<string> = new Set([
  'wait',
  'wait!',
  'hold on',
  'hold on!',
  'pause',
  'one moment',
  'one sec',
  'hang on',
]);

const FAST_PAUSE_PATTERNS: readonly RegExp[] = [
  /^wait\b/i,
  /^hold on/i,
  /^pause\b/i,
  /^hang on/i,
  /^one (sec|moment|minute)/i,
  /^let me think/i,
];

// ── Sentinel Implementation ──────────────────────────────────────────

export class MessageSentinel {
  private config: MessageSentinelConfig;
  private stats: SentinelStats;
  private customStopExact: Set<string>;
  private customPauseExact: Set<string>;

  constructor(config: MessageSentinelConfig = {}) {
    this.config = config;
    this.stats = {
      totalClassified: 0,
      byCategory: { 'emergency-stop': 0, 'pause': 0, 'redirect': 0, 'normal': 0 },
      byMethod: { 'fast-path': 0, 'llm': 0, 'default': 0 },
      avgLatencyMs: 0,
      emergencyStops: 0,
    };

    // Merge custom patterns
    this.customStopExact = new Set(
      (config.customStopPatterns ?? []).map(p => p.toLowerCase().trim())
    );
    this.customPauseExact = new Set(
      (config.customPausePatterns ?? []).map(p => p.toLowerCase().trim())
    );
  }

  /**
   * Classify an incoming user message.
   *
   * Returns the classification with recommended action.
   * The caller (TelegramAdapter/server) decides whether to execute the action.
   */
  async classify(message: string): Promise<SentinelClassification> {
    if (this.config.enabled === false) {
      return {
        category: 'normal',
        confidence: 1,
        method: 'default',
        latencyMs: 0,
        action: { type: 'pass-through' },
        reason: 'Sentinel disabled',
      };
    }

    const start = Date.now();

    // Layer 1: Fast-path classification
    const fastResult = this.fastClassify(message);
    if (fastResult) {
      const latency = Date.now() - start;
      this.recordStats(fastResult.category, 'fast-path', latency);
      return {
        ...fastResult,
        method: 'fast-path',
        latencyMs: latency,
      };
    }

    // Layer 2: LLM classification (if available and not fast-path-only)
    if (this.config.intelligence && !this.config.fastPathOnly) {
      const llmResult = await this.llmClassify(message);
      const latency = Date.now() - start;
      this.recordStats(llmResult.category, 'llm', latency);
      return {
        ...llmResult,
        method: 'llm',
        latencyMs: latency,
      };
    }

    // Default: pass through
    const latency = Date.now() - start;
    this.recordStats('normal', 'default', latency);
    return {
      category: 'normal',
      confidence: 0.5,
      method: 'default',
      latencyMs: latency,
      action: { type: 'pass-through' },
      reason: 'No fast-path match, no LLM available',
    };
  }

  /**
   * Fast-path classification using pattern matching.
   * Returns null if no pattern matches (falls through to LLM).
   */
  private fastClassify(message: string): Omit<SentinelClassification, 'method' | 'latencyMs'> | null {
    const trimmed = message.trim();
    const lower = trimmed.toLowerCase();

    // Slash commands — highest priority, unambiguous
    if (SLASH_STOP.has(lower)) {
      return {
        category: 'emergency-stop',
        confidence: 1.0,
        action: { type: 'kill-session' },
        reason: `Slash command: ${lower}`,
      };
    }

    if (SLASH_PAUSE.has(lower)) {
      return {
        category: 'pause',
        confidence: 1.0,
        action: { type: 'pause-session' },
        reason: `Slash command: ${lower}`,
      };
    }

    // Exact match — emergency stop
    if (FAST_STOP_EXACT.has(lower) || this.customStopExact.has(lower)) {
      return {
        category: 'emergency-stop',
        confidence: 0.95,
        action: { type: 'kill-session' },
        reason: `Exact match: "${lower}"`,
      };
    }

    // Exact match — pause
    if (FAST_PAUSE_EXACT.has(lower) || this.customPauseExact.has(lower)) {
      return {
        category: 'pause',
        confidence: 0.95,
        action: { type: 'pause-session' },
        reason: `Exact match: "${lower}"`,
      };
    }

    // Regex patterns — emergency stop
    for (const pattern of FAST_STOP_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          category: 'emergency-stop',
          confidence: 0.85,
          action: { type: 'kill-session' },
          reason: `Pattern match: ${pattern}`,
        };
      }
    }

    // Regex patterns — pause
    for (const pattern of FAST_PAUSE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          category: 'pause',
          confidence: 0.85,
          action: { type: 'pause-session' },
          reason: `Pattern match: ${pattern}`,
        };
      }
    }

    // All caps message (short) — likely an emergency
    if (trimmed === trimmed.toUpperCase() && trimmed.length > 2 && trimmed.length < 50 && /[A-Z]/.test(trimmed)) {
      // Only if it contains stop-like words
      if (/\b(STOP|NO|DON'?T|CANCEL|ABORT|HALT|QUIT)\b/.test(trimmed)) {
        return {
          category: 'emergency-stop',
          confidence: 0.8,
          action: { type: 'kill-session' },
          reason: `All-caps stop signal: "${trimmed}"`,
        };
      }
    }

    // No fast-path match
    return null;
  }

  /**
   * LLM-based classification for ambiguous messages.
   */
  private async llmClassify(message: string): Promise<Omit<SentinelClassification, 'method' | 'latencyMs'>> {
    if (!this.config.intelligence) {
      return {
        category: 'normal',
        confidence: 0.5,
        action: { type: 'pass-through' },
        reason: 'No intelligence provider',
      };
    }

    const prompt = [
      'You are a message classifier for an AI agent system.',
      'Classify the following user message into exactly one category:',
      '',
      '- emergency-stop: User wants the agent to stop immediately (examples: "don\'t do that", "I changed my mind stop", "NO NO NO", "cancel what you\'re doing")',
      '- pause: User wants the agent to pause and wait (examples: "hold on let me think", "wait a second", "not yet")',
      '- redirect: User wants to change the agent\'s course (examples: "actually do X instead", "no I meant Y", "forget that, do this")',
      '- normal: Regular conversation that doesn\'t require interruption',
      '',
      'IMPORTANT: When in doubt between emergency-stop and normal, prefer emergency-stop.',
      'It is much safer to stop unnecessarily than to continue destructively.',
      '',
      `Message: "${message}"`,
      '',
      'Respond with exactly one word: emergency-stop, pause, redirect, or normal.',
    ].join('\n');

    try {
      const response = await this.config.intelligence.evaluate(prompt, {
        maxTokens: 10,
        temperature: 0,
      });

      const category = response.trim().toLowerCase() as SentinelCategory;
      const validCategories: SentinelCategory[] = ['emergency-stop', 'pause', 'redirect', 'normal'];

      if (!validCategories.includes(category)) {
        // Unparseable → err toward caution
        return {
          category: 'pause',
          confidence: 0.4,
          action: { type: 'pause-session' },
          reason: `LLM response unparseable: "${response.trim()}"`,
        };
      }

      return {
        category,
        confidence: 0.8,
        action: this.categoryToAction(category, message),
        reason: `LLM classification: ${category}`,
      };
    } catch {
      // LLM failure → pass through (don't block on evaluation errors)
      return {
        category: 'normal',
        confidence: 0.3,
        action: { type: 'pass-through' },
        reason: 'LLM classification failed, defaulting to pass-through',
      };
    }
  }

  /**
   * Map a category to its recommended action.
   */
  private categoryToAction(category: SentinelCategory, message: string): SentinelAction {
    switch (category) {
      case 'emergency-stop':
        return { type: 'kill-session' };
      case 'pause':
        return { type: 'pause-session' };
      case 'redirect':
        return { type: 'priority-inject', message };
      case 'normal':
        return { type: 'pass-through' };
    }
  }

  /**
   * Record classification stats.
   */
  private recordStats(category: SentinelCategory, method: string, latencyMs: number): void {
    this.stats.totalClassified++;
    this.stats.byCategory[category]++;
    this.stats.byMethod[method] = (this.stats.byMethod[method] ?? 0) + 1;

    if (category === 'emergency-stop') {
      this.stats.emergencyStops++;
    }

    // Running average
    const n = this.stats.totalClassified;
    this.stats.avgLatencyMs = ((this.stats.avgLatencyMs * (n - 1)) + latencyMs) / n;
  }

  /**
   * Get current stats.
   */
  getStats(): SentinelStats {
    return { ...this.stats };
  }

  /**
   * Reset stats.
   */
  resetStats(): void {
    this.stats = {
      totalClassified: 0,
      byCategory: { 'emergency-stop': 0, 'pause': 0, 'redirect': 0, 'normal': 0 },
      byMethod: { 'fast-path': 0, 'llm': 0, 'default': 0 },
      avgLatencyMs: 0,
      emergencyStops: 0,
    };
  }

  /**
   * Check if the sentinel is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled !== false;
  }
}
