/**
 * Evolution Manager — the feedback loop that turns running into evolving.
 *
 * Four subsystems, one principle: every interaction is an opportunity
 * to improve. Not during batch reflection hours later, but at the
 * moment the insight is freshest.
 *
 * Subsystems:
 * 1. Evolution Queue — staged self-improvement proposals
 * 2. Learning Registry — structured, searchable insights
 * 3. Capability Gap Tracker — "what am I missing?"
 * 4. Action Queue — commitment tracking with stale detection
 *
 * Born from Portal's engagement pipeline (Steps 8-11) and proven
 * across 100+ evolution proposals and 10 platform engagement skills.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  EvolutionProposal,
  EvolutionType,
  EvolutionStatus,
  LearningEntry,
  LearningSource,
  CapabilityGap,
  GapCategory,
  ActionItem,
  EvolutionManagerConfig,
} from './types.js';
import type { TrustElevationTracker } from './TrustElevationTracker.js';
import type { AutonomousEvolution, ReviewResult } from './AutonomousEvolution.js';
import type { AutonomyProfileManager } from './AutonomyProfileManager.js';

interface EvolutionState {
  proposals: EvolutionProposal[];
  stats: {
    totalProposals: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    lastUpdated: string;
  };
}

interface LearningState {
  learnings: LearningEntry[];
  stats: {
    totalLearnings: number;
    applied: number;
    pending: number;
    byCategory: Record<string, number>;
    lastUpdated: string;
  };
}

interface GapState {
  gaps: CapabilityGap[];
  stats: {
    totalGaps: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
    addressed: number;
    lastUpdated: string;
  };
}

interface ActionState {
  actions: ActionItem[];
  stats: {
    totalActions: number;
    pending: number;
    completed: number;
    overdue: number;
    lastUpdated: string;
  };
}

export class EvolutionManager {
  private stateDir: string;
  private config: EvolutionManagerConfig;
  private trustElevationTracker: TrustElevationTracker | null = null;
  private autonomousEvolution: AutonomousEvolution | null = null;
  private autonomyManager: AutonomyProfileManager | null = null;

  constructor(config: EvolutionManagerConfig) {
    this.config = config;
    this.stateDir = config.stateDir;
  }

  /**
   * Wire adaptive autonomy modules for runtime integration.
   * - TrustElevationTracker: receives proposal approval/rejection events
   * - AutonomousEvolution: handles auto-implementation when in autonomous mode
   * - AutonomyProfileManager: provides current autonomy profile state
   */
  setAdaptiveAutonomyModules(modules: {
    trustElevationTracker?: TrustElevationTracker | null;
    autonomousEvolution?: AutonomousEvolution | null;
    autonomyManager?: AutonomyProfileManager | null;
  }): void {
    this.trustElevationTracker = modules.trustElevationTracker ?? null;
    this.autonomousEvolution = modules.autonomousEvolution ?? null;
    this.autonomyManager = modules.autonomyManager ?? null;
  }

  /**
   * Get the wired TrustElevationTracker (for external access, e.g. routes).
   */
  getTrustElevationTracker(): TrustElevationTracker | null {
    return this.trustElevationTracker;
  }

  /**
   * Get the wired AutonomousEvolution module (for external access, e.g. routes).
   */
  getAutonomousEvolution(): AutonomousEvolution | null {
    return this.autonomousEvolution;
  }

  // ── File I/O ────────────────────────────────────────────────────

  private filePath(name: string): string {
    return path.join(this.stateDir, 'state', 'evolution', `${name}.json`);
  }

  private readFile<T>(name: string, defaultValue: T): T {
    const fp = this.filePath(name);
    if (!fs.existsSync(fp)) return defaultValue;
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    } catch {
      console.warn(`[EvolutionManager] Corrupted file: ${fp}`);
      return defaultValue;
    }
  }

  private writeFile<T>(name: string, data: T): void {
    const fp = this.filePath(name);
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = fp + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, fp);
    } catch (err) {
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  private now(): string {
    return new Date().toISOString();
  }

  // ── Evolution Queue ─────────────────────────────────────────────

  private loadEvolution(): EvolutionState {
    return this.readFile<EvolutionState>('evolution-queue', {
      proposals: [],
      stats: { totalProposals: 0, byStatus: {}, byType: {}, lastUpdated: this.now() },
    });
  }

  private saveEvolution(state: EvolutionState): void {
    // Recompute stats
    const statusCounts: Record<string, number> = {};
    const typeCounts: Record<string, number> = {};
    for (const p of state.proposals) {
      statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
      typeCounts[p.type] = (typeCounts[p.type] || 0) + 1;
    }
    state.stats = {
      totalProposals: state.proposals.length,
      byStatus: statusCounts,
      byType: typeCounts,
      lastUpdated: this.now(),
    };

    // Archive old implemented/rejected proposals if over limit
    const max = this.config.maxProposals || 200;
    if (state.proposals.length > max) {
      const active = state.proposals.filter(p => !['implemented', 'rejected'].includes(p.status));
      const archived = state.proposals.filter(p => ['implemented', 'rejected'].includes(p.status));
      // Keep most recent archived
      const keep = archived.slice(-Math.max(0, max - active.length));
      state.proposals = [...active, ...keep];
    }

    this.writeFile('evolution-queue', state);
  }

  private nextProposalId(state: EvolutionState): string {
    const existing = new Set(state.proposals.map(p => p.id));
    let num = 1;
    while (existing.has(`EVO-${String(num).padStart(3, '0')}`)) num++;
    return `EVO-${String(num).padStart(3, '0')}`;
  }

  addProposal(opts: {
    title: string;
    source: string;
    description: string;
    type: EvolutionType;
    impact?: 'high' | 'medium' | 'low';
    effort?: 'high' | 'medium' | 'low';
    proposedBy?: string;
    tags?: string[];
  }): EvolutionProposal {
    const state = this.loadEvolution();
    const id = this.nextProposalId(state);
    const proposal: EvolutionProposal = {
      id,
      title: opts.title,
      source: opts.source,
      description: opts.description,
      type: opts.type,
      impact: opts.impact || 'medium',
      effort: opts.effort || 'medium',
      status: 'proposed',
      proposedBy: opts.proposedBy || 'agent',
      proposedAt: this.now(),
      tags: opts.tags,
    };
    state.proposals.push(proposal);
    this.saveEvolution(state);
    return proposal;
  }

  updateProposalStatus(id: string, status: EvolutionStatus, resolution?: string): boolean {
    const state = this.loadEvolution();
    const proposal = state.proposals.find(p => p.id === id);
    if (!proposal) return false;
    proposal.status = status;
    if (resolution) proposal.resolution = resolution;
    if (status === 'implemented') proposal.implementedAt = this.now();
    this.saveEvolution(state);

    // Feed decision to TrustElevationTracker for acceptance rate tracking
    if (this.trustElevationTracker && (status === 'approved' || status === 'rejected')) {
      const decision = status === 'approved' ? 'approved' : 'rejected';
      this.trustElevationTracker.recordProposalDecision(proposal, decision, false);
    }

    return true;
  }

  /**
   * Process a proposal through the autonomous evolution pipeline.
   * If in autonomous mode and the review approves with safe scope,
   * the proposal is auto-implemented via sidecar pattern.
   *
   * Returns the action taken, or null if autonomous modules aren't wired.
   */
  processProposalAutonomously(
    proposalId: string,
    review: ReviewResult,
  ): { action: string; reason: string } | null {
    if (!this.autonomousEvolution || !this.autonomyManager) return null;

    const resolved = this.autonomyManager.getResolvedState();
    const isAutonomous = resolved.evolutionApprovalMode === 'autonomous';

    const evaluation = this.autonomousEvolution.evaluateForAutoImplementation(review, isAutonomous);

    const state = this.loadEvolution();
    const proposal = state.proposals.find(p => p.id === proposalId);
    if (!proposal) return null;

    switch (evaluation.action) {
      case 'auto-implement':
        // Auto-approve and create notification
        this.updateProposalStatus(proposalId, 'approved', evaluation.reason);
        this.autonomousEvolution.createNotification(proposal, 'auto-implemented', review, evaluation.reason);
        break;
      case 'reject':
        this.updateProposalStatus(proposalId, 'rejected', evaluation.reason);
        this.autonomousEvolution.createNotification(proposal, 'rejected', review, evaluation.reason);
        break;
      case 'needs-review':
        this.autonomousEvolution.createNotification(proposal, 'needs-review', review, evaluation.reason);
        break;
      case 'queue-for-approval':
        // Stays as proposed — human will approve via API
        break;
    }

    return { action: evaluation.action, reason: evaluation.reason };
  }

  listProposals(filter?: { status?: EvolutionStatus; type?: EvolutionType }): EvolutionProposal[] {
    const state = this.loadEvolution();
    let proposals = state.proposals;
    if (filter?.status) proposals = proposals.filter(p => p.status === filter.status);
    if (filter?.type) proposals = proposals.filter(p => p.type === filter.type);
    return proposals;
  }

  getEvolutionStats(): EvolutionState['stats'] {
    return this.loadEvolution().stats;
  }

  // ── Learning Registry ───────────────────────────────────────────

  private loadLearnings(): LearningState {
    return this.readFile<LearningState>('learning-registry', {
      learnings: [],
      stats: { totalLearnings: 0, applied: 0, pending: 0, byCategory: {}, lastUpdated: this.now() },
    });
  }

  private saveLearnings(state: LearningState): void {
    const categoryCounts: Record<string, number> = {};
    let applied = 0;
    for (const l of state.learnings) {
      categoryCounts[l.category] = (categoryCounts[l.category] || 0) + 1;
      if (l.applied) applied++;
    }
    state.stats = {
      totalLearnings: state.learnings.length,
      applied,
      pending: state.learnings.length - applied,
      byCategory: categoryCounts,
      lastUpdated: this.now(),
    };

    const max = this.config.maxLearnings || 500;
    if (state.learnings.length > max) {
      const unapplied = state.learnings.filter(l => !l.applied);
      const appliedEntries = state.learnings.filter(l => l.applied);
      const keep = appliedEntries.slice(-Math.max(0, max - unapplied.length));
      state.learnings = [...unapplied, ...keep];
    }

    this.writeFile('learning-registry', state);
  }

  private nextLearningId(state: LearningState): string {
    const existing = new Set(state.learnings.map(l => l.id));
    let num = 1;
    while (existing.has(`LRN-${String(num).padStart(3, '0')}`)) num++;
    return `LRN-${String(num).padStart(3, '0')}`;
  }

  addLearning(opts: {
    title: string;
    category: string;
    description: string;
    source: LearningSource;
    tags?: string[];
    evolutionRelevance?: string;
  }): LearningEntry {
    const state = this.loadLearnings();
    const id = this.nextLearningId(state);
    const learning: LearningEntry = {
      id,
      title: opts.title,
      category: opts.category,
      description: opts.description,
      source: opts.source,
      tags: opts.tags || [],
      applied: false,
      evolutionRelevance: opts.evolutionRelevance,
    };
    state.learnings.push(learning);
    this.saveLearnings(state);
    return learning;
  }

  markLearningApplied(id: string, appliedTo: string): boolean {
    const state = this.loadLearnings();
    const learning = state.learnings.find(l => l.id === id);
    if (!learning) return false;
    learning.applied = true;
    learning.appliedTo = appliedTo;
    this.saveLearnings(state);
    return true;
  }

  listLearnings(filter?: { category?: string; applied?: boolean }): LearningEntry[] {
    const state = this.loadLearnings();
    let learnings = state.learnings;
    if (filter?.category) learnings = learnings.filter(l => l.category === filter.category);
    if (filter?.applied !== undefined) learnings = learnings.filter(l => l.applied === filter.applied);
    return learnings;
  }

  getLearningStats(): LearningState['stats'] {
    return this.loadLearnings().stats;
  }

  // ── Capability Gap Tracker ──────────────────────────────────────

  private loadGaps(): GapState {
    return this.readFile<GapState>('capability-gaps', {
      gaps: [],
      stats: { totalGaps: 0, bySeverity: {}, byCategory: {}, addressed: 0, lastUpdated: this.now() },
    });
  }

  private saveGaps(state: GapState): void {
    const severityCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    let addressed = 0;
    for (const g of state.gaps) {
      severityCounts[g.severity] = (severityCounts[g.severity] || 0) + 1;
      categoryCounts[g.category] = (categoryCounts[g.category] || 0) + 1;
      if (g.status === 'addressed') addressed++;
    }
    state.stats = {
      totalGaps: state.gaps.length,
      bySeverity: severityCounts,
      byCategory: categoryCounts,
      addressed,
      lastUpdated: this.now(),
    };

    const max = this.config.maxGaps || 200;
    if (state.gaps.length > max) {
      const open = state.gaps.filter(g => g.status === 'identified');
      const closed = state.gaps.filter(g => g.status !== 'identified');
      const keep = closed.slice(-Math.max(0, max - open.length));
      state.gaps = [...open, ...keep];
    }

    this.writeFile('capability-gaps', state);
  }

  private nextGapId(state: GapState): string {
    const existing = new Set(state.gaps.map(g => g.id));
    let num = 1;
    while (existing.has(`GAP-${String(num).padStart(3, '0')}`)) num++;
    return `GAP-${String(num).padStart(3, '0')}`;
  }

  addGap(opts: {
    title: string;
    category: GapCategory;
    severity: 'critical' | 'high' | 'medium' | 'low';
    description: string;
    context: string;
    platform?: string;
    session?: string;
    currentState?: string;
    proposedSolution?: string;
  }): CapabilityGap {
    const state = this.loadGaps();
    const id = this.nextGapId(state);
    const gap: CapabilityGap = {
      id,
      title: opts.title,
      category: opts.category,
      severity: opts.severity,
      description: opts.description,
      discoveredFrom: {
        context: opts.context,
        platform: opts.platform,
        discoveredAt: this.now(),
        session: opts.session,
      },
      currentState: opts.currentState || 'Not implemented',
      proposedSolution: opts.proposedSolution,
      status: 'identified',
    };
    state.gaps.push(gap);
    this.saveGaps(state);
    return gap;
  }

  addressGap(id: string, resolution: string): boolean {
    const state = this.loadGaps();
    const gap = state.gaps.find(g => g.id === id);
    if (!gap) return false;
    gap.status = 'addressed';
    gap.resolution = resolution;
    gap.addressedAt = this.now();
    this.saveGaps(state);
    return true;
  }

  listGaps(filter?: { severity?: string; category?: GapCategory; status?: string }): CapabilityGap[] {
    const state = this.loadGaps();
    let gaps = state.gaps;
    if (filter?.severity) gaps = gaps.filter(g => g.severity === filter.severity);
    if (filter?.category) gaps = gaps.filter(g => g.category === filter.category);
    if (filter?.status) gaps = gaps.filter(g => g.status === filter.status);
    return gaps;
  }

  getGapStats(): GapState['stats'] {
    return this.loadGaps().stats;
  }

  // ── Action Queue ────────────────────────────────────────────────

  private loadActions(): ActionState {
    return this.readFile<ActionState>('action-queue', {
      actions: [],
      stats: { totalActions: 0, pending: 0, completed: 0, overdue: 0, lastUpdated: this.now() },
    });
  }

  private saveActions(state: ActionState): void {
    let pending = 0, completed = 0, overdue = 0;
    const now = new Date();
    for (const a of state.actions) {
      if (a.status === 'completed') completed++;
      else if (a.status === 'pending' || a.status === 'in_progress') {
        pending++;
        if (a.dueBy && new Date(a.dueBy) < now) overdue++;
      }
    }
    state.stats = {
      totalActions: state.actions.length,
      pending,
      completed,
      overdue,
      lastUpdated: this.now(),
    };

    const max = this.config.maxActions || 300;
    if (state.actions.length > max) {
      const active = state.actions.filter(a => !['completed', 'cancelled'].includes(a.status));
      const done = state.actions.filter(a => ['completed', 'cancelled'].includes(a.status));
      const keep = done.slice(-Math.max(0, max - active.length));
      state.actions = [...active, ...keep];
    }

    this.writeFile('action-queue', state);
  }

  private nextActionId(state: ActionState): string {
    const existing = new Set(state.actions.map(a => a.id));
    let num = 1;
    while (existing.has(`ACT-${String(num).padStart(3, '0')}`)) num++;
    return `ACT-${String(num).padStart(3, '0')}`;
  }

  addAction(opts: {
    title: string;
    description: string;
    priority?: 'critical' | 'high' | 'medium' | 'low';
    commitTo?: string;
    dueBy?: string;
    source?: ActionItem['source'];
    tags?: string[];
  }): ActionItem {
    const state = this.loadActions();
    const id = this.nextActionId(state);
    const action: ActionItem = {
      id,
      title: opts.title,
      description: opts.description,
      priority: opts.priority || 'medium',
      status: 'pending',
      commitTo: opts.commitTo,
      createdAt: this.now(),
      dueBy: opts.dueBy,
      source: opts.source,
      tags: opts.tags,
    };
    state.actions.push(action);
    this.saveActions(state);
    return action;
  }

  updateAction(id: string, updates: {
    status?: ActionItem['status'];
    resolution?: string;
  }): boolean {
    const state = this.loadActions();
    const action = state.actions.find(a => a.id === id);
    if (!action) return false;
    if (updates.status) {
      action.status = updates.status;
      if (updates.status === 'completed') action.completedAt = this.now();
    }
    if (updates.resolution) action.resolution = updates.resolution;
    this.saveActions(state);
    return true;
  }

  listActions(filter?: { status?: ActionItem['status']; priority?: string }): ActionItem[] {
    const state = this.loadActions();
    let actions = state.actions;
    if (filter?.status) actions = actions.filter(a => a.status === filter.status);
    if (filter?.priority) actions = actions.filter(a => a.priority === filter.priority);
    return actions;
  }

  getOverdueActions(): ActionItem[] {
    const state = this.loadActions();
    const now = new Date();
    return state.actions.filter(a =>
      (a.status === 'pending' || a.status === 'in_progress') &&
      a.dueBy && new Date(a.dueBy) < now
    );
  }

  getActionStats(): ActionState['stats'] {
    return this.loadActions().stats;
  }

  // ── Cross-System Queries ────────────────────────────────────────

  /**
   * Get a full dashboard of evolution health.
   * Useful for session-start orientation and status reporting.
   */
  getDashboard(): {
    evolution: EvolutionState['stats'];
    learnings: LearningState['stats'];
    gaps: GapState['stats'];
    actions: ActionState['stats'];
    highlights: string[];
  } {
    const evolution = this.getEvolutionStats();
    const learnings = this.getLearningStats();
    const gaps = this.getGapStats();
    const actions = this.getActionStats();
    const overdue = this.getOverdueActions();

    const highlights: string[] = [];
    const proposed = evolution.byStatus['proposed'] || 0;
    if (proposed > 0) highlights.push(`${proposed} evolution proposal(s) awaiting review`);
    if (learnings.pending > 0) highlights.push(`${learnings.pending} learning(s) not yet applied`);
    const criticalGaps = gaps.bySeverity['critical'] || 0;
    if (criticalGaps > 0) highlights.push(`${criticalGaps} critical capability gap(s)`);
    if (overdue.length > 0) highlights.push(`${overdue.length} overdue action item(s)`);
    if (highlights.length === 0) highlights.push('All systems healthy — no pending evolution items');

    return { evolution, learnings, gaps, actions, highlights };
  }

  // ── Implicit Evolution Detection ──────────────────────────────
  //
  // Inspired by Dawn's REC-52-2 pattern: scan open gaps and proposals
  // to detect when a capability need is already satisfied by existing
  // infrastructure (implemented proposals, applied learnings, addressed gaps).
  // This prevents duplicate proposals and accelerates the feedback loop.

  /**
   * Detect gaps or proposals that may already be resolved by existing infrastructure.
   *
   * Scans open gaps and proposed items against:
   *   - Implemented proposals (already built)
   *   - Applied learnings (already absorbed)
   *   - Addressed gaps (already resolved)
   *
   * Returns items that appear to have implicit resolutions, with evidence.
   */
  detectImplicitEvolution(): Array<{
    type: 'gap' | 'proposal';
    id: string;
    title: string;
    matchedBy: { type: string; id: string; title: string; similarity: string };
  }> {
    const evolutionState = this.loadEvolution();
    const gapState = this.loadGaps();
    const learningState = this.loadLearnings();

    const resolved: Array<{
      type: 'gap' | 'proposal';
      id: string;
      title: string;
      matchedBy: { type: string; id: string; title: string; similarity: string };
    }> = [];

    // Build keyword index from implemented/resolved items
    const implementedProposals = evolutionState.proposals.filter(
      (p: EvolutionProposal) => p.status === 'implemented',
    );
    const appliedLearnings = learningState.learnings.filter(
      (l: LearningEntry) => l.applied,
    );
    const addressedGaps = gapState.gaps.filter((g: CapabilityGap) => g.status === 'addressed');

    // Check open proposals against implemented ones
    const openProposals = evolutionState.proposals.filter(
      (p: EvolutionProposal) => p.status === 'proposed',
    );
    for (const open of openProposals) {
      const match = this.findKeywordMatch(
        open.title + ' ' + open.description,
        [
          ...implementedProposals.map((p: EvolutionProposal) => ({
            type: 'implemented-proposal',
            id: p.id,
            title: p.title,
            text: p.title + ' ' + p.description,
          })),
          ...appliedLearnings.map((l: LearningEntry) => ({
            type: 'applied-learning',
            id: l.id,
            title: l.title,
            text: l.title + ' ' + l.description,
          })),
        ],
      );
      if (match) {
        resolved.push({
          type: 'proposal',
          id: open.id,
          title: open.title,
          matchedBy: match,
        });
      }
    }

    // Check open gaps against resolved infrastructure
    const openGaps = gapState.gaps.filter((g: CapabilityGap) => g.status === 'identified');
    for (const gap of openGaps) {
      const match = this.findKeywordMatch(
        gap.title + ' ' + gap.description,
        [
          ...implementedProposals.map((p: EvolutionProposal) => ({
            type: 'implemented-proposal',
            id: p.id,
            title: p.title,
            text: p.title + ' ' + p.description,
          })),
          ...addressedGaps.map((g2: CapabilityGap) => ({
            type: 'addressed-gap',
            id: g2.id,
            title: g2.title,
            text: g2.title + ' ' + g2.description + ' ' + (g2.resolution || ''),
          })),
        ],
      );
      if (match) {
        resolved.push({
          type: 'gap',
          id: gap.id,
          title: gap.title,
          matchedBy: match,
        });
      }
    }

    return resolved;
  }

  /**
   * Verify that implemented proposals left actual file traces in the workspace.
   *
   * Inspired by Dawn's lesson-behavior-gap analyzer: proposals marked
   * "implemented" should have corresponding infrastructure (hooks, scripts,
   * config entries, code files). Proposals with no detectable traces may be
   * "phantom implementations" — marked done without actual changes.
   *
   * Returns proposals that lack verifiable infrastructure traces.
   */
  verifyImplementationTraces(): Array<{
    id: string;
    title: string;
    implementedAt: string;
    tracesFound: string[];
    verdict: 'verified' | 'unverified' | 'weak';
  }> {
    const evolutionState = this.loadEvolution();
    const implemented = evolutionState.proposals.filter(
      (p: EvolutionProposal) => p.status === 'implemented',
    );

    const results: Array<{
      id: string;
      title: string;
      implementedAt: string;
      tracesFound: string[];
      verdict: 'verified' | 'unverified' | 'weak';
    }> = [];

    // Build search paths
    const projectDir = this.config.stateDir.replace(/\/.instar\/state$/, '');
    const searchDirs = [
      path.join(projectDir, '.instar', 'hooks'),
      path.join(projectDir, '.instar', 'scripts'),
      path.join(projectDir, '.claude', 'hooks'),
      path.join(projectDir, '.claude', 'skills'),
      path.join(projectDir, '.claude', 'scripts'),
    ].filter(d => fs.existsSync(d));

    for (const proposal of implemented) {
      const keywords = this.extractKeywords(proposal.title + ' ' + proposal.description);
      const traces: string[] = [];

      // Check if any file in infrastructure dirs mentions keywords from the proposal
      for (const dir of searchDirs) {
        try {
          const files = fs.readdirSync(dir, { recursive: true }) as string[];
          for (const file of files) {
            const filePath = path.join(dir, String(file));
            try {
              const stat = fs.statSync(filePath);
              if (!stat.isFile()) continue;
              // Check filename match
              const fileName = path.basename(String(file)).toLowerCase();
              const nameKeywords = new Set(fileName.replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(w => w.length > 2));
              const nameOverlap = [...keywords].filter(k => nameKeywords.has(k));
              if (nameOverlap.length >= 2) {
                traces.push(`filename:${path.relative(projectDir, filePath)}`);
              }
            } catch { /* skip unreadable files */ }
          }
        } catch { /* skip unreadable dirs */ }
      }

      // Check git log for mentions (fast: just search commit messages)
      // Skip this for performance — file traces are sufficient

      const verdict = traces.length >= 2 ? 'verified'
        : traces.length === 1 ? 'weak'
        : 'unverified';

      results.push({
        id: proposal.id,
        title: proposal.title,
        implementedAt: proposal.implementedAt || proposal.proposedAt || '',
        tracesFound: traces,
        verdict,
      });
    }

    return results;
  }

  /**
   * Simple keyword overlap matching. Returns the best match if overlap
   * exceeds a threshold, or null if no match is strong enough.
   */
  private findKeywordMatch(
    query: string,
    candidates: Array<{ type: string; id: string; title: string; text: string }>,
  ): { type: string; id: string; title: string; similarity: string } | null {
    const queryWords = this.extractKeywords(query);
    if (queryWords.size < 2) return null;

    let bestMatch: { type: string; id: string; title: string; similarity: string } | null = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const candidateWords = this.extractKeywords(candidate.text);
      const intersection = new Set([...queryWords].filter(w => candidateWords.has(w)));
      // Jaccard-like overlap score
      const union = new Set([...queryWords, ...candidateWords]);
      const score = intersection.size / union.size;

      // Require at least 30% overlap and 3+ shared keywords
      if (score > bestScore && score >= 0.3 && intersection.size >= 3) {
        bestScore = score;
        bestMatch = {
          type: candidate.type,
          id: candidate.id,
          title: candidate.title,
          similarity: `${Math.round(score * 100)}% keyword overlap`,
        };
      }
    }

    return bestMatch;
  }

  /**
   * Extract meaningful keywords from text, filtering stop words.
   */
  private extractKeywords(text: string): Set<string> {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'up', 'about', 'into', 'through',
      'during', 'before', 'after', 'above', 'below', 'between', 'and',
      'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either', 'neither',
      'each', 'every', 'all', 'any', 'few', 'more', 'most', 'other',
      'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
      'just', 'because', 'as', 'until', 'while', 'if', 'then', 'that',
      'this', 'these', 'those', 'it', 'its', 'when', 'where', 'which',
      'what', 'who', 'how', 'why', 'also', 'add', 'use', 'using', 'used',
    ]);

    return new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w)),
    );
  }
}
