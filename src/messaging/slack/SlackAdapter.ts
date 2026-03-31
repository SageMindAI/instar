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
 */

import path from 'node:path';
import fs from 'node:fs';
import type { MessagingAdapter, Message, OutgoingMessage } from '../../core/types.js';
import { SlackApiClient } from './SlackApiClient.js';
import { SocketModeClient, type SocketModeHandlers } from './SocketModeClient.js';
import { ChannelManager } from './ChannelManager.js';
import { FileHandler } from './FileHandler.js';
import { RingBuffer } from './RingBuffer.js';
import { MessageLogger, type LogEntry } from '../shared/MessageLogger.js';
import type { SlackConfig, SlackMessage, PendingPrompt, InteractionPayload, InteractionAction } from './types.js';
import { sanitizeDisplayName, validateChannelId, escapeMrkdwn } from './sanitize.js';

const RING_BUFFER_CAPACITY = 50;
const SLACK_MAX_TEXT_LENGTH = 4000;
const AUTO_ARCHIVE_DAYS = 7;
const LOG_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // Daily

export class SlackAdapter implements MessagingAdapter {
  readonly platform = 'slack';

  // Config
  private config: SlackConfig;
  private stateDir: string;

  // Components
  private apiClient: SlackApiClient;
  private socketClient: SocketModeClient | null = null;
  private channelManager: ChannelManager;
  private fileHandler: FileHandler;
  private logger: MessageLogger;

  // State
  private messageHandler: ((message: Message) => Promise<void>) | null = null;
  private started = false;
  private authorizedUsers: Set<string>;
  private channelHistory: Map<string, RingBuffer<SlackMessage>> = new Map();
  private pendingPrompts: Map<string, PendingPrompt> = new Map();
  private userCache: Map<string, { name: string; fetchedAt: number }> = new Map();
  private promptEvictionTimer: ReturnType<typeof setInterval> | null = null;
  private housekeepingTimer: ReturnType<typeof setInterval> | null = null;
  private logPurgeTimer: ReturnType<typeof setInterval> | null = null;

  // Callbacks (wired by server.ts)
  /** Called when a prompt gate response is received */
  onPromptResponse: ((channelId: string, promptId: string, value: string) => void) | null = null;
  /** Called when a message is logged (for dual-write to SQLite) */
  onMessageLogged: ((entry: LogEntry) => void) | null = null;

  constructor(config: Record<string, unknown>, stateDir: string) {
    this.config = config as unknown as SlackConfig;
    this.stateDir = stateDir;

    // Validate required fields
    if (!this.config.botToken) throw new Error('[slack] botToken is required');
    if (!this.config.appToken) throw new Error('[slack] appToken is required');
    if (!Array.isArray(this.config.authorizedUserIds)) {
      throw new Error('[slack] authorizedUserIds is required (array of Slack user IDs)');
    }

    // Fail-closed: empty array means deny all
    this.authorizedUsers = new Set(this.config.authorizedUserIds);
    if (this.authorizedUsers.size === 0) {
      console.warn('[slack] authorizedUserIds is empty — all messages will be rejected (fail-closed)');
    }

    // Initialize components
    this.apiClient = new SlackApiClient(this.config.botToken, this.config.appToken);

    const agentName = this.config.workspaceName?.replace(/-agent$/, '') || 'agent';
    this.channelManager = new ChannelManager(this.apiClient, agentName);
    this.fileHandler = new FileHandler(this.apiClient, this.config.botToken, stateDir);
    this.logger = new MessageLogger({
      logPath: path.join(stateDir, 'slack-messages.jsonl'),
      maxLines: 100_000,
      keepLines: 75_000,
    });
  }

  // ── MessagingAdapter Interface ──

