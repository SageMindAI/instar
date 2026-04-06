/**
 * ThreadResumeMap — Persistent mapping from thread IDs to Claude session UUIDs.
 *
 * Analogous to TopicResumeMap but for inter-agent conversation threads.
 * When a thread's session is killed idle, the Claude session UUID is persisted
 * so it can be resumed (--resume UUID) when the next message arrives on that thread.
 *
 * Key differences from TopicResumeMap:
 * - Maps threadId (string UUID) → extended session info
 * - 7-day TTL (vs. 24 hours)
 * - Max 1,000 entries with LRU eviction of non-pinned entries
 * - Resolved threads get a 7-day grace period before removal
 * - Pinned threads are never evicted
 *
 * Storage: {stateDir}/threadline/thread-resume-map.json
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

// ── Types ───────────────────────────────────────────────────────

/** Thread lifecycle state */
export type ThreadState = 'active' | 'idle' | 'resolved' | 'failed' | 'archived';

/** A single thread resume mapping entry */
export interface ThreadResumeEntry {
  /** Claude session UUID */
  uuid: string;
  /** tmux session name */
  sessionName: string;
  /** When thread was created */
  createdAt: string;
  /** When this mapping was last saved */
  savedAt: string;
  /** When thread was last accessed */
  lastAccessedAt: string;
  /** The other agent in this conversation */
  remoteAgent: string;
  /** Thread subject */
  subject: string;
  /** Thread lifecycle state */
  state: ThreadState;
  /** When thread was resolved (only set if state === 'resolved') */
  resolvedAt?: string;
  /** Pinned threads are never evicted */
  pinned: boolean;
  /** Total messages in thread */
  messageCount: number;
  /** Machine that owns this thread (for cross-machine sync) */
  machineOrigin?: string;
  /** If migrated to another machine, which one */
  migratedTo?: string;
  /** Spawn mode: interactive (default) or pipe */
  spawnMode?: 'interactive' | 'pipe';
}

/** Serialized map format */
interface ThreadResumeMapData {
  [threadId: string]: ThreadResumeEntry;
}

// ── Constants ───────────────────────────────────────────────────

/** Entries older than 7 days are pruned (non-pinned only) */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Resolved threads get a 7-day grace period before removal */
const RESOLVED_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum number of entries before LRU eviction */
const MAX_ENTRIES = 1000;

// ── Implementation ──────────────────────────────────────────────

export class ThreadResumeMap {
  private filePath: string;
  private projectDir: string;
  private tmuxPath: string;

  constructor(stateDir: string, projectDir: string, tmuxPath?: string) {
    const threadlineDir = path.join(stateDir, 'threadline');
    fs.mkdirSync(threadlineDir, { recursive: true });
    this.filePath = path.join(threadlineDir, 'thread-resume-map.json');
    this.projectDir = projectDir;
    this.tmuxPath = tmuxPath || 'tmux';
  }

  /**
   * Save or update a thread resume mapping.
   * Triggers pruning if the map exceeds MAX_ENTRIES.
   */
  save(threadId: string, entry: ThreadResumeEntry): void {
    const map = this.load();

    map[threadId] = {
      ...entry,
      savedAt: new Date().toISOString(),
    };

    // Prune if needed
    this.pruneMap(map);
    this.persist(map);
  }

  /**
   * Look up a thread resume entry. Returns null if not found,
   * expired, or the JSONL file no longer exists.
   */
  get(threadId: string): ThreadResumeEntry | null {
    const map = this.load();
    const entry = map[threadId];
    if (!entry) return null;

    // Check if expired (non-pinned only)
    if (!entry.pinned && this.isExpired(entry)) {
      return null;
    }

    // Verify the JSONL file still exists
    if (!this.jsonlExists(entry.uuid)) {
      return null;
    }

    return entry;
  }

  /**
   * Remove a thread entry.
   */
  remove(threadId: string): void {
    const map = this.load();
    delete map[threadId];
    this.persist(map);
  }

  /**
   * Mark a thread as resolved — sets state to 'resolved' and records resolvedAt.
   * Resolved threads get a grace period before being removed by prune().
   */
  resolve(threadId: string): void {
    const map = this.load();
    const entry = map[threadId];
    if (!entry) return;

    entry.state = 'resolved';
    entry.resolvedAt = new Date().toISOString();
    entry.savedAt = new Date().toISOString();

    this.persist(map);
  }

