/**
 * RelayClient — WebSocket client for connecting to the Threadline relay.
 *
 * Handles authentication, reconnection, heartbeat, and message routing.
 * Part of Threadline Relay Phase 1.
 */

import { WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { sign } from '../ThreadlineCrypto.js';
import type {
  RelayClientConfig,
  AgentFingerprint,
  ServerFrame,
  MessageEnvelope,
  DiscoverResultFrame,
  PresenceChangeFrame,
  AckFrame,
  ErrorFrame,
} from '../relay/types.js';
import type { IdentityInfo } from './IdentityManager.js';

export interface RelayClientEvents {
  connected: (sessionId: string) => void;
  disconnected: (reason: string) => void;
  displaced: (reason: string) => void;
  message: (envelope: MessageEnvelope) => void;
  ack: (ack: AckFrame) => void;
  error: (error: ErrorFrame) => void;
  'presence-change': (change: PresenceChangeFrame) => void;
  'discover-result': (result: DiscoverResultFrame) => void;
}

type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

export class RelayClient extends EventEmitter {
  private readonly config: Required<RelayClientConfig>;
  private readonly identity: IdentityInfo;
  private socket: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private sessionId: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;
  private heartbeatInterval: number | null = null;

  constructor(config: RelayClientConfig, identity: IdentityInfo) {
    super();
    this.config = {
      relayUrl: config.relayUrl,
      name: config.name,
      framework: config.framework ?? 'unknown',
      capabilities: config.capabilities ?? [],
      version: config.version ?? '1.0.0',
      visibility: config.visibility ?? 'unlisted',
      reconnectInitialMs: config.reconnectInitialMs ?? 1000,
      reconnectMaxMs: config.reconnectMaxMs ?? 60000,
      reconnectJitter: config.reconnectJitter ?? 0.25,
      stateDir: config.stateDir ?? '.',
    };
    this.identity = identity;
  }

  /**
   * Connect to the relay server.
   */
  async connect(): Promise<string> {
    if (this.state === 'connected') return this.sessionId!;
    if (this.state === 'connecting' || this.state === 'authenticating') {
      throw new Error('Already connecting');
    }

    this.shouldReconnect = true;
    return this.doConnect();
  }

  /**
   * Disconnect from the relay server.
   */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close(1000, 'Client disconnect');
      this.socket = null;
    }
    this.state = 'disconnected';
    this.sessionId = null;
  }

  /**
   * Send a message envelope to the relay.
   */
  sendMessage(envelope: MessageEnvelope): void {
    if (this.state !== 'connected' || !this.socket) {
      throw new Error('Not connected to relay');
    }
    this.socket.send(JSON.stringify({ type: 'message', envelope }));
  }

  /**
   * Send an ack for a received message.
   */
  sendAck(messageId: string, status: 'delivered' = 'delivered'): void {
    if (this.state !== 'connected' || !this.socket) return;
    this.socket.send(JSON.stringify({ type: 'ack', messageId, status }));
  }

  /**
   * Discover agents on the relay.
   */
  discover(filter?: { capability?: string; framework?: string; name?: string }): void {
    if (this.state !== 'connected' || !this.socket) {
      throw new Error('Not connected to relay');
    }
    this.socket.send(JSON.stringify({ type: 'discover', filter }));
  }

  /**
   * Subscribe to presence changes.
   */
  subscribe(agentIds?: AgentFingerprint[]): void {
    if (this.state !== 'connected' || !this.socket) {
      throw new Error('Not connected to relay');
    }
    this.socket.send(JSON.stringify({ type: 'subscribe', agentIds }));
  }

  /**
   * Get current connection state.
   */
  get connectionState(): ConnectionState {
    return this.state;
  }

  /**
   * Get the relay session ID.
   */
  get relaySessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Get the agent's fingerprint.
   */
  get fingerprint(): AgentFingerprint {
    return this.identity.fingerprint;
  }

  // ── Private ─────────────────────────────────────────────────────

  private doConnect(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.state = 'connecting';

      try {
        this.socket = new WebSocket(this.config.relayUrl);
      } catch (err) {
        this.state = 'disconnected';
        reject(err);
        return;
      }

      const connectTimeout = setTimeout(() => {
        if (this.state !== 'connected') {
          this.socket?.close();
          reject(new Error('Connection timeout'));
        }
      }, 30_000);

      this.socket.on('open', () => {
        this.state = 'authenticating';
        this.reconnectAttempt = 0;
      });

      this.socket.on('message', (data) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }

        switch (frame.type) {
          case 'challenge':
            this.handleChallenge(frame.nonce);
            break;

          case 'auth_ok':
            clearTimeout(connectTimeout);
            this.state = 'connected';
            this.sessionId = frame.sessionId;
            this.heartbeatInterval = frame.heartbeatInterval;
            this.emit('connected', frame.sessionId);
            resolve(frame.sessionId);
            break;

          case 'auth_error':
            clearTimeout(connectTimeout);
            this.state = 'disconnected';
            // If rate-limited, enforce longer backoff before retrying
            if (frame.message?.includes('Too many') || frame.message?.includes('rate')) {
              this.reconnectAttempt = Math.max(this.reconnectAttempt, 5); // Start at ~32s backoff
            }
            reject(new Error(`Auth failed: ${frame.message}`));
            break;

          case 'message':
            this.emit('message', frame.envelope);
            break;

          case 'ack':
            this.emit('ack', frame);
            break;

          case 'ping':
            this.socket?.send(JSON.stringify({
              type: 'pong',
              timestamp: new Date().toISOString(),
            }));
            break;

          case 'error':
            this.emit('error', frame);
            break;

          case 'discover_result':
            this.emit('discover-result', frame);
            break;

          case 'presence_change':
            this.emit('presence-change', frame);
            break;

          case 'displaced':
            this.shouldReconnect = false;
            this.emit('displaced', frame.reason);
            break;
        }
      });

      this.socket.on('close', (code, reason) => {
        clearTimeout(connectTimeout);
        const wasConnected = this.state === 'connected';
        this.state = 'disconnected';
        this.sessionId = null;

        if (wasConnected) {
          this.emit('disconnected', reason?.toString() ?? `Code: ${code}`);
        }

        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.socket.on('error', (err) => {
        // Error is usually followed by close, so we handle reconnection there
        if (this.state === 'connecting') {
          clearTimeout(connectTimeout);
          this.state = 'disconnected';
          reject(err);
        }
      });
    });
  }

  private handleChallenge(nonce: string): void {
    const nonceBuffer = Buffer.from(nonce, 'utf-8');
    const signature = sign(this.identity.privateKey, nonceBuffer);

    this.socket?.send(JSON.stringify({
      type: 'auth',
      agentId: this.identity.fingerprint,
      publicKey: this.identity.publicKey.toString('base64'),
      signature: signature.toString('base64'),
      metadata: {
        name: this.config.name,
        framework: this.config.framework,
        capabilities: this.config.capabilities,
        version: this.config.version,
      },
      visibility: this.config.visibility,
    }));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const base = Math.min(
      this.config.reconnectInitialMs * Math.pow(2, this.reconnectAttempt),
      this.config.reconnectMaxMs,
    );
    const jitter = base * this.config.reconnectJitter * (Math.random() * 2 - 1);
    const delay = Math.max(100, base + jitter);

    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect().catch(() => {
        // Will trigger another reconnect via close handler
      });
    }, delay);
  }
}