  async start(): Promise<void> {
    const handlers: SocketModeHandlers = {
      onEvent: async (type, payload) => this._handleEvent(type, payload),
      onInteraction: async (payload) => this._handleInteraction(payload as unknown as InteractionPayload),
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
        } else {
          console.warn(`[slack] Transient error: ${err.message}`);
        }
      },
    };

    this.socketClient = new SocketModeClient(this.apiClient, handlers);
    await this.socketClient.connect();
    this.started = true;

    // Start pending prompt TTL eviction
    this._startPromptEviction();

    // Start channel housekeeping (auto-archive idle channels)
    this._startHousekeeping();

    // Start log retention purge (daily)
    this._startLogPurge();

    // Purge stale log entries on startup
    this._purgeOldLogs();
  }

  async stop(): Promise<void> {
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
    if (this.socketClient) {
      await this.socketClient.disconnect();
      this.socketClient = null;
    }
  }

  async send(message: OutgoingMessage): Promise<void | unknown> {
    const channelId = message.channel?.identifier;
    if (!channelId) {
      console.error('[slack] Cannot send: no channel identifier');
      return;
    }

    // Chunk long messages
    const chunks = this._chunkText(message.content);

    let lastResult: unknown = null;
    for (const chunk of chunks) {
      const params: Record<string, unknown> = {
        channel: channelId,
        text: chunk,
      };

      // If there's thread_ts in metadata, reply in thread
      if (message.channel?.type === 'slack' && (message as unknown as Record<string, unknown>).threadTs) {
        params.thread_ts = (message as unknown as Record<string, unknown>).threadTs;
      }

      lastResult = await this.apiClient.call('chat.postMessage', params);
    }

    return lastResult;
  }

  onMessage(handler: (message: Message) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async resolveUser(channelIdentifier: string): Promise<string | null> {
    // For Slack, the channel identifier IS the user reference
    return channelIdentifier || null;
  }

  // ── Slack-Specific Public Methods ──

  /** Check if a user is authorized. */
  isAuthorized(userId: string): boolean {
    return this.authorizedUsers.has(userId);
  }

  /** Send a message to a specific channel. */
  async sendToChannel(channelId: string, text: string, options?: { thread_ts?: string }): Promise<string> {
    const params: Record<string, unknown> = { channel: channelId, text };
    if (options?.thread_ts) params.thread_ts = options.thread_ts;
    const result = await this.apiClient.call('chat.postMessage', params);
    return result.ts as string;
  }

  /** Add a reaction (fire-and-forget). */
  addReaction(channelId: string, timestamp: string, emoji: string): void {
    this.apiClient.call('reactions.add', { channel: channelId, timestamp, name: emoji }).catch(() => {});
  }

  /** Remove a reaction (fire-and-forget). */
  removeReaction(channelId: string, timestamp: string, emoji: string): void {
    this.apiClient.call('reactions.remove', { channel: channelId, timestamp, name: emoji }).catch(() => {});
  }

  /** Update an existing message. */
  async updateMessage(channelId: string, timestamp: string, text: string): Promise<void> {
    await this.apiClient.call('chat.update', { channel: channelId, ts: timestamp, text });
  }

  /** Pin a message. */
  async pinMessage(channelId: string, timestamp: string): Promise<void> {
    await this.apiClient.call('pins.add', { channel: channelId, timestamp });
  }

  /** Send an ephemeral message (visible only to one user). */
  async postEphemeral(channelId: string, userId: string, text: string): Promise<void> {
    await this.apiClient.call('chat.postEphemeral', { channel: channelId, user: userId, text });
  }

  /** Send a message with Block Kit blocks. */
  async sendBlocks(channelId: string, blocks: unknown[], text?: string): Promise<string> {
    const params: Record<string, unknown> = { channel: channelId, blocks };
    if (text) params.text = text; // Fallback text for notifications
    const result = await this.apiClient.call('chat.postMessage', params);
    return result.ts as string;
  }

  /** Get cached channel messages from ring buffer. */
  getChannelMessages(channelId: string, limit = 30): SlackMessage[] {
    const buffer = this.channelHistory.get(channelId);
    if (!buffer) return [];
    const all = buffer.toArray();
    return limit >= all.length ? all : all.slice(-limit);
  }

  /** Get user info (cached for 5 minutes). */
  async getUserInfo(userId: string): Promise<{ id: string; name: string }> {
    const cached = this.userCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < 5 * 60 * 1000) {
      return { id: userId, name: cached.name };
    }

    const result = await this.apiClient.call('users.info', { user: userId });
    const user = result.user as { id: string; real_name?: string; name: string };
    const name = user.real_name || user.name;
    this.userCache.set(userId, { name, fetchedAt: Date.now() });
    return { id: userId, name };
  }

  /** Create a channel. */
  async createChannel(name: string, isPrivate?: boolean): Promise<string> {
    return this.channelManager.createChannel(name, isPrivate);
  }

  /** Archive a channel. */
  async archiveChannel(channelId: string): Promise<void> {
    return this.channelManager.archiveChannel(channelId);
  }

  /** Upload a file. */
  async uploadFile(channelId: string, filePath: string, title?: string): Promise<void> {
    return this.fileHandler.uploadFile(channelId, filePath, title);
  }

  /** Download a file. */
  async downloadFile(url: string, destPath: string): Promise<string> {
    return this.fileHandler.downloadFile(url, destPath);
  }

  /** Get the underlying API client (for routes). */
  get api(): SlackApiClient {
    return this.apiClient;
  }

  // ── Test Helpers (underscore-prefixed) ──

  /** Inject a simulated message for testing. */
  async _testInjectMessage(event: Record<string, unknown>): Promise<void> {
    await this._handleEvent('message', { event });
  }

  /** Inject a simulated interaction for testing. */
  async _testInjectInteraction(payload: InteractionPayload): Promise<void> {
    await this._handleInteraction(payload);
  }

  // ── Internal Event Handling ──

  private async _handleEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    const event = (payload.event ?? payload) as Record<string, unknown>;

    if (type === 'message' || event.type === 'message') {
      await this._handleMessage(event);
    } else if (type === 'file_shared') {
      await this._handleFileShared(event);
    }
    // reaction_added, app_mention can be handled later
  }

  private async _handleMessage(event: Record<string, unknown>): Promise<void> {
    const userId = event.user as string;
    const text = event.text as string ?? '';
    const channelId = event.channel as string;
    const ts = event.ts as string;
    const threadTs = event.thread_ts as string | undefined;

    // Skip bot messages and subtypes (edits, deletes, etc.)
    if (event.bot_id || event.subtype) return;
    if (!userId || !channelId) return;

    // AuthGate — fail-closed
    if (!this.isAuthorized(userId)) {
      return; // Silently drop unauthorized messages
    }

    // Populate ring buffer (authorized messages only — prevents cache poisoning)
    const buffer = this.channelHistory.get(channelId) ?? new RingBuffer<SlackMessage>(RING_BUFFER_CAPACITY);
    buffer.push({ ts, user: userId, text, channel: channelId, thread_ts: threadTs });
    this.channelHistory.set(channelId, buffer);

    // Resolve user name
    let senderName = userId;
    try {
      const info = await this.getUserInfo(userId);
      senderName = info.name;
    } catch {
      // Use userId as fallback
    }

    // Log inbound message
    const logEntry: LogEntry = {
      messageId: ts,
      channelId,
      text,
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
    const message: Message = {
      id: `slack-${ts}`,
      userId,
      content: text,
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
        isDM: channelId.startsWith('D'),
      },
    };

    // Route to handler
    if (this.messageHandler) {
      try {
        await this.messageHandler(message);
      } catch (err) {
        console.error('[slack] Message handler error:', (err as Error).message);
      }
    }

    // Mark complete (replace eyes with checkmark)
    this.removeReaction(channelId, ts, 'eyes');
    this.addReaction(channelId, ts, 'white_check_mark');
  }

  private async _handleInteraction(payload: InteractionPayload): Promise<void> {
    const userId = payload.user?.id;
    if (!userId) return;

    // AuthGate check
    if (!this.isAuthorized(userId)) {
      console.warn(`[slack] Unauthorized interaction from ${userId}`);
      return;
    }

    const action = payload.actions?.[0];
    if (!action) return;

    if (action.action_id.startsWith('prompt::')) {
      const parts = action.action_id.split('::');
      const promptId = parts[1];

      // Validate this is a prompt we sent
      const messageTs = payload.message?.ts;
      if (!messageTs || !this.pendingPrompts.has(messageTs)) {
        console.warn(`[slack] Interaction for unknown prompt ts: ${messageTs}`);
        return;
      }

      this.pendingPrompts.delete(messageTs);

      // Update message to show selection
      if (payload.channel?.id && messageTs) {
        await this.updateMessage(
          payload.channel.id,
          messageTs,
          `Answered: ${action.text?.text ?? action.value ?? 'selected'}`,
        ).catch(() => {});
      }
    }
  }

  private async _handleFileShared(event: Record<string, unknown>): Promise<void> {
    const userId = event.user_id as string ?? event.user as string;

    // AuthGate — check before download (prevents disk exhaustion from unauthorized users)
    if (!userId || !this.isAuthorized(userId)) {
      return;
    }

    // File handling would download and route to session
    // Full implementation depends on session injection patterns
  }

  // ── Prompt Gate ──

  /** Register a pending prompt (for interaction validation). */
  registerPendingPrompt(messageTs: string, promptId: string, channelId: string): void {
    this.pendingPrompts.set(messageTs, {
      promptId,
      channelId,
      messageTs,
      createdAt: Date.now(),
    });
  }

  private _startPromptEviction(): void {
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
  async relayPrompt(channelId: string, promptId: string, question: string, options: Array<{ label: string; value: string; primary?: boolean }>): Promise<void> {
    const blocks = [
      {
        type: 'section' as const,
        text: { type: 'mrkdwn' as const, text: `*Agent needs your input:*\n${question}` },
      },
      {
        type: 'actions' as const,
        elements: options.map((opt, i) => ({
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: opt.label },
          value: opt.value,
          action_id: `prompt::${promptId}::${i}`,
          ...(opt.primary ? { style: 'primary' as const } : {}),
        })),
      },
    ];

    const ts = await this.sendBlocks(channelId, blocks, question);
    this.registerPendingPrompt(ts, promptId, channelId);
  }

  // ── Message Search ──

  /** Search the JSONL message log. */
  searchLog(params: { query?: string; channelId?: string; since?: Date; limit?: number }): LogEntry[] {
    return this.logger.search(params);
  }

  /** Get message log statistics. */
  getLogStats(): { totalMessages: number; logSizeBytes: number; logPath: string } {
    return this.logger.getStats();
  }

  // ── Channel Housekeeping ──

  /**
   * Auto-archive channels idle for more than AUTO_ARCHIVE_DAYS.
   * Runs periodically. Only archives session channels (sess- prefix).
   */
  private async _archiveIdleChannels(): Promise<void> {
    try {
      const channels = await this.channelManager.listChannels();
      const now = Date.now();
      const threshold = AUTO_ARCHIVE_DAYS * 24 * 60 * 60 * 1000;

      for (const channel of channels) {
        // Only auto-archive session channels, not system/job channels
        if (!channel.name.includes('-sess-') || channel.is_archived) continue;

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
    } catch (err) {
      console.error('[slack] Channel housekeeping error:', (err as Error).message);
    }
  }

  private _startHousekeeping(): void {
    // Run every 6 hours
    this.housekeepingTimer = setInterval(() => {
      this._archiveIdleChannels().catch(() => {});
    }, 6 * 60 * 60 * 1000);
    if (this.housekeepingTimer.unref) this.housekeepingTimer.unref();
  }

  // ── Log Retention ──

  /** Purge log entries older than logRetentionDays. */
  private _purgeOldLogs(): void {
    const retentionDays = this.config.logRetentionDays ?? 90;
    if (retentionDays === 0) return; // Unlimited

    const logPath = path.join(this.stateDir, 'slack-messages.jsonl');
    if (!fs.existsSync(logPath)) return;

    try {
      const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const content = fs.readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const kept = lines.filter(line => {
        try {
          const entry = JSON.parse(line);
          return new Date(entry.timestamp) >= cutoff;
        } catch {
          return true; // Keep unparseable lines
        }
      });

      if (kept.length < lines.length) {
        fs.writeFileSync(logPath, kept.join('\n') + '\n');
        console.log(`[slack] Log purge: removed ${lines.length - kept.length} entries older than ${retentionDays} days`);
      }
    } catch {
      // Non-fatal — will retry on next cycle
    }
  }

  private _startLogPurge(): void {
    this.logPurgeTimer = setInterval(() => {
      this._purgeOldLogs();
    }, LOG_PURGE_INTERVAL_MS);
    if (this.logPurgeTimer.unref) this.logPurgeTimer.unref();
  }

  // ── Dashboard ──

  /**
   * Broadcast the tunnel URL to the dashboard channel.
   * Called by server.ts when tunnel is established.
   */
  async broadcastDashboardUrl(tunnelUrl: string): Promise<void> {
    const dashboardChannelId = this.config.dashboardChannelId;
    if (!dashboardChannelId) return;

    const text = `Dashboard available at: ${tunnelUrl}`;
    try {
      await this.sendToChannel(dashboardChannelId, text);
      await this.pinMessage(dashboardChannelId, (await this.sendToChannel(dashboardChannelId, text)));
    } catch (err) {
      console.error('[slack] Dashboard broadcast failed:', (err as Error).message);
    }
  }

  // ── Unanswered Message Detection ──

  /**
   * Get count of unanswered user messages in a channel.
   * A message is "unanswered" if it's from a user and no agent reply follows.
   */
  getUnansweredCount(channelId: string): number {
    const messages = this.getChannelMessages(channelId);
    let unanswered = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      // Messages from authorized users are "user" messages
      if (this.authorizedUsers.has(msg.user)) {
        unanswered++;
      } else {
        break; // Agent reply found — stop counting
      }
    }
    return unanswered;
  }

  private _chunkText(text: string): string[] {
    if (text.length <= SLACK_MAX_TEXT_LENGTH) return [text];

    const chunks: string[] = [];
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
