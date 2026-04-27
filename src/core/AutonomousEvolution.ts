/**
 * AutonomousEvolution — Auto-approval and auto-implementation of evolution proposals.
 *
 * Part of Phase 3 of the Adaptive Autonomy System.
 *
 * When autonomyProfile allows autonomous evolution:
 * - Proposals that pass review are auto-approved
 * - Safe proposals (definedSteps, description, learnings) are auto-implemented
 * - Unsafe proposals (schedule, model, priority, gate, execute) require human approval
 * - Every self-modification produces a notification
 * - Operator can revert any change conversationally
 *
 * Sidecar pattern: Job changes write to {slug}.proposed-changes.json,
 * merged at load time. Original jobs.json is never modified by autonomous evolution.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { EvolutionProposal } from './types.js';

// ── Types ────────────────────────────────────────────────────────────

export type ReviewDecision = 'approve' | 'reject' | 'needs-review';

export interface ReviewResult {
  decision: ReviewDecision;
  reason: string;
  /** What the proposal changes — used for scope classification */
  affectedFields: string[];
  /** AI confidence score 0-1 */
  confidence: number;
}

/** Fields that are safe for autonomous implementation */
const SAFE_FIELDS = new Set([
  'definedSteps',
  'description',
  'name',
  'tags',
  'learnings',
]);

/** Fields that require human approval regardless of profile */
const UNSAFE_FIELDS = new Set([
  'schedule',
  'model',
  'priority',
  'gate',
  'execute',
  'enabled',
]);

export type ScopeClassification = 'safe' | 'unsafe' | 'mixed';

export interface ProposedJobChange {
  /** The job slug this change applies to */
  jobSlug: string;
  /** The proposal that generated this change */
  proposalId: string;
  /** What fields are being changed */
  changes: Record<string, unknown>;
  /** When the change was proposed */
  proposedAt: string;
  /** When the change was applied (null if pending) */
  appliedAt: string | null;
  /** Whether this has been reverted */
  reverted: boolean;
  /** Revert timestamp */
  revertedAt: string | null;
}

export interface EvolutionNotification {
  /** The proposal that was acted on */
  proposalId: string;
  /** Proposal title */
  title: string;
  /** What happened */
  action: 'auto-approved' | 'auto-implemented' | 'rejected' | 'needs-review' | 'reverted';
  /** Source of the proposal */
  source: string;
  /** Review confidence */
  confidence: number;
  /** Scope classification */
  scope: ScopeClassification;
  /** Timestamp */
  timestamp: string;
  /** Additional details */
  details: string;
}

export interface AutonomousEvolutionConfig {
  stateDir: string;
  /** Whether autonomous evolution is enabled */
  enabled?: boolean;
}

export interface AutonomousEvolutionState {
  /** Pending sidecar changes not yet applied */
  pendingSidecars: ProposedJobChange[];
  /** Applied sidecar changes (for revert) */
  appliedSidecars: ProposedJobChange[];
  /** Notification queue (for digest mode) */
  notificationQueue: EvolutionNotification[];
  /** Sent notifications (history) */
  notificationHistory: EvolutionNotification[];
  /** Last update */
  lastUpdated: string;
}

// ── Implementation ───────────────────────────────────────────────────

export class AutonomousEvolution {
  private config: AutonomousEvolutionConfig;
  private statePath: string;
  private state: AutonomousEvolutionState;

  constructor(config: AutonomousEvolutionConfig) {
    this.config = config;
    this.statePath = path.join(config.stateDir, 'state', 'autonomous-evolution.json');
    this.state = this.loadOrCreate();
  }

  // ── Scope Classification ─────────────────────────────────────────

  /**
   * Classify whether a proposal's affected fields are safe for autonomous implementation.
   */
  classifyScope(affectedFields: string[]): ScopeClassification {
    if (affectedFields.length === 0) return 'safe';

    const hasSafe = affectedFields.some(f => SAFE_FIELDS.has(f));
    const hasUnsafe = affectedFields.some(f => UNSAFE_FIELDS.has(f));

    if (hasUnsafe && hasSafe) return 'mixed';
    if (hasUnsafe) return 'unsafe';
    return 'safe';
  }

  /**
   * Determine whether a reviewed proposal should be auto-implemented.
   * Returns the action to take.
   */
  evaluateForAutoImplementation(
    review: ReviewResult,
    autonomousMode: boolean,
  ): { action: 'auto-implement' | 'queue-for-approval' | 'reject' | 'needs-review'; reason: string } {
    // Rejections are always rejections
    if (review.decision === 'reject') {
      return { action: 'reject', reason: review.reason };
    }

    // Uncertain reviews always need human review
    if (review.decision === 'needs-review') {
      return { action: 'needs-review', reason: review.reason };
    }

    // Not in autonomous mode — queue for human approval
    if (!autonomousMode) {
      return { action: 'queue-for-approval', reason: 'Evolution governance is ai-assisted — proposal queued for human approval.' };
    }

    // In autonomous mode — check scope
    const scope = this.classifyScope(review.affectedFields);

    if (scope === 'unsafe') {
      return {
        action: 'queue-for-approval',
        reason: `Proposal affects restricted fields (${review.affectedFields.filter(f => UNSAFE_FIELDS.has(f)).join(', ')}). Requires human approval even in autonomous mode.`,
      };
    }

    if (scope === 'mixed') {
      return {
        action: 'queue-for-approval',
        reason: `Proposal contains both safe and restricted changes. Requires human approval for the restricted portion.`,
      };
    }

    // Safe scope + autonomous mode + approved by review
    return {
      action: 'auto-implement',
      reason: `Review approved (confidence: ${(review.confidence * 100).toFixed(0)}%). Scope is safe (${review.affectedFields.join(', ') || 'no field changes'}).`,
    };
  }

