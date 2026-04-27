/**
 * SyncOrchestrator — Full sync lifecycle coordinator.
 *
 * Integrates all INTELLIGENT_SYNC_SPEC modules into a coherent sync lifecycle:
 *   - Periodic sync cycle (Section 9): lock → ledger → auto-commit → branch → fetch/rebase → resolve → push → update ledger → unlock
 *   - Task completion merge (Section 9): commit → switch → fetch → merge → resolve → validate → push → cleanup
 *   - Machine transition (Section 9/10): WIP commit → pause → handoff → push / pull → resume
 *
 * All module dependencies are optional — the orchestrator degrades gracefully
 * when modules are not configured. Core sync (GitSyncManager) always works;
 * additional modules add awareness, security, and coordination layers.
 *
 * From INTELLIGENT_SYNC_SPEC Section 9 (Sync Lifecycle) and Section 13 (Distributed Coordination).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { GitSyncManager } from './GitSync.js';
import type { GitSyncConfig, SyncResult } from './GitSync.js';
import type { WorkLedger, LedgerEntry } from './WorkLedger.js';
import type { BranchManager, MergeResult } from './BranchManager.js';
import type { OverlapGuard, OverlapCheckResult } from './OverlapGuard.js';
import type { HandoffManager, HandoffResult, ResumeResult, HandoffReason } from './HandoffManager.js';
import type { SecretRedactor, RedactionResult } from './SecretRedactor.js';
import type { PromptGuard, ContentScanResult } from './PromptGuard.js';
import type { LedgerAuth } from './LedgerAuth.js';
import type { AccessControl } from './AccessControl.js';
import type { AuditTrail } from './AuditTrail.js';
import type { AgentBus } from './AgentBus.js';
import type { CoordinationProtocol } from './CoordinationProtocol.js';
import type { ConflictNegotiator } from './ConflictNegotiator.js';

// ── Types ────────────────────────────────────────────────────────────

export type SyncPhase =
  | 'idle'
  | 'acquiring-lock'
  | 'reading-ledger'
  | 'auto-committing'
  | 'branch-handling'
  | 'fetching'
  | 'resolving'
  | 'pushing'
  | 'updating-ledger'
  | 'releasing-lock';

export interface SyncOrchestratorConfig extends GitSyncConfig {
  /** Work ledger for inter-agent awareness. */
  workLedger?: WorkLedger;
  /** Branch manager for task branch lifecycle. */
  branchManager?: BranchManager;
  /** Overlap guard for conflict prevention. */
  overlapGuard?: OverlapGuard;
  /** Handoff manager for machine transitions. */
  handoffManager?: HandoffManager;
  /** Secret redactor for LLM prompt safety. */
  secretRedactor?: SecretRedactor;
  /** Prompt guard for injection defense. */
  promptGuard?: PromptGuard;
  /** Ledger auth for entry signing. */
  ledgerAuth?: LedgerAuth;
  /** Access control for RBAC. */
  accessControl?: AccessControl;
  /** Audit trail for tamper-evident logging. */
  auditTrail?: AuditTrail;
  /** Agent bus for real-time messaging. */
  agentBus?: AgentBus;
  /** Coordination protocol for inter-agent coordination. */
  coordinationProtocol?: CoordinationProtocol;
  /** Conflict negotiator for pre-merge negotiation. */
  conflictNegotiator?: ConflictNegotiator;
  /** Lock timeout in ms (default: 10 min). */
  lockTimeoutMs?: number;
  /** Periodic sync interval in ms (default: 30 min). */
  syncIntervalMs?: number;
  /** User ID for access control checks. */
  userId?: string;
  /** Session ID for audit trail context. */
  sessionId?: string;
}

export interface OrchestratedSyncResult extends SyncResult {
  /** Whether overlap was detected before sync. */
  overlapDetected: boolean;
  /** Overlap check result (if guard is configured). */
  overlapResult?: OverlapCheckResult;
  /** Whether ledger was updated. */
  ledgerUpdated: boolean;
  /** Current ledger entry ID (if work is tracked). */
  ledgerEntryId?: string;
  /** Whether real-time coordination was used. */
  coordinationUsed: boolean;
  /** Audit entries generated during this sync. */
  auditEntriesGenerated: number;
  /** Security events detected. */
  securityEvents: number;
  /** Current sync phase at completion. */
  phase: SyncPhase;
  /** Duration of the sync in ms. */
  durationMs: number;
}

