/**
 * Auto Dispatcher — built-in periodic dispatch polling and execution.
 *
 * Runs inside the server process (no Claude session needed for most
 * dispatches). Periodically polls the Portal API for new intelligence
 * dispatches, processes them based on type:
 *
 *   - lesson/strategy: Auto-applied to context file (passive)
 *   - configuration: Executed programmatically via DispatchExecutor
 *   - action: Executed programmatically or agentically via DispatchExecutor
 *   - behavioral: Applied to context file (passive)
 *   - security: Never auto-applied (requires agent review)
 *
 * This replaces the heavyweight prompt-based dispatch-check job.
 * Dispatches are the intelligent layer that complements npm updates —
 * they tell agents HOW to update themselves beyond just code changes.
 *
 * The full update cycle:
 *   1. Agent sends feedback (FeedbackManager)
 *   2. Dawn fixes the issue
 *   3. Dawn publishes npm update (code) + dispatch (instructions)
 *   4. AutoUpdater applies npm update
 *   5. AutoDispatcher applies dispatch instructions
 *   6. Agent is fully updated — code AND behavior
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DispatchManager, Dispatch } from './DispatchManager.js';
import type { DispatchExecutor, ExecutionResult } from './DispatchExecutor.js';
import type { DispatchScopeEnforcer } from './DispatchScopeEnforcer.js';
import type { AutonomyProfileManager } from './AutonomyProfileManager.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { StateManager } from './StateManager.js';
import type { DispatchDecisionJournal } from './DispatchDecisionJournal.js';
import type { ContextualEvaluator, ContextualEvaluation } from './ContextualEvaluator.js';
import type { ContextSnapshotBuilder } from './ContextSnapshotBuilder.js';
import type { RelevanceFilter } from './RelevanceFilter.js';
import type { DispatchVerifier } from './DispatchVerifier.js';
import type { DeferredDispatchTracker } from './DeferredDispatchTracker.js';
import type { AdaptationValidator } from './AdaptationValidator.js';

export interface AutoDispatcherConfig {
  /** How often to poll for dispatches, in minutes. Default: 30 */
  pollIntervalMinutes?: number;
  /** Whether to auto-apply safe dispatches (lesson, strategy). Default: true */
  autoApplyPassive?: boolean;
  /** Whether to auto-execute action/configuration dispatches. Default: true */
  autoExecuteActions?: boolean;
  /** Telegram topic ID for notifications (uses Agent Attention if not set) */
  notificationTopicId?: number;
}

export interface AutoDispatcherStatus {
  running: boolean;
  lastPoll: string | null;
  lastExecution: string | null;
  config: Required<AutoDispatcherConfig>;
  pendingDispatches: number;
  executedDispatches: number;
  lastError: string | null;
}

/**
 * Build a human-readable notification for dispatches that are waiting on the
 * user's approval. The old message was cryptic — just the count and IDs — so
 * users had no idea what they were approving. This version names each one in
 * plain language, shows a content preview, and tells the user how to respond.
 *
 * Exported for unit testing.
 */
export function formatApprovalNotification(dispatches: Dispatch[]): string {
  if (dispatches.length === 0) return '';

  const TYPE_LABEL: Record<string, string> = {
    behavioral: 'behavior guideline',
    security: 'security update',
    strategy: 'strategy note',
    lesson: 'lesson',
    action: 'action',
    configuration: 'configuration change',
  };

  const PREVIEW_LIMIT = 220;

  const describe = (d: Dispatch): string => {
    const label = TYPE_LABEL[d.type] || d.type;
    const raw = (d.content || '').trim().replace(/\s+/g, ' ');
    const preview = raw.length > PREVIEW_LIMIT
      ? `${raw.slice(0, PREVIEW_LIMIT).trimEnd()}…`
      : raw;
    const priorityNote = d.priority && d.priority !== 'normal' ? `, ${d.priority} priority` : '';
    return `• "${d.title}" — ${label}${priorityNote}\n  ${preview || '(no content)'}\n  ID: ${d.dispatchId}`;
  };

  const header = dispatches.length === 1
    ? `I have a new guideline waiting for your approval before I apply it:`
    : `I have ${dispatches.length} new guidelines waiting for your approval before I apply them:`;

  const items = dispatches.map(describe).join('\n\n');

  const footer = `Just tell me which ones to approve or reject and I'll handle it.`;

  return `${header}\n\n${items}\n\n${footer}`;
}

