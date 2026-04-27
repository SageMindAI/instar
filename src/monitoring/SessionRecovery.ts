/**
 * SessionRecovery — Mechanical session crash/stall recovery via JSONL analysis.
 *
 * A fast, deterministic layer that runs BEFORE the LLM-powered TriageOrchestrator.
 * Detects three failure modes without any LLM calls:
 * 1. Tool call stalls (process alive but frozen mid-tool)
 * 2. Crashes (process dead with incomplete JSONL)
 * 3. Error loops (same error repeated 3+ times)
 *
 * Recovery strategy: truncate JSONL to safe point + respawn with recovery prompt.
 * Escalation ladder: last_exchange → last_successful_tool → n_exchanges_back → alert human.
 *
 * Self-contained — no Dawn dependencies. Uses only:
 * - stall-detector.ts (pure function)
 * - crash-detector.ts (pure function)
 * - jsonl-truncator.ts (pure function)
 *
 * Part of PROP-session-stall-recovery (Instar integration)
 */

import { EventEmitter } from 'events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';

import { detectToolCallStall, type StallInfo } from './stall-detector.js';
import { detectCrashedSession, detectErrorLoop, type CrashInfo, type ErrorLoopInfo } from './crash-detector.js';
import { truncateJsonlToSafePoint, type TruncationStrategy } from './jsonl-truncator.js';
import { detectContextExhaustion } from './QuotaExhaustionDetector.js';

// ============================================================================
// Types
// ============================================================================

export interface SessionRecoveryConfig {
  enabled: boolean;
  /** Max recovery attempts per session before alerting human */
  maxAttempts: number;
  /** Cooldown between recovery attempts (ms) */
  cooldownMs: number;
  /** Project directory (used to find JSONL files) */
  projectDir: string;
}

export interface RecoveryAttempt {
  lastAttempt: number;
  count: number;
}

export interface RecoveryResult {
  recovered: boolean;
  failureType: 'stall' | 'crash' | 'error_loop' | 'context_exhaustion' | null;
  strategy?: TruncationStrategy;
  attemptNumber?: number;
  message: string;
}

export interface SessionRecoveryDeps {
  /** Check if a tmux session's Claude process is alive */
  isSessionAlive: (sessionName: string) => boolean;
  /** Get the PID of the pane in a tmux session */
  getPanePid?: (sessionName: string) => number | null;
  /** Kill a tmux session */
  killSession: (sessionName: string) => void;
  /** Respawn a session for a topic, optionally with a recovery prompt */
  respawnSession: (topicId: number, sessionName?: string, recoveryPrompt?: string) => Promise<void>;
  /** Send a message to a topic */
  sendToTopic?: (topicId: number, message: string) => Promise<void>;
  /** Capture tmux output for a session (needed for context exhaustion detection) */
  captureSessionOutput?: (sessionName: string, lines: number) => string | null;
  /** Respawn a session fresh (no --resume) for context exhaustion recovery */
  respawnSessionFresh?: (topicId: number, sessionName?: string, recoveryPrompt?: string) => Promise<void>;
  /**
   * Get recent messages for a topic (used by context-exhaustion recovery to
   * capture any in-flight agent reply that lands between detection and respawn,
   * so the fresh session can avoid duplicating it).
   */
  getRecentTopicMessages?: (topicId: number, limit: number) => Array<{
    text: string;
    fromUser: boolean;
    timestamp: string | number | Date;
  }>;
}

// ============================================================================
// SessionRecovery Class
// ============================================================================

export class SessionRecovery extends EventEmitter {
  private config: SessionRecoveryConfig;
  private deps: SessionRecoveryDeps;
  private recoveryAttempts: Map<string, RecoveryAttempt> = new Map();
  private stateFilePath: string;

