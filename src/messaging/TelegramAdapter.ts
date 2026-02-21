/**
 * Telegram Messaging Adapter — send/receive messages via Telegram Bot API.
 *
 * Uses long polling to receive messages. Supports forum topics
 * (each user gets a topic thread). Includes topic-session registry,
 * message logging, voice transcription, photo handling, stall detection,
 * auth gating, and delivery confirmation.
 *
 * No external dependencies — uses native fetch for Telegram API calls.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MessagingAdapter, Message, OutgoingMessage, UserChannel } from '../core/types.js';

export interface TelegramConfig {
  /** Bot token from @BotFather */
  token: string;
  /** Forum chat ID (the supergroup where topics live) */
  chatId: string;
  /** Polling interval in ms */
  pollIntervalMs?: number;
  /** Authorized Telegram user IDs (only these users' messages are processed) */
  authorizedUserIds?: number[];
  /** Voice transcription provider: 'groq' or 'openai' (auto-detects if not set) */
  voiceProvider?: string;
  /** Stall detection timeout in minutes (default: 5, 0 to disable) */
  stallTimeoutMinutes?: number;
}

export interface SendResult {
  /** Telegram message ID */
  messageId: number;
  /** Topic the message was sent to */
  topicId?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number };
    message_thread_id?: number;
    text?: string;
    date: number;
    reply_to_message?: {
      message_id: number;
      forum_topic_created?: { name: string };
    };
    voice?: {
      file_id: string;
      file_unique_id: string;
      duration: number;
      mime_type?: string;
      file_size?: number;
    };
    photo?: Array<{
      file_id: string;
      file_unique_id: string;
      width: number;
      height: number;
      file_size?: number;
    }>;
    caption?: string;
  };
}

interface LogEntry {
  messageId: number;
  topicId: number | null;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
}

export interface AttentionItem {
  id: string;
  title: string;
  summary: string;
  description?: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
  status: 'OPEN' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'DONE' | 'WONT_DO';
  sourceContext?: string;
  createdAt: string;
  updatedAt: string;
  topicId?: number;
}

/**
 * Telegram General topic convention:
 * - Incoming: messages in General have message_thread_id=1 (or undefined in older API)
 * - Internal: we use GENERAL_TOPIC_ID (1) as the sentinel
 * - Outgoing: we OMIT message_thread_id for General (don't send 1, don't send 0)
 *
 * The isGeneralTopic() helper should be used instead of raw `topicId === 1` checks
 * to keep the convention in one place.
 */
const GENERAL_TOPIC_ID = 1;

function isGeneralTopic(topicId: number): boolean {
  return topicId <= GENERAL_TOPIC_ID;
}

const PRIORITY_EMOJI: Record<string, string> = {
  URGENT: '\ud83d\udd34',  // 🔴
  HIGH: '\ud83d\udfe0',     // 🟠
  NORMAL: '\ud83d\udd35',   // 🔵
  LOW: '\u26aa',             // ⚪
};

const PRIORITY_COLOR: Record<string, number> = {
  URGENT: 16478047,   // red
  HIGH: 16749490,     // orange
  NORMAL: 7322096,    // blue
  LOW: 13338331,      // purple
};

/** Tracks a pending message for stall detection */
interface PendingMessage {
  topicId: number;
  sessionName: string;
  messageText: string;
  injectedAt: number; // Date.now()
  alerted: boolean;
}

export class TelegramAdapter implements MessagingAdapter {
  readonly platform = 'telegram';

  private config: TelegramConfig;
  private handler: ((message: Message) => Promise<void>) | null = null;
  private polling = false;
  private pollTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateId = 0;
  private startedAt: Date | null = null;
  private consecutivePollErrors = 0;

  // Topic-session registry (persisted to disk)
  private topicToSession: Map<number, string> = new Map();
  private sessionToTopic: Map<string, number> = new Map();
  private topicToName: Map<number, string> = new Map();
  private registryPath: string;
  private messageLogPath: string;
  private offsetPath: string;
  private stateDir: string;

  // Attention queue (persisted to disk)
  private attentionItemToTopic: Map<string, number> = new Map();
  private attentionTopicToItem: Map<number, string> = new Map();
  private attentionItems: Map<string, AttentionItem> = new Map();
  private attentionFilePath: string;

  // Stall detection
  private pendingMessages: Map<string, PendingMessage> = new Map(); // key = topicId-timestamp
  private stallCheckInterval: ReturnType<typeof setInterval> | null = null;

  // Topic message callback — fires on every incoming topic message
  public onTopicMessage: ((message: Message) => void) | null = null;

  // Session management callbacks (wired by server.ts)
  public onInterruptSession: ((sessionName: string) => Promise<boolean>) | null = null;
  public onRestartSession: ((sessionName: string, topicId: number) => Promise<void>) | null = null;
  public onListSessions: (() => Array<{ name: string; tmuxSession: string; status: string; alive: boolean }>) | null = null;
  public onIsSessionAlive: ((tmuxSession: string) => boolean) | null = null;
  public onIsSessionActive: ((tmuxSession: string) => Promise<boolean>) | null = null;

  // Attention queue callbacks
  public onAttentionStatusChange: ((itemId: string, status: string) => Promise<void>) | null = null;

  constructor(config: TelegramConfig, stateDir: string) {
    this.config = config;
    this.stateDir = stateDir;
    this.registryPath = path.join(stateDir, 'topic-session-registry.json');
    this.messageLogPath = path.join(stateDir, 'telegram-messages.jsonl');
    this.offsetPath = path.join(stateDir, 'telegram-poll-offset.json');
    this.attentionFilePath = path.join(stateDir, 'state', 'attention-items.json');
    this.loadRegistry();
    this.loadOffset();
    this.loadAttentionItems();
  }

