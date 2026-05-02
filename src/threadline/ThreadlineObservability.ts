/**
 * ThreadlineObservability — read-only views over the canonical threadline
 * inbox + outbox + bridge bindings, powering the dashboard "Threadline" tab.
 *
 * Sources of truth (single source per class of data — no duplication):
 *   - .instar/threadline/inbox.jsonl.active   — every inbound message (PR #113).
 *   - .instar/threadline/outbox.jsonl.active  — every outbound message (this PR).
 *   - .instar/threadline/telegram-bridge-bindings.json — thread → topic links (PR #117).
 *   - .instar/threadline/known-agents.json     — fingerprint → display name.
 *
 * This class is **observational only** — it reads files, computes summaries,
 * and answers queries. It never writes, mutates, blocks, or gates.
 *
 * Performance: reads are lazy and stream-friendly. The inbox and outbox
 * files are append-only JSONL, so we do a full-file scan with line parsing
 * on every query. For agents with millions of messages this becomes
 * slow — at that point the right answer is to add an FTS5 index, but
 * today every agent in production has <10K threadline messages and
 * sub-100ms scans are fine.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TelegramBridgeBinding } from './TelegramBridge.js';

export interface ThreadlineMessageRow {
  /** "in" or "out" — direction relative to this agent. */
  direction: 'in' | 'out';
  id: string;
  timestamp: string;
  threadId: string;
  /** Counterparty agent — for inbound this is the sender; for outbound the recipient. */
  remoteAgent: string;
  /** Display name of the counterparty (resolved from known-agents.json when possible). */
  remoteAgentName: string;
  text: string;
  /** Trust level of the inbound sender, or 'self' for outbound. */
  trustLevel: string;
  outcome?: string;
}

export interface ThreadSummary {
  threadId: string;
  remoteAgent: string;
  remoteAgentName: string;
  messageCount: number;
  inboundCount: number;
  outboundCount: number;
  firstSeen: string;
  lastSeen: string;
  /** Average ms latency between an inbound message and the next outbound on the same thread. Null when no pair. */
  avgResponseLatencyMs: number | null;
  bridge: { topicId: number; topicName: string; createdAt: string; lastMessageAt: string } | null;
  /** Whether a spawn-session record exists for this thread (heuristic). */
  hasSpawnedSession: boolean;
}

export interface ThreadDetail extends ThreadSummary {
  messages: ThreadlineMessageRow[];
}

export interface SearchHit {
  message: ThreadlineMessageRow;
  /** Snippet around the match, with the matched substring marked between «» (Telegraph-style). */
  snippet: string;
}

export interface ThreadlineObservabilityOptions {
  stateDir: string;
}

interface RawInboxEntry {
  id: string;
  timestamp: string;
  from: string;
  senderName: string;
  trustLevel: string;
  threadId: string;
  text: string;
  hmac?: string;
  // Outbox-only fields:
  to?: string;
  recipientName?: string;
  outcome?: string;
}

interface KnownAgentsFile {
  agents?: Array<{ name?: string; publicKey?: string; fingerprint?: string }>;
}

interface BridgeBindingsFile {
  version?: number;
  bindings?: TelegramBridgeBinding[];
}

interface ThreadResumeFile {
  [threadId: string]: unknown;
}

export class ThreadlineObservability {
  private readonly stateDir: string;
  private nameCache: Map<string, string> | null = null; // fingerprint → display name
  private nameCacheReadAt = 0;

  constructor(opts: ThreadlineObservabilityOptions) {
    this.stateDir = opts.stateDir;
  }

  // ── Public API ─────────────────────────────────────────────────