export interface TaskCompletionResult {
  /** Whether the task completion succeeded. */
  success: boolean;
  /** Merge result from BranchManager. */
  mergeResult?: MergeResult;
  /** Whether post-merge validation passed. */
  validationPassed: boolean;
  /** Whether the push succeeded. */
  pushed: boolean;
  /** Files that had conflicts. */
  conflicts: string[];
  /** Whether the branch was cleaned up. */
  branchCleaned: boolean;
  /** Ledger entry status after completion. */
  ledgerStatus?: string;
  /** Error if the completion failed. */
  error?: string;
}

export interface TransitionResult {
  /** Whether the transition completed. */
  success: boolean;
  /** Handoff/resume result from HandoffManager. */
  handoffResult?: HandoffResult;
  /** Resume result (for incoming machine). */
  resumeResult?: ResumeResult;
  /** Whether coordination peers were notified. */
  peersNotified: boolean;
  /** Error if transition failed. */
  error?: string;
}

export interface SyncLock {
  /** Machine that holds the lock. */
  machineId: string;
  /** When the lock was acquired. */
  acquiredAt: string;
  /** Lock timeout (absolute timestamp). */
  expiresAt: string;
  /** Process ID (for stale detection). */
  pid: number;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_LOCK_TIMEOUT = 10 * 60 * 1000; // 10 minutes
const DEFAULT_SYNC_INTERVAL = 30 * 60 * 1000; // 30 minutes
const LOCK_FILE = 'sync.lock';

// ── SyncOrchestrator ─────────────────────────────────────────────────

export class SyncOrchestrator extends EventEmitter {
  // Core
  private gitSync: GitSyncManager;
  private projectDir: string;
  private stateDir: string;
  private machineId: string;
  private lockTimeoutMs: number;
  private syncIntervalMs: number;
  private userId?: string;
  private sessionId?: string;

  // Optional modules
  private workLedger?: WorkLedger;
  private branchManager?: BranchManager;
  private overlapGuard?: OverlapGuard;
  private handoffManager?: HandoffManager;
  private secretRedactor?: SecretRedactor;
  private promptGuard?: PromptGuard;
  private ledgerAuth?: LedgerAuth;
  private accessControl?: AccessControl;
  private auditTrail?: AuditTrail;
  private agentBus?: AgentBus;
  private coordinationProtocol?: CoordinationProtocol;
  private conflictNegotiator?: ConflictNegotiator;

  // State
  private currentPhase: SyncPhase = 'idle';
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private activeLedgerEntryId?: string;
  private syncInProgress = false;

  constructor(config: SyncOrchestratorConfig) {
    super();

    this.projectDir = config.projectDir;
    this.stateDir = config.stateDir;
    this.machineId = config.machineId;
    this.lockTimeoutMs = config.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT;
    this.syncIntervalMs = config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL;
    this.userId = config.userId;
    this.sessionId = config.sessionId;

    // Initialize core GitSync
    this.gitSync = new GitSyncManager({
      projectDir: config.projectDir,
      stateDir: config.stateDir,
      identityManager: config.identityManager,
      securityLog: config.securityLog,
      machineId: config.machineId,
      autoPush: config.autoPush,
      debounceMs: config.debounceMs,
      intelligence: config.intelligence,
    });

    // Wire optional modules
    this.workLedger = config.workLedger;
    this.branchManager = config.branchManager;
    this.overlapGuard = config.overlapGuard;
    this.handoffManager = config.handoffManager;
    this.secretRedactor = config.secretRedactor;
    this.promptGuard = config.promptGuard;
    this.ledgerAuth = config.ledgerAuth;
    this.accessControl = config.accessControl;
    this.auditTrail = config.auditTrail;
    this.agentBus = config.agentBus;
    this.coordinationProtocol = config.coordinationProtocol;
    this.conflictNegotiator = config.conflictNegotiator;

    // Ensure lock directory exists
    const lockDir = path.join(this.stateDir, 'state');
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }
  }

  // ── Accessors ──────────────────────────────────────────────────────

  /** Current sync phase. */
  getPhase(): SyncPhase {
    return this.currentPhase;
  }

  /** Whether a sync is currently in progress. */
  isSyncing(): boolean {
    return this.syncInProgress;
  }

