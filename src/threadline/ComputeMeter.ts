/**
 * ComputeMeter — Per-agent and global compute budget tracking.
 *
 * Part of Threadline Protocol Phase 6A (A2A Gateway). Prevents cost overrun
 * from inbound A2A messages by enforcing hourly/daily token limits per agent
 * (tied to trust level) and a global daily cap across all network agents.
 *
 * Rolling windows: hourly resets when the hour changes, daily resets at midnight UTC.
 *
 * Storage: {stateDir}/threadline/compute-meters.json
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

export type TrustLevel = 'untrusted' | 'verified' | 'trusted' | 'autonomous';

export interface ComputeBudget {
  hourlyTokenLimit: number;
  dailyTokenLimit: number;
  maxConcurrentSessions: number;
}

export interface AgentMeterState {
  agentIdentity: string;
  hourlyTokens: number;
  dailyTokens: number;
  activeSessions: number;
  hourWindowStart: string;
  dayWindowStart: string;
  lastUpdated: string;
}

export interface GlobalMeterState {
  dailyTokens: number;
  dayWindowStart: string;
  lastUpdated: string;
}

export interface ComputeMeterConfig {
  stateDir: string;
  globalDailyCap?: number;
  budgetOverrides?: Partial<Record<TrustLevel, Partial<ComputeBudget>>>;
}

export interface MeterCheckResult {
  allowed: boolean;
  reason?: string;
  remaining: {
    hourlyTokens: number;
    dailyTokens: number;
    globalDailyTokens: number;
    sessions: number;
  };
  retryAfterSeconds?: number;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_GLOBAL_DAILY_CAP = 5_000_000;

const BUDGET_TIERS: Record<TrustLevel, ComputeBudget> = {
  untrusted:  { hourlyTokenLimit: 10_000,  dailyTokenLimit: 50_000,    maxConcurrentSessions: 1  },
  verified:   { hourlyTokenLimit: 50_000,  dailyTokenLimit: 250_000,   maxConcurrentSessions: 3  },
  trusted:    { hourlyTokenLimit: 200_000, dailyTokenLimit: 1_000_000, maxConcurrentSessions: 5  },
  autonomous: { hourlyTokenLimit: 500_000, dailyTokenLimit: 2_000_000, maxConcurrentSessions: 10 },
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

/** Get the start of the current UTC hour as ISO string */
function currentHourStart(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
  return d.toISOString();
}

/** Get the start of the current UTC day as ISO string */
function currentDayStart(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString();
}

/** Seconds until the next UTC hour boundary */
function secondsUntilNextHour(now: Date): number {
  const nextHour = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1));
  return Math.max(1, Math.ceil((nextHour.getTime() - now.getTime()) / 1000));
}

/** Seconds until the next UTC midnight */
function secondsUntilNextDay(now: Date): number {
  const nextDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(1, Math.ceil((nextDay.getTime() - now.getTime()) / 1000));
}

// ── Persistence Types ────────────────────────────────────────────────

interface PersistedState {
  agents: Record<string, AgentMeterState>;
  global: GlobalMeterState;
  updatedAt: string;
}

// ── Implementation ───────────────────────────────────────────────────

export class ComputeMeter {
  private readonly threadlineDir: string;
  private readonly filePath: string;
  private readonly globalDailyCap: number;
  private readonly budgetOverrides: Partial<Record<TrustLevel, Partial<ComputeBudget>>>;

  private agents: Map<string, AgentMeterState>;
  private global: GlobalMeterState;

  constructor(config: ComputeMeterConfig) {
    this.threadlineDir = path.join(config.stateDir, 'threadline');
    fs.mkdirSync(this.threadlineDir, { recursive: true });
    this.filePath = path.join(this.threadlineDir, 'compute-meters.json');
    this.globalDailyCap = config.globalDailyCap ?? DEFAULT_GLOBAL_DAILY_CAP;
    this.budgetOverrides = config.budgetOverrides ?? {};

    this.agents = new Map();
    const now = new Date();
    this.global = {
      dailyTokens: 0,
      dayWindowStart: currentDayStart(now),
      lastUpdated: now.toISOString(),
    };

    this.reload();
  }

  // ── Budget Resolution ──────────────────────────────────────────────

