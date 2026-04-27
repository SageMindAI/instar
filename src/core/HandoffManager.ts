/**
 * HandoffManager — Seamless work transfer between machines.
 *
 * Handles three scenarios:
 *   1. Graceful handoff: outgoing machine saves state, writes handoff note
 *   2. Resume: incoming machine reads handoff note, picks up where left off
 *   3. Crash recovery: incoming machine detects stale work, recovers gracefully
 *
 * From INTELLIGENT_SYNC_SPEC Section 9 (Machine Transition) and
 * Section 10 (Failover and Handoff).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import type { WorkLedger, LedgerEntry } from './WorkLedger.js';
import { assertNotInstarSourceTree } from './SourceTreeGuard.js';

// ── Types ────────────────────────────────────────────────────────────

export interface HandoffNote {
  /** Schema version for forward compatibility. */
  schemaVersion: number;
  /** Machine that initiated the handoff. */
  from: string;
  /** Timestamp of handoff. */
  at: string;
  /** Reason for handoff. */
  reason: HandoffReason;
  /** Active work items at time of handoff. */
  activeWork: HandoffWorkItem[];
  /** Whether all changes were committed and pushed. */
  allChangesPushed: boolean;
  /** Any notes about uncommitted state. */
  uncommittedNotes: string;
  /** The git HEAD at handoff time. */
  gitHead: string;
  /** Branches that were active at handoff. */
  activeBranches: string[];
}

export type HandoffReason = 'user-initiated' | 'inactivity' | 'shutdown' | 'sleep' | 'crash-detected';

export interface HandoffWorkItem {
  /** Ledger entry ID. */
  entryId: string;
  /** Session ID. */
  sessionId: string;
  /** Branch name (if on a task branch). */
  branch?: string;
  /** Status at handoff time. */
  status: 'paused' | 'interrupted';
  /** Task description. */
  description: string;
  /** Files that were being worked on. */
  filesModified: string[];
  /** Instructions for resuming. */
  resumeInstructions?: string;
}

export interface HandoffResult {
  /** Whether the handoff completed successfully. */
  success: boolean;
  /** The handoff note that was written. */
  note?: HandoffNote;
  /** Number of ledger entries paused. */
  entriesPaused: number;
  /** Number of WIP commits created. */
  wipCommits: number;
  /** Whether push succeeded. */
  pushed: boolean;
  /** Error if handoff failed. */
  error?: string;
}

export interface ResumeResult {
  /** Whether resume completed successfully. */
  success: boolean;
  /** The handoff note that was read. */
  note?: HandoffNote;
  /** Work items available to resume. */
  resumableWork: HandoffWorkItem[];
  /** Whether pull succeeded. */
  pulled: boolean;
  /** Whether the previous machine's changes were present. */
  changesAvailable: boolean;
  /** Recovery type. */
  recoveryType: 'graceful' | 'crash-recovery' | 'fresh-start';
  /** Error if resume failed. */
  error?: string;
}

export interface HandoffManagerConfig {
  /** Project directory (repo root). */
  projectDir: string;
  /** State directory (.instar). */
  stateDir: string;
  /** This machine's ID. */
  machineId: string;
  /** Work ledger instance. */
  workLedger: WorkLedger;
}

// ── Constants ────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1;
const HANDOFF_FILE = 'handoff.json';

// ── HandoffManager ───────────────────────────────────────────────────

export class HandoffManager {
  private projectDir: string;
  private stateDir: string;
  private machineId: string;
  private workLedger: WorkLedger;
  private handoffDir: string;

  constructor(config: HandoffManagerConfig) {
    assertNotInstarSourceTree(config.projectDir, 'HandoffManager');
    this.projectDir = config.projectDir;
    this.stateDir = config.stateDir;
    this.machineId = config.machineId;
    this.workLedger = config.workLedger;

    this.handoffDir = path.join(config.stateDir, 'state');
    if (!fs.existsSync(this.handoffDir)) {
      fs.mkdirSync(this.handoffDir, { recursive: true });
    }
  }

  // ── Graceful Handoff (Outgoing) ────────────────────────────────────