  /** The underlying GitSyncManager instance. */
  getGitSync(): GitSyncManager {
    return this.gitSync;
  }

  /** Current active ledger entry ID. */
  getActiveLedgerEntryId(): string | undefined {
    return this.activeLedgerEntryId;
  }

  // ── Lock Management ────────────────────────────────────────────────

  /**
   * Acquire the sync lock. Returns true if acquired, false if held by another.
   * Automatically reclaims expired locks.
   */
  acquireLock(): boolean {
    const lockPath = this.lockFilePath();
    const now = Date.now();

    // Check for existing lock
    if (fs.existsSync(lockPath)) {
      try {
        const existing: SyncLock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
        const expiresAt = new Date(existing.expiresAt).getTime();

        // Lock still valid and held by someone else
        if (expiresAt > now && existing.machineId !== this.machineId) {
          return false;
        }

        // Same machine re-acquiring — allowed (reentrant)
        if (existing.machineId === this.machineId) {
          return true;
        }

        // Expired lock — reclaim it
        this.auditTrail?.logSecurity({
          event: 'stale-lock-reclaimed',
          severity: 'low',
          details: `Reclaimed expired sync lock from ${existing.machineId}`,
          sessionId: this.sessionId,
        });
      } catch {
        // Corrupted lock file — overwrite
      }
    }

    // Write new lock
    const lock: SyncLock = {
      machineId: this.machineId,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(now + this.lockTimeoutMs).toISOString(),
      pid: process.pid,
    };

    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    return true;
  }

