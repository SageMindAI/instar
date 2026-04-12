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
import type { InputDetector } from '../monitoring/PromptGate.js';

const execFileAsync = promisify(execFile);
import type { Session, SessionManagerConfig, SessionStatus, ModelTier } from './types.js';
import { StateManager } from './StateManager.js';
import { buildInjectionTag } from '../types/pipeline.js';
import { sanitizeSenderName, sanitizeTopicName } from '../utils/sanitize.js';

/** Absolute maximum session duration (4 hours) — safety net for sessions without explicit timeout */
const DEFAULT_MAX_DURATION_MINUTES = 240;

/** Minutes of idle-at-prompt before a non-protected session is killed */
const IDLE_PROMPT_KILL_MINUTES = 15;

/** Patterns that indicate Claude is sitting at its idle prompt (not actively working) */
const IDLE_PROMPT_PATTERNS = [
  'bypass permissions on',
  'shift+tab to cycle',
  'auto-accept edits',
  // The bare prompt character at end of output (after stripping ANSI)
];

/**
 * Patterns in terminal output that indicate an API or tool error caused the session to stop.
 * When detected at the idle prompt, we nudge the session to continue instead of killing it.
 */
const TERMINAL_ERROR_PATTERNS = [
  'API Error:',
  'invalid_request_error',
  'Could not process',
  'overloaded_error',
  'rate_limit_error',
  'Request timed out',
  'Internal server error',
  'ServiceUnavailable',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'fetch failed',
];

/**
 * Process names that are always running in a Claude Code session (MCP servers, etc.)
 * These do NOT indicate activity — they're background infrastructure.
 */
