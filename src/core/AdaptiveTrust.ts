/**
 * Adaptive Trust — Organic trust evolution between agent and user.
 *
 * Trust is not a config value set at install time. It's a living dimension
 * of the relationship that grows through successful interaction and contracts
 * when things go wrong.
 *
 * Trust is tracked per service and per operation type:
 * - "I trust you with reading email but not deleting it"
 * - "You've done 20 calendar operations without issues, I'll stop asking"
 * - "After that incident, always ask before modifying emails"
 *
 * Three ways trust changes:
 * 1. Earned — consistent successful operations build trust automatically
 * 2. Granted — user explicitly says "you don't need to ask me about X"
 * 3. Revoked — incident or user explicit "always ask about X"
 *
 * Design principle: Trust can never auto-escalate to "autonomous."
 * Only explicit user statements can grant that level. The trust floor
 * prevents silent escalation past a safety minimum.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { OperationMutability, TrustLevel, TrustSource, AutonomyBehavior } from './ExternalOperationGate.js';

// ── Types ────────────────────────────────────────────────────────────

export interface TrustProfile {
  /** Per-service trust scores */
  services: Record<string, ServiceTrust>;
  /** Global trust modifiers */
  global: {
    /** Overall relationship maturity (0-1), grows over time */
    maturity: number;
    /** Last trust-affecting event description */
    lastEvent: string;
    /** Last trust change timestamp */
    lastEventAt: string;
    /** Trust floor — never auto-escalate below this */
    floor: 'supervised' | 'collaborative';
  };
}

export interface ServiceTrust {
  /** Service name */
  service: string;
  /** Per-operation-type trust */
  operations: Record<OperationMutability, TrustEntry>;
  /** Track record */
  history: TrustHistory;
}

export interface TrustEntry {
  /** Current effective trust level */
  level: TrustLevel;
  /** How this level was set */
  source: TrustSource;
  /** When it was last changed */
  changedAt: string;
  /** If user-explicit, what they said */
  userStatement?: string;
}

export interface TrustHistory {
  /** Successful operations without incident */
  successCount: number;
  /** Operations that were stopped or rolled back */
  incidentCount: number;
  /** Last incident timestamp */
  lastIncident?: string;
  /** Consecutive successes since last incident */
  streakSinceIncident: number;
}

export interface TrustChangeEvent {
  /** What changed */
  service: string;
  /** Which operation type */
  operation: OperationMutability;
  /** Previous trust level */
  from: TrustLevel;
  /** New trust level */
  to: TrustLevel;
  /** How the change happened */
  source: TrustSource;
  /** Timestamp */
  timestamp: string;
  /** Context (user statement or automatic reason) */
  reason: string;
}

export interface AdaptiveTrustConfig {
  /** State directory for trust profile persistence */
  stateDir: string;
  /** Trust floor (default: 'collaborative') */
  floor?: 'supervised' | 'collaborative';
  /** Enable automatic trust elevation (default: true) */
  autoElevateEnabled?: boolean;
  /** Consecutive successes before suggesting elevation (default: 5) */
  elevationThreshold?: number;
  /** Trust level to drop to on incident (default: 'approve-always') */
  incidentDropLevel?: TrustLevel;
}

export interface TrustElevationSuggestion {
  /** Service this suggestion is for */
  service: string;
  /** Operation type */
  operation: OperationMutability;
  /** Current level */
  currentLevel: TrustLevel;
  /** Suggested level */
  suggestedLevel: TrustLevel;
  /** Why */
  reason: string;
  /** Track record that justifies this */
  streak: number;
}

// ── Constants ────────────────────────────────────────────────────────

/** Default trust for operations when no explicit config exists */
const DEFAULT_TRUST: Record<OperationMutability, TrustLevel> = {
  read: 'autonomous',
  write: 'log',
  modify: 'approve-always',
  delete: 'approve-always',
};

/** Trust levels ordered from most restrictive to least */
const TRUST_ORDER: TrustLevel[] = ['blocked', 'approve-always', 'approve-first', 'log', 'autonomous'];

/** Maximum auto-elevation level — can never auto-elevate past this */
const MAX_AUTO_LEVEL: TrustLevel = 'log';

// ── Implementation ───────────────────────────────────────────────────

export class AdaptiveTrust {
  private config: AdaptiveTrustConfig;
  private profilePath: string;
  private profile: TrustProfile;
  private changeLog: TrustChangeEvent[] = [];

  constructor(config: AdaptiveTrustConfig) {
    this.config = config;
    this.profilePath = path.join(config.stateDir, 'state', 'trust-profile.json');
    this.profile = this.loadOrCreateProfile();
  }

