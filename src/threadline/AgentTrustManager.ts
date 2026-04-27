/**
 * AgentTrustManager — Per-agent trust profiles for inter-agent communication.
 *
 * Part of Threadline Protocol Phase 5. Tracks trust between THIS agent and
 * remote agents it communicates with. Unlike AdaptiveTrust (user→agent trust),
 * this manages agent→agent trust in the Threadline mesh.
 *
 * Trust rules (Section 7.3/7.4):
 * - ALL trust level UPGRADES require source: 'user-granted' — NO auto-escalation
 * - Auto-DOWNGRADE only: circuit breaker (3 activations in 24h → untrusted),
 *   crypto verification failure → untrusted, 90 days no interaction → downgrade one level
 * - All trust changes logged to append-only audit trail
 *
 * Storage:
 * - Profiles: {stateDir}/threadline/trust-profiles.json
 * - Audit trail: {stateDir}/threadline/trust-audit.jsonl
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

export type AgentTrustLevel = 'untrusted' | 'verified' | 'trusted' | 'autonomous';
export type AgentTrustSource = 'user-granted' | 'paired-machine-granted' | 'setup-default';

export interface AgentTrustHistory {
  messagesReceived: number;
  messagesResponded: number;
  successfulInteractions: number;
  failedInteractions: number;
  lastInteraction: string;
  streakSinceIncident: number;
}

export interface AgentTrustProfile {
  agent: string;
  /** Cryptographic fingerprint (Ed25519-derived). Primary identity key. */
  fingerprint?: string;
  level: AgentTrustLevel;
  source: AgentTrustSource;
  history: AgentTrustHistory;
  allowedOperations: string[];
  blockedOperations: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TrustAuditEntry {
  timestamp: string;
  agent: string;
  previousLevel: AgentTrustLevel;
  newLevel: AgentTrustLevel;
  source: AgentTrustSource | 'system';
  reason: string;
  userInitiated: boolean;
}

export interface TrustChangeNotification {
  agent: string;
  previousLevel: AgentTrustLevel;
  newLevel: AgentTrustLevel;
  reason: string;
  userInitiated: boolean;
}

/** Callback for trust change notifications */
export type TrustChangeCallback = (notification: TrustChangeNotification) => void;

export interface InteractionStats {
  messagesReceived: number;
  messagesResponded: number;
  successfulInteractions: number;
  failedInteractions: number;
  successRate: number;
  streakSinceIncident: number;
  lastInteraction: string | null;
}

// ── Constants ────────────────────────────────────────────────────────

/** Trust levels ordered from most restrictive to least */
const TRUST_ORDER: AgentTrustLevel[] = ['untrusted', 'verified', 'trusted', 'autonomous'];

/** 90 days in milliseconds — staleness threshold for auto-downgrade */
const STALENESS_THRESHOLD_MS = 90 * 24 * 60 * 60 * 1000;