  listThreads(filters?: {
    remoteAgent?: string;
    sinceIso?: string;
    untilIso?: string;
    /** "yes" → only threads with a Telegram topic; "no" → only without; undefined → both. */
    hasTopic?: 'yes' | 'no';
  }): ThreadSummary[] {
    const inbox = this.readJsonl(this.inboxPath());
    const outbox = this.readJsonl(this.outboxPath());
    const bindings = this.loadBindings();
    const resume = this.loadThreadResume();

    const byThread = new Map<string, { in: RawInboxEntry[]; out: RawInboxEntry[] }>();
    for (const entry of inbox) {
      if (!entry.threadId) continue;
      const slot = byThread.get(entry.threadId) ?? { in: [], out: [] };
      slot.in.push(entry);
      byThread.set(entry.threadId, slot);
    }
    for (const entry of outbox) {
      if (!entry.threadId) continue;
      const slot = byThread.get(entry.threadId) ?? { in: [], out: [] };
      slot.out.push(entry);
      byThread.set(entry.threadId, slot);
    }

    const summaries: ThreadSummary[] = [];
    for (const [threadId, slot] of byThread) {
      const allTimes = [...slot.in.map(e => e.timestamp), ...slot.out.map(e => e.timestamp)].sort();
      if (allTimes.length === 0) continue;

      const firstSeen = allTimes[0]!;
      const lastSeen = allTimes[allTimes.length - 1]!;
      // Counterparty: inbound senders > outbound recipients > unknown
      const counterpartyId =
        slot.in[0]?.from
        ?? slot.out[0]?.to
        ?? '(unknown)';
      // Prefer the senderName/recipientName the message itself carried;
      // fall back to known-agents.json lookup when the message-side name
      // is missing.
      const inlineName = slot.in[0]?.senderName || slot.out[0]?.recipientName;
      const counterpartyName = inlineName && inlineName.length > 0
        ? inlineName
        : this.resolveAgentName(counterpartyId);

      const binding = bindings.get(threadId) ?? null;
      const hasSpawnedSession = !!resume[threadId];

      const avgLatency = this.computeAvgResponseLatencyMs(slot.in, slot.out);

      summaries.push({
        threadId,
        remoteAgent: counterpartyId,
        remoteAgentName: counterpartyName,
        messageCount: slot.in.length + slot.out.length,
        inboundCount: slot.in.length,
        outboundCount: slot.out.length,
        firstSeen,
        lastSeen,
        avgResponseLatencyMs: avgLatency,
        bridge: binding
          ? { topicId: binding.topicId, topicName: binding.topicName, createdAt: binding.createdAt, lastMessageAt: binding.lastMessageAt }
          : null,
        hasSpawnedSession,
      });
    }

    // Apply filters
    let filtered = summaries;
    if (filters?.remoteAgent) {
      const needle = filters.remoteAgent.toLowerCase();
      filtered = filtered.filter(t =>
        t.remoteAgent.toLowerCase().includes(needle) || t.remoteAgentName.toLowerCase().includes(needle));
    }
    if (filters?.sinceIso) {
      filtered = filtered.filter(t => t.lastSeen >= filters.sinceIso!);
    }
    if (filters?.untilIso) {
      filtered = filtered.filter(t => t.firstSeen <= filters.untilIso!);
    }
    if (filters?.hasTopic === 'yes') {
      filtered = filtered.filter(t => t.bridge !== null);
    } else if (filters?.hasTopic === 'no') {
      filtered = filtered.filter(t => t.bridge === null);
    }

    // Sort: most recent activity first
    filtered.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    return filtered;
  }

  getThread(threadId: string): ThreadDetail | null {
    const summaries = this.listThreads();
    const summary = summaries.find(t => t.threadId === threadId);
    if (!summary) return null;

    const inbox = this.readJsonl(this.inboxPath()).filter(e => e.threadId === threadId);
    const outbox = this.readJsonl(this.outboxPath()).filter(e => e.threadId === threadId);

    const messages: ThreadlineMessageRow[] = [
      ...inbox.map(e => this.mapInbound(e)),
      ...outbox.map(e => this.mapOutbound(e)),
    ];
    messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return { ...summary, messages };
  }

  searchMessages(query: string, limit = 50): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const inbox = this.readJsonl(this.inboxPath());
    const outbox = this.readJsonl(this.outboxPath());