  /**
   * Get the trust level for a specific service + operation.
   */
  getTrustLevel(service: string, operation: OperationMutability): TrustEntry {
    const serviceTrust = this.profile.services[service];
    if (!serviceTrust) {
      // No trust data for this service — return defaults
      const now = new Date().toISOString();
      return {
        level: DEFAULT_TRUST[operation],
        source: 'default',
        changedAt: now,
      };
    }

    return serviceTrust.operations[operation] ?? {
      level: DEFAULT_TRUST[operation],
      source: 'default',
      changedAt: new Date().toISOString(),
    };
  }

  /**
   * Map a trust level to an autonomy behavior for the ExternalOperationGate.
   */
  trustToAutonomy(trustLevel: TrustLevel): AutonomyBehavior {
    switch (trustLevel) {
      case 'blocked': return 'block';
      case 'approve-always': return 'approve';
      case 'approve-first': return 'approve';
      case 'log': return 'log';
      case 'autonomous': return 'proceed';
    }
  }

  /**
   * Record a successful operation — builds trust over time.
   */
  recordSuccess(service: string, operation: OperationMutability): TrustElevationSuggestion | null {
    const serviceTrust = this.ensureServiceTrust(service);
    serviceTrust.history.successCount++;
    serviceTrust.history.streakSinceIncident++;

    this.save();

    // Check if we should suggest elevation
    if (this.config.autoElevateEnabled !== false) {
      return this.checkElevation(service, operation);
    }

    return null;
  }

  /**
   * Record an incident (stop, abort, rollback) — trust drops.
   */
  recordIncident(service: string, operation: OperationMutability, reason: string): TrustChangeEvent | null {
    const serviceTrust = this.ensureServiceTrust(service);
    const dropLevel = this.config.incidentDropLevel ?? 'approve-always';

    serviceTrust.history.incidentCount++;
    serviceTrust.history.lastIncident = new Date().toISOString();
    serviceTrust.history.streakSinceIncident = 0;

    const currentEntry = serviceTrust.operations[operation];
    const currentLevel = currentEntry?.level ?? DEFAULT_TRUST[operation];

    // Only drop if current level is less restrictive than drop level
    if (this.compareTrust(currentLevel, dropLevel) > 0) {
      const event = this.setTrustLevel(service, operation, dropLevel, 'revoked', reason);
      this.save();
      return event;
    }

    this.save();
    return null;
  }

  /**
   * User explicitly grants or revokes trust.
   *
   * Examples:
   * - grantTrust('gmail', 'delete', 'autonomous', "You don't need to ask me about deleting emails")
   * - grantTrust('gmail', 'write', 'approve-always', "Always ask before sending emails")
   */
  grantTrust(
    service: string,
    operation: OperationMutability,
    level: TrustLevel,
    userStatement: string
  ): TrustChangeEvent {
    this.ensureServiceTrust(service);
    const event = this.setTrustLevel(service, operation, level, 'user-explicit', userStatement);
    this.save();
    return event;
  }

  /**
   * User grants trust for ALL operations on a service.
   */
  grantServiceTrust(service: string, level: TrustLevel, userStatement: string): TrustChangeEvent[] {
    const operations: OperationMutability[] = ['read', 'write', 'modify', 'delete'];
    const events: TrustChangeEvent[] = [];

    for (const op of operations) {
      events.push(this.grantTrust(service, op, level, userStatement));
    }

    return events;
  }

  /**
   * Get the full trust profile.
   */
  getProfile(): TrustProfile {
    return JSON.parse(JSON.stringify(this.profile));
  }

  /**
   * Get trust history for a service.
   */
  getServiceHistory(service: string): TrustHistory | null {
    return this.profile.services[service]?.history ?? null;
  }

  /**
   * Get all pending elevation suggestions.
   * These are services/operations where the agent has earned enough
   * trust to suggest reducing friction.
   */
  getPendingElevations(): TrustElevationSuggestion[] {
    if (this.config.autoElevateEnabled === false) return [];

    const suggestions: TrustElevationSuggestion[] = [];
    const threshold = this.config.elevationThreshold ?? 5;

    for (const [service, trust] of Object.entries(this.profile.services)) {
      for (const op of ['read', 'write', 'modify', 'delete'] as OperationMutability[]) {
        const entry = trust.operations[op];
        if (!entry) continue;

        // Skip user-explicit or already at max auto level
        if (entry.source === 'user-explicit') continue;
        if (this.compareTrust(entry.level, MAX_AUTO_LEVEL) >= 0) continue;

        if (trust.history.streakSinceIncident >= threshold) {
          const nextLevel = this.nextTrustLevel(entry.level);
          if (nextLevel && this.compareTrust(nextLevel, MAX_AUTO_LEVEL) <= 0) {
            suggestions.push({
              service,
              operation: op,
              currentLevel: entry.level,
              suggestedLevel: nextLevel,
              reason: `${trust.history.streakSinceIncident} consecutive successful operations without incident.`,
              streak: trust.history.streakSinceIncident,
            });
          }
        }
      }
    }

    return suggestions;
  }

