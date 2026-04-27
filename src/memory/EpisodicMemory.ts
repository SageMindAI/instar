/**
 * EpisodicMemory — Activity digest + session synthesis storage and retrieval.
 *
 * Stores two levels of episodic data:
 *   1. Activity Digests (mini-digests) — short summaries of individual activity
 *      units within a session (30-60 min chunks)
 *   2. Session Syntheses — coherent overviews composed from all activity digests
 *      when a session completes
 *
 * Storage is JSON file-based (no SQLite) to keep episodic data portable
 * and easily inspectable. Files live under state/episodes/.
 *
 * Implements the Phase 3 design from PROP-memory-architecture.md v3.1.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────────

export type BoundarySignal =
  | 'topic_shift'       // Conversation changed direction
  | 'task_complete'     // Commit, test run, deployment
  | 'long_pause'        // 30+ min gap in activity
  | 'explicit_switch'   // User said "now let's work on..."
  | 'time_threshold'    // Max time between digests (60 min)
  | 'session_end';      // Session completed/killed

export interface ActivityDigest {
  id: string;
  sessionId: string;
  sessionName: string;
  startedAt: string;
  endedAt: string;
  telegramTopicId?: number;

  summary: string;
  actions: string[];

  entities: string[];       // IDs of SemanticMemory entities created/updated
  learnings: string[];

  significance: number;     // 1-10
  themes: string[];
  boundarySignal: BoundarySignal;
}

export interface SessionSynthesis {
  sessionId: string;
  sessionName: string;
  startedAt: string;
  endedAt: string;
  jobSlug?: string;
  telegramTopicId?: number;

  activityDigestIds: string[];
  summary: string;
  keyOutcomes: string[];

  allEntities: string[];
  allLearnings: string[];

  significance: number;     // 1-10
  themes: string[];
  followUp?: string;
}

export interface SentinelState {
  lastScanAt: string;
  sessions: Record<string, {
    lastDigestedAt: string;
    lastActivityAt?: string;
    digestCount: number;
  }>;
}

export interface EpisodicMemoryConfig {
  stateDir: string;  // Root state directory (episodes stored under state/episodes/)
}

// ─── EpisodicMemory ─────────────────────────────────────────────────

export class EpisodicMemory {
  private readonly episodesDir: string;
  private readonly activitiesDir: string;
  private readonly sessionsDir: string;
  private readonly pendingDir: string;
  private readonly sentinelStatePath: string;

  constructor(config: EpisodicMemoryConfig) {
    this.episodesDir = path.join(config.stateDir, 'episodes');
    this.activitiesDir = path.join(this.episodesDir, 'activities');
    this.sessionsDir = path.join(this.episodesDir, 'sessions');
    this.pendingDir = path.join(this.episodesDir, 'pending');
    this.sentinelStatePath = path.join(this.episodesDir, 'sentinel-state.json');

    this.ensureDirs();
  }

  private ensureDirs(): void {
    for (const dir of [this.episodesDir, this.activitiesDir, this.sessionsDir, this.pendingDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  // ─── Activity Digest CRUD ───────────────────────────────────────

  /**
   * Save an activity digest. Returns the digest ID.
   * Idempotent: uses hash(sessionId + startedAt + endedAt) to detect duplicates.
   */
  saveDigest(digest: Omit<ActivityDigest, 'id'>): string {
    const idempotencyKey = this.digestKey(digest.sessionId, digest.startedAt, digest.endedAt);

    // Check for existing digest with same key
    const existing = this.findDigestByKey(digest.sessionId, idempotencyKey);
    if (existing) return existing.id;

    const id = crypto.randomUUID();
    const fullDigest: ActivityDigest = { id, ...digest };

    // Ensure session directory
    const sessionDir = path.join(this.activitiesDir, digest.sessionId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    fs.writeFileSync(
      path.join(sessionDir, `${id}.json`),
      JSON.stringify(fullDigest, null, 2)
    );

    return id;
  }

  /**
   * Get a specific activity digest by ID.
   */
  getDigest(sessionId: string, digestId: string): ActivityDigest | null {
    const filePath = path.join(this.activitiesDir, sessionId, `${digestId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  /**
   * Get all activity digests for a session, ordered by startedAt.
   */
  getSessionActivities(sessionId: string): ActivityDigest[] {
    const sessionDir = path.join(this.activitiesDir, sessionId);
    if (!fs.existsSync(sessionDir)) return [];

    return fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(sessionDir, f), 'utf-8')) as ActivityDigest)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  // ─── Session Synthesis CRUD ─────────────────────────────────────

  /**
   * Save a session synthesis. Overwrites if exists.
   */
  saveSynthesis(synthesis: SessionSynthesis): void {
    fs.writeFileSync(
      path.join(this.sessionsDir, `${synthesis.sessionId}.json`),
      JSON.stringify(synthesis, null, 2)
    );
  }

  /**
   * Get the session synthesis for a completed session.
   */
  getSynthesis(sessionId: string): SessionSynthesis | null {
    const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }

  /**
   * List all session syntheses, ordered by startedAt descending (newest first).
   */
  listSyntheses(limit?: number): SessionSynthesis[] {
    if (!fs.existsSync(this.sessionsDir)) return [];

    const syntheses = fs.readdirSync(this.sessionsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(this.sessionsDir, f), 'utf-8')) as SessionSynthesis)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    return limit ? syntheses.slice(0, limit) : syntheses;
  }

  // ─── Query Methods ──────────────────────────────────────────────

  /**
   * Get digests across all sessions within a time range.
   */
  getByTimeRange(start: string, end: string): ActivityDigest[] {
    const allDigests: ActivityDigest[] = [];
    if (!fs.existsSync(this.activitiesDir)) return allDigests;

    for (const sessionDir of fs.readdirSync(this.activitiesDir)) {
      const sessionPath = path.join(this.activitiesDir, sessionDir);
      if (!fs.statSync(sessionPath).isDirectory()) continue;

      for (const file of fs.readdirSync(sessionPath).filter(f => f.endsWith('.json'))) {
        const digest = JSON.parse(fs.readFileSync(path.join(sessionPath, file), 'utf-8')) as ActivityDigest;
        if (digest.startedAt >= start && digest.endedAt <= end) {
          allDigests.push(digest);
        }
      }
    }

    return allDigests.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  /**
   * Get digests matching a theme across all sessions.
   */
  getByTheme(theme: string): ActivityDigest[] {
    const themeLower = theme.toLowerCase();
    const matches: ActivityDigest[] = [];
    if (!fs.existsSync(this.activitiesDir)) return matches;

    for (const sessionDir of fs.readdirSync(this.activitiesDir)) {
      const sessionPath = path.join(this.activitiesDir, sessionDir);
      if (!fs.statSync(sessionPath).isDirectory()) continue;

      for (const file of fs.readdirSync(sessionPath).filter(f => f.endsWith('.json'))) {
        const digest = JSON.parse(fs.readFileSync(path.join(sessionPath, file), 'utf-8')) as ActivityDigest;
        if (digest.themes.some(t => t.toLowerCase().includes(themeLower))) {
          matches.push(digest);
        }
      }
    }

    return matches.sort((a, b) => b.significance - a.significance);
  }

  /**
   * Get the most significant digests across all sessions.
   */
  getBySignificance(minSignificance: number): ActivityDigest[] {
    const matches: ActivityDigest[] = [];
    if (!fs.existsSync(this.activitiesDir)) return matches;

    for (const sessionDir of fs.readdirSync(this.activitiesDir)) {
      const sessionPath = path.join(this.activitiesDir, sessionDir);
      if (!fs.statSync(sessionPath).isDirectory()) continue;

      for (const file of fs.readdirSync(sessionPath).filter(f => f.endsWith('.json'))) {
        const digest = JSON.parse(fs.readFileSync(path.join(sessionPath, file), 'utf-8')) as ActivityDigest;
        if (digest.significance >= minSignificance) {
          matches.push(digest);
        }
      }
    }

    return matches.sort((a, b) => b.significance - a.significance);
  }

  /**
   * Get recent activity across all sessions (for working memory).
   */
  getRecentActivity(hours: number, limit: number): ActivityDigest[] {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const recent: ActivityDigest[] = [];
    if (!fs.existsSync(this.activitiesDir)) return recent;

    for (const sessionDir of fs.readdirSync(this.activitiesDir)) {
      const sessionPath = path.join(this.activitiesDir, sessionDir);
      if (!fs.statSync(sessionPath).isDirectory()) continue;

      for (const file of fs.readdirSync(sessionPath).filter(f => f.endsWith('.json'))) {
        const digest = JSON.parse(fs.readFileSync(path.join(sessionPath, file), 'utf-8')) as ActivityDigest;
        if (digest.endedAt >= cutoff) {
          recent.push(digest);
        }
      }
    }

    return recent
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt))
      .slice(0, limit);
  }

  // ─── Sentinel State ─────────────────────────────────────────────

  getSentinelState(): SentinelState {
    if (!fs.existsSync(this.sentinelStatePath)) {
      return { lastScanAt: new Date(0).toISOString(), sessions: {} };
    }
    return JSON.parse(fs.readFileSync(this.sentinelStatePath, 'utf-8'));
  }

  saveSentinelState(state: SentinelState): void {
    fs.writeFileSync(this.sentinelStatePath, JSON.stringify(state, null, 2));
  }

  // ─── Pending (Failed LLM) ──────────────────────────────────────

  /**
   * Save raw activity content when LLM digestion fails.
   * Stored for retry by the sentinel.
   */
  savePending(sessionId: string, content: string): string {
    const id = crypto.randomUUID();
    const sessionPending = path.join(this.pendingDir, sessionId);
    if (!fs.existsSync(sessionPending)) {
      fs.mkdirSync(sessionPending, { recursive: true });
    }

    fs.writeFileSync(
      path.join(sessionPending, `${id}.json`),
      JSON.stringify({
        id,
        sessionId,
        content,
        createdAt: new Date().toISOString(),
        retryCount: 0,
      }, null, 2)
    );

    return id;
  }

  /**
   * Get all pending items for a session.
   */
  getPending(sessionId: string): Array<{ id: string; sessionId: string; content: string; createdAt: string; retryCount: number }> {
    const sessionPending = path.join(this.pendingDir, sessionId);
    if (!fs.existsSync(sessionPending)) return [];

    return fs.readdirSync(sessionPending)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(fs.readFileSync(path.join(sessionPending, f), 'utf-8')));
  }

  /**
   * Remove a pending item after successful processing.
   */
  removePending(sessionId: string, pendingId: string): void {
    const filePath = path.join(this.pendingDir, sessionId, `${pendingId}.json`);
    // safe-git-allow: incremental-migration
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  /**
   * Increment retry count for a pending item.
   */
  incrementPendingRetry(sessionId: string, pendingId: string): number {
    const filePath = path.join(this.pendingDir, sessionId, `${pendingId}.json`);
    if (!fs.existsSync(filePath)) return -1;

    const item = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    item.retryCount += 1;
    fs.writeFileSync(filePath, JSON.stringify(item, null, 2));
    return item.retryCount;
  }

  // ─── Stats ──────────────────────────────────────────────────────

  stats(): {
    totalDigests: number;
    totalSyntheses: number;
    totalPending: number;
    sessionCount: number;
  } {
    let totalDigests = 0;
    let totalPending = 0;
    let sessionCount = 0;

    if (fs.existsSync(this.activitiesDir)) {
      for (const sessionDir of fs.readdirSync(this.activitiesDir)) {
        const sessionPath = path.join(this.activitiesDir, sessionDir);
        if (!fs.statSync(sessionPath).isDirectory()) continue;
        sessionCount++;
        totalDigests += fs.readdirSync(sessionPath).filter(f => f.endsWith('.json')).length;
      }
    }

    if (fs.existsSync(this.pendingDir)) {
      for (const sessionDir of fs.readdirSync(this.pendingDir)) {
        const sessionPath = path.join(this.pendingDir, sessionDir);
        if (!fs.statSync(sessionPath).isDirectory()) continue;
        totalPending += fs.readdirSync(sessionPath).filter(f => f.endsWith('.json')).length;
      }
    }

    const totalSyntheses = fs.existsSync(this.sessionsDir)
      ? fs.readdirSync(this.sessionsDir).filter(f => f.endsWith('.json')).length
      : 0;

    return { totalDigests, totalSyntheses, totalPending, sessionCount };
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private digestKey(sessionId: string, startedAt: string, endedAt: string): string {
    return crypto.createHash('sha256')
      .update(`${sessionId}:${startedAt}:${endedAt}`)
      .digest('hex')
      .slice(0, 16);
  }

  private findDigestByKey(sessionId: string, key: string): ActivityDigest | null {
    const sessionDir = path.join(this.activitiesDir, sessionId);
    if (!fs.existsSync(sessionDir)) return null;

    for (const file of fs.readdirSync(sessionDir).filter(f => f.endsWith('.json'))) {
      const digest = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf-8')) as ActivityDigest;
      const existingKey = this.digestKey(digest.sessionId, digest.startedAt, digest.endedAt);
      if (existingKey === key) return digest;
    }
    return null;
  }
}
