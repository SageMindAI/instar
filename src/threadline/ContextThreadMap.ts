/**
 * ContextThreadMap — Bidirectional mapping between A2A contextIds and Threadline threadIds.
 *
 * Part of Threadline Protocol Phase 6A (A2A Gateway). When an A2A request arrives
 * with a contextId, this map resolves it to an existing Threadline threadId (or
 * signals that a new thread should be created). Reverse lookup is also supported.
 *
 * Identity binding prevents session smuggling: each contextId is bound to the
 * authenticated agent identity that created it. A different agent sending the
 * same contextId gets null (forcing a new thread), preventing one agent from
 * hijacking another agent's conversation context.
 *
 * Storage: {stateDir}/threadline/context-thread-map.json
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

export interface ContextThreadMapping {
  contextId: string;
  threadId: string;
  /** The authenticated agent identity that owns this mapping */
  agentIdentity: string;
  /** ISO timestamp */
  createdAt: string;
  /** ISO timestamp (for LRU eviction) */
  lastAccessedAt: string;
}

export interface ContextThreadMapConfig {
  stateDir: string;
  /** TTL in milliseconds. Default: 7 days */
  ttlMs?: number;
  /** Maximum entries before LRU eviction. Default: 10000 */
  maxEntries?: number;
}

// ── Constants ────────────────────────────────────────────────────────

/** 7 days in milliseconds — matches ThreadResumeMap TTL */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum mappings before LRU eviction kicks in */
const DEFAULT_MAX_ENTRIES = 10_000;

// ── Helpers ──────────────────────────────────────────────────────────

