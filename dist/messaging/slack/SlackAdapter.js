/**
 * SlackAdapter — Native Slack messaging adapter for Instar.
 *
 * Implements the MessagingAdapter interface using Socket Mode (WebSocket)
 * for event intake and the Slack Web API for outbound messages.
 *
 * Key design decisions:
 * - DIY app model (each user creates their own Slack app)
 * - Socket Mode (no public URLs, no webhooks)
 * - Zero external SDK (direct HTTP to Slack Web API)
 * - authorizedUserIds is required and fail-closed
 * - Ring buffer scoped to authorized users only
 * - JSON-encoded context files (no delimiter-based injection)
 *
 * Required bot scopes (each event subscription requires its read scope):
 *   app_mentions:read, channels:history, channels:join, channels:manage,
 *   channels:read, chat:write, files:read, groups:history, im:history,
 *   im:read, im:write, pins:write, reactions:read, reactions:write, users:read
 */
import path from 'node:path';
import fs from 'node:fs';
import { SlackApiClient } from './SlackApiClient.js';
import { SocketModeClient } from './SocketModeClient.js';
import { ChannelManager } from './ChannelManager.js';
import { FileHandler } from './FileHandler.js';
import { RingBuffer } from './RingBuffer.js';
import { MessageLogger } from '../shared/MessageLogger.js';
import { sanitizeDisplayName } from './sanitize.js';
const RING_BUFFER_CAPACITY = 50;
const SLACK_MAX_TEXT_LENGTH = 4000;
const AUTO_ARCHIVE_DAYS = 7;
const LOG_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // Daily
export class SlackAdapter {
    platform = 'slack';
    // Config
    config;
    stateDir;
    // Components
    apiClient;
    socketClient = null;
    channelManager;
    fileHandler;
    logger;
    // Workspace behavior (resolved from config + mode defaults)
    workspaceMode;
    autoJoinChannels;
    respondMode;
    botUserId = null;
    // State
    messageHandler = null;
    started = false;
    authorizedUsers;
    channelHistory = new Map();
    pendingPrompts = new Map();
    seenMessageTs = new Set();
    seenMessageTsCleanupTimer = null;
    userCache = new Map();
    promptEvictionTimer = null;
    housekeepingTimer = null;
    logPurgeTimer = null;
    // Channel ↔ Session Registry (persisted to disk)
    channelToSession = new Map();
    channelRegistryPath;
    // Channel Resume Map (persisted — maps channel IDs to Claude session UUIDs for resume)
    channelResumeMap = new Map();
    channelResumeMapPath;
    // Stall tracking (matches Telegram's trackMessageInjection pattern)
    pendingStalls = new Map();
    stallCheckTimer = null;
    // Promise tracking (matches Telegram's "give me a minute" detection)
    pendingPromises = new Map();
    // Callbacks (wired by server.ts)
    /** Called when a prompt gate response is received */
    onPromptResponse = null;
    /** Called when a message is logged (for dual-write to SQLite) */
    onMessageLogged = null;
    /** Called when a stall is detected */
    onStallDetected = null;
    /** Called to interrupt a session (send Escape) */
    onInterruptSession = null;
    /** Called to restart a session */
    onRestartSession = null;
    /** Called to list running sessions */
    onListSessions = null;
    /** Called to check if a session is alive */
    onIsSessionAlive = null;
    /** Called to transcribe a voice/audio file (via Whisper API) */
    transcribeVoice = null;
    /** Called to handle standby commands (unstick, quiet, resume, restart) */
    onStandbyCommand = null;
    /** Called to get triage status for a channel's session */
    onGetTriageStatus = null;
    /** Called to classify why a session died */
    onClassifySessionDeath = null;
    /** Intelligence provider for LLM-gated stall confirmation */
    intelligence = null;
    constructor(config, stateDir) {
        this.config = config;
        this.stateDir = stateDir;
        // Validate required fields
        if (!this.config.botToken)
            throw new Error('[slack] botToken is required');
        if (!this.config.appToken)
            throw new Error('[slack] appToken is required');
        if (!Array.isArray(this.config.authorizedUserIds)) {
            throw new Error('[slack] authorizedUserIds is required (array of Slack user IDs)');
        }
        // Fail-closed: empty array means deny all
        this.authorizedUsers = new Set(this.config.authorizedUserIds);
        if (this.authorizedUsers.size === 0) {
            console.warn('[slack] authorizedUserIds is empty — all messages will be rejected (fail-closed)');
        }
        // Resolve workspace mode and defaults
        this.workspaceMode = this.config.workspaceMode ?? 'dedicated';
        const isDedicated = this.workspaceMode === 'dedicated';
        this.autoJoinChannels = this.config.autoJoinChannels ?? isDedicated;
        this.respondMode = this.config.respondMode ?? (isDedicated ? 'all' : 'mention-only');
        console.log(`[slack] Workspace mode: ${this.workspaceMode} (autoJoin: ${this.autoJoinChannels}, respond: ${this.respondMode})`);
        // Initialize components
        this.apiClient = new SlackApiClient(this.config.botToken, this.config.appToken);
        const rawAgentName = this.config.workspaceName?.replace(/-agent$/i, '') || 'agent';
        const agentName = rawAgentName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        this.channelManager = new ChannelManager(this.apiClient, agentName);
        this.fileHandler = new FileHandler(this.apiClient, this.config.botToken, stateDir);
        this.logger = new MessageLogger({
            logPath: path.join(stateDir, 'slack-messages.jsonl'),
            maxLines: 100_000,
            keepLines: 75_000,
        });
        // Channel registry and resume map persistence
        this.channelRegistryPath = path.join(stateDir, 'slack-channel-registry.json');
        this.channelResumeMapPath = path.join(stateDir, 'slack-channel-resume-map.json');
        this._loadChannelRegistry();
        this._loadChannelResumeMap();
    }
    // ── MessagingAdapter Interface ──
    async start() {
        const handlers = {
            onEvent: async (type, payload) => this._handleEvent(type, payload),
            onInteraction: async (payload) => this._handleInteraction(payload),
            onConnected: () => {
                console.log('[slack] Socket Mode connected');
                this.started = true;
            },
            onDisconnected: (reason) => {
                console.log(`[slack] Disconnected: ${reason}`);
            },
            onError: (err, permanent) => {
                if (permanent) {
                    console.error(`[slack] Permanent error: ${err.message}`);
                }
                else {
                    console.warn(`[slack] Transient error: ${err.message}`);
                }
            },
        };
        this.socketClient = new SocketModeClient(this.apiClient, handlers);
        // Connect with a 15-second timeout to prevent server startup hangs
        const SLACK_CONNECT_TIMEOUT_MS = 15000;
        const connectPromise = this.socketClient.connect();
        const timeoutPromise = new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('Slack Socket Mode connection timeout after 15s')), SLACK_CONNECT_TIMEOUT_MS);
        });
        await Promise.race([connectPromise, timeoutPromise]);
        this.started = true;
        // Fetch bot user ID (needed for @mention detection in shared mode)
        try {
            const authResult = await this.apiClient.call('auth.test', {});
            this.botUserId = authResult.user_id ?? null;
            if (this.botUserId) {
                console.log(`[slack] Bot user ID: ${this.botUserId}`);
            }
        }
        catch {
            console.warn('[slack] Could not fetch bot user ID — mention detection may not work');
        }
        // Auto-join all public channels if in dedicated mode
        if (this.autoJoinChannels) {
            this._autoJoinAllChannels();
        }
        // Backfill ring buffers with recent channel history so sessions have context on restart
        this._backfillChannelHistory();
        // Start pending prompt TTL eviction
        this._startPromptEviction();
        // Start message dedup set cleanup (every 5 minutes, drop entries older than 10 min)
        this.seenMessageTsCleanupTimer = setInterval(() => {
            // Slack ts format: "1234567890.123456" (seconds.microseconds)
            const cutoff = (Date.now() / 1000) - 600; // 10 minutes ago
            for (const ts of this.seenMessageTs) {
                const tsSeconds = parseFloat(ts);
                if (!isNaN(tsSeconds) && tsSeconds < cutoff) {
                    this.seenMessageTs.delete(ts);
                }
            }
        }, 5 * 60 * 1000);
        // Start channel housekeeping (auto-archive idle channels)
        this._startHousekeeping();
        // Start log retention purge (daily)
        this._startLogPurge();
        // Purge stale log entries on startup
        this._purgeOldLogs();
    }
    async stop() {
        this.started = false;
        if (this.promptEvictionTimer) {
            clearInterval(this.promptEvictionTimer);
            this.promptEvictionTimer = null;
        }
        if (this.housekeepingTimer) {
            clearInterval(this.housekeepingTimer);
            this.housekeepingTimer = null;
        }
        if (this.logPurgeTimer) {
            clearInterval(this.logPurgeTimer);
            this.logPurgeTimer = null;
        }
        if (this.stallCheckTimer) {
            clearInterval(this.stallCheckTimer);
            this.stallCheckTimer = null;
        }
        if (this.seenMessageTsCleanupTimer) {
            clearInterval(this.seenMessageTsCleanupTimer);
            this.seenMessageTsCleanupTimer = null;
        }
        if (this.socketClient) {
            await this.socketClient.disconnect();
            this.socketClient = null;
        }
    }
    async send(message) {
        const channelId = message.channel?.identifier;
        if (!channelId) {
            console.error('[slack] Cannot send: no channel identifier');
            return;
        }
        // Chunk long messages
        const chunks = this._chunkText(message.content);
        let lastResult = null;
        for (const chunk of chunks) {
            const params = {
                channel: channelId,
                text: chunk,
            };
            // If there's thread_ts in metadata, reply in thread
            if (message.channel?.type === 'slack' && message.threadTs) {
                params.thread_ts = message.threadTs;
            }
            lastResult = await this.apiClient.call('chat.postMessage', params);
        }
        return lastResult;
    }
    onMessage(handler) {
        this.messageHandler = handler;
    }
    async resolveUser(channelIdentifier) {
        // For Slack, the channel identifier IS the user reference
        return channelIdentifier || null;
    }
    // ── Slack-Specific Public Methods ──
    /** Get the current workspace behavior config. */
    getWorkspaceConfig() {
        return {
            mode: this.workspaceMode,
            autoJoinChannels: this.autoJoinChannels,
            respondMode: this.respondMode,
        };
    }
    /** Get the bot's own Slack user ID (for distinguishing bot vs user messages). */
    getBotUserId() {
        return this.botUserId;
    }
    /** Check if a user is authorized. */
    isAuthorized(userId) {
        return this.authorizedUsers.has(userId);
    }
    /** Send a message to a specific channel. */
    async sendToChannel(channelId, text, options) {
        const params = { channel: channelId, text };
        if (options?.thread_ts)
            params.thread_ts = options.thread_ts;
        const result = await this.apiClient.call('chat.postMessage', params);
        return result.ts;
    }
    /** Add a reaction (fire-and-forget). */
    addReaction(channelId, timestamp, emoji) {
        this.apiClient.call('reactions.add', { channel: channelId, timestamp, name: emoji }).catch(() => { });
    }
    /** Remove a reaction (fire-and-forget). */
    removeReaction(channelId, timestamp, emoji) {
        this.apiClient.call('reactions.remove', { channel: channelId, timestamp, name: emoji }).catch(() => { });
    }
    /** Update an existing message. */
    async updateMessage(channelId, timestamp, text) {
        await this.apiClient.call('chat.update', { channel: channelId, ts: timestamp, text });
    }
    /** Pin a message. */
    async pinMessage(channelId, timestamp) {
        await this.apiClient.call('pins.add', { channel: channelId, timestamp });
    }
    /** Send an ephemeral message (visible only to one user). */
    async postEphemeral(channelId, userId, text) {
        await this.apiClient.call('chat.postEphemeral', { channel: channelId, user: userId, text });
    }
    /** Send a message with Block Kit blocks. */
    async sendBlocks(channelId, blocks, text) {
        const params = { channel: channelId, blocks };
        if (text)
            params.text = text; // Fallback text for notifications
        const result = await this.apiClient.call('chat.postMessage', params);
        return result.ts;
    }
    /** Get cached channel messages from ring buffer. */
    getChannelMessages(channelId, limit = 30) {
        const buffer = this.channelHistory.get(channelId);
        if (!buffer)
            return [];
        const all = buffer.toArray();
        return limit >= all.length ? all : all.slice(-limit);
    }
    /** Get user info (cached for 5 minutes). */
    async getUserInfo(userId) {
        const cached = this.userCache.get(userId);
        if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) {
            return { id: userId, name: cached.name };
        }
        const result = await this.apiClient.call('users.info', { user: userId });
        const user = result.user;
        const name = user.real_name || user.name;
        this.userCache.set(userId, { name, fetchedAt: Date.now() });
        return { id: userId, name };
    }
    /** Create a channel. */
    async createChannel(name, isPrivate) {
        return this.channelManager.createChannel(name, isPrivate);
    }
    /** Archive a channel. */
    async archiveChannel(channelId) {
        return this.channelManager.archiveChannel(channelId);
    }
    /** Upload a file. */
    async uploadFile(channelId, filePath, title) {
        return this.fileHandler.uploadFile(channelId, filePath, title);
    }
    /** Download a file. */
    async downloadFile(url, destPath) {
        return this.fileHandler.downloadFile(url, destPath);
    }
    /** Get the underlying API client (for routes). */
    get api() {
        return this.apiClient;
    }
    // ── Channel ↔ Session Registry ──
    /** Register a channel → session binding. Persisted to disk. */
    registerChannelSession(channelId, sessionName, channelName) {
        this.channelToSession.set(channelId, {
            sessionName,
            channelName,
            registeredAt: new Date().toISOString(),
        });
        this._saveChannelRegistry();
    }
    /** Look up which session is bound to a channel. */
    getSessionForChannel(channelId) {
        return this.channelToSession.get(channelId)?.sessionName ?? null;
    }
    /** Look up which channel is bound to a session. */
    getChannelForSession(sessionName) {
        for (const [channelId, entry] of this.channelToSession) {
            if (entry.sessionName === sessionName)
                return channelId;
        }
        return null;
    }
    /** Remove a channel → session binding. */
    unregisterChannel(channelId) {
        this.channelToSession.delete(channelId);
        this._saveChannelRegistry();
    }
    /** Get all channel → session mappings. */
    getChannelRegistry() {
        const result = {};
        for (const [channelId, entry] of this.channelToSession) {
            result[channelId] = { sessionName: entry.sessionName, channelName: entry.channelName };
        }
        return result;
    }
    // ── Channel Resume Map ──
    /** Save a session UUID for resume when a channel goes idle. */
    saveChannelResume(channelId, uuid, sessionName) {
        this.channelResumeMap.set(channelId, {
            uuid,
            savedAt: new Date().toISOString(),
            sessionName,
        });
        this._saveChannelResumeMap();
    }
    /** Get the resume UUID for a channel (returns null if none or expired). */
    getChannelResume(channelId) {
        const entry = this.channelResumeMap.get(channelId);
        if (!entry)
            return null;
        // Expire entries older than 24 hours
        const age = Date.now() - new Date(entry.savedAt).getTime();
        if (age > 24 * 60 * 60 * 1000) {
            this.channelResumeMap.delete(channelId);
            this._saveChannelResumeMap();
            return null;
        }
        return { uuid: entry.uuid, sessionName: entry.sessionName };
    }
    /** Remove a resume entry (consumed after resume). */
    removeChannelResume(channelId) {
        this.channelResumeMap.delete(channelId);
        this._saveChannelResumeMap();
    }
    // ── Stall Detection ──
    /** Track an injected message for stall detection. */
    trackMessageInjection(channelId, sessionName, text) {
        const key = `${channelId}-${Date.now()}`;
        this.pendingStalls.set(key, {
            channelId,
            sessionName,
            text: text.slice(0, 200),
            injectedAt: Date.now(),
        });
    }
    /** Clear stall tracking for a channel (agent responded). */
    clearStallTracking(channelId) {
        for (const [key, entry] of this.pendingStalls) {
            if (entry.channelId === channelId) {
                this.pendingStalls.delete(key);
            }
        }
    }
    /** Start periodic stall checking (stalls + promise expiry, LLM-gated). */
    startStallDetection(timeoutMs = 5 * 60 * 1000, promiseTimeoutMs = 10 * 60 * 1000) {
        if (this.stallCheckTimer)
            return;
        this.stallCheckTimer = setInterval(async () => {
            const now = Date.now();
            // Check for stalled messages
            for (const [key, entry] of this.pendingStalls) {
                if (now - entry.injectedAt > timeoutMs) {
                    this.pendingStalls.delete(key);
                    // Delegate to triage system if available
                    if (this.onStallDetected) {
                        this.onStallDetected(entry.channelId, entry.sessionName, entry.text, entry.injectedAt);
                        continue;
                    }
                    // Fallback: LLM-gated user-facing alert
                    const minutesAgo = Math.round((now - entry.injectedAt) / 60000);
                    const alive = this.onIsSessionAlive ? this.onIsSessionAlive(entry.sessionName) : true;
                    const shouldAlert = await this.confirmStallAlert({
                        type: 'stall', sessionName: entry.sessionName,
                        messageText: entry.text, minutesElapsed: minutesAgo, sessionAlive: alive,
                    });
                    if (shouldAlert) {
                        const status = alive ? 'running but not responding' : 'no longer running';
                        this.sendToChannel(entry.channelId, `⚠️ No response after ${minutesAgo} minutes. "${entry.sessionName}" is ${status}.\n\n${alive ? 'Use `!interrupt` to nudge it, or `!restart` to start fresh.' : 'Send another message to start a new session.'}`).catch(() => { });
                    }
                }
            }
            // Check for expired promises
            if (promiseTimeoutMs > 0) {
                for (const [channelId, promise] of this.pendingPromises) {
                    if (promise.alerted)
                        continue;
                    if (now - promise.promisedAt < promiseTimeoutMs)
                        continue;
                    promise.alerted = true;
                    const alive = this.onIsSessionAlive ? this.onIsSessionAlive(promise.sessionName) : true;
                    // Delegate to triage if available
                    if (this.onStallDetected) {
                        this.onStallDetected(channelId, promise.sessionName, `[promise expired] ${promise.promiseText}`, promise.promisedAt);
                        continue;
                    }
                    // Fallback: LLM-gated alert
                    const minutesAgo = Math.round((now - promise.promisedAt) / 60000);
                    const shouldAlert = await this.confirmStallAlert({
                        type: 'promise-expired', sessionName: promise.sessionName,
                        messageText: promise.promiseText, minutesElapsed: minutesAgo, sessionAlive: alive,
                    });
                    if (shouldAlert) {
                        this.sendToChannel(channelId, `⚠️ The agent said "${promise.promiseText.slice(0, 80)}..." ${minutesAgo} minutes ago but hasn't followed up.\n\n${alive ? 'Use `!interrupt` to nudge or `!restart` to start fresh.' : 'Session has ended. Send a new message to start.'}`).catch(() => { });
                    }
                }
            }
        }, 30_000); // Check every 30s
        if (this.stallCheckTimer.unref)
            this.stallCheckTimer.unref();
    }
    /** Get pending stall count. */
    getPendingStallCount() {
        return this.pendingStalls.size;
    }
    /** Track a promise from the agent ("give me a minute" etc.) */
    trackPromise(channelId, sessionName, text) {
        if (this._isPromiseMessage(text)) {
            this.pendingPromises.set(channelId, {
                channelId,
                sessionName,
                promiseText: text.slice(0, 200),
                promisedAt: Date.now(),
                alerted: false,
            });
        }
        else if (this.pendingPromises.has(channelId) && this._isFollowThroughMessage(text)) {
            this.pendingPromises.delete(channelId);
        }
    }
    /** Clear promise tracking for a channel. */
    clearPromiseTracking(channelId) {
        this.pendingPromises.delete(channelId);
    }
    _isPromiseMessage(text) {
        const patterns = [
            /give me (?:a )?(?:couple|few|some) (?:more )?minutes/i,
            /give me (?:a )?(?:minute|moment|second|sec)/i,
            /working on (?:it|this|that)/i,
            /looking into (?:it|this|that)/i,
            /let me (?:check|look|investigate|dig|research)/i,
            /investigating/i,
            /still (?:on it|working|looking)/i,
            /one moment/i, /hang on/i, /bear with me/i,
            /i'll (?:get back|follow up|check|look into)/i,
            /narrowing (?:it |this |that )?down/i,
        ];
        return patterns.some(p => p.test(text));
    }
    _isFollowThroughMessage(text) {
        if (text.length > 200)
            return true;
        const patterns = [
            /here(?:'s| is| are) (?:what|the)/i,
            /i found/i,
            /the (?:issue|problem|bug|fix|solution|answer|result)/i,
            /done|completed|finished|resolved/i,
            /summary|overview|analysis/i,
        ];
        return patterns.some(p => p.test(text));
    }
    /** LLM-gated stall alert confirmation. Returns true if alert should be sent. Fail-open. */
    async confirmStallAlert(context) {
        if (!this.intelligence)
            return true;
        const prompt = [
            'You are evaluating whether to send an alert to a user about an AI agent session.',
            '',
            `Alert type: ${context.type}`,
            `Session: "${context.sessionName}" (${context.sessionAlive ? 'still running' : 'stopped'})`,
            `Time elapsed: ${context.minutesElapsed} minutes`,
            `Context: "${context.messageText}"`,
            '',
            'Should we send a user-facing alert about this? Consider:',
            '- If the session stopped, the user needs to know',
            '- If the session is still running, it might just be working on a complex task',
            `- ${context.minutesElapsed} minutes is ${context.minutesElapsed > 15 ? 'a long time' : 'moderate'} for an AI task`,
            '',
            'Respond with exactly one word: yes or no.',
        ].join('\n');
        try {
            const response = await this.intelligence.evaluate(prompt, { maxTokens: 5, temperature: 0 });
            if (response.trim().toLowerCase() === 'no') {
                console.log(`[slack] LLM suppressed ${context.type} alert for "${context.sessionName}" (${context.minutesElapsed}m)`);
                return false;
            }
            return true;
        }
        catch {
            return true; // Fail-open
        }
    }
    /** Get adapter status. */
    getStatus() {
        return {
            started: this.started,
            uptime: this.started ? Date.now() : null,
            pendingStalls: this.pendingStalls.size,
            pendingPromises: this.pendingPromises.size,
            channelMappings: this.channelToSession.size,
        };
    }
    // ── Registry Persistence ──
    _loadChannelRegistry() {
        try {
            if (fs.existsSync(this.channelRegistryPath)) {
                const data = JSON.parse(fs.readFileSync(this.channelRegistryPath, 'utf-8'));
                for (const [k, v] of Object.entries(data.channelToSession ?? {})) {
                    this.channelToSession.set(k, v);
                }
            }
        }
        catch { /* non-fatal */ }
    }
    _saveChannelRegistry() {
        try {
            const data = { channelToSession: Object.fromEntries(this.channelToSession) };
            const tmp = this.channelRegistryPath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fs.renameSync(tmp, this.channelRegistryPath);
        }
        catch { /* non-fatal */ }
    }
    _loadChannelResumeMap() {
        try {
            if (fs.existsSync(this.channelResumeMapPath)) {
                const data = JSON.parse(fs.readFileSync(this.channelResumeMapPath, 'utf-8'));
                for (const [k, v] of Object.entries(data)) {
                    this.channelResumeMap.set(k, v);
                }
            }
        }
        catch { /* non-fatal */ }
    }
    _saveChannelResumeMap() {
        try {
            const data = Object.fromEntries(this.channelResumeMap);
            const tmp = this.channelResumeMapPath + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fs.renameSync(tmp, this.channelResumeMapPath);
        }
        catch { /* non-fatal */ }
    }
    // ── Test Helpers (underscore-prefixed) ──
    /** Inject a simulated message for testing. */
    async _testInjectMessage(event) {
        await this._handleEvent('message', { event });
    }
    /** Inject a simulated interaction for testing. */
    async _testInjectInteraction(payload) {
        await this._handleInteraction(payload);
    }
    // ── Internal Event Handling ──
    async _handleEvent(type, payload) {
        const event = (payload.event ?? payload);
        if (type === 'message' || event.type === 'message') {
            await this._handleMessage(event);
        }
        else if (type === 'file_shared') {
            await this._handleFileShared(event);
        }
        else if (type === 'channel_created' && this.autoJoinChannels) {
            // Auto-join newly created channels in dedicated mode
            const channel = event.channel;
            const newChannelId = channel?.id ?? event.channel;
            if (newChannelId) {
                this.apiClient.call('conversations.join', { channel: newChannelId }).then(() => {
                    console.log(`[slack] Auto-joined new channel ${newChannelId}`);
                }).catch((err) => {
                    console.warn(`[slack] Could not auto-join new channel: ${err.message}`);
                });
            }
        }
    }
    async _handleMessage(event) {
        const userId = event.user;
        const text = event.text ?? '';
        const channelId = event.channel;
        const ts = event.ts;
        const threadTs = event.thread_ts;
        const files = event.files;
        // Skip most subtypes (edits, deletes, etc.)
        // Allow file_share subtype through — that's how Slack sends messages with attachments
        const subtype = event.subtype;
        if (subtype && subtype !== 'file_share')
            return;
        if (!userId || !channelId)
            return;
        // Dedup — Socket Mode reconnections can redeliver the same event.
        // Slack message timestamps are unique per-channel and safe as dedup keys.
        if (ts && this.seenMessageTs.has(ts)) {
            return;
        }
        if (ts) {
            this.seenMessageTs.add(ts);
        }
        // Bot messages: store in ring buffer for context but don't process as user input
        // This ensures spawned sessions see the full conversation (both sides).
        if (event.bot_id) {
            const buffer = this.channelHistory.get(channelId) ?? new RingBuffer(RING_BUFFER_CAPACITY);
            buffer.push({ ts, user: userId, text, channel: channelId, thread_ts: threadTs });
            this.channelHistory.set(channelId, buffer);
            // Bot replied in this channel — clear stall tracking (the agent answered)
            this.clearStallTracking(channelId);
            return;
        }
        // AuthGate — fail-closed
        if (!this.isAuthorized(userId)) {
            // Send ephemeral "not authorized" message instead of silently dropping
            this.postEphemeral(channelId, userId, `You're not authorized to interact with this agent. Contact the workspace admin to get access.`).catch(() => { });
            return;
        }
        // In mention-only mode, skip messages that don't @mention the bot (except DMs and commands)
        const isDM = channelId.startsWith('D');
        if (this.respondMode === 'mention-only' && !isDM && !this._isBotMentioned(text)) {
            // Still populate ring buffer for context, but don't process
            const buffer = this.channelHistory.get(channelId) ?? new RingBuffer(RING_BUFFER_CAPACITY);
            buffer.push({ ts, user: userId, text, channel: channelId, thread_ts: threadTs });
            this.channelHistory.set(channelId, buffer);
            return;
        }
        // Check for standby commands (unstick, quiet, resume, restart) — these bypass normal processing
        const lowerText = text.trim().toLowerCase();
        if (this.onStandbyCommand && ['unstick', 'quiet', 'resume', 'restart'].includes(lowerText)) {
            const handled = await this.onStandbyCommand(channelId, lowerText, userId);
            if (handled)
                return;
        }
        // Handle commands (Slack intercepts / prefix, so we use ! prefix)
        // Supports both !command and /command (in case Slack delivers it)
        if (text.startsWith('!') || text.startsWith('/')) {
            const normalizedText = text.startsWith('!') ? '/' + text.slice(1) : text;
            const handled = await this._handleSlashCommand(normalizedText, channelId, ts);
            if (handled)
                return;
        }
        // Strip @mention of the bot from message text (so sessions see clean content)
        let cleanText = text;
        if (this.botUserId) {
            cleanText = text.replace(new RegExp(`<@${this.botUserId}>\\s*`, 'g'), '').trim();
        }
        // Download attached files (images, documents, voice/audio) and append appropriate tags
        const filePaths = [];
        if (files && files.length > 0) {
            for (const file of files) {
                const url = file.url_private;
                const mimetype = file.mimetype ?? '';
                const filename = file.name ?? 'file';
                if (!url)
                    continue;
                try {
                    const isImage = mimetype.startsWith('image/');
                    const isAudio = mimetype.startsWith('audio/');
                    const destName = `${isImage ? 'photo' : isAudio ? 'voice' : 'file'}-${Date.now()}-${file.id ?? ts}.${filename.split('.').pop() ?? 'bin'}`;
                    const destPath = path.join(this.fileHandler.downloadDir, destName);
                    const savedPath = await this.fileHandler.downloadFile(url, destPath);
                    filePaths.push(savedPath);
                    if (isImage) {
                        // Validate the downloaded file is actually a processable image
                        const imageValid = this._validateImageFile(savedPath);
                        if (imageValid) {
                            cleanText = cleanText ? `${cleanText} [image:${savedPath}]` : `[image:${savedPath}]`;
                        }
                        else {
                            // File exists but isn't a valid/processable image — fall back to document
                            console.warn(`[slack] Downloaded image failed validation, treating as document: ${savedPath}`);
                            cleanText = cleanText ? `${cleanText} [document:${savedPath}]` : `[document:${savedPath}]`;
                        }
                    }
                    else if (isAudio && this.transcribeVoice) {
                        // Voice message: transcribe and inject as [voice] transcript
                        try {
                            const transcript = await this.transcribeVoice(savedPath);
                            cleanText = cleanText ? `${cleanText} [voice] ${transcript}` : `[voice] ${transcript}`;
                        }
                        catch (transcribeErr) {
                            console.warn(`[slack] Voice transcription failed: ${transcribeErr.message}`);
                            cleanText = cleanText ? `${cleanText} [document:${savedPath}]` : `[document:${savedPath}]`;
                        }
                    }
                    else {
                        cleanText = cleanText ? `${cleanText} [document:${savedPath}]` : `[document:${savedPath}]`;
                    }
                }
                catch (err) {
                    console.warn(`[slack] Failed to download file ${filename}: ${err.message}`);
                    const isImage = mimetype.startsWith('image/');
                    cleanText = cleanText ? `${cleanText} [${isImage ? 'image' : 'document'}:download-failed]` : `[${isImage ? 'image' : 'document'}:download-failed]`;
                }
            }
        }
        // Populate ring buffer (authorized messages only — prevents cache poisoning)
        const buffer = this.channelHistory.get(channelId) ?? new RingBuffer(RING_BUFFER_CAPACITY);
        buffer.push({ ts, user: userId, text: cleanText, channel: channelId, thread_ts: threadTs });
        this.channelHistory.set(channelId, buffer);
        // Resolve user name
        let senderName = userId;
        try {
            const info = await this.getUserInfo(userId);
            senderName = info.name;
        }
        catch {
            // Use userId as fallback
        }
        // Log inbound message
        const logEntry = {
            messageId: ts,
            channelId,
            text: cleanText,
            fromUser: true,
            timestamp: new Date(parseFloat(ts) * 1000).toISOString(),
            sessionName: null,
            senderName: sanitizeDisplayName(senderName),
            platformUserId: userId,
            platform: 'slack',
        };
        this.logger.append(logEntry);
        this.onMessageLogged?.(logEntry);
        // Acknowledge with reaction (fire-and-forget)
        this.addReaction(channelId, ts, 'eyes');
        // Convert to Instar Message format
        const message = {
            id: `slack-${ts}`,
            userId,
            content: cleanText,
            channel: {
                type: 'slack',
                identifier: channelId,
            },
            receivedAt: new Date(parseFloat(ts) * 1000).toISOString(),
            metadata: {
                slackUserId: userId,
                senderName: sanitizeDisplayName(senderName),
                ts,
                threadTs: threadTs,
                channelId,
                isDM,
            },
        };
        // Route to handler
        if (this.messageHandler) {
            try {
                await this.messageHandler(message);
            }
            catch (err) {
                console.error('[slack] Message handler error:', err.message);
            }
        }
        // Mark complete (replace eyes with checkmark)
        this.removeReaction(channelId, ts, 'eyes');
        this.addReaction(channelId, ts, 'white_check_mark');
    }
    async _handleInteraction(payload) {
        const userId = payload.user?.id;
        if (!userId)
            return;
        // AuthGate check
        if (!this.isAuthorized(userId)) {
            console.warn(`[slack] Unauthorized interaction from ${userId}`);
            return;
        }
        const action = payload.actions?.[0];
        if (!action)
            return;
        if (action.action_id.startsWith('prompt::')) {
            const parts = action.action_id.split('::');
            const promptId = parts[1];
            // Validate this is a prompt we sent
            const messageTs = payload.message?.ts;
            if (!messageTs || !this.pendingPrompts.has(messageTs)) {
                console.warn(`[slack] Interaction for unknown prompt ts: ${messageTs}`);
                return;
            }
            const pending = this.pendingPrompts.get(messageTs);
            this.pendingPrompts.delete(messageTs);
            // Clear stall tracking for the channel — prompt was answered
            this.clearStallTracking(pending.channelId);
            // Update message to show selection
            const channelId = payload.channel?.id;
            if (channelId && messageTs) {
                await this.updateMessage(channelId, messageTs, `Answered: ${action.text?.text ?? action.value ?? 'selected'}`).catch(() => { });
            }
            // Inject the response into the session
            const value = action.value ?? action.text?.text ?? '';
            if (this.onPromptResponse && channelId) {
                this.onPromptResponse(channelId, promptId, value);
                console.log(`[slack] Prompt response: session=${pending.sessionName ?? 'unknown'} value="${value}"`);
            }
        }
    }
    async _handleFileShared(event) {
        // Files attached to messages are handled inline in _handleMessage.
        // This handler catches standalone file_shared events (e.g., drag-and-drop without text).
        const userId = event.user_id ?? event.user;
        // AuthGate — check before download (prevents disk exhaustion from unauthorized users)
        if (!userId || !this.isAuthorized(userId)) {
            return;
        }
        // Standalone file_shared events are rare — most files come as message attachments.
        // The file_id is in the event, but we'd need files.info to get the URL.
        // For now, message-embedded files (handled in _handleMessage) cover the primary use case.
        const fileId = event.file_id;
        if (fileId) {
            console.log(`[slack] file_shared event for ${fileId} — handled inline with message`);
        }
    }
    // ── Prompt Gate ──
    /** Register a pending prompt (for interaction validation). */
    registerPendingPrompt(messageTs, promptId, channelId, sessionName) {
        this.pendingPrompts.set(messageTs, {
            promptId,
            channelId,
            messageTs,
            createdAt: Date.now(),
            sessionName,
        });
    }
    _startPromptEviction() {
        const ttl = (this.config.promptGate?.relayTimeoutSeconds ?? 300) * 1000;
        this.promptEvictionTimer = setInterval(() => {
            const now = Date.now();
            for (const [ts, prompt] of this.pendingPrompts) {
                if (now - prompt.createdAt > ttl) {
                    this.pendingPrompts.delete(ts);
                }
            }
        }, 60_000); // Check every 60s
    }
    // ── Utilities ──
    // ── Prompt Gate (Block Kit) ──
    /**
     * Relay a prompt to the user via Block Kit interactive message.
     * Registers the prompt for validation against spoofed button presses.
     */
    async relayPrompt(channelId, promptId, question, options) {
        const blocks = [
            {
                type: 'section',
                text: { type: 'mrkdwn', text: `*Agent needs your input:*\n${question}` },
            },
            {
                type: 'actions',
                elements: options.map((opt, i) => ({
                    type: 'button',
                    text: { type: 'plain_text', text: opt.label },
                    value: opt.value,
                    action_id: `prompt::${promptId}::${i}`,
                    ...(opt.primary ? { style: 'primary' } : {}),
                })),
            },
        ];
        const ts = await this.sendBlocks(channelId, blocks, question);
        this.registerPendingPrompt(ts, promptId, channelId);
    }
    // ── Message Search ──
    /** Search the JSONL message log. */
    searchLog(params) {
        return this.logger.search(params);
    }
    /** Get message log statistics. */
    getLogStats() {
        return this.logger.getStats();
    }
    // ── Channel Housekeeping ──
    /**
     * Auto-archive channels idle for more than AUTO_ARCHIVE_DAYS.
     * Runs periodically. Only archives session channels (sess- prefix).
     */
    async _archiveIdleChannels() {
        try {
            const channels = await this.channelManager.listChannels();
            const now = Date.now();
            const threshold = AUTO_ARCHIVE_DAYS * 24 * 60 * 60 * 1000;
            for (const channel of channels) {
                // Only auto-archive session channels, not system/job channels
                if (!channel.name.includes('-sess-') || channel.is_archived)
                    continue;
                // Check last message time from ring buffer
                const history = this.channelHistory.get(channel.id);
                const lastMessage = history?.toArray().at(-1);
                if (lastMessage) {
                    const lastTs = parseFloat(lastMessage.ts) * 1000;
                    if (now - lastTs > threshold) {
                        await this.channelManager.archiveChannel(channel.id);
                        console.log(`[slack] Auto-archived idle channel: ${channel.name}`);
                    }
                }
            }
        }
        catch (err) {
            console.error('[slack] Channel housekeeping error:', err.message);
        }
    }
    _startHousekeeping() {
        // Run every 6 hours
        this.housekeepingTimer = setInterval(() => {
            this._archiveIdleChannels().catch(() => { });
        }, 6 * 60 * 60 * 1000);
        if (this.housekeepingTimer.unref)
            this.housekeepingTimer.unref();
    }
    // ── Log Retention ──
    /** Purge log entries older than logRetentionDays. */
    _purgeOldLogs() {
        const retentionDays = this.config.logRetentionDays ?? 90;
        if (retentionDays === 0)
            return; // Unlimited
        const logPath = path.join(this.stateDir, 'slack-messages.jsonl');
        if (!fs.existsSync(logPath))
            return;
        try {
            const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
            const content = fs.readFileSync(logPath, 'utf-8');
            const lines = content.split('\n').filter(Boolean);
            const kept = lines.filter(line => {
                try {
                    const entry = JSON.parse(line);
                    return new Date(entry.timestamp) >= cutoff;
                }
                catch {
                    return true; // Keep unparseable lines
                }
            });
            if (kept.length < lines.length) {
                fs.writeFileSync(logPath, kept.join('\n') + '\n');
                console.log(`[slack] Log purge: removed ${lines.length - kept.length} entries older than ${retentionDays} days`);
            }
        }
        catch {
            // Non-fatal — will retry on next cycle
        }
    }
    _startLogPurge() {
        this.logPurgeTimer = setInterval(() => {
            this._purgeOldLogs();
        }, LOG_PURGE_INTERVAL_MS);
        if (this.logPurgeTimer.unref)
            this.logPurgeTimer.unref();
    }
    // ── Dashboard ──
    /**
     * Broadcast the tunnel URL to the dashboard channel.
     * Called by server.ts when tunnel is established.
     */
    /** Last broadcast dashboard URL and message timestamp (for update-in-place) */
    lastDashboardUrl = null;
    lastDashboardMessageTs = null;
    async broadcastDashboardUrl(tunnelUrl) {
        const dashboardChannelId = this.config.dashboardChannelId;
        if (!dashboardChannelId)
            return;
        // Skip if URL hasn't changed
        if (this.lastDashboardUrl === tunnelUrl)
            return;
        const text = `Dashboard available at: ${tunnelUrl}`;
        try {
            if (this.lastDashboardMessageTs) {
                // Update existing message in-place
                await this.updateMessage(dashboardChannelId, this.lastDashboardMessageTs, text);
            }
            else {
                // First time — post new message and pin it
                const ts = await this.sendToChannel(dashboardChannelId, text);
                this.lastDashboardMessageTs = ts;
                try {
                    await this.pinMessage(dashboardChannelId, ts);
                }
                catch { /* already pinned or can't pin */ }
            }
            this.lastDashboardUrl = tunnelUrl;
        }
        catch (err) {
            // If update fails (message deleted?), post new
            try {
                const ts = await this.sendToChannel(dashboardChannelId, text);
                this.lastDashboardMessageTs = ts;
                this.lastDashboardUrl = tunnelUrl;
                try {
                    await this.pinMessage(dashboardChannelId, ts);
                }
                catch { /* ignore */ }
            }
            catch (err2) {
                console.error('[slack] Dashboard broadcast failed:', err2.message);
            }
        }
    }
    // ── Unanswered Message Detection ──
    /**
     * Get count of unanswered user messages in a channel.
     * A message is "unanswered" if it's from a user and no agent reply follows.
     */
    getUnansweredCount(channelId) {
        const messages = this.getChannelMessages(channelId);
        let unanswered = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            const msg = messages[i];
            // Messages from authorized users are "user" messages
            if (this.authorizedUsers.has(msg.user)) {
                unanswered++;
            }
            else {
                break; // Agent reply found — stop counting
            }
        }
        return unanswered;
    }
    // ── Slash Commands (Telegram parity) ──
    /** Handle slash commands from Slack messages. Returns true if handled. */
    async _handleSlashCommand(text, channelId, ts) {
        const parts = text.trim().split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1).join(' ');
        switch (cmd) {
            case '/sessions': {
                // List running sessions
                const sessions = this.getChannelRegistry();
                const lines = Object.entries(sessions).map(([chId, info]) => `• ${info.sessionName}${info.channelName ? ` (#${info.channelName})` : ` (${chId})`}`);
                const reply = lines.length > 0
                    ? `Running Slack sessions:\n${lines.join('\n')}`
                    : 'No active Slack sessions.';
                await this.sendToChannel(channelId, reply);
                return true;
            }
            case '/new': {
                // Create new session with Slack channel
                const name = args || `session-${Date.now()}`;
                const channelName = `${(this.config.workspaceName?.replace(/-agent$/i, '') || 'agent').toLowerCase().replace(/[^a-z0-9]/g, '-')}-sess-${name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40)}`;
                try {
                    const newChannelId = await this.createChannel(channelName);
                    // Invite authorized users
                    for (const uid of this.config.authorizedUserIds) {
                        this.apiClient.call('conversations.invite', { channel: newChannelId, users: uid }).catch(() => { });
                    }
                    await this.sendToChannel(channelId, `Created new session channel: #${channelName}`);
                    await this.sendToChannel(newChannelId, `Session "${name}" is ready. Send a message here to start working.`);
                }
                catch (err) {
                    await this.sendToChannel(channelId, `Failed to create session: ${err.message}`);
                }
                return true;
            }
            case '/claim':
            case '/link': {
                // Claim/link a session to this channel
                if (!args) {
                    await this.sendToChannel(channelId, `Please include a session name — e.g. \`!claim my-session\``);
                    return true;
                }
                const existingSession = this.getSessionForChannel(channelId);
                if (existingSession) {
                    await this.sendToChannel(channelId, `This channel is already linked to "${existingSession}". Use \`!unlink\` first.`);
                    return true;
                }
                this.registerChannelSession(channelId, args);
                await this.sendToChannel(channelId, `Claimed session "${args}" into this channel.`);
                return true;
            }
            case '/unlink': {
                const sessionName = this.getSessionForChannel(channelId);
                if (!sessionName) {
                    await this.sendToChannel(channelId, 'No session linked to this channel.');
                    return true;
                }
                this.unregisterChannel(channelId);
                await this.sendToChannel(channelId, `Unlinked session "${sessionName}" from this channel.`);
                return true;
            }
            case '/interrupt': {
                const sessionName = this.getSessionForChannel(channelId);
                if (!sessionName) {
                    await this.sendToChannel(channelId, 'No session linked to this channel.');
                    return true;
                }
                if (!this.onInterruptSession) {
                    await this.sendToChannel(channelId, 'Interrupt not available.');
                    return true;
                }
                try {
                    const success = await this.onInterruptSession(sessionName);
                    this.clearStallTracking(channelId);
                    await this.sendToChannel(channelId, success
                        ? `Nudged "${sessionName}" — it should resume shortly.`
                        : `Failed to interrupt "${sessionName}" — session may not exist.`);
                }
                catch {
                    await this.sendToChannel(channelId, `Couldn't interrupt the session. It may have already ended.`);
                }
                return true;
            }
            case '/restart': {
                const sessionName = this.getSessionForChannel(channelId);
                if (!sessionName) {
                    await this.sendToChannel(channelId, 'No session linked to this channel.');
                    return true;
                }
                if (!this.onRestartSession) {
                    await this.sendToChannel(channelId, 'Restart not available.');
                    return true;
                }
                this.clearStallTracking(channelId);
                await this.sendToChannel(channelId, `Restarting "${sessionName}"...`);
                try {
                    await this.onRestartSession(sessionName, channelId);
                    await this.sendToChannel(channelId, 'Session restarted.');
                }
                catch {
                    await this.sendToChannel(channelId, `Restart didn't work. Try sending a new message to start a fresh session.`);
                }
                return true;
            }
            case '/triage': {
                if (!this.onGetTriageStatus) {
                    await this.sendToChannel(channelId, 'Triage system not available.');
                    return true;
                }
                const status = this.onGetTriageStatus(channelId);
                if (!status || !status.active) {
                    await this.sendToChannel(channelId, '🔍 No active triage for this channel. Session appears to be operating normally.');
                }
                else {
                    const triageLines = [
                        '🔍 Active triage for this channel:',
                        `Classification: ${status.classification || 'pending'}`,
                        `Checks: ${status.checkCount}`,
                        status.lastCheck ? `Last check: ${status.lastCheck}` : '',
                    ].filter(Boolean);
                    await this.sendToChannel(channelId, triageLines.join('\n'));
                }
                return true;
            }
            case '/status': {
                const s = this.getStatus();
                const wsConfig = this.getWorkspaceConfig();
                const lines = [
                    `Slack adapter: ${s.started ? '✅ running' : '❌ stopped'}`,
                    `Workspace mode: ${wsConfig.mode} (respond: ${wsConfig.respondMode})`,
                    `Channel mappings: ${s.channelMappings}`,
                    `Pending stall alerts: ${s.pendingStalls}`,
                    `Pending promises: ${s.pendingPromises}`,
                ];
                await this.sendToChannel(channelId, lines.join('\n'));
                return true;
            }
            case '/help': {
                await this.sendToChannel(channelId, `Available commands (use \`!\` prefix in Slack):\n` +
                    `• \`!sessions\` — List running sessions\n` +
                    `• \`!new [name]\` — Create a new session channel\n` +
                    `• \`!claim <session>\` — Link a session to this channel\n` +
                    `• \`!unlink\` — Unlink session from this channel\n` +
                    `• \`!interrupt\` — Nudge a stuck session\n` +
                    `• \`!restart\` — Kill and respawn the session\n` +
                    `• \`!triage\` — Show triage status for this channel\n` +
                    `• \`!status\` — Show adapter status\n` +
                    `• \`!help\` — Show this help message`);
                return true;
            }
            default:
                // Unknown command — don't handle, let it pass through as a regular message
                return false;
        }
    }
    /**
     * Auto-join all public channels in the workspace.
     * Only called in dedicated mode or when autoJoinChannels is true.
     * Runs asynchronously — doesn't block startup.
     */
    /**
     * Backfill ring buffers with recent channel history from Slack's API.
     * This runs on startup so that sessions spawned after a server restart
     * have conversation context instead of starting from scratch.
     */
    async _backfillChannelHistory() {
        // Backfill the lifeline channel and any other configured channels
        const channelIds = [
            this.config.lifelineChannelId,
            this.config.dashboardChannelId,
        ].filter(Boolean);
        for (const channelId of channelIds) {
            try {
                const result = await this.apiClient.call('conversations.history', {
                    channel: channelId,
                    limit: 50,
                });
                const messages = result.messages ?? [];
                messages.reverse(); // API returns newest-first, we want oldest-first
                const buffer = this.channelHistory.get(channelId) ?? new RingBuffer(RING_BUFFER_CAPACITY);
                let count = 0;
                for (const m of messages) {
                    const user = m.user ?? m.bot_id;
                    const text = m.text ?? '';
                    const ts = m.ts;
                    const subtype = m.subtype;
                    if (!user || !ts)
                        continue;
                    // Skip join/leave subtypes
                    if (subtype && subtype !== 'file_share')
                        continue;
                    buffer.push({ ts, user, text, channel: channelId });
                    count++;
                }
                this.channelHistory.set(channelId, buffer);
                if (count > 0) {
                    console.log(`[slack] Backfilled ${count} messages for channel ${channelId}`);
                }
            }
            catch (err) {
                console.warn(`[slack] Could not backfill channel ${channelId}: ${err.message}`);
            }
        }
    }
    async _autoJoinAllChannels() {
        try {
            const result = await this.apiClient.call('conversations.list', {
                types: 'public_channel',
                limit: 200,
                exclude_archived: true,
            });
            const channels = (result.channels ?? []);
            let joined = 0;
            for (const ch of channels) {
                if (ch.is_member)
                    continue;
                try {
                    await this.apiClient.call('conversations.join', { channel: ch.id });
                    joined++;
                }
                catch (err) {
                    // channels:join scope might not be available — log and continue
                    console.warn(`[slack] Could not auto-join #${ch.name}: ${err.message}`);
                }
            }
            if (joined > 0) {
                console.log(`[slack] Auto-joined ${joined} channel(s)`);
            }
        }
        catch (err) {
            console.warn(`[slack] Auto-join channel scan failed: ${err.message}`);
        }
    }
    /**
     * Check if a message mentions the bot (via @mention).
     * Slack encodes mentions as <@U12345> in message text.
     */
    /**
     * Validate that a downloaded file is a processable image.
     * Checks magic bytes and file size to avoid Claude API "Could not process image" errors.
     */
    _validateImageFile(filePath) {
        try {
            const stats = fs.statSync(filePath);
            // Too small to be a real image (< 100 bytes is likely an error page or empty)
            if (stats.size < 100) {
                console.warn(`[slack] Image too small (${stats.size} bytes): ${filePath}`);
                return false;
            }
            // Too large for Claude API (> 20MB)
            if (stats.size > 20 * 1024 * 1024) {
                console.warn(`[slack] Image too large (${Math.round(stats.size / 1024 / 1024)}MB): ${filePath}`);
                return false;
            }
            // Check magic bytes for supported image formats
            const header = Buffer.alloc(16);
            const fd = fs.openSync(filePath, 'r');
            fs.readSync(fd, header, 0, 16, 0);
            fs.closeSync(fd);
            // JPEG: FF D8 FF
            if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF)
                return true;
            // PNG: 89 50 4E 47
            if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47)
                return true;
            // GIF: 47 49 46
            if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46)
                return true;
            // WebP: RIFF....WEBP
            if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46
                && header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50)
                return true;
            // BMP: 42 4D
            if (header[0] === 0x42 && header[1] === 0x4D)
                return true;
            // SVG: starts with < (text-based)
            if (header[0] === 0x3C)
                return true;
            // Check if it looks like HTML (Slack error page downloaded instead of image)
            const headerStr = header.toString('utf-8', 0, 10).toLowerCase();
            if (headerStr.includes('<!doctype') || headerStr.includes('<html')) {
                console.warn(`[slack] Downloaded file is HTML, not an image: ${filePath}`);
                return false;
            }
            console.warn(`[slack] Unknown image format (magic: ${header.slice(0, 4).toString('hex')}): ${filePath}`);
            return false;
        }
        catch (err) {
            console.warn(`[slack] Image validation error: ${err.message}`);
            return false;
        }
    }
    _isBotMentioned(text) {
        if (!this.botUserId)
            return false;
        return text.includes(`<@${this.botUserId}>`);
    }
    _chunkText(text) {
        if (text.length <= SLACK_MAX_TEXT_LENGTH)
            return [text];
        const chunks = [];
        let remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= SLACK_MAX_TEXT_LENGTH) {
                chunks.push(remaining);
                break;
            }
            // Try to break at a newline
            let breakPoint = remaining.lastIndexOf('\n', SLACK_MAX_TEXT_LENGTH);
            if (breakPoint < SLACK_MAX_TEXT_LENGTH / 2) {
                // No good newline break — try space
                breakPoint = remaining.lastIndexOf(' ', SLACK_MAX_TEXT_LENGTH);
            }
            if (breakPoint < SLACK_MAX_TEXT_LENGTH / 2) {
                // No good break point — hard break
                breakPoint = SLACK_MAX_TEXT_LENGTH;
            }
            chunks.push(remaining.slice(0, breakPoint));
            remaining = remaining.slice(breakPoint).trimStart();
        }
        return chunks;
    }
}
//# sourceMappingURL=SlackAdapter.js.map