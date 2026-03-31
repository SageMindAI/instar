/**
 * Server Supervisor — manages the full Instar server as a child process.
 *
 * Starts, monitors, and auto-restarts the server. Reports health status
 * back to the lifeline so it can inform users via Telegram.
 *
 * The supervisor spawns the server in a tmux session (same as `instar server start`)
 * and monitors it via health checks.
 *
 * RESTART ARCHITECTURE (v0.9.63):
 * The server NEVER restarts itself. When the AutoUpdater installs an update,
 * it writes a `restart-requested.json` flag. The supervisor detects this flag
 * during its health check polling and performs a graceful restart. This eliminates
 * the entire category of self-restart bugs (PATH mismatch, launchd confusion,
 * binary resolution failures, restart loops).
 */
import { EventEmitter } from 'node:events';
export interface SupervisorEvents {
    serverUp: [];
    serverDown: [reason: string];
    serverRestarting: [attempt: number];
    circuitBroken: [totalFailures: number, lastCrashOutput: string];
    debugRestartRequested: [request: {
        fixDescription: string;
        requestedBy: string;
    }];
    debugRestartSkipped: [info: {
        fixDescription: string;
        reason: string;
    }];
    /** Emitted when the server recovers after a planned update restart.
     *  The lifeline should self-restart to pick up new code from the shadow install. */
    updateApplied: [targetVersion: string];
}
export declare class ServerSupervisor extends EventEmitter {
    private projectDir;
    private projectName;
    private port;
    private tmuxPath;
    private serverSessionName;
    private healthCheckInterval;
    private lastHealthCheckAt;
    private readonly sleepWakeGapMs;
    private restartAttempts;
    private maxRestartAttempts;
    private restartBackoffMs;
    private isRunning;
    private lastHealthy;
    private startupGraceMs;
    private spawnedAt;
    private retryCooldownMs;
    private maxRetriesExhaustedAt;
    private consecutiveFailures;
    private readonly unhealthyThreshold;
    private stateDir;
    private maintenanceWaitStartedAt;
    private maintenanceWaitMs;
    private pendingUpdateVersion;
    private totalFailures;
    private totalFailureWindowStart;
    private readonly circuitBreakerThreshold;
    private readonly circuitBreakerWindowMs;
    private circuitBroken;
    private circuitBreakerTrippedAt;
    private circuitBreakerRetryCount;
    private readonly circuitBreakerRetryIntervalMs;
    private readonly maxCircuitBreakerRetries;
    private readonly slowRetryIntervalMs;
    private slowRetryStartedAt;
    private lastCrashOutput;
    private doctorSessionSecret;
    private sleepWakeDetector;
    private wakeTransitionUntil;
    private readonly wakeTransitionMs;
    constructor(options: {
        projectDir: string;
        projectName: string;
        port: number;
        stateDir?: string;
        /** How long to wait for server recovery during a planned restart before alerting. Default: 5 minutes. */
        maintenanceWaitMinutes?: number;
        /** How long to wait after spawning before starting health checks. Default: 180 seconds (3 minutes). */
        startupGraceSeconds?: number;
    });
    /**
     * Start the server and begin monitoring.
     */
    start(): Promise<boolean>;
    /**
     * Stop the server and monitoring.
     */
    stop(): Promise<void>;
    /**
     * Check if the server is currently healthy.
     */
    get healthy(): boolean;
    /**
     * Get supervisor status.
     */
    getStatus(): {
        running: boolean;
        healthy: boolean;
        restartAttempts: number;
        lastHealthy: number;
        serverSession: string;
        coolingDown: boolean;
        cooldownRemainingMs: number;
        circuitBroken: boolean;
        totalFailures: number;
        lastCrashOutput: string;
        circuitBreakerRetryCount: number;
        maxCircuitBreakerRetries: number;
        inMaintenanceWait: boolean;
        maintenanceWaitElapsedMs: number;
        inWakeTransition: boolean;
        wakeTransitionRemainingMs: number;
    };
    /**
     * Reset the circuit breaker — allows restart attempts to resume.
     * Call this after fixing the underlying issue (e.g., via /lifeline restart).
     */
    resetCircuitBreaker(): void;
    /**
     * Set the HMAC secret for validating doctor session restart requests.
     * Called by TelegramLifeline when a doctor session is spawned.
     */
    setDoctorSessionSecret(secret: string): void;
    /**
     * Gracefully restart the server: capture output, kill tmux session,
     * clean up child processes, then spawn fresh.
     *
     * Used by: restart-request handling (auto-update), /lifeline restart command.
     */
    performGracefulRestart(reason: string): Promise<boolean>;
    /**
     * Run preflight checks and attempt to fix broken prerequisites.
     * Returns a summary of what was healed (empty string if nothing needed fixing).
     */
    private preflightSelfHeal;
    /**
     * Find a working npm binary. Checks common locations.
     */
    private findNpmPath;
    /**
     * Find a working node binary. Checks common locations.
     */
    private findNodePath;
    private spawnServer;
    private isServerSessionAlive;
    private startHealthChecks;
    private stopHealthChecks;
    private checkHealth;
    /**
     * Check if the server (AutoUpdater) has requested a restart.
     * Called during the health check loop. If a valid request exists,
     * initiate a graceful restart of the server tmux session.
     */
    private checkRestartRequest;
    /**
     * Check if a doctor session has requested a restart via HMAC-signed file.
     * Called during the health check loop alongside checkRestartRequest().
     */
    private checkDebugRestartRequest;
    /**
     * Validate HMAC on a debug restart request using the doctor session secret.
     */
    private validateRestartHmac;
    private handleUnhealthy;
    /**
     * Capture crash output from multiple sources:
     * 1. tmux pane capture (last 50 lines of terminal output)
     * 2. stderr crash log file (tee'd from server process)
     */
    private captureCrashOutput;
    /**
     * Kill child processes (cloudflared, etc.) that were spawned by the server
     * but will become orphans when the tmux session is killed.
     */
    private cleanupChildProcesses;
    /**
     * Check for the legacy update-restart.json flag (written by old AutoUpdater versions).
     * New versions write restart-requested.json instead, handled by checkRestartRequest().
     */
    private isLegacyPlannedRestart;
    private clearLegacyRestartFlag;
    /**
     * Check if a planned restart is in progress.
     *
     * Two sources of truth (covers both race scenarios):
     * 1. Internal state: set by checkRestartRequest() when it sees plannedRestart: true
     * 2. Planned-exit marker: written by ForegroundRestartWatcher before process.exit()
     *    when it consumed the restart-requested.json before us
     *
     * Auto-expires after maintenanceWaitMs (default 5 min). If the server doesn't
     * come back within the window, fall back to normal alerting.
     */
    private isPendingPlannedRestart;
    /**
     * Clean up the planned-exit marker written by ForegroundRestartWatcher.
     */
    private clearPlannedExitMarker;
}
//# sourceMappingURL=ServerSupervisor.d.ts.map