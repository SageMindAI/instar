/**
 * SessionLifecycle — Manages the lifecycle of network agent sessions.
 *
 * Each inbound A2A conversation requires a Claude session (significant memory
 * and API cost). This module manages session states to control resource usage.
 *
 * Session states:
 *   active  →  parked  →  archived  →  evicted
 *     ↑          │          │
 *     └──────────┘          │ (resumed on demand
 *     (resumed on demand)    with context summary)
 *
 * Part of Threadline Protocol Phase 6A.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

export type SessionState = 'active' | 'parked' | 'archived' | 'evicted';

export interface SessionEntry {
  /** Threadline thread ID */
  threadId: string;
  /** Agent identity that owns this session */
  agentIdentity: string;
  /** Current session state */
  state: SessionState;
  /** When session was created */
  createdAt: string;
  /** When session last had activity */
  lastActivityAt: string;
  /** When session entered current state */
  stateChangedAt: string;
  /** Context summary (populated when archiving) */
  contextSummary?: string;
  /** Claude session UUID (null after eviction) */
  sessionUuid?: string;
  /** Message count in thread */
  messageCount: number;
}

export interface SessionLifecycleConfig {
  stateDir: string;
  /** Max active sessions (default: 5) */
  maxActive?: number;
  /** Max parked sessions (default: 20) */
  maxParked?: number;
  /** Idle timeout before parking in ms (default: 5 min) */
  parkAfterMs?: number;
  /** Idle timeout before archiving in ms (default: 24 hours) */
  archiveAfterMs?: number;
  /** Idle timeout before eviction in ms (default: 7 days) */
  evictAfterMs?: number;
  /** Callback when session is archived (for generating context summary) */
  onArchive?: (entry: SessionEntry) => Promise<string | undefined>;
  /** Callback when session state changes */
  onStateChange?: (entry: SessionEntry, previousState: SessionState) => void;
}

export interface SessionCapacityResult {
  canActivate: boolean;
  reason?: string;
  retryAfterSeconds?: number;
  /** If canActivate is false but a session was parked to make room, this is the parked threadId */
  parkedThreadId?: string;
}

