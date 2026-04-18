/**
 * InitiativeTracker — persists and queries multi-phase, long-running work.
 *
 * Fills the gap between one-off AttentionItems (single actionable) and
 * scheduled Jobs (recurring cron task). An Initiative represents a
 * bounded-but-multi-week effort with phases, each advancing in order.
 *
 * Persistence: `.instar/initiatives.json` (atomic rename pattern).
 * Consumers: HTTP routes (`/initiatives/*`), dashboard "Initiatives" tab,
 * daily digest job (alerts when initiatives go stale / need user input /
 * are ready to advance).
 */
import fs from 'node:fs';
import path from 'node:path';

export type InitiativePhaseStatus = 'pending' | 'in-progress' | 'done' | 'blocked';

export interface InitiativePhase {
  /** Stable identifier within this initiative (e.g. 'phase-a'). */
  id: string;
  /** Human-readable name (e.g. 'Phase A: Scaffolding'). */
  name: string;
  /** Short summary of what this phase delivers. */
  summary?: string;
  status: InitiativePhaseStatus;
  /** ISO timestamp when status first became 'in-progress'. */
  startedAt?: string;
  /** ISO timestamp when status first became 'done'. */
  completedAt?: string;
}

export type InitiativeStatus = 'active' | 'completed' | 'archived' | 'abandoned';

export interface InitiativeLink {
  type: 'spec' | 'pr' | 'commit' | 'topic' | 'doc' | 'other';
  label: string;
  url?: string;
  ref?: string;
}

export interface Initiative {
  /** URL-safe slug (stable identifier). */
  id: string;
  title: string;
  description: string;
  status: InitiativeStatus;
  phases: InitiativePhase[];
  /** Index into phases[] of the phase currently active (or last worked on). */
  currentPhaseIndex: number;
  /** ISO timestamp of the last phase/status update. */
  lastTouchedAt: string;
  /** Optional ISO timestamp; digest job flags if past and status === 'active'. */
  nextCheckAt?: string;
  /** True when waiting on the user (decision, approval, ratification). */
  needsUser: boolean;
  /** Short rationale when needsUser === true. */
  needsUserReason?: string;
  /** Free-text list of current blockers (not necessarily user-blocked). */
  blockers: string[];
  /** External references: spec docs, PRs, commits, Telegram topics, etc. */
  links: InitiativeLink[];
  createdAt: string;
  updatedAt: string;
}

export interface InitiativeCreateInput {
  id: string;
  title: string;
  description: string;
  phases: Array<{ id: string; name: string; summary?: string; status?: InitiativePhaseStatus }>;
  links?: InitiativeLink[];
  nextCheckAt?: string;
  needsUser?: boolean;
  needsUserReason?: string;
  blockers?: string[];
}

export interface InitiativeUpdateInput {
  title?: string;
  description?: string;
  status?: InitiativeStatus;
  nextCheckAt?: string | null;
  needsUser?: boolean;
  needsUserReason?: string | null;
  blockers?: string[];
  links?: InitiativeLink[];
}

export interface DigestItem {
  initiativeId: string;
  title: string;
  reason: 'stale' | 'needs-user' | 'next-check-due' | 'ready-to-advance';
  detail: string;
}

export interface Digest {
  generatedAt: string;
  items: DigestItem[];
}

/**
 * Staleness threshold for the digest scan (7 days without an update on an
 * active initiative triggers a 'stale' flag).
 */
