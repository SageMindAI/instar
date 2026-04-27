/**
 * RateLimiter — Rate limiting for inter-agent communication.
 *
 * Part of Threadline Protocol Phase 5 (Section 7.7). Enforces per-agent,
 * per-thread, global, burst, machine-aggregate, and spawn-request rate limits.
 *
 * Uses sliding window counters for accurate rate limiting (not fixed windows).
 *
 * Storage: In-memory with periodic persistence to {stateDir}/threadline/rate-limits.json
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  perAgentInbound: { limit: number; windowMs: number };
  perAgentOutbound: { limit: number; windowMs: number };
  perThread: { limit: number; windowMs: number };
  globalInbound: { limit: number; windowMs: number };
  perAgentBurst: { limit: number; windowMs: number };
  machineAggregate: { limit: number; windowMs: number };
  spawnRequests: { limit: number; windowMs: number };
}

export type RateLimitType = keyof RateLimitConfig;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface RateLimitStatus {
  type: RateLimitType;
  key: string;
  currentCount: number;
  limit: number;
  windowMs: number;
  remaining: number;
  isLimited: boolean;
}

// ── Constants ────────────────────────────────────────────────────────

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  perAgentInbound: { limit: 30, windowMs: 60 * 60 * 1000 },
  perAgentOutbound: { limit: 30, windowMs: 60 * 60 * 1000 },
  perThread: { limit: 10, windowMs: 60 * 60 * 1000 },
  globalInbound: { limit: 200, windowMs: 60 * 60 * 1000 },
  perAgentBurst: { limit: 5, windowMs: 60 * 1000 },
  machineAggregate: { limit: 500, windowMs: 60 * 60 * 1000 },
  spawnRequests: { limit: 5, windowMs: 60 * 60 * 1000 },
};

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

// ── Sliding Window Counter ───────────────────────────────────────────

interface SlidingWindow {
  events: number[]; // timestamps in ms
}

// ── Implementation ───────────────────────────────────────────────────

export class RateLimiter {
  private readonly threadlineDir: string;
  private readonly filePath: string;
  private readonly config: RateLimitConfig;
  private readonly nowFn: () => number;

  /**
   * Nested map: type → key → sliding window
   * e.g., 'perAgentInbound' → 'agent-x' → { events: [...] }
   */
  private windows: Map<string, Map<string, SlidingWindow>>;

  constructor(options: {
    stateDir: string;
    config?: Partial<RateLimitConfig>;
    nowFn?: () => number;
  }) {
    this.threadlineDir = path.join(options.stateDir, 'threadline');
    fs.mkdirSync(this.threadlineDir, { recursive: true });
    this.filePath = path.join(this.threadlineDir, 'rate-limits.json');
    this.config = { ...DEFAULT_RATE_LIMITS, ...options.config };
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.windows = new Map();
    this.loadFromDisk();
  }

  // ── Core Rate Limit Operations ──────────────────────────────────

  /**
   * Check if a rate limit would be exceeded.
   * Does NOT record an event — use recordEvent() to consume a slot.
   */
  checkLimit(type: RateLimitType, key: string): RateLimitResult {
    const limitConfig = this.config[type];
    const now = this.nowFn();
    const windowStart = now - limitConfig.windowMs;

    const window = this.getWindow(type, key);
    // Clean expired events
    const activeEvents = window.events.filter(t => t > windowStart);
    window.events = activeEvents;

    const count = activeEvents.length;
    const remaining = Math.max(0, limitConfig.limit - count);
    const oldestInWindow = activeEvents.length > 0 ? activeEvents[0] : now;
    const resetAt = oldestInWindow + limitConfig.windowMs;

    return {
      allowed: count < limitConfig.limit,
      remaining,
      resetAt,
    };
  }

  /**
   * Record an event against a rate limit.
   * Returns the check result after recording.
   */
  recordEvent(type: RateLimitType, key: string): RateLimitResult {
    const now = this.nowFn();
    const window = this.getWindow(type, key);

    // Clean expired events first
    const limitConfig = this.config[type];
    const windowStart = now - limitConfig.windowMs;
    window.events = window.events.filter(t => t > windowStart);

    // Add new event
    window.events.push(now);

    const count = window.events.length;
    const remaining = Math.max(0, limitConfig.limit - count);
    const resetAt = window.events[0] + limitConfig.windowMs;

    return {
      allowed: count <= limitConfig.limit,
      remaining,
      resetAt,
    };
  }

  // ── Quick Check Methods ─────────────────────────────────────────

  /**
   * Quick check if an agent is rate limited for inbound or outbound.
   */
  isRateLimited(agentName: string, direction: 'inbound' | 'outbound'): boolean {
    const type: RateLimitType = direction === 'inbound' ? 'perAgentInbound' : 'perAgentOutbound';
    const result = this.checkLimit(type, agentName);

    if (!result.allowed) return true;

    // Also check burst limit
    const burstResult = this.checkLimit('perAgentBurst', agentName);
    return !burstResult.allowed;
  }

  // ── Status Reporting ────────────────────────────────────────────

  /**
   * Get current rate limit status for an agent or all limits.
   */
  getStatus(agentName?: string): RateLimitStatus[] {
    const statuses: RateLimitStatus[] = [];

    if (agentName) {
      // Per-agent statuses
      for (const type of ['perAgentInbound', 'perAgentOutbound', 'perAgentBurst', 'spawnRequests'] as RateLimitType[]) {
        statuses.push(this.buildStatus(type, agentName));
      }
    } else {
      // Global statuses
      const typeMap = this.windows;
      for (const [typeKey, keyMap] of typeMap) {
        for (const [key] of keyMap) {
          statuses.push(this.buildStatus(typeKey as RateLimitType, key));
        }
      }
    }

    return statuses;
  }

  // ── Reset ───────────────────────────────────────────────────────

  /**
   * Reset rate limits. If type and key provided, resets that specific limit.
   * If only type provided, resets all keys for that type.
   * If neither provided, resets everything.
   */
  reset(type?: RateLimitType, key?: string): void {
    if (type && key) {
      const typeMap = this.windows.get(type);
      if (typeMap) {
        typeMap.delete(key);
      }
    } else if (type) {
      this.windows.delete(type);
    } else {
      this.windows.clear();
    }
    this.persistToDisk();
  }

  // ── Persistence ─────────────────────────────────────────────────

  /**
   * Persist current state to disk.
   * Call periodically (e.g., every 5 minutes) for crash recovery.
   */
  persistToDisk(): void {
    try {
      const data: Record<string, Record<string, number[]>> = {};
      for (const [type, keyMap] of this.windows) {
        data[type] = {};
        for (const [key, window] of keyMap) {
          data[type][key] = window.events;
        }
      }
      atomicWrite(this.filePath, JSON.stringify({ windows: data, updatedAt: new Date(this.nowFn()).toISOString() }, null, 2));
    } catch {
      // Persistence failure should not break rate limiting
    }
  }

  // ── Private ─────────────────────────────────────────────────────

  private getWindow(type: string, key: string): SlidingWindow {
    if (!this.windows.has(type)) {
      this.windows.set(type, new Map());
    }
    const typeMap = this.windows.get(type)!;
    if (!typeMap.has(key)) {
      typeMap.set(key, { events: [] });
    }
    return typeMap.get(key)!;
  }

  private buildStatus(type: RateLimitType, key: string): RateLimitStatus {
    const limitConfig = this.config[type];
    const now = this.nowFn();
    const windowStart = now - limitConfig.windowMs;
    const window = this.getWindow(type, key);
    const activeEvents = window.events.filter(t => t > windowStart);
    const count = activeEvents.length;

    return {
      type,
      key,
      currentCount: count,
      limit: limitConfig.limit,
      windowMs: limitConfig.windowMs,
      remaining: Math.max(0, limitConfig.limit - count),
      isLimited: count >= limitConfig.limit,
    };
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (!raw?.windows) return;

      const now = this.nowFn();
      for (const [type, keyObj] of Object.entries(raw.windows as Record<string, Record<string, number[]>>)) {
        const limitConfig = this.config[type as RateLimitType];
        if (!limitConfig) continue;
        const windowStart = now - limitConfig.windowMs;

        for (const [key, events] of Object.entries(keyObj)) {
          // Only load events still within the window
          const validEvents = events.filter(t => t > windowStart);
          if (validEvents.length > 0) {
            const window = this.getWindow(type, key);
            window.events = validEvents;
          }
        }
      }
    } catch {
      // Load failure — start fresh
    }
  }
}