  async start(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.startedAt = new Date();
    this.consecutivePollErrors = 0;
    console.log(`[telegram] Starting long-polling...`);
    this.poll();

    // Start stall detection if configured
    const stallMinutes = this.config.stallTimeoutMinutes ?? 5;
    if (stallMinutes > 0) {
      this.stallCheckInterval = setInterval(() => this.checkForStalls(), 30_000); // Check every 30s
    }
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    if (this.stallCheckInterval) {
      clearInterval(this.stallCheckInterval);
      this.stallCheckInterval = null;
    }
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const topicId = message.channel?.identifier;
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text: message.content,
      parse_mode: 'Markdown',
    };

    if (topicId && !isGeneralTopic(parseInt(topicId, 10))) {
      params.message_thread_id = parseInt(topicId, 10);
    }

    try {
      const result = await this.apiCall('sendMessage', params) as { message_id: number };
      return { messageId: result.message_id, topicId: topicId ? parseInt(topicId, 10) : undefined };
    } catch (err) {
      // Only retry without parse_mode on 400 errors (likely Markdown parse failures)
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('(400)') && params.parse_mode) {
        delete params.parse_mode;
        const result = await this.apiCall('sendMessage', params) as { message_id: number };
        return { messageId: result.message_id, topicId: topicId ? parseInt(topicId, 10) : undefined };
      }
      throw err;
    }
  }

  /**
   * Send a message to a specific forum topic.
   * Returns the Telegram message ID for delivery confirmation.
   */
  async sendToTopic(topicId: number, text: string): Promise<SendResult> {
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text,
    };
    if (!isGeneralTopic(topicId)) {
      params.message_thread_id = topicId;
    }

    let result: { message_id: number };
    try {
      result = await this.apiCall('sendMessage', { ...params, parse_mode: 'Markdown' }) as { message_id: number };
    } catch {
      result = await this.apiCall('sendMessage', params) as { message_id: number };
    }

    // Log outbound messages too
    this.appendToLog({
      messageId: result.message_id,
      topicId,
      text,
      fromUser: false,
      timestamp: new Date().toISOString(),
      sessionName: this.topicToSession.get(topicId) ?? null,
    });

    // Clear stall tracking for this topic (agent responded)
    this.clearStallForTopic(topicId);

    return { messageId: result.message_id, topicId };
  }

  /**
   * Create a forum topic in the supergroup.
   */
  async createForumTopic(name: string, iconColor?: number): Promise<{ topicId: number; name: string }> {
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      name,
    };
    if (iconColor !== undefined) {
      params.icon_color = iconColor;
    }

    const result = await this.apiCall('createForumTopic', params) as {
      message_thread_id: number;
      name: string;
    };

    this.topicToName.set(result.message_thread_id, name);
    this.saveRegistry();

    console.log(`[telegram] Created forum topic: "${name}" (ID: ${result.message_thread_id})`);
    return { topicId: result.message_thread_id, name: result.name };
  }

  /**
   * Close a forum topic.
   */
  async closeForumTopic(topicId: number): Promise<boolean> {
    try {
      await this.apiCall('closeForumTopic', {
        chat_id: this.config.chatId,
        message_thread_id: topicId,
      });
      return true;
    } catch {
      return false;
    }
  }

  onMessage(handler: (message: Message) => Promise<void>): void {
    this.handler = handler;
  }

  async resolveUser(channelIdentifier: string): Promise<string | null> {
    return null;
  }

  // ── Auth Gating ──────────────────────────────────────────

  /**
   * Check if a message is from an authorized user.
   * If no authorizedUserIds configured, all messages are accepted.
   */
  private isAuthorized(userId: number): boolean {
    const authorized = this.config.authorizedUserIds;
    if (!authorized || authorized.length === 0) return true;
    return authorized.includes(userId);
  }

  // ── Topic-Session Registry ─────────────────────────────────

  registerTopicSession(topicId: number, sessionName: string): void {
    this.topicToSession.set(topicId, sessionName);
    this.sessionToTopic.set(sessionName, topicId);
    this.saveRegistry();
    console.log(`[telegram] Registered topic ${topicId} <-> session "${sessionName}"`);
  }

  unregisterTopic(topicId: number): void {
    const sessionName = this.topicToSession.get(topicId);
    this.topicToSession.delete(topicId);
    if (sessionName) this.sessionToTopic.delete(sessionName);
    this.saveRegistry();
  }

  getSessionForTopic(topicId: number): string | null {
    return this.topicToSession.get(topicId) ?? null;
  }

  getTopicForSession(sessionName: string): number | null {
    return this.sessionToTopic.get(sessionName) ?? null;
  }

  getTopicName(topicId: number): string | null {
    return this.topicToName.get(topicId) ?? null;
  }

  /**
   * Get all topic-session mappings (for admin/debug UIs).
   */
  getAllTopicMappings(): Array<{ topicId: number; sessionName: string; topicName: string | null }> {
    const result: Array<{ topicId: number; sessionName: string; topicName: string | null }> = [];
    for (const [topicId, sessionName] of this.topicToSession) {
      result.push({
        topicId,
        sessionName,
        topicName: this.topicToName.get(topicId) ?? null,
      });
    }
    return result;
  }

  // ── Stall Detection ──────────────────────────────────────

  /**
   * Track that a message was injected into a session.
   * Used by stall detection to alert if no response comes back.
   */
  trackMessageInjection(topicId: number, sessionName: string, messageText: string): void {
    const key = `${topicId}-${Date.now()}`;
    this.pendingMessages.set(key, {
      topicId,
      sessionName,
      messageText: messageText.slice(0, 100),
      injectedAt: Date.now(),
      alerted: false,
    });
  }

  private clearStallForTopic(topicId: number): void {
    for (const [key, pending] of this.pendingMessages) {
      if (pending.topicId === topicId) {
        this.pendingMessages.delete(key);
      }
    }
  }

  private async checkForStalls(): Promise<void> {
    const stallMinutes = this.config.stallTimeoutMinutes ?? 5;
    const stallThresholdMs = stallMinutes * 60 * 1000;
    const now = Date.now();

    for (const [key, pending] of this.pendingMessages) {
      if (pending.alerted) continue;
      if (now - pending.injectedAt < stallThresholdMs) continue;

      // Check if session is still alive
      const alive = this.onIsSessionAlive
        ? this.onIsSessionAlive(pending.sessionName)
        : true; // assume alive if no checker

      // If alive, verify the session is truly stalled (not just responding through a different path)
      if (alive && this.onIsSessionActive) {
        try {
          const active = await this.onIsSessionActive(pending.sessionName);
          if (active) {
            // Session is producing output — false alarm, clear it
            console.log(`[telegram] Session "${pending.sessionName}" verified active, clearing stall`);
            this.pendingMessages.delete(key);
            continue;
          }
        } catch {
          // Verifier failed — fall through to alert
        }
      }

      pending.alerted = true;

      const status = alive ? 'running but not responding' : 'no longer running';
      const minutesAgo = Math.round((now - pending.injectedAt) / 60000);
      this.sendToTopic(
        pending.topicId,
        `\u26a0\ufe0f No response after ${minutesAgo} minutes. Session "${pending.sessionName}" is ${status}.\n\nMessage: "${pending.messageText}..."${alive ? '\n\nTry /interrupt to unstick, or /restart to respawn.' : '\n\nSend another message to auto-respawn.'}`,
      ).catch(err => {
        console.error(`[telegram] Stall alert failed: ${err}`);
      });
    }

    // Clean up old entries (older than 30 minutes, already alerted)
    for (const [key, pending] of this.pendingMessages) {
      if (pending.alerted && now - pending.injectedAt > 30 * 60 * 1000) {
        this.pendingMessages.delete(key);
      }
    }
  }

  // ── Health Status ────────────────────────────────────────

  getStatus(): {
    started: boolean;
    uptime: number | null;
    pendingStalls: number;
    topicMappings: number;
  } {
    return {
      started: this.polling,
      uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : null,
      pendingStalls: this.pendingMessages.size,
      topicMappings: this.topicToSession.size,
    };
  }

  // ── Voice Transcription ──────────────────────────────────

  /**
   * Download a file from Telegram by file_id.
   */
  private async downloadFile(fileId: string, destPath: string): Promise<void> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const fileInfo = await this.apiCall('getFile', { file_id: fileId }) as { file_path: string };
        const fileUrl = `https://api.telegram.org/file/bot${this.config.token}/${fileInfo.file_path}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60_000);
        try {
          const response = await fetch(fileUrl, { signal: controller.signal });
          if (!response.ok) throw new Error(`Download failed: ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());
          fs.writeFileSync(destPath, buffer);
          return; // Success
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const delay = attempt * 1000;
          console.warn(`[telegram] File download attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError!;
  }

  /**
   * Resolve voice transcription provider from config or environment.
   * Checks explicit config, then env vars, then auto-detects.
   */
  private resolveTranscriptionProvider(): { apiKey: string; baseUrl: string; model: string } | null {
    const providers: Record<string, { envKey: string; baseUrl: string; model: string }> = {
      groq: {
        envKey: 'GROQ_API_KEY',
        baseUrl: 'https://api.groq.com/openai/v1',
        model: 'whisper-large-v3',
      },
      openai: {
        envKey: 'OPENAI_API_KEY',
        baseUrl: 'https://api.openai.com/v1',
        model: 'whisper-1',
      },
    };

    // Check explicit config
    const explicit = this.config.voiceProvider?.toLowerCase();
    if (explicit && providers[explicit]) {
      const p = providers[explicit];
      const apiKey = process.env[p.envKey];
      if (!apiKey) {
        console.warn(`[telegram] ${p.envKey} not set — required for ${explicit} voice transcription`);
        return null;
      }
      return { apiKey, baseUrl: p.baseUrl, model: p.model };
    }

    // Auto-detect: try Groq first (cheaper), then OpenAI
    for (const [name, p] of Object.entries(providers)) {
      const apiKey = process.env[p.envKey];
      if (apiKey) {
        console.log(`[telegram] Auto-detected voice transcription provider: ${name}`);
        return { apiKey, baseUrl: p.baseUrl, model: p.model };
      }
    }

    return null;
  }

  /**
   * Transcribe a voice message using the configured provider.
   */
  private async transcribeVoice(filePath: string): Promise<string> {
    const provider = this.resolveTranscriptionProvider();
    if (!provider) {
      throw new Error('No voice transcription provider configured. Set GROQ_API_KEY or OPENAI_API_KEY.');
    }

    const formData = new FormData();
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: 'audio/ogg' });
    formData.append('file', blob, path.basename(filePath));
    formData.append('model', provider.model);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`${provider.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Transcription API error (${response.status}): ${errText}`);
      }

      const data = await response.json() as { text: string };
      return data.text;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Photo Handling ───────────────────────────────────────

  /**
   * Download a photo from Telegram and save it locally.
   * Returns the local file path.
   */
  private async downloadPhoto(fileId: string, messageId: number): Promise<string> {
    const photoDir = path.join(this.stateDir, 'telegram-images');
    fs.mkdirSync(photoDir, { recursive: true });
    const filename = `photo-${Date.now()}-${messageId}.jpg`;
    const filepath = path.join(photoDir, filename);
    await this.downloadFile(fileId, filepath);
    return filepath;
  }

  // ── Command Handling ─────────────────────────────────────

  /**
   * Process Telegram commands. Returns true if the message was a command.
   */
  private async handleCommand(text: string, topicId: number, userId: number): Promise<boolean> {
    const cmd = text.trim().toLowerCase();

    // Attention topic commands — intercept before general commands
    if (this.isAttentionTopic(topicId)) {
      const handled = await this.handleAttentionCommand(topicId, text);
      if (handled) return true;
    }

    // /sessions — list all sessions with claim status
    if (cmd === '/sessions' || cmd.startsWith('/sessions ')) {
      const filterUnclaimed = cmd.includes('unclaimed');
      if (!this.onListSessions) {
        await this.sendToTopic(topicId, 'Session listing not available.').catch(() => {});
        return true;
      }

      const sessions = this.onListSessions();
      if (sessions.length === 0) {
        await this.sendToTopic(topicId, 'No sessions running.').catch(() => {});
        return true;
      }

      const lines: string[] = [];
      for (const s of sessions) {
        const linkedTopic = this.getTopicForSession(s.tmuxSession);
        const claimed = linkedTopic !== null;
        if (filterUnclaimed && claimed) continue;

        const status = s.alive ? '\u2705' : '\u274c';
        const claimTag = claimed ? ` (topic ${linkedTopic})` : ' \u{1f7e1} unclaimed';
        lines.push(`${status} ${s.name}${claimTag}`);
      }

      if (lines.length === 0) {
        await this.sendToTopic(topicId, filterUnclaimed ? 'No unclaimed sessions.' : 'No sessions.').catch(() => {});
      } else {
        await this.sendToTopic(topicId, lines.join('\n')).catch(() => {});
      }
      return true;
    }

    // /claim <session> — claim a session into this topic
    if (cmd.startsWith('/claim ')) {
      const sessionName = text.trim().slice(7).trim();
      if (!sessionName) {
        await this.sendToTopic(topicId, 'Usage: /claim <session-name>').catch(() => {});
        return true;
      }

      // Check if already claimed
      const existingSession = this.getSessionForTopic(topicId);
      if (existingSession) {
        await this.sendToTopic(topicId, `This topic is already linked to "${existingSession}". Use /unlink first.`).catch(() => {});
        return true;
      }

      this.registerTopicSession(topicId, sessionName);
      await this.sendToTopic(topicId, `Claimed session "${sessionName}" into this topic.`).catch(() => {});
      return true;
    }

    // /link <session> — alias for /claim
    if (cmd.startsWith('/link ')) {
      const sessionName = text.trim().slice(6).trim();
      if (!sessionName) {
        await this.sendToTopic(topicId, 'Usage: /link <session-name>').catch(() => {});
        return true;
      }

      const existingSession = this.getSessionForTopic(topicId);
      if (existingSession) {
        await this.sendToTopic(topicId, `This topic is already linked to "${existingSession}". Use /unlink first.`).catch(() => {});
        return true;
      }

      this.registerTopicSession(topicId, sessionName);
      await this.sendToTopic(topicId, `Linked session "${sessionName}" to this topic.`).catch(() => {});
      return true;
    }

    // /unlink — unlink session from this topic
    if (cmd === '/unlink') {
      const sessionName = this.getSessionForTopic(topicId);
      if (!sessionName) {
        await this.sendToTopic(topicId, 'No session linked to this topic.').catch(() => {});
        return true;
      }

      this.unregisterTopic(topicId);
      await this.sendToTopic(topicId, `Unlinked session "${sessionName}" from this topic.`).catch(() => {});
      return true;
    }

    // /interrupt — send Escape to unstick a stalled session
    if (cmd === '/interrupt') {
      const sessionName = this.getSessionForTopic(topicId);
      if (!sessionName) {
        await this.sendToTopic(topicId, 'No session linked to this topic.').catch(() => {});
        return true;
      }

      if (!this.onInterruptSession) {
        await this.sendToTopic(topicId, 'Interrupt not available (no handler registered).').catch(() => {});
        return true;
      }

      try {
        const success = await this.onInterruptSession(sessionName);
        // Clear stall tracking — user is actively intervening
        this.clearStallForTopic(topicId);
        if (success) {
          await this.sendToTopic(topicId, `Sent Escape to "${sessionName}" \u2014 it should resume processing.`).catch(() => {});
        } else {
          await this.sendToTopic(topicId, `Failed to interrupt "${sessionName}" \u2014 session may not exist.`).catch(() => {});
        }
      } catch (err) {
        await this.sendToTopic(topicId, `Interrupt error: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      }
      return true;
    }

    // /restart — kill and respawn the session for this topic
    if (cmd === '/restart') {
      const sessionName = this.getSessionForTopic(topicId);
      if (!sessionName) {
        await this.sendToTopic(topicId, 'No session linked to this topic.').catch(() => {});
        return true;
      }

      if (!this.onRestartSession) {
        await this.sendToTopic(topicId, 'Restart not available (no handler registered).').catch(() => {});
        return true;
      }

      // Clear stall tracking — user is actively intervening
      this.clearStallForTopic(topicId);
      await this.sendToTopic(topicId, `Restarting "${sessionName}"...`).catch(() => {});
      try {
        await this.onRestartSession(sessionName, topicId);
        await this.sendToTopic(topicId, 'Session restarted.').catch(() => {});
      } catch (err) {
        await this.sendToTopic(topicId, `Restart failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      }
      return true;
    }

    // /status — show Telegram adapter status
    if (cmd === '/status') {
      const s = this.getStatus();
      const lines = [
        `Telegram adapter: ${s.started ? '\u2705 running' : '\u274c stopped'}`,
        `Uptime: ${s.uptime ? Math.round(s.uptime / 60000) + 'm' : 'n/a'}`,
        `Topic mappings: ${s.topicMappings}`,
        `Pending stall alerts: ${s.pendingStalls}`,
      ];
      await this.sendToTopic(topicId, lines.join('\n')).catch(() => {});
      return true;
    }

    return false;
  }

  // ── Message Log ────────────────────────────────────────────

  /**
   * Search the message log with flexible filters.
   * Supports text query, topicId filter, date range, and pagination.
   */
  searchLog(opts: {
    query?: string;
    topicId?: number;
    since?: Date;
    limit?: number;
  } = {}): LogEntry[] {
    if (!fs.existsSync(this.messageLogPath)) return [];

    const limit = Math.min(opts.limit ?? 50, 500);
    const queryLower = opts.query?.toLowerCase();
    const sinceMs = opts.since?.getTime();

    const content = fs.readFileSync(this.messageLogPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    // Scan from end for efficiency (most queries want recent messages)
    const matches: LogEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && matches.length < limit; i--) {
      try {
        const entry: LogEntry = JSON.parse(lines[i]);

        if (opts.topicId !== undefined && entry.topicId !== opts.topicId) continue;
        if (sinceMs && new Date(entry.timestamp).getTime() < sinceMs) continue;
        if (queryLower && !entry.text.toLowerCase().includes(queryLower)) continue;

        matches.unshift(entry); // Maintain chronological order
      } catch { /* skip malformed */ }
    }

    return matches;
  }

  /**
   * Get message log statistics.
   */
  getLogStats(): { totalMessages: number; logSizeBytes: number; logPath: string } {
    if (!fs.existsSync(this.messageLogPath)) {
      return { totalMessages: 0, logSizeBytes: 0, logPath: this.messageLogPath };
    }
    const stat = fs.statSync(this.messageLogPath);
    const content = fs.readFileSync(this.messageLogPath, 'utf-8');
    const lineCount = content.split('\n').filter(Boolean).length;
    return { totalMessages: lineCount, logSizeBytes: stat.size, logPath: this.messageLogPath };
  }

  /**
   * Get recent messages for a topic (for thread history on respawn).
   */
  getTopicHistory(topicId: number, limit: number = 20): LogEntry[] {
    if (!fs.existsSync(this.messageLogPath)) return [];

    // Read the file to find matching entries.
    // Log rotation caps at 75,000 lines, so this is bounded.
    const content = fs.readFileSync(this.messageLogPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    // Scan from end to find matching entries (most recent first)
    const matching: LogEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && matching.length < limit; i--) {
      try {
        const entry: LogEntry = JSON.parse(lines[i]);
        if (entry.topicId === topicId) {
          matching.unshift(entry); // Maintain chronological order
        }
      } catch { /* skip malformed */ }
    }

    return matching;
  }

  private appendToLog(entry: LogEntry): void {
    try {
      fs.appendFileSync(this.messageLogPath, JSON.stringify(entry) + '\n');
      // Rotate log if it exceeds 100,000 lines to prevent unbounded growth.
      // Limit is intentionally high — message history is core memory for the agent.
      // On a dedicated machine, text-only JSONL can safely grow to tens of MB.
      this.maybeRotateLog();
    } catch (err) {
      console.error(`[telegram] Failed to append to message log: ${err}`);
    }
  }

  /** Keep only the last 75,000 lines when log exceeds 100,000 lines.
   *  High limits because message history is core agent memory.
   *  At ~200 bytes/line average, 100k lines ~ 20MB — fine for a dedicated machine. */
  private maybeRotateLog(): void {
    try {
      const stat = fs.statSync(this.messageLogPath);
      // Only check rotation when file exceeds ~20MB
      if (stat.size < 20 * 1024 * 1024) return;

      const content = fs.readFileSync(this.messageLogPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length > 100_000) {
        const kept = lines.slice(-75_000);
        const tmpPath = `${this.messageLogPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
          fs.writeFileSync(tmpPath, kept.join('\n') + '\n');
          fs.renameSync(tmpPath, this.messageLogPath);
        } catch (rotateErr) {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          throw rotateErr;
        }
        console.log(`[telegram] Rotated message log: ${lines.length} -> ${kept.length} lines`);
      }
    } catch {
      // Non-critical — don't fail on rotation errors
    }
  }

  // ── Attention Queue ────────────────────────────────────────

  /**
   * Create an attention item and its Telegram topic.
   */
  async createAttentionItem(item: Omit<AttentionItem, 'createdAt' | 'updatedAt' | 'status' | 'topicId'>): Promise<AttentionItem> {
    // Check for existing
    if (this.attentionItems.has(item.id)) {
      return this.attentionItems.get(item.id)!;
    }

    const now = new Date().toISOString();
    const attention: AttentionItem = {
      ...item,
      status: 'OPEN',
      createdAt: now,
      updatedAt: now,
    };

    // Create Telegram topic
    try {
      const emoji = PRIORITY_EMOJI[item.priority] || PRIORITY_EMOJI.NORMAL;
      const color = PRIORITY_COLOR[item.priority] || PRIORITY_COLOR.NORMAL;
      const topicTitle = `${emoji} ${item.title}`.slice(0, 128);

      const result = await this.apiCall(
        'createForumTopic',
        { chat_id: this.config.chatId, name: topicTitle, icon_color: color },
      ) as { message_thread_id: number };

      const topicId = result.message_thread_id;
      attention.topicId = topicId;

      // Register mappings
      this.attentionItemToTopic.set(item.id, topicId);
      this.attentionTopicToItem.set(topicId, item.id);
      this.topicToName.set(topicId, item.title);
      this.saveRegistry();

      // Post details as first message
      const detail = [
        `<b>${this.escapeHtml(item.category)}</b> | Priority: ${item.priority}`,
        ``,
        this.escapeHtml(item.summary),
        item.description ? `\n${this.escapeHtml(item.description.slice(0, 1000))}` : '',
        item.sourceContext ? `\n<i>Source: ${this.escapeHtml(item.sourceContext)}</i>` : '',
        ``,
        `Commands: /ack, /done, /wontdo, /reopen`,
      ].filter(Boolean).join('\n');

      // Send as HTML by calling API directly
      const sendParams: Record<string, unknown> = {
        chat_id: this.config.chatId,
        text: detail,
        parse_mode: 'HTML',
      };
      if (!isGeneralTopic(topicId)) sendParams.message_thread_id = topicId;
      await this.apiCall('sendMessage', sendParams);
    } catch (err) {
      console.error(`[telegram] Failed to create attention topic for "${item.title}": ${err}`);
    }

    this.attentionItems.set(item.id, attention);
    this.saveAttentionItems();
    return attention;
  }

  /**
   * Update attention item status. Called by /ack, /done, /wontdo, /reopen commands.
   */
  async updateAttentionStatus(itemId: string, status: AttentionItem['status']): Promise<boolean> {
    const item = this.attentionItems.get(itemId);
    if (!item) return false;

    item.status = status;
    item.updatedAt = new Date().toISOString();
    this.saveAttentionItems();

    const topicId = this.attentionItemToTopic.get(itemId);
    if (topicId) {
      const labels: Record<string, string> = {
        'ACKNOWLEDGED': '\ud83d\udc40 Acknowledged',
        'IN_PROGRESS': '\ud83d\udd28 In Progress',
        'DONE': '\u2705 Done',
        'WONT_DO': '\u23ed Won\'t Do',
        'OPEN': '\ud83d\udccb Reopened',
      };
      await this.sendToTopic(topicId, `Status \u2192 ${labels[status] || status}`).catch(() => {});

      // Auto-close/reopen topic
      try {
        if (status === 'DONE' || status === 'WONT_DO') {
          await this.apiCall('closeForumTopic', { chat_id: this.config.chatId, message_thread_id: topicId });
        } else if (status === 'OPEN') {
          await this.apiCall('reopenForumTopic', { chat_id: this.config.chatId, message_thread_id: topicId });
        }
      } catch { /* topic operations may fail if already in desired state */ }
    }

    // Fire callback for external integrations
    if (this.onAttentionStatusChange) {
      await this.onAttentionStatusChange(itemId, status).catch(err => {
        console.error(`[telegram] Attention status callback failed: ${err}`);
      });
    }

    return true;
  }

  /**
   * Get all attention items, optionally filtered by status.
   */
  getAttentionItems(status?: string): AttentionItem[] {
    const items = Array.from(this.attentionItems.values());
    if (status) return items.filter(i => i.status === status);
    return items;
  }

  /**
   * Get a specific attention item.
   */
  getAttentionItem(itemId: string): AttentionItem | undefined {
    return this.attentionItems.get(itemId);
  }

  /**
   * Check if a topic is an attention topic.
   */
  isAttentionTopic(topicId: number): boolean {
    return this.attentionTopicToItem.has(topicId);
  }

  /**
   * Handle commands in attention topics (/ack, /done, /wontdo, /reopen).
   * Returns true if handled, false if not an attention command.
   */
  async handleAttentionCommand(topicId: number, text: string): Promise<boolean> {
    const itemId = this.attentionTopicToItem.get(topicId);
    if (!itemId) return false;

    const cmd = text.trim().toLowerCase();
    const statusMap: Record<string, AttentionItem['status']> = {
      '/ack': 'ACKNOWLEDGED',
      '/acknowledge': 'ACKNOWLEDGED',
      '/done': 'DONE',
      '/wontdo': 'WONT_DO',
      '/reopen': 'OPEN',
    };

    if (cmd in statusMap) {
      await this.updateAttentionStatus(itemId, statusMap[cmd]);
      return true;
    }

    return false;
  }

  private loadAttentionItems(): void {
    try {
      if (!fs.existsSync(this.attentionFilePath)) return;
      const data = JSON.parse(fs.readFileSync(this.attentionFilePath, 'utf-8'));
      if (data.items) {
        for (const item of data.items) {
          this.attentionItems.set(item.id, item);
          if (item.topicId) {
            this.attentionItemToTopic.set(item.id, item.topicId);
            this.attentionTopicToItem.set(item.topicId, item.id);
          }
        }
        console.log(`[telegram] Loaded ${this.attentionItems.size} attention items`);
      }
    } catch { /* file doesn't exist yet */ }
  }

  private saveAttentionItems(): void {
    try {
      const dir = path.dirname(this.attentionFilePath);
      fs.mkdirSync(dir, { recursive: true });
      const data = { items: Array.from(this.attentionItems.values()) };
      const tmpPath = `${this.attentionFilePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, this.attentionFilePath);
    } catch (err) {
      console.error(`[telegram] Failed to save attention items: ${err}`);
    }
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Registry Persistence ───────────────────────────────────

  private loadRegistry(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
      if (data.topicToSession) {
        for (const [k, v] of Object.entries(data.topicToSession)) {
          this.topicToSession.set(Number(k), v as string);
          this.sessionToTopic.set(v as string, Number(k));
        }
      }
      if (data.topicToName) {
        for (const [k, v] of Object.entries(data.topicToName)) {
          this.topicToName.set(Number(k), v as string);
        }
      }
      console.log(`[telegram] Loaded ${this.topicToSession.size} topic-session mappings from disk`);
    } catch {
      // File doesn't exist yet — start fresh
    }
  }

  private saveRegistry(): void {
    try {
      const data = {
        topicToSession: Object.fromEntries(this.topicToSession),
        topicToName: Object.fromEntries(this.topicToName),
      };
      // Atomic write: unique temp filename to prevent concurrent corruption
      const tmpPath = this.registryPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
        fs.renameSync(tmpPath, this.registryPath);
      } catch (writeErr) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw writeErr;
      }
    } catch (err) {
      console.error(`[telegram] Failed to save registry: ${err}`);
    }
  }

  // ── Polling Offset Persistence ────────────────────────────

  private loadOffset(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.offsetPath, 'utf-8'));
      if (typeof data.lastUpdateId === 'number' && Number.isFinite(data.lastUpdateId) && data.lastUpdateId > 0) {
        this.lastUpdateId = data.lastUpdateId;
        console.log(`[telegram] Restored poll offset: ${this.lastUpdateId}`);
      }
    } catch {
      // File doesn't exist or is corrupted — start from 0
    }
  }

  private saveOffset(): void {
    try {
      const tmpPath = `${this.offsetPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        fs.writeFileSync(tmpPath, JSON.stringify({ lastUpdateId: this.lastUpdateId }));
        fs.renameSync(tmpPath, this.offsetPath);
      } catch (writeErr) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw writeErr;
      }
    } catch (err) {
      console.error(`[telegram] Failed to save poll offset: ${err}`);
    }
  }

  // ── Polling ────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (!this.polling) return;

    try {
      const updates = await this.getUpdates();
      this.consecutivePollErrors = 0; // Reset on success

      for (const update of updates) {
        await this.processUpdate(update);
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
      }

      // Persist offset so restarts don't re-process old messages
      if (updates.length > 0) {
        this.saveOffset();
      }
    } catch (err) {
      this.consecutivePollErrors++;
      const errMsg = err instanceof Error ? err.message : String(err);

      // Check for fatal errors that require restart
      if (errMsg.includes('401') || errMsg.includes('Unauthorized')) {
        console.error(`[telegram] FATAL: Bot token is invalid. Stopping polling.`);
        this.polling = false;
        return;
      }

      // Exponential backoff on consecutive errors
      if (this.consecutivePollErrors > 1) {
        const backoffMs = Math.min(1000 * Math.pow(2, this.consecutivePollErrors - 1), 60_000);
        console.error(`[telegram] Poll error (attempt ${this.consecutivePollErrors}), backing off ${backoffMs}ms: ${errMsg}`);
        await new Promise(r => setTimeout(r, backoffMs));
      } else {
        console.error(`[telegram] Poll error: ${errMsg}`);
      }
    }

    // Schedule next poll
    const interval = this.config.pollIntervalMs ?? 2000;
    this.pollTimeout = setTimeout(() => this.poll(), interval);
  }

  /**
   * Process a single Telegram update (text, voice, or photo).
   */
  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg) return;

    // Auth gating — reject messages from unauthorized users
    if (!this.isAuthorized(msg.from.id)) {
      console.log(`[telegram] Ignoring message from unauthorized user ${msg.from.id} (${msg.from.username ?? msg.from.first_name})`);
      return;
    }

    const numericTopicId = msg.message_thread_id ?? GENERAL_TOPIC_ID;
    const topicId = numericTopicId.toString();

    // Auto-capture topic name from reply_to_message
    if (msg.reply_to_message?.forum_topic_created?.name) {
      if (!this.topicToName.has(numericTopicId)) {
        this.topicToName.set(numericTopicId, msg.reply_to_message.forum_topic_created.name);
        this.saveRegistry();
      }
    }

    // Handle voice messages
    if (msg.voice) {
      await this.handleVoiceMessage(msg, numericTopicId);
      return;
    }

    // Handle photo messages
    if (msg.photo && msg.photo.length > 0) {
      await this.handlePhotoMessage(msg, numericTopicId);
      return;
    }

    // Handle text messages
    if (!msg.text) return;

    const text = msg.text;

    // Check for commands first
    if (text.startsWith('/')) {
      const handled = await this.handleCommand(text, numericTopicId, msg.from.id);
      if (handled) return;
    }

    const message: Message = {
      id: `tg-${msg.message_id}`,
      userId: msg.from.id.toString(),
      content: text,
      channel: { type: 'telegram', identifier: topicId },
      receivedAt: new Date(msg.date * 1000).toISOString(),
      metadata: {
        telegramUserId: msg.from.id,
        username: msg.from.username,
        firstName: msg.from.first_name,
        messageThreadId: numericTopicId,
      },
    };

    // Log the message
    this.appendToLog({
      messageId: msg.message_id,
      topicId: numericTopicId,
      text,
      fromUser: true,
      timestamp: new Date(msg.date * 1000).toISOString(),
      sessionName: this.topicToSession.get(numericTopicId) ?? null,
    });

    // Fire topic message callback (always fires — General topic falls back to ID 1)
    if (this.onTopicMessage) {
      try {
        this.onTopicMessage(message);
      } catch (err) {
        console.error(`[telegram] Topic message handler error: ${err}`);
      }
    }

    // Fire general handler
    if (this.handler) {
      try {
        await this.handler(message);
      } catch (err) {
        console.error(`[telegram] Handler error: ${err}`);
      }
    }
  }

  /**
   * Handle an incoming voice message: download, transcribe, route as text.
   */
  private async handleVoiceMessage(
    msg: NonNullable<TelegramUpdate['message']>,
    topicId: number,
  ): Promise<void> {
    const voice = msg.voice!;

    // Download the voice file
    const voiceDir = path.join(this.stateDir, 'telegram-voice');
    fs.mkdirSync(voiceDir, { recursive: true });
    const filename = `voice-${Date.now()}-${msg.message_id}.ogg`;
    const filepath = path.join(voiceDir, filename);

    try {
      await this.downloadFile(voice.file_id, filepath);
    } catch (err) {
      console.error(`[telegram] Failed to download voice: ${err}`);
      await this.sendToTopic(topicId, `(Voice message received but download failed)`).catch(() => {});
      return;
    }

    // Transcribe
    try {
      const transcript = await this.transcribeVoice(filepath);
      console.log(`[telegram] Transcribed voice (${voice.duration}s): "${transcript.slice(0, 80)}"`);

      // Create a message with the transcription
      const message: Message = {
        id: `tg-${msg.message_id}`,
        userId: msg.from.id.toString(),
        content: `[voice] ${transcript}`,
        channel: { type: 'telegram', identifier: topicId.toString() },
        receivedAt: new Date(msg.date * 1000).toISOString(),
        metadata: {
          telegramUserId: msg.from.id,
          username: msg.from.username,
          firstName: msg.from.first_name,
          messageThreadId: topicId,
          voiceFile: filepath,
          voiceDuration: voice.duration,
        },
      };

      // Log it
      this.appendToLog({
        messageId: msg.message_id,
        topicId,
        text: `[voice] ${transcript}`,
        fromUser: true,
        timestamp: new Date(msg.date * 1000).toISOString(),
        sessionName: this.topicToSession.get(topicId) ?? null,
      });

      // Fire callbacks
      if (this.onTopicMessage) {
        try {
          this.onTopicMessage(message);
        } catch (err) {
          console.error(`[telegram] Topic message handler error: ${err}`);
        }
      }
      if (this.handler) {
        try {
          await this.handler(message);
        } catch (err) {
          console.error(`[telegram] Handler error: ${err}`);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isNotConfigured = errMsg.includes('No voice transcription provider configured');
      const replyText = isNotConfigured
        ? '\ud83c\udfa4 Voice transcription is not configured. To enable it, set GROQ_API_KEY or OPENAI_API_KEY in your environment.'
        : `(Voice message received but transcription failed: ${errMsg})`;
      await this.sendToTopic(topicId, replyText).catch(() => {});
    } finally {
      // Clean up voice file after processing
      try { fs.unlinkSync(filepath); } catch { /* ignore */ }
    }
  }

  /**
   * Handle an incoming photo message: download, save, route with path.
   */
  private async handlePhotoMessage(
    msg: NonNullable<TelegramUpdate['message']>,
    topicId: number,
  ): Promise<void> {
    const photos = msg.photo!;
    // Get highest resolution (last in array)
    const photo = photos[photos.length - 1];
    const caption = msg.caption || '';

    try {
      const filepath = await this.downloadPhoto(photo.file_id, msg.message_id);
      console.log(`[telegram] Downloaded photo: ${filepath}`);

      const content = caption
        ? `[image:${filepath}] ${caption}`
        : `[image:${filepath}]`;

      const message: Message = {
        id: `tg-${msg.message_id}`,
        userId: msg.from.id.toString(),
        content,
        channel: { type: 'telegram', identifier: topicId.toString() },
        receivedAt: new Date(msg.date * 1000).toISOString(),
        metadata: {
          telegramUserId: msg.from.id,
          username: msg.from.username,
          firstName: msg.from.first_name,
          messageThreadId: topicId,
          photoPath: filepath,
        },
      };

      // Log it
      this.appendToLog({
        messageId: msg.message_id,
        topicId,
        text: content,
        fromUser: true,
        timestamp: new Date(msg.date * 1000).toISOString(),
        sessionName: this.topicToSession.get(topicId) ?? null,
      });

      // Fire callbacks
      if (this.onTopicMessage) {
        try {
          this.onTopicMessage(message);
        } catch (err) {
          console.error(`[telegram] Topic message handler error: ${err}`);
        }
      }
      if (this.handler) {
        try {
          await this.handler(message);
        } catch (err) {
          console.error(`[telegram] Handler error: ${err}`);
        }
      }
    } catch (err) {
      console.error(`[telegram] Failed to download photo: ${err}`);
      await this.sendToTopic(topicId, `(Photo received but download failed: ${err instanceof Error ? err.message : String(err)})`).catch(() => {});
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const result = await this.apiCall('getUpdates', {
      offset: this.lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['message'],
    });

    return (result as TelegramUpdate[]) ?? [];
  }

  private async apiCall(method: string, params: Record<string, unknown>, retryCount: number = 0): Promise<unknown> {
    const url = `https://api.telegram.org/bot${this.config.token}/${method}`;
    const safeUrl = `https://api.telegram.org/bot[REDACTED]/${method}`;

    // Long polling uses 30s timeout in params — give extra headroom
    const timeoutMs = method === 'getUpdates' ? 60_000 : 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Handle 429 Too Many Requests — respect Telegram's retry_after
      if (response.status === 429) {
        if (retryCount >= 3) {
          throw new Error(`Telegram API rate limited ${safeUrl} (429) after ${retryCount} retries`);
        }
        try {
          const errorData = await response.json() as { parameters?: { retry_after?: number } };
          const retryAfter = errorData?.parameters?.retry_after ?? 5;
          console.warn(`[telegram] Rate limited on ${method}, waiting ${retryAfter}s (retry ${retryCount + 1}/3)...`);
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          return this.apiCall(method, params, retryCount + 1);
        } catch (retryErr) {
          if (retryErr instanceof Error && retryErr.message.includes('after')) throw retryErr;
          throw new Error(`Telegram API rate limited ${safeUrl} (429)`);
        }
      }
      const text = await response.text();
      throw new Error(`Telegram API error ${safeUrl} (${response.status}): ${text}`);
    }

    const data = await response.json() as { ok: boolean; result: unknown };
    if (!data.ok) {
      throw new Error(`Telegram API returned not ok: ${JSON.stringify(data)}`);
    }

    return data.result;
  }
}
