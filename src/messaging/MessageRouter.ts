/**
 * MessageRouter — message sending, routing, acknowledgment, and relay.
 *
 * The primary entry point for the messaging subsystem. Handles:
 * - Creating and sending messages with proper envelope wrapping
 * - Routing to local, cross-agent (same machine), or cross-machine targets
 * - Default TTL assignment per message type
 * - Thread auto-creation for query/request types
 * - Echo prevention (cannot send to self)
 * - Relay chain loop detection
 * - Deduplication on relay receipt
 * - Delivery state monotonic transitions
 * - Drop-directory fallback for offline agents
 * - Cross-machine relay with Ed25519 signatures and Machine-HMAC auth
 * - Outbound queue for offline cross-machine fallback
 *
 * Routing decision tree (from INTER-AGENT-MESSAGING-SPEC v3.1):
 *   target machine == local?
 *     → Yes: target agent == local agent?
 *       → Yes: deliver locally (no relay needed)
 *       → No: relay via POST /api/messages/relay-agent (Bearer token)
 *              If agent down → write to drop directory with HMAC
 *     → No: target machine paired and online?
 *       → Yes: relay via POST /api/messages/relay-machine (Machine-HMAC + Ed25519)
 *       → No: queue to outbound directory for git-sync fallback
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  IMessageRouter,
  AgentMessage,
  MessageEnvelope,
  MessageFilter,
  MessageThread,
  ThreadStatus,
  MessageType,
  MessagePriority,
  SendMessageOptions,
  SendResult,
  DeliveryState,
  MessagingStats,
  SignedPayload,
} from './types.js';
import { DEFAULT_TTL, VALID_TRANSITIONS, CLOCK_SKEW_TOLERANCE, THREAD_STALE_MINUTES } from './types.js';
import type { MessageStore } from './MessageStore.js';
import type { MessageDelivery } from './MessageDelivery.js';
import { getAgentToken, computeDropHmac } from './AgentTokenManager.js';
import { listAgents } from '../core/AgentRegistry.js';
import type { AgentRegistryEntry } from '../core/types.js';
import type { MachineIdentityManager } from '../core/MachineIdentity.js';
import { sign, verify } from '../core/MachineIdentity.js';
import { signRequest } from '../server/machineAuth.js';
import type { NonceStore } from '../core/NonceStore.js';
import type { SecurityLog } from '../core/SecurityLog.js';

export interface MessageRouterConfig {
  localAgent: string;
  localMachine: string;
  serverUrl: string;
}

/** Optional cross-machine crypto dependencies. Only needed when multi-machine is enabled. */
export interface CrossMachineDeps {
  identityManager: MachineIdentityManager;
  signingKeyPem: string;
  nonceStore: NonceStore;
  securityLog: SecurityLog;
}

export class MessageRouter implements IMessageRouter {
  private readonly store: MessageStore;
  private readonly delivery: MessageDelivery;
  private readonly config: MessageRouterConfig;
  private readonly crossMachine: CrossMachineDeps | null;
  /** Monotonic sequence counter for Machine-HMAC outgoing requests */
  private machineSequence: number = 0;
  /** Optional summary sentinel for intelligent routing */
  private summarySentinel: import('./SessionSummarySentinel.js').SessionSummarySentinel | null = null;

  constructor(
    store: MessageStore,
    delivery: MessageDelivery,
    config: MessageRouterConfig,
    crossMachine?: CrossMachineDeps,
  ) {
    this.store = store;
    this.delivery = delivery;
    this.config = config;
    this.crossMachine = crossMachine ?? null;
  }

  /** Attach a summary sentinel for intelligent routing (session: "best") */
  setSummarySentinel(sentinel: import('./SessionSummarySentinel.js').SessionSummarySentinel): void {
    this.summarySentinel = sentinel;
  }