  /**
   * Get the compute budget for a given trust level.
   * Applies any configured overrides on top of the default tier.
   */
  getBudget(trustLevel: TrustLevel): ComputeBudget {
    const base = BUDGET_TIERS[trustLevel];
    const overrides = this.budgetOverrides[trustLevel];
    if (!overrides) return { ...base };
    return {
      hourlyTokenLimit: overrides.hourlyTokenLimit ?? base.hourlyTokenLimit,
      dailyTokenLimit: overrides.dailyTokenLimit ?? base.dailyTokenLimit,
      maxConcurrentSessions: overrides.maxConcurrentSessions ?? base.maxConcurrentSessions,
    };
  }

  // ── Check & Record ─────────────────────────────────────────────────

  /**
   * Check if a request with the given token count would be allowed.
   * Does NOT consume tokens — use `record()` for that.
   */
  check(agentIdentity: string, trustLevel: TrustLevel, tokenCount: number): MeterCheckResult {
    const now = new Date();
    const budget = this.getBudget(trustLevel);

    // Roll windows for the agent
    const agent = this.getOrCreateAgent(agentIdentity, now);
    this.rollWindows(agent, now);

    // Roll global window
    this.rollGlobalWindow(now);

    // Check session limit (sessions aren't consumed by check, but report remaining)
    const sessionsRemaining = budget.maxConcurrentSessions - agent.activeSessions;

    // Check hourly
    const hourlyRemaining = budget.hourlyTokenLimit - agent.hourlyTokens;
    if (agent.hourlyTokens + tokenCount > budget.hourlyTokenLimit) {
      return {
        allowed: false,
        reason: 'hourly_limit_exceeded',
        remaining: {
          hourlyTokens: Math.max(0, hourlyRemaining),
          dailyTokens: Math.max(0, budget.dailyTokenLimit - agent.dailyTokens),
          globalDailyTokens: Math.max(0, this.globalDailyCap - this.global.dailyTokens),
          sessions: Math.max(0, sessionsRemaining),
        },
        retryAfterSeconds: secondsUntilNextHour(now),
      };
    }

    // Check daily
    const dailyRemaining = budget.dailyTokenLimit - agent.dailyTokens;
    if (agent.dailyTokens + tokenCount > budget.dailyTokenLimit) {
      return {
        allowed: false,
        reason: 'daily_limit_exceeded',
        remaining: {
          hourlyTokens: Math.max(0, hourlyRemaining),
          dailyTokens: Math.max(0, dailyRemaining),
          globalDailyTokens: Math.max(0, this.globalDailyCap - this.global.dailyTokens),
          sessions: Math.max(0, sessionsRemaining),
        },
        retryAfterSeconds: secondsUntilNextDay(now),
      };
    }

    // Check global daily cap
    const globalRemaining = this.globalDailyCap - this.global.dailyTokens;
    if (this.global.dailyTokens + tokenCount > this.globalDailyCap) {
      return {
        allowed: false,
        reason: 'global_cap_exceeded',
        remaining: {
          hourlyTokens: Math.max(0, hourlyRemaining),
          dailyTokens: Math.max(0, dailyRemaining),
          globalDailyTokens: Math.max(0, globalRemaining),
          sessions: Math.max(0, sessionsRemaining),
        },
        retryAfterSeconds: secondsUntilNextDay(now),
      };
    }

    return {
      allowed: true,
      remaining: {
        hourlyTokens: Math.max(0, hourlyRemaining - tokenCount),
        dailyTokens: Math.max(0, dailyRemaining - tokenCount),
        globalDailyTokens: Math.max(0, globalRemaining - tokenCount),
        sessions: Math.max(0, sessionsRemaining),
      },
    };
  }

  /**
   * Record token consumption for an agent.
   * Returns the check result after recording. Fails if budget would be exceeded.
   */
  record(agentIdentity: string, trustLevel: TrustLevel, tokenCount: number): MeterCheckResult {
    const result = this.check(agentIdentity, trustLevel, tokenCount);
    if (!result.allowed) return result;

    const now = new Date();
    const agent = this.getOrCreateAgent(agentIdentity, now);
    this.rollWindows(agent, now);
    this.rollGlobalWindow(now);

    // Consume tokens
    agent.hourlyTokens += tokenCount;
    agent.dailyTokens += tokenCount;
    agent.lastUpdated = now.toISOString();

    this.global.dailyTokens += tokenCount;
    this.global.lastUpdated = now.toISOString();

    return result;
  }

  // ── Session Management ─────────────────────────────────────────────