function atomicWrite(filePath: string, data: string): void {
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // safe-git-allow: incremental-migration
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

function safeJsonParse<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

// ── Persistence Format ───────────────────────────────────────────────

interface ContextThreadMapFile {
  mappings: ContextThreadMapping[];
  updatedAt: string;
}

// ── Implementation ───────────────────────────────────────────────────

export class ContextThreadMap {
  private readonly threadlineDir: string;
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  /** Primary index: contextId → mapping */
  private byContextId: Map<string, ContextThreadMapping>;
  /** Reverse index: threadId → contextId */
  private byThreadId: Map<string, string>;

  constructor(config: ContextThreadMapConfig) {
    this.threadlineDir = path.join(config.stateDir, 'threadline');
    fs.mkdirSync(this.threadlineDir, { recursive: true });
    this.filePath = path.join(this.threadlineDir, 'context-thread-map.json');
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = config.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.byContextId = new Map();
    this.byThreadId = new Map();
    this.reload();
  }

  // ── Lookup ───────────────────────────────────────────────────────

  /**
   * Get the threadId for a contextId, if the contextId exists AND belongs
   * to the given agent identity. Updates lastAccessedAt for LRU tracking.
   *
   * Returns null if:
   * - contextId is not mapped
   * - contextId is expired
   * - contextId belongs to a different agent (session smuggling prevention)
   */
  getThreadId(contextId: string, agentIdentity: string): string | null {
    const mapping = this.byContextId.get(contextId);
    if (!mapping) return null;

    // TTL check
    if (this.isExpired(mapping)) {
      this.deleteMapping(contextId);
      this.persist();
      return null;
    }

    // Identity binding — prevents session smuggling
    if (mapping.agentIdentity !== agentIdentity) {
      return null;
    }

    // Update LRU timestamp
    mapping.lastAccessedAt = new Date().toISOString();
    this.persist();

    return mapping.threadId;
  }

  /**
   * Reverse lookup: get the contextId for a threadId.
   * Returns null if no mapping exists or the mapping is expired.
   */
  getContextId(threadId: string): string | null {
    const contextId = this.byThreadId.get(threadId);
    if (!contextId) return null;

    const mapping = this.byContextId.get(contextId);
    if (!mapping) {
      // Stale reverse index — clean up
      this.byThreadId.delete(threadId);
      return null;
    }

    // TTL check
    if (this.isExpired(mapping)) {
      this.deleteMapping(contextId);
      this.persist();
      return null;
    }

    return contextId;
  }

  // ── Mutation ──────────────────────────────────────────────────────

  /**
   * Create a mapping between a contextId and threadId, bound to the
   * given agent identity. If at capacity, evicts the least recently
   * accessed entry before inserting.
   */
  set(contextId: string, threadId: string, agentIdentity: string): void {
    // If this contextId already exists, remove old reverse index
    const existing = this.byContextId.get(contextId);
    if (existing) {
      this.byThreadId.delete(existing.threadId);
    }

    // If this threadId already has a different contextId, remove that too
    const existingContextId = this.byThreadId.get(threadId);
    if (existingContextId && existingContextId !== contextId) {
      this.byContextId.delete(existingContextId);
    }

    // Evict LRU if at capacity
    if (!this.byContextId.has(contextId) && this.byContextId.size >= this.maxEntries) {
      this.evictLru();
    }

    const now = new Date().toISOString();
    const mapping: ContextThreadMapping = {
      contextId,
      threadId,
      agentIdentity,
      createdAt: existing?.createdAt ?? now,
      lastAccessedAt: now,
    };

    this.byContextId.set(contextId, mapping);
    this.byThreadId.set(threadId, contextId);
    this.persist();
  }

  /**
   * Remove a mapping by contextId.
   * Returns true if a mapping was removed, false if not found.
   */
  delete(contextId: string): boolean {
    const removed = this.deleteMapping(contextId);
    if (removed) {
      this.persist();
    }
    return removed;
  }

  /**
   * Remove a mapping by threadId.
   * Returns true if a mapping was removed, false if not found.
   */
  deleteByThreadId(threadId: string): boolean {
    const contextId = this.byThreadId.get(threadId);
    if (!contextId) return false;

    const removed = this.deleteMapping(contextId);
    if (removed) {
      this.persist();
    }
    return removed;
  }

  /**
   * Remove all mappings.
   */
  clear(): void {
    this.byContextId.clear();
    this.byThreadId.clear();
    this.persist();
  }

  // ── Maintenance ───────────────────────────────────────────────────

  /**
   * Current number of mappings.
   */
  size(): number {
    return this.byContextId.size;
  }

  /**
   * Remove all expired entries. Returns the number of entries removed.
   */
  cleanup(): number {
    let removed = 0;
    const toDelete: string[] = [];

    for (const [contextId, mapping] of this.byContextId) {
      if (this.isExpired(mapping)) {
        toDelete.push(contextId);
      }
    }

    for (const contextId of toDelete) {
      this.deleteMapping(contextId);
      removed++;
    }

    if (removed > 0) {
      this.persist();
    }

    return removed;
  }

  // ── Persistence ───────────────────────────────────────────────────

  /**
   * Save current state to disk. Called automatically on mutations.
   */
  persist(): void {
    try {
      const data: ContextThreadMapFile = {
        mappings: Array.from(this.byContextId.values()),
        updatedAt: new Date().toISOString(),
      };
      atomicWrite(this.filePath, JSON.stringify(data, null, 2));
    } catch {
      // Persistence failure should not break mapping operations
    }
  }

  /**
   * Reload state from disk. Called automatically on construction.
   */
  reload(): void {
    this.byContextId.clear();
    this.byThreadId.clear();

    const data = safeJsonParse<ContextThreadMapFile>(this.filePath, {
      mappings: [],
      updatedAt: '',
    });

    for (const mapping of data.mappings) {
      // Skip expired entries on load
      if (this.isExpired(mapping)) continue;

      this.byContextId.set(mapping.contextId, mapping);
      this.byThreadId.set(mapping.threadId, mapping.contextId);
    }
  }

  // ── Private ───────────────────────────────────────────────────────

  private isExpired(mapping: ContextThreadMapping): boolean {
    const age = Date.now() - new Date(mapping.lastAccessedAt).getTime();
    return age > this.ttlMs;
  }

  /**
   * Remove a mapping from both indexes. Does NOT persist — caller must persist.
   */
  private deleteMapping(contextId: string): boolean {
    const mapping = this.byContextId.get(contextId);
    if (!mapping) return false;

    this.byContextId.delete(contextId);
    this.byThreadId.delete(mapping.threadId);
    return true;
  }

  /**
   * Evict the least recently accessed entry to make room for a new one.
   */
  private evictLru(): void {
    let oldestContextId: string | null = null;
    let oldestTime = Infinity;

    for (const [contextId, mapping] of this.byContextId) {
      const accessTime = new Date(mapping.lastAccessedAt).getTime();
      if (accessTime < oldestTime) {
        oldestTime = accessTime;
        oldestContextId = contextId;
      }
    }

    if (oldestContextId) {
      this.deleteMapping(oldestContextId);
    }
  }
}
