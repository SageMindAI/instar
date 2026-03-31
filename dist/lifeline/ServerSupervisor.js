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
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { detectTmuxPath } from '../core/Config.js';
import { SleepWakeDetector } from '../core/SleepWakeDetector.js';
/** Execute a shell command safely, returning stdout. */
function shellExec(cmd, timeout = 5000) {
    return spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf-8', timeout }).stdout ?? '';
}
export class ServerSupervisor extends EventEmitter {
    projectDir;
    projectName;
    port;
    tmuxPath;
    serverSessionName;
    healthCheckInterval = null;
    lastHealthCheckAt = 0; // Wall-clock ms for sleep/wake detection
    sleepWakeGapMs = 2 * 60_000; // Gap > 2 min between 10s intervals = machine was suspended
    restartAttempts = 0;
    maxRestartAttempts = 5;
    restartBackoffMs = 5000;
    isRunning = false;
    lastHealthy = 0;
    startupGraceMs = 180_000; // 3 minutes grace period — allows time for heavy init (Threadline, tunnel, agent discovery)
    spawnedAt = 0;
    retryCooldownMs = 5 * 60_000; // 5 minutes cooldown after max retries exhausted
    maxRetriesExhaustedAt = 0;
    consecutiveFailures = 0; // Hysteresis: require 2 consecutive failures before marking unhealthy
    unhealthyThreshold = 2;
    stateDir;
    // Planned restart / maintenance wait — suppress alerts during expected downtime
    maintenanceWaitStartedAt = 0;
    maintenanceWaitMs = 5 * 60_000; // 5 minutes default (configurable via maintenanceWaitMinutes)
    pendingUpdateVersion = null; // Version being applied — triggers lifeline self-restart on recovery
    // Circuit breaker — give up after too many total failures, but retry periodically
    totalFailures = 0;
    totalFailureWindowStart = 0;
    circuitBreakerThreshold = 20; // Total failures before tripping
    circuitBreakerWindowMs = 60 * 60_000; // 1-hour window
    circuitBroken = false;
    circuitBreakerTrippedAt = 0;
    circuitBreakerRetryCount = 0;
    circuitBreakerRetryIntervalMs = 30 * 60_000; // 30 min between retries
    maxCircuitBreakerRetries = 3; // Try 3 times at 30-min intervals before entering slow-retry
    slowRetryIntervalMs = 2 * 60 * 60_000; // 2 hours between slow retries (never truly give up)
    slowRetryStartedAt = 0; // When slow retry mode started
    lastCrashOutput = ''; // Last captured crash output for diagnostics
    doctorSessionSecret = null; // HMAC secret for doctor restart requests
    sleepWakeDetector = null; // Detects short sleeps that gap-based detection misses
    wakeTransitionUntil = 0; // Timestamp until which we're in a wake transition (lenient health checks)
    wakeTransitionMs = 60_000; // 60 seconds of lenient health checking after wake
    constructor(options) {
        super();
        this.projectDir = options.projectDir;
        this.projectName = options.projectName;
        this.port = options.port;
        this.stateDir = options.stateDir ?? null;
        this.tmuxPath = detectTmuxPath();
        this.serverSessionName = `${this.projectName}-server`;
        if (options.maintenanceWaitMinutes !== undefined) {
            this.maintenanceWaitMs = options.maintenanceWaitMinutes * 60_000;
        }
        if (options.startupGraceSeconds !== undefined) {
            this.startupGraceMs = options.startupGraceSeconds * 1000;
        }
    }
    /**
     * Start the server and begin monitoring.
     */
    async start() {
        if (!this.tmuxPath) {
            console.error('[Supervisor] tmux not found');
            return false;
        }
        // Check if already running
        if (this.isServerSessionAlive()) {
            console.log(`[Supervisor] Server already running in tmux session: ${this.serverSessionName}`);
            this.isRunning = true;
            this.lastHealthy = Date.now();
            // Set spawnedAt so the startup grace period applies. Without this, a fresh
            // Supervisor (e.g., after Lifeline self-restart for an update) has spawnedAt=0,
            // which disables the grace check and can cause false serverDown alerts if the
            // server responds slowly during the transition window.
            this.spawnedAt = Date.now();
            // Check for planned-exit-marker or restart-requested flag — if present,
            // pre-set maintenance wait so handleUnhealthy() suppresses alerts.
            if (this.stateDir) {
                const markerPath = path.join(this.stateDir, 'state', 'planned-exit-marker.json');
                const restartPath = path.join(this.stateDir, 'state', 'restart-requested.json');
                try {
                    if (fs.existsSync(markerPath)) {
                        const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
                        const markerAge = Date.now() - (new Date(data.exitedAt).getTime() || Date.now());
                        if (markerAge < 10 * 60_000) {
                            console.log(`[Supervisor] Found planned-exit marker on start — entering maintenance wait`);
                            this.maintenanceWaitStartedAt = new Date(data.exitedAt).getTime() || Date.now();
                            this.pendingUpdateVersion = data.targetVersion ?? null;
                        }
                    }
                    else if (fs.existsSync(restartPath)) {
                        const data = JSON.parse(fs.readFileSync(restartPath, 'utf-8'));
                        if (data.plannedRestart && (!data.expiresAt || new Date(data.expiresAt).getTime() > Date.now())) {
                            console.log(`[Supervisor] Found restart-requested flag on start — entering maintenance wait`);
                            this.maintenanceWaitStartedAt = Date.now();
                            this.pendingUpdateVersion = data.targetVersion ?? null;
                        }
                    }
                }
                catch { /* best-effort marker check */ }
            }
            this.startHealthChecks();
            return true;
        }
        return this.spawnServer();
    }
    /**
     * Stop the server and monitoring.
     */
    async stop() {
        this.stopHealthChecks();
        if (this.tmuxPath && this.isServerSessionAlive()) {
            try {
                // Graceful: send C-c
                execFileSync(this.tmuxPath, ['send-keys', '-t', `=${this.serverSessionName}:`, 'C-c'], {
                    stdio: 'ignore', timeout: 5000,
                });
                // Wait briefly for graceful shutdown
                await new Promise(r => setTimeout(r, 3000));
                // Force kill if still alive
                if (this.isServerSessionAlive()) {
                    execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
                        stdio: 'ignore',
                    });
                }
            }
            catch { /* ignore */ }
        }
        this.isRunning = false;
    }
    /**
     * Check if the server is currently healthy.
     */
    get healthy() {
        return this.isRunning && (Date.now() - this.lastHealthy) < 30_000;
    }
    /**
     * Get supervisor status.
     */
    getStatus() {
        const coolingDown = this.maxRetriesExhaustedAt > 0;
        const cooldownRemainingMs = coolingDown
            ? Math.max(0, this.retryCooldownMs - (Date.now() - this.maxRetriesExhaustedAt))
            : 0;
        const inMaintenanceWait = this.maintenanceWaitStartedAt > 0;
        const inWakeTransition = Date.now() < this.wakeTransitionUntil;
        return {
            running: this.isRunning,
            healthy: this.healthy,
            restartAttempts: this.restartAttempts,
            lastHealthy: this.lastHealthy,
            serverSession: this.serverSessionName,
            coolingDown,
            cooldownRemainingMs,
            circuitBroken: this.circuitBroken,
            totalFailures: this.totalFailures,
            lastCrashOutput: this.lastCrashOutput,
            circuitBreakerRetryCount: this.circuitBreakerRetryCount,
            maxCircuitBreakerRetries: this.maxCircuitBreakerRetries,
            inMaintenanceWait,
            maintenanceWaitElapsedMs: inMaintenanceWait ? Date.now() - this.maintenanceWaitStartedAt : 0,
            inWakeTransition,
            wakeTransitionRemainingMs: inWakeTransition ? this.wakeTransitionUntil - Date.now() : 0,
        };
    }
    /**
     * Reset the circuit breaker — allows restart attempts to resume.
     * Call this after fixing the underlying issue (e.g., via /lifeline restart).
     */
    resetCircuitBreaker() {
        this.circuitBroken = false;
        this.circuitBreakerTrippedAt = 0;
        this.circuitBreakerRetryCount = 0;
        this.totalFailures = 0;
        this.totalFailureWindowStart = 0;
        this.restartAttempts = 0;
        this.maxRetriesExhaustedAt = 0;
        this.slowRetryStartedAt = 0;
        this.wakeTransitionUntil = 0;
        console.log('[Supervisor] Circuit breaker reset');
    }
    /**
     * Set the HMAC secret for validating doctor session restart requests.
     * Called by TelegramLifeline when a doctor session is spawned.
     */
    setDoctorSessionSecret(secret) {
        this.doctorSessionSecret = secret;
    }
    /**
     * Gracefully restart the server: capture output, kill tmux session,
     * clean up child processes, then spawn fresh.
     *
     * Used by: restart-request handling (auto-update), /lifeline restart command.
     */
    async performGracefulRestart(reason) {
        console.log(`[Supervisor] Graceful restart initiated: ${reason}`);
        this.emit('serverRestarting', 0);
        if (this.tmuxPath && this.isServerSessionAlive()) {
            this.captureCrashOutput();
            this.cleanupChildProcesses();
            try {
                // Send C-c for graceful shutdown
                execFileSync(this.tmuxPath, ['send-keys', '-t', `=${this.serverSessionName}:`, 'C-c'], {
                    stdio: 'ignore', timeout: 5000,
                });
                await new Promise(r => setTimeout(r, 3000));
                // Force kill if still alive
                if (this.isServerSessionAlive()) {
                    execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
                        stdio: 'ignore',
                    });
                }
            }
            catch { /* ignore */ }
        }
        // Wait for port release
        await new Promise(r => setTimeout(r, 2000));
        // Spawn fresh server — uses the updated binary since spawnServer resolves
        // cli.js relative to import.meta.url (the globally installed package)
        this.restartAttempts = 0;
        return this.spawnServer();
    }
    // ── Pre-spawn self-healing ──────────────────────────────────────
    //
    // Before starting the server, check prerequisites and fix common issues
    // that would otherwise cause the server to crash immediately. This makes
    // `/lifeline restart` actually useful for recovery — not just a blind retry.
    /**
     * Run preflight checks and attempt to fix broken prerequisites.
     * Returns a summary of what was healed (empty string if nothing needed fixing).
     */
    preflightSelfHeal() {
        if (!this.stateDir)
            return '';
        const healed = [];
        // 1. Shadow install — the most common failure mode.
        //    If the shadow install is missing or corrupt, the server can't start at all.
        const shadowDir = path.join(this.stateDir, 'shadow-install');
        const shadowCli = path.join(shadowDir, 'node_modules', 'instar', 'dist', 'cli.js');
        if (!fs.existsSync(shadowCli)) {
            console.log('[Supervisor] Preflight: shadow install missing — attempting reinstall');
            try {
                // Find a working npm binary
                const npmPath = this.findNpmPath();
                if (npmPath) {
                    const result = spawnSync(npmPath, ['install', 'instar', '--prefix', shadowDir], {
                        encoding: 'utf-8',
                        timeout: 60_000,
                        cwd: this.projectDir,
                    });
                    if (result.status === 0 && fs.existsSync(shadowCli)) {
                        healed.push('shadow install restored');
                        console.log('[Supervisor] Preflight: shadow install restored successfully');
                    }
                    else {
                        console.error(`[Supervisor] Preflight: npm install failed (exit ${result.status}): ${(result.stderr || '').slice(-200)}`);
                    }
                }
                else {
                    console.error('[Supervisor] Preflight: no npm binary found — cannot restore shadow install');
                }
            }
            catch (err) {
                console.error(`[Supervisor] Preflight: shadow install repair failed: ${err}`);
            }
        }
        // 2. Node symlink — if broken, the launchd boot wrapper will fail on next restart.
        const nodeSymlink = path.join(this.stateDir, 'bin', 'node');
        try {
            if (!fs.existsSync(nodeSymlink) || spawnSync(nodeSymlink, ['--version'], { timeout: 5000 }).status !== 0) {
                console.log('[Supervisor] Preflight: node symlink missing or broken — attempting fix');
                const nodePath = this.findNodePath();
                if (nodePath) {
                    fs.mkdirSync(path.dirname(nodeSymlink), { recursive: true });
                    try {
                        fs.unlinkSync(nodeSymlink);
                    }
                    catch { /* may not exist */ }
                    fs.symlinkSync(nodePath, nodeSymlink);
                    healed.push('node symlink repaired');
                    console.log(`[Supervisor] Preflight: node symlink → ${nodePath}`);
                }
            }
        }
        catch (err) {
            console.error(`[Supervisor] Preflight: node symlink check failed: ${err}`);
        }
        // 3. Stale lifeline lock — can prevent the lifeline from restarting properly.
        const lockFile = path.join(this.stateDir, 'state', 'lifeline.lock');
        try {
            if (fs.existsSync(lockFile)) {
                const lockAge = Date.now() - fs.statSync(lockFile).mtimeMs;
                if (lockAge > 10 * 60_000) { // 10 minutes
                    fs.unlinkSync(lockFile);
                    healed.push('stale lifeline lock removed');
                    console.log(`[Supervisor] Preflight: removed stale lifeline lock (${Math.round(lockAge / 60_000)}m old)`);
                }
            }
        }
        catch { /* ignore */ }
        if (healed.length > 0) {
            const summary = healed.join(', ');
            console.log(`[Supervisor] Preflight self-heal: ${summary}`);
            return summary;
        }
        return '';
    }
    /**
     * Find a working npm binary. Checks common locations.
     */
    findNpmPath() {
        // Try the node that's running us — npm is usually a sibling
        const currentNodeDir = path.dirname(process.execPath);
        const siblingNpm = path.join(currentNodeDir, 'npm');
        if (fs.existsSync(siblingNpm))
            return siblingNpm;
        // Common paths
        for (const candidate of ['/opt/homebrew/bin/npm', '/usr/local/bin/npm']) {
            if (fs.existsSync(candidate))
                return candidate;
        }
        // Fall back to PATH lookup
        try {
            const which = spawnSync('which', ['npm'], { encoding: 'utf-8', timeout: 5000 });
            if (which.status === 0 && which.stdout.trim())
                return which.stdout.trim();
        }
        catch { /* ignore */ }
        return null;
    }
    /**
     * Find a working node binary. Checks common locations.
     */
    findNodePath() {
        // Current process is always valid
        if (process.execPath)
            return process.execPath;
        for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
            if (fs.existsSync(candidate))
                return candidate;
        }
        try {
            const which = spawnSync('which', ['node'], { encoding: 'utf-8', timeout: 5000 });
            if (which.status === 0 && which.stdout.trim())
                return which.stdout.trim();
        }
        catch { /* ignore */ }
        return null;
    }
    spawnServer() {
        if (!this.tmuxPath)
            return false;
        // Run preflight self-heal before every spawn attempt
        this.preflightSelfHeal();
        try {
            // Get the instar CLI path — resolution order:
            //   1. Shadow install (agent's own managed version from AutoUpdater)
            //   2. Current binary location (how the lifeline was started)
            //
            // Shadow install is the agent's private copy at {stateDir}/shadow-install/.
            // The AutoUpdater installs updates there instead of globally, so each agent
            // manages its own version independently.
            let cliPath = new URL('../cli.js', import.meta.url).pathname;
            // Check for shadow install first — this is the agent's own managed version
            if (this.stateDir) {
                const shadowCli = path.join(this.stateDir, 'shadow-install', 'node_modules', 'instar', 'dist', 'cli.js');
                if (fs.existsSync(shadowCli)) {
                    console.log(`[Supervisor] Using shadow install: ${shadowCli}`);
                    cliPath = shadowCli;
                }
            }
            // Stderr capture: tee to crash log file for fast-exit diagnostics
            const crashLogDir = this.stateDir ? path.join(this.stateDir, 'logs') : '/tmp';
            try {
                fs.mkdirSync(crashLogDir, { recursive: true });
            }
            catch { /* ignore */ }
            const crashLogPath = path.join(crashLogDir, 'server-stderr.log');
            // --no-telegram: lifeline owns the Telegram connection, server should not poll
            const quotedCli = cliPath.replace(/'/g, "'\\''");
            const nodeCmd = `'node' '${quotedCli}' 'server' 'start' '--foreground' '--no-telegram' 2> >(tee '${crashLogPath}' >&2)`;
            execFileSync(this.tmuxPath, [
                'new-session', '-d',
                '-s', this.serverSessionName,
                '-c', this.projectDir,
                `bash`, '-c', nodeCmd,
            ], { stdio: 'ignore' });
            console.log(`[Supervisor] Server started in tmux session: ${this.serverSessionName}`);
            this.isRunning = true;
            this.spawnedAt = Date.now();
            this.startHealthChecks();
            return true;
        }
        catch (err) {
            console.error(`[Supervisor] Failed to start server: ${err}`);
            return false;
        }
    }
    isServerSessionAlive() {
        if (!this.tmuxPath)
            return false;
        try {
            execFileSync(this.tmuxPath, ['has-session', '-t', `=${this.serverSessionName}`], {
                stdio: 'ignore', timeout: 5000,
            });
            return true;
        }
        catch {
            return false;
        }
    }
    startHealthChecks() {
        if (this.healthCheckInterval)
            return;
        // Start SleepWakeDetector to catch short sleeps (10-30s) that the gap-based
        // detection below misses (its 2-minute threshold is too high for brief suspends).
        // On wake, reset failure counters so stale pre-sleep failures don't cascade.
        if (!this.sleepWakeDetector) {
            // Use 15s drift threshold — low enough to catch real sleeps but high enough
            // to avoid false positives from normal OS scheduling jitter (~5-10s on loaded systems)
            // that still cause health check failures during the transition.
            this.sleepWakeDetector = new SleepWakeDetector({ driftThresholdMs: 15_000 });
            this.sleepWakeDetector.on('wake', (event) => {
                console.log(`[Supervisor] SleepWakeDetector: wake after ~${event.sleepDurationSeconds}s. Resetting failure counters.`);
                this.restartAttempts = 0;
                this.maxRetriesExhaustedAt = 0;
                this.consecutiveFailures = 0;
                this.totalFailures = 0;
                this.totalFailureWindowStart = 0;
                this.spawnedAt = Date.now();
                this.wakeTransitionUntil = Date.now() + this.wakeTransitionMs;
            });
            this.sleepWakeDetector.start();
        }
        this.healthCheckInterval = setInterval(async () => {
            const now = Date.now();
            // Sleep/wake detection: if the gap between health checks is much larger than
            // the poll interval, the machine was likely suspended (e.g., lid close after
            // an auto-update restart). Reset failure counters so brief wake cycles don't
            // exhaust restart attempts before the machine is fully awake.
            if (this.lastHealthCheckAt > 0 && (now - this.lastHealthCheckAt) > this.sleepWakeGapMs) {
                const gapSec = Math.round((now - this.lastHealthCheckAt) / 1000);
                console.log(`[Supervisor] Sleep/wake detected (${gapSec}s gap). Resetting failure counters.`);
                this.restartAttempts = 0;
                this.maxRetriesExhaustedAt = 0;
                this.consecutiveFailures = 0;
                this.totalFailures = 0;
                this.totalFailureWindowStart = 0;
                // Give the server the full startup grace period from wake time
                this.spawnedAt = now;
                this.wakeTransitionUntil = now + this.wakeTransitionMs;
            }
            this.lastHealthCheckAt = now;
            // During startup grace period: probe health optimistically but don't act on failures.
            // This allows `lastHealthy` to update as soon as the server is responsive, so
            // TelegramLifeline can forward messages immediately instead of queuing them for
            // the entire grace period. Failures are ignored — the server is still booting.
            if (this.spawnedAt > 0 && (now - this.spawnedAt) < this.startupGraceMs) {
                this.checkRestartRequest();
                // Optimistic health probe — update lastHealthy on success, ignore failures
                try {
                    const alive = await this.checkHealth();
                    if (alive) {
                        this.lastHealthy = Date.now();
                        if (!this.isRunning) {
                            this.isRunning = true;
                            this.emit('serverUp');
                        }
                    }
                }
                catch { /* expected during boot — ignore */ }
                return;
            }
            try {
                const healthy = await this.checkHealth();
                if (healthy) {
                    if (!this.isRunning) {
                        if (this.maintenanceWaitStartedAt > 0) {
                            // Recovering from planned restart — quiet recovery, no notification
                            const elapsedMs = Date.now() - this.maintenanceWaitStartedAt;
                            console.log(`[Supervisor] Server recovered after planned restart (${Math.round(elapsedMs / 1000)}s downtime)`);
                            this.maintenanceWaitStartedAt = 0;
                            this.clearPlannedExitMarker();
                            // Still replay queued messages (important!) but skip serverDown notification
                            this.emit('serverUp');
                            // Signal the lifeline to self-restart so it picks up new code
                            if (this.pendingUpdateVersion) {
                                console.log(`[Supervisor] Update to v${this.pendingUpdateVersion} applied — signaling lifeline self-restart`);
                                this.emit('updateApplied', this.pendingUpdateVersion);
                                this.pendingUpdateVersion = null;
                            }
                        }
                        else {
                            this.emit('serverUp');
                        }
                    }
                    this.isRunning = true;
                    this.lastHealthy = Date.now();
                    this.restartAttempts = 0;
                    this.consecutiveFailures = 0;
                    // If circuit breaker was tripped and we recovered, reset it
                    if (this.circuitBroken) {
                        console.log('[Supervisor] Server recovered after circuit breaker — resetting');
                        this.resetCircuitBreaker();
                    }
                }
                else {
                    this.consecutiveFailures++;
                    if (this.consecutiveFailures >= this.unhealthyThreshold) {
                        // During wake transitions, don't kill a server that's still alive — it's
                        // likely just slow to respond while the system recovers (disk I/O, network
                        // reconfig, SQLite WAL replay). Only act if the server process is actually dead.
                        if (Date.now() < this.wakeTransitionUntil && this.isServerSessionAlive()) {
                            console.log(`[Supervisor] Health check failed during wake transition but server session is alive — waiting (${Math.round((this.wakeTransitionUntil - Date.now()) / 1000)}s remaining)`);
                            this.consecutiveFailures = 0; // Reset so we don't immediately re-trigger
                        }
                        else {
                            this.handleUnhealthy();
                        }
                    }
                }
            }
            catch {
                this.consecutiveFailures++;
                if (this.consecutiveFailures >= this.unhealthyThreshold) {
                    if (Date.now() < this.wakeTransitionUntil && this.isServerSessionAlive()) {
                        console.log(`[Supervisor] Health check failed during wake transition but server session is alive — waiting (${Math.round((this.wakeTransitionUntil - Date.now()) / 1000)}s remaining)`);
                        this.consecutiveFailures = 0;
                    }
                    else {
                        this.handleUnhealthy();
                    }
                }
            }
            // Check for restart requests from the server (e.g., auto-updater)
            this.checkRestartRequest();
            // Check for debug restart requests from doctor sessions
            this.checkDebugRestartRequest();
        }, 10_000); // Check every 10 seconds
    }
    stopHealthChecks() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
            this.healthCheckInterval = null;
        }
        if (this.sleepWakeDetector) {
            this.sleepWakeDetector.stop();
            this.sleepWakeDetector = null;
        }
    }
    async checkHealth() {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5000);
            try {
                const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
                    signal: controller.signal,
                });
                return response.ok;
            }
            finally {
                clearTimeout(timer);
            }
        }
        catch {
            return false;
        }
    }
    // ── Restart request handling ──────────────────────────────────────
    /**
     * Check if the server (AutoUpdater) has requested a restart.
     * Called during the health check loop. If a valid request exists,
     * initiate a graceful restart of the server tmux session.
     */
    checkRestartRequest() {
        if (!this.stateDir)
            return;
        const flagPath = path.join(this.stateDir, 'state', 'restart-requested.json');
        try {
            if (!fs.existsSync(flagPath))
                return;
            const data = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
            // Check TTL
            if (data.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
                try {
                    fs.unlinkSync(flagPath);
                }
                catch { /* ignore */ }
                console.log('[Supervisor] Expired restart request — ignoring');
                return;
            }
            console.log(`[Supervisor] Restart requested by ${data.requestedBy} for v${data.targetVersion}`);
            // RESTART LOOP DETECTION: If we've already restarted for this version,
            // the binary isn't actually updating (npx cache mismatch). Don't loop.
            const restartCountFile = path.join(this.stateDir, 'state', 'restart-version-count.json');
            let restartCount = 0;
            try {
                if (fs.existsSync(restartCountFile)) {
                    const countData = JSON.parse(fs.readFileSync(restartCountFile, 'utf-8'));
                    if (countData.targetVersion === data.targetVersion) {
                        restartCount = (countData.count ?? 0);
                    }
                }
            }
            catch { /* fresh count */ }
            if (restartCount >= 2) {
                console.log(`[Supervisor] Restart loop detected — already restarted ${restartCount}x for v${data.targetVersion}. Skipping.`);
                try {
                    fs.unlinkSync(flagPath);
                }
                catch { /* ignore */ }
                // Clean up the count file so it doesn't block future real updates
                try {
                    fs.unlinkSync(restartCountFile);
                }
                catch { /* ignore */ }
                return;
            }
            // Increment restart count for this version
            try {
                const stateSubdir = path.join(this.stateDir, 'state');
                fs.mkdirSync(stateSubdir, { recursive: true });
                fs.writeFileSync(restartCountFile, JSON.stringify({
                    targetVersion: data.targetVersion,
                    count: restartCount + 1,
                    lastRestartAt: new Date().toISOString(),
                }));
            }
            catch { /* best-effort */ }
            // Enter maintenance wait if this is a planned restart (suppress serverDown alerts)
            if (data.plannedRestart) {
                this.maintenanceWaitStartedAt = Date.now();
                this.pendingUpdateVersion = data.targetVersion ?? null;
                console.log(`[Supervisor] Planned restart — entering maintenance wait (${Math.round(this.maintenanceWaitMs / 60_000)}m window)`);
            }
            // Clear the flag BEFORE restarting to prevent re-triggering
            try {
                fs.unlinkSync(flagPath);
            }
            catch { /* ignore */ }
            // Also clean up legacy flag if present
            this.clearLegacyRestartFlag();
            // Clean up any planned-exit marker from ForegroundRestartWatcher
            this.clearPlannedExitMarker();
            // Initiate graceful restart
            this.performGracefulRestart(`update to v${data.targetVersion}`);
        }
        catch {
            // Malformed flag — clean up
            try {
                fs.unlinkSync(flagPath);
            }
            catch { /* ignore */ }
        }
    }
    // ── Debug restart request handling (doctor session) ─────────────
    /**
     * Check if a doctor session has requested a restart via HMAC-signed file.
     * Called during the health check loop alongside checkRestartRequest().
     */
    checkDebugRestartRequest() {
        if (!this.stateDir)
            return;
        const requestPath = path.join(this.stateDir, 'debug-restart-request.json');
        try {
            if (!fs.existsSync(requestPath))
                return;
            const raw = fs.readFileSync(requestPath, 'utf-8');
            fs.unlinkSync(requestPath); // consume the request immediately
            const request = JSON.parse(raw);
            // TTL check — reject requests older than 30 minutes
            const requestAge = Date.now() - new Date(request.requestedAt).getTime();
            if (requestAge > 30 * 60_000) {
                console.log(`[Supervisor] Stale debug restart request (${Math.round(requestAge / 60_000)}m old) — discarded`);
                return;
            }
            // HMAC validation
            if (!this.validateRestartHmac(request)) {
                console.warn(`[Supervisor] Invalid HMAC on debug restart request — rejected`);
                return;
            }
            // Sanitize fixDescription before display (self-reported, untrusted)
            const safeDescription = (request.fixDescription || 'no description')
                .replace(/[<>&"']/g, '') // strip HTML-like chars
                .slice(0, 200); // cap length
            console.log(`[Supervisor] Debug session fix (self-reported): ${safeDescription}`);
            // Check if server already recovered
            if (this.healthy) {
                console.log(`[Supervisor] Server already healthy — skipping restart, noting fix`);
                this.emit('debugRestartSkipped', { fixDescription: safeDescription, reason: 'server_already_healthy' });
                return;
            }
            this.emit('debugRestartRequested', { fixDescription: safeDescription, requestedBy: request.requestedBy || 'doctor-session' });
            // Reset circuit breaker and restart
            this.resetCircuitBreaker();
            this.stop().then(() => this.start());
        }
        catch (err) {
            console.error(`[Supervisor] Error processing debug restart request: ${err}`);
        }
    }
    /**
     * Validate HMAC on a debug restart request using the doctor session secret.
     */
    validateRestartHmac(request) {
        if (!this.doctorSessionSecret || !request.hmac || !request.requestedAt)
            return false;
        try {
            const expectedPayload = request.requestedAt + (request.fixDescription || '');
            const expectedHmac = crypto
                .createHmac('sha256', this.doctorSessionSecret)
                .update(expectedPayload)
                .digest('hex');
            // Use timing-safe comparison to prevent timing attacks
            const hmacBuf = Buffer.from(request.hmac, 'hex');
            const expectedBuf = Buffer.from(expectedHmac, 'hex');
            if (hmacBuf.length !== expectedBuf.length)
                return false;
            return crypto.timingSafeEqual(hmacBuf, expectedBuf);
        }
        catch {
            return false;
        }
    }
    // ── Unhealthy handling ──────────────────────────────────────────
    handleUnhealthy() {
        // Circuit breaker — periodic retry instead of permanent death
        if (this.circuitBroken) {
            // Phase 1: Fast retries (every 30 min, 3x)
            if (this.circuitBreakerRetryCount < this.maxCircuitBreakerRetries) {
                const elapsed = Date.now() - this.circuitBreakerTrippedAt;
                const nextRetryAt = this.circuitBreakerRetryIntervalMs * (this.circuitBreakerRetryCount + 1);
                if (elapsed >= nextRetryAt) {
                    this.circuitBreakerRetryCount++;
                    console.log(`[Supervisor] Circuit breaker retry ${this.circuitBreakerRetryCount}/${this.maxCircuitBreakerRetries}`);
                    this.emit('serverRestarting', this.circuitBreakerRetryCount);
                    // Kill existing session if alive
                    if (this.tmuxPath && this.isServerSessionAlive()) {
                        this.captureCrashOutput();
                        this.cleanupChildProcesses();
                        try {
                            execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
                                stdio: 'ignore',
                            });
                        }
                        catch { /* ignore */ }
                    }
                    this.spawnServer();
                }
                return;
            }
            // Phase 2: Slow retry — never truly give up. Transient issues (Node version change,
            // disk full, port conflict) often resolve themselves. Try every 2 hours forever.
            if (this.slowRetryStartedAt === 0) {
                this.slowRetryStartedAt = Date.now();
                console.log(`[Supervisor] Circuit breaker fast retries exhausted. Entering slow-retry mode (every ${this.slowRetryIntervalMs / 3600_000}h). Use /lifeline reset for immediate retry.`);
            }
            const slowElapsed = Date.now() - (this.slowRetryStartedAt + this.slowRetryIntervalMs * Math.floor((Date.now() - this.slowRetryStartedAt) / this.slowRetryIntervalMs));
            if (slowElapsed < 10_000) { // Within 10s of a 2-hour boundary
                console.log(`[Supervisor] Slow retry attempt (${Math.round((Date.now() - this.slowRetryStartedAt) / 3600_000)}h since circuit breaker exhaustion)`);
                // Kill existing session if alive
                if (this.tmuxPath && this.isServerSessionAlive()) {
                    this.captureCrashOutput();
                    this.cleanupChildProcesses();
                    try {
                        execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
                            stdio: 'ignore',
                        });
                    }
                    catch { /* ignore */ }
                }
                this.spawnServer();
            }
            return;
        }
        // Check for legacy planned restart flag (backward compatibility with old AutoUpdater)
        if (this.isLegacyPlannedRestart()) {
            if (!this.isServerSessionAlive()) {
                console.log('[Supervisor] Legacy planned restart detected — server session dead. Respawning.');
                this.clearLegacyRestartFlag();
                this.consecutiveFailures = 0;
                this.spawnServer();
                return;
            }
            console.log('[Supervisor] Health check failed but legacy update-restart flag is active — suppressing alert');
            this.consecutiveFailures = 0;
            this.spawnedAt = Date.now();
            return;
        }
        // Check for planned restart (new AutoUpdater with plannedRestart: true, or
        // ForegroundRestartWatcher exit marker). Suppress serverDown during the
        // maintenance wait window — this is expected downtime, not a crash.
        if (this.isPendingPlannedRestart()) {
            if (!this.isServerSessionAlive()) {
                console.log('[Supervisor] Planned restart in progress — server session dead. Respawning.');
                this.consecutiveFailures = 0;
                this.spawnServer();
                return;
            }
            console.log('[Supervisor] Health check failed during planned restart — suppressing alert');
            this.consecutiveFailures = 0;
            return;
        }
        if (this.isRunning) {
            this.isRunning = false;
            this.emit('serverDown', 'Health check failed');
        }
        this.consecutiveFailures = 0; // Reset after triggering action
        // After max retries exhausted, wait for cooldown before trying again.
        // IMPORTANT: Check cooldown BEFORE incrementing totalFailures. Otherwise, passive health check
        // failures during cooldown accumulate and trip the circuit breaker, escalating a recoverable
        // 5-min cooldown into a 30-min circuit breaker stall. Only actual restart failures should
        // count toward the circuit breaker threshold.
        if (this.restartAttempts >= this.maxRestartAttempts) {
            if (this.maxRetriesExhaustedAt === 0) {
                this.maxRetriesExhaustedAt = Date.now();
                console.error(`[Supervisor] Max restart attempts (${this.maxRestartAttempts}) reached. Cooling down for ${this.retryCooldownMs / 1000}s before retrying.`);
            }
            if ((Date.now() - this.maxRetriesExhaustedAt) >= this.retryCooldownMs) {
                console.log(`[Supervisor] Cooldown elapsed. Resetting restart counter.`);
                this.restartAttempts = 0;
                this.maxRetriesExhaustedAt = 0;
            }
            else {
                return; // Still cooling down — skip totalFailures increment
            }
        }
        // Track total failures for circuit breaker (only incremented for active failure handling, not passive cooldown)
        const now = Date.now();
        if (this.totalFailureWindowStart === 0 || (now - this.totalFailureWindowStart) > this.circuitBreakerWindowMs) {
            // Reset window
            this.totalFailureWindowStart = now;
            this.totalFailures = 0;
        }
        this.totalFailures++;
        // Circuit breaker: too many total failures in the window → trip (but with periodic retry)
        if (this.totalFailures >= this.circuitBreakerThreshold) {
            this.circuitBroken = true;
            this.circuitBreakerTrippedAt = Date.now();
            this.circuitBreakerRetryCount = 0;
            console.error(`[Supervisor] CIRCUIT BREAKER: ${this.totalFailures} failures in ${Math.round(this.circuitBreakerWindowMs / 60000)}m window. Will retry every ${this.circuitBreakerRetryIntervalMs / 60000}m (${this.maxCircuitBreakerRetries}x).`);
            console.error(`[Supervisor] Last crash output:\n${this.lastCrashOutput}`);
            this.emit('circuitBroken', this.totalFailures, this.lastCrashOutput);
            return;
        }
        // Auto-restart with backoff
        this.restartAttempts++;
        const delay = this.restartBackoffMs * Math.pow(2, this.restartAttempts - 1);
        console.log(`[Supervisor] Server unhealthy. Restart attempt ${this.restartAttempts}/${this.maxRestartAttempts} in ${delay}ms`);
        this.emit('serverRestarting', this.restartAttempts);
        setTimeout(() => {
            // Capture crash output BEFORE killing the tmux session
            if (this.tmuxPath && this.isServerSessionAlive()) {
                this.captureCrashOutput();
                this.cleanupChildProcesses();
                try {
                    execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
                        stdio: 'ignore',
                    });
                }
                catch { /* ignore */ }
            }
            this.spawnServer();
        }, delay);
    }
    // ── Crash diagnostics ──────────────────────────────────────────
    /**
     * Capture crash output from multiple sources:
     * 1. tmux pane capture (last 50 lines of terminal output)
     * 2. stderr crash log file (tee'd from server process)
     */
    captureCrashOutput() {
        // Try tmux pane capture first
        if (this.tmuxPath) {
            try {
                const output = execFileSync(this.tmuxPath, [
                    'capture-pane', '-t', `=${this.serverSessionName}:`, '-p', '-S', '-50',
                ], { encoding: 'utf-8', timeout: 5000 });
                if (output.trim()) {
                    this.lastCrashOutput = output.trim();
                    console.log(`[Supervisor] Crash output from tmux:\n${this.lastCrashOutput.slice(-500)}`);
                    return;
                }
            }
            catch { // @silent-fallback-ok — capture may fail if session already dead
            }
        }
        // Fallback: read the stderr crash log
        if (this.stateDir) {
            const crashLogPath = path.join(this.stateDir, 'logs', 'server-stderr.log');
            try {
                if (fs.existsSync(crashLogPath)) {
                    const content = fs.readFileSync(crashLogPath, 'utf-8');
                    const last500 = content.slice(-500).trim();
                    if (last500) {
                        this.lastCrashOutput = last500;
                        console.log(`[Supervisor] Crash output from stderr log:\n${last500}`);
                    }
                }
            }
            catch { /* ignore */ }
        }
    }
    /**
     * Kill child processes (cloudflared, etc.) that were spawned by the server
     * but will become orphans when the tmux session is killed.
     */
    cleanupChildProcesses() {
        if (!this.tmuxPath)
            return;
        try {
            const panePid = execFileSync(this.tmuxPath, [
                'list-panes', '-t', `=${this.serverSessionName}`, '-F', '#{pane_pid}',
            ], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0];
            if (!panePid)
                return;
            const descendants = shellExec(`pgrep -P ${panePid} 2>/dev/null; pgrep -g ${panePid} 2>/dev/null`).trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n));
            const unique = [...new Set(descendants)].filter(pid => pid !== parseInt(panePid));
            if (unique.length > 0) {
                console.log(`[Supervisor] Cleaning up ${unique.length} child process(es) before restart: ${unique.join(', ')}`);
                for (const pid of unique) {
                    try {
                        process.kill(pid, 'SIGTERM');
                    }
                    catch { /* already dead */ }
                }
                setTimeout(() => {
                    for (const pid of unique) {
                        try {
                            process.kill(pid, 0);
                            process.kill(pid, 'SIGKILL');
                        }
                        catch { /* dead */ }
                    }
                }, 3000);
            }
        }
        catch { // @silent-fallback-ok — cleanup is best-effort
        }
    }
    // ── Legacy flag handling (backward compatibility) ──────────────
    /**
     * Check for the legacy update-restart.json flag (written by old AutoUpdater versions).
     * New versions write restart-requested.json instead, handled by checkRestartRequest().
     */
    isLegacyPlannedRestart() {
        if (!this.stateDir)
            return false;
        const flagPath = path.join(this.stateDir, 'state', 'update-restart.json');
        try {
            if (!fs.existsSync(flagPath))
                return false;
            const data = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
            if (data.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
                try {
                    fs.unlinkSync(flagPath);
                }
                catch { /* ignore */ }
                return false;
            }
            return true;
        }
        catch {
            return false;
        }
    }
    clearLegacyRestartFlag() {
        if (!this.stateDir)
            return;
        const flagPath = path.join(this.stateDir, 'state', 'update-restart.json');
        try {
            if (fs.existsSync(flagPath)) {
                fs.unlinkSync(flagPath);
                console.log('[Supervisor] Cleared legacy update-restart flag');
            }
        }
        catch { /* ignore */ }
    }
    // ── Planned restart detection ──────────────────────────────
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
    isPendingPlannedRestart() {
        // Source 1: Internal state (supervisor saw the flag directly)
        if (this.maintenanceWaitStartedAt > 0) {
            const elapsed = Date.now() - this.maintenanceWaitStartedAt;
            if (elapsed > this.maintenanceWaitMs) {
                console.warn(`[Supervisor] Maintenance wait expired after ${Math.round(elapsed / 1000)}s — falling back to normal alerting`);
                this.maintenanceWaitStartedAt = 0;
                return false;
            }
            return true;
        }
        // Source 2: Planned-exit marker (ForegroundRestartWatcher consumed the flag first)
        if (!this.stateDir)
            return false;
        const markerPath = path.join(this.stateDir, 'state', 'planned-exit-marker.json');
        try {
            if (!fs.existsSync(markerPath))
                return false;
            const data = JSON.parse(fs.readFileSync(markerPath, 'utf-8'));
            // TTL check: marker expires after 10 minutes. If the server hasn't recovered
            // by then, the marker is stale and should not keep suppressing alerts or
            // triggering maintenance-mode respawns indefinitely.
            const markerAge = Date.now() - (new Date(data.exitedAt).getTime() || Date.now());
            const markerTtlMs = 10 * 60_000; // 10 minutes
            if (markerAge > markerTtlMs) {
                console.warn(`[Supervisor] Planned-exit marker expired (${Math.round(markerAge / 60_000)}m old) — clearing and falling back to normal alerting`);
                try {
                    fs.unlinkSync(markerPath);
                }
                catch { /* ignore */ }
                return false;
            }
            // Marker exists and is fresh — enter maintenance wait mode
            console.log(`[Supervisor] Found planned-exit marker (target: v${data.targetVersion}) — entering maintenance wait`);
            this.maintenanceWaitStartedAt = new Date(data.exitedAt).getTime() || Date.now();
            this.pendingUpdateVersion = data.targetVersion ?? null;
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Clean up the planned-exit marker written by ForegroundRestartWatcher.
     */
    clearPlannedExitMarker() {
        if (!this.stateDir)
            return;
        const markerPath = path.join(this.stateDir, 'state', 'planned-exit-marker.json');
        try {
            if (fs.existsSync(markerPath)) {
                fs.unlinkSync(markerPath);
            }
        }
        catch { /* ignore */ }
    }
}
//# sourceMappingURL=ServerSupervisor.js.map