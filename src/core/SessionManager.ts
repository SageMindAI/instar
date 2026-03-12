/**
 * Session Manager — spawn and monitor Claude Code sessions via tmux.
 *
 * This is the core capability that transforms Claude Code from a CLI tool
 * into a persistent agent. Sessions run in tmux, survive terminal disconnects,
 * and can be monitored/reaped by the server.
 */

import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Diagnostics for a single running session */
export interface SessionDiagnostic {
  name: string;
  id: string;
  jobSlug?: string;
  ageMinutes: number;
  maxDurationMinutes?: number;
  isStale: boolean;
  staleReason?: string;
}

/** System memory pressure levels */
export type MemoryPressure = 'low' | 'moderate' | 'high' | 'critical';

/** Full diagnostics snapshot for intelligent scheduling decisions */
export interface SessionDiagnostics {
  sessions: SessionDiagnostic[];
  maxSessions: number;
  staleSessions: SessionDiagnostic[];
  memoryPressure: MemoryPressure;
  memoryUsedPercent: number;
  freeMemoryMB: number;
  totalMemoryMB: number;
  suggestions: string[];
}
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { InputGuard, type TopicBinding } from './InputGuard.js';

const execFileAsync = promisify(execFile);
import type { Session, SessionManagerConfig, SessionStatus, ModelTier } from './types.js';
import { StateManager } from './StateManager.js';
import { buildInjectionTag } from '../types/pipeline.js';
import { sanitizeSenderName, sanitizeTopicName } from '../utils/sanitize.js';

/** Absolute maximum session duration (4 hours) — safety net for sessions without explicit timeout */
const DEFAULT_MAX_DURATION_MINUTES = 240;

/** Sanitize a string for use as part of a tmux session name. */
function sanitizeSessionName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  return sanitized || 'session';
}

export interface SessionManagerEvents {
  sessionComplete: [session: Session];
}

export class SessionManager extends EventEmitter {
  private config: SessionManagerConfig;
  private state: StateManager;
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private monitoringInProgress = false;
  private inputGuard: InputGuard | null = null;
  private registryPath: string | null = null;

  constructor(config: SessionManagerConfig, state: StateManager) {
    super();
    this.config = config;
    this.state = state;
  }

  /**
   * Set the InputGuard for cross-topic injection defense.
   * Must be called after construction with state dir info.
   */
  setInputGuard(guard: InputGuard, registryPath: string): void {
    this.inputGuard = guard;
    this.registryPath = registryPath;
  }

  /**
   * Look up the topic binding for a tmux session from the topic-session registry.
   * Returns null if the session is not bound to any topic.
   */
  private getTopicBinding(tmuxSession: string): TopicBinding | null {
    if (!this.registryPath) return null;
    try {
      if (!fs.existsSync(this.registryPath)) return null;
      const registry = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      const topicToSession = registry.topicToSession || {};
      const topicToName = registry.topicToName || {};

      // Reverse lookup: find which topic maps to this session
      for (const [topicIdStr, sessionName] of Object.entries(topicToSession)) {
        if (sessionName === tmuxSession) {
          const topicId = parseInt(topicIdStr, 10);
          return {
            topicId,
            topicName: (topicToName[topicIdStr] as string) || `Topic ${topicId}`,
            channel: 'telegram', // Currently only Telegram uses the registry
            sessionName: tmuxSession,
          };
        }
      }
      return null;
    } catch {
      // Registry read failure — fail open (no binding = no check)
      return null;
    }
  }

  /**
   * Start polling for completed sessions. Emits 'sessionComplete' when
   * a running session's tmux process disappears.
   *
   * Uses async tmux calls to avoid blocking the event loop when
   * many sessions are running.
   */
  startMonitoring(intervalMs: number = 5000): void {
    if (this.monitorInterval) return;

    this.monitorInterval = setInterval(() => {
      // Prevent overlapping monitor ticks
      if (this.monitoringInProgress) return;
      this.monitorTick().catch(err => {
        console.error(`[SessionManager] Monitor tick error: ${err}`);
      });
    }, intervalMs);
  }