  /**
   * Mark entries from a specific machine as migrated (Phase 4: cross-machine sync).
   * Called during failover when this machine takes over from another.
   * The migrated entries can be used to resume threads with --resume UUID.
   */
  migrateFrom(sourceMachine: string, targetMachine: string): { migrated: number; skipped: number } {
    const map = this.load();
    let migrated = 0;
    let skipped = 0;

    for (const [threadId, entry] of Object.entries(map)) {
      if (entry.machineOrigin === sourceMachine && entry.state === 'active') {
        entry.migratedTo = targetMachine;
        entry.state = 'idle'; // Demote to idle — will be resumed on next message
        entry.savedAt = new Date().toISOString();
        migrated++;
      } else if (entry.machineOrigin === sourceMachine) {
        skipped++;
      }
    }

    if (migrated > 0) this.persist(map);
    return { migrated, skipped };
  }

  /**
   * Get entries that were migrated to this machine (for resume capability).
   */
  getMigratedEntries(targetMachine: string): Array<{ threadId: string; entry: ThreadResumeEntry }> {
    const map = this.load();
    const results: Array<{ threadId: string; entry: ThreadResumeEntry }> = [];
    for (const [threadId, entry] of Object.entries(map)) {
      if (entry.migratedTo === targetMachine) {
        results.push({ threadId, entry });
      }
    }
    return results;
  }

  /**
   * Pin a thread — pinned threads are never evicted by LRU or TTL.
   */
  pin(threadId: string): void {
    const map = this.load();
    const entry = map[threadId];
    if (!entry) return;

    entry.pinned = true;
    entry.savedAt = new Date().toISOString();

    this.persist(map);
  }

  /**
   * Unpin a thread — allows normal TTL and LRU eviction.
   */
  unpin(threadId: string): void {
    const map = this.load();
    const entry = map[threadId];
    if (!entry) return;

    entry.pinned = false;
    entry.savedAt = new Date().toISOString();

    this.persist(map);
  }

  /**
   * Find all threads with a specific remote agent.
   * Returns entries that are not expired.
   */
  getByRemoteAgent(agentName: string): Array<{ threadId: string; entry: ThreadResumeEntry }> {
    const map = this.load();
    const results: Array<{ threadId: string; entry: ThreadResumeEntry }> = [];

    for (const [threadId, entry] of Object.entries(map)) {
      if (entry.remoteAgent === agentName && (entry.pinned || !this.isExpired(entry))) {
        results.push({ threadId, entry });
      }
    }

    return results;
  }

  /**
   * List all active or idle threads (not resolved, failed, or archived).
   */
  listActive(): Array<{ threadId: string; entry: ThreadResumeEntry }> {
    const map = this.load();
    const results: Array<{ threadId: string; entry: ThreadResumeEntry }> = [];

    for (const [threadId, entry] of Object.entries(map)) {
      if (
        (entry.state === 'active' || entry.state === 'idle') &&
        (entry.pinned || !this.isExpired(entry))
      ) {
        results.push({ threadId, entry });
      }
    }

    return results;
  }

  /**
   * Prune expired entries, resolved entries past grace period,
   * and LRU overflow entries. Called automatically on save, but
   * can be called manually for maintenance.
   */
  prune(): void {
    const map = this.load();
    this.pruneMap(map);
    this.persist(map);
  }

  /**
   * Proactive resume heartbeat: scan all active thread-linked tmux sessions
   * and update the thread→UUID mapping. Should be called periodically.
   *
   * This ensures that even if a session crashes unexpectedly, we already have
   * its UUID on file for --resume.
   */
  refreshResumeMappings(threadSessions: Map<string, string>): void {
    try {
      if (!threadSessions || threadSessions.size === 0) return;

      const projectHash = this.projectDir.replace(/\//g, '-');
      const projectJsonlDir = path.join(os.homedir(), '.claude', 'projects', projectHash);

      if (!fs.existsSync(projectJsonlDir)) return;

      // Get all JSONL files with their stats
      const jsonlFiles = fs.readdirSync(projectJsonlDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          try {
            const stat = fs.statSync(path.join(projectJsonlDir, f));
            return { name: f, mtimeMs: stat.mtimeMs, uuid: f.replace('.jsonl', '') };
          } catch { return null; }
        })
        .filter((f): f is { name: string; mtimeMs: number; uuid: string } => f !== null && f.uuid.length >= 30)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      if (jsonlFiles.length === 0) return;

      const map = this.load();
      let updated = 0;
      const claimedUuids = new Set<string>();

      for (const [threadId, sessionName] of threadSessions) {
        // Verify the tmux session is actually alive
        const hasSession = spawnSync(this.tmuxPath, ['has-session', '-t', `=${sessionName}`]);
        if (hasSession.status !== 0) continue;

        // Find the JSONL for this session (most recently modified, not already claimed)
        const availableJsonl = jsonlFiles.find(f => !claimedUuids.has(f.uuid));
        if (!availableJsonl) continue;

        claimedUuids.add(availableJsonl.uuid);

        const existingEntry = map[threadId];

        // Update if UUID changed, entry doesn't exist, or entry is stale (>2 hours)
        const entryAge = existingEntry ? Date.now() - new Date(existingEntry.savedAt).getTime() : Infinity;
        if (existingEntry && (existingEntry.uuid !== availableJsonl.uuid || entryAge > 2 * 60 * 60 * 1000)) {
          existingEntry.uuid = availableJsonl.uuid;
          existingEntry.savedAt = new Date().toISOString();
          existingEntry.lastAccessedAt = new Date().toISOString();
          existingEntry.sessionName = sessionName;
          updated++;
        }
      }

      if (updated > 0) {
        this.persist(map);
      }
    } catch (err) {
      console.error('[ThreadResumeMap] Resume heartbeat error:', err);
    }
  }