  /**
   * Perform a graceful handoff: commit WIP, pause ledger entries,
   * write handoff note, push.
   */
  initiateHandoff(opts?: {
    reason?: HandoffReason;
    resumeInstructions?: string;
  }): HandoffResult {
    const reason = opts?.reason ?? 'user-initiated';
    let wipCommits = 0;
    let pushed = false;

    try {
      // Step 1: Commit any dirty working tree
      const committed = this.commitWip();
      if (committed) wipCommits++;

      // Step 2: Pause all active ledger entries for this machine
      const entriesPaused = this.pauseActiveEntries();

      // Step 3: Collect active work items for the handoff note
      const activeWork = this.collectActiveWork(opts?.resumeInstructions);

      // Step 4: Detect active branches
      const activeBranches = this.detectActiveBranches();

      // Step 5: Get git HEAD
      const gitHead = this.getGitHead();

      // Step 6: Write handoff note
      const note: HandoffNote = {
        schemaVersion: SCHEMA_VERSION,
        from: this.machineId,
        at: new Date().toISOString(),
        reason,
        activeWork,
        allChangesPushed: false, // Updated after push
        uncommittedNotes: wipCommits > 0 ? `${wipCommits} WIP commit(s) created` : 'None — all committed',
        gitHead,
        activeBranches,
      };

      this.writeHandoffNote(note);

      // Step 7: Push everything
      pushed = this.pushAll();
      note.allChangesPushed = pushed;
      this.writeHandoffNote(note); // Update with push status

      // Step 8: Push again with the updated note
      if (pushed) {
        this.pushAll();
      }

      return {
        success: true,
        note,
        entriesPaused,
        wipCommits,
        pushed,
      };
    } catch (err) {
      return {
        success: false,
        entriesPaused: 0,
        wipCommits,
        pushed,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── Resume (Incoming) ──────────────────────────────────────────────

  /**
   * Resume work on an incoming machine.
   * Reads the handoff note, pulls latest, identifies resumable work.
   */
  resume(): ResumeResult {
    try {
      // Step 1: Pull latest
      const pulled = this.pullLatest();

      // Step 2: Read handoff note (if it exists)
      const note = this.readHandoffNote();

      if (!note) {
        // No handoff note — check for stale work in ledger (crash recovery)
        return this.attemptCrashRecovery(pulled);
      }

      // Step 3: Check if the handoff was from a different machine
      if (note.from === this.machineId) {
        // We wrote this handoff — we're the same machine resuming
        // Clear the note and resume
        this.clearHandoffNote();
        return {
          success: true,
          note,
          resumableWork: note.activeWork,
          pulled,
          changesAvailable: true,
          recoveryType: 'graceful',
        };
      }

      // Step 4: Handoff from another machine — read and prepare to resume
      const resumableWork = note.activeWork.filter(w => w.status === 'paused');

      return {
        success: true,
        note,
        resumableWork,
        pulled,
        changesAvailable: note.allChangesPushed,
        recoveryType: 'graceful',
      };
    } catch (err) {
      return {
        success: false,
        resumableWork: [],
        pulled: false,
        changesAvailable: false,
        recoveryType: 'fresh-start',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Accept a handoff — take ownership of resumed work.
   * Creates new ledger entries for the work being resumed.
   */
  acceptHandoff(workItems: HandoffWorkItem[]): LedgerEntry[] {
    const newEntries: LedgerEntry[] = [];

    for (const item of workItems) {
      const entry = this.workLedger.startWork({
        sessionId: item.sessionId,
        task: `[resumed from ${item.entryId}] ${item.description}`,
        filesPlanned: item.filesModified,
        branch: item.branch,
      });
      newEntries.push(entry);
    }

    // Clear the handoff note after accepting
    this.clearHandoffNote();

    return newEntries;
  }

  // ── Crash Recovery ─────────────────────────────────────────────────

  /**
   * Attempt crash recovery when no handoff note exists but stale work detected.
   */
  private attemptCrashRecovery(pulled: boolean): ResumeResult {
    // Read all entries — look for stale/active entries from other machines
    const allEntries = this.workLedger.getAllEntries();
    const otherMachineWork = allEntries.filter(
      e => e.machineId !== this.machineId && (e.status === 'active' || e.status === 'stale')
    );

    if (otherMachineWork.length === 0) {
      return {
        success: true,
        resumableWork: [],
        pulled,
        changesAvailable: false,
        recoveryType: 'fresh-start',
      };
    }

    // Convert stale entries to resumable work items
    const resumableWork: HandoffWorkItem[] = otherMachineWork.map(entry => ({
      entryId: entry.id,
      sessionId: entry.sessionId,
      branch: entry.branch,
      status: 'interrupted' as const,
      description: entry.task,
      filesModified: [...entry.filesPlanned, ...entry.filesModified],
    }));

    return {
      success: true,
      resumableWork,
      pulled,
      changesAvailable: pulled,
      recoveryType: 'crash-recovery',
    };
  }

  // ── Handoff Note I/O ───────────────────────────────────────────────

  /**
   * Read the current handoff note, if any.
   */
  readHandoffNote(): HandoffNote | null {
    const filePath = this.handoffFilePath();
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as HandoffNote;
    } catch {
      // @silent-fallback-ok — handoff file may not exist; null signals no pending handoff
      return null;
    }
  }

  /**
   * Check if a handoff note exists.
   */
  hasHandoffNote(): boolean {
    return fs.existsSync(this.handoffFilePath());
  }

  /**
   * Clear the handoff note (after accepting or when no longer needed).
   */
  clearHandoffNote(): void {
    const filePath = this.handoffFilePath();
    try {
      // safe-git-allow: incremental-migration
      fs.unlinkSync(filePath);
    } catch {
      // @silent-fallback-ok — file may not exist; clearing a nonexistent handoff note is a no-op
    }
  }

  // ── Private Helpers ────────────────────────────────────────────────

  private handoffFilePath(): string {
    return path.join(this.handoffDir, HANDOFF_FILE);
  }

  private writeHandoffNote(note: HandoffNote): void {
    const filePath = this.handoffFilePath();
    fs.writeFileSync(filePath, JSON.stringify(note, null, 2));
  }

  /**
   * Commit any uncommitted changes as WIP.
   */
  private commitWip(): boolean {
    try {
      const status = this.git('status', '--porcelain');
      if (!status.trim()) return false;

      this.git('add', '-A');
      this.git('commit', '-m', `wip(${this.machineId}): handoff — work in progress`);
      return true;
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'HandoffManager.commitWip',
        primary: 'Commit work-in-progress before handoff',
        fallback: 'WIP commit failed — uncommitted changes may be lost during handoff',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Uncommitted work may not transfer to the receiving machine',
      });
      return false;
    }
  }

  /**
   * Pause all active ledger entries for this machine.
   */
  private pauseActiveEntries(): number {
    const ledger = this.workLedger.readOwnLedger();
    let paused = 0;

    for (const entry of ledger.entries) {
      if (entry.status === 'active') {
        this.workLedger.endWork(entry.id, 'paused');
        paused++;
      }
    }

    return paused;
  }

  /**
   * Collect active work items for the handoff note.
   */
  private collectActiveWork(resumeInstructions?: string): HandoffWorkItem[] {
    const ledger = this.workLedger.readOwnLedger();

    return ledger.entries
      .filter(e => e.status === 'paused' || e.status === 'active')
      .map(entry => ({
        entryId: entry.id,
        sessionId: entry.sessionId,
        branch: entry.branch,
        status: 'paused' as const,
        description: entry.task,
        filesModified: [...new Set([...entry.filesPlanned, ...entry.filesModified])],
        resumeInstructions,
      }));
  }

  /**
   * Detect active task branches.
   */
  private detectActiveBranches(): string[] {
    try {
      const output = this.git('branch', '--list', 'task/*');
      return output.split('\n')
        .map(l => l.replace(/^\*?\s+/, '').trim())
        .filter(l => l.length > 0);
    } catch {
      // @silent-fallback-ok — git branch listing for task detection; empty list is safe default
      return [];
    }
  }

  /**
   * Get current git HEAD.
   */
  private getGitHead(): string {
    try {
      return this.git('rev-parse', 'HEAD');
    } catch {
      // @silent-fallback-ok — HEAD lookup for metadata; 'unknown' is acceptable fallback
      return 'unknown';
    }
  }

  /**
   * Push all branches and tags.
   */
  private pushAll(): boolean {
    try {
      this.git('push', '--all');
      return true;
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'HandoffManager.pushAll',
        primary: 'Push all branches to remote before handoff',
        fallback: 'Push failed — remote may not have latest work',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Receiving machine may not get latest commits until next successful push',
      });
      return false;
    }
  }

  /**
   * Pull latest from remote.
   */
  private pullLatest(): boolean {
    try {
      this.git('pull', '--rebase', '--autostash');
      return true;
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'HandoffManager.pullLatest',
        primary: 'Pull latest changes from remote during resume',
        fallback: 'Pull failed — working with potentially stale state',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Machine may resume work without the latest remote changes',
      });
      return false;
    }
  }

  private git(...args: string[]): string {
    // safe-git-allow: incremental-migration
    return execFileSync('git', args, {
      cwd: this.projectDir,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }
}
