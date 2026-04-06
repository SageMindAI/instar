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
import type { MessagingAdapter, Message, OutgoingMessage, UserChannel, IntelligenceProvider } from '../core/types.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { NotificationBatcher, NotificationTier } from './NotificationBatcher.js';
import type { ContentValidationConfig } from './TopicContentValidator.js';
import { validateTopicContent, getTopicPurpose, classifyContent } from './TopicContentValidator.js';
import { SHARED_INFRA_FLAGS } from './shared/FeatureFlags.js';
import { MessageLogger, type LogEntry as SharedLogEntry } from './shared/MessageLogger.js';
import { SessionChannelRegistry } from './shared/SessionChannelRegistry.js';
import { StallDetector, type StallEvent } from './shared/StallDetector.js';
import { CommandRouter } from './shared/CommandRouter.js';
import { AuthGate } from './shared/AuthGate.js';
import { MessagingEventBus } from './shared/MessagingEventBus.js';
import { CallbackRegistry, isAllowedButtonKey } from '../core/CallbackRegistry.js';
import type { DetectedPrompt } from '../monitoring/PromptGate.js';
import { sanitizeForPrompt } from '../monitoring/SessionRecovery.js';

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
  /** Promise follow-through timeout in minutes (default: 10, 0 to disable) */
  promiseTimeoutMinutes?: number;
  /** Lifeline topic thread ID — the always-available channel. Auto-recreated if deleted. */
  lifelineTopicId?: number;
  /** Dashboard topic thread ID — auto-broadcasts tunnel URL on startup. */
  dashboardTopicId?: number;
  /** Dashboard PIN (for including in broadcast messages). */
  dashboardPin?: string;
  /** Content validation configuration — validates outbound messages against topic purpose */
  contentValidation?: ContentValidationConfig;
  /** Prompt Gate configuration for Telegram relay */
  promptGate?: {
    /** Telegram user ID of the session owner (only this user can respond to prompts) */
    ownerId?: number;
    /** Timeout in seconds for relay responses (default: 300 = 5 min) */
    relayTimeoutSeconds?: number;
  };
}

/** Tracks a pending text reply for a Prompt Gate relay (no-button prompts) */
interface PendingPromptReply {
  prompt: DetectedPrompt;
  relayMessageId: number;
  createdAt: number;
  reminderSent?: boolean;
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
    document?: {
      file_id: string;
      file_unique_id: string;
      file_name?: string;
      mime_type?: string;
      file_size?: number;
    };
    forum_topic_created?: { name: string };
    forum_topic_edited?: { name?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name: string; username?: string };
    message?: {
      message_id: number;
      chat: { id: number };
      message_thread_id?: number;
    };
    data?: string;
  };
}

interface LogEntry {
  messageId: number;
  topicId: number | null;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
  senderName?: string;
  senderUsername?: string;
  telegramUserId?: number;
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

/**
 * Standard topic styles for visual organization in Telegram forum.
 * Colors are the 6 values Telegram's Bot API accepts for icon_color.
 * Emojis prefix topic names for at-a-glance scanning.
 */
export const TOPIC_STYLE = {
  /** Green — core infrastructure (Lifeline) */
  SYSTEM:  { color: 9367192,  emoji: '🛡️' },
  /** Purple — automated recurring jobs */
  JOB:     { color: 13338331, emoji: '⚙️' },
  /** Green — interactive user sessions */
  SESSION: { color: 9367192,  emoji: '💬' },
  /** Blue — informational (Dashboard, Updates) */
  INFO:    { color: 7322096,  emoji: '📢' },
  /** Yellow — needs user attention */
  ALERT:   { color: 16766590, emoji: '🔔' },
} as const;

/**
 * Keyword → emoji mapping for smart topic emoji selection.
 * First match wins, so more specific patterns come first.
 * Falls back to 💬 for unmatched names.
 */
const TOPIC_EMOJI_KEYWORDS: Array<{ keywords: string[]; emoji: string }> = [
  { keywords: ['debug', 'bug', 'fix', 'issue', 'error'],   emoji: '🐛' },
  { keywords: ['deploy', 'release', 'ship', 'launch'],      emoji: '🚀' },
  { keywords: ['test', 'testing', 'qa', 'cypress', 'jest'], emoji: '🧪' },
  { keywords: ['review', 'pr', 'code review'],              emoji: '👀' },
  { keywords: ['research', 'explore', 'investigate'],        emoji: '🔍' },
  { keywords: ['design', 'ui', 'ux', 'frontend', 'css'],    emoji: '🎨' },
  { keywords: ['doc', 'docs', 'readme', 'write', 'draft'],  emoji: '📝' },
  { keywords: ['build', 'ci', 'pipeline', 'compile'],       emoji: '🏗️' },
  { keywords: ['security', 'auth', 'permission', 'access'], emoji: '🔒' },
  { keywords: ['perf', 'performance', 'speed', 'optimize'],  emoji: '⚡' },
  { keywords: ['data', 'database', 'db', 'sql', 'prisma'],  emoji: '🗄️' },
  { keywords: ['api', 'endpoint', 'route', 'server'],       emoji: '🔌' },
  { keywords: ['monitor', 'metric', 'observ', 'dashboard'], emoji: '📊' },
  { keywords: ['alert', 'incident', 'urgent', 'critical'],  emoji: '🚨' },
  { keywords: ['brainstorm', 'idea', 'think', 'plan'],      emoji: '💡' },
  { keywords: ['migrate', 'migration', 'upgrade'],          emoji: '🔄' },
  { keywords: ['config', 'setting', 'env'],                 emoji: '⚙️' },
  { keywords: ['email', 'mail', 'newsletter', 'outreach'],  emoji: '📧' },
  { keywords: ['chat', 'talk', 'conversation', 'discuss'],  emoji: '💬' },
  { keywords: ['learn', 'study', 'tutorial', 'course'],     emoji: '📚' },
  { keywords: ['money', 'payment', 'billing', 'cost'],      emoji: '💰' },
  { keywords: ['clean', 'cleanup', 'refactor', 'tidy'],     emoji: '🧹' },
];

/**
 * Select an appropriate emoji for a topic based on its name.
 * Matches keywords case-insensitively. Falls back to 💬 for unmatched names.
 */
export function selectTopicEmoji(topicName: string): string {
  const lower = topicName.toLowerCase();
  for (const entry of TOPIC_EMOJI_KEYWORDS) {
    if (entry.keywords.some(kw => lower.includes(kw))) {
      return entry.emoji;
    }
  }
  return TOPIC_STYLE.SESSION.emoji; // 💬 default
}

/** Tracks a pending message for stall detection */
interface PendingMessage {
  topicId: number;
  sessionName: string;
  messageText: string;
  injectedAt: number; // Date.now()
  alerted: boolean;
}

/** Tracks an agent promise that expects follow-through */
interface PendingPromise {
  topicId: number;
  sessionName: string;
  promiseText: string;
  promisedAt: number;
  alerted: boolean;
}

export class TelegramAdapter implements MessagingAdapter {
  readonly platform = 'telegram';

  private config: TelegramConfig;
  private handler: ((message: Message) => Promise<void>) | null = null;
  private polling = false;

  /** True when this adapter is actively polling for messages (false in send-only mode). */
  get isPolling(): boolean { return this.polling; }
  private pollTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastUpdateId = 0;
  private startedAt: Date | null = null;
  private consecutivePollErrors = 0;

  // Forum detection — if the chat is not a forum, skip all topic operations
  private notAForum = false;
  private notAForumWarned = false;

  // Topic-session registry (persisted to disk)
  private topicToSession: Map<number, string> = new Map();
  private sessionToTopic: Map<string, number> = new Map();
  private topicToName: Map<number, string> = new Map();
  private topicToPurpose: Map<number, string> = new Map();
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

  // Promise tracking (agent said "give me a minute" but hasn't followed up)
  private pendingPromises: Map<number, PendingPromise> = new Map(); // key = topicId

  // Topic message callback — fires on every incoming topic message
  public onTopicMessage: ((message: Message) => void | Promise<void>) | null = null;

  // Session management callbacks (wired by server.ts)
  public onInterruptSession: ((sessionName: string) => Promise<boolean>) | null = null;
  public onRestartSession: ((sessionName: string, topicId: number) => Promise<void>) | null = null;
  public onListSessions: (() => Array<{ name: string; tmuxSession: string; status: string; alive: boolean }>) | null = null;
  public onIsSessionAlive: ((tmuxSession: string) => boolean) | null = null;
  public onIsSessionActive: ((tmuxSession: string) => Promise<boolean>) | null = null;

  // Message log callback — fires on every message logged (inbound and outbound).
  // Used by TopicMemory to dual-write to SQLite for search and summarization.
  // Includes sender identity fields (Phase 1C/1D — User-Agent Topology Spec).
  public onMessageLogged: ((entry: { messageId: number; topicId: number | null; text: string; fromUser: boolean; timestamp: string; sessionName: string | null; senderName?: string; senderUsername?: string; telegramUserId?: number }) => void) | null = null;

  // Sentinel interceptor — fires BEFORE the message handler for real-time interrupt detection.
  // Returns the sentinel classification. If category is 'emergency-stop' or 'pause',
  // the adapter will handle the session action and skip the normal handler.
  public onSentinelIntercept: ((message: string, topicId: number) => Promise<{
    category: 'emergency-stop' | 'pause' | 'redirect' | 'normal';
    action: { type: string; message?: string };
    reason?: string;
  } | null>) | null = null;

  // Session kill/pause callbacks — used by sentinel to take immediate action
  public onSentinelKillSession: ((sessionName: string) => boolean) | null = null;
  public onSentinelPauseSession: ((sessionName: string) => void) | null = null;

  // Attention queue callbacks
  public onAttentionStatusChange: ((itemId: string, status: string) => Promise<void>) | null = null;

  // Quota management callbacks
  public onSwitchAccountRequest: ((target: string, replyTopicId: number) => Promise<void>) | null = null;
  public onQuotaStatusRequest: ((replyTopicId: number) => Promise<void>) | null = null;
  public onLoginRequest: ((email: string | null, replyTopicId: number) => Promise<void>) | null = null;
  public onClassifySessionDeath: ((sessionName: string) => Promise<{ cause: string; detail: string } | null>) | null = null;
  /** LLM-powered stall triage — called instead of generic stall alert when set */
  public onStallDetected: ((topicId: number, sessionName: string, messageText: string, injectedAt: number) => Promise<{ resolved: boolean }>) | null = null;
  /** Get triage status for a topic — returns null if no active triage, or status summary */
  public onGetTriageStatus: ((topicId: number) => { active: boolean; classification?: string; checkCount: number; lastCheck?: string } | null) | null = null;

  // Unknown user handling callbacks (Multi-User Setup Wizard Phase 4.5)
  // Returns the registration policy and optional contact hint for the gated message
  public onGetRegistrationPolicy: (() => { policy: string; contactHint?: string; agentName?: string }) | null = null;
  // Called when an admin-only join request is created (notify admin via lifeline/admin topic)
  public onNotifyAdminJoinRequest: ((request: { name: string; username?: string; telegramUserId: number }) => Promise<void>) | null = null;
  // Called to validate an invite code for invite-only policy
  public onValidateInviteCode: ((code: string, telegramUserId: number) => Promise<{ valid: boolean; error?: string }>) | null = null;
  // Called to start mini-onboarding for open policy
  public onStartMiniOnboarding: ((telegramUserId: number, firstName: string, username?: string) => Promise<void>) | null = null;

  // Rate limiting for unknown user responses (prevent spam)
  private unknownUserRateLimit: Map<number, number> = new Map(); // telegramUserId -> last response timestamp
  private static readonly UNKNOWN_USER_COOLDOWN_MS = 60_000; // 1 minute between responses to same unknown user

  // Notification batching
  private batcher: NotificationBatcher | null = null;

  // Intelligence provider — gates fallback stall/promise alerts behind LLM confirmation.
  // Without this, fallback alerts fire purely from timers when StallTriageNurse is unavailable.
  public intelligence: IntelligenceProvider | null = null;

  // Flush notifications callback — fires when user sends /flush
  public onFlushNotifications: ((replyTopicId: number) => Promise<void>) | null = null;

  // Prompt Gate — relay prompts to Telegram and handle responses
  private callbackRegistry: CallbackRegistry;
  private pendingPromptReply = new Map<number, PendingPromptReply>(); // topicId → pending
  private promptGateDisclosureSent = new Set<number>(); // topicIds that have seen the disclosure

  /** Callback to inject a response into a tmux session. Wired by server.ts. */
  public onPromptResponse: ((sessionName: string, key: string) => boolean) | null = null;
  /** Callback to inject text input into a tmux session. Wired by server.ts. */
  public onPromptTextResponse: ((sessionName: string, text: string) => boolean) | null = null;
  /** Callback when relay lease should extend idle timeout for a session */
  public onRelayLeaseStart: ((sessionName: string) => void) | null = null;
  /** Callback when relay lease is released (response received or timeout) */
  public onRelayLeaseEnd: ((sessionName: string) => void) | null = null;