  constructor(config: Partial<SessionRecoveryConfig>, deps: SessionRecoveryDeps) {
    super();
    this.config = {
      enabled: config.enabled ?? true,
      maxAttempts: config.maxAttempts ?? 3,
      cooldownMs: config.cooldownMs ?? 15 * 60 * 1000,
      projectDir: config.projectDir || process.cwd(),
    };
    this.deps = deps;
    this.stateFilePath = path.join(this.config.projectDir, '.instar', 'recovery-state.json');
    this.loadState();
  }

  /**
   * Check a session for mechanical failures and attempt recovery.
   * Should be called from SessionMonitor.checkSession() before LLM triage.
   *
   * @returns RecoveryResult — if recovered is true, caller should skip LLM triage
   */
  async checkAndRecover(
    topicId: number,
    sessionName: string,
  ): Promise<RecoveryResult> {
    if (!this.config.enabled) {
      return { recovered: false, failureType: null, message: 'Recovery disabled' };
    }

    const processAlive = this.deps.isSessionAlive(sessionName);

    // 1. Check for context exhaustion (process alive but conversation too long)
    // This runs FIRST and doesn't need JSONL — it scans tmux output directly.
    // A session at the "conversation too long" prompt is alive and not stalled,
    // it just can't accept any more input without hitting the same error.
    if (processAlive && this.deps.captureSessionOutput) {
      const tmuxOutput = this.deps.captureSessionOutput(sessionName, 50);
      if (tmuxOutput) {
        const contextCheck = detectContextExhaustion(tmuxOutput);
        if (contextCheck.matched) {
          const result = await this.recoverFromContextExhaustion(topicId, sessionName, contextCheck.pattern || 'unknown');
          this.logEvent(result, topicId, sessionName);
          return result;
        }
      }
    }

    // 2. Find the JSONL file for this session (needed for stall/crash/error-loop detection)
    const jsonlPath = this.findJsonlForSession(sessionName);
    if (!jsonlPath) {
      return { recovered: false, failureType: null, message: 'No JSONL found' };
    }

    // 3. Check for stall (process alive but frozen)
    if (processAlive) {
      const stall = detectToolCallStall(jsonlPath);
      if (stall) {
        const result = await this.recoverFromStall(topicId, sessionName, stall);
        this.logEvent(result, topicId, sessionName);
        return result;
      }
    }

    // 4. Check for error loop (can happen with alive OR dead process)
    const errorLoop = detectErrorLoop(jsonlPath);
    if (errorLoop) {
      const result = await this.recoverFromErrorLoop(topicId, sessionName, jsonlPath, errorLoop);
      this.logEvent(result, topicId, sessionName);
      return result;
    }

    // 5. Check for crash (process dead with incomplete state)
    if (!processAlive) {
      const crash = detectCrashedSession(jsonlPath, false);
      if (crash) {
        const result = await this.recoverFromCrash(topicId, sessionName, jsonlPath, crash);
        this.logEvent(result, topicId, sessionName);
        return result;
      }
    }

    return { recovered: false, failureType: null, message: 'No mechanical failure detected' };
  }

