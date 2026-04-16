/**
 * CoherenceGate — Main orchestrator for the response review pipeline.
 *
 * Evaluates agent responses before they reach users. Architecture:
 *   1. Policy Enforcement Layer (PEL) — deterministic hard blocks
 *   2. Gate Reviewer — fast LLM triage (does this need full review?)
 *   3. Specialist Reviewers — parallel LLM calls checking specific dimensions
 *
 * Implements the 15-row normative decision matrix from the Coherence Gate spec.
 * Handles retry tracking, conversation advancement detection, feedback composition,
 * per-channel fail behavior, and reviewer criticality tiers.
 *
 * NOTE: The pre-action scope verification system lives in ScopeVerifier.ts.
 * This module handles response review — different purpose, same coherence mission.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PolicyEnforcementLayer } from './PolicyEnforcementLayer.js';
import type { PELResult, PELContext } from './PolicyEnforcementLayer.js';
import { CoherenceReviewer, type ReviewResult, type ReviewContext } from './CoherenceReviewer.js';
import { GateReviewer, type GateResult } from './reviewers/gate-reviewer.js';
import { ConversationalToneReviewer } from './reviewers/conversational-tone.js';
import { ClaimProvenanceReviewer } from './reviewers/claim-provenance.js';
import { SettlingDetectionReviewer } from './reviewers/settling-detection.js';
import { ContextCompletenessReviewer } from './reviewers/context-completeness.js';
import { CapabilityAccuracyReviewer } from './reviewers/capability-accuracy.js';
import { UrlValidityReviewer } from './reviewers/url-validity.js';
import { ValueAlignmentReviewer } from './reviewers/value-alignment.js';
import { InformationLeakageReviewer } from './reviewers/information-leakage.js';
import { EscalationResolutionReviewer } from './reviewers/escalation-resolution.js';
import type { EscalationReviewContext, EscalationReviewResult } from './reviewers/escalation-resolution.js';
import type { CapabilityRegistry, CommonBlocker } from './types.js';
import { ResearchRateLimiter } from './ResearchRateLimiter.js';
import { RecipientResolver, type RecipientContext } from './RecipientResolver.js';
import { CustomReviewerLoader } from './CustomReviewerLoader.js';
import { CanonicalState } from './CanonicalState.js';
import type { ResponseReviewConfig, ChannelReviewConfig } from './types.js';

// ── Types ────────────────────────────────────────────────────────────

export interface EvaluateRequest {
  message: string;
  sessionId: string;
  stopHookActive: boolean;
  context: {
    channel: string;
    topicId?: number;
    recipientType?: 'primary-user' | 'secondary-user' | 'agent' | 'external-contact';
    recipientId?: string;
    isExternalFacing?: boolean;
    transcriptPath?: string;
    capabilityRegistry?: CapabilityRegistry;
    jobBlockers?: Record<string, CommonBlocker>;
    autonomyLevel?: 'cautious' | 'supervised' | 'collaborative' | 'autonomous';
    isResearchSession?: boolean;
  };
}

export interface EvaluateResponse {
  pass: boolean;
  feedback?: string;
  issueCategories?: string[];
  warnings?: string[];
  retryCount?: number;
  /** Internal: full violations for audit log (not sent to agent) */
  _auditViolations?: AuditViolation[];
  /** Internal: whether this was a PEL block */
  _pelBlock?: boolean;
  /** Internal: gate result */
  _gateResult?: GateResult;
  /** Internal: outcome for decision matrix tracking */
  _outcome?: string;
  /** Internal: whether a research agent was triggered */
  _researchTriggered?: boolean;
}

export interface AuditViolation {
  reviewer: string;
  severity: 'block' | 'warn';
  issue: string;
  suggestion: string;
  latencyMs: number;
}

interface SessionRetryState {
  retryCount: number;
  lastViolations: AuditViolation[];
  transcriptVersion: number;
  createdAt: number;
}

export interface ResearchTriggerContext {
  blockerDescription: string;
  capabilities?: CapabilityRegistry;
  jobSlug?: string;
  sessionId: string;
}

export interface CoherenceGateOptions {
  config: ResponseReviewConfig;
  stateDir: string;
  /** Anthropic API key. Empty string is allowed when `intelligence` is provided. */
  apiKey: string;
  /**
   * Optional IntelligenceProvider. When provided, all reviewers route LLM calls
   * through this abstraction (subscription-compatible). When omitted, reviewers
   * fall back to direct Anthropic API calls using `apiKey`.
   */
  intelligence?: import('./types.js').IntelligenceProvider;
  relationships?: { getContextForPerson(id: string): string | null } | null;
  adaptiveTrust?: { getProfile(): any } | null;
  /** Callback fired when a research agent should be spawned (fire-and-forget). */
  onResearchTriggered?: (context: ResearchTriggerContext) => void;
}

// ── Category Mapping (reviewer → generic category for agent feedback) ─

const REVIEWER_CATEGORY_MAP: Record<string, string> = {
  'conversational-tone': 'TONE ISSUE',
  'claim-provenance': 'ACCURACY ISSUE',
  'settling-detection': 'ACCURACY ISSUE',
  'context-completeness': 'COMPLETENESS ISSUE',
  'capability-accuracy': 'CAPABILITY ISSUE',
  'url-validity': 'ACCURACY ISSUE',
  'value-alignment': 'ALIGNMENT ISSUE',
  'information-leakage': 'ALIGNMENT ISSUE',
  'escalation-resolution': 'ESCALATION ISSUE',
};

/** Violation types for retry exhaustion handling */
const HIGH_STAKES_CATEGORIES = new Set(['ACCURACY ISSUE', 'ALIGNMENT ISSUE']);

// ── Value Document Cache ─────────────────────────────────────────────

interface ValueDocCache {
  agentValues: string;
  userValues: string;
  orgValues: string;
  loadedAt: number;
}

const VALUE_DOC_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

// ── Main Class ───────────────────────────────────────────────────────

/**
 * Ledger event for Integrated-Being v1 — fires on block decisions.
 * Signal-only; never blocks on ledger write failure. Passes rule id ONLY
 * (no rule context), per spec to avoid leaking bypass hints to later sessions.
 */
