/**
 * SocketModeClient — WebSocket connection manager for Slack Socket Mode.
 *
 * Handles the full lifecycle: connect, receive events, acknowledge,
 * reconnect with hardened strategy (exponential backoff, active heartbeat,
 * too_many_websockets handling, proactive rotation).
 *
 * Uses Node's built-in WebSocket (Node 22+) or falls back to 'ws' package.
 */

import { SlackApiClient, SlackApiError } from './SlackApiClient.js';
import type { SocketModeEnvelope, SocketModeConnectionInfo } from './types.js';

// Polyfill WebSocket for Node <22 (global added in Node 22)
if (typeof globalThis.WebSocket === 'undefined') {
  const ws = await import('ws');
  // @ts-expect-error ws package is API-compatible but has different TS types
  globalThis.WebSocket = ws.default;
}

export interface SocketModeHandlers {
  onEvent: (type: string, payload: Record<string, unknown>) => Promise<void>;
  onInteraction: (payload: Record<string, unknown>) => Promise<void>;
  onConnected: () => void;
  onDisconnected: (reason: string) => void;
  onError: (error: Error, permanent: boolean) => void;
}

interface OutboundQueueItem {
  data: string;
  enqueuedAt: number;
}

const MAX_OUTBOUND_QUEUE = 100;
const HEARTBEAT_TIMEOUT_MS = 3_600_000; // 1 hour — quiet channels have no events; WebSocket close handles real disconnections
const MAX_BACKOFF_MS = 60_000;
const TOO_MANY_WS_DELAY_MS = 30_000;

export class SocketModeClient {
  private apiClient: SlackApiClient;
  private handlers: SocketModeHandlers;
  private ws: WebSocket | null = null;
  private started = false;
  private reconnecting = false;
  private consecutiveErrors = 0;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEventAt = 0;
  private outboundQueue: OutboundQueueItem[] = [];
  private connectionTime: number | null = null;

  constructor(apiClient: SlackApiClient, handlers: SocketModeHandlers) {
    this.apiClient = apiClient;
    this.handlers = handlers;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    this.started = true;
    await this._openConnection();
  }