export interface SessionStats {
  active: number;
  parked: number;
  archived: number;
  evicted: number;
  total: number;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_MAX_ACTIVE = 5;
const DEFAULT_MAX_PARKED = 20;
const DEFAULT_PARK_AFTER_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_EVICT_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Helpers ──────────────────────────────────────────────────────────

function atomicWrite(filePath: string, data: string): void {
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // safe-git-allow: incremental-migration
    try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

// ── SessionLifecycle ─────────────────────────────────────────────────

export class SessionLifecycle {
  private sessions: Map<string, SessionEntry> = new Map();
  private readonly filePath: string;
  private readonly maxActive: number;
  private readonly maxParked: number;
  private readonly parkAfterMs: number;
  private readonly archiveAfterMs: number;
  private readonly evictAfterMs: number;
  private readonly onArchive?: (entry: SessionEntry) => Promise<string | undefined>;
  private readonly onStateChange?: (entry: SessionEntry, previousState: SessionState) => void;

  constructor(config: SessionLifecycleConfig) {
    const dir = path.join(config.stateDir, 'threadline');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, 'session-lifecycle.json');
    this.maxActive = config.maxActive ?? DEFAULT_MAX_ACTIVE;
    this.maxParked = config.maxParked ?? DEFAULT_MAX_PARKED;
    this.parkAfterMs = config.parkAfterMs ?? DEFAULT_PARK_AFTER_MS;
    this.archiveAfterMs = config.archiveAfterMs ?? DEFAULT_ARCHIVE_AFTER_MS;
    this.evictAfterMs = config.evictAfterMs ?? DEFAULT_EVICT_AFTER_MS;
    this.onArchive = config.onArchive;
    this.onStateChange = config.onStateChange;
    this.reload();
  }

  /**
   * Activate a session for the given thread. Creates if not exists.
   * May park the oldest active session to make room.
   */
  activate(threadId: string, agentIdentity: string, sessionUuid?: string): SessionCapacityResult {
    const now = new Date().toISOString();
    const existing = this.sessions.get(threadId);

    // If already active, just update
    if (existing && existing.state === 'active') {
      existing.lastActivityAt = now;
      if (sessionUuid) existing.sessionUuid = sessionUuid;
      this.persist();
      return { canActivate: true };
    }

    // Check active count
    const activeCount = this.countByState('active');

    if (activeCount >= this.maxActive) {
      // Try to park the oldest active session
      const oldest = this.getOldestByState('active');
      if (oldest && oldest.threadId !== threadId) {
        this.transitionState(oldest.threadId, 'parked');
        return this.activate(threadId, agentIdentity, sessionUuid);
      }
      return {
        canActivate: false,
        reason: 'max_active_sessions_reached',
        retryAfterSeconds: 30,
      };
    }

    // Reactivate existing or create new
    if (existing) {
      const prevState = existing.state;
      existing.state = 'active';
      existing.lastActivityAt = now;
      existing.stateChangedAt = now;
      if (sessionUuid) existing.sessionUuid = sessionUuid;
      this.onStateChange?.(existing, prevState);
    } else {
      const entry: SessionEntry = {
        threadId,
        agentIdentity,
        state: 'active',
        createdAt: now,
        lastActivityAt: now,
        stateChangedAt: now,
        sessionUuid,
        messageCount: 0,
      };
      this.sessions.set(threadId, entry);
    }

    this.persist();
    return { canActivate: true };
  }

  /**
   * Record activity on a session (updates lastActivityAt).
   */
  touch(threadId: string): void {
    const entry = this.sessions.get(threadId);
    if (entry) {
      entry.lastActivityAt = new Date().toISOString();
      this.persist();
    }
  }

  /**
   * Increment message count for a thread.
   */
  incrementMessages(threadId: string): void {
    const entry = this.sessions.get(threadId);
    if (entry) {
      entry.messageCount++;
      entry.lastActivityAt = new Date().toISOString();
      this.persist();
    }
  }

  /**
   * Get session entry for a thread.
   */
  get(threadId: string): SessionEntry | null {
    return this.sessions.get(threadId) ?? null;
  }

  /**
   * Get all sessions for an agent.
   */
  getByAgent(agentIdentity: string): SessionEntry[] {
    return Array.from(this.sessions.values())
      .filter(s => s.agentIdentity === agentIdentity);
  }

  /**
   * Get session stats.
   */
  getStats(): SessionStats {
    const stats: SessionStats = { active: 0, parked: 0, archived: 0, evicted: 0, total: 0 };
    for (const entry of this.sessions.values()) {
      stats[entry.state]++;
      stats.total++;
    }
    return stats;
  }

  /**
   * Transition a session to a new state.
   */
  transitionState(threadId: string, newState: SessionState): boolean {
    const entry = this.sessions.get(threadId);
    if (!entry) return false;

    const prevState = entry.state;
    if (prevState === newState) return true;

    // Validate state transitions
    const validTransitions: Record<SessionState, SessionState[]> = {
      active: ['parked', 'archived', 'evicted'],
      parked: ['active', 'archived', 'evicted'],
      archived: ['active', 'evicted'],
      evicted: ['active'], // Can reactivate an evicted session (creates new)
    };

    if (!validTransitions[prevState].includes(newState)) {
      return false;
    }

    entry.state = newState;
    entry.stateChangedAt = new Date().toISOString();

    // Clear session UUID when archiving or evicting
    if (newState === 'archived' || newState === 'evicted') {
      entry.sessionUuid = undefined;
    }

    this.onStateChange?.(entry, prevState);
    this.persist();
    return true;
  }

  /**
   * Run lifecycle maintenance. Parks idle active sessions, archives idle parked
   * sessions, evicts old archived sessions.
   * Returns count of transitions made.
   */
  async runMaintenance(): Promise<number> {
    const now = Date.now();
    let transitions = 0;

    const entries = Array.from(this.sessions.values());

    for (const entry of entries) {
      const lastActivity = new Date(entry.lastActivityAt).getTime();
      const idleMs = now - lastActivity;

      switch (entry.state) {
        case 'active':
          if (idleMs >= this.parkAfterMs) {
            this.transitionState(entry.threadId, 'parked');
            transitions++;
          }
          break;

        case 'parked':
          if (idleMs >= this.archiveAfterMs) {
            // Generate context summary before archiving
            if (this.onArchive) {
              try {
                entry.contextSummary = await this.onArchive(entry);
              } catch { /* proceed without summary */ }
            }
            this.transitionState(entry.threadId, 'archived');
            transitions++;
          }
          break;

        case 'archived':
          if (idleMs >= this.evictAfterMs) {
            this.transitionState(entry.threadId, 'evicted');
            transitions++;
          }
          break;
      }
    }

    // Enforce parked limit — evict oldest parked if over limit
    const parked = entries
      .filter(e => e.state === 'parked')
      .sort((a, b) => new Date(a.lastActivityAt).getTime() - new Date(b.lastActivityAt).getTime());

    while (parked.length > this.maxParked) {
      const oldest = parked.shift()!;
      this.transitionState(oldest.threadId, 'archived');
      transitions++;
    }

    if (transitions > 0) this.persist();
    return transitions;
  }

  /**
   * Remove a session entirely (after thread deletion).
   */
  remove(threadId: string): boolean {
    const existed = this.sessions.delete(threadId);
    if (existed) this.persist();
    return existed;
  }

  /**
   * Clear all sessions.
   */
  clear(): void {
    this.sessions.clear();
    this.persist();
  }

  /**
   * Total session count.
   */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Persist to disk.
   */
  persist(): void {
    const data: Record<string, SessionEntry> = {};
    for (const [id, entry] of this.sessions) {
      data[id] = entry;
    }
    atomicWrite(this.filePath, JSON.stringify(data, null, 2));
  }

  /**
   * Reload from disk.
   */
  reload(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        this.sessions.clear();
        for (const [id, entry] of Object.entries(raw)) {
          this.sessions.set(id, entry as SessionEntry);
        }
      }
    } catch { /* start fresh if corrupt */ }
  }

  // ── Private Helpers ──────────────────────────────────────────────

  private countByState(state: SessionState): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (entry.state === state) count++;
    }
    return count;
  }

  private getOldestByState(state: SessionState): SessionEntry | null {
    let oldest: SessionEntry | null = null;
    let oldestTime = Infinity;
    for (const entry of this.sessions.values()) {
      if (entry.state === state) {
        const time = new Date(entry.lastActivityAt).getTime();
        if (time < oldestTime) {
          oldestTime = time;
          oldest = entry;
        }
      }
    }
    return oldest;
  }
}
