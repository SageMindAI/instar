/**
 * Telegram Messaging Adapter — send/receive messages via Telegram Bot API.
 *
 * Uses long polling to receive messages. Supports forum topics
 * (each user gets a topic thread). Includes topic-session registry
 * and message logging for session respawn with thread history.
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

export class TelegramAdapter implements MessagingAdapter {
  readonly platform = 'telegram';

  private config: TelegramConfig;
  private handler: ((message: Message) => Promise<void>) | null = null;
  private polling = false;
  private pollTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateId = 0;

  // Topic-session registry (persisted to disk)
  private topicToSession: Map<number, string> = new Map();
  private sessionToTopic: Map<string, number> = new Map();
  private topicToName: Map<number, string> = new Map();
  private registryPath: string;
  private messageLogPath: string;
  private offsetPath: string;

  // Topic message callback — fires on every incoming topic message
  public onTopicMessage: ((message: Message) => void) | null = null;

  constructor(config: TelegramConfig, stateDir: string) {
    this.config = config;
    this.registryPath = path.join(stateDir, 'topic-session-registry.json');
    this.messageLogPath = path.join(stateDir, 'telegram-messages.jsonl');
    this.offsetPath = path.join(stateDir, 'telegram-poll-offset.json');
    this.loadRegistry();
    this.loadOffset();
  }

  async start(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    console.log(`[telegram] Starting long-polling...`);
    this.poll();
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    const topicId = message.channel?.identifier;
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text: message.content,
      parse_mode: 'Markdown',
    };

    if (topicId && parseInt(topicId, 10) > 1) {
      params.message_thread_id = parseInt(topicId, 10);
    }

    try {
      await this.apiCall('sendMessage', params);
    } catch (err) {
      // Only retry without parse_mode on 400 errors (likely Markdown parse failures)
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('(400)') && params.parse_mode) {
        delete params.parse_mode;
        await this.apiCall('sendMessage', params);
      } else {
        throw err;
      }
    }
  }

  /**
   * Send a message to a specific forum topic.
   */
  async sendToTopic(topicId: number, text: string): Promise<void> {
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text,
    };
    // Topic ID 1 = General topic (our fallback) — omit message_thread_id for General
    if (topicId > 1) {
      params.message_thread_id = topicId;
    }

    try {
      await this.apiCall('sendMessage', { ...params, parse_mode: 'Markdown' });
    } catch {
      await this.apiCall('sendMessage', params);
    }

    // Log outbound messages too
    this.appendToLog({
      messageId: 0,
      topicId,
      text,
      fromUser: false,
      timestamp: new Date().toISOString(),
      sessionName: this.topicToSession.get(topicId) ?? null,
    });
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

  onMessage(handler: (message: Message) => Promise<void>): void {
    this.handler = handler;
  }

  async resolveUser(channelIdentifier: string): Promise<string | null> {
    return null;
  }

  // ── Topic-Session Registry ─────────────────────────────────

  registerTopicSession(topicId: number, sessionName: string): void {
    this.topicToSession.set(topicId, sessionName);
    this.sessionToTopic.set(sessionName, topicId);
    this.saveRegistry();
    console.log(`[telegram] Registered topic ${topicId} <-> session "${sessionName}"`);
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

  // ── Message Log ────────────────────────────────────────────

  /**
   * Get recent messages for a topic (for thread history on respawn).
   */
  getTopicHistory(topicId: number, limit: number = 20): LogEntry[] {
    if (!fs.existsSync(this.messageLogPath)) return [];

    // Read the last portion of the file to avoid loading everything into memory.
    // With log rotation capping at 5,000 lines, this is a bounded operation,
    // but we still optimize by reading only what we need for most cases.
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
      // Rotate log if it exceeds 10,000 lines to prevent unbounded growth
      this.maybeRotateLog();
    } catch (err) {
      console.error(`[telegram] Failed to append to message log: ${err}`);
    }
  }

  /** Keep only the last 5,000 lines when log exceeds 10,000 lines. */
  private maybeRotateLog(): void {
    try {
      const stat = fs.statSync(this.messageLogPath);
      // Only check rotation when file exceeds ~2MB (rough proxy for 10k lines)
      if (stat.size < 2 * 1024 * 1024) return;

      const content = fs.readFileSync(this.messageLogPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      if (lines.length > 10_000) {
        const kept = lines.slice(-5_000);
        const tmpPath = `${this.messageLogPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
          fs.writeFileSync(tmpPath, kept.join('\n') + '\n');
          fs.renameSync(tmpPath, this.messageLogPath);
        } catch (rotateErr) {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          throw rotateErr;
        }
        console.log(`[telegram] Rotated message log: ${lines.length} → ${kept.length} lines`);
      }
    } catch {
      // Non-critical — don't fail on rotation errors
    }
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
      for (const update of updates) {
        if (update.message?.text) {
          const msg = update.message;
          const text = msg.text!;
          // Use message_thread_id if present; fall back to 1 (General topic) for forum groups
          const numericTopicId = msg.message_thread_id ?? 1;
          const topicId = numericTopicId.toString();

          // Auto-capture topic name from reply_to_message
          if (msg.reply_to_message?.forum_topic_created?.name) {
            if (!this.topicToName.has(numericTopicId)) {
              this.topicToName.set(numericTopicId, msg.reply_to_message.forum_topic_created.name);
              this.saveRegistry();
            }
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

        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
      }

      // Persist offset so restarts don't re-process old messages
      if (updates.length > 0) {
        this.saveOffset();
      }
    } catch (err) {
      console.error(`[telegram] Poll error: ${err}`);
    }

    // Schedule next poll
    const interval = this.config.pollIntervalMs ?? 2000;
    this.pollTimeout = setTimeout(() => this.poll(), interval);
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