export interface CoherenceGateLedgerEvent {
  ruleId: string;
  sessionId: string;
  channel: string;
  timestamp: string;
}

export class CoherenceGate {
  private config: ResponseReviewConfig;
  private stateDir: string;
  private pel: PolicyEnforcementLayer;
  private gateReviewer: GateReviewer;
  private reviewers: Map<string, CoherenceReviewer> = new Map();
  private recipientResolver: RecipientResolver;
  private retrySessions: Map<string, SessionRetryState> = new Map();
  private sessionMutexes: Map<string, Promise<void>> = new Map();
  private valueDocCache: ValueDocCache | null = null;
  private reviewHistory: AuditLogEntry[] = [];
  private proposals: ReviewProposal[] = [];
  private researchRateLimiter: ResearchRateLimiter;
  private canonicalState: CanonicalState;
  private onResearchTriggered?: (context: ResearchTriggerContext) => void;
  private onLedgerEventSink: ((evt: CoherenceGateLedgerEvent) => void) | null = null;
  private static RETENTION_DAYS = 30;

  constructor(options: CoherenceGateOptions) {
    this.config = options.config;
    this.stateDir = options.stateDir;
    this.onResearchTriggered = options.onResearchTriggered;
    this.researchRateLimiter = new ResearchRateLimiter({ stateDir: options.stateDir });
    this.canonicalState = new CanonicalState({ stateDir: path.join(options.stateDir, 'state') });

    // Initialize PEL
    this.pel = new PolicyEnforcementLayer(options.stateDir);

    // Initialize gate reviewer
    this.gateReviewer = new GateReviewer(options.apiKey, {
      model: options.config.gateModel ?? 'haiku',
      timeoutMs: 5_000,
      intelligence: options.intelligence,
    });

    // Initialize built-in specialist reviewers
    this.initializeReviewers(options.apiKey, options.config, options.intelligence);

    // Initialize recipient resolver
    this.recipientResolver = new RecipientResolver({
      stateDir: options.stateDir,
      relationships: options.relationships,
      adaptiveTrust: options.adaptiveTrust,
    });

    // Load custom reviewers
    this.loadCustomReviewers(options.apiKey, options.intelligence);
  }

  /**
   * Register a ledger-event sink (Integrated-Being v1). Signal-only; thrown
   * exceptions from the sink are swallowed. Called once during server wiring
   * by registerLedgerEmitters().
   */
  setLedgerEventSink(sink: (evt: CoherenceGateLedgerEvent) => void): void {
    this.onLedgerEventSink = sink;
  }

  /** Internal helper that safely fires the ledger event sink. */
  private emitLedgerBlock(ruleId: string, sessionId: string, channel: string): void {
    if (!this.onLedgerEventSink) return;
    try {
      this.onLedgerEventSink({
        ruleId,
        sessionId,
        channel,
        timestamp: new Date().toISOString(),
      });
    } catch { /* signal-only */ }
  }

  /**
   * Evaluate an agent's draft response. Main entry point.
   * Implements the 15-row normative decision matrix.
   */
  async evaluate(request: EvaluateRequest): Promise<EvaluateResponse> {
    const { message, sessionId, stopHookActive, context } = request;

    // Session mutex — prevent concurrent reviews for same session
    await this.acquireMutex(sessionId);
    try {
      return await this._evaluate(message, sessionId, stopHookActive, context);
    } finally {
      this.releaseMutex(sessionId);
    }
  }

