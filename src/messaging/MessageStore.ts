/**
 * MessageStore — file-based message persistence layer.
 *
 * Per-message JSON files as source of truth with JSONL indexes as derived data.
 * Implements the IMessageStore interface from the Inter-Agent Messaging Spec v3.1.
 *
 * Storage layout:
 *   {basePath}/
 *     store/{messageId}.json        — source of truth per message
 *     index/inbox.jsonl             — derived, rebuilt on startup
 *     index/outbox.jsonl            — derived, rebuilt on startup
 *     dead-letter/{messageId}.json  — expired/failed messages
 *     pending/{messageId}.json      — symlinks to store/ for delivery queue
 *     threads/{threadId}.json       — thread metadata
 *     threads/archive/              — resolved/stale threads
 *     drop/{agentName}/             — cross-agent offline drops
 *     outbound/{machineId}/         — cross-machine offline queue
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  IMessageStore,
  MessageEnvelope,
  MessageThread,
  ThreadStatus,
  DeliveryState,
  MessageFilter,
  MessagingStats,
} from './types.js';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';

const DIRS = ['store', 'index', 'dead-letter', 'pending', 'threads', 'threads/archive', 'drop', 'outbound'];

export class MessageStore implements IMessageStore {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async initialize(): Promise<void> {
    // Create directory structure
    for (const dir of DIRS) {
      fs.mkdirSync(path.join(this.basePath, dir), { recursive: true });
    }
  }

  async save(envelope: MessageEnvelope): Promise<void> {
    const filePath = this.messageFilePath(envelope.message.id);

    // Deduplication — if the message already exists, skip
    if (fs.existsSync(filePath)) {
      return;
    }

    // Atomic write: tmp + rename
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(tmpPath, filePath);

    // Append to index
    this.appendToIndex(envelope);
  }

  async get(messageId: string): Promise<MessageEnvelope | null> {
    const filePath = this.messageFilePath(messageId);
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data) as MessageEnvelope;
    } catch {
      return null;
    }
  }

  async updateDelivery(messageId: string, delivery: DeliveryState): Promise<void> {
    const filePath = this.messageFilePath(messageId);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Message not found: ${messageId}`);
    }

    const data = fs.readFileSync(filePath, 'utf-8');
    const envelope = JSON.parse(data) as MessageEnvelope;
    envelope.delivery = delivery;

    // Atomic write
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Mark many messages as 'undelivered' in chunks, yielding between chunks.
   *
   * Transitions: queued → undelivered, received → undelivered. Messages already
   * in a terminal phase (delivered/read/expired/dead-lettered/failed) or already
   * 'undelivered' are skipped silently. Missing files are skipped silently.
   *
   * Returns the count of messages actually transitioned.
   */
  async markManyUndelivered(messageIds: string[], chunkSize: number = 50): Promise<number> {
    let updated = 0;
    const { VALID_TRANSITIONS } = await import('./types.js');
    const allowedFrom = new Set(
      VALID_TRANSITIONS.filter(([, to]) => to === 'undelivered').map(([from]) => from)
    );

    for (let i = 0; i < messageIds.length; i += chunkSize) {
      const chunk = messageIds.slice(i, i + chunkSize);
      for (const id of chunk) {
        const filePath = this.messageFilePath(id);
        if (!fs.existsSync(filePath)) continue;

        let envelope: MessageEnvelope;
        try {
          envelope = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as MessageEnvelope;
        } catch {
          continue; // Corrupt file; skip rather than crash dispose
        }

        if (!allowedFrom.has(envelope.delivery.phase)) continue;

        const now = new Date().toISOString();
        const transition = {
          from: envelope.delivery.phase,
          to: 'undelivered' as const,
          at: now,
          reason: 'SpawnRequestManager dispose handoff',
        };
        envelope.delivery = {
          ...envelope.delivery,
          phase: 'undelivered',
          transitions: [...envelope.delivery.transitions, transition],
        };

        const tmpPath = filePath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
        fs.renameSync(tmpPath, filePath);
        updated++;
      }
      // Yield between chunks so dispose doesn't block the event loop.
      if (i + chunkSize < messageIds.length) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }

    return updated;
  }

  /**
   * Overwrite a stored envelope entirely.
   * Used after cross-machine routing updates transport fields (signature, relayChain).
   */
  async updateEnvelope(envelope: MessageEnvelope): Promise<void> {
    const filePath = this.messageFilePath(envelope.message.id);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Message not found: ${envelope.message.id}`);
    }

    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  async queryInbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]> {
    const envelopes = this.readAllEnvelopes();

    let results = envelopes.filter(e => {
      // Match messages addressed to this agent (or broadcast)
      const toAgent = e.message.to.agent;
      return toAgent === agentName || toAgent === '*';
    });

    // Apply filters
    if (filter?.type) {
      results = results.filter(e => e.message.type === filter.type);
    }
    if (filter?.priority) {
      results = results.filter(e => e.message.priority === filter.priority);
    }
    if (filter?.unread) {
      results = results.filter(e => e.delivery.phase !== 'read');
    }
    if (filter?.fromAgent) {
      results = results.filter(e => e.message.from.agent === filter.fromAgent);
    }
    if (filter?.threadId) {
      results = results.filter(e => e.message.threadId === filter.threadId);
    }

    // Sort by creation time (newest first)
    results.sort((a, b) =>
      new Date(b.message.createdAt).getTime() - new Date(a.message.createdAt).getTime(),
    );

    // Apply pagination
    if (filter?.offset) {
      results = results.slice(filter.offset);
    }
    if (filter?.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  async queryOutbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]> {
    const envelopes = this.readAllEnvelopes();

    let results = envelopes.filter(e => e.message.from.agent === agentName);

    if (filter?.type) {
      results = results.filter(e => e.message.type === filter.type);
    }
    if (filter?.priority) {
      results = results.filter(e => e.message.priority === filter.priority);
    }
    if (filter?.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  async deadLetter(messageId: string, reason: string): Promise<void> {
    const srcPath = this.messageFilePath(messageId);
    if (!fs.existsSync(srcPath)) {
      return;
    }

    const data = fs.readFileSync(srcPath, 'utf-8');
    const envelope = JSON.parse(data) as MessageEnvelope;

    // Update delivery state
    envelope.delivery.phase = 'dead-lettered';
    envelope.delivery.failureReason = reason;
    envelope.delivery.transitions.push({
      from: envelope.delivery.phase === 'dead-lettered' ? 'failed' : envelope.delivery.phase,
      to: 'dead-lettered',
      at: new Date().toISOString(),
      reason,
    });

    // Write to dead-letter
    const dlPath = path.join(this.basePath, 'dead-letter', `${messageId}.json`);
    fs.writeFileSync(dlPath, JSON.stringify(envelope, null, 2));

    // Remove from store
    // safe-git-allow: incremental-migration
    fs.unlinkSync(srcPath);
  }

  async queryDeadLetters(filter?: MessageFilter): Promise<MessageEnvelope[]> {
    const dlDir = path.join(this.basePath, 'dead-letter');
    if (!fs.existsSync(dlDir)) return [];

    const files = fs.readdirSync(dlDir).filter(f => f.endsWith('.json'));
    let results: MessageEnvelope[] = [];

    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(dlDir, file), 'utf-8');
        results.push(JSON.parse(data) as MessageEnvelope);
      } catch {
        // @silent-fallback-ok — skip corrupted dead-letter files
      }
    }

    // Sort by most recent first
    results.sort((a, b) => {
      const aTime = a.delivery.transitions.at(-1)?.at ?? a.message.createdAt;
      const bTime = b.delivery.transitions.at(-1)?.at ?? b.message.createdAt;
      return bTime.localeCompare(aTime);
    });

    if (filter?.type) {
      results = results.filter(e => e.message.type === filter.type);
    }
    if (filter?.priority) {
      results = results.filter(e => e.message.priority === filter.priority);
    }
    if (filter?.fromAgent) {
      results = results.filter(e => e.message.from.agent === filter.fromAgent);
    }
    if (filter?.limit) {
      const offset = filter.offset ?? 0;
      results = results.slice(offset, offset + filter.limit);
    }

    return results;
  }

  async exists(messageId: string): Promise<boolean> {
    return fs.existsSync(this.messageFilePath(messageId));
  }

  // ── Thread Management ──────────────────────────────────────────

  async saveThread(thread: MessageThread): Promise<void> {
    const filePath = path.join(this.basePath, 'threads', `${thread.id}.json`);
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(thread, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  async getThread(threadId: string): Promise<MessageThread | null> {
    const filePath = path.join(this.basePath, 'threads', `${threadId}.json`);
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data) as MessageThread;
    } catch { // @silent-fallback-ok — thread file not found, check archive
      const archivePath = path.join(this.basePath, 'threads', 'archive', `${threadId}.json`);
      try {
        const data = fs.readFileSync(archivePath, 'utf-8');
        return JSON.parse(data) as MessageThread;
      } catch { // @silent-fallback-ok — thread not found in archive either, return null
        return null;
      }
    }
  }

  async listThreads(status?: ThreadStatus): Promise<MessageThread[]> {
    const threadsDir = path.join(this.basePath, 'threads');
    if (!fs.existsSync(threadsDir)) return [];

    const files = fs.readdirSync(threadsDir).filter(f => f.endsWith('.json'));
    const threads: MessageThread[] = [];

    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(threadsDir, file), 'utf-8');
        const thread = JSON.parse(data) as MessageThread;
        if (!status || thread.status === status) {
          threads.push(thread);
        }
      } catch {
        // @silent-fallback-ok — skip corrupt thread files
      }
    }

    // Sort by most recent activity first
    threads.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    return threads;
  }

  async archiveThread(threadId: string): Promise<void> {
    const srcPath = path.join(this.basePath, 'threads', `${threadId}.json`);
    if (!fs.existsSync(srcPath)) return;

    const destPath = path.join(this.basePath, 'threads', 'archive', `${threadId}.json`);
    fs.renameSync(srcPath, destPath);
  }

  async getStats(): Promise<MessagingStats> {
    const envelopes = this.readAllEnvelopes();
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60_000;
    const oneHrAgo = now - 60 * 60_000;

    const sent = envelopes.filter(e =>
      e.delivery.transitions.some(t => t.to === 'sent'),
    );
    const received = envelopes.filter(e =>
      e.delivery.transitions.some(t => t.to === 'received'),
    );

    const dlDir = path.join(this.basePath, 'dead-letter');
    const dlCount = fs.existsSync(dlDir) ? fs.readdirSync(dlDir).filter(f => f.endsWith('.json')).length : 0;

    return {
      volume: {
        sent: {
          total: sent.length,
          last5min: sent.filter(e => new Date(e.message.createdAt).getTime() > fiveMinAgo).length,
          last1hr: sent.filter(e => new Date(e.message.createdAt).getTime() > oneHrAgo).length,
        },
        received: {
          total: received.length,
          last5min: received.filter(e => new Date(e.message.createdAt).getTime() > fiveMinAgo).length,
          last1hr: received.filter(e => new Date(e.message.createdAt).getTime() > oneHrAgo).length,
        },
        deadLettered: {
          total: dlCount,
          last5min: 0,
          last1hr: 0,
        },
      },
      delivery: {
        avgLatencyMs: { layer1: 0, layer2: 0, layer3: 0 },
        successRate: { layer1: 0, layer2: 0, layer3: 0 },
      },
      rateLimiting: {
        sessionsThrottled: 0,
        circuitBreakers: { open: 0, recentTrips: 0 },
      },
      threads: await this.getThreadStats(),
    };
  }

  async cleanup(): Promise<{ deleted: number; deadLettered: number }> {
    let deleted = 0;
    let deadLettered = 0;

    // Scan dead-letter for files past retention (30 days default)
    const dlDir = path.join(this.basePath, 'dead-letter');
    if (fs.existsSync(dlDir)) {
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60_000;
      for (const file of fs.readdirSync(dlDir)) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(dlDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < thirtyDaysAgo) {
            // safe-git-allow: incremental-migration
            fs.unlinkSync(filePath);
            deleted++;
          }
        } catch {
          // @silent-fallback-ok — best-effort cleanup of expired dead-letter files
        }
      }
    }

    return { deleted, deadLettered };
  }

  async destroy(): Promise<void> {
    // No-op for normal usage; tests use this for cleanup
  }

  // ── Private Helpers ──────────────────────────────────────────────

  private messageFilePath(messageId: string): string {
    return path.join(this.basePath, 'store', `${messageId}.json`);
  }

  private async getThreadStats(): Promise<{ active: number; resolved: number; stale: number }> {
    const threads = await this.listThreads();
    let active = 0, resolved = 0, stale = 0;
    for (const t of threads) {
      if (t.status === 'active') active++;
      else if (t.status === 'resolved') resolved++;
      else if (t.status === 'stale') stale++;
    }
    return { active, resolved, stale };
  }

  private readAllEnvelopes(): MessageEnvelope[] {
    const storeDir = path.join(this.basePath, 'store');
    if (!fs.existsSync(storeDir)) return [];

    const files = fs.readdirSync(storeDir).filter(f => f.endsWith('.json'));
    const envelopes: MessageEnvelope[] = [];

    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(storeDir, file), 'utf-8');
        envelopes.push(JSON.parse(data));
      } catch {
        // Skip corrupt files
      }
    }

    return envelopes;
  }

  private appendToIndex(envelope: MessageEnvelope): void {
    const indexEntry = {
      id: envelope.message.id,
      from: envelope.message.from.agent,
      to: envelope.message.to.agent,
      type: envelope.message.type,
      priority: envelope.message.priority,
      phase: envelope.delivery.phase,
      createdAt: envelope.message.createdAt,
    };

    const inboxPath = path.join(this.basePath, 'index', 'inbox.jsonl');
    const outboxPath = path.join(this.basePath, 'index', 'outbox.jsonl');

    maybeRotateJsonl(outboxPath, { maxBytes: 5 * 1024 * 1024, keepRatio: 0.5 });
    maybeRotateJsonl(inboxPath, { maxBytes: 5 * 1024 * 1024, keepRatio: 0.5 });
    fs.appendFileSync(outboxPath, JSON.stringify(indexEntry) + '\n');
    fs.appendFileSync(inboxPath, JSON.stringify(indexEntry) + '\n');
  }
}