  async send(
    from: AgentMessage['from'],
    to: AgentMessage['to'],
    type: MessageType,
    priority: MessagePriority,
    subject: string,
    body: string,
    options?: SendMessageOptions,
  ): Promise<SendResult> {
    // Intelligent routing: resolve session: "best" to actual session.
    // Pass `from.session` as an exclusion so the sender's own session is
    // never selected as the target — otherwise a self-to-self match would
    // immediately trip the echo-prevention check below.
    if (to.session === 'best' && this.summarySentinel) {
      const isLocal = to.machine === 'local' || to.machine === this.config.localMachine;
      if (isLocal && to.agent === this.config.localAgent) {
        const scores = this.summarySentinel.findBestSession(subject, body, to.agent, from.session);
        if (scores.length > 0) {
          to = { ...to, session: scores[0].tmuxSession };
        }
        // If no match, keep "best" — it will be queued for the next available session
      }
    }

    // Echo prevention: cannot send to the same session on the same agent
    if (
      from.agent === to.agent &&
      from.session === to.session &&
      (to.machine === 'local' || to.machine === from.machine)
    ) {
      throw new Error('Cannot send a message to the same session (echo prevention)');
    }

    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();
    const ttlMinutes = options?.ttlMinutes ?? DEFAULT_TTL[type];

    // Auto-create thread for query and request types
    let threadId = options?.threadId;
    if (!threadId && (type === 'query' || type === 'request')) {
      threadId = crypto.randomUUID();
    }

    const message: AgentMessage = {
      id: messageId,
      from,
      to,
      type,
      priority,
      subject,
      body,
      createdAt: now,
      ttlMinutes,
      threadId,
      inReplyTo: options?.inReplyTo,
    };

    const envelope: MessageEnvelope = {
      schemaVersion: 1,
      message,
      transport: {
        relayChain: [],
        originServer: this.config.serverUrl,
        nonce: `${crypto.randomUUID()}:${now}`,
        timestamp: now,
      },
      delivery: {
        phase: 'sent',
        transitions: [
          { from: 'created', to: 'sent', at: now },
        ],
        attempts: 0,
      },
    };

    // Save to local store (outbox)
    await this.store.save(envelope);

    // Track thread if message has a threadId
    if (threadId) {
      await this.updateThread(threadId, message);
    }

    // Route the message based on target
    const isLocalMachine = to.machine === 'local' || to.machine === this.config.localMachine;
    const isLocalAgent = to.agent === this.config.localAgent;

    if (isLocalMachine && !isLocalAgent) {
      // Cross-agent, same machine → relay via HTTP or drop directory
      await this.routeCrossAgentLocal(envelope);
    } else if (!isLocalMachine) {
      // Cross-machine → relay via HTTP with Ed25519 or queue to outbound
      await this.routeCrossMachine(envelope);
    }
    // If isLocalMachine && isLocalAgent → already saved locally, delivery is handled
    // by the local agent's session delivery mechanism

    return {
      messageId,
      threadId,
      phase: envelope.delivery.phase,
    };
  }

  async acknowledge(messageId: string, sessionId: string): Promise<void> {
    const envelope = await this.store.get(messageId);
    if (!envelope) return;

    // Validate transition: must be at 'delivered' to advance to 'read'
    if (!this.isValidTransition(envelope.delivery.phase, 'read')) {
      return;
    }

    const now = new Date().toISOString();
    const delivery: DeliveryState = {
      ...envelope.delivery,
      phase: 'read',
      transitions: [
        ...envelope.delivery.transitions,
        { from: envelope.delivery.phase, to: 'read', at: now, reason: `ack by ${sessionId}` },
      ],
    };

    await this.store.updateDelivery(messageId, delivery);
  }

  async relay(envelope: MessageEnvelope, source: 'agent' | 'machine'): Promise<boolean> {
    // Loop prevention: check if our machine is already in the relay chain
    if (envelope.transport.relayChain.includes(this.config.localMachine)) {
      return false;
    }

    // Deduplication: if message already exists, return ACK but don't re-store
    if (await this.store.exists(envelope.message.id)) {
      return true;
    }

    // Cross-machine relay requires Ed25519 signature verification
    if (source === 'machine') {
      if (!this.crossMachine) {
        return false; // Cross-machine not enabled
      }
      const verifyResult = this.verifyEnvelopeSignature(envelope);
      if (!verifyResult.valid) {
        this.crossMachine.securityLog.append({
          event: 'relay_signature_invalid',
          reason: verifyResult.reason,
          messageId: envelope.message.id,
          signedBy: envelope.transport.signedBy ?? 'unknown',
        });
        return false;
      }
    }

    // Update delivery phase to 'received'
    const now = new Date().toISOString();
    envelope.delivery = {
      phase: 'received',
      transitions: [
        ...envelope.delivery.transitions,
        { from: envelope.delivery.phase, to: 'received', at: now },
      ],
      attempts: 0,
    };

    await this.store.save(envelope);
    return true;
  }