    const all: ThreadlineMessageRow[] = [
      ...inbox.map(e => this.mapInbound(e)),
      ...outbox.map(e => this.mapOutbound(e)),
    ];
    all.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    const needle = q.toLowerCase();
    const hits: SearchHit[] = [];
    for (const m of all) {
      const idx = m.text.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      hits.push({ message: m, snippet: makeSnippet(m.text, idx, q.length) });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  // ── Internals ──────────────────────────────────────────────────

  private inboxPath(): string {
    return path.join(this.stateDir, 'threadline', 'inbox.jsonl.active');
  }
  private outboxPath(): string {
    return path.join(this.stateDir, 'threadline', 'outbox.jsonl.active');
  }
  private bindingsPath(): string {
    return path.join(this.stateDir, 'threadline', 'telegram-bridge-bindings.json');
  }
  private knownAgentsPath(): string {
    return path.join(this.stateDir, 'threadline', 'known-agents.json');
  }
  private threadResumePath(): string {
    return path.join(this.stateDir, 'threadline', 'thread-resume-map.json');
  }

  private readJsonl(filePath: string): RawInboxEntry[] {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const out: RawInboxEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as RawInboxEntry);
      } catch {
        // skip malformed
      }
    }
    return out;
  }

  private loadBindings(): Map<string, TelegramBridgeBinding> {
    const map = new Map<string, TelegramBridgeBinding>();
    const file = this.bindingsPath();
    if (!fs.existsSync(file)) return map;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as BridgeBindingsFile;
      for (const b of parsed.bindings ?? []) {
        if (b.threadId) map.set(b.threadId, b);
      }
    } catch { /* ignore */ }
    return map;
  }

  private loadThreadResume(): ThreadResumeFile {
    const file = this.threadResumePath();
    if (!fs.existsSync(file)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // ThreadResumeMap structure varies; accept any keyed map at the top level.
      if (parsed && typeof parsed === 'object' && parsed.threads && typeof parsed.threads === 'object') {
        return parsed.threads as ThreadResumeFile;
      }
      if (parsed && typeof parsed === 'object') return parsed as ThreadResumeFile;
    } catch { /* ignore */ }
    return {};
  }

  private resolveAgentName(idOrName: string): string {
    if (!idOrName) return '(unknown)';
    // Cheap cache: re-read only when stale (mtime changed). For simplicity
    // re-read every minute in the absence of an mtime-watch.
    const STALE_MS = 60_000;
    if (!this.nameCache || Date.now() - this.nameCacheReadAt > STALE_MS) {
      this.nameCache = this.loadKnownAgentsCache();
      this.nameCacheReadAt = Date.now();
    }
    const cached = this.nameCache.get(idOrName);
    if (cached) return cached;
    // Try fingerprint prefix match
    for (const [k, v] of this.nameCache) {
      if (k.startsWith(idOrName) || idOrName.startsWith(k)) return v;
    }
    // Fingerprint-looking → first 8 chars; else the value itself
    if (/^[a-f0-9]{16,}$/i.test(idOrName)) return idOrName.slice(0, 8);
    return idOrName;
  }

  private loadKnownAgentsCache(): Map<string, string> {
    const map = new Map<string, string>();
    const file = this.knownAgentsPath();
    if (!fs.existsSync(file)) return map;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as KnownAgentsFile | KnownAgentsFile['agents'];
      const list = Array.isArray(parsed) ? parsed : (parsed?.agents ?? []);
      for (const a of list) {
        const id = a.publicKey || a.fingerprint;
        if (id && a.name) map.set(id, a.name);
      }
    } catch { /* ignore */ }
    return map;
  }

  private mapInbound(e: RawInboxEntry): ThreadlineMessageRow {
    return {
      direction: 'in',
      id: e.id,
      timestamp: e.timestamp,
      threadId: e.threadId,
      remoteAgent: e.from,
      remoteAgentName: e.senderName || this.resolveAgentName(e.from),
      text: e.text,
      trustLevel: e.trustLevel,
    };
  }

  private mapOutbound(e: RawInboxEntry): ThreadlineMessageRow {
    return {
      direction: 'out',
      id: e.id,
      timestamp: e.timestamp,
      threadId: e.threadId,
      remoteAgent: e.to ?? '(unknown)',
      remoteAgentName: e.recipientName || this.resolveAgentName(e.to ?? ''),
      text: e.text,
      trustLevel: 'self',
      outcome: e.outcome,
    };
  }

  private computeAvgResponseLatencyMs(
    inbound: RawInboxEntry[],
    outbound: RawInboxEntry[],
  ): number | null {
    if (inbound.length === 0 || outbound.length === 0) return null;
    const sortedIn = [...inbound].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const sortedOut = [...outbound].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const latencies: number[] = [];
    let outIdx = 0;
    for (const inMsg of sortedIn) {
      const inMs = Date.parse(inMsg.timestamp);
      while (outIdx < sortedOut.length && Date.parse(sortedOut[outIdx]!.timestamp) <= inMs) {
        outIdx++;
      }
      if (outIdx < sortedOut.length) {
        const outMs = Date.parse(sortedOut[outIdx]!.timestamp);
        latencies.push(outMs - inMs);
        outIdx++;
      }
    }
    if (latencies.length === 0) return null;
    return Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  }
}

function makeSnippet(text: string, matchStart: number, matchLen: number): string {
  const HEAD = 60;
  const TAIL = 60;
  const start = Math.max(0, matchStart - HEAD);
  const end = Math.min(text.length, matchStart + matchLen + TAIL);
  const left = (start > 0 ? '…' : '') + text.slice(start, matchStart);
  const matched = `«${text.slice(matchStart, matchStart + matchLen)}»`;
  const right = text.slice(matchStart + matchLen, end) + (end < text.length ? '…' : '');
  return left + matched + right;
}