  /**
   * Get recent trust change events.
   */
  getChangeLog(): TrustChangeEvent[] {
    return [...this.changeLog];
  }

  /**
   * Get a compact summary of the trust state.
   */
  getSummary(): string {
    const lines: string[] = [];
    lines.push(`Trust floor: ${this.profile.global.floor}`);
    lines.push(`Maturity: ${(this.profile.global.maturity * 100).toFixed(0)}%`);

    for (const [service, trust] of Object.entries(this.profile.services)) {
      const ops = Object.entries(trust.operations)
        .map(([op, entry]) => `${op}=${entry.level}`)
        .join(', ');
      lines.push(`${service}: ${ops} (streak: ${trust.history.streakSinceIncident})`);
    }

    if (Object.keys(this.profile.services).length === 0) {
      lines.push('No services configured yet.');
    }

    return lines.join('\n');
  }

  // ── Private Methods ──────────────────────────────────────────────

  private ensureServiceTrust(service: string): ServiceTrust {
    if (!this.profile.services[service]) {
      const now = new Date().toISOString();
      this.profile.services[service] = {
        service,
        operations: {
          read: { level: DEFAULT_TRUST.read, source: 'default', changedAt: now },
          write: { level: DEFAULT_TRUST.write, source: 'default', changedAt: now },
          modify: { level: DEFAULT_TRUST.modify, source: 'default', changedAt: now },
          delete: { level: DEFAULT_TRUST.delete, source: 'default', changedAt: now },
        },
        history: {
          successCount: 0,
          incidentCount: 0,
          streakSinceIncident: 0,
        },
      };
    }
    return this.profile.services[service];
  }

  private setTrustLevel(
    service: string,
    operation: OperationMutability,
    level: TrustLevel,
    source: TrustSource,
    reason: string
  ): TrustChangeEvent {
    const serviceTrust = this.ensureServiceTrust(service);
    const current = serviceTrust.operations[operation];
    const now = new Date().toISOString();

    const event: TrustChangeEvent = {
      service,
      operation,
      from: current.level,
      to: level,
      source,
      timestamp: now,
      reason,
    };

    serviceTrust.operations[operation] = {
      level,
      source,
      changedAt: now,
      userStatement: source === 'user-explicit' ? reason : undefined,
    };

    // Update global
    this.profile.global.lastEvent = `${service}.${operation}: ${current.level} → ${level}`;
    this.profile.global.lastEventAt = now;

    this.changeLog.push(event);
    return event;
  }

  private checkElevation(service: string, operation: OperationMutability): TrustElevationSuggestion | null {
    const serviceTrust = this.profile.services[service];
    if (!serviceTrust) return null;

    const entry = serviceTrust.operations[operation];
    if (!entry) return null;

    const threshold = this.config.elevationThreshold ?? 5;

    // Don't suggest elevation for user-explicit levels
    if (entry.source === 'user-explicit') return null;

    // Don't elevate past the max auto level
    if (this.compareTrust(entry.level, MAX_AUTO_LEVEL) >= 0) return null;

    // Check streak
    if (serviceTrust.history.streakSinceIncident >= threshold) {
      const nextLevel = this.nextTrustLevel(entry.level);
      if (nextLevel && this.compareTrust(nextLevel, MAX_AUTO_LEVEL) <= 0) {
        return {
          service,
          operation,
          currentLevel: entry.level,
          suggestedLevel: nextLevel,
          reason: `${serviceTrust.history.streakSinceIncident} consecutive successful operations without incident.`,
          streak: serviceTrust.history.streakSinceIncident,
        };
      }
    }

    return null;
  }

  /**
   * Compare two trust levels.
   * Returns positive if a is LESS restrictive than b,
   * negative if a is MORE restrictive, 0 if equal.
   */
  private compareTrust(a: TrustLevel, b: TrustLevel): number {
    return TRUST_ORDER.indexOf(a) - TRUST_ORDER.indexOf(b);
  }

  /**
   * Get the next trust level up (less restrictive).
   */
  private nextTrustLevel(current: TrustLevel): TrustLevel | null {
    const idx = TRUST_ORDER.indexOf(current);
    if (idx < 0 || idx >= TRUST_ORDER.length - 1) return null;
    return TRUST_ORDER[idx + 1];
  }

  private loadOrCreateProfile(): TrustProfile {
    if (fs.existsSync(this.profilePath)) {
      try {
        return JSON.parse(fs.readFileSync(this.profilePath, 'utf-8'));
      } catch {
        // Corrupt file — start fresh
      }
    }

    return {
      services: {},
      global: {
        maturity: 0,
        lastEvent: 'Profile created',
        lastEventAt: new Date().toISOString(),
        floor: this.config.floor ?? 'collaborative',
      },
    };
  }

  private save(): void {
    try {
      const dir = path.dirname(this.profilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.profilePath, JSON.stringify(this.profile, null, 2));
    } catch {
      // Save failure should never break trust evaluation
    }
  }
}
