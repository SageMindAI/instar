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

const execFileAsync = promisify(execFile);
import type { Session, SessionManagerConfig, SessionStatus, ModelTier } from './types.js';
import { StateManager } from './StateManager.js';

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

  constructor(config: SessionManagerConfig, state: StateManager) {
    super();
    this.config = config;
    this.state = state;
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
            } catch { /* ignore */ }
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
        '-e', 'CLAUDECODE=',
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
      // If we can't check, fall back to tmux session existence
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
  async spawnInteractiveSession(initialMessage?: string, name?: string, options?: { telegramTopicId?: number }): Promise<string> {
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
      ];

      if (options?.telegramTopicId) {
        tmuxArgs.push('-e', `INSTAR_TELEGRAM_TOPIC=${options.telegramTopicId}`);
      }

      tmuxArgs.push(this.config.claudePath, '--dangerously-skip-permissions');

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
    if (initialMessage) {
      this.waitForClaudeReady(tmuxSession).then((ready) => {
        if (ready) {
          this.injectMessage(tmuxSession, initialMessage);
          console.log(`[SessionManager] Injected initial message into "${tmuxSession}" (${initialMessage.length} chars)`);
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
   * Inject a Telegram message into a tmux session.
   * Short messages go via send-keys; long messages are written to a temp file.
   */
  injectTelegramMessage(tmuxSession: string, topicId: number, text: string): void {
    const FILE_THRESHOLD = 500;
    const taggedText = `[telegram:${topicId}] ${text}`;

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
   * Send text to a tmux session via send-keys.
   * For single-line text, uses -l (literal) flag directly.
   * For multi-line text, writes to a temp file and uses tmux load-buffer/paste-buffer
   * to avoid newlines being interpreted as Enter keypresses.
   */
  private injectMessage(tmuxSession: string, text: string): void {
    const exactTarget = `=${tmuxSession}:`;
    try {
      if (text.includes('\n')) {
        // Multi-line: write to temp file, load into tmux buffer, paste into pane.
        // This avoids newlines being treated as Enter keypresses which would
        // fragment the message into multiple Claude prompts.
        const tmpDir = path.join('/tmp', 'instar-inject');
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmpPath = path.join(tmpDir, `msg-${Date.now()}-${process.pid}.txt`);
        fs.writeFileSync(tmpPath, text);
        try {
          execFileSync(this.config.tmuxPath, ['load-buffer', tmpPath], {
            encoding: 'utf-8', timeout: 5000,
          });
          execFileSync(this.config.tmuxPath, ['paste-buffer', '-t', exactTarget, '-p'], {
            encoding: 'utf-8', timeout: 5000,
          });
          // Brief delay to let the terminal process the paste before sending Enter.
          // Without this, the Enter arrives before paste processing completes and
          // the message sits in the input buffer without being submitted.
          execFileSync('/bin/sleep', ['0.3'], { timeout: 2000 });
          // Send Enter to submit
          execFileSync(this.config.tmuxPath, ['send-keys', '-t', exactTarget, 'Enter'], {
            encoding: 'utf-8', timeout: 5000,
          });
        } finally {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        }
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
      const output = this.captureOutput(tmuxSession, 10);
      // Check for Claude Code's specific prompt character (❯)
      // Avoid matching generic shell prompts (> and $) which cause false positives
      if (output && output.includes('❯')) {
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

  private tmuxSessionExists(name: string): boolean {
    try {
      execFileSync(this.config.tmuxPath, ['has-session', '-t', `=${name}`], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private generateId(): string {
    return randomUUID();
  }
}