  /**
   * Increment the active session count for an agent.
   * Returns false if the agent is already at the maximum for their trust level.
   */
  incrementSessions(agentIdentity: string, trustLevel: TrustLevel): boolean {
    const now = new Date();
    const budget = this.getBudget(trustLevel);
    const agent = this.getOrCreateAgent(agentIdentity, now);

    if (agent.activeSessions >= budget.maxConcurrentSessions) {
      return false;
    }

    agent.activeSessions += 1;
    agent.lastUpdated = now.toISOString();
    return true;
  }

  /**
   * Decrement the active session count for an agent.
   * Clamps to zero — never goes negative.
   */
  decrementSessions(agentIdentity: string): void {
    const agent = this.agents.get(agentIdentity);
    if (!agent) return;

    agent.activeSessions = Math.max(0, agent.activeSessions - 1);
    agent.lastUpdated = new Date().toISOString();
  }

  // ── State Accessors ────────────────────────────────────────────────

  /**
   * Get current meter state for a specific agent, or null if unknown.
   */
  getAgentState(agentIdentity: string): AgentMeterState | null {
    const agent = this.agents.get(agentIdentity);
    if (!agent) return null;

    // Roll windows before returning so caller sees fresh state
    const now = new Date();
    this.rollWindows(agent, now);
    return { ...agent };
  }

  /**
   * Get the global meter state.
   */
  getGlobalState(): GlobalMeterState {
    const now = new Date();
    this.rollGlobalWindow(now);
    return { ...this.global };
  }

  // ── Reset ──────────────────────────────────────────────────────────

  /**
   * Reset meters. If agentIdentity is provided, resets only that agent.
   * If omitted, resets all agents and the global counter.
   */
  reset(agentIdentity?: string): void {
    if (agentIdentity) {
      this.agents.delete(agentIdentity);
    } else {
      this.agents.clear();
      const now = new Date();
      this.global = {
        dailyTokens: 0,
        dayWindowStart: currentDayStart(now),
        lastUpdated: now.toISOString(),
      };
    }
  }

  // ── Persistence ────────────────────────────────────────────────────

  /**
   * Persist current meter state to disk.
   * Uses atomic write (tmp file + rename) to prevent corruption.
   */
  persist(): void {
    try {
      const agents: Record<string, AgentMeterState> = {};
      for (const [key, state] of this.agents) {
        agents[key] = { ...state };
      }
      const data: PersistedState = {
        agents,
        global: { ...this.global },
        updatedAt: new Date().toISOString(),
      };
      atomicWrite(this.filePath, JSON.stringify(data, null, 2));
    } catch {
      // Persistence failure should not break metering
    }
  }

  /**
   * Reload meter state from disk.
   * Rolls any stale windows after loading.
   */
  reload(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw: PersistedState = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (!raw) return;

      const now = new Date();

      // Restore agent states
      if (raw.agents) {
        for (const [key, state] of Object.entries(raw.agents)) {
          const agent: AgentMeterState = { ...state };
          this.rollWindows(agent, now);
          this.agents.set(key, agent);
        }
      }

      // Restore global state
      if (raw.global) {
        this.global = { ...raw.global };
        this.rollGlobalWindow(now);
      }
    } catch {
      // Load failure — start fresh
    }
  }

  // ── Private ────────────────────────────────────────────────────────

  private getOrCreateAgent(agentIdentity: string, now: Date): AgentMeterState {
    let agent = this.agents.get(agentIdentity);
    if (!agent) {
      agent = {
        agentIdentity,
        hourlyTokens: 0,
        dailyTokens: 0,
        activeSessions: 0,
        hourWindowStart: currentHourStart(now),
        dayWindowStart: currentDayStart(now),
        lastUpdated: now.toISOString(),
      };
      this.agents.set(agentIdentity, agent);
    }
    return agent;
  }

  /**
   * Roll agent windows if the hour or day has changed since window start.
   */
  private rollWindows(agent: AgentMeterState, now: Date): void {
    const nowHourStart = currentHourStart(now);
    const nowDayStart = currentDayStart(now);

    // Roll hourly window
    if (agent.hourWindowStart !== nowHourStart) {
      agent.hourlyTokens = 0;
      agent.hourWindowStart = nowHourStart;
    }

    // Roll daily window
    if (agent.dayWindowStart !== nowDayStart) {
      agent.dailyTokens = 0;
      agent.dayWindowStart = nowDayStart;
    }
  }

  /**
   * Roll the global daily window if the UTC date has changed.
   */
  private rollGlobalWindow(now: Date): void {
    const nowDayStart = currentDayStart(now);
    if (this.global.dayWindowStart !== nowDayStart) {
      this.global.dailyTokens = 0;
      this.global.dayWindowStart = nowDayStart;
    }
  }
}