  // Shared infrastructure modules (Phase 1 extraction)
  private sharedLogger: MessageLogger | null = null;
  private sharedRegistry: SessionChannelRegistry | null = null;
  private sharedStallDetector: StallDetector | null = null;
  private sharedCommandRouter: CommandRouter | null = null;
  private sharedAuthGate: AuthGate | null = null;
  private eventBus: MessagingEventBus | null = null;

  /** Get the event bus for external subscribers (Phase 1e). Returns null if flag is off. */
  getEventBus(): MessagingEventBus | null {
    return this.eventBus;
  }

  constructor(config: TelegramConfig, stateDir: string) {
    if (config.chatId && !/^-?\d+$/.test(String(config.chatId))) {
      throw new Error(
        `Invalid Telegram chatId "${config.chatId}". Chat IDs must be numeric (e.g., -1001234567890). ` +
        `Update messaging.config.chatId in your instar.config.json with a valid numeric ID.`,
      );
    }
    this.config = config;
    this.stateDir = stateDir;
    this.registryPath = path.join(stateDir, 'topic-session-registry.json');
    this.messageLogPath = path.join(stateDir, 'telegram-messages.jsonl');
    this.offsetPath = path.join(stateDir, 'telegram-poll-offset.json');
    this.attentionFilePath = path.join(stateDir, 'state', 'attention-items.json');
    this.loadRegistry();
    this.loadOffset();
    this.loadAttentionItems();

    // Initialize Prompt Gate callback registry
    const relayTimeoutMs = (config.promptGate?.relayTimeoutSeconds ?? 300) * 1000;
    this.callbackRegistry = new CallbackRegistry({
      maxEntries: 500,
      maxAgeMs: relayTimeoutMs,
      pruneIntervalMs: 60_000,
    });
    this.callbackRegistry.start();

    // Initialize shared modules when feature flags are enabled
    if (SHARED_INFRA_FLAGS.useSharedMessageLogger) {
      this.sharedLogger = new MessageLogger({ logPath: this.messageLogPath });
    }
    if (SHARED_INFRA_FLAGS.useSharedStallDetector) {
      this.sharedStallDetector = new StallDetector({
        stallTimeoutMinutes: config.stallTimeoutMinutes,
        promiseTimeoutMinutes: config.promiseTimeoutMinutes,
      });
    }
    if (SHARED_INFRA_FLAGS.useSharedCommandRouter) {
      this.sharedCommandRouter = new CommandRouter('telegram');
      this.registerSharedCommands();
    }
    if (SHARED_INFRA_FLAGS.useSharedAuthGate) {
      this.sharedAuthGate = new AuthGate({
        authorizedUsers: (config.authorizedUserIds ?? []).map(id => id.toString()),
      });
    }
    if (SHARED_INFRA_FLAGS.useEventEmitterPattern) {
      this.eventBus = new MessagingEventBus('telegram');
    }
  }

  /**
   * Register all Telegram commands with the shared CommandRouter (Phase 1a).
   * Each command delegates back to the existing handler logic.
   */
  private registerSharedCommands(): void {
    if (!this.sharedCommandRouter) return;

    // Attention topic interceptor
    this.sharedCommandRouter.addInterceptor(async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      if (this.isAttentionTopic(topicId)) {
        return this.handleAttentionCommand(topicId, ctx.rawText);
      }
      return false;
    });

    this.sharedCommandRouter.register('flush', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      if (this.batcher && this.batcher.isEnabled()) {
        const flushed = await this.batcher.flushAll();
        if (flushed > 0) {
          await this.sendToTopic(topicId, `Flushed ${flushed} batched notification${flushed === 1 ? '' : 's'}.`).catch(() => {});
        } else {
          await this.sendToTopic(topicId, 'No batched notifications to flush.').catch(() => {});
        }
      } else if (this.onFlushNotifications) {
        this.onFlushNotifications(topicId).catch(err => {
          console.error('[telegram] Flush notifications failed:', err);
          this.sendToTopic(topicId, 'Failed to flush notifications.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Notification batching is not enabled.').catch(() => {});
      }
      return true;
    }, { description: 'Flush batched notifications' });

    this.sharedCommandRouter.register('sessions', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      const filterUnclaimed = ctx.args.includes('unclaimed');
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
    }, { description: 'List sessions', platforms: ['telegram'] });

    this.sharedCommandRouter.register(['claim', 'link'], async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      const sessionName = ctx.args;
      if (!sessionName) {
        await this.sendToTopic(topicId, `Please include a session name — e.g. /${ctx.command} my-session`).catch(() => {});
        return true;
      }
      const existingSession = this.getSessionForTopic(topicId);
      if (existingSession) {
        await this.sendToTopic(topicId, `This topic is already linked to "${existingSession}". Use /unlink first.`).catch(() => {});
        return true;
      }
      this.registerTopicSession(topicId, sessionName);
      const verb = ctx.command === 'claim' ? 'Claimed' : 'Linked';
      await this.sendToTopic(topicId, `${verb} session "${sessionName}" ${ctx.command === 'claim' ? 'into' : 'to'} this topic.`).catch(() => {});
      return true;
    }, { description: 'Link a session to this topic', platforms: ['telegram'] });