  /**
   * Log a recovery event to the JSONL event log for observability.
   */
  logEvent(result: RecoveryResult, topicId: number, sessionName: string): void {
    const eventLogPath = path.join(this.config.projectDir, '.instar', 'recovery-events.jsonl');
    const entry = {
      timestamp: new Date().toISOString(),
      failureType: result.failureType,
      recovered: result.recovered,
      topicId,
      sessionName,
      attempt: result.attemptNumber ?? 1,
    };
    try {
      const dir = path.dirname(eventLogPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(eventLogPath, JSON.stringify(entry) + '\n');
    } catch { // @silent-fallback-ok — event logging is best-effort observability
      // Can't write — skip
    }
  }

  /**
   * Aggregate recovery stats from the event log since a given timestamp.
   */
  getStats(sinceMs: number): {
    attempts: { stall: number; crash: number; errorLoop: number; contextExhaustion: number };
    successes: { stall: number; crash: number; errorLoop: number; contextExhaustion: number };
  } {
    const stats = {
      attempts: { stall: 0, crash: 0, errorLoop: 0, contextExhaustion: 0 },
      successes: { stall: 0, crash: 0, errorLoop: 0, contextExhaustion: 0 },
    };

    const eventLogPath = path.join(this.config.projectDir, '.instar', 'recovery-events.jsonl');
    if (!fs.existsSync(eventLogPath)) return stats;

    try {
      const lines = fs.readFileSync(eventLogPath, 'utf-8').trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const entry = JSON.parse(line);
        const ts = new Date(entry.timestamp).getTime();
        if (ts < sinceMs) continue;

        const key = entry.failureType === 'error_loop' ? 'errorLoop'
          : entry.failureType === 'stall' ? 'stall'
          : entry.failureType === 'crash' ? 'crash'
          : entry.failureType === 'context_exhaustion' ? 'contextExhaustion'
          : null;
        if (!key) continue;

        stats.attempts[key]++;
        if (entry.recovered) stats.successes[key]++;
      }
    } catch { // @silent-fallback-ok — corrupt log returns empty stats
      // Can't read — return zeros
    }

    return stats;
  }

  // ============================================================================
  // Recovery Methods
  // ============================================================================

  private async recoverFromStall(
    topicId: number,
    sessionName: string,
    stall: StallInfo,
  ): Promise<RecoveryResult> {
    const key = `stall:${stall.sessionUuid || sessionName}`;

    if (!this.shouldAttempt(key)) {
      return {
        recovered: false,
        failureType: 'stall',
        message: `Stall recovery exhausted or in cooldown for ${sessionName}`,
      };
    }

    const attemptNumber = this.recordAttempt(key);

    this.emit('recovery:stall', { topicId, sessionName, stall, attemptNumber });

    // Kill and respawn (stalls don't need truncation — just resume)
    this.deps.killSession(sessionName);

    await new Promise(resolve => setTimeout(resolve, 3000));

    const recoveryPrompt = this.buildStallRecoveryPrompt(stall);

    try {
      await this.deps.respawnSession(topicId, sessionName, recoveryPrompt);
      return {
        recovered: true,
        failureType: 'stall',
        attemptNumber,
        message: `Recovered from stall (${stall.lastToolName}, attempt ${attemptNumber})`,
      };
    } catch (err: any) { // @silent-fallback-ok — recovery code; returning recovered:false IS the degradation signal
      return {
        recovered: false,
        failureType: 'stall',
        attemptNumber,
        message: `Stall recovery respawn failed: ${err.message}`,
      };
    }
  }