  /**
   * Get the total number of entries in the map (for monitoring).
   */
  size(): number {
    return Object.keys(this.load()).length;
  }

  // ── Private Helpers ──────────────────────────────────────────

  private load(): ThreadResumeMapData {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      }
    } catch {
      // Corrupted file — start fresh
    }
    return {};
  }

  private persist(map: ThreadResumeMapData): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(map, null, 2));
    } catch (err) {
      console.error(`[ThreadResumeMap] Failed to save: ${err}`);
    }
  }

  /**
   * Check if an entry is expired based on its state and age.
   * - Active/idle: expire after MAX_AGE_MS from lastAccessedAt
   * - Resolved: expire after RESOLVED_GRACE_MS from resolvedAt
   * - Failed/archived: expire after MAX_AGE_MS from savedAt
   */
  private isExpired(entry: ThreadResumeEntry): boolean {
    const now = Date.now();

    if (entry.state === 'resolved' && entry.resolvedAt) {
      return now - new Date(entry.resolvedAt).getTime() > RESOLVED_GRACE_MS;
    }

    // For active/idle threads, use lastAccessedAt
    const referenceTime = entry.lastAccessedAt || entry.savedAt;
    return now - new Date(referenceTime).getTime() > MAX_AGE_MS;
  }

  /**
   * Prune a map in-place: remove expired entries, resolved-past-grace entries,
   * and LRU overflow (non-pinned) entries.
   */
  private pruneMap(map: ThreadResumeMapData): void {
    // Phase 1: Remove expired and resolved-past-grace entries
    for (const key of Object.keys(map)) {
      const entry = map[key];
      if (entry.pinned) continue;

      if (this.isExpired(entry)) {
        delete map[key];
      }
    }

    // Phase 2: LRU eviction if still over MAX_ENTRIES
    const keys = Object.keys(map);
    if (keys.length <= MAX_ENTRIES) return;

    // Separate pinned from unpinned
    const pinned: string[] = [];
    const unpinned: Array<{ key: string; lastAccessedAt: number }> = [];

    for (const key of keys) {
      const entry = map[key];
      if (entry.pinned) {
        pinned.push(key);
      } else {
        unpinned.push({
          key,
          lastAccessedAt: new Date(entry.lastAccessedAt || entry.savedAt).getTime(),
        });
      }
    }

    // Sort unpinned by lastAccessedAt ascending (oldest first = evict first)
    unpinned.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

    // Evict oldest unpinned entries until we're at or under MAX_ENTRIES
    const toEvict = keys.length - MAX_ENTRIES;
    for (let i = 0; i < toEvict && i < unpinned.length; i++) {
      delete map[unpinned[i].key];
    }
  }

  /**
   * Check if a JSONL file exists for the given UUID.
   */
  private jsonlExists(uuid: string): boolean {
    const homeDir = os.homedir();
    const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');

    if (!fs.existsSync(claudeProjectsDir)) return false;

    try {
      const projectDirs = fs.readdirSync(claudeProjectsDir);
      for (const dir of projectDirs) {
        const jsonlPath = path.join(claudeProjectsDir, dir, `${uuid}.jsonl`);
        if (fs.existsSync(jsonlPath)) return true;
      }
    } catch {
      // Can't check — assume not found
    }

    return false;
  }
}
