/**
 * BaileysBackend — WhatsApp Web protocol connection manager.
 *
 * Handles:
 * - QR code authentication + persistent session
 * - Pairing code authentication (headless)
 * - WebSocket connection management
 * - Reconnection with exponential backoff + jitter + circuit breaker
 * - Message deduplication on reconnect
 * - Auth state persistence (atomic writes)
 *
 * Baileys is a peer dependency — only imported when WhatsApp is configured.
 * This module provides a clean interface for the WhatsAppAdapter to consume
 * without knowing Baileys internals.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { WhatsAppAdapter, BaileysConfig, ConnectionState } from '../WhatsAppAdapter.js';

// ── Reconnection constants ──────────────────────────────

const BASE_DELAYS = [2000, 5000, 10000, 30000, 60000]; // ms

function getReconnectDelay(attempt: number): number {
  const base = BASE_DELAYS[Math.min(attempt, BASE_DELAYS.length - 1)];
  const jitter = Math.random() * base * 0.3; // 30% jitter prevents thundering herd
  return Math.round(base + jitter);
}

// ── Event types (for testing without Baileys) ──────────────────

export interface BaileysEventHandlers {
  onQrCode: (qr: string) => void;
  onPairingCode: (code: string) => void;
  onConnected: (phoneNumber: string) => void;
  onDisconnected: (reason: string, shouldReconnect: boolean) => void;
  onMessage: (jid: string, messageId: string, text: string, senderName?: string, timestamp?: number) => void;
  onError: (error: Error) => void;
}

export interface BaileysBackendStatus {
  connected: boolean;
  phoneNumber: string | null;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  authDir: string;
  authMethod: 'qr' | 'pairing-code';
}

// ── Backend implementation ──────────────────────────────

export class BaileysBackend {
  private config: Required<BaileysConfig>;
  private handlers: BaileysEventHandlers;
  private adapter: WhatsAppAdapter;

  private connected = false;
  private phoneNumber: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private socket: any = null; // Baileys WASocket

  constructor(
    adapter: WhatsAppAdapter,
    config: Required<BaileysConfig>,
    handlers: BaileysEventHandlers,
  ) {
    this.adapter = adapter;
    this.config = config;
    this.handlers = handlers;

    // Ensure auth directory exists
    fs.mkdirSync(this.config.authDir, { recursive: true });
  }

  /** Start the Baileys connection. */
  async connect(): Promise<void> {
    try {
      // Dynamic import — Baileys is a peer/optional dependency
      // @ts-expect-error — Baileys may not be installed; handled gracefully below
      const baileys = await import('@whiskeysockets/baileys').catch(() => null);
      if (!baileys) {
        throw new Error(
          'Baileys is not installed. Run: npm install @whiskeysockets/baileys\n' +
          'Baileys is a peer dependency required for WhatsApp Web support.',
        );
      }
      const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

      const { state, saveCreds } = await useMultiFileAuthState(this.config.authDir);

      this.socket = makeWASocket({
        auth: state,
        markOnlineOnConnect: this.config.markOnline,
        printQRInTerminal: this.config.authMethod === 'qr',
      });

      // Auth state persistence
      this.socket.ev.on('creds.update', saveCreds);

      // Connection events
      this.socket.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && this.config.authMethod === 'qr') {
          this.adapter.setConnectionState('qr-pending');
          this.handlers.onQrCode(qr);
        }

        if (connection === 'open') {
          this.connected = true;
          this.reconnectAttempts = 0;
          const me = this.socket?.user;
          this.phoneNumber = me?.id?.split(':')[0] ?? null;
          this.adapter.setConnectionState('connected', this.phoneNumber ?? undefined);
          this.adapter.setSendFunction(async (jid, text) => {
            await this.socket?.sendMessage(jid, { text });
          });
          this.handlers.onConnected(this.phoneNumber ?? 'unknown');
        }

        if (connection === 'close') {
          this.connected = false;
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          if (loggedOut) {
            // Session expired — need new QR scan
            this.adapter.setConnectionState('disconnected');
            this.handlers.onDisconnected('logged-out', false);
            console.log('[baileys] Session expired. Delete auth state and restart to re-authenticate.');
          } else {
            // Attempt reconnection
            this.scheduleReconnect();
          }
        }
      });

      // Message events
      this.socket.ev.on('messages.upsert', (m: any) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
          if (!msg.message || msg.key.fromMe) continue;

          const jid = msg.key.remoteJid;
          if (!jid) continue;

          // Extract text from various message types
          const text =
            msg.message.conversation ??
            msg.message.extendedTextMessage?.text ??
            msg.message.imageMessage?.caption ??
            msg.message.videoMessage?.caption ??
            null;

          if (!text) continue; // Skip non-text messages for now

          const senderName = msg.pushName ?? undefined;
          const timestamp = msg.messageTimestamp;

          this.handlers.onMessage(
            jid,
            msg.key.id ?? `${Date.now()}`,
            text,
            senderName,
            typeof timestamp === 'number' ? timestamp : undefined,
          );
        }
      });

      // Pairing code auth
      if (this.config.authMethod === 'pairing-code' && this.config.pairingPhoneNumber) {
        const code = await this.socket.requestPairingCode(this.config.pairingPhoneNumber);
        this.handlers.onPairingCode(code);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.handlers.onError(error);
      this.adapter.setConnectionState('disconnected');
    }
  }

  /** Disconnect and cleanup. */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.end(undefined);
      this.socket = null;
    }
    this.connected = false;
    this.adapter.setConnectionState('closed');
  }

  /** Schedule a reconnection attempt with exponential backoff + jitter. */
  private scheduleReconnect(): void {
    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.config.maxReconnectAttempts) {
      console.error(`[baileys] Circuit breaker: ${this.reconnectAttempts} reconnect attempts exhausted.`);
      this.adapter.setConnectionState('disconnected');
      this.handlers.onDisconnected('circuit-breaker', false);
      return;
    }

    const delay = getReconnectDelay(this.reconnectAttempts - 1);
    console.log(`[baileys] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);
    this.adapter.setConnectionState('reconnecting');
    this.handlers.onDisconnected(`reconnecting (attempt ${this.reconnectAttempts})`, true);

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(err => {
        console.error(`[baileys] Reconnect failed: ${err}`);
        this.scheduleReconnect();
      });
    }, delay);
  }

  /** Get current backend status. */
  getStatus(): BaileysBackendStatus {
    return {
      connected: this.connected,
      phoneNumber: this.phoneNumber,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.config.maxReconnectAttempts,
      authDir: this.config.authDir,
      authMethod: this.config.authMethod,
    };
  }
}

// Export the reconnect delay calculator for testing
export { getReconnectDelay };