export class AutoDispatcher {
  private dispatches: DispatchManager;
  private executor: DispatchExecutor;
  private telegram: TelegramAdapter | null;
  private state: StateManager;
  private config: Required<AutoDispatcherConfig>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private stateFile: string;

  // Scope enforcement
  private scopeEnforcer: DispatchScopeEnforcer | null = null;
  private autonomyManager: AutonomyProfileManager | null = null;

  // Decision journal for dispatch integration tracking
  private decisionJournal: DispatchDecisionJournal | null = null;

  // Discernment layer components (Milestones 3-5)
  private contextualEvaluator: ContextualEvaluator | null = null;
  private snapshotBuilder: ContextSnapshotBuilder | null = null;
  private relevanceFilter: RelevanceFilter | null = null;
  private dispatchVerifier: DispatchVerifier | null = null;
  private deferredTracker: DeferredDispatchTracker | null = null;
  private adaptationValidator: AdaptationValidator | null = null;

  // Persisted state
  private lastPoll: string | null = null;
  private lastExecution: string | null = null;
  private executedCount = 0;
  private lastError: string | null = null;
  private isProcessing = false;

  constructor(
    dispatches: DispatchManager,
    executor: DispatchExecutor,
    state: StateManager,
    stateDir: string,
    config?: AutoDispatcherConfig,
    telegram?: TelegramAdapter | null,
  ) {
    this.dispatches = dispatches;
    this.executor = executor;
    this.state = state;
    this.telegram = telegram ?? null;
    this.stateFile = path.join(stateDir, 'state', 'auto-dispatcher.json');

    this.config = {
      pollIntervalMinutes: config?.pollIntervalMinutes ?? 30,
      autoApplyPassive: config?.autoApplyPassive ?? true,
      autoExecuteActions: config?.autoExecuteActions ?? true,
      notificationTopicId: config?.notificationTopicId ?? 0,
    };

    this.loadState();
  }