  async disconnect(): Promise<void> {
    this.started = false;
    this._clearHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'client disconnect');
      this.ws = null;
    }
  }

  /** Force-reconnect: tear down existing connection and establish a new one. */
  async reconnect(): Promise<void> {
    this._clearHeartbeat();
    this.reconnecting = false;
    this.consecutiveErrors = 0;
    if (this.ws) {
      // Temporarily clear started to prevent the close handler from
      // triggering its own reconnect (we're already handling it).
      const wasStarted = this.started;
      this.started = false;
      try { this.ws.close(1000, 'reconnect'); } catch { /* ok */ }
      this.ws = null;
      this.started = wasStarted;
    }
    this.started = true;
    await this._openConnection();
  }

  /** Queue an outbound message for sending (or send immediately if connected). */
  queueOutbound(data: string): void {
    if (this.isConnected && this.ws) {
      this.ws.send(data);
    } else {
      this.outboundQueue.push({ data, enqueuedAt: Date.now() });
      if (this.outboundQueue.length > MAX_OUTBOUND_QUEUE) {
        this.outboundQueue.shift(); // Drop oldest
      }
    }
  }

  private async _openConnection(): Promise<void> {
    try {
      const response = await this.apiClient.call(
        'apps.connections.open',
        {},
        { useAppToken: true },
      ) as unknown as SocketModeConnectionInfo;

      if (!response.url) {
        throw new Error('No WebSocket URL in apps.connections.open response');
      }

      this.connectionTime = response.approximate_connection_time ?? null;
      this._connectWebSocket(response.url);
      this.consecutiveErrors = 0;
    } catch (err) {
      if (err instanceof SlackApiError && err.permanent) {
        this.handlers.onError(err, true);
        this.started = false; // Don't retry permanent failures
        return;
      }
      this.handlers.onError(err as Error, false);
      if (this.started) {
        await this._backoffReconnect();
      }
    }
  }

  private _connectWebSocket(url: string): void {
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.lastEventAt = Date.now();
      this._startHeartbeat();
      this._drainQueue();
      this.handlers.onConnected();
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      this.lastEventAt = Date.now();
      this._handleRawMessage(typeof event.data === 'string' ? event.data : String(event.data));
    });

    this.ws.addEventListener('close', (event: Event & { reason?: string; code?: number }) => {
      this._clearHeartbeat();
      this.ws = null;
      this.handlers.onDisconnected(event.reason || 'connection closed');
      if (this.started) {
        this._backoffReconnect().catch((err) => {
          console.error('[slack-socket] Reconnect failed:', (err as Error).message);
          // Schedule one more attempt after MAX_BACKOFF to avoid permanent death
          if (this.started) {
            setTimeout(() => {
              if (this.started && !this.reconnecting) {
                this._backoffReconnect().catch(() => {});
              }
            }, MAX_BACKOFF_MS);
          }
        });
      }
    });

    this.ws.addEventListener('error', () => {
      // Error event is always followed by close event — handle reconnection there
    });
  }

  private async _handleRawMessage(raw: string): Promise<void> {
    let envelope: SocketModeEnvelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      console.error('[slack-socket] Failed to parse WebSocket message');
      return;
    }


    // Handle disconnect events (no envelope_id to ack)
    if (envelope.type === 'disconnect') {
      const reason = (envelope.payload as Record<string, string>)?.reason
        ?? (envelope as unknown as Record<string, unknown>).reason as string
        ?? 'unknown';
      this._handleDisconnect(reason);
      return;
    }

    // Acknowledge immediately (must be within 3 seconds)
    if (envelope.envelope_id) {
      this.ws?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }

    // Process event with exception guard (post-ack — Slack won't redeliver)
    try {
      if (envelope.type === 'interactive') {
        await this.handlers.onInteraction(envelope.payload);
      } else if (envelope.type === 'events_api') {
        const event = (envelope.payload as Record<string, unknown>).event as Record<string, unknown> | undefined;
        const eventType = event?.type as string ?? 'unknown';
        await this.handlers.onEvent(eventType, envelope.payload);
      }
    } catch (err) {
      console.error('[slack-socket] Event processing failed after ack:', (err as Error).message);
    }
  }

  private _handleDisconnect(reason: string): void {
    this._clearHeartbeat();
    // Prevent close event handler from triggering a second reconnect
    const wasStarted = this.started;
    this.started = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.started = wasStarted;
    this.handlers.onDisconnected(reason);

    if (!this.started) return;

    if (reason === 'refresh_requested') {
      // Slack container rotation — reconnect immediately
      this._openConnection();
    } else if (reason === 'too_many_websockets') {
      // Wait 30s before reconnecting
      setTimeout(() => {
        if (this.started) this._openConnection();
      }, TOO_MANY_WS_DELAY_MS);
    } else {
      this._backoffReconnect();
    }
  }

  private async _backoffReconnect(): Promise<void> {
    if (this.reconnecting || !this.started) return;
    this.reconnecting = true;
    this.consecutiveErrors++;

    // Exponential backoff from first attempt: 1s, 2s, 4s, 8s... max 60s
    const delay = Math.min(1000 * Math.pow(2, this.consecutiveErrors - 1), MAX_BACKOFF_MS);
    await new Promise(r => setTimeout(r, delay));

    this.reconnecting = false;
    if (this.started) {
      await this._openConnection();
    }
  }

  private _startHeartbeat(): void {
    this._clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastEventAt;
      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        console.warn('[slack-socket] No events for 1h — connection presumed dead, reconnecting');
        if (this.ws) {
          this.ws.close();
          this.ws = null;
        }
        // Close event handler will trigger reconnect
      }
    }, HEARTBEAT_TIMEOUT_MS / 2); // Check every 30min
  }

  private _clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private _drainQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    for (const item of this.outboundQueue) {
      this.ws.send(item.data);
    }
    this.outboundQueue = [];
  }
}