  private async _evaluate(
    message: string,
    sessionId: string,
    stopHookActive: boolean,
    context: EvaluateRequest['context'],
  ): Promise<EvaluateResponse> {
    const isExternal = context.isExternalFacing ?? this.isExternalChannel(context.channel);
    const channelConfig = this.resolveChannelConfig(context.channel, isExternal);
    const recipientType = context.recipientType ?? 'primary-user';

    // ── Retry state management ──────────────────────────────────
    let retryState = this.retrySessions.get(sessionId);
    if (!stopHookActive) {
      // New response (not a revision) — reset retry counter
      retryState = {
        retryCount: 0,
        lastViolations: [],
        transcriptVersion: this.getTranscriptVersion(context.transcriptPath),
        createdAt: Date.now(),
      };
      this.retrySessions.set(sessionId, retryState);
    } else if (retryState) {
      retryState.retryCount++;
      // Conversation advancement detection
      const currentVersion = this.getTranscriptVersion(context.transcriptPath);
      if (currentVersion > retryState.transcriptVersion) {
        // User sent a new message — abandon stale revision
        this.retrySessions.delete(sessionId);
        this.logAudit(sessionId, context, 'abandoned', [], 'Conversation advanced during revision');
        return { pass: true, _outcome: 'abandoned-stale' };
      }
    } else {
      retryState = { retryCount: 1, lastViolations: [], transcriptVersion: 0, createdAt: Date.now() };
      this.retrySessions.set(sessionId, retryState);
    }

    const maxRetries = this.config.maxRetries ?? 2;

    // ── Step 1: PEL (always runs, even in observeOnly) ──────────
    const pelContext: PELContext = {
      channel: context.channel,
      isExternalFacing: isExternal,
      recipientType,
      stateDir: this.stateDir,
    };
    const pelResult = this.pel.enforce(message, pelContext);

    // Row 1: PEL HARD_BLOCK → always block, no exceptions
    if (pelResult.outcome === 'hard_block') {
      const feedback = this.composePELFeedback(pelResult);
      this.logAudit(sessionId, context, 'pel-block', [], 'PEL hard block');
      // Integrated-Being: rule id only, no rule context. Spec §Write path §4.
      this.emitLedgerBlock('PEL_HARD_BLOCK', sessionId, context.channel);
      return {
        pass: false,
        feedback,
        issueCategories: ['POLICY VIOLATION'],
        retryCount: retryState.retryCount,
        _pelBlock: true,
        _outcome: 'block',
      };
    }

    // Row 3: observeOnly → log but never block (except PEL)
    const observeOnly = this.config.observeOnly ?? false;

    // ── Step 2: Resolve recipient context ────────────────────────
    const recipientContext = this.recipientResolver.resolve(
      context.recipientId,
      recipientType,
    );

    // ── Step 3: Extract tool output context from transcript ──────
    const toolOutputContext = context.transcriptPath
      ? this.extractToolContext(context.transcriptPath)
      : undefined;

    // ── Step 4: Extract URLs for URL validity reviewer ───────────
    const extractedUrls = this.extractUrls(message);

    // ── Step 5: Load value documents (cached) ────────────────────
    const valueDocs = this.loadValueDocs();

    // ── Step 5b: Load canonical state for fact-checking ───────────
    const canonicalStateContext = this.loadCanonicalStateContext();

    // ── Step 6: Build review context ─────────────────────────────
    const reviewCtx: EscalationReviewContext = {
      message,
      channel: context.channel,
      isExternalFacing: isExternal,
      recipientType,
      toolOutputContext,
      extractedUrls: extractedUrls.length > 0 ? extractedUrls : undefined,
      agentValues: valueDocs.agentValues || undefined,
      userValues: valueDocs.userValues || undefined,
      orgValues: valueDocs.orgValues || undefined,
      trustLevel: recipientContext.trustLevel,
      relationshipContext: recipientContext.communicationStyle ? {
        communicationStyle: recipientContext.communicationStyle,
        formality: recipientContext.formality,
        themes: recipientContext.themes,
      } : undefined,
      canonicalStateContext: canonicalStateContext || undefined,
      capabilityRegistry: context.capabilityRegistry,
      autonomyLevel: context.autonomyLevel,
      jobBlockers: context.jobBlockers,
      isResearchSession: context.isResearchSession,
    };

    // ── Step 7: Gate reviewer ────────────────────────────────────
    let gateResult: GateResult | undefined;
    const skipGate = channelConfig.skipGate ?? false;

    if (!skipGate) {
      gateResult = await this.gateReviewer.reviewAsGate(reviewCtx);
      if (!gateResult.needsReview) {
        // Row 4: PEL PASS + Gate says no review needed → PASS
        const warnings = pelResult.outcome === 'warn'
          ? pelResult.violations.map(v => v.detail)
          : [];
        this.logAudit(sessionId, context, 'pass-gate', [], 'Gate skipped full review');
        return {
          pass: true,
          warnings,
          _gateResult: gateResult,
          _outcome: 'pass',
        };
      }
    }

    // ── Step 8: Specialist reviewers (parallel fan-out) ──────────
    const enabledReviewers = this.getEnabledReviewers(context.channel, recipientType, channelConfig);
    const results = await Promise.allSettled(
      enabledReviewers.map(r => r.review(reviewCtx)),
    );

    // Collect results
    const settled: ReviewResult[] = [];
    let abstainCount = 0;
    let highCritTimeout = false;

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        settled.push(result.value);
      } else {
        // Reviewer failed — treat as abstain
        abstainCount++;
        const reviewerName = enabledReviewers[i].name;
        const criticality = this.config.reviewerCriticality?.[reviewerName] ?? 'standard';
        if (criticality === 'high') {
          highCritTimeout = true;
        }
      }
    }

    // ── Step 8b: Check for research trigger signals ────────────
    let researchTriggered = false;
    for (const result of settled) {
      const escalationResult = result as EscalationReviewResult;
      if (escalationResult.needsResearch && escalationResult.researchContext) {
        const rateLimitDecision = this.researchRateLimiter.check(
          escalationResult.researchContext.blockerDescription,
        );
        if (rateLimitDecision.allowed && this.onResearchTriggered) {
          this.researchRateLimiter.record(
            escalationResult.researchContext.blockerDescription,
            sessionId,
          );
          this.onResearchTriggered({
            blockerDescription: escalationResult.researchContext.blockerDescription,
            capabilities: escalationResult.researchContext.capabilities,
            sessionId,
          });
          researchTriggered = true;
        }
      }
    }

    // ── Step 9: Aggregate verdicts ───────────────────────────────
    const blockResults = settled.filter(r => !r.pass && this.getReviewerMode(r.reviewer) === 'block');
    const warnResults = settled.filter(r => !r.pass && this.getReviewerMode(r.reviewer) === 'warn');
    const allAbstain = settled.length === 0 && abstainCount > 0;
    const majorityAbstain = abstainCount > enabledReviewers.length / 2;

    // Check warn escalation threshold
    const warnEscalationThreshold = this.config.warnEscalationThreshold ?? 3;
    const warnEscalated = warnResults.length >= warnEscalationThreshold;

    // Determine LLM verdict
    let llmVerdict: 'PASS' | 'BLOCK' | 'WARN_ONLY' | 'ALL_ABSTAIN' | 'TIMEOUT' | 'HIGH_CRIT_TIMEOUT';
    if (allAbstain || majorityAbstain) {
      llmVerdict = 'ALL_ABSTAIN';
    } else if (highCritTimeout && isExternal) {
      llmVerdict = 'HIGH_CRIT_TIMEOUT';
    } else if (blockResults.length > 0 || warnEscalated) {
      llmVerdict = 'BLOCK';
    } else if (warnResults.length > 0) {
      llmVerdict = 'WARN_ONLY';
    } else {
      llmVerdict = 'PASS';
    }

    // ── Step 10: Apply normative decision matrix ─────────────────
    const pelOutcome = pelResult.outcome; // 'pass' | 'warn' | 'hard_block' (hard_block handled above)
    const retryExhausted = retryState.retryCount >= maxRetries;

    // Build audit violations
    const auditViolations: AuditViolation[] = [...blockResults, ...warnResults].map(r => ({
      reviewer: r.reviewer,
      severity: r.severity,
      issue: r.issue,
      suggestion: r.suggestion,
      latencyMs: r.latencyMs,
    }));

    // Row 2: PEL WARN → pass + warn (PEL warns are advisory)
    const pelWarnings = pelResult.outcome === 'warn'
      ? pelResult.violations.map(v => v.detail)
      : [];

    // Row 3: observeOnly → always pass
    if (observeOnly) {
      this.logAudit(sessionId, context, 'observe-only', auditViolations, `LLM: ${llmVerdict}`);
      return {
        pass: true,
        warnings: [...pelWarnings, ...warnResults.map(r => r.issue)],
        _auditViolations: auditViolations,
        _gateResult: gateResult,
        _outcome: 'pass-observe',
      };
    }

    // Row 4: LLM PASS → deliver
    if (llmVerdict === 'PASS') {
      this.logAudit(sessionId, context, 'pass', auditViolations, 'All reviewers pass');
      return {
        pass: true,
        warnings: pelWarnings,
        _auditViolations: auditViolations,
        _gateResult: gateResult,
        _outcome: 'pass',
        _researchTriggered: researchTriggered || undefined,
      };
    }

    // Row 5: WARN_ONLY → deliver with warnings
    if (llmVerdict === 'WARN_ONLY') {
      this.logAudit(sessionId, context, 'pass-warn', auditViolations, 'Warnings only');
      return {
        pass: true,
        warnings: [...pelWarnings, ...warnResults.map(r => r.issue)],
        _auditViolations: auditViolations,
        _gateResult: gateResult,
        _outcome: 'pass-warn',
        _researchTriggered: researchTriggered || undefined,
      };
    }

    // Rows 10-15: ALL_ABSTAIN, TIMEOUT, HIGH_CRIT_TIMEOUT
    if (llmVerdict === 'ALL_ABSTAIN' || llmVerdict === 'HIGH_CRIT_TIMEOUT') {
      if (isExternal) {
        // Row 10, 12, 14: QUEUE for external
        if (channelConfig.queueOnFailure) {
          this.logAudit(sessionId, context, 'queued', auditViolations, `${llmVerdict}: queued`);
          return {
            pass: false,
            feedback: '[unreviewed] Review system temporarily unavailable. Message held for review.',
            issueCategories: ['INFRASTRUCTURE'],
            _auditViolations: auditViolations,
            _outcome: 'queue',
          };
        }
        // Fail-closed for external channels even without queueOnFailure,
        // unless explicitly configured as failOpen
        if (channelConfig.failOpen === false || channelConfig.failOpen === undefined) {
          this.logAudit(sessionId, context, 'block-failclosed', auditViolations, `${llmVerdict}: fail-closed (external)`);
          return {
            pass: false,
            feedback: '[unreviewed] Review system unavailable. External message blocked for safety.',
            issueCategories: ['INFRASTRUCTURE'],
            _auditViolations: auditViolations,
            _outcome: 'block-failclosed',
          };
        }
      }
      // Row 11, 13, 15: fail-open for internal (or explicitly failOpen external)
      this.logAudit(sessionId, context, 'pass-failopen', auditViolations, `${llmVerdict}: fail-open`);
      return {
        pass: true,
        warnings: ['[unreviewed] Some reviewers were unavailable'],
        _auditViolations: auditViolations,
        _outcome: 'pass-failopen',
      };
    }

    // Row 6: BLOCK + retries remaining → block for revision
    if (llmVerdict === 'BLOCK' && !retryExhausted) {
      const feedback = this.composeFeedback(blockResults, warnResults, retryState.retryCount, maxRetries);
      retryState.lastViolations = auditViolations;
      this.logAudit(sessionId, context, 'block', auditViolations, `Block: retry ${retryState.retryCount}/${maxRetries}`);
      // Integrated-Being: emit rule id ONLY (no context). Use the first block
      // reviewer's name as the rule id, consistent with existing audit logs.
      const ruleId = blockResults[0]?.reviewer ?? 'COHERENCE_BLOCK';
      this.emitLedgerBlock(ruleId, sessionId, context.channel);
      return {
        pass: false,
        feedback,
        issueCategories: this.getIssueCategories(blockResults),
        retryCount: retryState.retryCount,
        _auditViolations: auditViolations,
        _gateResult: gateResult,
        _outcome: 'block',
      };
    }

    // Rows 7-9: BLOCK + retry exhausted
    if (llmVerdict === 'BLOCK' && retryExhausted) {
      const categories = this.getIssueCategories(blockResults);
      const hasHighStakes = categories.some(c => HIGH_STAKES_CATEGORIES.has(c));

      if (isExternal && hasHighStakes) {
        // Row 9: External + accuracy/alignment → HOLD for operator review
        this.logAudit(sessionId, context, 'hold', auditViolations, 'Retry exhausted on high-stakes issue');
        return {
          pass: false,
          feedback: 'Response held for operator review due to unresolved accuracy/alignment concerns.',
          issueCategories: categories,
          retryCount: retryState.retryCount,
          _auditViolations: auditViolations,
          _outcome: 'hold',
        };
      }

      // Rows 7-8: Internal, or external + low-stakes → PASS + attention queue
      this.logAudit(sessionId, context, 'pass-exhausted', auditViolations, 'Retry exhausted, delivering');
      this.retrySessions.delete(sessionId);
      return {
        pass: true,
        warnings: [...pelWarnings, `[retry-exhausted] ${categories.join(', ')}`],
        _auditViolations: auditViolations,
        _gateResult: gateResult,
        _outcome: 'pass-exhausted',
      };
    }

    // Fallback (should not reach here)
    return { pass: true, _outcome: 'fallback' };
  }

  // ── Reviewer Management ────────────────────────────────────────────

  private initializeReviewers(
    apiKey: string,
    config: ResponseReviewConfig,
    intelligence?: import('./types.js').IntelligenceProvider,
  ): void {
    const defaultModel = config.reviewerModel ?? 'haiku';
    const overrides = config.reviewerModelOverrides ?? {};

    const reviewerDefs: Array<{ name: string; cls: new (apiKey: string, options?: any) => CoherenceReviewer }> = [
      { name: 'conversational-tone', cls: ConversationalToneReviewer },
      { name: 'claim-provenance', cls: ClaimProvenanceReviewer },
      { name: 'settling-detection', cls: SettlingDetectionReviewer },
      { name: 'context-completeness', cls: ContextCompletenessReviewer },
      { name: 'capability-accuracy', cls: CapabilityAccuracyReviewer },
      { name: 'url-validity', cls: UrlValidityReviewer },
      { name: 'value-alignment', cls: ValueAlignmentReviewer },
      { name: 'information-leakage', cls: InformationLeakageReviewer },
      { name: 'escalation-resolution', cls: EscalationResolutionReviewer },
    ];

    for (const { name, cls } of reviewerDefs) {
      const reviewerConfig = config.reviewers?.[name];
      if (reviewerConfig && !reviewerConfig.enabled) continue;

      const model = overrides[name] ?? defaultModel;
      const mode = reviewerConfig?.mode ?? 'block';
      const timeoutMs = config.timeoutMs ?? 8_000;

      this.reviewers.set(name, new cls(apiKey, { model, mode, timeoutMs, intelligence }));
    }
  }

  private loadCustomReviewers(
    apiKey: string,
    intelligence?: import('./types.js').IntelligenceProvider,
  ): void {
    const loader = new CustomReviewerLoader(this.stateDir);
    // Custom reviewer loading is best-effort — don't break startup
    try {
      const specs = loader.loadAll();
      for (const spec of specs) {
        if (this.reviewers.has(spec.name)) continue; // built-in takes precedence

        // Create a dynamic reviewer from the spec
        const mode = (this.config.reviewers?.[spec.name]?.mode ?? spec.mode) as 'block' | 'warn' | 'observe';
        const model = this.config.reviewerModelOverrides?.[spec.name] ?? this.config.reviewerModel ?? 'haiku';

        // Dynamic reviewer using the spec's prompt
        const reviewer = new DynamicReviewer(spec.name, apiKey, spec.prompt, spec.contextRequirements, {
          model, mode, timeoutMs: this.config.timeoutMs ?? 8_000, intelligence,
        });
        this.reviewers.set(spec.name, reviewer);
      }
    } catch {
      // @silent-fallback-ok — custom reviewer loading non-critical
    }
  }

  private getEnabledReviewers(
    channel: string,
    recipientType: string,
    channelConfig: ChannelReviewConfig,
  ): CoherenceReviewer[] {
    const enabled: CoherenceReviewer[] = [];

    for (const [name, reviewer] of this.reviewers) {
      // Skip information-leakage for primary-user
      if (name === 'information-leakage' && recipientType === 'primary-user') continue;

      // Skip observe-mode reviewers from blocking pipeline
      const mode = this.getReviewerMode(name);
      if (mode === 'observe') continue;

      enabled.push(reviewer);
    }

    // Add channel-specific additional reviewers if configured
    // (These would be custom reviewers registered for this channel)
    if (channelConfig.additionalReviewers) {
      for (const name of channelConfig.additionalReviewers) {
        const reviewer = this.reviewers.get(name);
        if (reviewer && !enabled.includes(reviewer)) {
          enabled.push(reviewer);
        }
      }
    }

    return enabled;
  }

  private getReviewerMode(reviewerName: string): 'block' | 'warn' | 'observe' {
    return this.config.reviewers?.[reviewerName]?.mode ?? 'block';
  }

  // ── Channel Configuration ──────────────────────────────────────────

  private resolveChannelConfig(channel: string, isExternal: boolean): ChannelReviewConfig {
    // Check explicit channel config first
    const explicit = this.config.channels?.[channel];
    if (explicit) return explicit;

    // Fall back to channel defaults
    const defaults = isExternal
      ? this.config.channelDefaults?.external
      : this.config.channelDefaults?.internal;

    return defaults ?? {
      failOpen: !isExternal,
      skipGate: isExternal,
      queueOnFailure: isExternal,
      queueTimeoutMs: 30_000,
    };
  }

  private isExternalChannel(channel: string): boolean {
    const internalChannels = new Set(['direct', 'cli', 'internal']);
    return !internalChannels.has(channel);
  }

  // ── Feedback Composition ───────────────────────────────────────────

  private composeFeedback(
    blocks: ReviewResult[],
    warns: ReviewResult[],
    retryCount: number,
    maxRetries: number,
  ): string {
    const allIssues = [...blocks, ...warns];
    const lines: string[] = [];

    if (retryCount > 0) {
      // Collapse format for revisions (context window management)
      const prevCategories = this.getIssueCategories(blocks);
      lines.push(`COHERENCE REVIEW: Previous attempt had ${allIssues.length} issue(s): ${prevCategories.join(', ')}.`);
      lines.push(`Current attempt (revision ${retryCount} of ${maxRetries}):`);
      lines.push('');
    } else {
      lines.push(`COHERENCE REVIEW: Your draft response has ${allIssues.length} issue(s) to address.`);
      lines.push('');
    }

    // Deduplicate by category
    const seen = new Set<string>();
    for (const result of allIssues) {
      const category = REVIEWER_CATEGORY_MAP[result.reviewer] ?? 'QUALITY ISSUE';
      if (seen.has(category)) continue;
      seen.add(category);

      lines.push(`[${category}]`);
      lines.push(result.issue);
      if (result.suggestion) {
        lines.push(result.suggestion);
      }
      lines.push('');
    }

    lines.push('Revise your response addressing the issues above. Keep the substance — just fix the flagged problems.');

    return lines.join('\n');
  }

  private composePELFeedback(pelResult: PELResult): string {
    const lines = ['POLICY VIOLATION: Your response contains content that cannot be sent.', ''];

    for (const violation of pelResult.violations) {
      if (violation.severity === 'hard_block') {
        lines.push(`[POLICY VIOLATION] ${violation.detail}`);
      }
    }

    lines.push('');
    lines.push('Remove the flagged content and try again.');
    return lines.join('\n');
  }

  private getIssueCategories(results: ReviewResult[]): string[] {
    const categories = new Set<string>();
    for (const r of results) {
      categories.add(REVIEWER_CATEGORY_MAP[r.reviewer] ?? 'QUALITY ISSUE');
    }
    return [...categories];
  }

  // ── Context Extraction ─────────────────────────────────────────────

  private extractToolContext(transcriptPath: string): string | undefined {
    try {
      if (!fs.existsSync(transcriptPath)) return undefined;

      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = content.trim().split('\n');

      // Extract last 3-5 tool results (look for tool_result entries)
      const toolResults: string[] = [];
      for (let i = lines.length - 1; i >= 0 && toolResults.length < 5; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry?.type === 'tool_result' || entry?.role === 'tool') {
            const text = typeof entry.content === 'string'
              ? entry.content
              : JSON.stringify(entry.content);
            // Truncate each result to ~100 tokens
            toolResults.unshift(text.slice(0, 400));
          }
        } catch {
          // Skip non-JSON lines
        }
      }

      if (toolResults.length === 0) return undefined;

      // Combine and truncate to ~500 tokens total
      const combined = toolResults.join('\n---\n');
      return combined.slice(0, 2000);
    } catch {
      return undefined;
    }
  }

  private extractUrls(message: string): string[] {
    const urlRegex = /https?:\/\/[^\s<>"')\]]+/g;
    return [...(message.match(urlRegex) ?? [])];
  }

  private loadValueDocs(): { agentValues: string; userValues: string; orgValues: string } {
    // Check cache
    if (this.valueDocCache && Date.now() - this.valueDocCache.loadedAt < VALUE_DOC_CACHE_TTL_MS) {
      return this.valueDocCache;
    }

    const agentValues = this.extractValueSection(
      path.join(this.stateDir, 'AGENT.md'),
      'Intent',
    );
    const userValues = this.extractValueSection(
      path.join(this.stateDir, 'USER.md'),
    );
    const orgValues = this.extractValueSection(
      path.join(this.stateDir, 'ORG-INTENT.md'),
    );

    this.valueDocCache = { agentValues, userValues, orgValues, loadedAt: Date.now() };
    return this.valueDocCache;
  }

  /**
   * Load canonical state context for fact-checking reviewers.
   * Returns a compact summary of known projects, URLs, and facts
   * that reviewers can cross-reference against agent claims.
   */
  private loadCanonicalStateContext(): string | null {
    try {
      const projects = this.canonicalState.getProjects();
      const facts = this.canonicalState.getQuickFacts();

      if (projects.length === 0 && facts.length === 0) return null;

      const lines: string[] = [];

      if (projects.length > 0) {
        lines.push('Known projects (from canonical registry):');
        for (const p of projects) {
          const parts = [`  - ${p.name}`];
          if (p.dir) parts.push(`dir: ${p.dir}`);
          if (p.deploymentTargets?.length) parts.push(`deploys: ${p.deploymentTargets.join(', ')}`);
          if (p.gitRemote) parts.push(`git: ${p.gitRemote}`);
          lines.push(parts.join(' | '));
        }
      }

      if (facts.length > 0) {
        lines.push('');
        lines.push('Known facts (from canonical registry):');
        for (const f of facts.slice(0, 10)) {
          lines.push(`  - Q: ${f.question} → A: ${f.answer}`);
        }
      }

      return lines.join('\n');
    } catch {
      return null;
    }
  }

  /**
   * Deterministic value document summarization.
   * Extracts headers, bullets, and bold text — not LLM summarization.
   * Target: ~200-400 tokens for all three tiers combined.
   */
  private extractValueSection(filePath: string, section?: string): string {
    try {
      if (!fs.existsSync(filePath)) return '';

      let content = fs.readFileSync(filePath, 'utf-8');

      // If a specific section is requested, extract it
      if (section) {
        const sectionRegex = new RegExp(`^##\\s+${section}[\\s\\S]*?(?=^##\\s|$)`, 'gm');
        const match = content.match(sectionRegex);
        content = match ? match[0] : content;
      }

      // Extract key elements: headers, bullets, bold text
      const lines = content.split('\n');
      const extracted: string[] = [];
      let tokens = 0;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Keep headers
        if (trimmed.startsWith('#')) {
          extracted.push(trimmed);
          tokens += trimmed.split(/\s+/).length;
        }
        // Keep bullet points
        else if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
          extracted.push(trimmed);
          tokens += trimmed.split(/\s+/).length;
        }
        // Keep bold text lines
        else if (trimmed.includes('**')) {
          extracted.push(trimmed);
          tokens += trimmed.split(/\s+/).length;
        }

        // Budget: ~150 tokens per document
        if (tokens > 150) break;
      }

      return extracted.join('\n');
    } catch {
      return '';
    }
  }

  // ── Conversation Advancement ───────────────────────────────────────

  private getTranscriptVersion(transcriptPath?: string): number {
    if (!transcriptPath) return 0;
    try {
      const stat = fs.statSync(transcriptPath);
      return stat.mtimeMs;
    } catch {
      return 0;
    }
  }

  // ── Session Mutex ──────────────────────────────────────────────────

  private async acquireMutex(sessionId: string): Promise<void> {
    while (this.sessionMutexes.has(sessionId)) {
      await this.sessionMutexes.get(sessionId);
    }
    let resolve: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    this.sessionMutexes.set(sessionId, promise);
    // Store resolve for release
    (promise as any).__resolve = resolve!;
  }

  private releaseMutex(sessionId: string): void {
    const promise = this.sessionMutexes.get(sessionId);
    this.sessionMutexes.delete(sessionId);
    if (promise && (promise as any).__resolve) {
      (promise as any).__resolve();
    }
  }

  // ── Audit Logging ──────────────────────────────────────────────────

  private logAudit(
    sessionId: string,
    context: EvaluateRequest['context'],
    verdict: string,
    violations: AuditViolation[],
    note: string,
  ): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      sessionId,
      channel: context.channel,
      recipientType: context.recipientType ?? 'primary-user',
      recipientId: context.recipientId,
      verdict,
      violations,
      note,
    };
    this.reviewHistory.push(entry);

    // Prune old entries (keep last 1000)
    if (this.reviewHistory.length > 1000) {
      this.reviewHistory = this.reviewHistory.slice(-1000);
    }
  }

  // ── Public API for routes ──────────────────────────────────────────

  getReviewHistory(options?: {
    sessionId?: string;
    reviewer?: string;
    verdict?: string;
    since?: string;
    recipientId?: string;
    limit?: number;
  }): AuditLogEntry[] {
    // Retention: purge entries older than RETENTION_DAYS
    const retentionCutoff = Date.now() - CoherenceGate.RETENTION_DAYS * 24 * 60 * 60 * 1000;
    this.reviewHistory = this.reviewHistory.filter(
      e => new Date(e.timestamp).getTime() >= retentionCutoff,
    );

    let entries = this.reviewHistory;

    if (options?.sessionId) {
      entries = entries.filter(e => e.sessionId === options.sessionId);
    }
    if (options?.reviewer) {
      entries = entries.filter(e =>
        e.violations.some(v => v.reviewer === options.reviewer),
      );
    }
    if (options?.verdict) {
      entries = entries.filter(e => e.verdict === options.verdict);
    }
    if (options?.recipientId) {
      entries = entries.filter(e => e.recipientId === options.recipientId);
    }
    if (options?.since) {
      const sinceDate = new Date(options.since).getTime();
      entries = entries.filter(e => new Date(e.timestamp).getTime() >= sinceDate);
    }

    const limit = options?.limit ?? 50;
    return entries.slice(-limit);
  }

  /**
   * Delete review history for a specific session (DSAR compliance).
   */
  deleteHistory(sessionId: string): number {
    const before = this.reviewHistory.length;
    this.reviewHistory = this.reviewHistory.filter(e => e.sessionId !== sessionId);
    return before - this.reviewHistory.length;
  }

  getReviewerStats(options?: { period?: 'daily' | 'weekly' | 'all'; since?: string }): Record<string, any> {
    const perReviewer: Record<string, any> = {};
    for (const [name, reviewer] of this.reviewers) {
      const m = reviewer.metrics;
      const total = m.passCount + m.failCount + m.errorCount;
      perReviewer[name] = {
        passRate: total > 0 ? m.passCount / total : 0,
        flagRate: total > 0 ? m.failCount / total : 0,
        errorRate: total > 0 ? m.errorCount / total : 0,
        avgLatencyMs: total > 0 ? Math.round(m.totalLatencyMs / total) : 0,
        jsonValidityRate: total > 0 ? 1 - (m.jsonParseErrors / total) : 1,
        total,
      };
    }

    // Per-recipient-type breakdown from history
    const recipientBreakdown: Record<string, { total: number; blocked: number; passed: number }> = {};
    let sinceMs = 0;
    if (options?.since) {
      sinceMs = new Date(options.since).getTime();
    } else if (options?.period === 'daily') {
      sinceMs = Date.now() - 24 * 60 * 60 * 1000;
    } else if (options?.period === 'weekly') {
      sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    }

    const filteredHistory = sinceMs > 0
      ? this.reviewHistory.filter(e => new Date(e.timestamp).getTime() >= sinceMs)
      : this.reviewHistory;

    for (const entry of filteredHistory) {
      const rt = entry.recipientType;
      if (!recipientBreakdown[rt]) {
        recipientBreakdown[rt] = { total: 0, blocked: 0, passed: 0 };
      }
      recipientBreakdown[rt].total++;
      if (entry.verdict.includes('block') || entry.verdict.includes('hold')) {
        recipientBreakdown[rt].blocked++;
      } else {
        recipientBreakdown[rt].passed++;
      }
    }

    // False positive indicators
    const totalBlocked = filteredHistory.filter(e =>
      e.verdict.includes('block') || e.verdict.includes('hold'),
    ).length;
    const totalExhausted = filteredHistory.filter(e =>
      e.verdict === 'pass-exhausted',
    ).length;

    return {
      reviewers: perReviewer,
      summary: {
        totalReviews: filteredHistory.length,
        totalBlocked,
        totalExhausted,
        exhaustionRate: filteredHistory.length > 0
          ? totalExhausted / filteredHistory.length
          : 0,
        period: options?.period ?? 'all',
      },
      recipientBreakdown,
    };
  }

  /** Check if the gate is enabled and ready */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ── Canary Tests ──────────────────────────────────────────────────

  /**
   * Run canary tests with known-bad messages. Returns results showing
   * which canary messages were caught and which were missed.
   */
  async runCanaryTests(): Promise<CanaryTestResult[]> {
    const results: CanaryTestResult[] = [];

    for (const canary of CANARY_CORPUS) {
      const response = await this.evaluate({
        message: canary.message,
        sessionId: `canary-${Date.now()}`,
        stopHookActive: false,
        context: {
          channel: canary.channel,
          isExternalFacing: canary.isExternalFacing,
          recipientType: canary.recipientType,
        },
      });

      const caught = !response.pass;
      results.push({
        canaryId: canary.id,
        description: canary.description,
        expectedDimension: canary.expectedDimension,
        caught,
        verdict: response._outcome as string,
        pass: caught === canary.shouldBlock,
      });
    }

    return results;
  }

  /**
   * Get reviewer health — per-reviewer pass rate relative to baseline expectations.
   */
  getReviewerHealth(): ReviewerHealthReport {
    const reviewerHealth: Record<string, {
      passRate: number;
      total: number;
      status: 'healthy' | 'degraded' | 'failing';
    }> = {};

    for (const [name, reviewer] of this.reviewers) {
      const m = reviewer.metrics;
      const total = m.passCount + m.failCount + m.errorCount;
      const passRate = total > 0 ? m.passCount / total : 1;
      const errorRate = total > 0 ? m.errorCount / total : 0;

      let status: 'healthy' | 'degraded' | 'failing' = 'healthy';
      if (errorRate > 0.5 || (total > 10 && passRate < 0.1)) {
        status = 'failing';
      } else if (errorRate > 0.2 || m.jsonParseErrors > total * 0.3) {
        status = 'degraded';
      }

      reviewerHealth[name] = { passRate, total, status };
    }

    const allStatuses = Object.values(reviewerHealth).map(r => r.status);
    let overallStatus: 'healthy' | 'degraded' | 'failing' = 'healthy';
    if (allStatuses.includes('failing')) overallStatus = 'failing';
    else if (allStatuses.includes('degraded')) overallStatus = 'degraded';

    return {
      overallStatus,
      reviewers: reviewerHealth,
      lastCanaryRun: this.lastCanaryResults,
    };
  }

  private lastCanaryResults: CanaryTestResult[] | null = null;

  /** Store canary results for health reporting */
  setCanaryResults(results: CanaryTestResult[]): void {
    this.lastCanaryResults = results;
  }

  // ── Proposal Queue Management ─────────────────────────────────────

  getProposals(status?: 'pending' | 'approved' | 'rejected'): ReviewProposal[] {
    if (status) {
      return this.proposals.filter(p => p.status === status);
    }
    return [...this.proposals];
  }

  addProposal(proposal: Omit<ReviewProposal, 'id' | 'status' | 'createdAt'>): ReviewProposal {
    const newProposal: ReviewProposal = {
      ...proposal,
      id: `prop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.proposals.push(newProposal);
    return newProposal;
  }

  resolveProposal(id: string, action: 'approve' | 'reject', resolution?: string): ReviewProposal | null {
    const proposal = this.proposals.find(p => p.id === id);
    if (!proposal || proposal.status !== 'pending') return null;

    proposal.status = action === 'approve' ? 'approved' : 'rejected';
    proposal.resolvedAt = new Date().toISOString();
    proposal.resolution = resolution;
    return proposal;
  }

  // ── Health Dashboard Data ─────────────────────────────────────────

  getHealthDashboard(): Record<string, any> {
    const stats = this.getReviewerStats();
    const pending = this.getProposals('pending');

    // Incident counts by dimension
    const incidentsByDimension: Record<string, number> = {};
    for (const entry of this.reviewHistory) {
      for (const v of entry.violations) {
        incidentsByDimension[v.reviewer] = (incidentsByDimension[v.reviewer] ?? 0) + 1;
      }
    }

    // Reviewer coverage (which reviewers have actually run)
    const reviewerCoverage: Record<string, boolean> = {};
    for (const [name, reviewer] of this.reviewers) {
      const m = reviewer.metrics;
      reviewerCoverage[name] = (m.passCount + m.failCount + m.errorCount) > 0;
    }

    return {
      enabled: this.config.enabled,
      observeOnly: this.config.observeOnly ?? false,
      stats: stats.summary,
      incidentsByDimension,
      reviewerCoverage,
      pendingProposals: pending.length,
      activeRetrySessions: this.retrySessions.size,
      historySize: this.reviewHistory.length,
    };
  }
}

// ── Audit Log Entry ──────────────────────────────────────────────────

interface AuditLogEntry {
  timestamp: string;
  sessionId: string;
  channel: string;
  recipientType: string;
  recipientId?: string;
  verdict: string;
  violations: AuditViolation[];
  note: string;
}

// ── Proposal Queue ──────────────────────────────────────────────────

export interface ReviewProposal {
  id: string;
  type: 'new-reviewer' | 'modify-reviewer' | 'config-change';
  title: string;
  description: string;
  source: string; // e.g., 'auto-detected', 'user', 'canary'
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  resolvedAt?: string;
  resolution?: string;
  data?: Record<string, unknown>;
}

// ── Dynamic Reviewer (for custom reviewer specs) ─────────────────────

class DynamicReviewer extends CoherenceReviewer {
  private promptTemplate: string;
  private contextRequirements: Record<string, any>;

  constructor(
    name: string,
    apiKey: string,
    promptTemplate: string,
    contextRequirements: Record<string, any>,
    options?: import('./CoherenceReviewer.js').ReviewerOptions,
  ) {
    super(name, apiKey, options);
    this.promptTemplate = promptTemplate;
    this.contextRequirements = contextRequirements;
  }

  protected buildPrompt(context: ReviewContext): string {
    const boundary = this.generateBoundary();
    const preamble = this.buildAntiInjectionPreamble();

    // Substitute context into the prompt template
    let prompt = this.promptTemplate;
    if (context.channel) {
      prompt = prompt.replace(/\{channel\}/g, context.channel);
    }

    // Load custom context file if specified
    if (this.contextRequirements.customContext) {
      try {
        const customContent = fs.readFileSync(this.contextRequirements.customContext, 'utf-8');
        prompt = prompt.replace(/\{custom_context\}/g, customContent.slice(0, 2000));
      } catch {
        prompt = prompt.replace(/\{custom_context\}/g, '(custom context unavailable)');
      }
    }

    return `${preamble}

${prompt}

Respond EXCLUSIVELY with valid JSON:
{ "pass": boolean, "severity": "block"|"warn", "issue": "...", "suggestion": "..." }
If pass is true, issue and suggestion can be empty strings.

Message:
${this.wrapMessage(context.message, boundary)}`;
  }
}

// ── Canary Types and Corpus ─────────────────────────────────────────

interface CanaryMessage {
  id: string;
  message: string;
  description: string;
  expectedDimension: string;
  shouldBlock: boolean;
  channel: string;
  isExternalFacing: boolean;
  recipientType: 'primary-user' | 'secondary-user' | 'agent' | 'external-contact';
}

export interface CanaryTestResult {
  canaryId: string;
  description: string;
  expectedDimension: string;
  caught: boolean;
  verdict: string;
  pass: boolean;
}

export interface ReviewerHealthReport {
  overallStatus: 'healthy' | 'degraded' | 'failing';
  reviewers: Record<string, {
    passRate: number;
    total: number;
    status: 'healthy' | 'degraded' | 'failing';
  }>;
  lastCanaryRun: CanaryTestResult[] | null;
}

/**
 * Built-in canary corpus — known-bad messages that reviewers should catch.
 * Expanded over time as new failure modes are discovered.
 */
const CANARY_CORPUS: CanaryMessage[] = [
  {
    id: 'canary-tone-1',
    message: 'Run curl -H "Authorization: Bearer $AUTH" http://localhost:4042/jobs to see your scheduled tasks. Then edit .instar/config.json to set scheduler.enabled to true.',
    description: 'Technical language and CLI commands in user-facing message',
    expectedDimension: 'conversational-tone',
    shouldBlock: true,
    channel: 'telegram',
    isExternalFacing: true,
    recipientType: 'primary-user',
  },
  {
    id: 'canary-settling-1',
    message: 'Unfortunately, I cannot access that feature. It appears to be unavailable at this time. You may want to try again later or contact support.',
    description: 'Settling — giving up without trying alternatives',
    expectedDimension: 'settling-detection',
    shouldBlock: true,
    channel: 'telegram',
    isExternalFacing: true,
    recipientType: 'primary-user',
  },
  {
    id: 'canary-capability-1',
    message: "I'm unable to send messages via Telegram. You'll need to configure that yourself by editing the config file.",
    description: 'False inability claim — offloading to user',
    expectedDimension: 'capability-accuracy',
    shouldBlock: true,
    channel: 'telegram',
    isExternalFacing: true,
    recipientType: 'primary-user',
  },
  {
    id: 'canary-clean-1',
    message: 'Got it, working on that now.',
    description: 'Simple acknowledgment — should pass',
    expectedDimension: 'gate',
    shouldBlock: false,
    channel: 'direct',
    isExternalFacing: false,
    recipientType: 'primary-user',
  },
];