  // ── Sidecar Management ───────────────────────────────────────────

  /**
   * Create a sidecar file for proposed job changes.
   * The sidecar is a JSON file alongside jobs.json that gets merged at load time.
   */
  createSidecar(jobSlug: string, proposalId: string, changes: Record<string, unknown>): ProposedJobChange {
    const sidecar: ProposedJobChange = {
      jobSlug,
      proposalId,
      changes,
      proposedAt: new Date().toISOString(),
      appliedAt: null,
      reverted: false,
      revertedAt: null,
    };

    this.state.pendingSidecars.push(sidecar);
    this.state.lastUpdated = new Date().toISOString();
    this.save();

    // Write sidecar file to disk
    this.writeSidecarFile(jobSlug, sidecar);

    return sidecar;
  }

  /**
   * Apply a pending sidecar (mark it as applied).
   */
  applySidecar(proposalId: string): boolean {
    const idx = this.state.pendingSidecars.findIndex(s => s.proposalId === proposalId);
    if (idx === -1) return false;

    const sidecar = this.state.pendingSidecars[idx];
    sidecar.appliedAt = new Date().toISOString();

    this.state.pendingSidecars.splice(idx, 1);
    this.state.appliedSidecars.push(sidecar);
    this.state.lastUpdated = new Date().toISOString();
    this.save();

    return true;
  }

  /**
   * Revert a previously applied sidecar.
   */
  revertSidecar(proposalId: string): boolean {
    const sidecar = this.state.appliedSidecars.find(s => s.proposalId === proposalId && !s.reverted);
    if (!sidecar) return false;

    sidecar.reverted = true;
    sidecar.revertedAt = new Date().toISOString();

    // Remove the sidecar file from disk
    this.removeSidecarFile(sidecar.jobSlug);

    this.state.lastUpdated = new Date().toISOString();
    this.save();

    return true;
  }

  /**
   * Get all pending sidecars for a specific job slug.
   */
  getPendingSidecars(jobSlug?: string): ProposedJobChange[] {
    if (jobSlug) {
      return this.state.pendingSidecars.filter(s => s.jobSlug === jobSlug);
    }
    return [...this.state.pendingSidecars];
  }

  /**
   * Get all applied (non-reverted) sidecars.
   */
  getAppliedSidecars(): ProposedJobChange[] {
    return this.state.appliedSidecars.filter(s => !s.reverted);
  }

  /**
   * Get all reverted sidecars.
   */
  getRevertedSidecars(): ProposedJobChange[] {
    return this.state.appliedSidecars.filter(s => s.reverted);
  }

  /**
   * Load sidecar changes for a job slug from disk.
   * Called by JobLoader at load time to merge changes.
   */
  loadSidecarForJob(jobSlug: string): Record<string, unknown> | null {
    const sidecarPath = this.sidecarPath(jobSlug);
    if (!fs.existsSync(sidecarPath)) return null;

    try {
      const raw = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
      return raw.changes ?? null;
    } catch {
      return null;
    }
  }

  // ── Notification Contract ────────────────────────────────────────

  /**
   * Create a notification for an evolution action.
   */
  createNotification(
    proposal: EvolutionProposal,
    action: EvolutionNotification['action'],
    review: ReviewResult,
    details: string,
  ): EvolutionNotification {
    const notification: EvolutionNotification = {
      proposalId: proposal.id,
      title: proposal.title,
      action,
      source: proposal.source,
      confidence: review.confidence,
      scope: this.classifyScope(review.affectedFields),
      timestamp: new Date().toISOString(),
      details,
    };

    this.state.notificationQueue.push(notification);
    this.state.lastUpdated = new Date().toISOString();
    this.save();

    return notification;
  }

  /**
   * Drain the notification queue (for immediate mode).
   * Returns all pending notifications and clears the queue.
   */
  drainNotifications(): EvolutionNotification[] {
    const notifications = [...this.state.notificationQueue];
    this.state.notificationHistory.push(...notifications);
    this.state.notificationQueue = [];

    // Keep history manageable
    if (this.state.notificationHistory.length > 200) {
      this.state.notificationHistory = this.state.notificationHistory.slice(-200);
    }

    this.state.lastUpdated = new Date().toISOString();
    this.save();
    return notifications;
  }

  /**
   * Get the current notification queue (for digest mode — peek without draining).
   */
  peekNotifications(): EvolutionNotification[] {
    return [...this.state.notificationQueue];
  }

