/**
 * ConnectionManager — Manages WebSocket connections from agents.
 *
 * Handles authentication, heartbeat, and connection lifecycle.
 * Part of Threadline Relay Phase 1.
 */

import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import type {
  AgentFingerprint,
  AgentVisibility,
  AuthFrame,
  ChallengeFrame,
  AuthOkFrame,
  AuthErrorFrame,
  PingFrame,
  ErrorFrame,
  DisplacedFrame,
  RelayFrame,
  RelayServerConfig,
} from './types.js';
import { RELAY_ERROR_CODES } from './types.js';
import { verify } from '../ThreadlineCrypto.js';
import type { PresenceRegistry } from './PresenceRegistry.js';
import type { RelayRateLimiter } from './RelayRateLimiter.js';
import type { RegistryStore } from './RegistryStore.js';
import type { RegistryAuth } from './RegistryAuth.js';

interface PendingAuth {
  nonce: string;
  timer: ReturnType<typeof setTimeout>;
  ip: string;
}

interface AgentConnection {
  socket: WebSocket;
  agentId: AgentFingerprint;
  publicKey: Buffer;
  publicKeyBase64: string;
  sessionId: string;
  ip: string;
  missedPongs: number;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
}

export interface ConnectionManagerConfig {
  heartbeatIntervalMs: number;
  heartbeatJitterMs: number;
  authTimeoutMs: number;
  missedPongsBeforeDisconnect: number;
}

export class ConnectionManager {
  private readonly config: ConnectionManagerConfig;
  private readonly presence: PresenceRegistry;
  private readonly rateLimiter: RelayRateLimiter;
  private readonly pending = new Map<WebSocket, PendingAuth>();
  private readonly connections = new Map<AgentFingerprint, AgentConnection>();
  private readonly socketToAgent = new Map<WebSocket, AgentFingerprint>();

  /** Optional registry store for persistent agent profiles */
  registryStore?: RegistryStore;
  /** Optional registry auth for JWT token issuance */
  registryAuth?: RegistryAuth;

  /** Callback when a fully authenticated agent connection is established */
  onAuthenticated?: (agentId: AgentFingerprint, socket: WebSocket) => void;
  /** Callback when an agent disconnects */
  onDisconnected?: (agentId: AgentFingerprint) => void;
  /** Callback when an existing agent is displaced by a new connection */
  onDisplaced?: (agentId: AgentFingerprint, oldSocket: WebSocket) => void;

  constructor(
    config: ConnectionManagerConfig,
    presence: PresenceRegistry,
    rateLimiter: RelayRateLimiter,
  ) {
    this.config = config;
    this.presence = presence;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Get the base64-encoded public key for an agent.
   */
  getPublicKey(agentId: AgentFingerprint): string | undefined {
    return this.connections.get(agentId)?.publicKeyBase64;
  }

  /**
   * Handle a new WebSocket connection.
   * Sends a challenge and waits for auth response.
   */
  handleConnection(socket: WebSocket, ip: string): void {
    // Rate limit auth attempts by IP
    const authCheck = this.rateLimiter.checkAuth(ip);
    if (!authCheck.allowed) {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.RATE_LIMITED,
        message: 'Too many auth attempts',
      });
      socket.close(4029, 'Rate limited');
      return;
    }
    this.rateLimiter.recordAuth(ip);

    // Generate challenge nonce
    const nonce = crypto.randomBytes(32).toString('base64');
    const challenge: ChallengeFrame = { type: 'challenge', nonce };