  /**
   * Start periodic dispatch polling.
   * Idempotent — calling start() when already running is a no-op.
   */
  start(): void {
    if (this.interval) return;

    const intervalMs = this.config.pollIntervalMinutes * 60 * 1000;
    console.log(
      `[AutoDispatcher] Started (every ${this.config.pollIntervalMinutes}m, ` +
      `passive: ${this.config.autoApplyPassive}, actions: ${this.config.autoExecuteActions})`
    );

    // First poll after a short delay
    setTimeout(() => this.tick(), 15_000);

    // Then poll periodically
    this.interval = setInterval(() => this.tick(), intervalMs);
    this.interval.unref();
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Get current status.
   */
  getStatus(): AutoDispatcherStatus {
    return {
      running: this.interval !== null,
      lastPoll: this.lastPoll,
      lastExecution: this.lastExecution,
      config: { ...this.config },
      pendingDispatches: this.dispatches.pending().length,
      executedDispatches: this.executedCount,
      lastError: this.lastError,
    };
  }

  /**
   * Set Telegram adapter (may be wired after construction).
   */
  setTelegram(telegram: TelegramAdapter): void {
    this.telegram = telegram;
  }

  /**
   * Wire the DispatchScopeEnforcer and AutonomyProfileManager.
   * When set, dispatch execution is gated by scope tier and autonomy profile.
   */
  setScopeEnforcer(enforcer: DispatchScopeEnforcer, manager: AutonomyProfileManager): void {
    this.scopeEnforcer = enforcer;
    this.autonomyManager = manager;
  }

  /**
   * Wire the DispatchDecisionJournal for dispatch integration tracking.
   */
  setDecisionJournal(journal: DispatchDecisionJournal): void {
    this.decisionJournal = journal;
  }

  /**
   * Wire the Discernment Layer components.
   * When set, dispatches go through verification → relevance filter → LLM evaluation
   * before being applied or executed.
   */
  setDiscernmentLayer(components: {
    evaluator: ContextualEvaluator;
    snapshotBuilder: ContextSnapshotBuilder;
    relevanceFilter?: RelevanceFilter;
    verifier?: DispatchVerifier;
    deferredTracker?: DeferredDispatchTracker;
    adaptationValidator?: AdaptationValidator;
  }): void {
    this.contextualEvaluator = components.evaluator;
    this.snapshotBuilder = components.snapshotBuilder;
    this.relevanceFilter = components.relevanceFilter ?? null;
    this.dispatchVerifier = components.verifier ?? null;
    this.deferredTracker = components.deferredTracker ?? null;
    this.adaptationValidator = components.adaptationValidator ?? null;
  }

  /**
   * One tick of the dispatch loop.
   */
  private async tick(): Promise<void> {
    if (this.isProcessing) {
      console.log('[AutoDispatcher] Skipping tick — already processing');
      return;
    }

    try {
      this.isProcessing = true;

      // When discernment layer is active, never auto-apply — evaluate first
      const useDiscernment = this.contextualEvaluator && this.snapshotBuilder;
      const result = (this.config.autoApplyPassive && !useDiscernment)
        ? await this.dispatches.checkAndAutoApply()
        : await this.dispatches.check();

      this.lastPoll = new Date().toISOString();
      this.lastError = null;

      if (result.error) {
        this.lastError = result.error;
        this.saveState();
        return;
      }

      // Log passive auto-applications to decision journal (only in non-discernment mode)
      if (result.autoApplied && result.autoApplied > 0) {
        for (const d of result.dispatches.filter(d => d.applied)) {
          this.logDispatchDecision(d, 'accept', {
            reasoning: `Auto-applied: ${d.type} dispatch with ${d.priority} priority`,
            applied: true,
            tags: ['auto-applied', 'passive'],
          });
        }

        console.log(`[AutoDispatcher] Auto-applied ${result.autoApplied} passive dispatch(es)`);
        const appliedTitles = result.dispatches
          .filter(d => d.applied)
          .map(d => d.title);
        const titleList = appliedTitles.length <= 2
          ? appliedTitles.join(' and ')
          : `${appliedTitles.length} improvements`;
        await this.notify(
          `I just picked up ${titleList} from Dawn. Already applied — no action needed on your end.`
        );
      }

      if (result.newCount === 0) {
        this.saveState();
        return;
      }

      console.log(`[AutoDispatcher] ${result.newCount} new dispatch(es) received`);

      // Route through discernment layer or legacy processing
      const unapplied = result.dispatches.filter(d => !d.applied);
      if (useDiscernment) {
        await this.processWithDiscernment(unapplied);
      } else {
        await this.processLegacy(unapplied);
      }

      this.saveState();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.saveState();
      console.error(`[AutoDispatcher] Tick error: ${this.lastError}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process dispatches through the full discernment pipeline:
   * verify → filter → LLM evaluate → apply/execute based on decision.
   */
  private async processWithDiscernment(dispatches: Dispatch[]): Promise<void> {
    const evaluator = this.contextualEvaluator!;
    const builder = this.snapshotBuilder!;
    const snapshot = builder.build();

    // Advance the deferred tracker poll counter
    if (this.deferredTracker) {
      this.deferredTracker.advancePoll();
    }

    // Collect already-evaluated dispatch IDs for idempotency
    const alreadyEvaluated = this.decisionJournal
      ? new Set(this.decisionJournal.query({}).map(e => e.dispatchId))
      : new Set<string>();

    const toEvaluate: Dispatch[] = [];

    for (const dispatch of dispatches) {
      // Step 1: Verify origin (if verifier is configured)
      if (this.dispatchVerifier) {
        const verification = this.dispatchVerifier.verify(dispatch);
        if (!verification.verified) {
          this.logDispatchDecision(dispatch, 'reject', {
            reasoning: `Verification failed: ${verification.reason}`,
            tags: ['verification-failed'],
          });
          console.log(`[AutoDispatcher] Dispatch rejected (verification): ${dispatch.title}`);
          continue;
        }
      }

      // Step 2: Relevance filter (if configured)
      if (this.relevanceFilter) {
        const relevance = this.relevanceFilter.check(dispatch, snapshot, alreadyEvaluated);
        if (!relevance.relevant) {
          this.logDispatchDecision(dispatch, 'reject', {
            reasoning: `Filtered out: ${relevance.reason}`,
            tags: ['filtered-out'],
            confidence: relevance.confidence,
          });
          console.log(`[AutoDispatcher] Dispatch filtered out: ${dispatch.title} (${relevance.reason})`);
          continue;
        }
      }

      toEvaluate.push(dispatch);
    }

    // Step 2b: Add deferred dispatches due for re-evaluation
    if (this.deferredTracker) {
      const dueForReeval = this.deferredTracker.getDueForReEvaluation();
      for (const deferred of dueForReeval) {
        // Don't double-add if already in the new batch
        if (!toEvaluate.some(d => d.dispatchId === deferred.dispatchId)) {
          toEvaluate.push(deferred.dispatch);
        }
      }
    }

    if (toEvaluate.length === 0) return;

    // Step 3: LLM contextual evaluation (batch when possible)
    let evaluations: ContextualEvaluation[];
    try {
      // Add jitter before evaluation to prevent broadcast spike overload
      const jitter = evaluator.getJitterDelay();
      await new Promise(resolve => setTimeout(resolve, jitter));

      evaluations = await evaluator.evaluateBatch(toEvaluate, snapshot);
    } catch (err) {
      // Evaluation system failed entirely — fall back to structural processing
      console.error(`[AutoDispatcher] Discernment evaluation failed, using legacy: ${err}`);
      await this.processLegacy(toEvaluate);
      return;
    }

    // Step 4: Act on evaluation decisions
    for (let i = 0; i < toEvaluate.length; i++) {
      const dispatch = toEvaluate[i];
      const evaluation = evaluations[i];

      this.logDispatchDecision(dispatch, evaluation.decision, {
        reasoning: evaluation.reasoning,
        evaluationMethod: 'contextual',
        promptVersion: evaluation.promptVersion,
        confidence: evaluation.confidenceScore,
        adaptationSummary: evaluation.adaptation,
        tags: ['discernment', `eval-${evaluation.evaluationMode}`],
      });

      if (evaluator.isDryRun) {
        console.log(`[AutoDispatcher] [DRY-RUN] ${dispatch.title}: ${evaluation.decision} (${evaluation.reasoning})`);
        continue;
      }

      switch (evaluation.decision) {
        case 'accept':
          // Remove from deferred queue if it was re-evaluated
          if (this.deferredTracker) this.deferredTracker.remove(dispatch.dispatchId);
          await this.applyAcceptedDispatch(dispatch);
          break;
        case 'adapt':
          if (this.deferredTracker) this.deferredTracker.remove(dispatch.dispatchId);
          await this.applyAdaptedDispatch(dispatch, evaluation);
          break;
        case 'defer':
          await this.handleDeferral(dispatch, evaluation);
          break;
        case 'reject':
          if (this.deferredTracker) this.deferredTracker.remove(dispatch.dispatchId);
          this.dispatches.evaluate(dispatch.dispatchId, 'rejected', evaluation.reasoning);
          console.log(`[AutoDispatcher] Rejected: ${dispatch.title} (${evaluation.reasoning})`);
          break;
      }
    }
  }

  /**
   * Handle a defer decision with bounded tracking.
   */
  private async handleDeferral(dispatch: Dispatch, evaluation: ContextualEvaluation): Promise<void> {
    if (!this.deferredTracker) {
      // No tracker — simple deferral
      this.dispatches.markPendingApproval(dispatch.dispatchId);
      console.log(`[AutoDispatcher] Deferred: ${dispatch.title} (${evaluation.deferCondition})`);
      return;
    }

    const result = this.deferredTracker.defer(
      dispatch,
      evaluation.deferCondition ?? 'Condition not specified',
      evaluation.reasoning,
    );

    switch (result.action) {
      case 'deferred':
        this.dispatches.markPendingApproval(dispatch.dispatchId);
        console.log(`[AutoDispatcher] Deferred: ${dispatch.title} (${result.reason})`);
        break;
      case 'auto-rejected':
        this.dispatches.evaluate(dispatch.dispatchId, 'rejected', result.reason);
        this.logDispatchDecision(dispatch, 'reject', {
          reasoning: result.reason,
          tags: ['auto-rejected', 'max-deferrals'],
        });
        console.log(`[AutoDispatcher] Auto-rejected (max deferrals): ${dispatch.title}`);
        await this.notify(
          `Dispatch "${dispatch.title}" was auto-rejected after reaching its deferral limit. ${result.reason}`
        );
        break;
      case 'overflow-rejected':
        this.dispatches.evaluate(dispatch.dispatchId, 'rejected', result.reason);
        this.logDispatchDecision(dispatch, 'reject', {
          reasoning: result.reason,
          tags: ['overflow-rejected'],
        });
        console.log(`[AutoDispatcher] Queue overflow — evicted: ${result.evictedDispatchId}`);
        break;
    }
  }

  /**
   * Apply an accepted dispatch (passive or action/config).
   */
  private async applyAcceptedDispatch(dispatch: Dispatch): Promise<void> {
    const PASSIVE_TYPES = new Set(['lesson', 'strategy', 'behavioral']);
    if (PASSIVE_TYPES.has(dispatch.type)) {
      // Auto-apply passive dispatches
      try {
        this.dispatches.evaluate(dispatch.dispatchId, 'accepted', 'Accepted by contextual evaluation');
        this.executedCount++;
        this.lastExecution = new Date().toISOString();
        console.log(`[AutoDispatcher] Accepted and applied: ${dispatch.title}`);
        await this.notify(
          `Applied "${dispatch.title}" after contextual evaluation. Integrated smoothly.`
        );
      } catch (err) {
        console.error(`[AutoDispatcher] Failed to apply accepted dispatch: ${err}`);
      }
    } else if (dispatch.type === 'action' || dispatch.type === 'configuration') {
      await this.executeDispatch(dispatch);
    } else {
      // Security or unknown type accepted by evaluator — still gate for approval
      this.dispatches.markPendingApproval(dispatch.dispatchId);
      await this.notify(
        `Contextual evaluation accepted "${dispatch.title}" (${dispatch.type}) but it still requires your sign-off.`
      );
    }
  }

  /**
   * Apply an adapted dispatch — uses the evaluator's modified content.
   * Post-adaptation scope enforcement prevents escalation via LLM adaptation.
   */
  private async applyAdaptedDispatch(dispatch: Dispatch, evaluation: ContextualEvaluation): Promise<void> {
    if (!evaluation.adaptation) {
      // No adaptation content — fall back to deferring
      this.dispatches.markPendingApproval(dispatch.dispatchId);
      return;
    }

    // Post-adaptation scope enforcement
    if (this.adaptationValidator) {
      const scopeCheck = this.adaptationValidator.validate(
        dispatch,
        evaluation.adaptation,
        this.scopeEnforcer,
        this.autonomyManager?.getResolvedState().profile,
      );

      if (!scopeCheck.withinScope) {
        // Adaptation introduced scope violations — reject the adaptation
        this.logDispatchDecision(dispatch, 'reject', {
          reasoning: `Adaptation scope violation: ${scopeCheck.violations.join('; ')}`,
          adaptationSummary: evaluation.adaptation,
          tags: ['adaptation-scope-violation', 'security-signal'],
        });
        this.dispatches.evaluate(dispatch.dispatchId, 'rejected', 'Adaptation exceeded scope');
        console.log(`[AutoDispatcher] Adaptation rejected (scope violation): ${dispatch.title}`);
        await this.notify(
          `Adaptation of "${dispatch.title}" was rejected — it introduced scope violations: ${scopeCheck.violations[0]}`
        );
        return;
      }

      if (scopeCheck.flagForReview) {
        // High drift or other concern — defer for human review
        this.logDispatchDecision(dispatch, 'defer', {
          reasoning: `Adaptation flagged for review: drift=${scopeCheck.driftScore.toFixed(2)}`,
          adaptationSummary: evaluation.adaptation,
          tags: ['adaptation-flagged', 'high-drift'],
        });
        this.dispatches.markPendingApproval(dispatch.dispatchId);
        console.log(`[AutoDispatcher] Adaptation flagged for review (drift ${scopeCheck.driftScore.toFixed(2)}): ${dispatch.title}`);
        await this.notify(
          `Adaptation of "${dispatch.title}" needs your review — semantic drift is ${(scopeCheck.driftScore * 100).toFixed(0)}%.`
        );
        return;
      }
    }

    // Create an adapted copy with modified content
    const adapted: Dispatch = {
      ...dispatch,
      content: evaluation.adaptation,
    };

    const PASSIVE_TYPES = new Set(['lesson', 'strategy', 'behavioral']);
    if (PASSIVE_TYPES.has(dispatch.type)) {
      this.dispatches.evaluate(dispatch.dispatchId, 'accepted', `Adapted: ${evaluation.reasoning}`);
      this.executedCount++;
      this.lastExecution = new Date().toISOString();
      console.log(`[AutoDispatcher] Adapted and applied: ${dispatch.title}`);
      await this.notify(
        `Applied an adapted version of "${dispatch.title}". ${evaluation.reasoning}`
      );
    } else if (dispatch.type === 'action' || dispatch.type === 'configuration') {
      await this.executeDispatch(adapted);
    } else {
      this.dispatches.markPendingApproval(dispatch.dispatchId);
    }
  }

  /**
   * Legacy dispatch processing (no discernment layer).
   */
  private async processLegacy(dispatches: Dispatch[]): Promise<void> {
    // Process action and configuration dispatches
    if (this.config.autoExecuteActions) {
      const actionDispatches = dispatches.filter(
        d => (d.type === 'action' || d.type === 'configuration') && !d.applied
      );

      for (const dispatch of actionDispatches) {
        await this.executeDispatch(dispatch);
      }
    }

    // Gate security and behavioral dispatches for human approval
    const APPROVAL_REQUIRED_TYPES: ReadonlySet<string> = new Set(['security', 'behavioral']);
    const needsApproval = dispatches.filter(
      d => APPROVAL_REQUIRED_TYPES.has(d.type) && !d.applied
    );
    if (needsApproval.length > 0) {
      for (const dispatch of needsApproval) {
        this.dispatches.markPendingApproval(dispatch.dispatchId);
        this.logDispatchDecision(dispatch, 'defer', {
          reasoning: `${dispatch.type} dispatch requires human approval`,
          tags: ['needs-approval', dispatch.type],
        });
      }

      await this.notify(formatApprovalNotification(needsApproval));
    }
  }

  /**
   * Execute a single action/configuration dispatch.
   */
  private async executeDispatch(dispatch: Dispatch): Promise<void> {
    console.log(`[AutoDispatcher] Executing dispatch: ${dispatch.title} (${dispatch.type})`);

    // Check scope enforcement before executing
    if (this.scopeEnforcer && this.autonomyManager) {
      const profile = this.autonomyManager.getResolvedState().profile;
      const scopeCheck = this.scopeEnforcer.checkScope(dispatch, profile);

      if (!scopeCheck.allowed) {
        console.log(`[AutoDispatcher] Dispatch blocked by scope enforcer: ${scopeCheck.reason}`);
        this.logDispatchDecision(dispatch, scopeCheck.requiresApproval ? 'defer' : 'reject', {
          reasoning: `Scope enforcer blocked: ${scopeCheck.reason}`,
          tags: ['scope-blocked'],
        });
        if (scopeCheck.requiresApproval) {
          this.dispatches.markPendingApproval(dispatch.dispatchId);
          await this.notify(
            `Dispatch "${dispatch.title}" (${dispatch.type}) requires approval — ` +
            `${scopeCheck.reason}. ID: ${dispatch.dispatchId}`
          );
        }
        return;
      }
    }

    // Try to parse as structured action
    const action = this.executor.parseAction(dispatch.content);

    if (!action) {
      // Not structured JSON — treat as agentic prompt
      console.log(`[AutoDispatcher] Dispatch is not structured — spawning agentic session`);
      const agenticAction = {
        description: dispatch.title,
        steps: [{ type: 'agentic' as const, prompt: dispatch.content }],
      };
      const result = await this.executor.execute(agenticAction);
      await this.recordResult(dispatch, result);
      return;
    }

    // Validate step scope if scope enforcer is available
    if (this.scopeEnforcer && this.autonomyManager) {
      const profile = this.autonomyManager.getResolvedState().profile;
      const tier = this.scopeEnforcer.getScopeTier(dispatch.type);
      const stepValidation = this.scopeEnforcer.validateSteps(action.steps, tier);

      if (!stepValidation.valid) {
        console.log(`[AutoDispatcher] Dispatch steps violate scope: ${stepValidation.violations.join('; ')}`);
        this.logDispatchDecision(dispatch, 'defer', {
          reasoning: `Step scope violation: ${stepValidation.violations.join('; ')}`,
          tags: ['scope-violation', 'needs-approval'],
        });
        this.dispatches.markPendingApproval(dispatch.dispatchId);
        await this.notify(
          `Dispatch "${dispatch.title}" has steps that violate its ${tier} scope: ` +
          `${stepValidation.violations[0]}. Queued for approval. ID: ${dispatch.dispatchId}`
        );
        return;
      }
    }

    // Execute structured action
    const result = await this.executor.execute(action);
    await this.recordResult(dispatch, result);
  }

  /**
   * Record the result of executing a dispatch.
   */
  private async recordResult(dispatch: Dispatch, result: ExecutionResult): Promise<void> {
    if (result.success) {
      this.dispatches.evaluate(dispatch.dispatchId, 'accepted', result.message);
      this.executedCount++;
      this.lastExecution = new Date().toISOString();

      this.logDispatchDecision(dispatch, 'accept', {
        reasoning: `Auto-executed successfully: ${result.message}`,
        applied: true,
        tags: ['auto-executed'],
      });

      console.log(`[AutoDispatcher] Dispatch executed successfully: ${dispatch.title}`);
      await this.notify(
        `Just applied an improvement from Dawn: ${dispatch.title}. Everything went smoothly.`
      );
    } else {
      console.error(`[AutoDispatcher] Dispatch execution failed: ${result.message}`);

      this.logDispatchDecision(dispatch, 'defer', {
        reasoning: `Auto-execution failed: ${result.message}`,
        applied: false,
        applicationError: result.message,
        tags: ['execution-failed', result.rolledBack ? 'rolled-back' : 'manual-needed'],
      });

      // Don't reject — mark as deferred so it can be retried
      this.dispatches.evaluate(
        dispatch.dispatchId,
        'deferred',
        `Auto-execution failed: ${result.message}. ${result.rolledBack ? 'Rolled back.' : 'Manual intervention may be needed.'}`
      );

      await this.notify(
        `I tried to apply an update (${dispatch.title}) but ran into an issue. ` +
        (result.rolledBack ? `I've rolled it back so nothing's affected. ` : '') +
        `I'll try again later.`
      );
    }
  }

  /**
   * Send notification via Telegram.
   */
  private async notify(message: string): Promise<void> {
    const formatted = message;

    if (this.telegram) {
      try {
        const topicId = this.config.notificationTopicId || this.getNotificationTopicId();
        if (topicId) {
          await this.telegram.sendToTopic(topicId, formatted);
          return;
        }
      } catch (err) {
        console.error(`[AutoDispatcher] Telegram notification failed: ${err}`);
      }
    }

    console.log(`[AutoDispatcher] Notification: ${message}`);
  }

  /**
   * Get the topic ID for dispatch notifications.
   *
   * Dispatch announcements are routed exclusively to the dedicated Agent Updates
   * topic. If it is not configured, notify() drops to console — we never fall
   * back to Attention or any other topic. Matches /telegram/post-update contract.
   */
  private getNotificationTopicId(): number {
    return this.state.get<number>('agent-updates-topic') || 0;
  }

  // ── Decision journal helpers ────────────────────────────────────────

  /**
   * Log a dispatch integration decision to the decision journal.
   */
  private logDispatchDecision(
    dispatch: Dispatch,
    dispatchDecision: 'accept' | 'adapt' | 'defer' | 'reject',
    extras: {
      reasoning: string;
      evaluationMethod?: 'structural' | 'contextual';
      promptVersion?: string;
      confidence?: number;
      adaptationSummary?: string;
      applied?: boolean;
      applicationError?: string;
      tags?: string[];
    },
  ): void {
    if (!this.decisionJournal) return;

    try {
      this.decisionJournal.logDispatchDecision({
        sessionId: '',
        dispatchId: dispatch.dispatchId,
        dispatchType: dispatch.type,
        dispatchPriority: dispatch.priority,
        dispatchDecision,
        reasoning: extras.reasoning,
        evaluationMethod: extras.evaluationMethod ?? 'structural',
        promptVersion: extras.promptVersion,
        adaptationSummary: extras.adaptationSummary,
        applied: extras.applied,
        applicationError: extras.applicationError,
        tags: extras.tags,
        confidence: extras.confidence,
        context: `title: ${dispatch.title}`,
      });
    } catch (err) {
      // Never let journal logging failures disrupt dispatch processing
      console.error(`[AutoDispatcher] Decision journal logging failed: ${err}`);
    }
  }

  // ── State persistence ──────────────────────────────────────────────

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
        this.lastPoll = data.lastPoll ?? null;
        this.lastExecution = data.lastExecution ?? null;
        this.executedCount = data.executedCount ?? 0;
        this.lastError = data.lastError ?? null;
      }
    } catch {
      // Start fresh
    }
  }

  private saveState(): void {
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true });

    const data = {
      lastPoll: this.lastPoll,
      lastExecution: this.lastExecution,
      executedCount: this.executedCount,
      lastError: this.lastError,
      savedAt: new Date().toISOString(),
    };

    const tmpPath = this.stateFile + `.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, this.stateFile);
    } catch {
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}