  async getMessage(messageId: string): Promise<MessageEnvelope | null> {
    return this.store.get(messageId);
  }

  async getInbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]> {
    return this.store.queryInbox(agentName, filter);
  }

  async getOutbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]> {
    return this.store.queryOutbox(agentName, filter);
  }

  async getDeadLetters(filter?: MessageFilter): Promise<MessageEnvelope[]> {
    return this.store.queryDeadLetters(filter);
  }

  // ── Thread Management ──────────────────────────────────────────

  async getThread(threadId: string): Promise<{ thread: MessageThread; messages: MessageEnvelope[] } | null> {
    const thread = await this.store.getThread(threadId);
    if (!thread) return null;

    // Fetch all messages in the thread
    const messages: MessageEnvelope[] = [];
    for (const msgId of thread.messageIds) {
      const env = await this.store.get(msgId);
      if (env) messages.push(env);
    }

    // Check staleness
    if (thread.status === 'active') {
      const lastActivity = new Date(thread.lastMessageAt).getTime();
      const staleThreshold = Date.now() - THREAD_STALE_MINUTES * 60_000;
      if (lastActivity < staleThreshold) {
        thread.status = 'stale';
        await this.store.saveThread(thread);
      }
    }

    return { thread, messages };
  }

  async listThreads(status?: ThreadStatus): Promise<MessageThread[]> {
    const threads = await this.store.listThreads(status);

    // Check staleness for active threads
    const now = Date.now();
    const staleThreshold = now - THREAD_STALE_MINUTES * 60_000;
    for (const thread of threads) {
      if (thread.status === 'active') {
        const lastActivity = new Date(thread.lastMessageAt).getTime();
        if (lastActivity < staleThreshold) {
          thread.status = 'stale';
          await this.store.saveThread(thread);
        }
      }
    }

    // Re-filter if status was specified (stale threads may have just changed)
    if (status) {
      return threads.filter(t => t.status === status);
    }
    return threads;
  }

  async resolveThread(threadId: string): Promise<void> {
    const thread = await this.store.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);

    thread.status = 'resolved';
    await this.store.saveThread(thread);
    await this.store.archiveThread(threadId);
  }

  private async updateThread(threadId: string, message: AgentMessage): Promise<void> {
    const now = message.createdAt;
    let thread = await this.store.getThread(threadId);

    if (!thread) {
      // Create new thread
      thread = {
        id: threadId,
        subject: message.subject,
        participants: [{
          agent: message.from.agent,
          session: message.from.session,
          joinedAt: now,
          lastMessageAt: now,
        }],
        createdAt: now,
        lastMessageAt: now,
        messageCount: 1,
        status: 'active',
        messageIds: [message.id],
      };
    } else {
      // Update existing thread
      thread.lastMessageAt = now;
      thread.messageCount++;
      thread.messageIds.push(message.id);

      // Un-stale a thread if a new message arrives
      if (thread.status === 'stale') {
        thread.status = 'active';
      }

      // Add or update participant
      const participant = thread.participants.find(
        p => p.agent === message.from.agent && p.session === message.from.session,
      );
      if (participant) {
        participant.lastMessageAt = now;
      } else {
        thread.participants.push({
          agent: message.from.agent,
          session: message.from.session,
          joinedAt: now,
          lastMessageAt: now,
        });
      }
    }

    await this.store.saveThread(thread);
  }

  async getStats(): Promise<MessagingStats> {
    return this.store.getStats();
  }

  // ── Routing: Cross-Agent Same-Machine ───────────────────────────

  /**
   * Route a message to a different agent on the same machine.
   *
   * Resolution order (per spec §Cross-Agent Resolution):
   * 1. Look up target agent in ~/.instar/registry.json
   * 2. Verify agent is running (PID alive + server responds to health)
   * 3. Forward via POST http://localhost:{port}/messages/relay-agent
   *    with Bearer token from ~/.instar/agent-tokens/{agentName}.token
   * 4. If agent server is down → write to drop directory with HMAC
   */
  private async routeCrossAgentLocal(envelope: MessageEnvelope): Promise<void> {
    const targetAgent = envelope.message.to.agent;

    // Look up target agent in registry
    const agents = listAgents({ status: 'running' });
    const targetEntry = agents.find(a => a.name === targetAgent);

    if (!targetEntry) {
      // Agent not registered — drop to filesystem
      await this.dropMessage(envelope, targetAgent, 'agent not registered');
      return;
    }

    // Try HTTP relay first
    const relaySuccess = await this.relayToAgent(envelope, targetEntry);
    if (relaySuccess) {
      // Update delivery phase to 'received' (both store and in-memory envelope)
      const now = new Date().toISOString();
      envelope.delivery = {
        ...envelope.delivery,
        phase: 'received',
        transitions: [
          ...envelope.delivery.transitions,
          { from: 'sent', to: 'received', at: now, reason: `relayed to ${targetAgent}` },
        ],
        attempts: envelope.delivery.attempts + 1,
      };
      await this.store.updateDelivery(envelope.message.id, envelope.delivery);
      return;
    }

    // HTTP relay failed — fall back to drop directory
    await this.dropMessage(envelope, targetAgent, 'relay failed (agent server unreachable)');
  }

  /**
   * Relay an envelope to another agent's server via HTTP.
   * Returns true if the target accepted the message.
   */
  private async relayToAgent(envelope: MessageEnvelope, target: AgentRegistryEntry): Promise<boolean> {
    // Read target agent's token for Bearer auth
    const targetToken = getAgentToken(target.name);
    if (!targetToken) {
      return false; // No token — can't authenticate
    }

    try {
      const url = `http://localhost:${target.port}/messages/relay-agent`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${targetToken}`,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(5000),
      });

      return response.ok;
    } catch {
      // @silent-fallback-ok — network failure, will fall back to drop directory
      return false;
    }
  }

  /**
   * Write a message to the drop directory for offline pickup.
   * The drop is HMAC-signed with the sender's token for tamper protection.
   *
   * Drop path: ~/.instar/messages/drop/{targetAgentName}/{messageId}.json
   */
  private async dropMessage(
    envelope: MessageEnvelope,
    targetAgent: string,
    reason: string,
  ): Promise<void> {
    const dropDir = path.join(os.homedir(), '.instar', 'messages', 'drop', targetAgent);
    fs.mkdirSync(dropDir, { recursive: true });

    // Compute HMAC with sender's token
    const senderToken = getAgentToken(this.config.localAgent);
    if (senderToken) {
      const hmac = computeDropHmac(senderToken, {
        message: envelope.message,
        originServer: envelope.transport.originServer,
        nonce: envelope.transport.nonce,
        timestamp: envelope.transport.timestamp,
      });
      envelope.transport.hmac = hmac;
      envelope.transport.hmacBy = this.config.localAgent;
    }

    // Update delivery phase to 'queued' (awaiting pickup)
    const now = new Date().toISOString();
    envelope.delivery = {
      ...envelope.delivery,
      phase: 'queued',
      transitions: [
        ...envelope.delivery.transitions,
        { from: envelope.delivery.phase, to: 'queued', at: now, reason: `drop: ${reason}` },
      ],
      attempts: envelope.delivery.attempts + 1,
    };

    // Write envelope to drop directory
    const dropPath = path.join(dropDir, `${envelope.message.id}.json`);
    fs.writeFileSync(dropPath, JSON.stringify(envelope, null, 2), { encoding: 'utf-8' });

    // Also update local store
    await this.store.updateDelivery(envelope.message.id, envelope.delivery);
  }

  // ── Routing: Cross-Machine ─────────────────────────────────────

  /**
   * Route a message to a different machine.
   *
   * Flow (per spec §Cross-Machine):
   * 1. Verify cross-machine deps are available
   * 2. Verify target machine is paired and active
   * 3. Resolve target machine URL
   * 4. Add self to relay chain (before signing — relayChain is part of SignedPayload)
   * 5. Sign envelope with Ed25519
   * 6. Forward via POST relay-machine with Machine-HMAC headers
   * 7. If relay fails → queue to outbound directory for git-sync fallback
   */
  private async routeCrossMachine(envelope: MessageEnvelope): Promise<void> {
    const targetMachine = envelope.message.to.machine;

    if (!this.crossMachine) {
      // Cross-machine not enabled — queue for later
      await this.queueOutbound(envelope, targetMachine, 'cross-machine not enabled');
      return;
    }

    const { identityManager } = this.crossMachine;

    // Verify target machine is paired and active
    if (!identityManager.isMachineActive(targetMachine)) {
      const now = new Date().toISOString();
      envelope.delivery = {
        ...envelope.delivery,
        phase: 'failed',
        transitions: [
          ...envelope.delivery.transitions,
          { from: envelope.delivery.phase, to: 'failed', at: now, reason: `target machine ${targetMachine} not active or unknown` },
        ],
        failureReason: `target machine ${targetMachine} not active or unknown`,
      };
      await this.store.updateDelivery(envelope.message.id, envelope.delivery);
      return;
    }

    // Resolve target machine URL
    const targetUrl = identityManager.getMachineUrl(targetMachine);
    if (!targetUrl) {
      // No URL known — queue for git-sync
      await this.queueOutbound(envelope, targetMachine, 'no URL known for target machine');
      return;
    }

    // Add self to relay chain before signing (relayChain is part of SignedPayload)
    envelope.transport.relayChain.push(this.config.localMachine);

    // Sign envelope with Ed25519
    this.signEnvelope(envelope);

    // Try HTTP relay
    const relaySuccess = await this.relayToMachine(envelope, targetUrl);
    if (relaySuccess) {
      const now = new Date().toISOString();
      envelope.delivery = {
        ...envelope.delivery,
        phase: 'received',
        transitions: [
          ...envelope.delivery.transitions,
          { from: 'sent', to: 'received', at: now, reason: `relayed to machine ${targetMachine}` },
        ],
        attempts: envelope.delivery.attempts + 1,
      };
      // Persist the full envelope (transport was updated with signature + relayChain)
      await this.store.updateEnvelope(envelope);
      return;
    }

    // HTTP relay failed — queue to outbound for git-sync
    await this.queueOutbound(envelope, targetMachine, 'relay failed (machine unreachable)');
  }

  /**
   * Sign a message envelope with this machine's Ed25519 key.
   * Sets transport.signature and transport.signedBy.
   *
   * Signature covers the canonical JSON of the SignedPayload:
   * { message, relayChain, originServer, nonce, timestamp }
   */
  private signEnvelope(envelope: MessageEnvelope): void {
    if (!this.crossMachine) return;

    const signedPayload: SignedPayload = {
      message: envelope.message,
      relayChain: envelope.transport.relayChain,
      originServer: envelope.transport.originServer,
      nonce: envelope.transport.nonce,
      timestamp: envelope.transport.timestamp,
    };

    const canonical = canonicalJSON(signedPayload);
    envelope.transport.signature = sign(canonical, this.crossMachine.signingKeyPem);
    envelope.transport.signedBy = this.config.localMachine;
  }

  /**
   * Public signature verification for git-sync inbound messages.
   * Skips clock skew check (per spec: git-sync has no timestamp check).
   */
  verifyInboundSignature(envelope: MessageEnvelope): { valid: true } | { valid: false; reason: string } {
    return this.verifyEnvelopeSignature(envelope, { skipClockSkew: true });
  }

  /**
   * Verify the Ed25519 signature on an incoming cross-machine envelope.
   * Checks: signature present, signer is active, clock skew within tolerance, signature valid.
   */
  private verifyEnvelopeSignature(
    envelope: MessageEnvelope,
    options?: { skipClockSkew?: boolean },
  ): { valid: true } | { valid: false; reason: string } {
    if (!this.crossMachine) {
      return { valid: false, reason: 'cross-machine not enabled' };
    }

    const { identityManager } = this.crossMachine;

    // Signature must be present
    if (!envelope.transport.signature || !envelope.transport.signedBy) {
      return { valid: false, reason: 'missing signature or signedBy' };
    }

    // Signer must be a known, active machine
    if (!identityManager.isMachineActive(envelope.transport.signedBy)) {
      return { valid: false, reason: `signer ${envelope.transport.signedBy} not active or unknown` };
    }

    // Clock skew check for real-time relay (skipped for git-sync per spec)
    const tolerance = CLOCK_SKEW_TOLERANCE['relay-machine'];
    if (tolerance != null && !options?.skipClockSkew) {
      const envelopeTime = new Date(envelope.transport.timestamp).getTime();
      const skew = Math.abs(Date.now() - envelopeTime);
      if (skew > tolerance) {
        return { valid: false, reason: `timestamp skew ${Math.round(skew / 1000)}s exceeds ${tolerance / 1000}s tolerance` };
      }
    }

    // Get signer's public key
    const publicKeyPem = identityManager.getSigningPublicKeyPem(envelope.transport.signedBy);
    if (!publicKeyPem) {
      return { valid: false, reason: `public key not found for ${envelope.transport.signedBy}` };
    }

    // Reconstruct and verify the SignedPayload
    const signedPayload: SignedPayload = {
      message: envelope.message,
      relayChain: envelope.transport.relayChain,
      originServer: envelope.transport.originServer,
      nonce: envelope.transport.nonce,
      timestamp: envelope.transport.timestamp,
    };

    const canonical = canonicalJSON(signedPayload);
    try {
      const isValid = verify(canonical, envelope.transport.signature, publicKeyPem);
      if (!isValid) {
        return { valid: false, reason: 'signature verification failed' };
      }
    } catch (err) {
      // @silent-fallback-ok — returns structured error with reason; caller handles validation failure
      return { valid: false, reason: `signature error: ${err instanceof Error ? err.message : String(err)}` };
    }

    return { valid: true };
  }

  /**
   * Relay an envelope to a remote machine via HTTP.
   * Uses Machine-HMAC (5-header scheme) for transport auth.
   * The envelope itself carries Ed25519 signature for message integrity.
   */
  private async relayToMachine(envelope: MessageEnvelope, targetUrl: string): Promise<boolean> {
    if (!this.crossMachine) return false;

    try {
      const sequence = this.machineSequence++;
      const machineHeaders = signRequest(
        this.config.localMachine,
        this.crossMachine.signingKeyPem,
        envelope,
        sequence,
      );

      const url = `${targetUrl}/messages/relay-machine`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...machineHeaders,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(10_000), // Cross-machine gets longer timeout
      });

      return response.ok;
    } catch {
      // @silent-fallback-ok — network failure, will fall back to outbound queue
      return false;
    }
  }

  /**
   * Queue a message in the outbound directory for offline cross-machine delivery.
   * These are picked up by git-sync or on next machine connection.
   *
   * Outbound path: ~/.instar/messages/outbound/{targetMachineId}/{messageId}.json
   */
  private async queueOutbound(
    envelope: MessageEnvelope,
    targetMachine: string,
    reason: string,
  ): Promise<void> {
    const outboundDir = path.join(os.homedir(), '.instar', 'messages', 'outbound', targetMachine);
    fs.mkdirSync(outboundDir, { recursive: true });

    // Sign envelope if not already signed (outbound messages need signatures for git-sync verification)
    if (!envelope.transport.signature && this.crossMachine) {
      envelope.transport.relayChain.push(this.config.localMachine);
      this.signEnvelope(envelope);
    }

    // Update delivery phase to 'queued'
    const now = new Date().toISOString();
    envelope.delivery = {
      ...envelope.delivery,
      phase: 'queued',
      transitions: [
        ...envelope.delivery.transitions,
        { from: envelope.delivery.phase, to: 'queued', at: now, reason: `outbound: ${reason}` },
      ],
      attempts: envelope.delivery.attempts + 1,
    };

    // Write envelope to outbound directory
    const outboundPath = path.join(outboundDir, `${envelope.message.id}.json`);
    fs.writeFileSync(outboundPath, JSON.stringify(envelope, null, 2), { encoding: 'utf-8' });

    // Update local store
    await this.store.updateDelivery(envelope.message.id, envelope.delivery);
  }

  // ── Private Helpers ──────────────────────────────────────────────

  private isValidTransition(from: string, to: string): boolean {
    return VALID_TRANSITIONS.some(([f, t]) => f === from && t === to);
  }
}

// ── Canonical JSON (RFC 8785 / JCS) ──────────────────────────────────

/**
 * Serialize an object to canonical JSON per RFC 8785.
 *
 * Rules:
 * - Object keys sorted lexicographically (Unicode code point order)
 * - No insignificant whitespace
 * - Applied recursively to all nested objects
 * - Arrays preserve element order
 * - Primitive values use standard JSON serialization
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map(item => canonicalJSON(item));
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`);
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(value);
}