    // Set auth timeout
    const timer = setTimeout(() => {
      this.pending.delete(socket);
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_TIMEOUT,
        message: 'Authentication timeout',
      });
      socket.close(4008, 'Auth timeout');
    }, this.config.authTimeoutMs);

    this.pending.set(socket, { nonce, timer, ip });
    this.sendFrame(socket, challenge);
  }

  /**
   * Handle an auth response from an agent.
   */
  handleAuth(socket: WebSocket, frame: AuthFrame): boolean {
    const pending = this.pending.get(socket);
    if (!pending) {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_FAILED,
        message: 'No pending challenge',
      });
      return false;
    }

    clearTimeout(pending.timer);
    this.pending.delete(socket);

    // Decode public key — must be raw 32-byte Ed25519 (NOT SPKI DER)
    let publicKey: Buffer;
    try {
      publicKey = Buffer.from(frame.publicKey, 'base64');
    } catch {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_FAILED,
        message: 'Invalid public key — could not base64-decode the publicKey field',
      });
      return false;
    }
    if (publicKey.length !== 32) {
      // Most common new-agent mistake: exporting Ed25519 key as SPKI DER (44 bytes
      // including a 12-byte ASN.1 prefix) or PKCS8 (48 bytes incl. 16-byte prefix).
      const hint =
        publicKey.length === 44
          ? ' Looks like SPKI DER — strip the leading 12 bytes (the ASN.1 prefix) and base64-encode the remaining 32 bytes.'
          : publicKey.length === 48
            ? ' That looks like a PKCS8 private key, not a public key.'
            : ' Expected the raw 32-byte Ed25519 public key, base64-encoded.';
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_FAILED,
        message:
          `Invalid public key — expected raw 32-byte Ed25519, got ${publicKey.length} bytes after base64 decode.` +
          hint +
          ' See https://instar.sh/reference/threadline-protocol/ for the identity format, or use the threadline-starter-kit npm package.',
      });
      return false;
    }

    // Verify fingerprint matches public key
    const expectedFingerprint = publicKey.subarray(0, 16).toString('hex');
    if (frame.agentId !== expectedFingerprint) {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_FAILED,
        message:
          `Agent ID does not match public key. Got agentId="${frame.agentId}" but the first 16 bytes of your public key (hex) are "${expectedFingerprint}". ` +
          'Compute agentId from your publicKey rather than choosing it. See https://instar.sh/reference/threadline-protocol/.',
      });
      return false;
    }

    // Verify signature
    let signature: Buffer;
    try {
      signature = Buffer.from(frame.signature, 'base64');
    } catch {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_FAILED,
        message: 'Invalid signature encoding — signature must be base64-encoded.',
      });
      return false;
    }
    if (signature.length !== 64) {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_FAILED,
        message:
          `Invalid signature length — expected 64 bytes after base64 decode, got ${signature.length}. ` +
          'Sign the raw UTF-8 bytes of the challenge nonce with Ed25519 (no hash).',
      });
      return false;
    }

    const nonceBuffer = Buffer.from(pending.nonce, 'utf-8');
    const valid = verify(publicKey, nonceBuffer, signature);
    if (!valid) {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.AUTH_FAILED,
        message:
          'Signature verification failed. Common causes: (1) signing the wrong nonce — sign the raw UTF-8 bytes of the challenge nonce, not the hex/base64 string; ' +
          '(2) signing with the wrong key — verify your privateKey matches your publicKey; ' +
          '(3) using a hash before signing — Ed25519 signs the message directly. See https://instar.sh/reference/threadline-protocol/.',
      });
      return false;
    }

    // Handle displacement: if this agent is already connected, disconnect the old socket
    const existingConn = this.connections.get(frame.agentId);
    if (existingConn) {
      const displacedFrame: DisplacedFrame = {
        type: 'displaced',
        reason: 'Another device connected with the same identity key',
      };
      this.sendFrame(existingConn.socket, displacedFrame);
      this.removeConnection(existingConn.socket, frame.agentId);
      existingConn.socket.close(4001, 'Displaced by new connection');
      this.onDisplaced?.(frame.agentId, existingConn.socket);
    }

    // Register with presence
    const sessionId = `relay-${crypto.randomBytes(8).toString('hex')}`;
    const visibility: AgentVisibility = frame.visibility ?? 'unlisted';

    try {
      this.presence.register(
        frame.agentId,
        frame.publicKey,
        frame.metadata,
        visibility,
        sessionId,
      );
    } catch (err) {
      this.sendFrame(socket, {
        type: 'auth_error',
        code: RELAY_ERROR_CODES.INTERNAL_ERROR,
        message: err instanceof Error ? err.message : 'Registration failed',
      });
      return false;
    }

    // Store connection
    const connection: AgentConnection = {
      socket,
      agentId: frame.agentId,
      publicKey,
      publicKeyBase64: frame.publicKey,
      sessionId,
      ip: pending.ip,
      missedPongs: 0,
      heartbeatTimer: null,
    };
    this.connections.set(frame.agentId, connection);
    this.socketToAgent.set(socket, frame.agentId);

    // Start heartbeat
    this.startHeartbeat(connection);

    // Handle registry
    const authOk: AuthOkFrame = {
      type: 'auth_ok',
      sessionId,
      heartbeatInterval: this.config.heartbeatIntervalMs,
    };

    if (this.registryStore && this.registryAuth) {
      // Issue JWT token for REST API access
      const tokenInfo = this.registryAuth.issueToken(frame.publicKey);
      authOk.registry_token = tokenInfo.token;
      authOk.registry_token_expires = tokenInfo.expiresAt;

      // Auto-register public agents in persistent registry (survives deploys)
      // Agents with explicit registry config get priority fields; all public agents get listed
      const registryFrameworkVisible = frame.registry?.frameworkVisible ?? true;
      const registryHomepage = frame.registry?.homepage ?? '';

      if (visibility === 'public' || frame.registry?.listed) {
        this.registryStore.upsert({
          publicKey: frame.publicKey,
          agentId: frame.agentId,
          name: frame.metadata.name ?? '',
          bio: frame.metadata.bio ?? '',
          interests: frame.metadata.interests ?? [],
          capabilities: frame.metadata.capabilities ?? [],
          framework: frame.metadata.framework ?? 'unknown',
          frameworkVisible: registryFrameworkVisible,
          homepage: registryHomepage,
          visibility: visibility === 'private' ? 'unlisted' : visibility,
          consentMethod: 'auth_handshake',
        });
        authOk.registry_status = 'listed';
        if (frame.registry?.listed) {
          authOk.registry_notice = 'Your online status and last-seen time are visible to anyone searching the registry.';
        }
      } else {
        // Unlisted/private — update last_seen if entry exists, don't auto-create
        const existing = this.registryStore.getByPublicKey(frame.publicKey);
        if (existing) {
          // Update visibility in case it changed (e.g., was public, now unlisted)
          this.registryStore.upsert({
            publicKey: frame.publicKey,
            agentId: frame.agentId,
            name: frame.metadata.name ?? '',
            bio: frame.metadata.bio ?? '',
            interests: frame.metadata.interests ?? [],
            capabilities: frame.metadata.capabilities ?? [],
            framework: frame.metadata.framework ?? 'unknown',
            frameworkVisible: registryFrameworkVisible,
            homepage: registryHomepage,
            visibility: 'unlisted',
            consentMethod: 'auth_handshake',
          });
          this.registryStore.setOnline(frame.publicKey);
          authOk.registry_status = 'updated';
        } else {
          authOk.registry_status = 'not_listed';
        }
      }
    }

    this.sendFrame(socket, authOk);

    this.onAuthenticated?.(frame.agentId, socket);
    return true;
  }

  /**
   * Handle a pong response from an agent.
   */
  handlePong(socket: WebSocket): void {
    const agentId = this.socketToAgent.get(socket);
    if (!agentId) return;
    const conn = this.connections.get(agentId);
    if (!conn) return;
    conn.missedPongs = 0;
    this.presence.touch(agentId);
  }

  /**
   * Handle socket close/error.
   */
  handleDisconnect(socket: WebSocket): void {
    // Clean up pending auth
    const pending = this.pending.get(socket);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(socket);
    }

    // Clean up authenticated connection
    const agentId = this.socketToAgent.get(socket);
    if (agentId) {
      this.removeConnection(socket, agentId);
      this.onDisconnected?.(agentId);
    }
  }

  /**
   * Get socket for an agent.
   */
  getSocket(agentId: AgentFingerprint): WebSocket | undefined {
    return this.connections.get(agentId)?.socket;
  }

  /**
   * Get agent ID for a socket.
   */
  getAgentId(socket: WebSocket): AgentFingerprint | undefined {
    return this.socketToAgent.get(socket);
  }

  /**
   * Get IP address for an agent.
   */
  getIP(agentId: AgentFingerprint): string {
    return this.connections.get(agentId)?.ip ?? 'unknown';
  }

  /**
   * Check if a socket is authenticated.
   */
  isAuthenticated(socket: WebSocket): boolean {
    return this.socketToAgent.has(socket);
  }

  /**
   * Get total number of active connections.
   */
  get size(): number {
    return this.connections.size;
  }

  /**
   * Destroy all connections and timers.
   */
  destroy(): void {
    for (const [, conn] of this.connections) {
      if (conn.heartbeatTimer) clearTimeout(conn.heartbeatTimer);
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
    }
    this.connections.clear();
    this.socketToAgent.clear();
    this.pending.clear();
  }

  // ── Private ─────────────────────────────────────────────────────

  private startHeartbeat(conn: AgentConnection): void {
    const scheduleNext = () => {
      const jitter = (Math.random() * 2 - 1) * this.config.heartbeatJitterMs;
      const interval = this.config.heartbeatIntervalMs + jitter;

      conn.heartbeatTimer = setTimeout(() => {
        if (conn.missedPongs >= this.config.missedPongsBeforeDisconnect) {
          // Too many missed pongs — disconnect
          this.handleDisconnect(conn.socket);
          conn.socket.close(4000, 'Heartbeat timeout');
          return;
        }

        conn.missedPongs++;
        const ping: PingFrame = {
          type: 'ping',
          timestamp: new Date().toISOString(),
        };
        this.sendFrame(conn.socket, ping);
        scheduleNext();
      }, Math.max(1000, interval));
    };

    scheduleNext();
  }

  private removeConnection(socket: WebSocket, agentId: AgentFingerprint): void {
    const conn = this.connections.get(agentId);
    if (conn?.heartbeatTimer) {
      clearTimeout(conn.heartbeatTimer);
    }

    // Set offline in registry
    if (conn && this.registryStore) {
      this.registryStore.setOffline(conn.publicKeyBase64);
    }

    this.connections.delete(agentId);
    this.socketToAgent.delete(socket);
    this.presence.unregister(agentId);
  }

  private sendFrame(socket: WebSocket, frame: RelayFrame): void {
    if (socket.readyState === 1 /* OPEN */) {
      socket.send(JSON.stringify(frame));
    }
  }
}