const BASELINE_PROCESS_PATTERNS = [
  /\bplaywright-mcp\b/,
  /\bplaywright\/mcp\b/,
  /\bmcp-stdio-entry\b/,
  /\bmcp.*server\b/i,
  /\bcaffeinate\b/,
  /\bnpm exec\b.*mcp/,
];

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

  /** Track when each session was first seen idle at the Claude prompt. Key = session ID */
  private idlePromptSince = new Map<string, number>();

  /** Throttle stale session cleanup to every 5 minutes */
  private lastCleanupAt = 0;

  /** Optional callback to check if a session has active subagents (prevents false zombie kills) */
  private subagentChecker?: (session: Session) => boolean;

  /** Prompt Gate InputDetector — monitors terminal output for interactive prompts */
  private promptDetector?: InputDetector;

  /** Sessions with active relay leases (prompt relayed, waiting for response) — extends idle timeout */
  private relayLeases = new Map<string, number>(); // session ID → lease expiry timestamp

  /** Track pending Telegram injections awaiting agent response.
   *  Key = tmuxSession name. Cleared when agent replies via /telegram/reply/:topicId. */
  private pendingInjections = new Map<string, { topicId: number; injectedAt: number; text: string }>();

  /** Track sessions that have been nudged after an API error.
   *  Key = session ID. Prevents infinite nudge loops — each session gets ONE nudge.
   *  If it goes idle again after the nudge, the zombie detector kills it normally. */
  private errorNudgedSessions = new Set<string>();

  /** Sessions where we've already retried Enter for stuck pasted text.
   *  Key = session ID. Prevents infinite retry loops — one retry per session. */
  private pasteRetried = new Set<string>();

  /** Cached count of running sessions, updated asynchronously by the monitor tick.
   *  Used by the health endpoint to avoid synchronous tmux polling. */
  private _cachedRunningCount = 0;
  private _cachedRunningSessions: Session[] = [];

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
   * Set the subagent checker callback for zombie cleanup awareness.
   * When set, the zombie cleanup will skip sessions that have active subagents.
   * Must be called after SubagentTracker is constructed.
   */
  setSubagentChecker(checker: (session: Session) => boolean): void {
    this.subagentChecker = checker;
  }

  /**
   * Set the Prompt Gate InputDetector for prompt monitoring.
   * When set, monitorTick() will capture output and feed it to the detector.
   */
  setPromptDetector(detector: InputDetector): void {
    this.promptDetector = detector;
    // Clean up detector state when sessions end
    this.on('sessionComplete', (session: Session) => {
      detector.cleanup(session.tmuxSession);
      this.relayLeases.delete(session.id);
      this.errorNudgedSessions.delete(session.id);
      this.pasteRetried.delete(session.id);
    });
  }

  /**
   * Grant a relay lease to a session — extends idle timeout while waiting for
   * a Telegram relay response. Prevents the zombie killer from killing sessions
   * that are legitimately waiting for user input.
   */
  grantRelayLease(sessionId: string, durationMs: number): void {
    this.relayLeases.set(sessionId, Date.now() + durationMs);
  }

  /**
   * Clear a relay lease (prompt was answered or timed out).
   */
  clearRelayLease(sessionId: string): void {
    this.relayLeases.delete(sessionId);
  }

  /**
   * Associate a Claude Code session UUID with an instar session.
   * Called when the first hook event arrives from a Claude Code session,
   * allowing SubagentTracker lookups to bridge the two ID spaces.
   */
  setClaudeSessionId(instarSessionId: string, claudeSessionId: string): void {
    const sessions = this.state.listSessions({ status: 'running' });
    const session = sessions.find(s => s.id === instarSessionId);
    if (session && !session.claudeSessionId) {
      session.claudeSessionId = claudeSessionId;
      this.state.saveSession(session);
    }
  }

  /**
   * Find a running session by its instar session ID.
   */
  getSessionById(instarSessionId: string): Session | undefined {
    return this.state.listSessions({ status: 'running' }).find(s => s.id === instarSessionId);
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
        // Grace period: don't check sessions that started less than 15 seconds ago.
        // Claude Code takes several seconds to start — the process might not be
        // visible in tmux yet when the monitor runs its first check.
        if (session.startedAt) {
          const ageMs = Date.now() - new Date(session.startedAt).getTime();
          if (ageMs < 15_000) continue;
        }

        const alive = await this.isSessionAliveAsync(session.tmuxSession);
        if (!alive) {
          // Check if this session had a pending Telegram injection that never got a response
          const pendingInjection = this.pendingInjections.get(session.tmuxSession);
          if (pendingInjection) {
            console.warn(`[SessionManager] Session "${session.name}" died with unanswered Telegram injection for topic ${pendingInjection.topicId} (injected ${Math.round((Date.now() - pendingInjection.injectedAt) / 1000)}s ago)`);
            this.pendingInjections.delete(session.tmuxSession);
            this.emit('injectionDropped', {
              topicId: pendingInjection.topicId,
              sessionName: session.tmuxSession,
              text: pendingInjection.text,
              injectedAt: pendingInjection.injectedAt,
            });
          }
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
          // Emit beforeSessionKill so listeners (TopicResumeMap, SlackAdapter) can save resume UUIDs
          this.emit('beforeSessionKill', session);
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
            // Check for unanswered injection before timeout kill
            const pendingInjection = this.pendingInjections.get(session.tmuxSession);
            if (pendingInjection) {
              console.warn(`[SessionManager] Timed-out session "${session.name}" had unanswered injection for topic ${pendingInjection.topicId}`);
              this.pendingInjections.delete(session.tmuxSession);
              this.emit('injectionDropped', {
                topicId: pendingInjection.topicId,
                sessionName: session.tmuxSession,
                text: pendingInjection.text,
                injectedAt: pendingInjection.injectedAt,
              });
            }
            console.warn(`[SessionManager] Session "${session.name}" exceeded timeout (${Math.round(elapsed)}m > ${maxMinutes}m). Killing.`);
            // Emit beforeSessionKill BEFORE destroying the tmux session so
            // listeners (e.g. TopicResumeMap) can discover the Claude UUID.
            this.emit('beforeSessionKill', session);
            try {
              await execFileAsync(this.config.tmuxPath, ['kill-session', '-t', `=${session.tmuxSession}`]);
            } catch {
              // @silent-fallback-ok — tmux kill, session may be dead
            }
            session.status = 'killed';
            session.endedAt = new Date().toISOString();
            this.state.saveSession(session);
            this.emit('sessionComplete', session);
            continue;
          }
        }

        // Idle detection — kill sessions that are truly stopped.
        // A session is idle when: (1) the terminal shows idle prompt patterns,
        // AND (2) no non-baseline child processes are running. This is the ground
        // truth — no exemptions needed for subagents, topic bindings, or relay leases.
        // If the process tree shows work, the session is active. Period.
        if (!this.config.protectedSessions.includes(session.tmuxSession)) {
          const output = this.captureOutput(session.tmuxSession, 5);
          const isIdleAtPrompt = output && IDLE_PROMPT_PATTERNS.some(p => output.includes(p));

          // ── Prompt Gate: feed captured output to InputDetector ──
          if (this.promptDetector && output) {
            const fullOutput = this.captureOutput(session.tmuxSession, 50);
            if (fullOutput) {
              this.promptDetector.onCapture(session.tmuxSession, fullOutput);
            }
          }

          // Two conditions must BOTH be true for idle: prompt pattern + no active processes
          const isActuallyIdle = isIdleAtPrompt && !this.hasActiveProcesses(session.tmuxSession);

          if (isActuallyIdle) {
            const now = Date.now();
            if (!this.idlePromptSince.has(session.id)) {
              this.idlePromptSince.set(session.id, now);

              // ── Pasted text stuck: detect unsubmitted paste and retry Enter ──
              // Claude Code shows "[Pasted text #N]" when bracketed paste content
              // sits in the input buffer without being submitted. This happens when
              // the Enter key sent after the paste end sequence doesn't register.
              // Re-send Enter to unstick it. Only try once per session to avoid loops.
              if (!this.pasteRetried.has(session.id)) {
                const recentForPaste = this.captureOutput(session.tmuxSession, 15);
                if (recentForPaste && /\[Pasted text #\d+\]/.test(recentForPaste)) {
                  this.pasteRetried.add(session.id);
                  console.log(`[SessionManager] Session "${session.name}" has unsubmitted pasted text — resending Enter.`);
                  this.sendKey(session.tmuxSession, 'Enter');
                  this.idlePromptSince.delete(session.id); // Reset idle timer
                  continue; // Skip to next session
                }
              }

              // ── Error nudge: on first idle detection, check terminal for API errors ──
              // If the session went idle because of an API error (not a natural stop),
              // inject a nudge to get it working again instead of waiting 15m to kill.
              if (!this.errorNudgedSessions.has(session.id)) {
                const recentOutput = this.captureOutput(session.tmuxSession, 30);
                if (recentOutput) {
                  const hasError = TERMINAL_ERROR_PATTERNS.some(p => recentOutput.includes(p));
                  if (hasError) {
                    this.errorNudgedSessions.add(session.id);
                    console.log(`[SessionManager] Session "${session.name}" idle after API error — nudging to continue.`);
                    this.sendInput(session.tmuxSession, 'You hit an API error. Please continue your work — skip or work around the action that failed.');
                    this.idlePromptSince.delete(session.id); // Reset idle timer
                    continue; // Skip to next session
                  }
                }
              }
            } else {
              const idleMs = now - this.idlePromptSince.get(session.id)!;
              if (idleMs > IDLE_PROMPT_KILL_MINUTES * 60_000) {
                // Check for unanswered injection before killing
                const pendingInjection = this.pendingInjections.get(session.tmuxSession);
                if (pendingInjection) {
                  console.warn(`[SessionManager] Zombie session "${session.name}" had unanswered injection for topic ${pendingInjection.topicId}`);
                  this.pendingInjections.delete(session.tmuxSession);
                  this.emit('injectionDropped', {
                    topicId: pendingInjection.topicId,
                    sessionName: session.tmuxSession,
                    text: pendingInjection.text,
                    injectedAt: pendingInjection.injectedAt,
                  });
                }
                console.warn(`[SessionManager] Session "${session.name}" idle at prompt for ${Math.round(idleMs / 60_000)}m with no active processes. Killing zombie.`);
                this.emit('beforeSessionKill', session);
                try {
                  await execFileAsync(this.config.tmuxPath, ['kill-session', '-t', `=${session.tmuxSession}`]);
                } catch { /* ignore */ }
                session.status = 'completed';
                session.endedAt = new Date().toISOString();
                this.state.saveSession(session);
                this.emit('sessionComplete', session);
                this.idlePromptSince.delete(session.id);
                continue;
              }
            }
          } else {
            // Session is active — clear idle tracker
            this.idlePromptSince.delete(session.id);
          }
        }
      }

      // Periodically clean up stale killed/completed session state files (every 5 min)
      const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
      if (Date.now() - this.lastCleanupAt > CLEANUP_INTERVAL_MS) {
        this.lastCleanupAt = Date.now();
        this.cleanupStaleSessions();
      }

      // Update cached session list (non-blocking) for health endpoint
      const stillRunning = this.state.listSessions({ status: 'running' });
      this._cachedRunningSessions = stillRunning;
      this._cachedRunningCount = stillRunning.length;
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
        '-e', `INSTAR_SESSION_ID=${sessionId}`, // Expose instar session ID to hook events
        '-e', `INSTAR_SERVER_URL=http://localhost:${this.config.port}`,
        '-e', `INSTAR_AUTH_TOKEN=${this.config.authToken}`,
        '-e', `ANTHROPIC_API_KEY=${this.config.anthropicApiKey ?? ''}`,
        '-e', `ANTHROPIC_BASE_URL=${this.config.anthropicBaseUrl ?? ''}`,
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

      // Increase tmux scrollback buffer for dashboard history support
      try {
        execFileSync(this.config.tmuxPath, [
          'set-option', '-t', `=${tmuxSession}:`, 'history-limit', '50000',
        ], { encoding: 'utf-8', timeout: 5000 });
      } catch {
        // @silent-fallback-ok — history-limit is a nice-to-have
      }
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
      // tmux session doesn't exist — it's dead
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
        console.log(`[SessionManager] Session "${tmuxSession}" has bare shell (${paneCmd}) — marking dead. start_command: ${startCmd}`);
        return false;
      }
      // Unknown command — log it and assume alive
      if (paneCmd) {
        console.log(`[SessionManager] Session "${tmuxSession}" has unknown pane command: "${paneCmd}" — assuming alive`);
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

    // Emit beforeSessionKill BEFORE destroying the tmux session so
    // listeners (e.g. TopicResumeMap) can discover the Claude UUID
    // while the session is still alive.
    this.emit('beforeSessionKill', session);

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
   * Check if a tmux session has active (non-baseline) child processes.
   * Returns true if the session is doing real work — running tools, bash commands,
   * subagents, etc. Returns false if only baseline processes (MCP servers, caffeinate)
   * are running, meaning the session is truly idle.
   *
   * This is the ground truth for whether a session is active — it doesn't care about
   * terminal output patterns, topic bindings, or subagent trackers. If the process
   * tree shows work happening, the session is active. Period.
   */
  hasActiveProcesses(tmuxSession: string): boolean {
    try {
      // Get the tmux pane's shell PID
      const panePid = execFileSync(
        this.config.tmuxPath,
        ['list-panes', '-t', `=${tmuxSession}:`, '-F', '#{pane_pid}'],
        { encoding: 'utf-8', timeout: 5000 }
      ).trim();

      if (!panePid || !/^\d+$/.test(panePid)) return false;

      // Get all descendant processes of the pane PID
      // Use ps to find all processes whose parent is in our tree
      const psOutput = execFileSync(
        'ps', ['-eo', 'pid,ppid,command'],
        { encoding: 'utf-8', timeout: 5000 }
      );

      // Build a map of PID → { ppid, command }
      const processes = new Map<string, { ppid: string; command: string }>();
      for (const line of psOutput.split('\n').slice(1)) { // skip header
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (match) {
          processes.set(match[1], { ppid: match[2], command: match[3] });
        }
      }

      // Walk the tree: find all descendants of panePid
      const descendants: Array<{ pid: string; command: string }> = [];
      const queue = [panePid];
      while (queue.length > 0) {
        const parentPid = queue.shift()!;
        for (const [pid, info] of processes) {
          if (info.ppid === parentPid && pid !== panePid) {
            descendants.push({ pid, command: info.command });
            queue.push(pid);
          }
        }
      }

      // Filter out baseline processes
      const activeProcesses = descendants.filter(p => {
        return !BASELINE_PROCESS_PATTERNS.some(pattern => pattern.test(p.command));
      });

      // The Claude Code node process itself is always running — that's the main process.
      // We care about processes BEYOND Claude itself and its baseline children.
      // Claude's main process is the direct child of the pane PID.
      // Filter it out: it's typically `node` or `claude` running the main Claude binary.
      const nonClaude = activeProcesses.filter(p => {
        const proc = processes.get(p.pid);
        // Direct child of pane PID running claude/node is the main process
        if (proc?.ppid === panePid) {
          return !/\bclaude\b/.test(p.command) && !/\bnode\b.*\bclaude\b/.test(p.command);
        }
        return true;
      });

      return nonClaude.length > 0;
    } catch {
      // If we can't check processes, assume active (fail-safe: don't kill)
      return true;
    }
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
   * WARNING: This calls synchronous tmux has-session for each session.
   * For health checks and non-critical callers, prefer getCachedRunningSessions().
   */
  listRunningSessions(): Session[] {
    const sessions = this.state.listSessions({ status: 'running' });
    const alive = sessions.filter(s => this.isSessionAlive(s.tmuxSession));
    // Update cache as a side effect
    this._cachedRunningCount = alive.length;
    this._cachedRunningSessions = alive;
    return alive;
  }

  /**
   * Get cached running session info (count + list) without blocking the event loop.
   * Updated asynchronously by the monitor tick every 5 seconds.
   * Safe to call from the health endpoint and other latency-sensitive paths.
   */
  getCachedRunningSessions(): { count: number; sessions: Session[] } {
    return { count: this._cachedRunningCount, sessions: this._cachedRunningSessions };
  }

  /**
   * Fast startup purge — immediately remove session records for dead tmux sessions.
   * Called once at server boot BEFORE monitoring starts, to prevent the death spiral
   * where stale sessions overwhelm startup and block health checks.
   * Uses a short timeout (1s) per session to fail fast.
   */
  async purgeDeadSessions(): Promise<number> {
    const running = this.state.listSessions({ status: 'running' });
    if (running.length === 0) return 0;

    let purged = 0;
    for (const session of running) {
      try {
        execFileSync(this.config.tmuxPath, ['has-session', '-t', `=${session.tmuxSession}`], {
          stdio: 'ignore', timeout: 1000,
        });
      } catch {
        // tmux session doesn't exist — purge the record
        session.status = 'completed';
        session.endedAt = new Date().toISOString();
        this.state.saveSession(session);
        purged++;
      }
    }

    if (purged > 0) {
      console.log(`[SessionManager] Startup purge: removed ${purged} dead session(s) of ${running.length} tracked`);
    }
    return purged;
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
   * Remove stale session state files for sessions that have been
   * killed or completed beyond the retention period.
   * Killed sessions: removed after 1 hour.
   * Completed sessions: removed after 24 hours.
   */
  cleanupStaleSessions(): string[] {
    const allSessions = this.state.listSessions();
    const now = Date.now();
    const KILLED_TTL_MS = 60 * 60 * 1000;            // 1 hour
    const COMPLETED_JOB_TTL_MS = 60 * 60 * 1000;     // 1 hour for jobs
    const COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;    // 24 hours for interactive
    const cleaned: string[] = [];
    const completed: { id: string; endedAt: number }[] = [];

    for (const session of allSessions) {
      if (session.status !== 'killed' && session.status !== 'completed') continue;
      const endedAt = session.endedAt ? new Date(session.endedAt).getTime() : 0;
      if (!endedAt) continue;

      const age = now - endedAt;
      let ttl: number;
      if (session.status === 'killed') {
        ttl = KILLED_TTL_MS;
      } else if (session.jobSlug) {
        ttl = COMPLETED_JOB_TTL_MS;
      } else {
        ttl = COMPLETED_TTL_MS;
      }

      if (age > ttl) {
        if (this.state.removeSession(session.id)) {
          cleaned.push(session.id);
        }
      } else if (session.status === 'completed') {
        completed.push({ id: session.id, endedAt });
      }
    }

    // Hard cap: prune oldest completed sessions if more than 50 remain
    const MAX_COMPLETED = 50;
    if (completed.length > MAX_COMPLETED) {
      completed.sort((a, b) => a.endedAt - b.endedAt);
      const excess = completed.slice(0, completed.length - MAX_COMPLETED);
      for (const s of excess) {
        if (this.state.removeSession(s.id)) {
          cleaned.push(s.id);
        }
      }
    }

    if (cleaned.length > 0) {
      console.log(`[SessionManager] Cleaned up ${cleaned.length} stale session(s): ${cleaned.join(', ')}`);
    }
    return cleaned;
  }

  /**
   * Spawn an interactive Claude Code session (no -p prompt — opens at the REPL).
   * Used for Telegram-driven conversational sessions.
   * Optionally sends an initial message after Claude is ready.
   */
  async spawnInteractiveSession(initialMessage?: string, name?: string, options?: { telegramTopicId?: number; slackChannelId?: string; resumeSessionId?: string }): Promise<string> {
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

    // Generate session ID before tmux spawn so we can pass it as env var
    const interactiveSessionId = this.generateId();

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
        '-e', `INSTAR_SESSION_ID=${interactiveSessionId}`, // Expose instar session ID to hook events
        '-e', `INSTAR_SERVER_URL=http://localhost:${this.config.port}`,
        '-e', `INSTAR_AUTH_TOKEN=${this.config.authToken}`,
        '-e', `ANTHROPIC_API_KEY=${this.config.anthropicApiKey ?? ''}`,
        '-e', `ANTHROPIC_BASE_URL=${this.config.anthropicBaseUrl ?? ''}`,
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

      if (options?.slackChannelId) {
        tmuxArgs.push('-e', `INSTAR_SLACK_CHANNEL=${options.slackChannelId}`);
      }

      tmuxArgs.push(this.config.claudePath, '--dangerously-skip-permissions');

      if (options?.resumeSessionId) {
        tmuxArgs.push('--resume', options.resumeSessionId);
        console.log(`[SessionManager] Resuming session: ${options.resumeSessionId}`);
      }

      execFileSync(this.config.tmuxPath, tmuxArgs, { encoding: 'utf-8' });

      // Increase tmux scrollback buffer for dashboard history support
      try {
        execFileSync(this.config.tmuxPath, [
          'set-option', '-t', `=${tmuxSession}:`, 'history-limit', '50000',
        ], { encoding: 'utf-8', timeout: 5000 });
      } catch {
        // @silent-fallback-ok — history-limit is a nice-to-have
      }
    } catch (err) {
      throw new Error(`Failed to create interactive tmux session: ${err}`);
    }

    // Track it in state (with default timeout — interactive sessions shouldn't hang forever)
    const session: Session = {
      id: interactiveSessionId,
      name: name || tmuxSession,
      status: 'running',
      tmuxSession,
      startedAt: new Date().toISOString(),
      prompt: initialMessage,
      maxDurationMinutes: DEFAULT_MAX_DURATION_MINUTES,
    };
    this.state.saveSession(session);

    // Wait for Claude to be ready, then send the initial message.
    // Resume sessions load large JONSLs which trigger TUI redraws — use longer timeout
    // and a stabilization delay to avoid injecting text that gets wiped by the redraw.
    // Fresh sessions also get a generous timeout (90s) to handle slow API auth,
    // large CLAUDE.md loading, and session-start hook execution.
    const readyTimeout = options?.resumeSessionId ? 120_000 : 90_000;
    if (initialMessage) {
      this.waitForClaudeReadyWithRetry(tmuxSession, readyTimeout).then((ready) => {
        if (ready) {
          // Stabilization delay: Claude's TUI may redraw after loading large JONSLs,
          // clearing any text injected too early. Wait for the redraw to settle.
          const stabilizationMs = options?.resumeSessionId ? 5000 : 1000;
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

    // Generate session ID before tmux spawn so we can pass it as env var
    const triageSessionId = this.generateId();

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
        '-e', `INSTAR_SESSION_ID=${triageSessionId}`,
        '-e', `INSTAR_SERVER_URL=http://localhost:${this.config.port}`,
        '-e', `INSTAR_AUTH_TOKEN=${this.config.authToken}`,
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

      // Increase tmux scrollback buffer for dashboard history support
      try {
        execFileSync(this.config.tmuxPath, [
          'set-option', '-t', `=${tmuxSession}:`, 'history-limit', '50000',
        ], { encoding: 'utf-8', timeout: 5000 });
      } catch {
        // @silent-fallback-ok — history-limit is a nice-to-have
      }
    } catch (err) {
      throw new Error(`Failed to create triage tmux session: ${err}`);
    }

    // Track it but with a shorter timeout (triage sessions should be brief)
    const session: Session = {
      id: triageSessionId,
      name,
      status: 'running',
      tmuxSession,
      startedAt: new Date().toISOString(),
      maxDurationMinutes: 10,
    };
    this.state.saveSession(session);

    // Wait for Claude to be ready
    const readyTimeout = options.resumeSessionId ? 120_000 : 90_000;
    await this.waitForClaudeReadyWithRetry(tmuxSession, readyTimeout);

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
  /**
   * Inject a paste notification into a tmux session.
   * Uses the same injection path as Telegram/WhatsApp messages
   * so InputGuard provenance checks apply.
   */
  injectPasteNotification(tmuxSession: string, notification: string): void {
    const FILE_THRESHOLD = 500;

    if (notification.length <= FILE_THRESHOLD) {
      this.injectMessage(tmuxSession, notification);
      return;
    }

    // Write to temp file for large notifications
    const tmpDir = path.join('/tmp', 'instar-paste');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filename = `paste-notify-${Date.now()}-${randomUUID().slice(0, 8)}.txt`;
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, notification);

    const ref = `[paste] Content notification saved to ${filepath} — read it to see the details.`;
    this.injectMessage(tmuxSession, ref);
  }

  injectTelegramMessage(tmuxSession: string, topicId: number, text: string, topicName?: string, senderName?: string, telegramUserId?: number): boolean {
    // Track this injection for response verification.
    // If the session dies before the agent replies, the monitor loop will detect it.
    this.pendingInjections.set(tmuxSession, { topicId, injectedAt: Date.now(), text: text.slice(0, 200) });

    const FILE_THRESHOLD = 500;

    // Transform [image:path] tags into explicit read instructions.
    // Claude Code can natively view images via the Read tool, but only
    // if it knows there's an image file to read.
    let transformed = text.replace(
      /\[image:([^\]]+)\]/g,
      (_, imagePath: string) => {
        if (imagePath === 'download-failed') {
          return '[User sent a photo but the download failed]';
        }
        return `[User sent a photo — read the image file at ${imagePath} to view it. If the image cannot be processed, acknowledge you received it and let the user know the image format may not be supported.]`;
      }
    );

    // Transform [document:path] tags into explicit read instructions.
    transformed = transformed.replace(
      /\[document:([^\]]+)\]/g,
      (_, docPath: string) => {
        if (docPath === 'download-failed') {
          return '[User sent a file but the download failed]';
        }
        return `[User sent a file — it has been saved to ${docPath}. Read the file to view its contents]`;
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
      return this.injectMessage(tmuxSession, taggedText) !== false;
    }

    // Write full message to temp file
    const tmpDir = path.join('/tmp', 'instar-telegram');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filename = `msg-${topicId}-${Date.now()}-${randomUUID().slice(0, 8)}.txt`;
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, taggedText);

    const ref = `[telegram:${topicId}] [Long message saved to ${filepath} — read it to see the full message]`;
    return this.injectMessage(tmuxSession, ref) !== false;
  }

  /**
   * Clear the injection tracker for a topic when the agent sends a reply.
   * Called from the /telegram/reply/:topicId route.
   */
  clearInjectionTracker(topicId: number): void {
    for (const [session, info] of this.pendingInjections) {
      if (info.topicId === topicId) {
        this.pendingInjections.delete(session);
      }
    }
  }

  /**
   * Get all pending injections (for diagnostics / event emission on session death).
   */
  getPendingInjection(tmuxSession: string): { topicId: number; injectedAt: number; text: string } | undefined {
    return this.pendingInjections.get(tmuxSession);
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
   * Inject an iMessage into a tmux session.
   * Tags with [imessage:SENDER] and handles long messages via temp files.
   * Tracks injection for stall detection (uses a synthetic numeric topicId
   * derived from hashing the sender identifier).
   */
  injectIMessageMessage(tmuxSession: string, sender: string, text: string, senderName?: string): void {
    const FILE_THRESHOLD = 500;

    // Generate a stable numeric ID from sender for pendingInjections tracking
    // (pendingInjections uses topicId: number, so we hash the sender string)
    let senderHash = 0;
    for (let i = 0; i < sender.length; i++) {
      senderHash = ((senderHash << 5) - senderHash + sender.charCodeAt(i)) | 0;
    }
    const syntheticTopicId = Math.abs(senderHash);

    this.pendingInjections.set(tmuxSession, { topicId: syntheticTopicId, injectedAt: Date.now(), text: text.slice(0, 200) });

    // Build tag: [imessage:+14081234567 from Justin]
    const safeName = senderName ? senderName.replace(/[\[\]]/g, '') : undefined;
    const nameTag = safeName ? ` from ${safeName}` : '';
    const tag = `[imessage:${sender}${nameTag}]`;
    const taggedText = `${tag} ${text}`;

    if (taggedText.length <= FILE_THRESHOLD) {
      this.injectMessage(tmuxSession, taggedText);
      return;
    }

    // Write full message to temp file with restricted permissions
    const tmpDir = path.join('/tmp', 'instar-imessage');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const senderSlug = sender.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
    const filename = `msg-${senderSlug}-${Date.now()}.txt`;
    const filepath = path.join(tmpDir, filename);
    fs.writeFileSync(filepath, taggedText, { mode: 0o600 });

    const ref = `${tag} [Long message saved to ${filepath} — read it to see the full message]`;
    this.injectMessage(tmuxSession, ref);
  }

  /**
   * Clear the injection tracker for an iMessage sender.
   * Called from the /imessage/reply/:recipient route.
   */
  clearIMessageInjectionTracker(sender: string): void {
    // Compute the same hash used in injectIMessageMessage
    let senderHash = 0;
    for (let i = 0; i < sender.length; i++) {
      senderHash = ((senderHash << 5) - senderHash + sender.charCodeAt(i)) | 0;
    }
    const syntheticTopicId = Math.abs(senderHash);

    for (const [session, info] of this.pendingInjections) {
      if (info.topicId === syntheticTopicId) {
        this.pendingInjections.delete(session);
      }
    }
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
  injectMessage(tmuxSession: string, text: string): boolean {
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
          return false;
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
              return false;
            }
            if (action === 'warn') {
              // Inject the message, then inject warning afterward
              const result = this.rawInject(tmuxSession, text);
              // Small delay so warning arrives after message
              setTimeout(() => {
                const warning = this.inputGuard!.buildWarning(binding, `Matched injection pattern: ${pattern}`);
                this.rawInject(tmuxSession, warning);
              }, 500);
              return result;
            }
            // action === 'log': fall through to normal injection
          }

          // Layer 2: Async LLM topic coherence review (non-blocking)
          // Inject immediately, review in background
          const injected = this.rawInject(tmuxSession, text);
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
          return injected;
        }
        // provenance === 'verified' or 'unbound' — fall through to normal injection
      }
    }

    // ── Normal injection (verified provenance or no InputGuard) ──
    return this.rawInject(tmuxSession, text);
  }

  /**
   * Raw tmux send-keys injection. No validation — just sends text to the session.
   * Used by injectMessage after provenance checks pass.
   */
  private rawInject(tmuxSession: string, text: string): boolean {
    // Reset idle-prompt timer — this session is about to receive new input,
    // so it's not a zombie. Without this, the zombie detector can kill a session
    // that just received a message but hasn't produced output yet.
    const running = this.state.listSessions({ status: 'running' });
    const match = running.find(s => s.tmuxSession === tmuxSession);
    if (match) {
      this.idlePromptSince.delete(match.id);
    }

    const exactTarget = `=${tmuxSession}:`;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
            encoding: 'utf-8', timeout: 10000,
          });
          execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, '\x1b[201~'], {
            encoding: 'utf-8', timeout: 5000,
          });
          // Delay to let the terminal fully process the bracketed paste.
          // 100ms was too short — Claude Code needs time to parse the paste end
          // sequence and buffer the content before Enter can submit it.
          // 500ms is conservative but prevents the "[Pasted text #1]" stuck state.
          execFileSync('/bin/sleep', ['0.5'], { timeout: 2000 });
          // Send Enter to submit
          execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, 'Enter'], {
            encoding: 'utf-8', timeout: 5000,
          });
        } else {
          // Single-line: simple send-keys
          execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, '-l', text], {
            encoding: 'utf-8', timeout: 10000,
          });
          // Send Enter separately
          execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, 'Enter'], {
            encoding: 'utf-8', timeout: 5000,
          });
        }
        return true;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[SessionManager] Failed to inject message into ${tmuxSession} (attempt ${attempt}/${maxAttempts}): ${errMsg}`);
        if (attempt < maxAttempts) {
          // Synchronous sleep between retry attempts. We use execFileSync('/bin/sleep')
          // rather than an async delay because the entire injection path is synchronous:
          // rawInject → injectMessage → injectTelegramMessage all use execFileSync for
          // tmux send-keys. Converting to async would require changing the call chain
          // through multiple callers. The 300ms pause is brief and only hits on failure
          // (max once per injection), so the event loop impact is negligible in practice.
          try { execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 }); } catch { /* ignore */ }
          continue;
        }
        DegradationReporter.getInstance().report({
          feature: 'SessionManager.injectMessage',
          primary: 'Inject Telegram message into tmux session',
          fallback: 'Message delivery failed — caller notified for user-facing error relay',
          reason: `Failed to inject message after ${maxAttempts} attempts: ${errMsg}`,
          impact: 'User message not delivered to session',
        });
        return false;
      }
    }
    return false;
  }

  /**
   * Wait for Claude to be ready in a tmux session by polling output.
   * Looks for Claude Code's prompt character (❯) which appears when ready for input.
   */
  async waitForClaudeReady(tmuxSession: string, timeoutMs: number = 30000): Promise<boolean> {
    const start = Date.now();
    // Wait a minimum startup delay before checking (Claude needs time to load)
    await new Promise(r => setTimeout(r, 3000));
    while (Date.now() - start < timeoutMs) {
      if (!this.tmuxSessionExists(tmuxSession)) {
        console.error(`[SessionManager] Session "${tmuxSession}" died during startup`);
        return false;
      }
      if (this.detectClaudePrompt(tmuxSession)) {
        console.log(`[SessionManager] Claude ready in "${tmuxSession}" after ${Date.now() - start}ms`);
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    // Log what we see on timeout for debugging
    const finalOutput = this.captureOutput(tmuxSession, 30);
    console.error(`[SessionManager] Claude not ready in "${tmuxSession}" after ${timeoutMs}ms. Output: ${(finalOutput || '').slice(-300)}`);
    return false;
  }

  /**
   * Detect whether Claude Code's prompt is visible in a tmux session.
   * Also auto-accepts consent dialogs that block startup.
   *
   * Checks multiple indicators across a wider capture window to handle
   * varying TUI layouts (different terminal sizes, large banners, etc.)
   */
  private detectClaudePrompt(tmuxSession: string): boolean {
    // Capture a generous window — Claude Code's TUI can have many blank lines
    // below the prompt in large panes. Using only 5 lines risks missing content.
    const output = this.captureOutput(tmuxSession, 20);
    if (!output) return false;

    const lines = output.split('\n').filter(l => l.trim());
    if (lines.length === 0) return false;

    // Auto-accept consent/ToS dialogs that block startup.
    // Claude Code shows "1. No, exit / 2. Yes, I accept" on first run or after updates.
    // If we don't accept, any injected text selects "No" and crashes the session.
    const fullText = lines.join('\n');
    if (fullText.includes('Yes, I accept') && fullText.includes('No, exit')) {
      console.log(`[SessionManager] Consent dialog detected in "${tmuxSession}" — auto-accepting`);
      try {
        // Press Down to select "Yes, I accept", then Enter to confirm
        execFileSync(this.config.tmuxPath, ['send-keys', '-t', `=${tmuxSession}:`, 'Down'], {
          encoding: 'utf-8', timeout: 5000,
        });
        execFileSync(this.config.tmuxPath, ['send-keys', '-t', `=${tmuxSession}:`, 'Enter'], {
          encoding: 'utf-8', timeout: 5000,
        });
      } catch {
        // Best-effort — if this fails, the session will be stuck but not crashed
      }
      return false; // Not ready yet — will be ready on next poll
    }

    // Check the last 6 non-blank lines for readiness indicators.
    // Claude Code's TUI shows: prompt (❯), status bar (bypass permissions / model info),
    // and separators. Using a wider tail catches all of these even when
    // blank lines or separators push them around.
    const tail = lines.slice(-6).join('\n');

    // Primary: the prompt character
    if (tail.includes('❯')) return true;

    // Secondary: permission mode indicators (visible in status bar)
    if (tail.includes('bypass permissions')) return true;

    // Tertiary: model/effort indicators in the status bar
    // These appear when Claude Code has fully loaded and is ready for input.
    if (/\/(effort|model|fast)/.test(tail)) return true;

    // Quaternary: the "medium · /effort" or "high · /effort" pattern
    if (/(?:low|medium|high)\s*·\s*\/effort/.test(tail)) return true;

    return false;
  }

  /**
   * Wait for Claude to be ready with a two-phase approach:
   * 1. Primary wait: poll for the prompt within the timeout
   * 2. Extended wait: if the session is alive but prompt wasn't detected,
   *    do a final longer check — Claude may have just finished loading
   *
   * This handles cases where Claude Code takes longer than expected due to
   * API auth refresh, large CLAUDE.md parsing, session-start hooks, or
   * network latency. The extended phase catches sessions that are "almost ready."
   */
  private async waitForClaudeReadyWithRetry(tmuxSession: string, timeoutMs: number): Promise<boolean> {
    const ready = await this.waitForClaudeReady(tmuxSession, timeoutMs);
    if (ready) return true;

    // Session not ready after primary timeout — check if it's still alive
    if (!this.tmuxSessionExists(tmuxSession)) {
      return false;
    }

    // Extended wait: the session is alive but prompt wasn't detected.
    // Give it one more chance with a 15-second grace period.
    // This catches the case where Claude Code was almost done loading
    // when the primary timeout hit.
    console.log(`[SessionManager] Session "${tmuxSession}" alive after primary timeout — starting 15s extended wait`);
    const extendedStart = Date.now();
    while (Date.now() - extendedStart < 15_000) {
      if (!this.tmuxSessionExists(tmuxSession)) {
        return false;
      }
      if (this.detectClaudePrompt(tmuxSession)) {
        console.log(`[SessionManager] Claude ready in "${tmuxSession}" during extended wait (${Date.now() - extendedStart}ms after primary timeout)`);
        return true;
      }
      await new Promise(r => setTimeout(r, 1000));
    }

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