/** Default operations allowed per trust level */
const DEFAULT_ALLOWED_OPS: Record<AgentTrustLevel, string[]> = {
  untrusted: ['ping', 'health'],
  verified: ['ping', 'health', 'message', 'query'],
  trusted: ['ping', 'health', 'message', 'query', 'task-request', 'data-share'],
  autonomous: ['ping', 'health', 'message', 'query', 'task-request', 'data-share', 'spawn', 'delegate'],
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

function safeJsonParse<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

// ── Implementation ───────────────────────────────────────────────────

interface ProfilesFile {
  profiles: Record<string, AgentTrustProfile>;
  updatedAt: string;
}

export class AgentTrustManager {
  private readonly threadlineDir: string;
  private readonly profilesPath: string;
  private readonly auditPath: string;
  private profiles: Record<string, AgentTrustProfile>;
  private onTrustChange: TrustChangeCallback | null;
  private saveDirty = false;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: {
    stateDir: string;
    onTrustChange?: TrustChangeCallback;
  }) {
    this.threadlineDir = path.join(options.stateDir, 'threadline');
    fs.mkdirSync(this.threadlineDir, { recursive: true });
    this.profilesPath = path.join(this.threadlineDir, 'trust-profiles.json');
    this.auditPath = path.join(this.threadlineDir, 'trust-audit.jsonl');
    this.onTrustChange = options.onTrustChange ?? null;
    this.profiles = this.loadProfiles();
  }

  // ── Profile Access ──────────────────────────────────────────────

  /**
   * Get trust profile for an agent by name or fingerprint.
   * Checks direct key match first (name or fingerprint), then scans
   * profile display names for backwards compatibility.
   */
  getProfile(agentNameOrFingerprint: string): AgentTrustProfile | null {
    // Direct key lookup (works for both name-keyed and fingerprint-keyed profiles)
    if (this.profiles[agentNameOrFingerprint]) {
      return this.profiles[agentNameOrFingerprint];
    }
    // Scan display names (for fingerprint-keyed profiles looked up by name)
    for (const profile of Object.values(this.profiles)) {
      if (profile.agent === agentNameOrFingerprint) return profile;
    }
    return null;
  }

  /**
   * Get or create a trust profile for an agent.
   * New agents start as 'untrusted' with 'setup-default' source.
   */
  getOrCreateProfile(agentName: string): AgentTrustProfile {
    if (!this.profiles[agentName]) {
      const now = new Date().toISOString();
      this.profiles[agentName] = {
        agent: agentName,
        level: 'untrusted',
        source: 'setup-default',
        history: {
          messagesReceived: 0,
          messagesResponded: 0,
          successfulInteractions: 0,
          failedInteractions: 0,
          lastInteraction: '',
          streakSinceIncident: 0,
        },
        allowedOperations: [...DEFAULT_ALLOWED_OPS.untrusted],
        blockedOperations: [],
        createdAt: now,
        updatedAt: now,
      };
      this.save();
    }
    return this.profiles[agentName];
  }

  // ── Fingerprint-Based Access (for relay messages) ──────────────

  /**
   * Get trust profile by cryptographic fingerprint.
   * Used for relay inbound messages where identity is fingerprint-based.
   */
  getProfileByFingerprint(fingerprint: string): AgentTrustProfile | null {
    for (const profile of Object.values(this.profiles)) {
      if (profile.fingerprint === fingerprint) {
        return profile;
      }
    }
    return null;
  }

  /**
   * Get or create a trust profile keyed by fingerprint.
   * For relay agents, the fingerprint IS the identity.
   * Relay agents default to 'verified' (can send messages) rather than
   * 'untrusted' (probes only), since they've already authenticated with the relay.
   *
   * IMPORTANT: Always keys by fingerprint to avoid collisions between
   * same-named agents on different machines. Display name is stored in
   * the profile's `agent` field for human readability.
   */
  getOrCreateProfileByFingerprint(fingerprint: string, displayName?: string): AgentTrustProfile {
    // Check if profile already exists by fingerprint
    const existing = this.getProfileByFingerprint(fingerprint);
    if (existing) {
      // Update display name if provided and different
      if (displayName && existing.agent !== displayName && existing.agent === fingerprint) {
        existing.agent = displayName;
        this.scheduleSave();
      }
      return existing;
    }

    // Create new profile keyed by fingerprint to prevent same-name collisions
    const now = new Date().toISOString();
    this.profiles[fingerprint] = {
      agent: displayName ?? fingerprint,
      fingerprint,
      level: 'verified',
      source: 'setup-default',
      history: {
        messagesReceived: 0,
        messagesResponded: 0,
        successfulInteractions: 0,
        failedInteractions: 0,
        lastInteraction: '',
        streakSinceIncident: 0,
      },
      allowedOperations: [...DEFAULT_ALLOWED_OPS.verified],
      blockedOperations: [],
      createdAt: now,
      updatedAt: now,
    };
    this.save();
    return this.profiles[fingerprint];
  }

  /**
   * Get trust level by fingerprint. Returns 'untrusted' for unknown agents.
   */
  getTrustLevelByFingerprint(fingerprint: string): AgentTrustLevel {
    const profile = this.getProfileByFingerprint(fingerprint);
    return profile?.level ?? 'untrusted';
  }

  /**
   * Get allowed operations by fingerprint.
   */
  getAllowedOperationsByFingerprint(fingerprint: string): string[] {
    const profile = this.getProfileByFingerprint(fingerprint);
    if (!profile) return [...DEFAULT_ALLOWED_OPS.untrusted];
    return profile.allowedOperations.length > 0
      ? profile.allowedOperations
      : [...DEFAULT_ALLOWED_OPS[profile.level]];
  }

  /**
   * Set trust level by fingerprint.
   * Operates directly on the fingerprint-keyed profile to avoid
   * name collision issues with setTrustLevel's name-based lookup.
   */
  setTrustLevelByFingerprint(
    fingerprint: string,
    level: AgentTrustLevel,
    source: AgentTrustSource,
    reason?: string,
    displayName?: string,
  ): boolean {
    const profile = this.getOrCreateProfileByFingerprint(fingerprint, displayName);
    return this.applyTrustLevel(profile, level, source, reason);
  }

  /**
   * Record a received message by fingerprint (debounced save).
   */
  recordMessageReceivedByFingerprint(fingerprint: string): void {
    const profile = this.getOrCreateProfileByFingerprint(fingerprint);
    profile.history.messagesReceived++;
    profile.history.lastInteraction = new Date().toISOString();
    profile.updatedAt = new Date().toISOString();
    this.scheduleSave();
  }

  // ── Trust Level Management ──────────────────────────────────────

  /**
   * Set trust level for an agent (by name).
   * UPGRADES require source: 'user-granted' or 'paired-machine-granted'.
   * Returns true if the change was applied, false if rejected.
   */
  setTrustLevel(
    agentName: string,
    level: AgentTrustLevel,
    source: AgentTrustSource,
    reason?: string
  ): boolean {
    const profile = this.getOrCreateProfile(agentName);
    return this.applyTrustLevel(profile, level, source, reason);
  }

  /**
   * Core trust level application logic. Shared by name-based and fingerprint-based paths.
   */
  private applyTrustLevel(
    profile: AgentTrustProfile,
    level: AgentTrustLevel,
    source: AgentTrustSource,
    reason?: string,
  ): boolean {
    const previousLevel = profile.level;
    const agentName = profile.agent;

    // Upgrades require user-granted or paired-machine-granted source
    if (this.compareTrust(level, previousLevel) > 0) {
      if (source !== 'user-granted' && source !== 'paired-machine-granted') {
        return false;
      }
    }

    profile.level = level;
    profile.source = source;
    profile.updatedAt = new Date().toISOString();
    profile.allowedOperations = [...DEFAULT_ALLOWED_OPS[level]];

    this.save();
    this.writeAudit({
      timestamp: new Date().toISOString(),
      agent: agentName,
      previousLevel,
      newLevel: level,
      source,
      reason: reason ?? `Trust level changed to ${level}`,
      userInitiated: source === 'user-granted' || source === 'paired-machine-granted',
    });

    if (this.onTrustChange) {
      this.onTrustChange({
        agent: agentName,
        previousLevel,
        newLevel: level,
        reason: reason ?? `Trust level changed to ${level}`,
        userInitiated: source === 'user-granted' || source === 'paired-machine-granted',
      });
    }

    return true;
  }

  // ── Interaction Recording ───────────────────────────────────────

  /**
   * Record a successful or failed interaction with an agent.
   */
  recordInteraction(agentName: string, success: boolean, details?: string): void {
    const profile = this.getOrCreateProfile(agentName);
    const now = new Date().toISOString();

    profile.history.lastInteraction = now;

    if (success) {
      profile.history.successfulInteractions++;
      profile.history.streakSinceIncident++;
    } else {
      profile.history.failedInteractions++;
      profile.history.streakSinceIncident = 0;
    }

    profile.updatedAt = now;
    this.save();
  }

  /**
   * Record a received message from an agent.
   */
  recordMessageReceived(agentName: string): void {
    const profile = this.getOrCreateProfile(agentName);
    profile.history.messagesReceived++;
    profile.history.lastInteraction = new Date().toISOString();
    profile.updatedAt = new Date().toISOString();
    this.save();
  }

  /**
   * Record a response sent to an agent.
   */
  recordMessageResponded(agentName: string): void {
    const profile = this.getOrCreateProfile(agentName);
    profile.history.messagesResponded++;
    profile.updatedAt = new Date().toISOString();
    this.save();
  }

  // ── Permission Checking ─────────────────────────────────────────

  /**
   * Check if an agent is allowed to perform an operation.
   * Checks both trust-level defaults and explicit allowed/blocked lists.
   */
  checkPermission(agentName: string, operation: string): boolean {
    const profile = this.profiles[agentName];
    if (!profile) {
      // Unknown agent — only allow untrusted-level operations
      return DEFAULT_ALLOWED_OPS.untrusted.includes(operation);
    }

    // Explicitly blocked operations always take precedence
    if (profile.blockedOperations.includes(operation)) {
      return false;
    }

    // Check explicit allowed list
    if (profile.allowedOperations.includes(operation)) {
      return true;
    }

    // Fall back to trust level defaults
    return DEFAULT_ALLOWED_OPS[profile.level].includes(operation);
  }

  // ── Interaction Stats ───────────────────────────────────────────

  /**
   * Get interaction statistics for an agent.
   */
  getInteractionStats(agentName: string): InteractionStats | null {
    const profile = this.profiles[agentName];
    if (!profile) return null;

    const h = profile.history;
    const total = h.successfulInteractions + h.failedInteractions;

    return {
      messagesReceived: h.messagesReceived,
      messagesResponded: h.messagesResponded,
      successfulInteractions: h.successfulInteractions,
      failedInteractions: h.failedInteractions,
      successRate: total > 0 ? h.successfulInteractions / total : 0,
      streakSinceIncident: h.streakSinceIncident,
      lastInteraction: h.lastInteraction || null,
    };
  }

  // ── Auto-Downgrade ──────────────────────────────────────────────

  /**
   * Safety-only auto-downgrade. Never auto-upgrades.
   * Called by CircuitBreaker (3 activations in 24h) or on crypto failure.
   */
  autoDowngrade(agentName: string, reason: string): boolean {
    const profile = this.profiles[agentName];
    if (!profile) return false;

    const previousLevel = profile.level;
    if (previousLevel === 'untrusted') return false; // Already at lowest

    profile.level = 'untrusted';
    profile.updatedAt = new Date().toISOString();
    profile.allowedOperations = [...DEFAULT_ALLOWED_OPS.untrusted];

    this.save();
    this.writeAudit({
      timestamp: new Date().toISOString(),
      agent: agentName,
      previousLevel,
      newLevel: 'untrusted',
      source: 'system',
      reason,
      userInitiated: false,
    });

    if (this.onTrustChange) {
      this.onTrustChange({
        agent: agentName,
        previousLevel,
        newLevel: 'untrusted',
        reason,
        userInitiated: false,
      });
    }

    return true;
  }

  /**
   * Check for staleness-based auto-downgrade.
   * If an agent hasn't interacted in 90 days, downgrade one level.
   * Returns true if a downgrade occurred.
   */
  checkStalenessDowngrade(agentName: string, nowMs?: number): boolean {
    const profile = this.profiles[agentName];
    if (!profile) return false;
    if (profile.level === 'untrusted') return false;

    const now = nowMs ?? Date.now();
    const lastInteraction = profile.history.lastInteraction;
    if (!lastInteraction) return false;

    const elapsed = now - new Date(lastInteraction).getTime();
    if (elapsed < STALENESS_THRESHOLD_MS) return false;

    const previousLevel = profile.level;
    const currentIdx = TRUST_ORDER.indexOf(previousLevel);
    if (currentIdx <= 0) return false;

    const newLevel = TRUST_ORDER[currentIdx - 1];
    profile.level = newLevel;
    profile.updatedAt = new Date().toISOString();
    profile.allowedOperations = [...DEFAULT_ALLOWED_OPS[newLevel]];

    this.save();
    this.writeAudit({
      timestamp: new Date().toISOString(),
      agent: agentName,
      previousLevel,
      newLevel,
      source: 'system',
      reason: `No interaction for ${Math.floor(elapsed / (24 * 60 * 60 * 1000))} days — auto-downgrade`,
      userInitiated: false,
    });

    if (this.onTrustChange) {
      this.onTrustChange({
        agent: agentName,
        previousLevel,
        newLevel,
        reason: `Staleness auto-downgrade after ${Math.floor(elapsed / (24 * 60 * 60 * 1000))} days`,
        userInitiated: false,
      });
    }

    return true;
  }

  // ── Profile Listing ─────────────────────────────────────────────

  /**
   * List all trust profiles, optionally filtered by trust level.
   */
  listProfiles(filter?: { level?: AgentTrustLevel; source?: AgentTrustSource }): AgentTrustProfile[] {
    let profiles = Object.values(this.profiles);

    if (filter?.level) {
      profiles = profiles.filter(p => p.level === filter.level);
    }
    if (filter?.source) {
      profiles = profiles.filter(p => p.source === filter.source);
    }

    return profiles;
  }

  // ── Blocked Operations ──────────────────────────────────────────

  /**
   * Block a specific operation for an agent.
   */
  blockOperation(agentName: string, operation: string): void {
    const profile = this.getOrCreateProfile(agentName);
    if (!profile.blockedOperations.includes(operation)) {
      profile.blockedOperations.push(operation);
      profile.updatedAt = new Date().toISOString();
      this.save();
    }
  }

  /**
   * Unblock a specific operation for an agent.
   */
  unblockOperation(agentName: string, operation: string): void {
    const profile = this.getOrCreateProfile(agentName);
    profile.blockedOperations = profile.blockedOperations.filter(op => op !== operation);
    profile.updatedAt = new Date().toISOString();
    this.save();
  }

  // ── Audit Trail ─────────────────────────────────────────────────

  /**
   * Read audit trail entries. Returns all entries or last N entries.
   */
  readAuditTrail(limit?: number): TrustAuditEntry[] {
    try {
      if (!fs.existsSync(this.auditPath)) return [];
      const content = fs.readFileSync(this.auditPath, 'utf-8').trim();
      if (!content) return [];

      const entries = content.split('\n').map(line => {
        try { return JSON.parse(line) as TrustAuditEntry; }
        catch { return null; }
      }).filter((e): e is TrustAuditEntry => e !== null);

      if (limit && limit > 0) {
        return entries.slice(-limit);
      }
      return entries;
    } catch {
      return [];
    }
  }

  // ── Persistence ─────────────────────────────────────────────────

  /**
   * Force reload profiles from disk.
   */
  reload(): void {
    this.profiles = this.loadProfiles();
  }

  /**
   * Flush any pending saves and stop the debounce timer.
   * Call on shutdown for clean exit.
   */
  flush(): void {
    if (this.saveDirty) {
      this.save();
      this.saveDirty = false;
    }
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
  }

  // ── Private ─────────────────────────────────────────────────────

  /**
   * Schedule a debounced save (dirty-flag + interval flush).
   * Avoids synchronous disk writes on every message received.
   */
  private scheduleSave(): void {
    this.saveDirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setInterval(() => {
        if (this.saveDirty) {
          this.save();
          this.saveDirty = false;
        }
      }, 5000); // Flush every 5 seconds
      // Don't keep process alive just for this timer
      if (this.saveTimer.unref) this.saveTimer.unref();
    }
  }

  private loadProfiles(): Record<string, AgentTrustProfile> {
    const data = safeJsonParse<ProfilesFile>(this.profilesPath, {
      profiles: {},
      updatedAt: '',
    });
    return data.profiles;
  }

  private save(): void {
    try {
      const data: ProfilesFile = {
        profiles: this.profiles,
        updatedAt: new Date().toISOString(),
      };
      atomicWrite(this.profilesPath, JSON.stringify(data, null, 2));
    } catch {
      // Save failure should never break trust evaluation
    }
  }

  private writeAudit(entry: TrustAuditEntry): void {
    try {
      fs.appendFileSync(this.auditPath, JSON.stringify(entry) + '\n');
    } catch {
      // Audit failure should not break operations
    }
  }

  private compareTrust(a: AgentTrustLevel, b: AgentTrustLevel): number {
    return TRUST_ORDER.indexOf(a) - TRUST_ORDER.indexOf(b);
  }
}