export const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export class InitiativeTracker {
  private readonly filePath: string;
  private readonly initiatives = new Map<string, Initiative>();

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, 'initiatives.json');
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
      if (Array.isArray(raw?.initiatives)) {
        for (const item of raw.initiatives) {
          if (item && typeof item.id === 'string') {
            this.initiatives.set(item.id, item as Initiative);
          }
        }
      }
    } catch (err) {
      console.error(`[initiatives] Failed to load: ${err instanceof Error ? err.message : err}`);
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = { initiatives: Array.from(this.initiatives.values()) };
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  list(filter?: { status?: InitiativeStatus }): Initiative[] {
    const all = Array.from(this.initiatives.values());
    const filtered = filter?.status ? all.filter((i) => i.status === filter.status) : all;
    return filtered.sort((a, b) => b.lastTouchedAt.localeCompare(a.lastTouchedAt));
  }

  get(id: string): Initiative | undefined {
    return this.initiatives.get(id);
  }

  create(input: InitiativeCreateInput): Initiative {
    if (this.initiatives.has(input.id)) {
      throw new Error(`Initiative "${input.id}" already exists`);
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input.id)) {
      throw new Error('Initiative id must be lowercase kebab-case, 1–63 chars');
    }
    if (!input.phases.length) {
      throw new Error('Initiative must have at least one phase');
    }
    const now = new Date().toISOString();
    const phases: InitiativePhase[] = input.phases.map((p) => ({
      id: p.id,
      name: p.name,
      summary: p.summary,
      status: p.status ?? 'pending',
    }));
    // currentPhaseIndex: first non-'done' phase, else last phase.
    const firstOpen = phases.findIndex((p) => p.status !== 'done');
    const currentPhaseIndex = firstOpen === -1 ? phases.length - 1 : firstOpen;
    const allDone = phases.every((p) => p.status === 'done');
    const initiative: Initiative = {
      id: input.id,
      title: input.title,
      description: input.description,
      status: allDone ? 'completed' : 'active',
      phases,
      currentPhaseIndex,
      lastTouchedAt: now,
      nextCheckAt: input.nextCheckAt,
      needsUser: input.needsUser ?? false,
      needsUserReason: input.needsUserReason,
      blockers: input.blockers ?? [],
      links: input.links ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.initiatives.set(initiative.id, initiative);
    this.save();
    return initiative;
  }

  update(id: string, input: InitiativeUpdateInput): Initiative {
    const existing = this.initiatives.get(id);
    if (!existing) throw new Error(`Initiative "${id}" not found`);
    const now = new Date().toISOString();
    const next: Initiative = { ...existing, updatedAt: now, lastTouchedAt: now };
    if (input.title !== undefined) next.title = input.title;
    if (input.description !== undefined) next.description = input.description;
    if (input.status !== undefined) next.status = input.status;
    if (input.nextCheckAt !== undefined) {
      next.nextCheckAt = input.nextCheckAt === null ? undefined : input.nextCheckAt;
    }
    if (input.needsUser !== undefined) next.needsUser = input.needsUser;
    if (input.needsUserReason !== undefined) {
      next.needsUserReason = input.needsUserReason === null ? undefined : input.needsUserReason;
    }
    if (input.blockers !== undefined) next.blockers = input.blockers;
    if (input.links !== undefined) next.links = input.links;
    this.initiatives.set(id, next);
    this.save();
    return next;
  }

  /**
   * Transition a phase's status. Updates currentPhaseIndex to point to the
   * earliest non-done phase; marks the whole initiative 'completed' when
   * all phases are 'done'. Sets startedAt/completedAt the first time a
   * phase reaches 'in-progress' / 'done' respectively.
   */
  setPhaseStatus(id: string, phaseId: string, status: InitiativePhaseStatus): Initiative {
    const existing = this.initiatives.get(id);
    if (!existing) throw new Error(`Initiative "${id}" not found`);
    const phases = existing.phases.map((p) => ({ ...p }));
    const phase = phases.find((p) => p.id === phaseId);
    if (!phase) throw new Error(`Phase "${phaseId}" not found in "${id}"`);
    const now = new Date().toISOString();
    phase.status = status;
    if (status === 'in-progress' && !phase.startedAt) phase.startedAt = now;
    if (status === 'done' && !phase.completedAt) phase.completedAt = now;
    const firstOpen = phases.findIndex((p) => p.status !== 'done');
    const allDone = phases.every((p) => p.status === 'done');
    const next: Initiative = {
      ...existing,
      phases,
      currentPhaseIndex: firstOpen === -1 ? phases.length - 1 : firstOpen,
      status: allDone ? 'completed' : existing.status === 'completed' ? 'active' : existing.status,
      updatedAt: now,
      lastTouchedAt: now,
    };
    this.initiatives.set(id, next);
    this.save();
    return next;
  }

  remove(id: string): boolean {
    const removed = this.initiatives.delete(id);
    if (removed) this.save();
    return removed;
  }

  /**
   * Scan active initiatives for anything actionable. The digest job uses
   * this to decide whether to send a push notification. Empty items[]
   * means "quiet day, don't spam the user."
   */
  digest(now: Date = new Date()): Digest {
    const items: DigestItem[] = [];
    const nowMs = now.getTime();
    for (const initiative of this.initiatives.values()) {
      if (initiative.status !== 'active') continue;

      if (initiative.needsUser) {
        items.push({
          initiativeId: initiative.id,
          title: initiative.title,
          reason: 'needs-user',
          detail: initiative.needsUserReason ?? 'Needs your decision.',
        });
        continue;
      }

      if (initiative.nextCheckAt) {
        const checkMs = Date.parse(initiative.nextCheckAt);
        if (Number.isFinite(checkMs) && checkMs <= nowMs) {
          items.push({
            initiativeId: initiative.id,
            title: initiative.title,
            reason: 'next-check-due',
            detail: `Check-in scheduled for ${initiative.nextCheckAt}.`,
          });
          continue;
        }
      }

      // Ready-to-advance: the previous phase is done AND the current
      // phase is still untouched ('pending'). Once the current phase
      // is 'in-progress' or 'blocked', the advance has already begun,
      // so we stop emitting this signal.
      const current = initiative.phases[initiative.currentPhaseIndex];
      const previous = initiative.currentPhaseIndex > 0
        ? initiative.phases[initiative.currentPhaseIndex - 1]
        : undefined;
      if (previous?.status === 'done' && current?.status === 'pending') {
        items.push({
          initiativeId: initiative.id,
          title: initiative.title,
          reason: 'ready-to-advance',
          detail: `Phase "${previous.name}" done → "${current.name}" can start.`,
        });
        continue;
      }

      const lastMs = Date.parse(initiative.lastTouchedAt);
      if (Number.isFinite(lastMs) && nowMs - lastMs > STALE_THRESHOLD_MS) {
        const days = Math.floor((nowMs - lastMs) / (24 * 60 * 60 * 1000));
        items.push({
          initiativeId: initiative.id,
          title: initiative.title,
          reason: 'stale',
          detail: `No movement in ${days} days.`,
        });
      }
    }
    return { generatedAt: now.toISOString(), items };
  }
}