  /**
   * Recover from context exhaustion ("conversation too long").
   *
   * Unlike stall/crash recovery which truncates the JSONL and resumes,
   * context exhaustion means the ENTIRE conversation is too large.
   * Recovery strategy: kill the session and respawn FRESH with telegram
   * history as the context seed. No --resume, no JSONL reuse.
   */
  private async recoverFromContextExhaustion(
    topicId: number,
    sessionName: string,
    matchedPattern: string,
  ): Promise<RecoveryResult> {
    const key = `context:${sessionName}`;

    if (!this.shouldAttempt(key)) {
      return {
        recovered: false,
        failureType: 'context_exhaustion',
        message: `Context exhaustion recovery exhausted or in cooldown for ${sessionName}`,
      };
    }

    const attemptNumber = this.recordAttempt(key);

    this.emit('recovery:context_exhaustion', { topicId, sessionName, matchedPattern, attemptNumber });

    // Record detection moment so we can identify any in-flight agent reply that
    // lands AFTER this point — the dying session may have generated a reply that
    // hasn't been written to topic history yet at respawn time.
    const detectedAt = Date.now();

    // Kill the session — it's stuck at the "conversation too long" prompt
    this.deps.killSession(sessionName);

    // Grace period: poll topic history for any in-flight agent reply from the
    // dying session. If one lands, capture its text so the fresh session can
    // avoid duplicating it. The previous 3s static sleep left a race window
    // where a reply landing at T+4s would never be known to the fresh session.
    const inFlightReply = await this.waitForInFlightReply(topicId, detectedAt);

    const baseRecoveryPrompt =
      `[RECOVERY] Your previous session hit the context window limit — the conversation became too long ` +
      `for Claude to process. The session was killed and restarted FRESH with thread history. ` +
      `You are NOT resuming the old conversation — this is a clean start with the recent message history ` +
      `loaded as context. Continue helping the user from where the conversation left off.`;

    const recoveryPrompt = sanitizeForPrompt(
      inFlightReply
        ? `${baseRecoveryPrompt}\n\n` +
          `IMPORTANT: Your previous session had ALREADY SENT this reply to the user before it was restarted — ` +
          `do NOT repeat any part of it. Acknowledge the restart to the user, then continue from where the reply left off:\n\n` +
          `<previous_reply>\n${inFlightReply}\n</previous_reply>`
        : baseRecoveryPrompt
    );

    // Use respawnSessionFresh if available (no --resume), otherwise fall back to normal respawn
    const respawnFn = this.deps.respawnSessionFresh || this.deps.respawnSession;

    try {
      await respawnFn(topicId, sessionName, recoveryPrompt);
      return {
        recovered: true,
        failureType: 'context_exhaustion',
        attemptNumber,
        message: inFlightReply
          ? `Recovered from context exhaustion with in-flight reply captured (pattern: "${matchedPattern}", attempt ${attemptNumber}) — fresh session knows what was already sent`
          : `Recovered from context exhaustion (pattern: "${matchedPattern}", attempt ${attemptNumber}) — fresh session spawned`,
      };
    } catch (err: any) { // @silent-fallback-ok — recovery code; returning recovered:false IS the degradation signal
      return {
        recovered: false,
        failureType: 'context_exhaustion',
        attemptNumber,
        message: `Context exhaustion recovery respawn failed: ${err.message}`,
      };
    }
  }

