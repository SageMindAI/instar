/**
 * IntegrationGate -- Enforces learning consolidation after job completion.
 *
 * Mirrors Portal's compose-guard pattern: compose-guard ensures grounding
 * BEFORE sending, IntegrationGate ensures learning AFTER job execution.
 *
 * The flow:
 *   1. Job completes -> notifyJobComplete calls gate.evaluate()
 *   2. Gate runs reflection (synchronous, NOT fire-and-forget)
 *   3. Gate runs pattern analysis
 *   4. Gate auto-populates CommonBlockers from high-confidence patterns
 *   5. If failed job produced no learning -> gate BLOCKS queue drain
 *   6. If learning captured -> gate ALLOWS queue drain
 *
 * Born from the 234th Lesson: "Skill text is not enforcement."
 * Born from the 235th Lesson: "Scheduled jobs vs ad-hoc sessions."
 */

import { JobReflector } from '../core/JobReflector.js';
import type { ReflectionInsight } from '../core/JobReflector.js';
import { PatternAnalyzer } from '../core/PatternAnalyzer.js';
import type { PatternReport, DetectedPattern } from '../core/PatternAnalyzer.js';
import { ExecutionJournal } from '../core/ExecutionJournal.js';
import type { JobDefinition, IntelligenceProvider, CommonBlocker } from '../core/types.js';
import type { JobRunHistory } from './JobRunHistory.js';
import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────────

export interface IntegrationGateConfig {
  stateDir: string;
  intelligence: IntelligenceProvider | null;
  runHistory: JobRunHistory;
  /** Timeout in ms before gate gives up and proceeds. Default: 30000 */
  defaultTimeoutMs?: number;
}

export interface GateContext {
  job: JobDefinition;
  sessionId: string;
  runId: string | null;
  failed: boolean;
  output: string;
  topicId?: number;
}

export interface GateResult {
  /** Whether the scheduler should proceed with queue drain */
  proceed: boolean;
  /** Reflection insight produced (null if skipped or failed) */
  reflectionInsight: ReflectionInsight | null;
  /** Number of patterns detected in analysis */
  patternsDetected: number;
  /** CommonBlocker keys that were auto-added */
  blockersAdded: string[];
  /** Reason the gate blocked (undefined if proceed=true) */
  gateBlockReason?: string;
  /** How long the gate evaluation took */
  durationMs: number;
  /** True if gate was not applicable (livingSkills not enabled, etc.) */
  skipped?: boolean;
}

// ── Gate Implementation ──────────────────────────────────────────────────────

export class IntegrationGate {
  private config: IntegrationGateConfig;
  private consecutiveBlocks: Map<string, number> = new Map();

  /** Maximum consecutive blocks before auto-downgrade to warning */
  static readonly MAX_CONSECUTIVE_BLOCKS = 3;

  constructor(config: IntegrationGateConfig) {
    this.config = config;
  }

  /**
   * Evaluate whether a completed job's learning has been captured.
   * Returns proceed=true if the scheduler should drain the queue.
   */
  async evaluate(ctx: GateContext): Promise<GateResult> {
    const startTime = Date.now();

    // Skip if livingSkills not enabled
    if (!ctx.job.livingSkills?.enabled) {
      return this.makeResult(true, startTime, { skipped: true });
    }

    // Skip if explicitly opted out
    if (ctx.job.livingSkills.integrationGate === false) {
      return this.makeResult(true, startTime, { skipped: true });
    }

    // No intelligence provider = can't reflect
    if (!this.config.intelligence) {
      if (ctx.failed) {
        // Failed job with no intelligence -> block (can't learn from failure)
        return this.handleBlock(ctx.job.slug, startTime,
          `Job "${ctx.job.slug}" failed but no intelligence provider is configured -- cannot produce reflection. ` +
          `Configure an intelligence provider or set livingSkills.integrationGate: false to skip.`
        );
      }
      // Successful job, no intelligence -> proceed with warning
      return this.makeResult(true, startTime);
    }

    // Run reflection with timeout
    const timeoutMs = ctx.job.livingSkills.integrationGateTimeoutMs
      ?? this.config.defaultTimeoutMs
      ?? 30000;

    let insight: ReflectionInsight | null = null;
    let patternReport: PatternReport | null = null;
    let timedOut = false;

    try {
      const result = await Promise.race([
        this.runLearning(ctx),
        this.timeout(timeoutMs),
      ]);

      if (result === 'TIMEOUT') {
        timedOut = true;
      } else {
        insight = result.insight;
        patternReport = result.patternReport;
      }
    } catch (err) {
      // Reflection errored -- treat like timeout
      console.error(`[integration-gate] Learning failed for "${ctx.job.slug}": ${err}`);
    }

    // Record reflection in run history if we got one
    if (insight && ctx.runId) {
      try {
        this.config.runHistory.recordReflection(ctx.runId, {
          summary: insight.summary,
          strengths: insight.strengths,
          improvements: insight.improvements,
          deviationAnalysis: insight.deviationAnalysis,
          purposeDrift: insight.purposeDrift,
          suggestedChanges: insight.suggestedChanges,
        });
      } catch {
        // Don't let history recording break the gate
      }
    }

    // Auto-populate CommonBlockers from high-confidence patterns
    const blockersAdded: string[] = [];
    if (patternReport) {
      const added = this.autoPopulateBlockers(ctx.job.slug, patternReport, ctx.sessionId);
      blockersAdded.push(...added);
    }

    // Decision logic
    if (timedOut) {
      // Timed out -> proceed with warning (don't stall queue)
      return this.makeResult(true, startTime, {
        reflectionInsight: insight,
        patternsDetected: patternReport?.patterns.length ?? 0,
        blockersAdded,
        gateBlockReason: `IntegrationGate timed out after ${timeoutMs}ms -- proceeding without full learning capture`,
      });
    }

    if (ctx.failed && !insight) {
      // Failed job with no reflection -> block
      return this.handleBlock(ctx.job.slug, startTime,
        `Job "${ctx.job.slug}" failed but reflection produced no insight. ` +
        `Learning from failure requires a working intelligence provider.`,
        { patternsDetected: patternReport?.patterns.length ?? 0, blockersAdded }
      );
    }

    // Success path: clear consecutive blocks counter
    this.consecutiveBlocks.delete(ctx.job.slug);

    return this.makeResult(true, startTime, {
      reflectionInsight: insight,
      patternsDetected: patternReport?.patterns.length ?? 0,
      blockersAdded,
    });
  }