  private async monitorTick(): Promise<void> {
    this.monitoringInProgress = true;
    try {
      const running = this.state.listSessions({ status: 'running' });
      for (const session of running) {
        const alive = await this.isSessionAliveAsync(session.tmuxSession);
        if (!alive) {
          session.status = 'completed';
          session.endedAt = new Date().toISOString();
          this.state.saveSession(session);
          this.emit('sessionComplete', session);
          continue;
        }

        // Check for completion patterns even while session appears alive
        // (catches sessions where Claude finished but tmux is still open)
        if (!this.config.protectedSessions.includes(session.tmuxSession) &&
            this.detectCompletion(session.tmuxSession)) {
          console.log(`[SessionManager] Session "${session.name}" completed (pattern detected). Cleaning up.`);
          try {
            await execFileAsync(this.config.tmuxPath, ['kill-session', '-t', `=${session.tmuxSession}`]);
          } catch { /* ignore */ }
          session.status = 'completed';
          session.endedAt = new Date().toISOString();
          this.state.saveSession(session);
          this.emit('sessionComplete', session);
          continue;
        }

        // Enforce session timeout (prevents zombie/stuck sessions)
        // Uses explicit maxDurationMinutes if set, otherwise falls back to
        // DEFAULT_MAX_DURATION_MINUTES as an absolute safety net.
        if (session.startedAt) {
          const maxMinutes = session.maxDurationMinutes || DEFAULT_MAX_DURATION_MINUTES;
          const elapsed = (Date.now() - new Date(session.startedAt).getTime()) / 60000;
          const buffer = Math.min(maxMinutes * 0.2, 60); // 20% buffer, max 60 min
          const limit = maxMinutes + buffer;
          if (elapsed > limit && !this.config.protectedSessions.includes(session.tmuxSession)) {
            console.warn(`[SessionManager] Session "${session.name}" exceeded timeout (${Math.round(elapsed)}m > ${maxMinutes}m). Killing.`);
            try {
              await execFileAsync(this.config.tmuxPath, ['kill-session', '-t', `=${session.tmuxSession}`]);
            } catch {
              // @silent-fallback-ok — tmux kill, session may be dead
            }
            session.status = 'killed';
            session.endedAt = new Date().toISOString();
            this.state.saveSession(session);
            this.emit('sessionComplete', session);
          }
        }
      }
    } finally {
      this.monitoringInProgress = false;
    }
  }