  /**
   * Release the sync lock. Only releases if we hold it.
   */
  releaseLock(): boolean {
    const lockPath = this.lockFilePath();

    if (!fs.existsSync(lockPath)) return true;

    try {
      const lock: SyncLock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      if (lock.machineId !== this.machineId) return false;

      // safe-git-allow: incremental-migration
      fs.unlinkSync(lockPath);
      return true;
    } catch {
      // @silent-fallback-ok — corrupted lock file; attempt removal as cleanup
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(lockPath); } catch { /* @silent-fallback-ok — lock file removal is best-effort cleanup */ }
      return true;
    }
  }

  /**
   * Check if the sync lock is currently held.
   */
  isLocked(): boolean {
    const lockPath = this.lockFilePath();
    if (!fs.existsSync(lockPath)) return false;

    try {
      const lock: SyncLock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      return new Date(lock.expiresAt).getTime() > Date.now();
    } catch {
      // @silent-fallback-ok — corrupted lock file treated as unlocked; safe default
      return false;
    }
  }

  /**
   * Get info about who holds the lock.
   */
  getLockHolder(): SyncLock | null {
    const lockPath = this.lockFilePath();
    if (!fs.existsSync(lockPath)) return null;

    try {
      return JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    } catch {
      // @silent-fallback-ok — lock file may not exist or be corrupted; null signals no lock holder
      return null;
    }
  }

  private lockFilePath(): string {
    return path.join(this.stateDir, 'state', LOCK_FILE);
  }

  // ── Periodic Sync Cycle ────────────────────────────────────────────

  /**
   * Run a full periodic sync cycle (spec Section 9).
   *
   * Steps:
   * 1. Acquire lock (prevent concurrent syncs)
   * 2. Read work ledger — note active work on other machines
   * 3. Auto-commit operational files
   * 4. Handle branch context (task branch vs main)
   * 5. Fetch + rebase from remote
   * 6. Tiered conflict resolution
   * 7. Push to remote
   * 8. Update work ledger with current state
   * 9. Release lock
   */
  async periodicSync(opts?: {
    /** Files currently being worked on (for overlap check). */
    currentFiles?: string[];
    /** Current task description (for overlap detection). */
    currentTask?: string;
  }): Promise<OrchestratedSyncResult> {
    const startTime = Date.now();
    let auditEntries = 0;
    let securityEvents = 0;

    const result: OrchestratedSyncResult = {
      pulled: false,
      pushed: false,
      commitsPulled: 0,
      commitsPushed: 0,
      rejectedCommits: [],
      conflicts: [],
      overlapDetected: false,
      ledgerUpdated: false,
      coordinationUsed: false,
      auditEntriesGenerated: 0,
      securityEvents: 0,
      phase: 'idle',
      durationMs: 0,
    };

    // No git repo — return clean no-op
    if (!this.gitSync.isGitRepo()) {
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Prevent concurrent syncs
    if (this.syncInProgress) {
      result.phase = 'idle';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    this.syncInProgress = true;

    try {
      // Step 1: Acquire lock
      this.setPhase('acquiring-lock');
      if (!this.acquireLock()) {
        result.phase = 'acquiring-lock';
        result.durationMs = Date.now() - startTime;
        this.syncInProgress = false;
        return result;
      }

      // RBAC check (if configured)
      if (this.accessControl && this.userId) {
        const accessCheck = this.accessControl.check(this.userId, 'code:modify');
        if (!accessCheck.allowed) {
          this.auditTrail?.logAccessDenied({
            userId: this.userId,
            permission: 'code:modify',
            role: accessCheck.role,
            action: 'periodic-sync',
            sessionId: this.sessionId,
          });
          auditEntries++;
          this.releaseLock();
          this.syncInProgress = false;
          result.durationMs = Date.now() - startTime;
          result.auditEntriesGenerated = auditEntries;
          return result;
        }
      }

      // Step 2: Read work ledger
      this.setPhase('reading-ledger');
      let otherWork: LedgerEntry[] = [];
      if (this.workLedger) {
        otherWork = this.workLedger.getActiveEntries()
          .filter(e => e.machineId !== this.machineId);
      }

      // Check for overlaps
      if (this.overlapGuard && opts?.currentFiles?.length) {
        const overlapResult = this.overlapGuard.check({
          plannedFiles: opts.currentFiles,
          task: opts.currentTask ?? 'periodic-sync',
        });
        result.overlapDetected = !overlapResult.canProceed;
        result.overlapResult = overlapResult;

        if (!overlapResult.canProceed) {
          this.auditTrail?.logSecurity({
            event: 'sync-blocked-by-overlap',
            severity: 'medium',
            details: overlapResult.suggestion,
            sessionId: this.sessionId,
          });
          auditEntries++;
          securityEvents++;
          this.emit('overlap-blocked', overlapResult);
        }
      }

      // Announce sync start via coordination protocol
      if (this.coordinationProtocol) {
        try {
          await this.coordinationProtocol.announceWork({
            workId: `sync_${crypto.randomBytes(4).toString('hex')}`,
            action: 'started',
            task: 'periodic-sync',
            files: opts?.currentFiles ?? [],
            sessionId: this.sessionId ?? '',
          });
          result.coordinationUsed = true;
        } catch {
          // Non-fatal — coordination is best-effort
        }
      }

      // Step 3: Auto-commit operational files
      this.setPhase('auto-committing');
      this.gitSync.flushAutoCommit();

      // Step 4: Handle branch context
      this.setPhase('branch-handling');
      let wasOnTaskBranch = false;
      let taskBranchName: string | undefined;

      if (this.branchManager) {
        const currentBranch = this.getCurrentBranch();
        if (currentBranch && currentBranch !== 'main' && currentBranch.startsWith('task/')) {
          wasOnTaskBranch = true;
          taskBranchName = currentBranch;

          // Commit WIP on task branch
          this.gitSync.flushAutoCommit();

          // Switch to main for sync
          this.gitExecSafe(['checkout', 'main']);
        }
      }

      // Step 5: Fetch + rebase from remote
      this.setPhase('fetching');
      const syncResult = await this.gitSync.sync();
      result.pulled = syncResult.pulled;
      result.pushed = syncResult.pushed;
      result.commitsPulled = syncResult.commitsPulled;
      result.commitsPushed = syncResult.commitsPushed;
      result.rejectedCommits = syncResult.rejectedCommits;
      result.conflicts = syncResult.conflicts;

      // Step 6: If there were conflicts, audit them
      this.setPhase('resolving');
      if (syncResult.conflicts.length > 0) {
        this.auditTrail?.logResolution({
          file: syncResult.conflicts.join(', '),
          chosenSide: 'merged',
          confidence: 0,
          tier: 0,
          conflictRegions: syncResult.conflicts.length,
          sessionId: this.sessionId,
        });
        auditEntries++;
      }

      // Step 7: Push
      this.setPhase('pushing');
      // Push already handled by gitSync.sync() if autoPush is true

      // Step 4b: Return to task branch if we were on one
      if (wasOnTaskBranch && taskBranchName) {
        this.gitExecSafe(['checkout', taskBranchName]);

        // Optionally rebase task branch onto updated main
        try {
          this.gitExecSafe(['rebase', 'main']);
        } catch {
          // Rebase conflict on task branch — non-fatal for periodic sync
        }
      }

      // Step 8: Update work ledger
      this.setPhase('updating-ledger');
      if (this.workLedger && this.activeLedgerEntryId) {
        this.workLedger.updateWork(this.activeLedgerEntryId, {
          filesModified: opts?.currentFiles,
        });
        result.ledgerUpdated = true;
        result.ledgerEntryId = this.activeLedgerEntryId;

        // Sign ledger entry if auth is configured
        if (this.ledgerAuth) {
          const ledger = this.workLedger.getActiveEntries()
            .find(e => e.id === this.activeLedgerEntryId);
          if (ledger) {
            this.ledgerAuth.signEntry(ledger);
          }
        }
      }

      // Announce sync complete
      if (this.coordinationProtocol) {
        try {
          await this.coordinationProtocol.announceWork({
            workId: `sync_${crypto.randomBytes(4).toString('hex')}`,
            action: 'completed',
            task: 'periodic-sync',
            files: opts?.currentFiles ?? [],
            sessionId: this.sessionId ?? '',
          });
        } catch {
          // Best-effort
        }
      }

      // Step 9: Release lock
      this.setPhase('releasing-lock');
      this.releaseLock();

      this.setPhase('idle');
      result.phase = 'idle';
      result.auditEntriesGenerated = auditEntries;
      result.securityEvents = securityEvents;
      result.durationMs = Date.now() - startTime;

      this.emit('sync-complete', result);
      return result;
    } catch (err) {
      // Always release lock on error
      this.releaseLock();
      this.setPhase('idle');

      result.phase = 'idle';
      result.auditEntriesGenerated = auditEntries;
      result.securityEvents = securityEvents;
      result.durationMs = Date.now() - startTime;

      this.auditTrail?.logSecurity({
        event: 'sync-error',
        severity: 'high',
        details: err instanceof Error ? err.message : String(err),
        sessionId: this.sessionId,
      });

      this.emit('sync-error', err);
      return result;
    } finally {
      this.syncInProgress = false;
    }
  }

  // ── Task Completion Merge ──────────────────────────────────────────

  /**
   * Complete a task on a branch — merge back to main (spec Section 9).
   *
   * Steps:
   * 1. Commit all changes on task branch
   * 2. Check access control
   * 3. Request file avoidance from peers (if coordination available)
   * 4. Switch to main
   * 5. Fetch + rebase main from remote
   * 6. Merge task branch into main
   * 7. If conflicts → try negotiation, then tiered resolution
   * 8. Post-merge validation
   * 9. Push main
   * 10. Cleanup: delete branch, update ledger
   */
  async completeTask(opts: {
    /** Branch name to complete. */
    branchName: string;
    /** Commit message for the final commit. */
    commitMessage?: string;
    /** Ledger entry ID to mark as completed. */
    ledgerEntryId?: string;
    /** Files modified in this task (for coordination). */
    filesModified?: string[];
  }): Promise<TaskCompletionResult> {
    const result: TaskCompletionResult = {
      success: false,
      validationPassed: false,
      pushed: false,
      conflicts: [],
      branchCleaned: false,
    };

    if (!this.branchManager) {
      result.error = 'BranchManager not configured';
      return result;
    }

    // Step 2: Check access control
    if (this.accessControl && this.userId) {
      const mergeCheck = this.accessControl.check(this.userId, 'branch:merge');
      if (!mergeCheck.allowed) {
        this.auditTrail?.logAccessDenied({
          userId: this.userId,
          permission: 'branch:merge',
          role: mergeCheck.role,
          action: `complete-task:${opts.branchName}`,
          sessionId: this.sessionId,
        });
        result.error = `Access denied: ${mergeCheck.reason}`;
        return result;
      }
    }

    // Step 3: Request file avoidance from peers
    if (this.coordinationProtocol && opts.filesModified?.length) {
      try {
        await this.coordinationProtocol.broadcastFileAvoidance({
          files: opts.filesModified,
          durationMs: 5 * 60 * 1000, // 5 minutes
          reason: `Task branch merge: ${opts.branchName}`,
        });
      } catch {
        // Non-fatal
      }
    }

    // Announce merge start
    if (this.coordinationProtocol) {
      try {
        await this.coordinationProtocol.announceWork({
          workId: `merge_${crypto.randomBytes(4).toString('hex')}`,
          action: 'started',
          task: `merge:${opts.branchName}`,
          files: opts.filesModified ?? [],
          sessionId: this.sessionId ?? '',
        });
      } catch {
        // Best-effort
      }
    }

    try {
      // Steps 1, 4-6: Use BranchManager.completeBranch()
      const mergeResult = this.branchManager.completeBranch(opts.branchName, {
        commitMessage: opts.commitMessage,
      });
      result.mergeResult = mergeResult;
      result.conflicts = mergeResult.conflicts;

      // Step 7: If conflicts, try negotiation then resolution
      if (!mergeResult.success && mergeResult.conflicts.length > 0) {
        // Try negotiation with peers if available
        if (this.conflictNegotiator) {
          for (const conflict of mergeResult.conflicts) {
            // Find peer who is working on this file
            const peerWork = this.findPeerWorkOnFile(conflict);
            if (peerWork) {
              try {
                const negotiation = await this.conflictNegotiator.negotiate({
                  targetMachineId: peerWork.machineId,
                  filePath: conflict,
                  strategy: 'merge-by-section',
                  reasoning: `Task branch merge: ${opts.branchName}`,
                  sessionId: this.sessionId,
                });

                if (negotiation.status === 'agreed') {
                  // Negotiation succeeded — conflict resolved by agreement
                  result.conflicts = result.conflicts.filter(c => c !== conflict);
                }
              } catch {
                // Negotiation failed — fall through to LLM resolution
              }
            }
          }
        }

        // If still conflicts, they'll be handled by GitSync's resolution
        if (result.conflicts.length > 0) {
          result.error = `Merge conflicts in: ${result.conflicts.join(', ')}`;
          this.auditTrail?.logBranch({
            action: 'merge',
            branch: opts.branchName,
            result: 'conflict',
            conflictFiles: result.conflicts,
            sessionId: this.sessionId,
          });
          return result;
        }
      }

      if (mergeResult.success) {
        result.validationPassed = mergeResult.validationPassed ?? true;

        // Step 8: If validation failed, the BranchManager already handled rollback

        // Step 9: Push main
        try {
          this.gitExecSafe(['push']);
          result.pushed = true;
        } catch {
          // Push failed — non-fatal, changes are local
        }

        // Step 10: Update ledger
        const entryId = opts.ledgerEntryId ?? this.activeLedgerEntryId;
        if (this.workLedger && entryId) {
          this.workLedger.endWork(entryId, 'completed');
          result.ledgerStatus = 'completed';
        }

        result.branchCleaned = true;
        result.success = true;

        // Audit the branch merge
        this.auditTrail?.logBranch({
          action: 'merge',
          branch: opts.branchName,
          result: 'success',
          sessionId: this.sessionId,
        });

        // Announce completion
        if (this.coordinationProtocol) {
          try {
            await this.coordinationProtocol.announceWork({
              workId: `merge_${crypto.randomBytes(4).toString('hex')}`,
              action: 'completed',
              task: `merge:${opts.branchName}`,
              files: opts.filesModified ?? [],
              sessionId: this.sessionId ?? '',
            });
          } catch {
            // Best-effort
          }
        }
      }

      return result;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);

      this.auditTrail?.logBranch({
        action: 'merge',
        branch: opts.branchName,
        result: 'failed',
        sessionId: this.sessionId,
      });

      return result;
    }
  }

  // ── Machine Transition ─────────────────────────────────────────────

  /**
   * Initiate a machine transition (outgoing machine).
   *
   * Steps:
   * 1. Complete any in-progress sync cycle
   * 2. Commit and push all work (including WIP)
   * 3. Update work ledger: all entries → paused
   * 4. Write handoff note
   * 5. Notify peers via coordination protocol
   * 6. Release locks
   */
  async initiateTransition(opts?: {
    reason?: HandoffReason;
    resumeInstructions?: string;
  }): Promise<TransitionResult> {
    const result: TransitionResult = {
      success: false,
      peersNotified: false,
    };

    // Step 1: Complete any in-progress sync
    if (this.syncInProgress) {
      // Wait briefly for current sync to finish
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Step 2-4: Use HandoffManager if available
    if (this.handoffManager) {
      const handoffResult = this.handoffManager.initiateHandoff({
        reason: opts?.reason,
        resumeInstructions: opts?.resumeInstructions,
      });
      result.handoffResult = handoffResult;
      result.success = handoffResult.success;

      // Audit the handoff
      this.auditTrail?.logHandoff({
        fromMachine: this.machineId,
        reason: opts?.reason ?? 'user-initiated',
        workItemCount: handoffResult.entriesPaused,
        sessionId: this.sessionId,
      });
    } else {
      // Minimal transition without HandoffManager:
      // Flush auto-commits and pause ledger entries
      this.gitSync.flushAutoCommit();

      if (this.workLedger && this.activeLedgerEntryId) {
        this.workLedger.endWork(this.activeLedgerEntryId, 'paused');
      }

      try {
        this.gitExecSafe(['push']);
        result.success = true;
      } catch {
        result.error = 'Push failed during minimal transition';
      }
    }

    // Step 5: Notify peers
    if (this.coordinationProtocol) {
      try {
        await this.coordinationProtocol.announceWork({
          workId: `transition_${crypto.randomBytes(4).toString('hex')}`,
          action: 'paused',
          task: 'machine-transition',
          files: [],
          sessionId: this.sessionId ?? '',
        });
        result.peersNotified = true;
      } catch {
        // Non-fatal
      }
    }

    // Step 6: Release locks
    this.releaseLock();

    // Stop periodic sync if running
    this.stopPeriodicSync();

    // Stop agent bus if running
    if (this.agentBus) {
      try {
        this.agentBus.stopPolling();
      } catch {
        // Best-effort
      }
    }

    this.emit('transition-out', result);
    return result;
  }

  /**
   * Resume from a machine transition (incoming machine).
   *
   * Steps:
   * 1. Pull all branches
   * 2. Read work ledger to understand paused work
   * 3. Read handoff note
   * 4. Resume from where outgoing machine left off
   * 5. Start agent bus and coordination
   * 6. Start periodic sync
   */
  async resumeFromTransition(): Promise<TransitionResult> {
    const result: TransitionResult = {
      success: false,
      peersNotified: false,
    };

    if (this.handoffManager) {
      const resumeResult = this.handoffManager.resume();
      result.resumeResult = resumeResult;
      result.success = resumeResult.success;

      // Start tracking work in ledger
      if (this.workLedger && resumeResult.resumableWork.length > 0) {
        const firstWork = resumeResult.resumableWork[0];
        const entry = this.workLedger.startWork({
          sessionId: firstWork.sessionId || this.sessionId || 'resumed',
          task: firstWork.description,
          filesPlanned: firstWork.filesModified,
          branch: firstWork.branch,
        });
        this.activeLedgerEntryId = entry.id;
      }
    } else {
      // Minimal resume: pull latest
      try {
        this.gitExecSafe(['pull', '--rebase', '--autostash']);
        result.success = true;
      } catch {
        result.error = 'Pull failed during minimal resume';
      }
    }

    // Start agent bus
    if (this.agentBus) {
      try {
        this.agentBus.startPolling();
      } catch {
        // Non-fatal
      }
    }

    // Announce arrival
    if (this.coordinationProtocol) {
      try {
        await this.coordinationProtocol.announceWork({
          workId: `resume_${crypto.randomBytes(4).toString('hex')}`,
          action: 'resumed',
          task: 'machine-transition-resume',
          files: [],
          sessionId: this.sessionId ?? '',
        });
        result.peersNotified = true;
      } catch {
        // Non-fatal
      }
    }

    this.emit('transition-in', result);
    return result;
  }

  // ── Work Tracking ──────────────────────────────────────────────────

  /**
   * Start tracking work in the ledger.
   */
  startWork(opts: {
    sessionId: string;
    task: string;
    filesPlanned?: string[];
    branch?: string;
  }): LedgerEntry | null {
    if (!this.workLedger) return null;

    const entry = this.workLedger.startWork(opts);
    this.activeLedgerEntryId = entry.id;

    // Sign entry if auth is configured
    if (this.ledgerAuth) {
      this.ledgerAuth.signEntry(entry);
    }

    return entry;
  }

  /**
   * Update current work tracking.
   */
  updateWork(updates: {
    task?: string;
    filesModified?: string[];
    filesPlanned?: string[];
  }): boolean {
    if (!this.workLedger || !this.activeLedgerEntryId) return false;
    return this.workLedger.updateWork(this.activeLedgerEntryId, updates);
  }

  /**
   * End current work tracking.
   */
  endWork(status: 'completed' | 'paused' = 'completed'): boolean {
    if (!this.workLedger || !this.activeLedgerEntryId) return false;
    const result = this.workLedger.endWork(this.activeLedgerEntryId, status);
    if (result) this.activeLedgerEntryId = undefined;
    return result;
  }

  // ── Security Pipeline ──────────────────────────────────────────────

  /**
   * Redact secrets from content before LLM exposure.
   * Returns the redacted content and a restoration map.
   */
  redactForLLM(content: string, fileSection?: 'ours' | 'theirs' | 'base'): RedactionResult | null {
    if (!this.secretRedactor) return null;

    const result = this.secretRedactor.redact(content, fileSection ?? 'unknown');

    if (result.count > 0 && this.auditTrail) {
      this.auditTrail.logRedaction({
        file: 'llm-prompt',
        totalRedactions: result.count,
        typeCounts: result.typeCounts as Record<string, number>,
        entropyStringsFound: result.typeCounts['high-entropy'] ?? 0,
        sessionId: this.sessionId,
      });
    }

    return result;
  }

  /**
   * Scan content for prompt injection before LLM submission.
   */
  scanForInjection(content: string): ContentScanResult | null {
    if (!this.promptGuard) return null;

    const result = this.promptGuard.scanContent(content);

    if (result.detected && this.auditTrail) {
      this.auditTrail.logSecurity({
        event: 'prompt-injection-detected',
        severity: result.shouldBlock ? 'high' : 'medium',
        details: `${result.matches.length} injection patterns detected (threat: ${result.threatLevel})`,
        sessionId: this.sessionId,
      });
    }

    return result;
  }

  // ── Periodic Sync Timer ────────────────────────────────────────────

  /**
   * Start periodic sync at the configured interval.
   */
  startPeriodicSync(opts?: {
    currentFiles?: string[];
    currentTask?: string;
  }): void {
    if (this.syncTimer) return;

    this.syncTimer = setInterval(async () => {
      try {
        await this.periodicSync(opts);
      } catch {
        // @silent-fallback-ok — periodic sync errors are non-fatal; next cycle will retry
      }
    }, this.syncIntervalMs);

    // Unref so the timer doesn't prevent process exit
    if (this.syncTimer.unref) {
      this.syncTimer.unref();
    }
  }

  /**
   * Stop the periodic sync timer.
   */
  stopPeriodicSync(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * Stop all orchestrator activity: timer, bus, flush pending commits.
   */
  stop(): void {
    this.stopPeriodicSync();
    this.gitSync.stop();

    if (this.agentBus) {
      try { this.agentBus.stopPolling(); } catch { /* @silent-fallback-ok — polling stop is best-effort shutdown cleanup */ }
    }
  }

  // ── Private Helpers ────────────────────────────────────────────────

  private setPhase(phase: SyncPhase): void {
    this.currentPhase = phase;
    this.emit('phase-change', phase);
  }

  /**
   * Get the current git branch name.
   */
  private getCurrentBranch(): string | null {
    try {
      return this.gitExecSafe(['rev-parse', '--abbrev-ref', 'HEAD']);
    } catch {
      // @silent-fallback-ok — branch detection may fail outside a git repo; null is the expected fallback
      return null;
    }
  }

  /**
   * Find a peer's work entry that touches a specific file.
   */
  private findPeerWorkOnFile(filePath: string): LedgerEntry | undefined {
    if (!this.workLedger) return undefined;

    return this.workLedger.getActiveEntries()
      .filter(e => e.machineId !== this.machineId)
      .find(e =>
        e.filesPlanned.includes(filePath) || e.filesModified.includes(filePath)
      );
  }

  /**
   * Execute a git command with safe error handling.
   */
  private gitExecSafe(args: string[]): string {
    // safe-git-allow: incremental-migration
    return execFileSync('git', args, {
      cwd: this.projectDir,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }
}