  /**
   * Run reflection and pattern analysis for a completed job.
   */
  private async runLearning(ctx: GateContext): Promise<{
    insight: ReflectionInsight | null;
    patternReport: PatternReport | null;
  }> {
    const reflector = new JobReflector({
      stateDir: this.config.stateDir,
      intelligence: this.config.intelligence ?? undefined,
      model: this.mapReflectionModel(ctx.job.livingSkills?.reflectionModel),
    });

    // Run reflection (synchronous -- the key difference from fire-and-forget)
    const insight = await reflector.reflect(ctx.job.slug, {
      sessionId: ctx.sessionId,
      includePatterns: true,
    });

    // Run pattern analysis
    const journal = new ExecutionJournal(this.config.stateDir);
    const analyzer = new PatternAnalyzer(journal);
    let patternReport: PatternReport | null = null;
    try {
      patternReport = analyzer.analyze(ctx.job.slug, { days: 30 });
    } catch {
      // Pattern analysis failure is non-critical
    }

    return { insight, patternReport };
  }

  /**
   * Auto-populate CommonBlockers from high-confidence failure patterns.
   * Writes to {stateDir}/state/jobs/{slug}/auto-blockers.json
   */
  private autoPopulateBlockers(
    jobSlug: string,
    report: PatternReport,
    sessionId: string,
  ): string[] {
    const highConfidencePatterns = report.patterns.filter(
      p => p.confidence === 'high'
    );

    if (highConfidencePatterns.length === 0) return [];

    const blockersDir = path.join(this.config.stateDir, 'state', 'jobs', jobSlug);
    const blockersFile = path.join(blockersDir, 'auto-blockers.json');

    // Load existing blockers
    let existing: Record<string, CommonBlocker> = {};
    try {
      existing = JSON.parse(fs.readFileSync(blockersFile, 'utf-8'));
    } catch {
      // No existing file -- start fresh
    }

    const added: string[] = [];

    for (const pattern of highConfidencePatterns) {
      const key = this.patternToBlockerKey(pattern);

      // Deduplicate
      if (existing[key]) continue;

      existing[key] = {
        description: pattern.description,
        resolution: pattern.suggestion,
        addedFrom: sessionId,
        addedAt: new Date().toISOString(),
        status: 'pending',
        successCount: 0,
      };
      added.push(key);
    }

    if (added.length > 0) {
      fs.mkdirSync(blockersDir, { recursive: true });
      // Atomic write: write to tmp then rename
      const tmpFile = blockersFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(existing, null, 2));
      fs.renameSync(tmpFile, blockersFile);
    }

    return added;
  }

  /**
   * Handle a gate block, with consecutive-block downgrade logic.
   */
  private handleBlock(
    jobSlug: string,
    startTime: number,
    reason: string,
    extras: Partial<GateResult> = {},
  ): GateResult {
    const blocks = (this.consecutiveBlocks.get(jobSlug) ?? 0) + 1;
    this.consecutiveBlocks.set(jobSlug, blocks);

    if (blocks > IntegrationGate.MAX_CONSECUTIVE_BLOCKS) {
      // Auto-downgrade after too many consecutive blocks
      return this.makeResult(true, startTime, {
        ...extras,
        gateBlockReason: `IntegrationGate auto-downgraded after ${blocks} consecutive blocks for "${jobSlug}". ` +
          `Original reason: ${reason}. Proceeding to prevent permanent queue stall.`,
      });
    }

    return this.makeResult(false, startTime, {
      ...extras,
      gateBlockReason: reason,
    });
  }

  private makeResult(proceed: boolean, startTime: number, extras: Partial<GateResult> = {}): GateResult {
    return {
      proceed,
      reflectionInsight: null,
      patternsDetected: 0,
      blockersAdded: [],
      durationMs: Date.now() - startTime,
      ...extras,
    };
  }

  private timeout(ms: number): Promise<'TIMEOUT'> {
    return new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), ms));
  }

  private patternToBlockerKey(pattern: DetectedPattern): string {
    // Create a stable key from the pattern type and step
    const base = pattern.step
      ? `${pattern.type}:${pattern.step}`
      : `${pattern.type}:${pattern.description.slice(0, 50)}`;
    return base.replace(/[^a-zA-Z0-9:_-]/g, '_').toLowerCase();
  }

  private mapReflectionModel(
    model?: import('../core/types.js').ModelTier | null,
  ): 'fast' | 'balanced' | 'capable' {
    const MAP: Record<string, 'fast' | 'balanced' | 'capable'> = {
      opus: 'capable',
      sonnet: 'balanced',
      haiku: 'fast',
    };
    return model ? MAP[model] ?? 'fast' : 'fast';
  }
}
