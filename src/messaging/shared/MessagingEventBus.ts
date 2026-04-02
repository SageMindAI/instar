/**
 * MessagingEventBus — Typed event emitter for messaging adapters (Phase 1e).
 *
 * Replaces direct callback properties (onTopicMessage, onInterruptSession, etc.)
 * with a typed pub/sub system. Any adapter can emit events, and any consumer
 * (server, triage nurse, monitor) can subscribe.
 *
 * Design:
 * - Strongly typed: event names are string literals, payloads are typed per-event
 * - Multiple listeners per event (unlike callback properties that only hold one)
 * - Error isolation: one listener throwing doesn't affect others
 * - Async-aware: listeners can return promises, emit() awaits all
 * - Platform-agnostic: uses channelId (string), not topicId (number)
 */

// ── Event type definitions ──────────────────────────────────────────

export interface IncomingMessageEvent {
  channelId: string;
  userId: string;
  text: string;
  timestamp: string;
  /** Platform-specific raw message object */
  raw?: unknown;
}

export interface MessageLoggedEvent {
  messageId: number;
  channelId: string;
  text: string;
  fromUser: boolean;
  timestamp: string;
  sessionName: string | null;
  senderName?: string;
  senderUsername?: string;
  platformUserId?: string;
}

export interface StallDetectedEvent {
  channelId: string;
  sessionName: string;
  messageText: string;
  injectedAt: number;
  minutesElapsed: number;
  alive: boolean;
}

export interface PromiseExpiredEvent {
  channelId: string;
  sessionName: string;
  promiseText: string;
  promisedAt: number;
  minutesElapsed: number;
  alive: boolean;
}

export interface SessionInterruptRequest {
  sessionName: string;
  channelId: string;
}

export interface SessionRestartRequest {
  sessionName: string;
  channelId: string;
}

export interface CommandExecutedEvent {
  command: string;
  args: string;
  channelId: string;
  userId: string;
  handled: boolean;
}

export interface UnauthorizedUserEvent {
  userId: string;
  displayName: string;
  username?: string;
  channelId: string;
  messageText?: string;
}

export interface AttentionStatusEvent {
  itemId: string;
  status: string;
}

export interface FlushRequestEvent {
  channelId: string;
}

export interface QuotaRequestEvent {
  channelId: string;
}

export interface SwitchAccountRequestEvent {
  target: string;
  channelId: string;
}

export interface LoginRequestEvent {
  email: string | null;
  channelId: string;
}

export interface PresenceTypingEvent {
  channelId: string;
  timestamp: string;
}

export interface ReadReceiptEvent {
  channelId: string;
  messageId: string;
  timestamp: string;
}

export interface AckReactionEvent {
  channelId: string;
  messageId: string;
  emoji: string;
  timestamp: string;
}

export interface QrUpdateEvent {
  qr: string | null;
  timestamp: string;
}

export interface OutboundRateLimitedEvent {
  recipient: string;  // masked
  reason: string;
}

// ── Event map ──────────────────────────────────────────────────────

export interface MessagingEventMap {
  'message:incoming': IncomingMessageEvent;
  'message:logged': MessageLoggedEvent;
  'stall:detected': StallDetectedEvent;
  'stall:promise-expired': PromiseExpiredEvent;
  'session:interrupt': SessionInterruptRequest;
  'session:restart': SessionRestartRequest;
  'command:executed': CommandExecutedEvent;
  'auth:unauthorized': UnauthorizedUserEvent;
  'attention:status-change': AttentionStatusEvent;
  'request:flush': FlushRequestEvent;
  'request:quota': QuotaRequestEvent;
  'request:switch-account': SwitchAccountRequestEvent;
  'request:login': LoginRequestEvent;
  'presence:typing': PresenceTypingEvent;
  'receipt:read': ReadReceiptEvent;
  'reaction:ack': AckReactionEvent;
  'whatsapp:qr-update': QrUpdateEvent;
  'rate:outbound-limited': OutboundRateLimitedEvent;
}

export type MessagingEventName = keyof MessagingEventMap;

// ── Listener types ──────────────────────────────────────────────────

export type EventListener<E> = (event: E) => void | Promise<void>;

interface ListenerEntry<E> {
  listener: EventListener<E>;
  once: boolean;
}

// ── EventBus implementation ──────────────────────────────────────────

export class MessagingEventBus {
  private listeners = new Map<string, ListenerEntry<any>[]>();
  private platform: string;

  constructor(platform: string) {
    this.platform = platform;
  }

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends MessagingEventName>(
    event: K,
    listener: EventListener<MessagingEventMap[K]>,
  ): () => void {
    const entries = this.listeners.get(event) ?? [];
    const entry: ListenerEntry<MessagingEventMap[K]> = { listener, once: false };
    entries.push(entry);
    this.listeners.set(event, entries);

    return () => {
      const current = this.listeners.get(event);
      if (current) {
        const idx = current.indexOf(entry);
        if (idx !== -1) current.splice(idx, 1);
      }
    };
  }

  /** Subscribe to an event, automatically unsubscribing after the first call. */
  once<K extends MessagingEventName>(
    event: K,
    listener: EventListener<MessagingEventMap[K]>,
  ): () => void {
    const entries = this.listeners.get(event) ?? [];
    const entry: ListenerEntry<MessagingEventMap[K]> = { listener, once: true };
    entries.push(entry);
    this.listeners.set(event, entries);

    return () => {
      const current = this.listeners.get(event);
      if (current) {
        const idx = current.indexOf(entry);
        if (idx !== -1) current.splice(idx, 1);
      }
    };
  }

  /** Remove all listeners for a specific event, or all events if no event specified. */
  off<K extends MessagingEventName>(event?: K): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  /** Emit an event to all registered listeners. Awaits all async listeners. */
  async emit<K extends MessagingEventName>(
    event: K,
    data: MessagingEventMap[K],
  ): Promise<void> {
    const entries = this.listeners.get(event);
    if (!entries || entries.length === 0) return;

    // Snapshot to avoid mutation during iteration
    const snapshot = [...entries];
    const toRemove: ListenerEntry<any>[] = [];

    for (const entry of snapshot) {
      try {
        await entry.listener(data);
      } catch (err) {
        console.error(`[event-bus:${this.platform}] Listener error on "${event}": ${err}`);
      }
      if (entry.once) {
        toRemove.push(entry);
      }
    }

    // Remove once-listeners
    if (toRemove.length > 0) {
      const current = this.listeners.get(event);
      if (current) {
        for (const entry of toRemove) {
          const idx = current.indexOf(entry);
          if (idx !== -1) current.splice(idx, 1);
        }
      }
    }
  }

  /** Get the count of listeners for a specific event. */
  listenerCount(event: MessagingEventName): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  /** Get all event names that have listeners. */
  eventNames(): MessagingEventName[] {
    const names: MessagingEventName[] = [];
    for (const [key, entries] of this.listeners) {
      if (entries.length > 0) {
        names.push(key as MessagingEventName);
      }
    }
    return names;
  }

  /** Get the platform this bus belongs to. */
  getPlatform(): string {
    return this.platform;
  }
}
