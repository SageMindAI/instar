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
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { StateManager } from './StateManager.js';

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

export class AutoDispatcher {
  private dispatches: DispatchManager;
  private executor: DispatchExecutor;
  private telegram: TelegramAdapter | null;
  private state: StateManager;
  private config: Required<AutoDispatcherConfig>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private stateFile: string;

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
   * One tick of the dispatch loop.
   */
  private async tick(): Promise<void> {
    if (this.isProcessing) {
      console.log('[AutoDispatcher] Skipping tick — already processing');
      return;
    }

    try {
      this.isProcessing = true;

      // Step 1: Poll for new dispatches
      const result = this.config.autoApplyPassive
        ? await this.dispatches.checkAndAutoApply()
        : await this.dispatches.check();

      this.lastPoll = new Date().toISOString();
      this.lastError = null;

      if (result.error) {
        this.lastError = result.error;
        this.saveState();
        return;
      }

      // Report passive auto-applications (conversational, not changelog)
      if (result.autoApplied && result.autoApplied > 0) {
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

      // Step 2: Process action and configuration dispatches
      if (this.config.autoExecuteActions) {
        const actionDispatches = result.dispatches.filter(
          d => (d.type === 'action' || d.type === 'configuration') && !d.applied
        );

        for (const dispatch of actionDispatches) {
          await this.executeDispatch(dispatch);
        }
      }

      // Step 3: Notify about any remaining unapplied dispatches
      const remaining = this.dispatches.pending();
      if (remaining.length > 0) {
        const securityDispatches = remaining.filter(d => d.type === 'security');
        if (securityDispatches.length > 0) {
          await this.notify(
            `Heads up — I received a security-related update that I'd like you to review before I apply it. ` +
            `Nothing urgent, just being careful.`
          );
        }
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
   * Execute a single action/configuration dispatch.
   */
  private async executeDispatch(dispatch: Dispatch): Promise<void> {
    console.log(`[AutoDispatcher] Executing dispatch: ${dispatch.title} (${dispatch.type})`);

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

      console.log(`[AutoDispatcher] Dispatch executed successfully: ${dispatch.title}`);
      await this.notify(
        `Just applied an improvement from Dawn: ${dispatch.title}. Everything went smoothly.`
      );
    } else {
      console.error(`[AutoDispatcher] Dispatch execution failed: ${result.message}`);

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
   * Prefers the dedicated Agent Updates topic (informational), falls back to Agent Attention.
   */
  private getNotificationTopicId(): number {
    return this.state.get<number>('agent-updates-topic')
      || this.state.get<number>('agent-attention-topic')
      || 0;
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
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}
