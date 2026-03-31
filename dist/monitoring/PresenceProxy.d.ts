/**
 * PresenceProxy — Intelligent Response Standby
 *
 * Monitors the gap between user messages and agent responses on Telegram,
 * providing tiered, LLM-generated status updates on the agent's behalf.
 *
 * Tier 1 (20s):  Haiku summarizes what the agent is doing
 * Tier 2 (2min): Haiku compares progress since Tier 1
 * Tier 3 (5min): Sonnet assesses if the agent is genuinely stuck
 *
 * All messages prefixed with 🔭 [Standby] to distinguish from agent responses.
 * Proxy messages do NOT count as agent responses for StallDetector.
 */
import type { IntelligenceProvider } from '../core/types.js';
import type { MessageLoggedEvent } from '../messaging/shared/MessagingEventBus.js';
export interface PresenceProxyConfig {
    stateDir: string;
    intelligence: IntelligenceProvider;
    agentName: string;
    captureSessionOutput: (sessionName: string, lines?: number) => string | null;
    getSessionForTopic: (topicId: number) => string | null;
    isSessionAlive: (sessionName: string) => boolean;
    sendMessage: (topicId: number, text: string, metadata?: ProxyMetadata) => Promise<void>;
    getAuthorizedUserIds: () => number[];
    getProcessTree: (sessionName: string) => ProcessInfo[];
    /** Check if agent sent any message to this topic after the given timestamp. Prevents race conditions. */
    hasAgentRespondedSince?: (topicId: number, sinceMs: number) => boolean;
    acquireTriageMutex?: (sessionName: string, holder: string) => boolean;
    releaseTriageMutex?: (sessionName: string, holder: string) => void;
    isTriageMutexHeld?: (sessionName: string) => string | null;
    triggerManualTriage?: (topicId: number, sessionName: string) => Promise<void>;
    tier1DelayMs?: number;
    tier2DelayMs?: number;
    tier3DelayMs?: number;
    tier3RecheckDelayMs?: number;
    silenceDurationMs?: number;
    tier1Model?: 'fast' | 'balanced' | 'capable';
    tier2Model?: 'fast' | 'balanced' | 'capable';
    tier3Model?: 'fast' | 'balanced' | 'capable';
    maxTmuxLines?: {
        t1: number;
        t2: number;
        t3: number;
    };
    llmTimeoutMs?: {
        t1: number;
        t2: number;
        t3: number;
    };
    llmRateLimit?: {
        perTopicPerHour: number;
        tier3MaxRechecks: number;
        autoSilenceMinutes: number;
    };
    concurrentLlmCalls?: number;
    allowExternalLlm?: boolean;
    credentialPatterns?: string[];
    prefix?: string;
    conversationHistoryMax?: number;
    __dev_timerMultiplier?: number;
}
export interface ProxyMetadata {
    source: 'presence-proxy';
    tier: number;
    isProxy: true;
}
export interface ProcessInfo {
    pid: number;
    command: string;
    elapsed?: string;
}
interface PresenceState {
    topicId: number;
    sessionName: string;
    userMessageAt: number;
    userMessageText: string;
    tier1FiredAt: number | null;
    tier1Snapshot: string | null;
    tier1SnapshotHash: string | null;
    tier2FiredAt: number | null;
    tier2Snapshot: string | null;
    tier2SnapshotHash: string | null;
    tier3FiredAt: number | null;
    tier3Assessment: 'working' | 'waiting' | 'stalled' | 'dead' | null;
    tier3Summary: string | null;
    tier3RecheckCount: number;
    silencedUntil: number | null;
    cancelled: boolean;
    llmCallCount: number;
    lastLlmCallAt: number;
    conversationHistory: Array<{
        role: 'user' | 'proxy';
        text: string;
        timestamp: number;
    }>;
}
export declare function sanitizeTmuxOutput(raw: string, extraPatterns?: string[]): string;
export declare function guardProxyOutput(text: string): {
    safe: boolean;
    reason?: string;
};
/**
 * Check if terminal output indicates quota exhaustion.
 * Returns a human-friendly message if detected, null otherwise.
 *
 * Only checks the LAST 15 lines of the snapshot to avoid false positives
 * from historical quota errors that the session already recovered from.
 * Quota errors are terminal — if the session recovered and kept working,
 * the error scrolls up and out of the recent window.
 */
export declare function detectQuotaExhaustion(snapshot: string): string | null;
export declare class PresenceProxy {
    private config;
    private states;
    private timers;
    private llmQueue;
    private stateDir;
    private started;
    private tier1DelayMs;
    private tier2DelayMs;
    private tier3DelayMs;
    private tier3RecheckDelayMs;
    private silenceDurationMs;
    private prefix;
    private maxConversationHistory;
    private rateLimit;
    constructor(config: PresenceProxyConfig);
    start(): void;
    stop(): void;
    /**
     * Called when a message is logged. Starts/resets timers for user messages,
     * cancels proxy for agent messages.
     */
    onMessageLogged(event: MessageLoggedEvent): void;
    /**
     * Handle user commands: unstick, restart, quiet, resume
     */
    handleCommand(topicId: number, command: string, userId: number): Promise<boolean>;
    private handleUserMessage;
    private handleAgentMessage;
    private scheduleTier;
    private fireTier;
    private fireTier1;
    private fireTier2;
    private fireTier3;
    private handleQuiet;
    private handleResume;
    private handleUnstick;
    private handleRestart;
    private buildTier1Prompt;
    private buildConversationPrompt;
    private buildTier2Prompt;
    private buildTier3Prompt;
    private callLlm;
    private sendProxyMessage;
    /** System/delivery messages that should NOT be treated as real agent responses */
    private isSystemMessage;
    private checkRateLimit;
    private clearTimersForTopic;
    private cleanupState;
    private persistState;
    private recoverFromRestart;
    getState(topicId: number): PresenceState | undefined;
    getActiveTopics(): number[];
}
export {};
//# sourceMappingURL=PresenceProxy.d.ts.map