/**
 * Telegram Lifeline — minimal persistent process that owns the Telegram connection.
 *
 * Architecture:
 *   Lifeline (this process)
 *     ├── Telegram Bot polling (always running)
 *     ├── Message queue (persisted to disk)
 *     └── Server Supervisor (manages full Instar server as child)
 *
 * The lifeline is intentionally minimal — it only handles:
 *   1. Telegram message polling
 *   2. Forwarding messages to the server
 *   3. Queuing messages when server is down
 *   4. Replaying queued messages when server recovers
 *   5. Responding to /lifeline commands directly
 *   6. Supervising the server process
 *
 * This ensures the user always has a communication channel even when
 * the full server crashes, runs out of memory, or gets stuck.
 */
export declare class TelegramLifeline {
    private config;
    private projectConfig;
    private queue;
    private supervisor;
    private polling;
    private lastUpdateId;
    private pollTimeout;
    private offsetPath;
    private stopHeartbeat;
    private replayInterval;
    private lifelineTopicId;
    private lockPath;
    private consecutive409s;
    private consecutive429s;
    private pollBackoffMs;
    private activeDoctorSession;
    private activeDoctorSecret;
    private doctorSessionTimeout;
    constructor(projectDir?: string);
    /**
     * Start the lifeline — begins Telegram polling and server supervision.
     */
    start(): Promise<void>;
    /**
     * Flush stale Telegram connections on startup.
     * After a hard kill or sleep/wake, a previous long-poll getUpdates call may
     * still be active on Telegram's side. This causes 409 Conflict errors until
     * the old connection times out (~30s). We claim the polling slot immediately
     * with a non-blocking getUpdates call (timeout=0), which invalidates any
     * stale long-poll connection.
     */
    private flushStaleConnection;
    private poll;
    private processUpdate;
    /**
     * Handle an incoming photo message: download it and forward/queue with [image:path] content.
     */
    private handlePhotoMessage;
    /**
     * Download a photo from Telegram and save it to the state directory.
     */
    private downloadPhoto;
    /**
     * Download a document from Telegram and save it to the state directory.
     * Preserves the original filename when available.
     */
    private downloadDocument;
    /**
     * Handle an incoming document message: download it and forward/queue with [document:path] content.
     */
    private handleDocumentMessage;
    /**
     * Forward an inline keyboard callback query to the server for processing.
     * Prompt Gate relay buttons generate these when the user taps a button.
     */
    private forwardCallbackQuery;
    /**
     * Forward a message to the Instar server's Telegram webhook.
     */
    private forwardToServer;
    private handleLifelineCommand;
    /** Max times a message can fail replay before being dropped. */
    private static readonly MAX_REPLAY_FAILURES;
    private replayQueue;
    /** Whether we've already notified for the current outage. Reset on recovery. */
    private hasNotifiedServerDown;
    /** Suppressed "server down" count during current outage. */
    private suppressedServerDownCount;
    /** Timestamp of last "server down" notification sent (for cross-outage rate limiting). */
    private lastServerDownNotifyAt;
    /** Minimum interval between "server down" notifications, even across separate outages (30 min). */
    private static readonly SERVER_DOWN_COOLDOWN_MS;
    /** Per-topic timestamps for rate-limiting queue acknowledgment messages. */
    private lastQueueAckAt;
    /** Minimum interval between "your message has been queued" acks per topic (2 minutes). */
    private static readonly QUEUE_ACK_RATE_LIMIT_MS;
    /** Queue size threshold above which ack messages are suppressed entirely. */
    private static readonly QUEUE_ACK_SUPPRESS_THRESHOLD;
    /**
     * Load persisted rate limit state from disk.
     * Before v0.12.10, this was in-memory only — every process restart
     * reset the counter, causing "server went down" spam during update loops.
     */
    private loadRateLimitState;
    private saveRateLimitState;
    /**
     * Check if a queue acknowledgment should be sent for this topic.
     * Rate-limits acks to prevent Telegram spam during restart loops.
     */
    private shouldSendQueueAck;
    private notifyServerDown;
    private notifyCircuitBroken;
    /**
     * Handle `/lifeline doctor` — spawn a Claude Code diagnostic session.
     */
    private handleDoctorCommand;
    /**
     * Sanitize log content by stripping ANSI codes and redacting secrets.
     */
    private sanitizeLogContent;
    /**
     * Write sanitized diagnostic context to a file for the doctor session.
     */
    private writeDiagnosticContext;
    /**
     * Spawn a Claude Code diagnostic session in tmux.
     * Returns the session name and HMAC secret for restart authentication.
     */
    private spawnDoctorSession;
    /**
     * Read the last N lines from a file, using seek-based reading for large files.
     */
    private readTailStream;
    /**
     * Find an existing doctor tmux session for this project.
     */
    private findExistingDoctorSession;
    /**
     * Check if `--allowedTools` is supported by the installed Claude Code version.
     */
    private supportsAllowedTools;
    /**
     * Log a doctor session to the audit trail.
     */
    private logDoctorSession;
    /**
     * Kill a doctor tmux session and notify via Telegram.
     */
    private killDoctorSession;
    /**
     * Check if OS-level autostart is installed for this project.
     */
    private isAutostartInstalled;
    /**
     * Self-heal the launchd plist if it uses a hardcoded Node path instead of the boot wrapper.
     *
     * Older agents (pre-boot-wrapper) had plists pointing directly to a Node binary path like
     * /Users/x/.asdf/installs/nodejs/24.13.1/bin/instar. When Node versions change (asdf, nvm),
     * the path breaks and the agent becomes unrecoverable after a reboot or restart.
     *
     * The boot wrapper pattern resolves the shadow install at runtime — immune to Node version changes.
     * If the plist doesn't use the boot wrapper, regenerate both the wrapper and the plist.
     */
    private selfHealPlist;
    /**
     * Ensure the Lifeline topic exists. Recreates if deleted.
     */
    private ensureLifelineTopic;
    /**
     * Persist the Lifeline topic ID to config.json.
     */
    private persistLifelineTopicId;
    private sendToTopic;
    private getUpdates;
    private apiCall;
    private loadOffset;
    private saveOffset;
}
//# sourceMappingURL=TelegramLifeline.d.ts.map