  /**
   * Get notification history.
   */
  getNotificationHistory(limit: number = 50): EvolutionNotification[] {
    return this.state.notificationHistory.slice(-limit);
  }

  /**
   * Format a notification as a conversational Telegram message.
   */
  formatNotification(notification: EvolutionNotification): string {
    const lines: string[] = [];

    switch (notification.action) {
      case 'auto-approved':
        lines.push('Evolution Auto-Approved');
        lines.push('');
        lines.push(`${notification.proposalId}: ${notification.title}`);
        lines.push(`Source: ${notification.source}`);
        lines.push(`Confidence: ${(notification.confidence * 100).toFixed(0)}%`);
        lines.push('');
        lines.push(notification.details);
        lines.push('');
        lines.push(`Reply "undo ${notification.proposalId}" to revert.`);
        break;

      case 'auto-implemented':
        lines.push('Self-Evolution Applied');
        lines.push('');
        lines.push(`${notification.proposalId}: ${notification.title}`);
        lines.push(`Source: ${notification.source}`);
        lines.push(`Confidence: ${(notification.confidence * 100).toFixed(0)}%`);
        lines.push(`Scope: ${notification.scope}`);
        lines.push('');
        lines.push(notification.details);
        lines.push('');
        lines.push(`Reply "undo ${notification.proposalId}" to revert, or "tell me more" for details.`);
        break;

      case 'rejected':
        lines.push('Evolution Rejected');
        lines.push('');
        lines.push(`${notification.proposalId}: ${notification.title}`);
        lines.push(`Reason: ${notification.details}`);
        break;

      case 'needs-review':
        lines.push('Evolution Needs Review');
        lines.push('');
        lines.push(`${notification.proposalId}: ${notification.title}`);
        lines.push(`Source: ${notification.source}`);
        lines.push('');
        lines.push(notification.details);
        lines.push('');
        lines.push(`Reply "approve ${notification.proposalId}" or "reject ${notification.proposalId}".`);
        break;

      case 'reverted':
        lines.push('Evolution Reverted');
        lines.push('');
        lines.push(`${notification.proposalId}: ${notification.title}`);
        lines.push('Change has been undone. Original behavior restored.');
        break;
    }

    return lines.join('\n');
  }

  /**
   * Format multiple notifications as a digest message.
   */
  formatDigest(notifications: EvolutionNotification[]): string {
    if (notifications.length === 0) return '';

    const lines: string[] = [];
    lines.push(`Evolution Digest (${notifications.length} items)`);
    lines.push('');

    for (const n of notifications) {
      const icon = n.action === 'auto-implemented' ? 'Applied'
        : n.action === 'auto-approved' ? 'Approved'
        : n.action === 'rejected' ? 'Rejected'
        : n.action === 'needs-review' ? 'Needs Review'
        : 'Reverted';
      lines.push(`${icon}: ${n.proposalId} — ${n.title}`);
    }

    const needsReview = notifications.filter(n => n.action === 'needs-review');
    if (needsReview.length > 0) {
      lines.push('');
      lines.push(`${needsReview.length} item(s) need your review.`);
    }

    return lines.join('\n');
  }

  // ── Dashboard ────────────────────────────────────────────────────

  /**
   * Get the full autonomous evolution dashboard.
   */
  getDashboard(): {
    enabled: boolean;
    pendingSidecars: ProposedJobChange[];
    appliedSidecars: ProposedJobChange[];
    revertedSidecars: ProposedJobChange[];
    notificationQueue: EvolutionNotification[];
    recentHistory: EvolutionNotification[];
    lastUpdated: string;
  } {
    return {
      enabled: this.config.enabled !== false,
      pendingSidecars: this.getPendingSidecars(),
      appliedSidecars: this.getAppliedSidecars(),
      revertedSidecars: this.getRevertedSidecars(),
      notificationQueue: this.peekNotifications(),
      recentHistory: this.getNotificationHistory(10),
      lastUpdated: this.state.lastUpdated,
    };
  }

  // ── Private ──────────────────────────────────────────────────────

  private sidecarPath(jobSlug: string): string {
    return path.join(this.config.stateDir, 'state', 'jobs', `${jobSlug}.proposed-changes.json`);
  }

  private writeSidecarFile(jobSlug: string, sidecar: ProposedJobChange): void {
    try {
      const dir = path.join(this.config.stateDir, 'state', 'jobs');
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.sidecarPath(jobSlug), JSON.stringify(sidecar, null, 2));
    } catch {
      // Non-fatal
    }
  }

  private removeSidecarFile(jobSlug: string): void {
    try {
      const p = this.sidecarPath(jobSlug);
      if (fs.existsSync(p)) {
        // safe-git-allow: incremental-migration
        fs.unlinkSync(p);
      }
    } catch {
      // Non-fatal
    }
  }

  private loadOrCreate(): AutonomousEvolutionState {
    if (fs.existsSync(this.statePath)) {
      try {
        return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      } catch {
        // Corrupt — recreate
      }
    }

    return {
      pendingSidecars: [],
      appliedSidecars: [],
      notificationQueue: [],
      notificationHistory: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  private save(): void {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch {
      // Non-fatal
    }
  }
}