    this.sharedCommandRouter.register('unlink', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      const sessionName = this.getSessionForTopic(topicId);
      if (!sessionName) {
        await this.sendToTopic(topicId, 'No session linked to this topic.').catch(() => {});
        return true;
      }
      this.unregisterTopic(topicId);
      await this.sendToTopic(topicId, `Unlinked session "${sessionName}" from this topic.`).catch(() => {});
      return true;
    }, { description: 'Unlink session from topic', platforms: ['telegram'] });

    this.sharedCommandRouter.register('interrupt', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
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
        this.clearStallForTopic(topicId);
        if (success) {
          await this.sendToTopic(topicId, `Nudged "${sessionName}" \u2014 it should resume shortly.`).catch(() => {});
        } else {
          await this.sendToTopic(topicId, `Failed to interrupt "${sessionName}" \u2014 session may not exist.`).catch(() => {});
        }
      } catch (err) {
        console.error(`[telegram] Interrupt failed:`, err);
        await this.sendToTopic(topicId, 'Couldn\'t interrupt the session. It may have already ended.').catch(() => {});
      }
      return true;
    }, { description: 'Send Escape to unstick a stalled session' });

    this.sharedCommandRouter.register('restart', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      const sessionName = this.getSessionForTopic(topicId);
      if (!sessionName) {
        await this.sendToTopic(topicId, 'No session linked to this topic.').catch(() => {});
        return true;
      }
      if (!this.onRestartSession) {
        await this.sendToTopic(topicId, 'Restart not available (no handler registered).').catch(() => {});
        return true;
      }
      this.clearStallForTopic(topicId);
      await this.sendToTopic(topicId, `Restarting "${sessionName}"...`).catch(() => {});
      try {
        await this.onRestartSession(sessionName, topicId);
        await this.sendToTopic(topicId, 'Session restarted.').catch(() => {});
      } catch (err) {
        console.error(`[telegram] Restart failed:`, err);
        await this.sendToTopic(topicId, 'Restart didn\'t work. The session may need to be recreated — try sending a new message.').catch(() => {});
      }
      return true;
    }, { description: 'Kill and respawn session' });

    this.sharedCommandRouter.register('status', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      const s = this.getStatus();
      const lines = [
        `Telegram adapter: ${s.started ? '\u2705 running' : '\u274c stopped'}`,
        `Uptime: ${s.uptime ? Math.round(s.uptime / 60000) + 'm' : 'n/a'}`,
        `Topic mappings: ${s.topicMappings}`,
        `Pending stall alerts: ${s.pendingStalls}`,
      ];
      await this.sendToTopic(topicId, lines.join('\n')).catch(() => {});
      return true;
    }, { description: 'Show adapter status' });

    this.sharedCommandRouter.register(['switch-account', 'sa'], async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      if (!ctx.args) return false;
      if (this.onSwitchAccountRequest) {
        this.onSwitchAccountRequest(ctx.args, topicId).catch(err => {
          console.error('[telegram] Switch account failed:', err);
          this.sendToTopic(topicId, 'Account switch didn\'t work. Try again or use /quota to check status.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Account switching not available.').catch(() => {});
      }
      return true;
    }, { description: 'Switch active Claude account' });

    this.sharedCommandRouter.register(['quota', 'q'], async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      if (this.onQuotaStatusRequest) {
        this.onQuotaStatusRequest(topicId).catch(err => {
          console.error('[telegram] Quota status failed:', err);
          this.sendToTopic(topicId, 'Couldn\'t check quota right now. Try again in a moment.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Quota status not available.').catch(() => {});
      }
      return true;
    }, { description: 'Show multi-account quota summary' });

    this.sharedCommandRouter.register('login', async (ctx) => {
      const topicId = parseInt(ctx.channelId, 10);
      const email = ctx.args || null;
      if (this.onLoginRequest) {
        this.onLoginRequest(email, topicId).catch(err => {
          console.error('[telegram] Login flow failed:', err);
          this.sendToTopic(topicId, 'Login didn\'t complete. Try again, or the auth service may be temporarily unavailable.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Login not available.').catch(() => {});
      }
      return true;
    }, { description: 'Seamless OAuth login from Telegram' });
  }

  async start(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.startedAt = new Date();
    this.consecutivePollErrors = 0;

    // Ensure Lifeline topic exists (auto-recreate if deleted)
    await this.ensureLifelineTopic();

    console.log(`[telegram] Starting long-polling...`);
    this.poll();

    // Resolve any topic names still using the fallback "topic-NNNN" pattern
    this.resolveUnknownTopicNames().catch(err => {
      console.warn(`[telegram] Topic name resolution failed: ${err}`);
    });

    // Start notification batcher if configured
    if (this.batcher) {
      this.batcher.start();
      console.log('[telegram] Notification batcher started');
    }

    // Start stall detection if configured
    if (this.sharedStallDetector) {
      // Phase 1c: Wire shared stall detector callbacks and start
      this.sharedStallDetector.setIsSessionAlive(this.onIsSessionAlive ? (name) => this.onIsSessionAlive!(name) : null);
      this.sharedStallDetector.setIsSessionActive(this.onIsSessionActive ? (name) => this.onIsSessionActive!(name) : null);
      this.sharedStallDetector.setOnStall(async (event, alive) => {
        await this.handleSharedStallEvent(event, alive);
      });
      this.sharedStallDetector.start();
    } else {
      const stallMinutes = this.config.stallTimeoutMinutes ?? 5;
      if (stallMinutes > 0) {
        this.stallCheckInterval = setInterval(() => this.checkForStalls(), 30_000);
      }
    }
  }

  async stop(): Promise<void> {
    this.polling = false;
    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = null;
    }
    if (this.sharedStallDetector) {
      this.sharedStallDetector.stop();
    }
    if (this.stallCheckInterval) {
      clearInterval(this.stallCheckInterval);
      this.stallCheckInterval = null;
    }
    // Flush and stop the batcher on shutdown
    if (this.batcher) {
      try {
        await this.batcher.flushAll();
      } catch (err) {
        console.error('[telegram] Failed to flush batcher on stop:', err);
      }
      this.batcher.stop();
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
   * Log an inbound user message that arrived via an external path (e.g. Lifeline
   * forwarding through /internal/telegram-forward). This ensures the message
   * appears in both JSONL and TopicMemory even when the normal polling handler
   * didn't receive it.
   */
  logInboundMessage(entry: {
    messageId: number;
    topicId: number;
    text: string;
    timestamp: string;
    senderName?: string;
    senderUsername?: string;
    telegramUserId?: number;
  }): void {
    this.appendToLog({
      messageId: entry.messageId,
      topicId: entry.topicId,
      text: entry.text,
      fromUser: true,
      timestamp: entry.timestamp,
      sessionName: this.topicToSession.get(entry.topicId) ?? null,
      senderName: entry.senderName,
      senderUsername: entry.senderUsername,
      telegramUserId: entry.telegramUserId,
    });
  }

  /**
   * Send a message to a specific forum topic.
   * Returns the Telegram message ID for delivery confirmation.
   */
  async sendToTopic(topicId: number, text: string, options?: { silent?: boolean; skipStallClear?: boolean }): Promise<SendResult> {
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      text,
    };
    if (!isGeneralTopic(topicId)) {
      params.message_thread_id = topicId;
    }
    if (options?.silent) {
      params.disable_notification = true;
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
    // Skip for proxy messages — PresenceProxy messages should NOT reset stall timers
    if (!options?.skipStallClear) {
      this.clearStallForTopic(topicId);
    }

    // Promise tracking — detect agent "working on it" messages that need follow-through
    const sessionName = this.topicToSession.get(topicId);
    if (sessionName) {
      // Phase 1c: Delegate to shared StallDetector when flag is enabled
      if (this.sharedStallDetector) {
        this.sharedStallDetector.trackOutboundMessage(topicId.toString(), sessionName, text);
      } else {
        if (this.isPromiseMessage(text)) {
          this.pendingPromises.set(topicId, {
            topicId,
            sessionName,
            promiseText: text.slice(0, 100),
            promisedAt: Date.now(),
            alerted: false,
          });
        } else if (this.pendingPromises.has(topicId) && this.isFollowThroughMessage(text)) {
          this.pendingPromises.delete(topicId);
        }
      }
    }

    return { messageId: result.message_id, topicId };
  }

  /**
   * Send a notification through the batcher, falling back to direct send.
   * Use this for internal system notifications that should be batched.
   */
  async notifyTopic(topicId: number, text: string, tier: NotificationTier, category: string): Promise<void> {
    if (this.batcher && this.batcher.isEnabled()) {
      await this.batcher.enqueue({
        tier,
        category,
        message: text,
        timestamp: new Date(),
        topicId,
      });
    } else {
      // No batcher or disabled — send directly
      await this.sendToTopic(topicId, text);
    }
  }

  /**
   * Configure the notification batcher. Call before start() to enable batching.
   * The batcher's send function is wired to sendToTopic automatically.
   */
  configureBatcher(config?: { summaryIntervalMinutes?: number; digestIntervalMinutes?: number; quietHours?: { enabled: boolean; start: string; end: string } }): NotificationBatcher {
    this.batcher = new NotificationBatcher({
      enabled: true,
      ...config,
    });
    this.batcher.setSendFunction((topicId, text) => this.sendToTopic(topicId, text));
    return this.batcher;
  }

  /**
   * Get the notification batcher (if configured).
   */
  getBatcher(): NotificationBatcher | null {
    return this.batcher;
  }

  /**
   * Create a forum topic in the supergroup.
   */
  async createForumTopic(name: string, iconColor?: number): Promise<{ topicId: number; name: string }> {
    if (this.notAForum) {
      throw new Error('Chat is not a forum — topic creation skipped');
    }

    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      name,
    };
    if (iconColor !== undefined) {
      params.icon_color = iconColor;
    }

    try {
      const result = await this.apiCall('createForumTopic', params) as {
        message_thread_id: number;
        name: string;
      };

      this.topicToName.set(result.message_thread_id, name);
      this.saveRegistry();

      console.log(`[telegram] Created forum topic: "${name}" (ID: ${result.message_thread_id})`);
      return { topicId: result.message_thread_id, name: result.name };
    } catch (err) {
      const errStr = String(err);
      if (errStr.includes('not a forum') || errStr.includes('FORUM_REQUIRED')) {
        this.notAForum = true;
        if (!this.notAForumWarned) {
          this.notAForumWarned = true;
          console.warn('[telegram] ⚠️ Chat is not a forum-enabled supergroup. Forum topics (Lifeline, Dashboard, per-session) will not be created. Messaging will use the General Topic. To enable topics, convert your Telegram group to a supergroup with Topics enabled in group settings.');
        }
      }
      throw err;
    }
  }

  /**
   * Edit a forum topic's name and/or icon color.
   * Best-effort — silently ignores failures (topic may not exist).
   */
  async editForumTopic(topicId: number, name?: string, iconColor?: number): Promise<boolean> {
    const params: Record<string, unknown> = {
      chat_id: this.config.chatId,
      message_thread_id: topicId,
    };
    if (name !== undefined) params.name = name;
    if (iconColor !== undefined) params.icon_color = iconColor;

    try {
      await this.apiCall('editForumTopic', params);
      if (name) {
        this.topicToName.set(topicId, name);
        this.saveRegistry();
      }
      console.log(`[telegram] Renamed topic ${topicId} → "${name}"`);
      return true;
    } catch {
      // @silent-fallback-ok — best-effort rename
      return false;
    }
  }

  /**
   * Find an existing topic by name, or create a new one if none exists.
   * Prevents duplicate topics when sessions respawn or the server restarts.
   */
  async findOrCreateForumTopic(name: string, iconColor?: number): Promise<{ topicId: number; name: string; reused: boolean }> {
    const normalizedName = name.toLowerCase().trim();
    for (const [topicId, existingName] of this.topicToName) {
      if (existingName.toLowerCase().trim() === normalizedName) {
        console.log(`[telegram] Reusing existing topic ${topicId} for "${name}"`);
        return { topicId, name: existingName, reused: true };
      }
    }
    const result = await this.createForumTopic(name, iconColor);
    return { ...result, reused: false };
  }

  /**
   * Get the Lifeline topic ID (if configured).
   */
  getLifelineTopicId(): number | undefined {
    return this.config.lifelineTopicId;
  }

  /**
   * Ensure the Lifeline topic exists. If it was deleted, recreate it.
   * Called on startup and can be called periodically.
   */
  async ensureLifelineTopic(): Promise<number | null> {
    if (this.notAForum) return null;
    const styledName = `${TOPIC_STYLE.SYSTEM.emoji} Lifeline`;
    if (!this.config.lifelineTopicId) {
      // No lifeline topic configured — create one
      try {
        const topic = await this.createForumTopic(styledName, TOPIC_STYLE.SYSTEM.color);
        this.config.lifelineTopicId = topic.topicId;
        this.persistLifelineTopicId(topic.topicId);
        console.log(`[telegram] Created Lifeline topic: ${topic.topicId}`);
        return topic.topicId;
      } catch (err) {
        // @silent-fallback-ok — lifeline topic creation, logged
        console.error(`[telegram] Failed to create Lifeline topic: ${err}`);
        return null;
      }
    }

    // Lifeline topic ID exists — verify it's still valid silently.
    // Don't send a visible message — it spams the user on every server restart.
    try {
      await this.apiCall('sendChatAction', {
        chat_id: this.config.chatId,
        message_thread_id: this.config.lifelineTopicId,
        action: 'typing',
      });
      // Best-effort rename to styled name if it doesn't match
      const currentName = this.topicToName.get(this.config.lifelineTopicId);
      if (currentName && !currentName.includes(TOPIC_STYLE.SYSTEM.emoji)) {
        await this.editForumTopic(this.config.lifelineTopicId, styledName, TOPIC_STYLE.SYSTEM.color);
      }
      console.log(`[telegram] Lifeline topic verified: ${this.config.lifelineTopicId}`);
      return this.config.lifelineTopicId;
    } catch (err) {
      const errStr = String(err);
      // Topic was deleted — "message thread not found" or "TOPIC_CLOSED" or similar
      if (errStr.includes('thread not found') || errStr.includes('TOPIC_DELETED') ||
          errStr.includes('TOPIC_CLOSED') || errStr.includes('not found')) {
        console.log(`[telegram] Lifeline topic ${this.config.lifelineTopicId} was deleted — recreating`);
        try {
          const topic = await this.createForumTopic(styledName, TOPIC_STYLE.SYSTEM.color);
          this.config.lifelineTopicId = topic.topicId;
          this.persistLifelineTopicId(topic.topicId);
          console.log(`[telegram] Recreated Lifeline topic: ${topic.topicId}`);
          return topic.topicId;
        } catch (recreateErr) {
          DegradationReporter.getInstance().report({
            feature: 'Telegram.Lifeline',
            primary: 'Verified lifeline topic for emergency agent communication',
            fallback: 'No lifeline topic — agent unreachable in emergencies',
            reason: `Lifeline topic deleted and recreation failed: ${recreateErr instanceof Error ? recreateErr.message : String(recreateErr)}`,
            impact: 'Agent cannot receive emergency commands or stall recovery signals.',
          });
          return null;
        }
      }
      // Some other error (network, etc.) — retry once before reporting degradation.
      // Transient errors like "This operation was aborted" (15s fetch timeout) should
      // not trigger degradation on the first attempt — a brief retry on startup resolves them.
      let retryErr: unknown = err;
      try {
        await new Promise<void>(resolve => setTimeout(resolve, 3000));
        await this.apiCall('sendChatAction', {
          chat_id: this.config.chatId,
          message_thread_id: this.config.lifelineTopicId,
          action: 'typing',
        });
        console.log(`[telegram] Lifeline topic verified (retry succeeded): ${this.config.lifelineTopicId}`);
        return this.config.lifelineTopicId;
      } catch (e) {
        // @silent-fallback-ok — error assigned to retryErr, reported to DegradationReporter below
        retryErr = e;
      }
      DegradationReporter.getInstance().report({
        feature: 'Telegram.Lifeline',
        primary: 'Verified lifeline topic for emergency agent communication',
        fallback: 'Using unverified (possibly stale) lifeline topic ID',
        reason: `Lifeline topic check failed after retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
        impact: 'Lifeline may be unreachable — messages to agent could fail silently.',
      });
      return this.config.lifelineTopicId;
    }
  }

  /**
   * Persist the Lifeline topic ID back to config.json so it survives restarts.
   */
  private persistLifelineTopicId(topicId: number): void {
    try {
      // Find config.json in state dir's parent (stateDir is .instar/state or .instar)
      const candidates = [
        path.join(this.stateDir, '..', 'config.json'),
        path.join(this.stateDir, 'config.json'),
      ];
      for (const configPath of candidates) {
        if (fs.existsSync(configPath)) {
          const raw = fs.readFileSync(configPath, 'utf-8');
          const config = JSON.parse(raw);
          // Find the telegram messaging config and update it
          if (Array.isArray(config.messaging)) {
            const telegramEntry = config.messaging.find(
              (m: { type: string }) => m.type === 'telegram'
            );
            if (telegramEntry?.config) {
              telegramEntry.config.lifelineTopicId = topicId;
              const tmpPath = `${configPath}.${process.pid}.tmp`;
              fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
              fs.renameSync(tmpPath, configPath);
              console.log(`[telegram] Saved lifelineTopicId=${topicId} to config`);
              return;
            }
          }
        }
      }
    } catch (err) {
      // @silent-fallback-ok — config persistence, in-memory ok
      console.warn(`[telegram] Failed to persist lifelineTopicId: ${err}`);
    }
  }

  // ── Dashboard Topic ──────────────────────────────────────────────────

  /**
   * Get the Dashboard topic ID (if configured).
   */
  getDashboardTopicId(): number | undefined {
    return this.config.dashboardTopicId;
  }

  /**
   * Whether the chat supports forum topics. False if we detected
   * "the chat is not a forum" from the Telegram API.
   */
  get isForumChat(): boolean {
    return !this.notAForum;
  }

  /**
   * Ensure the Dashboard topic exists. Creates it on first run, verifies on restart.
   * Same resilience pattern as the lifeline topic.
   */
  async ensureDashboardTopic(): Promise<number | null> {
    if (this.notAForum) return null;
    const styledName = `${TOPIC_STYLE.INFO.emoji} Dashboard`;
    if (!this.config.dashboardTopicId) {
      try {
        const topic = await this.createForumTopic(styledName, TOPIC_STYLE.INFO.color);
        this.config.dashboardTopicId = topic.topicId;
        this.persistDashboardTopicId(topic.topicId);
        console.log(`[telegram] Created Dashboard topic: ${topic.topicId}`);

        // Send a one-time setup hint: mute this topic to avoid unread badges.
        // The bot can't mute topics for users (client-side setting), so we guide them.
        try {
          await this.sendToTopic(topic.topicId, [
            '💡 *Tip*: Mute this topic to avoid notification badges.',
            '',
            'Long-press this topic → Mute → Forever.',
            '',
            '_The latest dashboard link will always be pinned here._',
          ].join('\n'), { silent: true });
        } catch {
          // @silent-fallback-ok — guidance message is nice-to-have
        }

        return topic.topicId;
      } catch (err) {
        DegradationReporter.getInstance().report({
          feature: 'TelegramAdapter.ensureDashboardTopic',
          primary: 'Create Dashboard forum topic for status messages',
          fallback: 'Dashboard topic unavailable, status messages have no destination',
          reason: `Failed to create Dashboard topic: ${err instanceof Error ? err.message : String(err)}`,
          impact: 'Dashboard status messages and pinned URLs will not be delivered',
        });
        return null;
      }
    }

    // Dashboard topic ID exists — verify it's still valid
    try {
      await this.apiCall('sendChatAction', {
        chat_id: this.config.chatId,
        message_thread_id: this.config.dashboardTopicId,
        action: 'typing',
      });
      // Best-effort rename to styled name
      const currentName = this.topicToName.get(this.config.dashboardTopicId);
      if (currentName && !currentName.includes(TOPIC_STYLE.INFO.emoji)) {
        await this.editForumTopic(this.config.dashboardTopicId, styledName, TOPIC_STYLE.INFO.color);
      }
      return this.config.dashboardTopicId;
    } catch (err) {
      // @silent-fallback-ok — self-healing: attempts topic recreation on deletion, returns existing ID for transient errors
      const errStr = String(err);
      if (errStr.includes('thread not found') || errStr.includes('TOPIC_DELETED') ||
          errStr.includes('TOPIC_CLOSED') || errStr.includes('not found')) {
        console.log(`[telegram] Dashboard topic ${this.config.dashboardTopicId} was deleted — recreating`);
        try {
          const topic = await this.createForumTopic(styledName, TOPIC_STYLE.INFO.color);
          this.config.dashboardTopicId = topic.topicId;
          this.persistDashboardTopicId(topic.topicId);
          return topic.topicId;
        } catch (recreateErr) {
          DegradationReporter.getInstance().report({
            feature: 'TelegramAdapter.ensureDashboardTopic',
            primary: 'Recreate deleted Dashboard forum topic',
            fallback: 'No dashboard topic available, returning null',
            reason: `Recreation failed: ${recreateErr instanceof Error ? recreateErr.message : String(recreateErr)}`,
            impact: 'Dashboard status messages and pinned URLs will not be delivered until next restart',
          });
          return null;
        }
      }
      return this.config.dashboardTopicId;
    }
  }

  /**
   * Broadcast the dashboard URL to the Dashboard topic.
   *
   * Edit-in-place pattern: instead of posting a new message each restart (which
   * creates unread badges), we edit the existing pinned message. This means the
   * Dashboard topic never shows as "unread" — it's a quiet reference the user
   * checks when they need the link.
   *
   * Fallback: if the pinned message was deleted or doesn't exist yet, we send
   * a new one, pin it, and save its ID for future edits.
   */
  async broadcastDashboardUrl(url: string, tunnelType: 'quick' | 'named'): Promise<void> {
    const topicId = this.config.dashboardTopicId;
    if (!topicId) return;

    const pin = this.config.dashboardPin || '(check your config)';
    const isNamed = tunnelType === 'named';

    const message = this.formatDashboardMessage(url, pin, isNamed);

    // Try to edit the existing pinned message (no new message = no unread badge)
    const existingMessageId = this.loadDashboardMessageId();
    if (existingMessageId) {
      try {
        await this.apiCall('editMessageText', {
          chat_id: this.config.chatId,
          message_id: existingMessageId,
          text: message,
          parse_mode: 'Markdown',
        });
        console.log(`[telegram] Edited dashboard message ${existingMessageId} in-place`);
        return; // Success — no new message, no unread badge
      } catch (err) {
        // Edit failed — message was deleted, or content unchanged. Fall through to send new.
        const errStr = String(err);
        if (errStr.includes('message is not modified')) {
          console.log(`[telegram] Dashboard message unchanged — skipping`);
          return;
        }
        console.log(`[telegram] Dashboard message ${existingMessageId} edit failed, sending new: ${errStr}`);
      }
    }

    // Fallback: send a new message, pin it, and save for future edits
    try {
      const result = await this.sendToTopic(topicId, message, { silent: true });

      if (result.messageId) {
        // Unpin old pins, then pin the new message
        try {
          await this.apiCall('unpinAllForumTopicMessages', {
            chat_id: this.config.chatId,
            message_thread_id: topicId,
          });
        } catch {
          // @silent-fallback-ok — unpinning old messages is best-effort
        }

        try {
          await this.apiCall('pinChatMessage', {
            chat_id: this.config.chatId,
            message_id: result.messageId,
            disable_notification: true,
          });
        } catch {
          // @silent-fallback-ok — pinning is nice-to-have, send succeeded
        }

        // Save message ID for future edit-in-place
        this.saveDashboardMessageId(result.messageId);
      }
    } catch (err) {
      console.error(`[telegram] Failed to broadcast dashboard URL: ${err}`);
    }
  }

  private formatDashboardMessage(url: string, pin: string, isNamed: boolean): string {
    const dashboardUrl = url + '/dashboard';
    const quickLinks = [
      `Sessions: ${dashboardUrl}?tab=sessions`,
      `Files: ${dashboardUrl}?tab=files`,
    ];

    if (isNamed) {
      return [
        '*Dashboard*',
        '',
        `Your permanent dashboard link:`,
        dashboardUrl,
        '',
        `PIN: \`${pin}\``,
        '',
        `Quick links:`,
        ...quickLinks.map(l => `  ${l}`),
        '',
        `_This link is permanent — it won't change on restart._`,
      ].join('\n');
    }
    return [
      '*Dashboard*',
      '',
      `Your dashboard is live:`,
      dashboardUrl,
      '',
      `PIN: \`${pin}\``,
      '',
      `Quick links:`,
      ...quickLinks.map(l => `  ${l}`),
      '',
      `_This link changes when the server restarts._`,
      `_For a permanent link, ask me to set up a named tunnel._`,
    ].join('\n');
  }

  private loadDashboardMessageId(): number | null {
    try {
      const statePath = path.join(this.stateDir, 'state', 'dashboard-message.json');
      if (fs.existsSync(statePath)) {
        const data = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        return data.messageId ?? null;
      }
    } catch {
      // @silent-fallback-ok — missing state file means first run
    }
    return null;
  }

  private saveDashboardMessageId(messageId: number): void {
    try {
      const stateSubdir = path.join(this.stateDir, 'state');
      fs.mkdirSync(stateSubdir, { recursive: true });
      const statePath = path.join(stateSubdir, 'dashboard-message.json');
      const tmpPath = `${statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({ messageId, savedAt: new Date().toISOString() }));
      fs.renameSync(tmpPath, statePath);
    } catch (err) {
      console.warn(`[telegram] Failed to save dashboard message ID: ${err}`);
    }
  }

  /**
   * Persist the Dashboard topic ID back to config.json.
   */
  private persistDashboardTopicId(topicId: number): void {
    try {
      const candidates = [
        path.join(this.stateDir, '..', 'config.json'),
        path.join(this.stateDir, 'config.json'),
      ];
      for (const configPath of candidates) {
        if (fs.existsSync(configPath)) {
          const raw = fs.readFileSync(configPath, 'utf-8');
          const config = JSON.parse(raw);
          if (Array.isArray(config.messaging)) {
            const telegramEntry = config.messaging.find(
              (m: { type: string }) => m.type === 'telegram'
            );
            if (telegramEntry?.config) {
              telegramEntry.config.dashboardTopicId = topicId;
              const tmpPath = `${configPath}.${process.pid}.tmp`;
              fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
              fs.renameSync(tmpPath, configPath);
              console.log(`[telegram] Saved dashboardTopicId=${topicId} to config`);
              return;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[telegram] Failed to persist dashboardTopicId: ${err}`);
    }
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
      // @silent-fallback-ok — forum close boolean return
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
    // Phase 1d: Delegate to shared AuthGate when flag is enabled
    if (this.sharedAuthGate) {
      return this.sharedAuthGate.isAuthorized(userId.toString());
    }

    const authorized = this.config.authorizedUserIds;
    if (!authorized || authorized.length === 0) return true;
    return authorized.includes(userId);
  }

  /**
   * Handle a message from an unknown/unauthorized Telegram user.
   * Checks the registration policy and responds appropriately:
   * - admin-only: Gated message + notify admin
   * - invite-only: Ask for invite code
   * - open: Start mini-onboarding (rate limited)
   *
   * Rate-limited to prevent spam from the same unknown user.
   */
  private async handleUnknownUser(
    telegramUserId: number,
    firstName: string,
    username: string | undefined,
    messageText: string | undefined,
  ): Promise<void> {
    // Rate limit: don't spam responses to the same unknown user
    const lastResponse = this.unknownUserRateLimit.get(telegramUserId);
    if (lastResponse && (Date.now() - lastResponse) < TelegramAdapter.UNKNOWN_USER_COOLDOWN_MS) {
      console.log(`[telegram] Rate-limited response to unknown user ${telegramUserId} (${username ?? firstName})`);
      return;
    }

    // Get registration policy from callback
    const policyInfo = this.onGetRegistrationPolicy?.();
    if (!policyInfo) {
      // No policy callback wired — fall back to silent ignore (legacy behavior)
      console.log(`[telegram] Ignoring message from unauthorized user ${telegramUserId} (${username ?? firstName}) — no registration policy configured`);
      return;
    }

    const { policy, contactHint, agentName } = policyInfo;
    const displayName = agentName || 'This agent';

    // Mark that we responded to this user
    this.unknownUserRateLimit.set(telegramUserId, Date.now());

    // Clean up old rate limit entries periodically (keep map from growing unbounded)
    if (this.unknownUserRateLimit.size > 100) {
      const cutoff = Date.now() - TelegramAdapter.UNKNOWN_USER_COOLDOWN_MS * 10;
      for (const [uid, ts] of this.unknownUserRateLimit) {
        if (ts < cutoff) this.unknownUserRateLimit.delete(uid);
      }
    }

    console.log(`[telegram] Unknown user ${telegramUserId} (${username ?? firstName}) — policy: ${policy}`);

    try {
      switch (policy) {
        case 'admin-only': {
          // Send gated message to the user
          let gatedMessage = `Hi ${firstName}! ${displayName} is not open for public registration. Access is managed by an administrator.`;
          if (contactHint) {
            gatedMessage += `\n\n${contactHint}`;
          }
          gatedMessage += `\n\nYour request has been noted and forwarded to the admin.`;

          // Reply in the group's General topic (since unknown users don't have their own topic)
          await this.sendToTopic(GENERAL_TOPIC_ID, gatedMessage).catch(() => {});

          // Notify admin via callback
          if (this.onNotifyAdminJoinRequest) {
            await this.onNotifyAdminJoinRequest({
              name: firstName,
              username,
              telegramUserId,
            }).catch(err => {
              console.error(`[telegram] Failed to notify admin of join request: ${err}`);
            });
          }
          break;
        }

        case 'invite-only': {
          // Check if the message contains an invite code
          const trimmedText = messageText?.trim();
          if (trimmedText && this.onValidateInviteCode) {
            const result = await this.onValidateInviteCode(trimmedText, telegramUserId);
            if (result.valid) {
              await this.sendToTopic(GENERAL_TOPIC_ID,
                `Welcome, ${firstName}! Your invite code has been accepted. Setting up your account...`,
              ).catch(() => {});
              // Trigger mini-onboarding after successful invite validation
              if (this.onStartMiniOnboarding) {
                await this.onStartMiniOnboarding(telegramUserId, firstName, username).catch(err => {
                  console.error(`[telegram] Failed to start onboarding after invite: ${err}`);
                });
              }
              return;
            } else if (result.error) {
              await this.sendToTopic(GENERAL_TOPIC_ID, result.error).catch(() => {});
              return;
            }
          }

          // Default invite-only prompt
          let inviteMessage = `Hi ${firstName}! ${displayName} requires an invite code to join. Please reply with your invite code.`;
          if (contactHint) {
            inviteMessage += `\n\n${contactHint}`;
          }
          await this.sendToTopic(GENERAL_TOPIC_ID, inviteMessage).catch(() => {});
          break;
        }

        case 'open': {
          // Start mini-onboarding via callback
          if (this.onStartMiniOnboarding) {
            await this.sendToTopic(GENERAL_TOPIC_ID,
              `Hi ${firstName}! Welcome! Setting up your account...`,
            ).catch(() => { /* @silent-fallback-ok — supplementary notification */ });
            await this.onStartMiniOnboarding(telegramUserId, firstName, username).catch(err => {
              // @silent-fallback-ok — supplementary notification
              console.error(`[telegram] Failed to start mini-onboarding: ${err}`);
              this.sendToTopic(GENERAL_TOPIC_ID,
                `Sorry ${firstName}, there was an issue setting up your account. Please try again later.`,
              ).catch(() => { /* @silent-fallback-ok — error notification, primary logged */ });
            });
          } else {
            await this.sendToTopic(GENERAL_TOPIC_ID,
              `Hi ${firstName}! Registration is currently being set up. Please try again later.`,
            ).catch(() => { /* @silent-fallback-ok — unavailable notification */ });
          }
          break;
        }

        default: {
          // Unknown policy — fall back to gated message
          console.warn(`[telegram] Unknown registration policy: ${policy}`);
          await this.sendToTopic(GENERAL_TOPIC_ID,
            `Hi ${firstName}! ${displayName} is not currently accepting new users.`,
          ).catch(() => {});
        }
      }
    } catch (err) {
      console.error(`[telegram] Error handling unknown user ${telegramUserId}: ${err}`);
    }
  }

  // ── Topic-Session Registry ─────────────────────────────────

  registerTopicSession(topicId: number, sessionName: string, topicName?: string): void {
    this.topicToSession.set(topicId, sessionName);
    this.sessionToTopic.set(sessionName, topicId);
    if (topicName) {
      this.topicToName.set(topicId, topicName);
    }
    this.saveRegistry();
    console.log(`[telegram] Registered topic ${topicId} <-> session "${sessionName}"${topicName ? ` (name: "${topicName}")` : ''}`);
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

  /**
   * Get all active topic→session mappings.
   * Used by TopicResumeMap heartbeat to proactively persist UUIDs.
   */
  getAllTopicSessions(): Map<number, string> {
    return new Map(this.topicToSession);
  }

  getTopicForSession(sessionName: string): number | null {
    return this.sessionToTopic.get(sessionName) ?? null;
  }

  getTopicName(topicId: number): string | null {
    return this.topicToName.get(topicId) ?? null;
  }

  /**
   * Actively resolve a topic's name from Telegram by sending a temporary probe message
   * that replies to the topic's service message (whose message_id = topic_id).
   * The API response includes reply_to_message.forum_topic_created.name.
   * The probe message is deleted immediately after.
   */
  async resolveTopicName(topicId: number): Promise<string | null> {
    if (this.notAForum) return null;
    try {
      // Send a temp message replying to the topic creation service message
      const result = await this.apiCall('sendMessage', {
        chat_id: this.config.chatId,
        text: '.', // minimal probe message — deleted immediately after
        message_thread_id: topicId,
        reply_to_message_id: topicId,
      }) as { message_id: number; reply_to_message?: { forum_topic_created?: { name: string } } };

      // Extract topic name from the reply target
      const name = result.reply_to_message?.forum_topic_created?.name;

      // Delete the probe message immediately
      try {
        await this.apiCall('deleteMessage', {
          chat_id: this.config.chatId,
          message_id: result.message_id,
        });
      } catch {
        // @silent-fallback-ok — best-effort cleanup
      }

      if (name) {
        this.topicToName.set(topicId, name);
        this.saveRegistry();
        console.log(`[telegram] Resolved topic name: ${topicId} → "${name}"`);
        return name;
      }
    } catch (err) {
      const errStr = String(err);
      console.log(`[telegram] Could not resolve topic name for ${topicId}: ${err}`);
      // If the topic was deleted, mark it so we don't retry resolution on every startup
      if (errStr.includes('message thread not found') || errStr.includes('TOPIC_DELETED')) {
        this.topicToName.set(topicId, `[deleted] topic-${topicId}`);
        this.saveRegistry();
      }
    }
    return null;
  }

  /**
   * Resolve all topic names that are still using the fallback "topic-NNNN" pattern.
   * Called on startup to backfill names for topics created before name tracking.
   */
  async resolveUnknownTopicNames(): Promise<void> {
    const unknowns: number[] = [];
    for (const [topicId, name] of this.topicToName) {
      if (/^topic-\d+$/.test(name)) {
        unknowns.push(topicId);
      }
    }
    if (unknowns.length === 0) return;
    console.log(`[telegram] Resolving ${unknowns.length} unknown topic names...`);
    for (const topicId of unknowns) {
      await this.resolveTopicName(topicId);
      // Small delay to avoid hitting rate limits
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // ── Topic Purpose Management ─────────────────────────────────

  /**
   * Set the purpose for a topic (e.g., "billing", "technical").
   * Purpose is used for outbound content validation.
   */
  setTopicPurpose(topicId: number, purpose: string): void {
    this.topicToPurpose.set(topicId, purpose.toLowerCase());
    this.saveRegistry();
  }

  /**
   * Get the purpose for a topic. Checks runtime map first, then config.
   * Returns null if no purpose is set (permissive — all content allowed).
   */
  getTopicPurpose(topicId: number): string | null {
    // Runtime map takes precedence over config
    const runtimePurpose = this.topicToPurpose.get(topicId);
    if (runtimePurpose) return runtimePurpose;

    // Fall back to config
    const validationConfig = this.config.contentValidation;
    if (validationConfig) {
      return getTopicPurpose(topicId, validationConfig);
    }
    return null;
  }

  /**
   * Get all topic purposes (runtime + config merged).
   */
  getAllTopicPurposes(): Record<number, string> {
    const result: Record<number, string> = {};
    // Config purposes first
    const validationConfig = this.config.contentValidation;
    if (validationConfig) {
      for (const [id, purpose] of Object.entries(validationConfig.topicPurposes)) {
        result[Number(id)] = purpose.toLowerCase();
      }
    }
    // Runtime overrides
    for (const [topicId, purpose] of this.topicToPurpose) {
      result[topicId] = purpose;
    }
    return result;
  }

  /**
   * Validate outbound content against topic purpose.
   * Returns the validation result. Callers decide how to handle rejection.
   */
  validateOutboundContent(
    topicId: number,
    text: string,
    options?: { bypass?: boolean },
  ): { allowed: boolean; reason: string | null; detectedCategory: string | null; topicPurpose: string | null; suggestion: string | null } {
    const validationConfig = this.config.contentValidation;
    if (!validationConfig?.enabled) {
      return { allowed: true, reason: null, detectedCategory: null, topicPurpose: null, suggestion: null };
    }

    const purpose = this.getTopicPurpose(topicId);
    return validateTopicContent(text, purpose, validationConfig, options);
  }

  /**
   * Classify content using the configured categories.
   * Useful for debugging and API endpoints.
   */
  classifyContent(text: string): { category: string | null; confidence: string; matchedKeywords: string[] } {
    const validationConfig = this.config.contentValidation;
    if (!validationConfig) {
      return { category: null, confidence: 'low', matchedKeywords: [] };
    }
    return classifyContent(text, validationConfig.categories);
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
    // Phase 1c: Delegate to shared StallDetector when flag is enabled
    if (this.sharedStallDetector) {
      this.sharedStallDetector.trackMessageInjection(topicId.toString(), sessionName, messageText);
      return;
    }

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
    // Phase 1c: Delegate to shared StallDetector when flag is enabled
    if (this.sharedStallDetector) {
      this.sharedStallDetector.clearStallForChannel(topicId.toString());
      return;
    }

    for (const [key, pending] of this.pendingMessages) {
      if (pending.topicId === topicId) {
        this.pendingMessages.delete(key);
      }
    }
  }

  /**
   * Public interface for external callers (e.g., StallTriageNurse) to clear
   * stall tracking for a topic after successful recovery.
   */
  clearStallTracking(topicId: number): void {
    this.clearStallForTopic(topicId);
  }

  /** Clear promise tracking for a topic (e.g., after successful recovery) */
  clearPromiseTracking(topicId: number): void {
    if (this.sharedStallDetector) {
      this.sharedStallDetector.clearPromiseForChannel(topicId.toString());
      return;
    }
    this.pendingPromises.delete(topicId);
  }

  /** Detect "work-in-progress" messages that imply the agent will follow up */
  private isPromiseMessage(text: string): boolean {
    const promisePatterns = [
      /give me (?:a )?(?:couple|few|some) (?:more )?minutes/i,
      /give me (?:a )?(?:minute|moment|second|sec)/i,
      /working on (?:it|this|that)/i,
      /looking into (?:it|this|that)/i,
      /let me (?:check|look|investigate|dig|research)/i,
      /investigating/i,
      /still (?:on it|working|looking)/i,
      /one moment/i,
      /be right back/i,
      /hang on/i,
      /bear with me/i,
      /i'll (?:get back|follow up|check|look into)/i,
      /narrowing (?:it |this |that )?down/i,
    ];
    return promisePatterns.some(p => p.test(text));
  }

  /** Detect messages that indicate the agent delivered on its promise */
  private isFollowThroughMessage(text: string): boolean {
    // Messages that indicate the agent is delivering results (not just status updates)
    // Must be substantially longer than a typical status update
    if (text.length > 200) return true;

    // Explicit completion signals
    const completionPatterns = [
      /here(?:'s| is| are) (?:what|the)/i,
      /i found/i,
      /the (?:issue|problem|bug|fix|solution|answer|result)/i,
      /done|completed|finished|resolved/i,
      /summary|overview|analysis/i,
    ];
    return completionPatterns.some(p => p.test(text));
  }

  /**
   * LLM gate for fallback stall/promise alerts.
   *
   * Before sending a user-facing alert about a stall or expired promise,
   * check with the intelligence provider whether the alert is warranted.
   * This prevents false positives when the StallTriageNurse is unavailable.
   *
   * Returns true if the alert should be sent, false to suppress.
   * If no intelligence provider is available, returns true (fail-open for safety).
   */
  private async confirmStallAlert(context: {
    type: 'stall' | 'promise-expired';
    sessionName: string;
    messageText: string;
    minutesElapsed: number;
    sessionAlive: boolean;
  }): Promise<boolean> {
    if (!this.intelligence) return true; // No LLM available → fail-open

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
      const response = await this.intelligence.evaluate(prompt, {
        maxTokens: 5,
        temperature: 0,
      });
      const answer = response.trim().toLowerCase();
      if (answer === 'no') {
        console.log(`[telegram] LLM suppressed ${context.type} alert for "${context.sessionName}" (${context.minutesElapsed}m)`);
        return false;
      }
      return true;
    } catch (err) {
      // @silent-fallback-ok — LLM intelligence is optional; fail-open to alert user about stalls
      console.warn(`[telegram] LLM stall confirmation failed, allowing alert:`, err);
      return true; // Fail-open
    }
  }

  /** Get all active topic-session mappings (used by SessionMonitor) */
  getActiveTopicSessions(): Map<number, string> {
    return new Map(this.topicToSession);
  }

  /** Get recent message log entries for analysis */
  getMessageLog(limit = 100): Array<{ topicId: number; text: string; fromUser: boolean; timestamp: string }> {
    try {
      if (!fs.existsSync(this.messageLogPath)) return [];
      const content = fs.readFileSync(this.messageLogPath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean).slice(-limit);
      return lines.map(line => {
        try {
          const entry = JSON.parse(line);
          return {
            topicId: entry.topicId,
            text: entry.text || '',
            fromUser: entry.fromUser ?? true,
            timestamp: entry.timestamp || new Date().toISOString(),
          };
        } catch {
          // @silent-fallback-ok — JSONL parse, skip corrupted
          return null;
        }
      }).filter(Boolean) as Array<{ topicId: number; text: string; fromUser: boolean; timestamp: string }>;
    } catch {
      // @silent-fallback-ok — log read, empty array safe
      return [];
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

      // Try LLM-powered triage first if available
      if (this.onStallDetected) {
        try {
          const triageResult = await this.onStallDetected(
            pending.topicId, pending.sessionName, pending.messageText, pending.injectedAt,
          );
          if (triageResult.resolved) {
            this.pendingMessages.delete(key);
            continue; // Nurse handled it
          }
          // Nurse couldn't resolve — fall through to quota check / generic alert
        } catch (err) {
          console.warn(`[telegram] Triage nurse error:`, err);
        }
      }

      // Classify the stall — check if it's a quota death
      let isQuotaDeath = false;
      if (this.onClassifySessionDeath) {
        try {
          const classification = await this.onClassifySessionDeath(pending.sessionName);
          if (classification && classification.cause === 'quota_exhaustion') {
            isQuotaDeath = true;
            this.sendToTopic(
              pending.topicId,
              `\ud83d\udd34 Session hit quota limit \u2014 "${pending.sessionName}" can't respond.\n\n` +
              `${classification.detail}\n\n` +
              `Use /quota to check accounts, /switch-account to switch, or /login to authenticate a new account.`,
            ).catch(err => {
              console.error(`[telegram] Quota stall alert failed: ${err}`);
            });
          }
        } catch {
          // Classification failed — fall through to generic
        }
      }

      if (!isQuotaDeath) {
        const minutesAgo = Math.round((now - pending.injectedAt) / 60000);

        // LLM gate: confirm alert is warranted before sending user-facing message
        const shouldAlert = await this.confirmStallAlert({
          type: 'stall',
          sessionName: pending.sessionName,
          messageText: pending.messageText,
          minutesElapsed: minutesAgo,
          sessionAlive: alive,
        });

        if (shouldAlert) {
          const status = alive ? 'running but not responding' : 'no longer running';
          this.sendToTopic(
            pending.topicId,
            `\u26a0\ufe0f No response after ${minutesAgo} minutes. "${pending.sessionName}" is ${status}.\n\nYour message: "${pending.messageText}..."${alive ? '\n\nTry /interrupt to nudge it, or /restart to start fresh.' : '\n\nSend another message and a new session will start automatically.'}`,
          ).catch(err => {
            console.error(`[telegram] Stall alert failed: ${err}`);
          });
        }
      }
    }

    // Check for expired promises (agent said "give me a minute" but never followed up)
    const promiseMinutes = this.config.promiseTimeoutMinutes ?? 10;
    const promiseThresholdMs = promiseMinutes * 60 * 1000;

    if (promiseMinutes > 0) {
      for (const [topicId, promise] of this.pendingPromises) {
        if (promise.alerted) continue;
        if (now - promise.promisedAt < promiseThresholdMs) continue;

        promise.alerted = true;
        console.log(`[telegram] Promise expired for topic ${topicId}: "${promise.promiseText}" (${Math.round((now - promise.promisedAt) / 60000)} min ago)`);

        // Check if session is still alive
        const alive = this.onIsSessionAlive
          ? this.onIsSessionAlive(promise.sessionName)
          : true;

        // Delegate to triage nurse if available
        if (this.onStallDetected) {
          try {
            const triageResult = await this.onStallDetected(
              promise.topicId, promise.sessionName,
              `[promise expired] ${promise.promiseText}`, promise.promisedAt,
            );
            if (triageResult.resolved) {
              this.pendingPromises.delete(topicId);
              continue;
            }
          } catch (err) {
            console.warn(`[telegram] Promise triage error:`, err);
            DegradationReporter.getInstance().report({
              feature: 'TelegramAdapter.onStallDetected',
              primary: 'LLM-based stall triage diagnosis',
              fallback: 'Stall goes undiagnosed',
              reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
              impact: 'Stalled session persists without recovery attempt',
            });
          }
        }

        // Fallback: LLM-gated user-facing alert
        const promiseMinutesAgo = Math.round((now - promise.promisedAt) / 60000);
        const shouldAlertPromise = await this.confirmStallAlert({
          type: 'promise-expired',
          sessionName: promise.sessionName,
          messageText: promise.promiseText,
          minutesElapsed: promiseMinutesAgo,
          sessionAlive: alive,
        });

        if (shouldAlertPromise) {
          if (!alive) {
            await this.sendToTopic(topicId,
              `The session stopped unexpectedly after saying "${promise.promiseText}". Sending a new message will auto-spawn a fresh session.`
            ).catch(() => {});
          } else {
            await this.sendToTopic(topicId,
              `It's been ${promiseMinutesAgo} minutes since the session said "${promise.promiseText}" — checking on it now...`
            ).catch(() => {});
          }
        }
      }

      // Clean up old promise entries
      for (const [topicId, promise] of this.pendingPromises) {
        if (promise.alerted && now - promise.promisedAt > 60 * 60 * 1000) {
          this.pendingPromises.delete(topicId);
        }
      }
    }

    // Clean up old entries (older than 30 minutes, already alerted)
    for (const [key, pending] of this.pendingMessages) {
      if (pending.alerted && now - pending.injectedAt > 30 * 60 * 1000) {
        this.pendingMessages.delete(key);
      }
    }
  }

  /**
   * Handle stall events from the shared StallDetector (Phase 1c).
   * Bridges shared events back to Telegram-specific alert logic
   * (triage nurse, quota classification, LLM gate, user notifications).
   */
  private async handleSharedStallEvent(event: StallEvent, alive: boolean): Promise<void> {
    const topicId = parseInt(event.channelId, 10);

    // Phase 1e: Emit to event bus
    if (this.eventBus) {
      if (event.type === 'stall') {
        this.eventBus.emit('stall:detected', {
          channelId: event.channelId,
          sessionName: event.sessionName,
          messageText: event.messageText,
          injectedAt: event.injectedAt,
          minutesElapsed: event.minutesElapsed,
          alive,
        }).catch(err => console.error(`[telegram] EventBus stall:detected error: ${err}`));
      } else {
        this.eventBus.emit('stall:promise-expired', {
          channelId: event.channelId,
          sessionName: event.sessionName,
          promiseText: event.messageText,
          promisedAt: event.injectedAt,
          minutesElapsed: event.minutesElapsed,
          alive,
        }).catch(err => console.error(`[telegram] EventBus stall:promise-expired error: ${err}`));
      }
    }

    if (event.type === 'stall') {
      // Try LLM-powered triage first
      if (this.onStallDetected) {
        try {
          const triageResult = await this.onStallDetected(
            topicId, event.sessionName, event.messageText, event.injectedAt,
          );
          if (triageResult.resolved) return;
        } catch (err) {
          console.warn(`[telegram] Triage nurse error:`, err);
        }
      }

      // Classify — check if it's a quota death
      let isQuotaDeath = false;
      if (this.onClassifySessionDeath) {
        try {
          const classification = await this.onClassifySessionDeath(event.sessionName);
          if (classification && classification.cause === 'quota_exhaustion') {
            isQuotaDeath = true;
            this.sendToTopic(
              topicId,
              `\ud83d\udd34 Session hit quota limit \u2014 "${event.sessionName}" can't respond.\n\n` +
              `${classification.detail}\n\n` +
              `Use /quota to check accounts, /switch-account to switch, or /login to authenticate a new account.`,
            ).catch(err => console.error(`[telegram] Quota stall alert failed: ${err}`));
          }
        } catch { /* Classification failed — fall through */ }
      }

      if (!isQuotaDeath) {
        const shouldAlert = await this.confirmStallAlert({
          type: 'stall',
          sessionName: event.sessionName,
          messageText: event.messageText,
          minutesElapsed: event.minutesElapsed,
          sessionAlive: alive,
        });

        if (shouldAlert) {
          const status = alive ? 'running but not responding' : 'no longer running';
          this.sendToTopic(
            topicId,
            `\u26a0\ufe0f No response after ${event.minutesElapsed} minutes. Session "${event.sessionName}" is ${status}.\n\nMessage: "${event.messageText}..."${alive ? '\n\nTry /interrupt to unstick, or /restart to respawn.' : '\n\nSend another message to auto-respawn.'}`,
          ).catch(err => console.error(`[telegram] Stall alert failed: ${err}`));
        }
      }
    } else if (event.type === 'promise-expired') {
      // Try triage nurse first
      if (this.onStallDetected) {
        try {
          const triageResult = await this.onStallDetected(
            topicId, event.sessionName, `[promise expired] ${event.messageText}`, event.injectedAt,
          );
          if (triageResult.resolved) return;
        } catch (err) {
          console.warn(`[telegram] Promise triage error:`, err);
        }
      }

      const shouldAlert = await this.confirmStallAlert({
        type: 'promise-expired',
        sessionName: event.sessionName,
        messageText: event.messageText,
        minutesElapsed: event.minutesElapsed,
        sessionAlive: alive,
      });

      if (shouldAlert) {
        if (!alive) {
          await this.sendToTopic(topicId,
            `The session stopped unexpectedly after saying "${event.messageText}". Sending a new message will auto-spawn a fresh session.`
          ).catch(() => {});
        } else {
          await this.sendToTopic(topicId,
            `It's been ${event.minutesElapsed} minutes since the session said "${event.messageText}" — checking on it now...`
          ).catch(() => {});
        }
      }
    }
  }

  // ── Health Status ────────────────────────────────────────

  getStatus(): {
    started: boolean;
    uptime: number | null;
    pendingStalls: number;
    pendingPromises: number;
    topicMappings: number;
  } {
    const stallStatus = this.sharedStallDetector
      ? this.sharedStallDetector.getStatus()
      : { pendingStalls: this.pendingMessages.size, pendingPromises: this.pendingPromises.size };

    return {
      started: this.polling,
      uptime: this.startedAt ? Date.now() - this.startedAt.getTime() : null,
      pendingStalls: stallStatus.pendingStalls,
      pendingPromises: stallStatus.pendingPromises,
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

  // ── Document Handling ───────────────────────────────────

  /**
   * Download a document from Telegram and save it locally.
   * Preserves the original filename when available.
   * Returns the local file path.
   */
  private async downloadDocument(fileId: string, messageId: number, originalName?: string): Promise<string> {
    const docDir = path.join(this.stateDir, 'telegram-documents');
    fs.mkdirSync(docDir, { recursive: true });
    const ext = originalName ? path.extname(originalName) : '';
    const baseName = originalName
      ? originalName.replace(/[^a-zA-Z0-9._-]/g, '_')
      : `document-${messageId}${ext}`;
    const filename = `${Date.now()}-${baseName}`;
    const filepath = path.join(docDir, filename);
    await this.downloadFile(fileId, filepath);
    return filepath;
  }

  // ── Command Handling ─────────────────────────────────────

  /**
   * Process Telegram commands. Returns true if the message was a command.
   */
  private async handleCommand(text: string, topicId: number, userId: number): Promise<boolean> {
    // Phase 1a: Delegate to shared CommandRouter when flag is enabled
    if (this.sharedCommandRouter) {
      return this.sharedCommandRouter.route(
        text,
        topicId.toString(),
        userId.toString(),
        { telegramUserId: userId, topicId },
      );
    }

    const cmd = text.trim().toLowerCase();

    // Attention topic commands — intercept before general commands
    if (this.isAttentionTopic(topicId)) {
      const handled = await this.handleAttentionCommand(topicId, text);
      if (handled) return true;
    }

    // /flush — flush all batched notifications immediately
    if (cmd === '/flush') {
      if (this.batcher && this.batcher.isEnabled()) {
        const flushed = await this.batcher.flushAll();
        if (flushed > 0) {
          await this.sendToTopic(topicId, `Flushed ${flushed} batched notification${flushed === 1 ? '' : 's'}.`).catch(() => {});
        } else {
          await this.sendToTopic(topicId, 'No batched notifications to flush.').catch(() => {});
        }
      } else if (this.onFlushNotifications) {
        this.onFlushNotifications(topicId).catch(err => {
          console.error('[telegram] Flush notifications failed:', err);
          this.sendToTopic(topicId, 'Failed to flush notifications.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Notification batching is not enabled.').catch(() => {});
      }
      return true;
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
        await this.sendToTopic(topicId, 'Please include a session name — e.g. /claim my-session').catch(() => {});
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
        await this.sendToTopic(topicId, 'Please include a session name — e.g. /link my-session').catch(() => {});
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
          await this.sendToTopic(topicId, `Nudged "${sessionName}" \u2014 it should resume shortly.`).catch(() => {});
        } else {
          await this.sendToTopic(topicId, `Failed to interrupt "${sessionName}" \u2014 session may not exist.`).catch(() => {});
        }
      } catch (err) {
        console.error(`[telegram] Interrupt failed:`, err);
        await this.sendToTopic(topicId, 'Couldn\'t interrupt the session. It may have already ended.').catch(() => {});
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
        console.error(`[telegram] Restart failed:`, err);
        await this.sendToTopic(topicId, 'Restart didn\'t work. The session may need to be recreated — try sending a new message.').catch(() => {});
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

    // /triage — show triage status for this topic
    if (cmd === '/triage') {
      if (!this.onGetTriageStatus) {
        await this.sendToTopic(topicId, 'Triage system not available.').catch(() => {});
        return true;
      }
      const status = this.onGetTriageStatus(topicId);
      if (!status || !status.active) {
        await this.sendToTopic(topicId, '🔍 No active triage for this topic. Session appears to be operating normally.').catch(() => {});
      } else {
        const lines = [
          `🔍 Active triage for this topic:`,
          `Classification: ${status.classification || 'pending'}`,
          `Checks: ${status.checkCount}`,
          status.lastCheck ? `Last check: ${status.lastCheck}` : '',
        ].filter(Boolean);
        await this.sendToTopic(topicId, lines.join('\n')).catch(() => {});
      }
      return true;
    }

    // /switch-account (or /sa) <target> — switch active Claude account
    const switchMatch = text.match(/^\/(?:switch[-_]?account|sa)\s+(.+)$/i);
    if (switchMatch) {
      const target = switchMatch[1].trim();
      if (this.onSwitchAccountRequest) {
        this.onSwitchAccountRequest(target, topicId).catch(err => {
          console.error('[telegram] Switch account failed:', err);
          this.sendToTopic(topicId, 'Account switch didn\'t work. Try again or use /quota to check status.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Account switching not available.').catch(() => {});
      }
      return true;
    }

    // /quota (or /q) — show multi-account quota summary
    if (cmd === '/quota' || cmd === '/q') {
      if (this.onQuotaStatusRequest) {
        this.onQuotaStatusRequest(topicId).catch(err => {
          console.error('[telegram] Quota status failed:', err);
          this.sendToTopic(topicId, 'Couldn\'t check quota right now. Try again in a moment.').catch(() => {});
        });
      } else {
        await this.sendToTopic(topicId, 'Quota status not available.').catch(() => {});
      }
      return true;
    }

    // /login [email] — seamless OAuth login from Telegram
    const loginMatch = text.match(/^\/login(?:\s+(.+))?$/i);
    if (loginMatch) {
      const email = loginMatch[1]?.trim() || null;
      if (this.onLoginRequest) {
        this.onLoginRequest(email, topicId).catch(err => {
          // @silent-fallback-ok — login error, user notified
          console.error('[telegram] Login flow failed:', err);
          this.sendToTopic(topicId, 'Login didn\'t complete. Try again, or the auth service may be temporarily unavailable.').catch(() => { /* @silent-fallback-ok — secondary notification */ });
        });
      } else {
        await this.sendToTopic(topicId, 'Login not available.').catch(() => { /* @silent-fallback-ok — secondary notification */ });
      }
      return true;
    }

    // /new is handled in server.ts onTopicMessage — it needs sessionManager
    // access to spawn a session in the new topic. Don't intercept it here.

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
    // Phase 1b: Delegate to shared MessageLogger when flag is enabled
    if (this.sharedLogger) {
      this.sharedLogger.append({
        messageId: entry.messageId,
        channelId: entry.topicId,
        text: entry.text,
        fromUser: entry.fromUser,
        timestamp: entry.timestamp,
        sessionName: entry.sessionName,
        senderName: entry.senderName,
        senderUsername: entry.senderUsername,
        platformUserId: entry.telegramUserId,
        platform: 'telegram',
      });
      // Also notify the Telegram-specific callback for backward compatibility
      if (this.onMessageLogged) {
        try {
          this.onMessageLogged(entry);
        } catch (err) {
          DegradationReporter.getInstance().report({
            feature: 'TopicMemory.dualWrite',
            primary: 'SQLite dual-write of messages for search and summaries',
            fallback: 'Message only in JSONL log (no search, no summary updates)',
            reason: `onMessageLogged callback failed: ${err instanceof Error ? err.message : String(err)}`,
            impact: 'Message may be missing from topic search and context summaries.',
          });
        }
      }
      // Phase 1e: Emit to event bus
      if (this.eventBus) {
        this.eventBus.emit('message:logged', {
          messageId: entry.messageId,
          channelId: entry.topicId?.toString() ?? '',
          text: entry.text,
          fromUser: entry.fromUser,
          timestamp: entry.timestamp,
          sessionName: entry.sessionName,
          senderName: entry.senderName,
          senderUsername: entry.senderUsername,
          platformUserId: entry.telegramUserId?.toString(),
        }).catch(err => console.error(`[telegram] EventBus message:logged error: ${err}`));
      }
      return;
    }

    // Legacy path (flag disabled)
    try {
      fs.appendFileSync(this.messageLogPath, JSON.stringify(entry) + '\n');
      this.maybeRotateLog();
    } catch (err) {
      console.error(`[telegram] Failed to append to message log: ${err}`);
      DegradationReporter.getInstance().report({
        feature: 'Telegram.messageLog',
        primary: 'JSONL message log for conversation history and recovery',
        fallback: 'Message lost from persistent log (only in memory)',
        reason: `Failed to write message log: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Conversation history gap — message may be missing from JSONL backup.',
      });
    }

    // Notify subscribers (TopicMemory for SQLite dual-write)
    if (this.onMessageLogged) {
      try {
        this.onMessageLogged(entry);
      } catch (err) {
        DegradationReporter.getInstance().report({
          feature: 'TopicMemory.dualWrite',
          primary: 'SQLite dual-write of messages for search and summaries',
          fallback: 'Message only in JSONL log (no search, no summary updates)',
          reason: `onMessageLogged callback failed: ${err instanceof Error ? err.message : String(err)}`,
          impact: 'Message may be missing from topic search and context summaries.',
        });
      }
    }
    // Phase 1e: Emit to event bus
    if (this.eventBus) {
      this.eventBus.emit('message:logged', {
        messageId: entry.messageId,
        channelId: entry.topicId?.toString() ?? '',
        text: entry.text,
        fromUser: entry.fromUser,
        timestamp: entry.timestamp,
        sessionName: entry.sessionName,
        senderName: entry.senderName,
        senderUsername: entry.senderUsername,
        platformUserId: entry.telegramUserId?.toString(),
      }).catch(err => console.error(`[telegram] EventBus message:logged error: ${err}`));
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
      // @silent-fallback-ok — log rotation non-critical
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

    // Create Telegram topic (uses the centralized method for forum detection)
    try {
      const emoji = PRIORITY_EMOJI[item.priority] || PRIORITY_EMOJI.NORMAL;
      const color = PRIORITY_COLOR[item.priority] || PRIORITY_COLOR.NORMAL;
      const topicTitle = `${emoji} ${item.title}`.slice(0, 128);

      const topic = await this.createForumTopic(topicTitle, color);

      const topicId = topic.topicId;
      attention.topicId = topicId;

      // Register mappings
      this.attentionItemToTopic.set(item.id, topicId);
      this.attentionTopicToItem.set(topicId, item.id);
      this.topicToName.set(topicId, item.title);
      // Registry already saved by createForumTopic

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
      DegradationReporter.getInstance().report({
        feature: 'TelegramAdapter.createAttentionItem',
        primary: 'Send attention/escalation notification',
        fallback: 'Attention item never delivered',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'User not notified of important escalation',
      });
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
      if (data.topicToPurpose) {
        for (const [k, v] of Object.entries(data.topicToPurpose)) {
          this.topicToPurpose.set(Number(k), v as string);
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
        topicToPurpose: Object.fromEntries(this.topicToPurpose),
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
      const raw = fs.readFileSync(this.offsetPath, 'utf-8');
      const data = JSON.parse(raw);
      // Support both 'lastUpdateId' (canonical) and 'offset' (legacy/external)
      const candidate = data.lastUpdateId ?? data.offset;
      if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        this.lastUpdateId = candidate;
        console.log(`[telegram] Restored poll offset: ${this.lastUpdateId}`);
      } else if (data.lastUpdateId !== undefined || data.offset !== undefined) {
        console.warn(`[telegram] Poll offset file has invalid value: ${raw.trim().substring(0, 100)}. Starting from 0.`);
      }
    } catch (err) {
      // Distinguish missing file from corrupted file
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[telegram] Poll offset file corrupted, starting from 0: ${err}`);
      }
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

      // Offset range sanity check: if received update_ids are significantly lower
      // than our stored offset, the offset is likely from a different bot token or
      // was corrupted during a migration. Auto-correct to prevent infinite replay.
      if (updates.length > 0 && this.lastUpdateId > 0) {
        const maxReceivedId = Math.max(...updates.map(u => u.update_id));
        const OFFSET_RANGE_THRESHOLD = 10_000_000; // 10M delta = cross-token corruption
        if (maxReceivedId < this.lastUpdateId - OFFSET_RANGE_THRESHOLD) {
          console.warn(
            `[telegram] Offset range mismatch: stored=${this.lastUpdateId}, ` +
            `received max=${maxReceivedId} (delta=${this.lastUpdateId - maxReceivedId}). ` +
            `Auto-correcting offset to prevent infinite replay loop.`
          );
          this.lastUpdateId = maxReceivedId;
          this.saveOffset();
        }
      }

      for (const update of updates) {
        await this.processUpdate(update);
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
        // Save offset after each update so a crash mid-batch doesn't re-deliver
        // messages that were already processed (mirrors TelegramLifeline fix).
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
   * Process a single Telegram update (text, voice, photo, or callback query).
   */
  private async processUpdate(update: TelegramUpdate): Promise<void> {
    // Handle callback queries from inline keyboard buttons (Prompt Gate)
    if (update.callback_query) {
      await this.processCallbackQuery(update.callback_query);
      return;
    }

    const msg = update.message;
    if (!msg) return;

    // Auth gating — handle messages from unauthorized/unknown users
    if (!this.isAuthorized(msg.from.id)) {
      await this.handleUnknownUser(msg.from.id, msg.from.first_name, msg.from.username, msg.text);
      return;
    }

    const numericTopicId = msg.message_thread_id ?? GENERAL_TOPIC_ID;
    const topicId = numericTopicId.toString();

    // Auto-capture topic name from multiple sources:
    // 1. Service message when topic is created (msg.forum_topic_created)
    // 2. Service message when topic is renamed (msg.forum_topic_edited)
    // 3. Reply to the topic creation service message (msg.reply_to_message.forum_topic_created)
    const detectedName =
      msg.forum_topic_created?.name ??
      msg.forum_topic_edited?.name ??
      msg.reply_to_message?.forum_topic_created?.name;
    if (detectedName) {
      const currentName = this.topicToName.get(numericTopicId);
      if (!currentName || /^topic-\d+$/.test(currentName) || msg.forum_topic_edited?.name) {
        this.topicToName.set(numericTopicId, detectedName);
        this.saveRegistry();
        console.log(`[telegram] Captured topic name: ${numericTopicId} → "${detectedName}"`);
      }
    }

    // Service messages (topic created/edited) have no user content — skip further processing
    if (msg.forum_topic_created || msg.forum_topic_edited) {
      return;
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

    // Handle document/file messages
    if (msg.document) {
      await this.handleDocumentMessage(msg, numericTopicId);
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

    // Log the message (including sender identity for multi-user topics)
    this.appendToLog({
      messageId: msg.message_id,
      topicId: numericTopicId,
      text,
      fromUser: true,
      timestamp: new Date(msg.date * 1000).toISOString(),
      sessionName: this.topicToSession.get(numericTopicId) ?? null,
      senderName: msg.from.first_name,
      senderUsername: msg.from.username,
      telegramUserId: msg.from.id,
    });

    // Sentinel intercept — fires BEFORE routing to detect emergency stop/pause.
    // This runs in the server process, separate from the session, so it can
    // kill/pause the session even when the session is mid-tool-call.
    if (this.onSentinelIntercept) {
      try {
        const classification = await this.onSentinelIntercept(text, numericTopicId);
        if (classification && (classification.category === 'emergency-stop' || classification.category === 'pause')) {
          const sessionName = this.topicToSession.get(numericTopicId);
          if (classification.category === 'emergency-stop' && sessionName) {
            console.log(`[sentinel] Emergency stop for session "${sessionName}" in topic ${numericTopicId}`);
            if (this.onSentinelKillSession) {
              this.onSentinelKillSession(sessionName);
            }
            // Never include raw sentinel reasons in user-facing messages.
            // Log the full reason server-side, show only clean messages to users.
            if (classification.reason) {
              console.log(`[sentinel] Stop reason: ${classification.reason}`);
            }
            await this.sendToTopic(numericTopicId,
              `Session terminated.\n\nSend a new message to start a fresh session.`
            ).catch(() => {});
          } else if (classification.category === 'pause' && sessionName) {
            console.log(`[sentinel] Pause for session "${sessionName}" in topic ${numericTopicId}`);
            if (this.onSentinelPauseSession) {
              this.onSentinelPauseSession(sessionName);
            }
            // Never include raw sentinel reasons in user-facing messages.
            if (classification.reason) {
              console.log(`[sentinel] Pause reason: ${classification.reason}`);
            }
            await this.sendToTopic(numericTopicId,
              `Session paused.\n\nSend a message to resume.`
            ).catch(() => {});
          } else if (!sessionName) {
            // No active session — just acknowledge the stop/pause signal
            await this.sendToTopic(numericTopicId,
              `No active session to ${classification.category === 'emergency-stop' ? 'stop' : 'pause'}.`
            ).catch(() => {});
          }
          return; // Don't route to session — sentinel handled it
        }
      } catch (err) {
        console.error(`[sentinel] Intercept error: ${err}`);
        // On sentinel error, fall through to normal routing (fail-open for message delivery)
      }
    }

    // Prompt Gate — intercept replies to relay messages (text-input prompts)
    if (this.pendingPromptReply.has(numericTopicId) && text) {
      const handled = this.handlePendingPromptReply(numericTopicId, msg);
      if (handled) return;
    }

    // Fire topic message callback (always fires — General topic falls back to ID 1)
    if (this.onTopicMessage) {
      try {
        Promise.resolve(this.onTopicMessage(message)).catch(err => {
          console.error(`[telegram] Topic message handler error: ${err}`);
        });
      } catch (err) {
        console.error(`[telegram] Topic message handler sync error: ${err}`);
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

      // Log it (including sender identity for multi-user topics)
      this.appendToLog({
        messageId: msg.message_id,
        topicId,
        text: `[voice] ${transcript}`,
        fromUser: true,
        timestamp: new Date(msg.date * 1000).toISOString(),
        sessionName: this.topicToSession.get(topicId) ?? null,
        senderName: msg.from.first_name,
        senderUsername: msg.from.username,
        telegramUserId: msg.from.id,
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

      // Log it (including sender identity for multi-user topics)
      this.appendToLog({
        messageId: msg.message_id,
        topicId,
        text: content,
        fromUser: true,
        timestamp: new Date(msg.date * 1000).toISOString(),
        sessionName: this.topicToSession.get(topicId) ?? null,
        senderName: msg.from.first_name,
        senderUsername: msg.from.username,
        telegramUserId: msg.from.id,
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
      await this.sendToTopic(topicId, '(Photo received but I couldn\'t process it. Try sending it again.)').catch(() => {});
    }
  }

  /**
   * Handle an incoming document message: download, save, route with path.
   */
  private async handleDocumentMessage(
    msg: NonNullable<TelegramUpdate['message']>,
    topicId: number,
  ): Promise<void> {
    const doc = msg.document!;
    const caption = msg.caption || '';

    try {
      const filepath = await this.downloadDocument(doc.file_id, msg.message_id, doc.file_name);
      console.log(`[telegram] Downloaded document: ${filepath}`);

      const content = caption
        ? `[document:${filepath}] ${caption}`
        : `[document:${filepath}]`;

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
          documentPath: filepath,
          documentName: doc.file_name,
          documentMimeType: doc.mime_type,
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
        senderName: msg.from.first_name,
        senderUsername: msg.from.username,
        telegramUserId: msg.from.id,
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
      console.error(`[telegram] Failed to download document: ${err}`);
      await this.sendToTopic(topicId, '(Document received but I couldn\'t process it. Try sending it again.)').catch(() => {});
    }
  }

  // ── Prompt Gate: Telegram Relay ───────────────────────────────────

  /**
   * Relay a detected prompt to a Telegram topic with inline keyboard buttons.
   * For prompts with options: sends buttons. For questions: sends text asking for reply.
   * Returns the Telegram message ID of the relay message.
   */
  async relayPrompt(topicId: number, prompt: DetectedPrompt): Promise<number> {
    // First-use disclosure (once per topic)
    if (!this.promptGateDisclosureSent.has(topicId)) {
      await this.sendToTopic(topicId,
        'Prompt Gate is now active for this topic. Session prompts will appear here ' +
        'for you to respond to. Note: prompt text is sent through Telegram\'s servers. ' +
        'Avoid including credentials or sensitive data in your replies.'
      ).catch(() => {});
      this.promptGateDisclosureSent.add(topicId);
    }

    const text = this.formatPromptMessage(prompt);

    let result: { message_id: number };

    if (prompt.options && prompt.options.length > 0) {
      // Add numbered options to the message body so full text is visible
      const optionLines = prompt.options.map((opt, i) => `${i + 1}. ${opt.label}`).join('\n');
      const fullText = `${text}\n\n${optionLines}`;

      // Build inline keyboard buttons with just the number/key (compact)
      const keyboard = prompt.options.map((opt, i) => {
        const token = this.callbackRegistry.register({
          sessionName: prompt.sessionName,
          promptId: prompt.id,
          key: opt.key,
        });
        return {
          text: String(i + 1),
          callback_data: JSON.stringify({ id: token }),
        };
      });

      // All buttons in a single row (they're just numbers now)
      result = await this.apiCall('sendMessage', {
        chat_id: this.config.chatId,
        message_thread_id: isGeneralTopic(topicId) ? undefined : topicId,
        text: fullText,
        reply_markup: { inline_keyboard: [keyboard] },
        parse_mode: 'Markdown',
      }) as { message_id: number };
    } else {
      // No options — text reply expected (clarifying question)
      result = await this.apiCall('sendMessage', {
        chat_id: this.config.chatId,
        message_thread_id: isGeneralTopic(topicId) ? undefined : topicId,
        text,
        parse_mode: 'Markdown',
      }) as { message_id: number };
    }

    // Track pending reply for text-input prompts
    this.pendingPromptReply.set(topicId, {
      prompt,
      relayMessageId: result.message_id,
      createdAt: Date.now(),
    });

    // Notify session manager to extend idle timeout (relay lease)
    if (this.onRelayLeaseStart) {
      this.onRelayLeaseStart(prompt.sessionName);
    }

    console.log(`[prompt-gate] Relayed ${prompt.type} prompt to topic ${topicId} (msg ${result.message_id})`);
    return result.message_id;
  }

  /**
   * Format a detected prompt into Telegram-friendly text.
   * Differentiates by prompt type and escapes Markdown special chars.
   */
  private formatPromptMessage(prompt: DetectedPrompt): string {
    const escapedSummary = this.escapeMarkdown(prompt.summary);

    switch (prompt.type) {
      case 'permission':
        return `\u{23F3} *Your agent is waiting — approve or decline:*\n\n"${escapedSummary}"`;
      case 'plan':
        return `\u{23F3} *Agent plan ready — do you want to proceed?*\n\n"${escapedSummary}"`;
      case 'question':
        return `\u{23F3} *Your agent has a question:*\n\n"${escapedSummary}"\n\nReply to this message with your answer.`;
      case 'confirmation':
        return `\u{23F3} *Your agent needs confirmation:*\n\n"${escapedSummary}"`;
      case 'selection':
        return `\u{23F3} *Your agent needs you to choose:*\n\n"${escapedSummary}"`;
      default:
        return `\u{23F3} *Session needs your input:*\n\n"${escapedSummary}"`;
    }
  }

  /**
   * Escape Markdown special characters for Telegram.
   */
  private escapeMarkdown(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/`/g, '\\`')
      .replace(/\[/g, '\\[');
  }

  /**
   * Handle a forwarded callback query from the Lifeline process.
   * In send-only mode the server doesn't poll for callbacks, so the
   * Lifeline forwards them via /internal/telegram-callback.
   */
  async handleForwardedCallback(query: any): Promise<void> {
    await this.processCallbackQuery(query);
  }

  /**
   * Handle a Telegram callback query from an inline keyboard button press.
   */
  private async processCallbackQuery(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    if (!query.data) {
      await this.apiCall('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Invalid button data',
      }).catch(() => {});
      return;
    }

    // Authorization check: verify sender is the configured owner
    const ownerId = this.config.promptGate?.ownerId;
    if (ownerId && query.from.id !== ownerId) {
      await this.apiCall('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Only the session owner can respond to prompts',
      }).catch(() => {});
      // Do NOT resolve the token — preserve it for the real owner
      return;
    }

    // Parse callback data
    let tokenId: string;
    try {
      const data = JSON.parse(query.data);
      tokenId = data.id;
      if (!tokenId || typeof tokenId !== 'string') throw new Error('missing id');
    } catch {
      await this.apiCall('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Invalid callback data',
      }).catch(() => {});
      return;
    }

    // Resolve the token
    const context = this.callbackRegistry.resolve(tokenId);

    if (!context) {
      // Stale button (server restarted, or entry pruned)
      await this.apiCall('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Session expired \u2014 check the dashboard',
      }).catch(() => {});
      if (query.message) {
        await this.editMessageWithRetry(
          query.message.message_id,
          '\u274C Session expired before response received'
        );
      }
      return;
    }

    // Validate the key against the allowlist
    if (!isAllowedButtonKey(context.key)) {
      console.warn(`[prompt-gate] Rejected non-allowlisted button key: ${context.key}`);
      await this.apiCall('answerCallbackQuery', {
        callback_query_id: query.id,
        text: 'Invalid response key',
      }).catch(() => {});
      return;
    }

    // Answer the callback (removes loading spinner on button)
    await this.apiCall('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Sent to session',
    }).catch(() => {});

    // Update the message to show which option was chosen
    if (query.message) {
      await this.editMessageWithRetry(
        query.message.message_id,
        `\u2705 Responded: ${context.key}`
      );
    }

    // Clear pending reply for this topic (if any)
    const topicId = query.message?.message_thread_id;
    if (topicId) {
      this.pendingPromptReply.delete(topicId);
    }

    // Release relay lease
    if (this.onRelayLeaseEnd) {
      this.onRelayLeaseEnd(context.sessionName);
    }

    // Inject the response into the session
    if (this.onPromptResponse) {
      const sent = this.onPromptResponse(context.sessionName, context.key);
      if (!sent) {
        console.warn(`[prompt-gate] Failed to send key "${context.key}" to session "${context.sessionName}"`);
      }
    } else {
      console.warn(`[prompt-gate] No onPromptResponse handler — cannot inject response`);
    }

    console.log(`[prompt-gate] Callback resolved: session="${context.sessionName}" key="${context.key}"`);
  }

  /**
   * Handle a text reply to a Prompt Gate relay message (for text-input prompts).
   * Returns true if the message was intercepted, false to fall through to normal routing.
   */
  private handlePendingPromptReply(
    topicId: number,
    msg: NonNullable<TelegramUpdate['message']>,
  ): boolean {
    const pending = this.pendingPromptReply.get(topicId);
    if (!pending) return false;

    // Check timeout (2x relay timeout)
    const relayTimeoutMs = (this.config.promptGate?.relayTimeoutSeconds ?? 300) * 2000;
    if (Date.now() - pending.createdAt > relayTimeoutMs) {
      this.pendingPromptReply.delete(topicId);
      // Release relay lease
      if (this.onRelayLeaseEnd) {
        this.onRelayLeaseEnd(pending.prompt.sessionName);
      }
      return false; // Expired — fall through to normal routing
    }

    // Reject forwarded messages — prevents forwarding attack
    if ((msg as any).forward_origin || (msg as any).forward_from || (msg as any).forward_date) {
      return false; // Forwarded message — reject silently
    }

    // Verify sender is the authorized owner
    const ownerId = this.config.promptGate?.ownerId;
    if (ownerId && msg.from.id !== ownerId) {
      return false; // Not the owner — fall through to normal routing
    }

    // Verify this is a reply-to the relay message
    if (msg.reply_to_message?.message_id !== pending.relayMessageId) {
      return false; // Not replying to the prompt — fall through
    }

    // Intercept the reply
    this.pendingPromptReply.delete(topicId);

    // Release relay lease
    if (this.onRelayLeaseEnd) {
      this.onRelayLeaseEnd(pending.prompt.sessionName);
    }

    // Sanitize the input
    const sanitized = sanitizeForPrompt(msg.text ?? '', 512);
    if (!sanitized) {
      console.warn(`[prompt-gate] Empty text reply after sanitization, topic ${topicId}`);
      return true; // Still consume the message — don't route it as a new message
    }

    // Inject the text into the session
    if (this.onPromptTextResponse) {
      const sent = this.onPromptTextResponse(pending.prompt.sessionName, sanitized);
      if (!sent) {
        console.warn(`[prompt-gate] Failed to send text to session "${pending.prompt.sessionName}"`);
      }
    } else {
      console.warn(`[prompt-gate] No onPromptTextResponse handler — cannot inject text`);
    }

    // Update the relay message to show it was answered
    this.editMessageWithRetry(
      pending.relayMessageId,
      `\u2705 Answered: "${sanitized.slice(0, 100)}${sanitized.length > 100 ? '...' : ''}"`
    ).catch(() => {});

    console.log(`[prompt-gate] Text reply intercepted: session="${pending.prompt.sessionName}" text="${sanitized.slice(0, 50)}"`);
    return true;
  }

  /**
   * Edit a Telegram message with retry on failure.
   * Uses exponential backoff (1s, 2s, 4s) for up to 3 attempts.
   */
  private async editMessageWithRetry(messageId: number, text: string, retries = 3): Promise<void> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await this.apiCall('editMessageText', {
          chat_id: this.config.chatId,
          message_id: messageId,
          text,
        });
        return;
      } catch (err) {
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        } else {
          console.warn(`[prompt-gate] Failed to edit message ${messageId} after ${retries} attempts: ${err}`);
        }
      }
    }
  }

  /**
   * Clean up Prompt Gate state for a session (call when session ends).
   */
  cleanupPromptGate(sessionName: string): void {
    // Remove all callback registry entries for this session
    this.callbackRegistry.removeForSession(sessionName);

    // Clear any pending replies for topics bound to this session
    for (const [topicId, pending] of this.pendingPromptReply) {
      if (pending.prompt.sessionName === sessionName) {
        this.pendingPromptReply.delete(topicId);
        // Update the relay message
        this.editMessageWithRetry(
          pending.relayMessageId,
          '\u274C Session ended before response received'
        ).catch(() => {});
      }
    }
  }

  /**
   * Proactively prune expired relay prompts and send timeout messages.
   * Call periodically (e.g. every 60s) to handle cases where no new message
   * arrives to trigger the expiry check in handlePendingPromptReply.
   */
  async pruneExpiredRelays(): Promise<void> {
    const relayTimeoutMs = (this.config.promptGate?.relayTimeoutSeconds ?? 300) * 1000;
    const reminderMs = relayTimeoutMs; // Send reminder at 1x timeout
    const expiryMs = relayTimeoutMs * 2; // Expire at 2x timeout
    const now = Date.now();

    for (const [topicId, pending] of this.pendingPromptReply) {
      const age = now - pending.createdAt;

      if (age > expiryMs) {
        // Expired — update message and clean up
        this.pendingPromptReply.delete(topicId);
        this.editMessageWithRetry(
          pending.relayMessageId,
          '\u23f0 Prompt expired — no response received. Check the dashboard to respond manually.'
        ).catch(() => {});

        // Release relay lease
        if (this.onRelayLeaseEnd) {
          this.onRelayLeaseEnd(pending.prompt.sessionName);
        }

        // Clean up callback registry entries for this prompt
        this.callbackRegistry.removeForSession(pending.prompt.sessionName);

        console.log(`[prompt-gate] Relay expired for topic ${topicId} (${Math.round(age / 1000)}s)`);
      } else if (age > reminderMs && !pending.reminderSent) {
        // Send reminder
        await this.sendToTopic(topicId,
          '\u23f3 Still waiting for your response on the prompt above.'
        ).catch(() => {});
        pending.reminderSent = true;
      }
    }
  }

  /**
   * Stop the callback registry (call on adapter shutdown).
   */
  stopPromptGate(): void {
    this.callbackRegistry.stop();
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const result = await this.apiCall('getUpdates', {
      offset: this.lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ['message', 'callback_query'],
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