  /**
   * After a context-exhausted session is killed, an in-flight reply it was
   * generating may still land in topic history a few seconds later. This
   * helper polls history for a new agent message with a timestamp after
   * detection, returning its text if found (or null if nothing landed in
   * the grace window).
   *
   * Purpose: pass the captured reply into the recovery prompt so the fresh
   * session does not re-answer a question the dying session already answered.
   * Without this, the fresh session's bootstrap snapshot is a view of history
   * that predates the dying reply, and the fresh session duplicates output.
   *
   * Grace window: 7s. Empirically, in-flight replies land 2-6s after detection;
   * 7s covers the common case without adding much latency when nothing arrives.
   * Breaks early the moment a reply is seen.
   */
  private async waitForInFlightReply(topicId: number, detectedAt: number): Promise<string | null> {
    if (!this.deps.getRecentTopicMessages) {
      // No topic-history source — fall back to the legacy 3s static delay
      // to preserve previous behavior and give the kill + filesystem time to settle.
      await new Promise(resolve => setTimeout(resolve, 3000));
      return null;
    }

    const graceMs = 7000;
    const pollMs = 500;
    const start = Date.now();
    while (Date.now() - start < graceMs) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      try {
        const recent = this.deps.getRecentTopicMessages(topicId, 5);
        for (const m of recent) {
          const ts = new Date(m.timestamp).getTime();
          if (!m.fromUser && ts > detectedAt && m.text && m.text.trim().length > 0) {
            return m.text;
          }
        }
      } catch { /* best effort — continue polling */ }
    }
    return null;
  }

  private async recoverFromCrash(
    topicId: number,
    sessionName: string,
    jsonlPath: string,
    crash: CrashInfo,
  ): Promise<RecoveryResult> {
    const key = `crash:${crash.sessionUuid || sessionName}`;

    if (!this.shouldAttempt(key)) {
      return {
        recovered: false,
        failureType: 'crash',
        message: `Crash recovery exhausted or in cooldown for ${sessionName}`,
      };
    }

    const attemptNumber = this.recordAttempt(key);
    const strategy = this.pickTruncationStrategy(attemptNumber);

    this.emit('recovery:crash', { topicId, sessionName, crash, attemptNumber, strategy });

    // Truncate JSONL
    try {
      truncateJsonlToSafePoint(jsonlPath, strategy, strategy === 'n_exchanges_back' ? 3 : undefined);
    } catch (err: any) { // @silent-fallback-ok — recovery code; returning recovered:false IS the degradation signal
      return {
        recovered: false,
        failureType: 'crash',
        strategy,
        attemptNumber,
        message: `JSONL truncation failed: ${err.message}`,
      };
    }

    // Kill (might already be dead) and respawn
    this.deps.killSession(sessionName);
    await new Promise(resolve => setTimeout(resolve, 3000));

    const recoveryPrompt = this.buildCrashRecoveryPrompt(crash, strategy);

    try {
      await this.deps.respawnSession(topicId, sessionName, recoveryPrompt);
      return {
        recovered: true,
        failureType: 'crash',
        strategy,
        attemptNumber,
        message: `Recovered from crash (${strategy}, attempt ${attemptNumber})`,
      };
    } catch (err: any) { // @silent-fallback-ok — recovery code; returning recovered:false IS the degradation signal
      return {
        recovered: false,
        failureType: 'crash',
        strategy,
        attemptNumber,
        message: `Crash recovery respawn failed: ${err.message}`,
      };
    }
  }

  private async recoverFromErrorLoop(
    topicId: number,
    sessionName: string,
    jsonlPath: string,
    loop: ErrorLoopInfo,
  ): Promise<RecoveryResult> {
    const key = `loop:${loop.sessionUuid || sessionName}`;

    if (!this.shouldAttempt(key)) {
      return {
        recovered: false,
        failureType: 'error_loop',
        message: `Error loop recovery exhausted or in cooldown for ${sessionName}`,
      };
    }

    const attemptNumber = this.recordAttempt(key);
    // Error loops need more aggressive truncation
    const strategy: TruncationStrategy = attemptNumber <= 1 ? 'last_exchange' : 'last_successful_tool';

    this.emit('recovery:error_loop', { topicId, sessionName, loop, attemptNumber, strategy });

    // Truncate JSONL
    try {
      truncateJsonlToSafePoint(jsonlPath, strategy);
    } catch (err: any) { // @silent-fallback-ok — recovery code; returning recovered:false IS the degradation signal
      return {
        recovered: false,
        failureType: 'error_loop',
        strategy,
        attemptNumber,
        message: `JSONL truncation failed: ${err.message}`,
      };
    }

    // Kill and respawn
    this.deps.killSession(sessionName);
    await new Promise(resolve => setTimeout(resolve, 3000));

    const recoveryPrompt = this.buildErrorLoopRecoveryPrompt(loop, strategy);

    try {
      await this.deps.respawnSession(topicId, sessionName, recoveryPrompt);
      return {
        recovered: true,
        failureType: 'error_loop',
        strategy,
        attemptNumber,
        message: `Recovered from error loop (${loop.loopCount}x "${loop.failingPattern.slice(0, 50)}", attempt ${attemptNumber})`,
      };
    } catch (err: any) { // @silent-fallback-ok — recovery code; returning recovered:false IS the degradation signal
      return {
        recovered: false,
        failureType: 'error_loop',
        strategy,
        attemptNumber,
        message: `Error loop recovery respawn failed: ${err.message}`,
      };
    }
  }

  // ============================================================================
  // Recovery Prompt Builders
  // ============================================================================

  private buildStallRecoveryPrompt(stall: StallInfo): string {
    return sanitizeForPrompt(
      `[RECOVERY] Your previous session stalled while running tool "${stall.lastToolName}" ` +
      `(stalled for ${Math.round(stall.stallDurationMs / 1000)}s). ` +
      `The session was automatically restarted. ` +
      `Continue where you left off — the tool call that stalled has been discarded.`
    );
  }

  private buildCrashRecoveryPrompt(crash: CrashInfo, strategy: TruncationStrategy): string {
    const errorDetail = crash.errorMessage
      ? ` Error: "${crash.errorMessage.slice(0, 200)}"`
      : crash.lastToolName
        ? ` Last tool: "${crash.lastToolName}"`
        : '';
    return sanitizeForPrompt(
      `[RECOVERY] Your previous session crashed (${crash.errorType}).${errorDetail} ` +
      `The conversation was rewound using strategy "${strategy}" and the session was restarted. ` +
      `Some recent messages may be missing. Continue where you left off — avoid repeating ` +
      `the action that caused the crash.`
    );
  }

  private buildErrorLoopRecoveryPrompt(loop: ErrorLoopInfo, strategy: TruncationStrategy): string {
    return sanitizeForPrompt(
      `[RECOVERY] Your previous session was stuck in an error loop — ` +
      `the same error repeated ${loop.loopCount} times: "${loop.failingPattern.slice(0, 100)}". ` +
      (loop.failingCommand ? `Failing command: "${loop.failingCommand.slice(0, 100)}". ` : '') +
      `The conversation was rewound using strategy "${strategy}" and the session was restarted. ` +
      `Try a DIFFERENT approach — the previous one kept failing.`
    );
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private pickTruncationStrategy(attemptNumber: number): TruncationStrategy {
    if (attemptNumber <= 1) return 'last_exchange';
    if (attemptNumber <= 2) return 'last_successful_tool';
    return 'n_exchanges_back';
  }

  private shouldAttempt(key: string): boolean {
    const prior = this.recoveryAttempts.get(key);
    if (!prior) return true;
    if (Date.now() - prior.lastAttempt < this.config.cooldownMs) return false;
    if (prior.count >= this.config.maxAttempts) return false;
    return true;
  }

  private recordAttempt(key: string): number {
    const prior = this.recoveryAttempts.get(key);
    const count = (prior?.count || 0) + 1;
    this.recoveryAttempts.set(key, { lastAttempt: Date.now(), count });
    this.saveState();
    return count;
  }

  /**
   * Load recovery state from disk. Prevents infinite kill-respawn loops
   * across dawn-server restarts by preserving attempt counts and cooldowns.
   */
  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf-8'));
        if (data.attempts && typeof data.attempts === 'object') {
          for (const [key, value] of Object.entries(data.attempts)) {
            const attempt = value as RecoveryAttempt;
            if (attempt.lastAttempt && attempt.count) {
              this.recoveryAttempts.set(key, attempt);
            }
          }
        }
      }
    } catch { // @silent-fallback-ok — corrupt state file means fresh start, which is safe
      // Can't load — start fresh (safe default)
    }
  }

  /**
   * Persist recovery state to disk so it survives process restarts.
   */
  private saveState(): void {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data: Record<string, RecoveryAttempt> = {};
      // Only persist entries less than 1 hour old
      const ONE_HOUR = 60 * 60 * 1000;
      for (const [key, entry] of Array.from(this.recoveryAttempts.entries())) {
        if (Date.now() - entry.lastAttempt < ONE_HOUR) {
          data[key] = entry;
        }
      }

      fs.writeFileSync(this.stateFilePath, JSON.stringify({ attempts: data }, null, 2));
    } catch { // @silent-fallback-ok — state persistence is best-effort; in-memory state still works
      // Can't save — in-memory state still works for this process lifetime
    }
  }

  /**
   * Find the JSONL file for a session using lsof (Strategy 1) with NO fallback.
   *
   * Previous implementation fell back to most-recently-modified JSONL which
   * could match a DIFFERENT healthy session, leading to cross-session corruption
   * during truncation. Now returns null if lsof can't identify the file —
   * better to skip recovery than corrupt the wrong session.
   */
  private findJsonlForSession(sessionName: string): string | null {
    const projectDir = this.config.projectDir;
    const projectHash = projectDir.replace(/[\/\.]/g, '-');
    const projectJsonlDir = path.join(os.homedir(), '.claude', 'projects', projectHash);

    if (!fs.existsSync(projectJsonlDir)) return null;

    // Strategy 1: Use lsof to find the JSONL file held open by the session's process
    if (this.deps.getPanePid) {
      const pid = this.deps.getPanePid(sessionName);
      if (pid) {
        try {
          const output = execFileSync('lsof', ['-p', String(pid), '-Fn'], {
            encoding: 'utf-8',
            timeout: 5000,
          });
          // Look for .jsonl files in the output
          for (const line of output.split('\n')) {
            if (line.startsWith('n') && line.endsWith('.jsonl')) {
              const filePath = line.slice(1); // Remove 'n' prefix
              if (filePath.startsWith(projectJsonlDir) && fs.existsSync(filePath)) {
                return filePath;
              }
            }
          }
        } catch { // @silent-fallback-ok — lsof failure is expected on some platforms; null return triggers skip-recovery path
          // lsof failed — fall through to null (do NOT fallback to mtime-based)
        }
      }
    }

    // Strategy 2 (removed): Most-recently-modified JSONL was unsafe — could match
    // a concurrent healthy session, leading to cross-session corruption during truncation.
    // If lsof fails, we skip recovery rather than risk corrupting the wrong session.

    return null;
  }

  /**
   * Clean up old recovery tracking entries and stale .bak files.
   */
  cleanup(): void {
    const ONE_HOUR = 60 * 60 * 1000;
    for (const [key, entry] of Array.from(this.recoveryAttempts.entries())) {
      if (Date.now() - entry.lastAttempt > ONE_HOUR) {
        this.recoveryAttempts.delete(key);
      }
    }

    // Clean up .bak files older than 24 hours
    this.cleanupBackupFiles();
  }

  /**
   * Remove .bak.* files older than maxAge from the Claude projects JSONL directory.
   * Each recovery creates a full backup — without cleanup these accumulate indefinitely,
   * consuming disk and retaining sensitive conversation data.
   */
  private cleanupBackupFiles(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const projectDir = this.config.projectDir;
    const projectHash = projectDir.replace(/[\/\.]/g, '-');
    const projectJsonlDir = path.join(os.homedir(), '.claude', 'projects', projectHash);

    if (!fs.existsSync(projectJsonlDir)) return;

    try {
      const files = fs.readdirSync(projectJsonlDir);
      const now = Date.now();
      let cleaned = 0;

      for (const file of files) {
        if (!file.includes('.bak.')) continue;

        const filePath = path.join(projectJsonlDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAgeMs) {
            // safe-git-allow: incremental-migration
            fs.unlinkSync(filePath);
            cleaned++;
          }
        } catch { // @silent-fallback-ok — best-effort cleanup; skipping one file is fine
          // Skip files we can't stat/delete
        }
      }

      if (cleaned > 0) {
        this.emit('cleanup:backups', { cleaned, directory: projectJsonlDir });
      }
    } catch { // @silent-fallback-ok — best-effort cleanup; directory read failure is non-critical
      // Can't read directory — skip cleanup
    }
  }
}

// ============================================================================
// Standalone Utilities
// ============================================================================

/**
 * Sanitize text for injection into a recovery prompt.
 * Strips control characters, Unicode directional overrides, and truncates.
 */
export function sanitizeForPrompt(text: string, maxLength: number = 2000): string {
  return text
    // Strip Unicode directional overrides and invisible characters (CVE-class attack vector)
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g, '')
    // Strip ASCII control characters (except newlines and tabs)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Normalize Unicode to NFC
    .normalize('NFC')
    // Truncate
    .slice(0, maxLength);
}