  /**
   * Stop the monitoring poll.
   */
  stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
  }

  /**
   * Spawn a new Claude Code session in tmux.
   */
  async spawnSession(options: {
    name: string;
    prompt: string;
    model?: ModelTier;
    jobSlug?: string;
    triggeredBy?: string;
    maxDurationMinutes?: number;
  }): Promise<Session> {
    const runningSessions = this.listRunningSessions();
    if (runningSessions.length >= this.config.maxSessions) {
      throw new Error(
        `Max sessions (${this.config.maxSessions}) reached. ` +
        `Running: ${runningSessions.map(s => s.name).join(', ')}`
      );
    }

    const sessionId = this.generateId();
    const safeName = sanitizeSessionName(options.name);
    const tmuxSession = `${path.basename(this.config.projectDir)}-${safeName}`;

    // Check if tmux session already exists
    if (this.tmuxSessionExists(tmuxSession)) {
      throw new Error(`tmux session "${tmuxSession}" already exists`);
    }

    // Build Claude CLI arguments — no shell intermediary.
    // tmux new-session executes the command directly (no bash -c needed)
    // when given as separate arguments after the session options.
    // Use -e CLAUDECODE= to unset the CLAUDECODE env var in spawned sessions,
    // preventing nested Claude Code detection when instar runs inside Claude Code.
    const claudeArgs = ['--dangerously-skip-permissions'];
    if (options.model) {
      claudeArgs.push('--model', options.model);
    }
    claudeArgs.push('-p', options.prompt);

    try {
      execFileSync(this.config.tmuxPath, [
        'new-session', '-d',
        '-s', tmuxSession,
        '-c', this.config.projectDir,
        '-e', 'CLAUDECODE=', // Prevent nested Claude Code detection
        '-e', 'ANTHROPIC_API_KEY=', // Clear stale/invalid API keys — agents use Claude subscription
        // Isolate database credentials — spawned sessions must never inherit production
        // database URLs from the parent shell. This prevents accidental schema changes
        // or data operations against the wrong database. (Learned from Portal incident 2026-02-22)
        '-e', 'DATABASE_URL=',
        '-e', 'DIRECT_DATABASE_URL=',
        '-e', 'DATABASE_URL_PROD=',
        '-e', 'DATABASE_URL_DEV=',
        '-e', 'DATABASE_URL_TEST=',
        this.config.claudePath, ...claudeArgs,
      ], { encoding: 'utf-8' });
    } catch (err) {
      throw new Error(`Failed to create tmux session: ${err}`);
    }

    const session: Session = {
      id: sessionId,
      name: options.name,
      status: 'running',
      jobSlug: options.jobSlug,
      tmuxSession,
      startedAt: new Date().toISOString(),
      triggeredBy: options.triggeredBy,
      model: options.model,
      prompt: options.prompt,
      maxDurationMinutes: options.maxDurationMinutes,
    };

    this.state.saveSession(session);
    return session;
  }

  /**
   * Check if a session is still running by checking tmux AND verifying
   * that the Claude process is running inside (not a zombie tmux pane).
   */
  isSessionAlive(tmuxSession: string): boolean {
    if (!this.tmuxSessionExists(tmuxSession)) return false;

    // Verify Claude process is running inside the tmux session
    try {
      const paneInfo = execFileSync(
        this.config.tmuxPath,
        ['display-message', '-t', `=${tmuxSession}:`, '-p', '#{pane_current_command}||#{pane_start_command}'],
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();
      const [paneCmd, startCmd] = paneInfo.split('||');
      // Claude Code runs as 'claude' or 'node' process
      if (paneCmd && (paneCmd.includes('claude') || paneCmd.includes('node'))) {
        return true;
      }
      // If pane command is bash/zsh/sh, check whether the session was launched
      // with a direct command (e.g., a bash script as claudePath). In that case
      // bash IS the expected running process — not a leftover shell after Claude exits.
      // tmux kills sessions launched with direct commands when the command exits,
      // so if has-session succeeds and start_command is non-empty, it's still running.
      if (paneCmd === 'bash' || paneCmd === 'zsh' || paneCmd === 'sh') {
        if (startCmd && startCmd !== paneCmd) {
          // Session was launched with a specific command (not a bare shell) — still alive
          return true;
        }
        return false;
      }
      // For any other command, assume alive (could be a Claude subprocess)
      return true;
    } catch {
      // @silent-fallback-ok — pane inspection, assumes alive
      return true;
    }
  }

  /**
   * Check if a session is still running by checking tmux AND verifying
   * that the Claude process is running inside (async version).
   * Used by the monitoring loop to avoid blocking the event loop.
   *
   * Previously only checked `tmux has-session` which missed zombie sessions
   * where tmux was alive but Claude had exited — causing stuck sessions
   * that blocked the scheduler for hours.
   */
  private async isSessionAliveAsync(tmuxSession: string): Promise<boolean> {
    try {
      await execFileAsync(this.config.tmuxPath, ['has-session', '-t', `=${tmuxSession}`], {
        timeout: 5000,
      });
    } catch {
      // @silent-fallback-ok — session existence check
      return false;
    }

    // Verify Claude process is alive inside (matches sync isSessionAlive logic)
    try {
      const { stdout } = await execFileAsync(
        this.config.tmuxPath,
        ['display-message', '-t', `=${tmuxSession}:`, '-p', '#{pane_current_command}||#{pane_start_command}'],
        { timeout: 5000 }
      );
      const paneInfo = stdout.trim();
      const [paneCmd, startCmd] = paneInfo.split('||');
      if (paneCmd && (paneCmd.includes('claude') || paneCmd.includes('node'))) {
        return true;
      }
      if (paneCmd === 'bash' || paneCmd === 'zsh' || paneCmd === 'sh') {
        if (startCmd && startCmd !== paneCmd) {
          return true;
        }
        return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  /**
   * Kill a session by terminating its tmux session.
   */
  killSession(sessionId: string): boolean {
    const session = this.state.getSession(sessionId);
    if (!session) return false;

    // Don't kill protected sessions
    if (this.config.protectedSessions.includes(session.tmuxSession)) {
      throw new Error(`Cannot kill protected session: ${session.tmuxSession}`);
    }

    try {
      execFileSync(this.config.tmuxPath, ['kill-session', '-t', `=${session.tmuxSession}`], {
        encoding: 'utf-8',
      });
    } catch {
      // Session might already be dead
    }

    session.status = 'killed';
    session.endedAt = new Date().toISOString();
    this.state.saveSession(session);
    return true;
  }

  /**
   * Capture the current output of a tmux session.
   */
  captureOutput(tmuxSession: string, lines: number = 100): string | null {
    try {
      // Note: use `=session:` (trailing colon) for pane-level tmux commands
      return execFileSync(
        this.config.tmuxPath,
        ['capture-pane', '-t', `=${tmuxSession}:`, '-p', '-S', `-${lines}`],
        { encoding: 'utf-8', timeout: 5000 }
      );
    } catch {
      // @silent-fallback-ok — capture output, null handled by caller
      return null;
    }
  }

  /**
   * Send input to a running tmux session.
   */
  sendInput(tmuxSession: string, input: string): boolean {
    try {
      // Note: use `=session:` (trailing colon) for pane-level tmux commands
      // Send text literally, then Enter separately
      execFileSync(
        this.config.tmuxPath,
        ['send-keys', '-t', `=${tmuxSession}:`, '-l', input],
        { encoding: 'utf-8', timeout: 5000 }
      );
      execFileSync(
        this.config.tmuxPath,
        ['send-keys', '-t', `=${tmuxSession}:`, 'Enter'],
        { encoding: 'utf-8', timeout: 5000 }
      );
      return true;
    } catch {
      // @silent-fallback-ok — send-keys boolean return
      return false;
    }
  }

  /**
   * Send a tmux key sequence (without -l literal flag).
   * Use for special keys like 'C-c' (Ctrl+C), 'Enter', 'Escape'.
   * Unlike sendInput() which uses -l (literal), this sends key names directly.
   */
  sendKey(tmuxSession: string, key: string): boolean {
    try {
      execFileSync(
        this.config.tmuxPath,
        ['send-keys', '-t', `=${tmuxSession}:`, key],
        { encoding: 'utf-8', timeout: 5000 }
      );
      return true;
    } catch {
      // @silent-fallback-ok — send-key boolean return
      return false;
    }
  }

  /**
   * List all sessions that are currently running.
   * Pure filter — does not mutate state. The monitor tick handles lifecycle transitions.
   */
  listRunningSessions(): Session[] {
    const sessions = this.state.listSessions({ status: 'running' });
    return sessions.filter(s => this.isSessionAlive(s.tmuxSession));
  }

  /**
   * Get diagnostics for all running sessions, including staleness detection
   * and memory pressure. Used by the scheduler to build intelligent notifications
   * when jobs are blocked by session limits.
   */
  getSessionDiagnostics(): SessionDiagnostics {
    const running = this.listRunningSessions();
    const now = Date.now();

    const sessions: SessionDiagnostic[] = running.map(s => {
      const ageMinutes = s.startedAt
        ? Math.round((now - new Date(s.startedAt).getTime()) / 60000)
        : 0;
      const maxDuration = s.maxDurationMinutes || DEFAULT_MAX_DURATION_MINUTES;

      // A session is stale if it's exceeded its expected duration
      let isStale = false;
      let staleReason: string | undefined;

      if (ageMinutes > maxDuration) {
        isStale = true;
        staleReason = `Running ${ageMinutes}m, expected max ${maxDuration}m`;
      } else if (s.maxDurationMinutes && ageMinutes > s.maxDurationMinutes * 0.9) {
        // Near its limit — flag as approaching stale
        isStale = true;
        staleReason = `Near timeout (${ageMinutes}m / ${s.maxDurationMinutes}m)`;
      }

      return {
        name: s.name,
        id: s.id,
        jobSlug: s.jobSlug,
        ageMinutes,
        maxDurationMinutes: s.maxDurationMinutes,
        isStale,
        staleReason,
      };
    });

    const staleSessions = sessions.filter(s => s.isStale);

    // Memory pressure assessment
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
    const freeMemMB = Math.round(freeMem / 1048576);
    const totalMemMB = Math.round(totalMem / 1048576);

    let memoryPressure: MemoryPressure;
    if (usedPercent >= 90) memoryPressure = 'critical';
    else if (usedPercent >= 75) memoryPressure = 'high';
    else if (usedPercent >= 60) memoryPressure = 'moderate';
    else memoryPressure = 'low';

    // Build actionable suggestions
    const suggestions: string[] = [];

    if (staleSessions.length > 0) {
      for (const s of staleSessions) {
        suggestions.push(`Kill stale session "${s.name}" (${s.staleReason})`);
      }
    }

    if (memoryPressure === 'critical' || memoryPressure === 'high') {
      if (staleSessions.length > 0) {
        suggestions.push(`Memory pressure is ${memoryPressure} (${usedPercent}% used) — killing stale sessions would free resources`);
      } else {
        suggestions.push(`Memory pressure is ${memoryPressure} (${usedPercent}% used) — avoid increasing maxSessions`);
      }
    } else if (staleSessions.length === 0) {
      // No stale sessions and memory is fine — suggest increasing the limit
      suggestions.push(`All ${running.length} sessions are active and healthy. Consider increasing maxSessions from ${this.config.maxSessions} to ${this.config.maxSessions + 1}`);
    }

    return {
      sessions,
      maxSessions: this.config.maxSessions,
      staleSessions,
      memoryPressure,
      memoryUsedPercent: usedPercent,
      freeMemoryMB: freeMemMB,
      totalMemoryMB: totalMemMB,
      suggestions,
    };
  }

  /**
   * Detect if a session has completed by checking output patterns.
   */
  detectCompletion(tmuxSession: string): boolean {
    const output = this.captureOutput(tmuxSession, 30);
    if (!output) return false;

    return this.config.completionPatterns.some(pattern =>
      output.includes(pattern)
    );
  }

  /**
   * Reap completed/zombie sessions.
   */
  reapCompletedSessions(): string[] {
    const running = this.state.listSessions({ status: 'running' });
    const reaped: string[] = [];

    for (const session of running) {
      if (this.config.protectedSessions.includes(session.tmuxSession)) continue;

      if (!this.isSessionAlive(session.tmuxSession) || this.detectCompletion(session.tmuxSession)) {
        session.status = 'completed';
        session.endedAt = new Date().toISOString();
        this.state.saveSession(session);
        reaped.push(session.id);

        // Kill the tmux session if it's still hanging around
        if (this.isSessionAlive(session.tmuxSession)) {
          try {
            execFileSync(this.config.tmuxPath, ['kill-session', '-t', `=${session.tmuxSession}`], {
              encoding: 'utf-8',
            });
          } catch { /* ignore */ }
        }
      }
    }

    return reaped;
  }

  /**
   * Spawn an interactive Claude Code session (no -p prompt — opens at the REPL).
   * Used for Telegram-driven conversational sessions.
   * Optionally sends an initial message after Claude is ready.
   */
  async spawnInteractiveSession(initialMessage?: string, name?: string, options?: { telegramTopicId?: number; resumeSessionId?: string }): Promise<string> {
    const sanitized = name
      ? name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
      : null;
    const projectBase = path.basename(this.config.projectDir);
    const tmuxSession = sanitized ? `${projectBase}-${sanitized}` : `${projectBase}-interactive-${Date.now()}`;

    // Prevent injection into protected sessions (e.g., the server itself)
    if (this.config.protectedSessions.includes(tmuxSession)) {
      throw new Error(`Cannot interact with protected session: ${tmuxSession}`);
    }

    if (this.tmuxSessionExists(tmuxSession)) {
      // Session already exists — just reuse it
      if (initialMessage) {
        this.injectMessage(tmuxSession, initialMessage);
      }
      return tmuxSession;
    }

    // User-initiated sessions bypass the maxSessions limit entirely.
    // The user should NEVER be blocked from interacting with their agent
    // because scheduled jobs filled all slots. maxSessions only constrains
    // autonomous/scheduled sessions, not human-initiated ones.
    // Safety valve: still cap at maxSessions * 3 to prevent runaway sessions.
    const runningSessions = this.listRunningSessions();
    const absoluteLimit = this.config.maxSessions * 3;
    if (runningSessions.length >= absoluteLimit) {
      throw new Error(
        `Absolute session limit (${absoluteLimit}) reached. ` +
        `Running: ${runningSessions.map(s => s.name).join(', ')}`
      );
    }

    // Spawn Claude in tmux — no bash -c shell intermediary.
    // Uses tmux -e flags to set/unset env vars directly, matching spawnSession pattern.
    // This avoids shell injection risks and handles claudePath with spaces.
    try {
      const tmuxArgs = [
        'new-session', '-d',
        '-s', tmuxSession,
        '-c', this.config.projectDir,
        '-x', '200', '-y', '50',
        '-e', 'CLAUDECODE=', // Prevent nested Claude Code detection
        '-e', 'ANTHROPIC_API_KEY=', // Clear stale/invalid API keys — agents use Claude subscription
        // Isolate database credentials — spawned sessions must never inherit production
        // database URLs from the parent shell. (Learned from Portal incident 2026-02-22)
        '-e', 'DATABASE_URL=',
        '-e', 'DIRECT_DATABASE_URL=',
        '-e', 'DATABASE_URL_PROD=',
        '-e', 'DATABASE_URL_DEV=',
        '-e', 'DATABASE_URL_TEST=',
      ];

      if (options?.telegramTopicId) {
        tmuxArgs.push('-e', `INSTAR_TELEGRAM_TOPIC=${options.telegramTopicId}`);
      }

      tmuxArgs.push(this.config.claudePath, '--dangerously-skip-permissions');

      if (options?.resumeSessionId) {
        tmuxArgs.push('--resume', options.resumeSessionId);
        console.log(`[SessionManager] Resuming session: ${options.resumeSessionId}`);
      }

      execFileSync(this.config.tmuxPath, tmuxArgs, { encoding: 'utf-8' });
    } catch (err) {
      throw new Error(`Failed to create interactive tmux session: ${err}`);
    }

    // Track it in state (with default timeout — interactive sessions shouldn't hang forever)
    const session: Session = {
      id: this.generateId(),
      name: name || tmuxSession,
      status: 'running',
      tmuxSession,
      startedAt: new Date().toISOString(),
      prompt: initialMessage,
      maxDurationMinutes: DEFAULT_MAX_DURATION_MINUTES,
    };
    this.state.saveSession(session);

    // Wait for Claude to be ready, then send the initial message
    // Resume sessions load large JONSLs which trigger TUI redraws — use longer timeout
    // and a stabilization delay to avoid injecting text that gets wiped by the redraw.
    const readyTimeout = options?.resumeSessionId ? 60000 : 30000;
    if (initialMessage) {
      this.waitForClaudeReady(tmuxSession, readyTimeout).then((ready) => {
        if (ready) {
          // Stabilization delay: Claude's TUI may redraw after loading large JONSLs,
          // clearing any text injected too early. Wait for the redraw to settle.
          const stabilizationMs = options?.resumeSessionId ? 5000 : 0;
          setTimeout(() => {
            this.injectMessage(tmuxSession, initialMessage);
            console.log(`[SessionManager] Injected initial message into "${tmuxSession}" (${initialMessage.length} chars${stabilizationMs ? ', after stabilization delay' : ''})`);
          }, stabilizationMs);
        } else {
          console.error(`[SessionManager] Claude not ready in session "${tmuxSession}" — message NOT injected. Session may need manual intervention.`);
          // Still try to inject — Claude might be ready but prompt detection failed
          if (this.tmuxSessionExists(tmuxSession)) {
            console.log(`[SessionManager] Session "${tmuxSession}" still alive — attempting injection anyway`);
            this.injectMessage(tmuxSession, initialMessage);
          }
        }
      }).catch((err) => {
        console.error(`[SessionManager] Error waiting for Claude ready in "${tmuxSession}": ${err}`);
      });
    }

    return tmuxSession;
  }

  /**
   * Spawn a scoped triage session with restricted tool access.
   * Unlike interactive sessions, triage sessions use --allowedTools + --permission-mode dontAsk
   * instead of --dangerously-skip-permissions. This gives them read-only access.
   *
   * Used by TriageOrchestrator for behind-the-scenes session investigation.
   */
  async spawnTriageSession(name: string, options: {
    allowedTools: string[];
    permissionMode: string;
    resumeSessionId?: string;
  }): Promise<string> {
    const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
    const projectBase = path.basename(this.config.projectDir);
    const tmuxSession = `${projectBase}-${sanitized}`;

    if (this.config.protectedSessions.includes(tmuxSession)) {
      throw new Error(`Cannot create triage session with protected name: ${tmuxSession}`);
    }

    // Kill existing triage session if present (triage sessions are ephemeral)
    if (this.tmuxSessionExists(tmuxSession)) {
      try {
        execFileSync(this.config.tmuxPath, ['kill-session', '-t', tmuxSession], { encoding: 'utf-8' });
      } catch {
        // Best-effort
      }
    }

    try {
      const tmuxArgs = [
        'new-session', '-d',
        '-s', tmuxSession,
        '-c', this.config.projectDir,
        '-x', '200', '-y', '50',
        '-e', 'CLAUDECODE=',
        '-e', 'ANTHROPIC_API_KEY=',
        '-e', 'DATABASE_URL=',
        '-e', 'DIRECT_DATABASE_URL=',
        '-e', 'DATABASE_URL_PROD=',
        '-e', 'DATABASE_URL_DEV=',
        '-e', 'DATABASE_URL_TEST=',
      ];

      tmuxArgs.push(this.config.claudePath);

      // Scoped permissions: allowedTools + permissionMode (NOT --dangerously-skip-permissions)
      if (options.allowedTools.length > 0) {
        tmuxArgs.push('--allowedTools', options.allowedTools.join(','));
      }
      tmuxArgs.push('--permission-mode', options.permissionMode);

      if (options.resumeSessionId) {
        tmuxArgs.push('--resume', options.resumeSessionId);
        console.log(`[SessionManager] Resuming triage session: ${options.resumeSessionId}`);
      }

      execFileSync(this.config.tmuxPath, tmuxArgs, { encoding: 'utf-8' });
    } catch (err) {
      throw new Error(`Failed to create triage tmux session: ${err}`);
    }

    // Track it but with a shorter timeout (triage sessions should be brief)
    const session: Session = {
      id: this.generateId(),
      name,
      status: 'running',
      tmuxSession,
      startedAt: new Date().toISOString(),
      maxDurationMinutes: 10,
    };
    this.state.saveSession(session);

    // Wait for Claude to be ready
    const readyTimeout = options.resumeSessionId ? 60000 : 30000;
    await this.waitForClaudeReady(tmuxSession, readyTimeout);

    return tmuxSession;
  }

  /**
   * Inject a Telegram message into a tmux session.
   * Short messages go via send-keys; long messages are written to a temp file.
   *
   * Image handling: [image:/path] tags from Telegram photo downloads are
   * transformed into explicit instructions so Claude Code knows to read the
   * image file (it can natively view images via the Read tool).
   */
  injectTelegramMessage(tmuxSession: string, topicId: number, text: string, topicName?: string, senderName?: string, telegramUserId?: number): void {
    const FILE_THRESHOLD = 500;

    // Transform [image:path] tags into explicit read instructions.
    // Claude Code can natively view images via the Read tool, but only
    // if it knows there's an image file to read.
    const transformed = text.replace(
      /\[image:([^\]]+)\]/g,
      (_, imagePath: string) => {
        if (imagePath === 'download-failed') {
          return '[User sent a photo but the download failed]';
        }
        return `[User sent a photo — read the image file at ${imagePath} to view it]`;
      }
    );

    // Sanitize user-controlled content at the injection boundary
    // (User-Agent Topology Spec, Gap 12)
    const safeName = senderName ? sanitizeSenderName(senderName) : undefined;
    const safeTopic = topicName ? sanitizeTopicName(topicName) : undefined;

    // Build tag using the shared builder — includes UID when available
    // Format: [telegram:42 "Agent Updates" from Justin (uid:12345)]
    const topicTag = buildInjectionTag(topicId, safeTopic, safeName, telegramUserId);
    const taggedText = `${topicTag} ${transformed}`;

    if (taggedText.length <= FILE_THRESHOLD) {
      this.injectMessage(tmuxSession, taggedText);
      return;
    }

    // Write full message to temp file
    const tmpDir = path.join('/tmp', 'instar-telegram');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filename = `msg-${topicId}-${Date.now()}-${randomUUID().slice(0, 8)}.txt`;
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, taggedText);

    const ref = `[telegram:${topicId}] [Long message saved to ${filepath} — read it to see the full message]`;
    this.injectMessage(tmuxSession, ref);
  }

  /**
   * Inject a WhatsApp message into a tmux session.
   * Tags with [whatsapp:JID] and handles long messages via temp files.
   */
  injectWhatsAppMessage(tmuxSession: string, jid: string, text: string, senderName?: string): void {
    const FILE_THRESHOLD = 500;

    // Build tag: [whatsapp:12345678901@s.whatsapp.net from Justin]
    const nameTag = senderName ? ` from ${senderName.replace(/[\[\]]/g, '')}` : '';
    const tag = `[whatsapp:${jid}${nameTag}]`;
    const taggedText = `${tag} ${text}`;

    if (taggedText.length <= FILE_THRESHOLD) {
      this.injectMessage(tmuxSession, taggedText);
      return;
    }

    // Write full message to temp file
    const tmpDir = path.join('/tmp', 'instar-whatsapp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filename = `msg-${jid.split('@')[0]}-${Date.now()}.txt`;
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, taggedText);

    const ref = `${tag} [Long message saved to ${filepath} — read it to see the full message]`;
    this.injectMessage(tmuxSession, ref);
  }

  /**
   * Send text to a tmux session via send-keys, with Input Guard protection.
   *
   * When an InputGuard is configured, messages are checked for provenance
   * before injection. Suspicious messages still reach the session but with
   * a system-reminder warning injected afterward (async, non-blocking).
   *
   * For multi-line text, uses bracketed paste mode escape sequences so the
   * terminal treats newlines as literal text rather than Enter keypresses.
   * This avoids tmux load-buffer/paste-buffer which trigger macOS TCC
   * "access data from other apps" permission prompts.
   */
  private injectMessage(tmuxSession: string, text: string): void {
    // ── Input Guard: Layer 1 + 1.5 (deterministic, synchronous) ──
    if (this.inputGuard) {
      const binding = this.getTopicBinding(tmuxSession);
      if (binding) {
        const provenance = this.inputGuard.checkProvenance(text, binding);

        if (provenance === 'mismatched-tag') {
          // Wrong topic — log, alert, and drop
          console.error(
            `[InputGuard] BLOCKED cross-topic injection: message bound for different topic, ` +
            `session "${tmuxSession}" is bound to topic ${binding.topicId}`
          );
          this.inputGuard.logSecurityEvent({
            event: 'input-provenance-block',
            session: tmuxSession,
            boundTopic: binding.topicId,
            messagePreview: text.slice(0, 100),
            reason: 'mismatched tag',
          });
          return;
        }

        if (provenance === 'untagged') {
          // Layer 1.5: Check injection patterns
          const pattern = this.inputGuard.checkInjectionPatterns(text);
          if (pattern) {
            const action = this.inputGuard['config'].action ?? 'warn';
            this.inputGuard.logSecurityEvent({
              event: 'input-injection-pattern',
              session: tmuxSession,
              boundTopic: binding.topicId,
              pattern,
              action,
              messagePreview: text.slice(0, 100),
            });

            if (action === 'block') {
              console.error(`[InputGuard] BLOCKED injection pattern "${pattern}" in session "${tmuxSession}"`);
              return;
            }
            if (action === 'warn') {
              // Inject the message, then inject warning afterward
              this.rawInject(tmuxSession, text);
              // Small delay so warning arrives after message
              setTimeout(() => {
                const warning = this.inputGuard!.buildWarning(binding, `Matched injection pattern: ${pattern}`);
                this.rawInject(tmuxSession, warning);
              }, 500);
              return;
            }
            // action === 'log': fall through to normal injection
          }

          // Layer 2: Async LLM topic coherence review (non-blocking)
          // Inject immediately, review in background
          this.rawInject(tmuxSession, text);
          this.inputGuard.reviewTopicCoherence(text, binding).then(result => {
            if (result.verdict === 'suspicious') {
              const action = this.inputGuard!['config'].action ?? 'warn';
              this.inputGuard!.logSecurityEvent({
                event: 'input-coherence-suspicious',
                session: tmuxSession,
                boundTopic: binding.topicId,
                reason: result.reason,
                confidence: result.confidence,
                action,
                messagePreview: text.slice(0, 100),
              });

              if (action === 'warn') {
                const warning = this.inputGuard!.buildWarning(binding, result.reason);
                this.rawInject(tmuxSession, warning);
              }
              // block mode doesn't apply after async review — message already injected
              // log mode: already logged above
            }
          }).catch(err => {
            // Fail open — message already injected, just log the error
            console.error(`[InputGuard] Coherence review error: ${err instanceof Error ? err.message : err}`);
          });
          return;
        }
        // provenance === 'verified' or 'unbound' — fall through to normal injection
      }
    }

    // ── Normal injection (verified provenance or no InputGuard) ──
    this.rawInject(tmuxSession, text);
  }

  /**
   * Raw tmux send-keys injection. No validation — just sends text to the session.
   * Used by injectMessage after provenance checks pass.
   */
  private rawInject(tmuxSession: string, text: string): void {
    const exactTarget = `=${tmuxSession}:`;
    try {
      if (text.includes('\n')) {
        // Multi-line: use bracketed paste mode.
        // The terminal (and Claude Code's readline) treats everything between
        // \e[200~ and \e[201~ as a single paste — newlines are literal, not Enter.
        // This completely avoids load-buffer/paste-buffer and their TCC prompts.
        execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, '\x1b[200~'], {
          encoding: 'utf-8', timeout: 5000,
        });
        execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, '-l', text], {
          encoding: 'utf-8', timeout: 5000,
        });
        execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, '\x1b[201~'], {
          encoding: 'utf-8', timeout: 5000,
        });
        // Brief delay to let the terminal process the bracketed paste
        execFileSync('/bin/sleep', ['0.1'], { timeout: 2000 });
        // Send Enter to submit
        execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, 'Enter'], {
          encoding: 'utf-8', timeout: 5000,
        });
      } else {
        // Single-line: simple send-keys
        execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, '-l', text], {
          encoding: 'utf-8', timeout: 5000,
        });
        // Send Enter separately
        execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, 'Enter'], {
          encoding: 'utf-8', timeout: 5000,
        });
      }
    } catch (err) {
      console.error(`[SessionManager] Failed to inject message into ${tmuxSession}: ${err}`);
      DegradationReporter.getInstance().report({
        feature: 'SessionManager.injectMessage',
        primary: 'Inject Telegram message into tmux session',
        fallback: 'Message lost — user input never reaches Claude',
        reason: `Failed to inject message: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'User message silently dropped',
      });
    }
  }

  /**
   * Wait for Claude to be ready in a tmux session by polling output.
   * Looks for Claude Code's prompt character (❯) which appears when ready for input.
   */
  private async waitForClaudeReady(tmuxSession: string, timeoutMs: number = 30000): Promise<boolean> {
    const start = Date.now();
    // Wait a minimum startup delay before checking (Claude needs time to load)
    await new Promise(r => setTimeout(r, 3000));
    while (Date.now() - start < timeoutMs) {
      if (!this.tmuxSessionExists(tmuxSession)) {
        console.error(`[SessionManager] Session "${tmuxSession}" died during startup`);
        return false;
      }
      const output = this.captureOutput(tmuxSession, 5);
      // Check only the last 3 lines for Claude Code's prompt character (❯).
      // Checking all captured lines can false-positive on ❯ appearing in prior output
      // (e.g., during TUI redraw of a resumed session's history).
      const lines = (output || '').split('\n').filter(l => l.trim());
      const tail = lines.slice(-3).join('\n');
      if (tail.includes('❯') || tail.includes('bypass permissions')) {
        console.log(`[SessionManager] Claude ready in "${tmuxSession}" after ${Date.now() - start}ms`);
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    // Log what we see on timeout for debugging
    const finalOutput = this.captureOutput(tmuxSession, 20);
    console.error(`[SessionManager] Claude not ready in "${tmuxSession}" after ${timeoutMs}ms. Output: ${(finalOutput || '').slice(-200)}`);
    return false;
  }

  tmuxSessionExists(name: string): boolean {
    try {
      execFileSync(this.config.tmuxPath, ['has-session', '-t', `=${name}`], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      return true;
    } catch {
      // @silent-fallback-ok — session existence check
      return false;
    }
  }

  private generateId(): string {
    return randomUUID();
  }
}
