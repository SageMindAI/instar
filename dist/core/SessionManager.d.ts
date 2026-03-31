/**
 * Session Manager — spawn and monitor Claude Code sessions via tmux.
 *
 * This is the core capability that transforms Claude Code from a CLI tool
 * into a persistent agent. Sessions run in tmux, survive terminal disconnects,
 * and can be monitored/reaped by the server.
 */
import { EventEmitter } from 'node:events';
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
import { InputGuard } from './InputGuard.js';
import type { InputDetector } from '../monitoring/PromptGate.js';
import type { Session, SessionManagerConfig, ModelTier } from './types.js';
import { StateManager } from './StateManager.js';
export interface SessionManagerEvents {
    sessionComplete: [session: Session];
}
export declare class SessionManager extends EventEmitter {
    private config;
    private state;
    private monitorInterval;
    private monitoringInProgress;
    private inputGuard;
    private registryPath;
    /** Track when each session was first seen idle at the Claude prompt. Key = session ID */
    private idlePromptSince;
    /** Throttle stale session cleanup to every 5 minutes */
    private lastCleanupAt;
    /** Optional callback to check if a session has active subagents (prevents false zombie kills) */
    private subagentChecker?;
    /** Prompt Gate InputDetector — monitors terminal output for interactive prompts */
    private promptDetector?;
    /** Sessions with active relay leases (prompt relayed, waiting for response) — extends idle timeout */
    private relayLeases;
    /** Track pending Telegram injections awaiting agent response.
     *  Key = tmuxSession name. Cleared when agent replies via /telegram/reply/:topicId. */
    private pendingInjections;
    /** Track sessions that have been nudged after an API error.
     *  Key = session ID. Prevents infinite nudge loops — each session gets ONE nudge.
     *  If it goes idle again after the nudge, the zombie detector kills it normally. */
    private errorNudgedSessions;
    /** Sessions where we've already retried Enter for stuck pasted text.
     *  Key = session ID. Prevents infinite retry loops — one retry per session. */
    private pasteRetried;
    /** Cached count of running sessions, updated asynchronously by the monitor tick.
     *  Used by the health endpoint to avoid synchronous tmux polling. */
    private _cachedRunningCount;
    private _cachedRunningSessions;
    constructor(config: SessionManagerConfig, state: StateManager);
    /**
     * Set the InputGuard for cross-topic injection defense.
     * Must be called after construction with state dir info.
     */
    setInputGuard(guard: InputGuard, registryPath: string): void;
    /**
     * Set the subagent checker callback for zombie cleanup awareness.
     * When set, the zombie cleanup will skip sessions that have active subagents.
     * Must be called after SubagentTracker is constructed.
     */
    setSubagentChecker(checker: (session: Session) => boolean): void;
    /**
     * Set the Prompt Gate InputDetector for prompt monitoring.
     * When set, monitorTick() will capture output and feed it to the detector.
     */
    setPromptDetector(detector: InputDetector): void;
    /**
     * Grant a relay lease to a session — extends idle timeout while waiting for
     * a Telegram relay response. Prevents the zombie killer from killing sessions
     * that are legitimately waiting for user input.
     */
    grantRelayLease(sessionId: string, durationMs: number): void;
    /**
     * Clear a relay lease (prompt was answered or timed out).
     */
    clearRelayLease(sessionId: string): void;
    /**
     * Associate a Claude Code session UUID with an instar session.
     * Called when the first hook event arrives from a Claude Code session,
     * allowing SubagentTracker lookups to bridge the two ID spaces.
     */
    setClaudeSessionId(instarSessionId: string, claudeSessionId: string): void;
    /**
     * Find a running session by its instar session ID.
     */
    getSessionById(instarSessionId: string): Session | undefined;
    /**
     * Look up the topic binding for a tmux session from the topic-session registry.
     * Returns null if the session is not bound to any topic.
     */
    private getTopicBinding;
    /**
     * Start polling for completed sessions. Emits 'sessionComplete' when
     * a running session's tmux process disappears.
     *
     * Uses async tmux calls to avoid blocking the event loop when
     * many sessions are running.
     */
    startMonitoring(intervalMs?: number): void;
    private monitorTick;
    /**
     * Stop the monitoring poll.
     */
    stopMonitoring(): void;
    /**
     * Spawn a new Claude Code session in tmux.
     */
    spawnSession(options: {
        name: string;
        prompt: string;
        model?: ModelTier;
        jobSlug?: string;
        triggeredBy?: string;
        maxDurationMinutes?: number;
    }): Promise<Session>;
    /**
     * Check if a session is still running by checking tmux AND verifying
     * that the Claude process is running inside (not a zombie tmux pane).
     */
    isSessionAlive(tmuxSession: string): boolean;
    /**
     * Check if a session is still running by checking tmux AND verifying
     * that the Claude process is running inside (async version).
     * Used by the monitoring loop to avoid blocking the event loop.
     *
     * Previously only checked `tmux has-session` which missed zombie sessions
     * where tmux was alive but Claude had exited — causing stuck sessions
     * that blocked the scheduler for hours.
     */
    private isSessionAliveAsync;
    /**
     * Kill a session by terminating its tmux session.
     */
    killSession(sessionId: string): boolean;
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
    hasActiveProcesses(tmuxSession: string): boolean;
    /**
     * Capture the current output of a tmux session.
     */
    captureOutput(tmuxSession: string, lines?: number): string | null;
    /**
     * Send input to a running tmux session.
     */
    sendInput(tmuxSession: string, input: string): boolean;
    /**
     * Send a tmux key sequence (without -l literal flag).
     * Use for special keys like 'C-c' (Ctrl+C), 'Enter', 'Escape'.
     * Unlike sendInput() which uses -l (literal), this sends key names directly.
     */
    sendKey(tmuxSession: string, key: string): boolean;
    /**
     * List all sessions that are currently running.
     * Pure filter — does not mutate state. The monitor tick handles lifecycle transitions.
     * WARNING: This calls synchronous tmux has-session for each session.
     * For health checks and non-critical callers, prefer getCachedRunningSessions().
     */
    listRunningSessions(): Session[];
    /**
     * Get cached running session info (count + list) without blocking the event loop.
     * Updated asynchronously by the monitor tick every 5 seconds.
     * Safe to call from the health endpoint and other latency-sensitive paths.
     */
    getCachedRunningSessions(): {
        count: number;
        sessions: Session[];
    };
    /**
     * Fast startup purge — immediately remove session records for dead tmux sessions.
     * Called once at server boot BEFORE monitoring starts, to prevent the death spiral
     * where stale sessions overwhelm startup and block health checks.
     * Uses a short timeout (1s) per session to fail fast.
     */
    purgeDeadSessions(): Promise<number>;
    /**
     * Get diagnostics for all running sessions, including staleness detection
     * and memory pressure. Used by the scheduler to build intelligent notifications
     * when jobs are blocked by session limits.
     */
    getSessionDiagnostics(): SessionDiagnostics;
    /**
     * Detect if a session has completed by checking output patterns.
     */
    detectCompletion(tmuxSession: string): boolean;
    /**
     * Reap completed/zombie sessions.
     */
    reapCompletedSessions(): string[];
    /**
     * Remove stale session state files for sessions that have been
     * killed or completed beyond the retention period.
     * Killed sessions: removed after 1 hour.
     * Completed sessions: removed after 24 hours.
     */
    cleanupStaleSessions(): string[];
    /**
     * Spawn an interactive Claude Code session (no -p prompt — opens at the REPL).
     * Used for Telegram-driven conversational sessions.
     * Optionally sends an initial message after Claude is ready.
     */
    spawnInteractiveSession(initialMessage?: string, name?: string, options?: {
        telegramTopicId?: number;
        resumeSessionId?: string;
    }): Promise<string>;
    /**
     * Spawn a scoped triage session with restricted tool access.
     * Unlike interactive sessions, triage sessions use --allowedTools + --permission-mode dontAsk
     * instead of --dangerously-skip-permissions. This gives them read-only access.
     *
     * Used by TriageOrchestrator for behind-the-scenes session investigation.
     */
    spawnTriageSession(name: string, options: {
        allowedTools: string[];
        permissionMode: string;
        resumeSessionId?: string;
    }): Promise<string>;
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
    injectPasteNotification(tmuxSession: string, notification: string): void;
    injectTelegramMessage(tmuxSession: string, topicId: number, text: string, topicName?: string, senderName?: string, telegramUserId?: number): void;
    /**
     * Clear the injection tracker for a topic when the agent sends a reply.
     * Called from the /telegram/reply/:topicId route.
     */
    clearInjectionTracker(topicId: number): void;
    /**
     * Get all pending injections (for diagnostics / event emission on session death).
     */
    getPendingInjection(tmuxSession: string): {
        topicId: number;
        injectedAt: number;
        text: string;
    } | undefined;
    /**
     * Inject a WhatsApp message into a tmux session.
     * Tags with [whatsapp:JID] and handles long messages via temp files.
     */
    injectWhatsAppMessage(tmuxSession: string, jid: string, text: string, senderName?: string): void;
    /**
     * Inject an iMessage into a tmux session.
     * Tags with [imessage:SENDER] and handles long messages via temp files.
     * Tracks injection for stall detection (uses a synthetic numeric topicId
     * derived from hashing the sender identifier).
     */
    injectIMessageMessage(tmuxSession: string, sender: string, text: string, senderName?: string): void;
    /**
     * Clear the injection tracker for an iMessage sender.
     * Called from the /imessage/reply/:recipient route.
     */
    clearIMessageInjectionTracker(sender: string): void;
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
    injectMessage(tmuxSession: string, text: string): void;
    /**
     * Raw tmux send-keys injection. No validation — just sends text to the session.
     * Used by injectMessage after provenance checks pass.
     */
    private rawInject;
    /**
     * Wait for Claude to be ready in a tmux session by polling output.
     * Looks for Claude Code's prompt character (❯) which appears when ready for input.
     */
    waitForClaudeReady(tmuxSession: string, timeoutMs?: number): Promise<boolean>;
    /**
     * Detect whether Claude Code's prompt is visible in a tmux session.
     * Also auto-accepts consent dialogs that block startup.
     *
     * Checks multiple indicators across a wider capture window to handle
     * varying TUI layouts (different terminal sizes, large banners, etc.)
     */
    private detectClaudePrompt;
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
    private waitForClaudeReadyWithRetry;
    tmuxSessionExists(name: string): boolean;
    private generateId;
}
//# sourceMappingURL=SessionManager.d.ts.map