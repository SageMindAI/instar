/**
 * Git-based state synchronization for multi-machine coordination.
 *
 * Handles:
 * - Configuring git commit signing with machine Ed25519 keys
 * - Commit signing verification on pull
 * - Debounced auto-commit + push
 * - Relationship merge with field-level resolution
 * - Conflict resolution strategies
 *
 * Part of Phase 3 (state sync via git).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { MachineIdentityManager } from './MachineIdentity.js';
import type { SecurityLog } from './SecurityLog.js';
import type { IntelligenceProvider } from './types.js';
import { LLMConflictResolver } from './LLMConflictResolver.js';
import type { ConflictFile, EscalationContext, ResolutionResult } from './LLMConflictResolver.js';
import { FileClassifier } from './FileClassifier.js';
import type { ClassificationResult } from './FileClassifier.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { assertNotInstarSourceTree } from './SourceTreeGuard.js';

// ── Types ────────────────────────────────────────────────────────────

export interface GitSyncConfig {
  /** Project directory (repo root). */
  projectDir: string;
  /** State directory (.instar). */
  stateDir: string;
  /** Machine identity manager. */
  identityManager: MachineIdentityManager;
  /** Security log. */
  securityLog: SecurityLog;
  /** This machine's ID. */
  machineId: string;
  /** Auto-push after commits (default: true). */
  autoPush?: boolean;
  /** Debounce interval in ms for auto-commit (default: 30000). */
  debounceMs?: number;
  /** Intelligence provider for LLM-based conflict resolution. */
  intelligence?: IntelligenceProvider;
}

export interface SyncResult {
  /** Whether changes were pulled. */
  pulled: boolean;
  /** Whether changes were pushed. */
  pushed: boolean;
  /** Number of commits pulled. */
  commitsPulled: number;
  /** Number of commits pushed. */
  commitsPushed: number;
  /** Rejected commits (unsigned or from revoked machines). */
  rejectedCommits: string[];
  /** Merge conflicts that need manual review. */
  conflicts: string[];
}

export interface RelationshipRecord {
  id: string;
  name: string;
  channels: Array<{ type: string; identifier: string }>;
  firstInteraction: string;
  lastInteraction: string;
  interactionCount: number;
  themes: string[];
  notes: string;
  significance: number;
  arcSummary: string;
  recentInteractions: Array<{ timestamp: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

// ── Git Sync Manager ─────────────────────────────────────────────────

export class GitSyncManager {
  private projectDir: string;
  private stateDir: string;
  private identityManager: MachineIdentityManager;
  private securityLog: SecurityLog;
  private machineId: string;
  private autoPush: boolean;
  private debounceMs: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPaths: Set<string> = new Set();
  private llmResolver: LLMConflictResolver | null = null;
  private fileClassifier: FileClassifier;

  constructor(config: GitSyncConfig) {
    assertNotInstarSourceTree(config.projectDir, 'GitSyncManager');
    this.projectDir = config.projectDir;
    this.stateDir = config.stateDir;
    this.identityManager = config.identityManager;
    this.securityLog = config.securityLog;
    this.machineId = config.machineId;
    this.autoPush = config.autoPush ?? true;
    this.debounceMs = config.debounceMs ?? 30_000;

    // Initialize file classifier
    this.fileClassifier = new FileClassifier({ projectDir: config.projectDir });

    // Initialize LLM resolver if intelligence provider is available
    if (config.intelligence) {
      this.llmResolver = new LLMConflictResolver({
        intelligence: config.intelligence,
        projectDir: config.projectDir,
        stateDir: config.stateDir,
      });
    }
  }

  /**
   * Check if the project directory is a git repository with at least one commit.
   * Returns false if .git/ doesn't exist or if git rev-parse HEAD fails
   * (e.g., empty repo with no commits) — prevents crashes when git sync
   * is called on a standalone agent that hasn't opted into git backup.
   */
  isGitRepo(): boolean {
    if (!fs.existsSync(path.join(this.projectDir, '.git'))) return false;
    try {
      this.gitExec(['rev-parse', '--verify', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Set the intelligence provider for LLM-based conflict resolution.
   * Can be called after construction when the provider becomes available.
   */
  setIntelligence(intelligence: IntelligenceProvider): void {
    if (!this.llmResolver) {
      this.llmResolver = new LLMConflictResolver({
        intelligence,
        projectDir: this.projectDir,
        stateDir: this.stateDir,
      });
    }
  }

  // ── Setup ───────────────────────────────────────────────────────

  /**
   * Configure git commit signing with this machine's Ed25519 key.
   * Requires git >= 2.34 for SSH signing support.
   */
  configureCommitSigning(): void {
    const keyPath = path.join(this.stateDir, 'machine', 'signing-private.pem');
    if (!fs.existsSync(keyPath)) {
      throw new Error('Machine signing key not found. Run `instar pair` first.');
    }

    // Git uses SSH-format keys for signing. Our Ed25519 PEM works with git's ssh signing.
    this.gitConfig('user.signingkey', keyPath);
    this.gitConfig('gpg.format', 'ssh');
    this.gitConfig('commit.gpgsign', 'true');
  }

  /**
   * Check if commit signing is configured for this repo.
   */
  isSigningConfigured(): boolean {
    try {
      const format = this.gitConfigGet('gpg.format');
      const signing = this.gitConfigGet('commit.gpgsign');
      return format === 'ssh' && signing === 'true';
    } catch {
      // @silent-fallback-ok — git config read, signing detection
      return false;
    }
  }

  // ── Sync Operations ─────────────────────────────────────────────

  /**
   * Full sync: pull → verify → resolve → push.
   */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      pulled: false,
      pushed: false,
      commitsPulled: 0,
      commitsPushed: 0,
      rejectedCommits: [],
      conflicts: [],
    };

    // No git repo — return clean no-op (standalone agent without git backup)
    if (!this.isGitRepo()) return result;

    // 0. Pre-flight: detect and fix stuck rebase / detached HEAD before attempting pull
    let rebaseJustAborted = false;
    try {
      const statusOut = this.gitExec(['status']);
      if (statusOut.includes('rebase in progress') || statusOut.includes('interactive rebase in progress')) {
        console.log('[GitSync] Pre-flight: stuck rebase detected — aborting before pull');
        try {
          this.gitExec(['rebase', '--abort']);
          rebaseJustAborted = true;
          console.log('[GitSync] Pre-flight: rebase aborted successfully');
        } catch (abortErr) {
          console.error(`[GitSync] Pre-flight: rebase abort failed: ${abortErr}`);
        }
      }
      // Check for detached HEAD (no branch)
      try {
        const branch = this.gitExec(['symbolic-ref', '--short', 'HEAD']).trim();
        if (!branch) throw new Error('no branch');
      } catch {
        // Detached HEAD — try to get back on main/master
        console.log('[GitSync] Pre-flight: detached HEAD detected — attempting to checkout main branch');
        try {
          // Try 'main' first, then 'master'
          try {
            this.gitExec(['checkout', 'main']);
          } catch {
            this.gitExec(['checkout', 'master']);
          }
          console.log('[GitSync] Pre-flight: back on main branch');
        } catch (checkoutErr) {
          console.error(`[GitSync] Pre-flight: could not recover from detached HEAD: ${checkoutErr}`);
          DegradationReporter.getInstance().report({
            feature: 'GitSync.pull',
            primary: 'Clean git pull',
            fallback: 'Skipping pull (detached HEAD)',
            reason: 'Git is in detached HEAD state and auto-recovery failed. Run: git checkout main',
            impact: 'Git sync disabled until HEAD is reattached to a branch.',
          });
          return result;
        }
      }
    } catch (preflightErr) {
      // Non-fatal — continue with pull attempt
      console.warn(`[GitSync] Pre-flight check warning: ${preflightErr}`);
    }

    // 1. Pull (use merge instead of rebase if we just aborted a stuck rebase, to avoid recreating the same conflict)
    try {
      const beforeHead = this.gitHead();
      if (rebaseJustAborted) {
        console.log('[GitSync] Using merge pull (not rebase) after stuck rebase recovery');
        this.gitExec(['pull', '--no-rebase', '--autostash']);
      } else {
        this.gitExec(['pull', '--rebase', '--autostash']);
      }
      const afterHead = this.gitHead();
      result.pulled = beforeHead !== afterHead;

      if (result.pulled) {
        // Count commits pulled
        const log = this.gitExec(['log', '--oneline', `${beforeHead}..${afterHead}`]);
        result.commitsPulled = log.trim().split('\n').filter(l => l.trim()).length;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Check for merge conflicts
      if (errMsg.includes('CONFLICT') || errMsg.includes('could not apply')) {
        result.conflicts = this.detectConflicts();
        await this.resolveConflicts(result);
      } else if (errMsg.includes('untracked working tree files would be overwritten')) {
        // Untracked local files conflict with incoming remote files (e.g. .instar/ hooks
        // generated by setup but not committed to the repo). Auto-resolve by backing up
        // the conflicting files and retrying the pull.
        console.log('[GitSync] Untracked files blocking pull — auto-resolving by backing up and retrying');
        try {
          // Extract conflicting file paths from the error message
          const lines = errMsg.split('\n');
          const conflictingFiles: string[] = [];
          for (const line of lines) {
            const trimmed = line.trim();
            // Git lists files as indented paths after the error message
            if (trimmed && !trimmed.startsWith('error:') && !trimmed.startsWith('Please move') &&
                !trimmed.startsWith('Aborting') && !trimmed.includes('untracked working tree') &&
                trimmed.length < 200 && !trimmed.includes(':')) {
              conflictingFiles.push(trimmed);
            }
          }

          if (conflictingFiles.length > 0) {
            // Back up conflicting files to .instar/git-sync-backup/
            const backupDir = path.join(this.projectDir, '.instar', 'git-sync-backup', new Date().toISOString().replace(/[:.]/g, '-'));
            fs.mkdirSync(backupDir, { recursive: true });

            for (const file of conflictingFiles) {
              const srcPath = path.join(this.projectDir, file);
              const destPath = path.join(backupDir, file);
              try {
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                fs.renameSync(srcPath, destPath);
                console.log(`[GitSync] Backed up: ${file} → ${path.relative(this.projectDir, destPath)}`);
              } catch { /* file may already be gone */ }
            }

            // Retry the pull
            const beforeHead = this.gitHead();
            this.gitExec(['pull', '--rebase', '--autostash']);
            const afterHead = this.gitHead();
            result.pulled = beforeHead !== afterHead;
            if (result.pulled) {
              const log = this.gitExec(['log', '--oneline', `${beforeHead}..${afterHead}`]);
              result.commitsPulled = log.trim().split('\n').filter(l => l.trim()).length;
            }
            console.log(`[GitSync] Auto-resolved untracked file conflict — ${conflictingFiles.length} file(s) backed up, pull succeeded`);
          } else {
            // Couldn't parse files — fall back to degradation report
            DegradationReporter.getInstance().report({
              feature: 'GitSync.pull',
              primary: 'Clean git pull',
              fallback: 'Manual resolution required',
              reason: `Why: Untracked local files would be overwritten by incoming commits. ${errMsg.slice(0, 200)}`,
              impact: 'Git pull blocked. To fix: either (1) commit the local files to your repo, or (2) add them to .gitignore and remove them from your working tree, then retry.',
            });
            return result;
          }
        } catch (retryErr) {
          // Auto-resolve failed — report degradation
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error(`[GitSync] Auto-resolve failed: ${retryMsg}`);
          DegradationReporter.getInstance().report({
            feature: 'GitSync.pull',
            primary: 'Clean git pull',
            fallback: 'Auto-resolve failed, manual resolution required',
            reason: `Why: Backed up conflicting files but pull still failed. ${retryMsg.slice(0, 200)}`,
            impact: 'Git pull blocked. Check .instar/git-sync-backup/ for backed-up files.',
          });
          return result;
        }
      } else if (errMsg.includes('rebase-merge') || errMsg.includes('rebase in progress') || errMsg.includes('rebase-apply')) {
        // Stuck rebase state from a previously interrupted pull — abort and retry with MERGE (not rebase)
        console.log('[GitSync] Stuck rebase detected — aborting and retrying pull (merge mode)');
        try {
          try {
            this.gitExec(['rebase', '--abort']);
          } catch (abortErr) {
            // rebase --abort can fail if .git/rebase-merge/head-name is missing (corrupted state)
            // Manually clean up the rebase state directories as a fallback
            console.warn(`[GitSync] rebase --abort failed, cleaning up rebase state manually: ${abortErr}`);
            const rebaseMerge = path.join(this.projectDir, '.git', 'rebase-merge');
            const rebaseApply = path.join(this.projectDir, '.git', 'rebase-apply');
            // safe-git-allow: incremental-migration
            if (fs.existsSync(rebaseMerge)) fs.rmSync(rebaseMerge, { recursive: true, force: true });
            // safe-git-allow: incremental-migration
            if (fs.existsSync(rebaseApply)) fs.rmSync(rebaseApply, { recursive: true, force: true });
          }
          const beforeHead = this.gitHead();
          // Use merge (not rebase) to avoid recreating the same stuck rebase
          this.gitExec(['pull', '--no-rebase', '--autostash']);
          const afterHead = this.gitHead();
          result.pulled = beforeHead !== afterHead;
          if (result.pulled) {
            const log = this.gitExec(['log', '--oneline', `${beforeHead}..${afterHead}`]);
            result.commitsPulled = log.trim().split('\n').filter(l => l.trim()).length;
          }
          console.log('[GitSync] Auto-resolved stuck rebase — pull succeeded (merge mode)');
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error(`[GitSync] Stuck rebase auto-resolve failed: ${retryMsg}`);
          DegradationReporter.getInstance().report({
            feature: 'GitSync.pull',
            primary: 'Clean git pull',
            fallback: 'Stuck rebase abort + retry failed',
            reason: `Why: Aborted stuck rebase but pull still failed. ${retryMsg.slice(0, 200)}`,
            impact: 'Git pull blocked. Manual intervention may be needed: cd to project and run git rebase --abort, then git pull.',
          });
          return result;
        }
      } else if (errMsg.includes('Cannot rebase onto multiple branches')) {
        // Ambiguous upstream tracking — fall back to explicit origin pull with merge
        console.log('[GitSync] Ambiguous tracking detected — falling back to explicit origin/main merge pull');
        try {
          const branch = this.gitExec(['symbolic-ref', '--short', 'HEAD']).trim() || 'main';
          const beforeHead = this.gitHead();
          this.gitExec(['pull', '--no-rebase', '--autostash', 'origin', branch]);
          const afterHead = this.gitHead();
          result.pulled = beforeHead !== afterHead;
          if (result.pulled) {
            const log = this.gitExec(['log', '--oneline', `${beforeHead}..${afterHead}`]);
            result.commitsPulled = log.trim().split('\n').filter(l => l.trim()).length;
          }
          console.log(`[GitSync] Explicit origin/${branch} merge pull succeeded`);
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error(`[GitSync] Explicit origin pull failed: ${retryMsg}`);
          DegradationReporter.getInstance().report({
            feature: 'GitSync.pull',
            primary: 'Clean git pull',
            fallback: 'Explicit origin pull with merge failed',
            reason: `Why: Cannot rebase onto multiple branches, and explicit merge pull also failed. ${retryMsg.slice(0, 200)}`,
            impact: 'Git pull blocked. Check git remote configuration: git remote -v',
          });
          return result;
        }
      }
      DegradationReporter.getInstance().report({
        feature: 'GitSync.pull',
        primary: 'Clean git pull',
        fallback: 'Attempt auto-resolution of conflicts',
        reason: `Why: ${errMsg}`,
        impact: 'Conflicts may not auto-resolve correctly',
      });
    }

    // 2. Verify pulled commits
    if (result.pulled) {
      result.rejectedCommits = this.verifyPulledCommits();
    }

    // 3. Push pending changes
    if (this.autoPush) {
      try {
        const status = this.gitExec(['status', '--porcelain']);
        if (status.trim()) {
          // There are changes to push
          result.pushed = this.commitAndPush('sync: auto-commit');
        }
      } catch {
        // Push failures are non-fatal for sync
      }
    }

    this.securityLog.append({
      event: 'git_sync',
      machineId: this.machineId,
      pulled: result.pulled,
      pushed: result.pushed,
      commitsPulled: result.commitsPulled,
      rejectedCommits: result.rejectedCommits.length,
    });

    return result;
  }

  /**
   * Stage files and commit with machine signing.
   */
  commitAndPush(message: string, paths?: string[]): boolean {
    const filesToAdd = paths || [this.stateDir];

    try {
      for (const p of filesToAdd) {
        this.gitExec(['add', p]);
      }

      // Check if there's anything staged
      const diff = this.gitExec(['diff', '--cached', '--name-only']);
      if (!diff.trim()) return false;

      this.gitExec(['commit', '-m', message]);

      if (this.autoPush) {
        this.gitExec(['push']);
      }

      return true;
    } catch {
      // @silent-fallback-ok — push failure boolean return
      return false;
    }
  }

  /**
   * Queue a file path for debounced auto-commit.
   * After debounceMs, all pending paths are committed in one batch.
   */
  queueAutoCommit(filePath: string): void {
    this.pendingPaths.add(filePath);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushAutoCommit();
    }, this.debounceMs);

    if (this.debounceTimer.unref) {
      this.debounceTimer.unref();
    }
  }

  /**
   * Immediately commit all pending paths.
   */
  flushAutoCommit(): void {
    if (this.pendingPaths.size === 0) return;

    const paths = [...this.pendingPaths];
    this.pendingPaths.clear();

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const categories = categorizePaths(paths, this.stateDir);
    const message = `sync(${this.machineId.slice(0, 8)}): ${categories.join(', ')}`;
    this.commitAndPush(message, paths);
  }

  /**
   * Stop debounce timer and flush pending commits.
   */
  stop(): void {
    this.flushAutoCommit();
  }

  // ── Commit Verification ─────────────────────────────────────────

  /**
   * Verify pulled commits: check signatures against the machine registry.
   * Returns commit hashes that should be rejected.
   */
  verifyPulledCommits(): string[] {
    // For now, return empty — full verification requires SSH allowed-signers file
    // which will be set up during pairing. The infrastructure is here for when
    // commit signing is enabled.
    return [];
  }

  /**
   * Install git hooks for commit verification.
   */
  installVerificationHooks(): void {
    const hooksDir = path.join(this.projectDir, '.git', 'hooks');
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    // Write allowed-signers file from machine registry
    this.updateAllowedSigners();
  }

  /**
   * Update the allowed-signers file from the machine registry.
   * This maps machine IDs to their SSH public keys for git verification.
   */
  updateAllowedSigners(): void {
    const registry = this.identityManager.loadRegistry();
    const allowedSignersPath = path.join(this.stateDir, 'machine', 'allowed-signers');
    const lines: string[] = [];

    for (const [machineId, entry] of Object.entries(registry.machines)) {
      if (entry.status !== 'active') continue;
      const identity = this.identityManager.loadRemoteIdentity(machineId);
      if (!identity) continue;

      // Format: email namespaces="git" key-type key-data
      // We use machineId as the email for identification
      lines.push(`${machineId} namespaces="git" ssh-ed25519 ${identity.signingPublicKey}`);
    }

    const dir = path.dirname(allowedSignersPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(allowedSignersPath, lines.join('\n') + '\n');

    // Configure git to use this file
    this.gitConfig('gpg.ssh.allowedSignersFile', allowedSignersPath);
  }

  // ── Conflict Resolution ─────────────────────────────────────────

  /**
   * Detect files in conflict state.
   */
  private detectConflicts(): string[] {
    try {
      const status = this.gitExec(['diff', '--name-only', '--diff-filter=U']);
      return status.trim().split('\n').filter(l => l.trim());
    } catch {
      // @silent-fallback-ok — conflict list returns empty
      return [];
    }
  }

  /**
   * Attempt auto-resolution for known file types, then escalate to LLM.
   *
   * Resolution flow:
   *   1. Try programmatic strategies (Tier 0) for each file
   *   2. For remaining conflicts, try LLM resolution (Tier 1 → 2)
   *   3. If LLM resolves: validate (build/test), rollback on failure
   *   4. Any still-unresolved files: report as Tier 3 (human escalation)
   */
  private async resolveConflicts(result: SyncResult): Promise<void> {
    // Step 1: Classify all conflicts and handle non-LLM strategies first
    const llmCandidates: string[] = [];

    for (const conflict of [...result.conflicts]) {
      const classification = this.fileClassifier.classify(conflict);

      switch (classification.strategy) {
        case 'never-sync':
        case 'exclude':
          // These shouldn't be in the repo — accept ours and move on
          try {
            this.gitExec(['checkout', '--ours', conflict]);
            this.gitExec(['add', conflict]);
            result.conflicts = result.conflicts.filter(c => c !== conflict);
          } catch {
            // Leave in conflict list for manual review
          }
          break;

        case 'regenerate':
          // Lockfile — regenerate from manifest
          {
            const regenResult = this.fileClassifier.regenerateLockfile(conflict, classification);
            if (regenResult.success) {
              result.conflicts = result.conflicts.filter(c => c !== conflict);
            } else {
              // Regen failed — escalate to Tier 3 (human)
              DegradationReporter.getInstance().report({
                feature: 'GitSync.lockfileRegeneration',
                primary: `Regenerate ${path.basename(conflict)} via ${classification.regenCommands?.join(' / ') ?? 'package manager'}`,
                fallback: 'Human must resolve lockfile conflict manually',
                reason: regenResult.error ?? 'Regeneration failed',
                impact: `Lockfile ${path.basename(conflict)} remains in conflict state`,
              });
            }
          }
          break;

        case 'ours-theirs':
          // Binary file — hash divergence detection
          {
            const binaryResult = this.fileClassifier.resolveBinary(conflict);
            if (binaryResult.resolution === 'ours' || binaryResult.resolution === 'theirs') {
              try {
                this.gitExec(['checkout', `--${binaryResult.resolution}`, conflict]);
                this.gitExec(['add', conflict]);
                result.conflicts = result.conflicts.filter(c => c !== conflict);
              } catch {
                // Leave in conflict list
              }
            }
            // 'conflict' means both sides changed — stays in conflict list for Tier 3
          }
          break;

        case 'programmatic':
          // Tier 0 — existing field-merge, newer-wins, union-by-id
          {
            const resolved = this.tryAutoResolve(conflict);
            if (resolved) {
              result.conflicts = result.conflicts.filter(c => c !== conflict);
            } else {
              // Programmatic failed — eligible for LLM
              llmCandidates.push(conflict);
            }
          }
          break;

        case 'llm':
          // Source code, docs — eligible for LLM resolution
          llmCandidates.push(conflict);
          break;
      }
    }

    // Step 2: Tier 1+2 — LLM resolution for remaining eligible conflicts
    if (llmCandidates.length > 0 && this.llmResolver) {
      // Replace result.conflicts temporarily with only LLM candidates
      const nonLlmConflicts = result.conflicts.filter(c => !llmCandidates.includes(c));
      result.conflicts = llmCandidates;
      await this.resolveLLMConflicts(result);
      // Merge back any non-LLM conflicts that weren't resolved above
      result.conflicts = [...result.conflicts, ...nonLlmConflicts];
    }

    if (result.conflicts.length === 0) {
      // All conflicts resolved — continue rebase
      try {
        this.gitExec(['rebase', '--continue']);
      } catch {
        // May need manual intervention
      }
    }
  }

  /**
   * Use LLM intelligence to resolve conflicts that programmatic strategies couldn't handle.
   */
  private async resolveLLMConflicts(result: SyncResult): Promise<void> {
    if (!this.llmResolver) return;

    // Create snapshot tag for rollback
    const snapshotTag = `sync-snapshot-${Date.now()}`;
    try {
      this.gitExec(['tag', snapshotTag]);
    } catch {
      // Tag creation failed — proceed without snapshot (degraded safety)
    }

    const llmResolved: string[] = [];
    const humanEscalations: ResolutionResult[] = [];

    for (const conflictPath of [...result.conflicts]) {
      try {
        const conflict = this.buildConflictFile(conflictPath);
        if (!conflict) continue;

        const context = this.buildEscalationContext(conflictPath);
        const resolution = await this.llmResolver.resolve(conflict, context);

        if (resolution.resolved && resolution.resolvedContent) {
          // Apply the resolution
          fs.writeFileSync(conflictPath, resolution.resolvedContent);
          this.gitExec(['add', conflictPath]);
          llmResolved.push(conflictPath);
          result.conflicts = result.conflicts.filter(c => c !== conflictPath);
        } else if (resolution.tier === 3) {
          humanEscalations.push(resolution);
        }
      } catch (err) {
        // Individual file resolution failure — continue with next file
        DegradationReporter.getInstance().report({
          feature: 'GitSync.resolveLLMConflicts',
          primary: 'LLM conflict resolution',
          fallback: 'Leave conflict for human review',
          reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
          impact: `File ${conflictPath} remains in conflict state`,
        });
      }
    }

    // Post-merge validation for LLM-resolved files
    if (llmResolved.length > 0) {
      const validationPassed = this.validatePostMerge();

      if (!validationPassed) {
        // Rollback to snapshot
        try {
          this.gitExec(['reset', '--hard', snapshotTag]);
          // All LLM resolutions are reverted — re-add to conflicts list
          for (const filePath of llmResolved) {
            if (!result.conflicts.includes(filePath)) {
              result.conflicts.push(filePath);
            }
          }
        } catch {
          // Rollback failed — critical state, report
          DegradationReporter.getInstance().report({
            feature: 'GitSync.rollbackSnapshot',
            primary: 'Rollback to pre-merge snapshot',
            fallback: 'Manual intervention required',
            reason: 'git reset --hard failed after validation failure',
            impact: 'Repository may be in inconsistent state',
          });
        }
      }
    }

    // Report human escalations
    for (const escalation of humanEscalations) {
      DegradationReporter.getInstance().report({
        feature: 'GitSync.LLMConflictResolution',
        primary: 'Auto-resolve via LLM (Tier 1 → Tier 2)',
        fallback: 'Human review required (Tier 3)',
        reason: escalation.reason ?? 'LLM could not resolve conflict',
        impact: `File ${escalation.filePath} needs manual resolution. ${escalation.humanSummary ?? ''}`,
      });
    }

    // Clean up old snapshot tags (keep last 5)
    this.cleanupSnapshotTags(5);
  }

  /**
   * Build a ConflictFile from a file path in conflict state.
   */
  private buildConflictFile(filePath: string): ConflictFile | null {
    try {
      const oursContent = this.gitExec(['show', ':2:' + filePath]);
      const theirsContent = this.gitExec(['show', ':3:' + filePath]);
      const conflictedContent = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(this.projectDir, filePath);

      return { filePath, relativePath, oursContent, theirsContent, conflictedContent };
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'GitSync.buildConflictFile',
        primary: 'Extract ours/theirs content for conflict resolution',
        fallback: 'Conflict file skipped — cannot read merge stages',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'This file will be excluded from LLM conflict resolution',
      });
      return null;
    }
  }

  /**
   * Build escalation context for Tier 2 (commit messages, related files).
   */
  private buildEscalationContext(filePath: string): EscalationContext {
    const context: EscalationContext = {};

    try {
      // Get recent commit messages touching this file from each side
      const oursLog = this.gitExec(['log', '--oneline', '-5', '--', filePath]);
      context.oursCommitMessages = oursLog.split('\n').filter(l => l.trim()).map(l => l.trim());
    } catch { /* no commit context available */ }

    try {
      // Get related files from the same commits
      const oursFiles = this.gitExec(['diff', '--name-only', 'HEAD~5..HEAD', '--', '.']);
      context.relatedFiles = {
        ours: oursFiles.split('\n').filter(l => l.trim() && l !== filePath).slice(0, 10),
        theirs: [], // Would need MERGE_HEAD context
      };
    } catch { /* no related files context */ }

    return context;
  }

  /**
   * Run post-merge validation (syntax check, build, tests).
   * Returns true if validation passes.
   */
  private validatePostMerge(): boolean {
    try {
      // Read validation config
      const configPath = path.join(this.stateDir, 'config.json');
      let validationConfig = { enabled: true, buildCommand: '', testCommand: '', timeout: 300000 };

      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          const pmv = config.sync?.postMergeValidation;
          if (pmv) {
            validationConfig = { ...validationConfig, ...pmv };
          }
        } catch { /* @silent-fallback-ok — malformed config file; built-in defaults are safe */ }
      }

      if (!validationConfig.enabled) return true;

      // Run build command if configured
      if (validationConfig.buildCommand) {
        try {
          execFileSync('sh', ['-c', validationConfig.buildCommand], {
            cwd: this.projectDir,
            timeout: validationConfig.timeout,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {
          // @silent-fallback-ok — build failure is an expected validation result; false signals merge should not proceed
          return false;
        }
      }

      // Run test command if configured
      if (validationConfig.testCommand) {
        try {
          execFileSync('sh', ['-c', validationConfig.testCommand], {
            cwd: this.projectDir,
            timeout: validationConfig.timeout,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {
          // @silent-fallback-ok — test failure is an expected validation result; false signals merge should not proceed
          return false;
        }
      }

      return true;
    } catch {
      // If we can't even read config, skip validation
      return true;
    }
  }

  /**
   * Clean up old sync snapshot tags, keeping the most recent N.
   */
  private cleanupSnapshotTags(keep: number): void {
    try {
      const tags = this.gitExec(['tag', '-l', 'sync-snapshot-*']);
      const tagList = tags.split('\n').filter(t => t.trim()).sort();
      if (tagList.length > keep) {
        for (const tag of tagList.slice(0, tagList.length - keep)) {
          try { this.gitExec(['tag', '-d', tag]); } catch { /* best effort */ }
        }
      }
    } catch { /* best effort */ }
  }

  /**
   * Try to auto-resolve a specific file conflict.
   */
  private tryAutoResolve(filePath: string): boolean {
    const relPath = path.relative(this.projectDir, filePath);

    // Relationship files: field-level merge
    if (relPath.includes('relationships/') && relPath.endsWith('.json')) {
      return this.resolveRelationshipConflict(filePath);
    }

    // Jobs file: newer timestamp wins
    if (relPath.endsWith('jobs.json')) {
      return this.resolveNewerWins(filePath);
    }

    // Evolution proposals: union by ID
    if (relPath.includes('evolution/') && relPath.endsWith('.json')) {
      return this.resolveUnionById(filePath);
    }

    return false;
  }

  /**
   * Resolve relationship file conflict using field-level merge.
   */
  private resolveRelationshipConflict(filePath: string): boolean {
    try {
      const oursContent = this.gitExec(['show', ':2:' + filePath]); // ours
      const theirsContent = this.gitExec(['show', ':3:' + filePath]); // theirs
      const ours = JSON.parse(oursContent) as RelationshipRecord;
      const theirs = JSON.parse(theirsContent) as RelationshipRecord;

      const merged = mergeRelationship(ours, theirs);
      fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
      this.gitExec(['add', filePath]);
      return true;
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'GitSync.resolveRelationshipConflict',
        primary: 'Auto-resolve relationship file conflicts',
        fallback: 'Leave conflict unresolved',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Relationship data may be inconsistent',
      });
      return false;
    }
  }

  /**
   * Resolve conflict by taking the newer version (by embedded timestamp).
   */
  private resolveNewerWins(filePath: string): boolean {
    try {
      const oursContent = this.gitExec(['show', ':2:' + filePath]);
      const theirsContent = this.gitExec(['show', ':3:' + filePath]);
      const ours = JSON.parse(oursContent);
      const theirs = JSON.parse(theirsContent);

      // Use lastModified or updatedAt if present
      const oursTime = ours.lastModified || ours.updatedAt || '';
      const theirsTime = theirs.lastModified || theirs.updatedAt || '';

      const winner = theirsTime > oursTime ? theirsContent : oursContent;
      fs.writeFileSync(filePath, winner);
      this.gitExec(['add', filePath]);
      return true;
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'GitSync.resolveNewerWins',
        primary: 'Auto-resolve via newer-wins strategy',
        fallback: 'Leave conflict unresolved',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'File may remain in conflict state',
      });
      return false;
    }
  }

  /**
   * Resolve conflict by taking the union of arrays by ID field.
   */
  private resolveUnionById(filePath: string): boolean {
    try {
      const oursContent = this.gitExec(['show', ':2:' + filePath]);
      const theirsContent = this.gitExec(['show', ':3:' + filePath]);
      const ours = JSON.parse(oursContent);
      const theirs = JSON.parse(theirsContent);

      if (Array.isArray(ours) && Array.isArray(theirs)) {
        const map = new Map<string, unknown>();
        for (const item of ours) {
          if (item.id) map.set(item.id, item);
        }
        for (const item of theirs) {
          if (item.id && !map.has(item.id)) map.set(item.id, item);
        }
        fs.writeFileSync(filePath, JSON.stringify([...map.values()], null, 2));
        this.gitExec(['add', filePath]);
        return true;
      }
      return false;
    } catch (err) {
      DegradationReporter.getInstance().report({
        feature: 'GitSync.resolveUnionById',
        primary: 'Auto-resolve via union-by-ID',
        fallback: 'Leave conflict unresolved',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Array-based files may remain in conflict state',
      });
      return false;
    }
  }

  // ── Git Helpers ─────────────────────────────────────────────────

  private gitExec(args: string[]): string {
    // safe-git-allow: incremental-migration
    return execFileSync('git', args, {
      cwd: this.projectDir,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  private gitConfig(key: string, value: string): void {
    this.gitExec(['config', '--local', key, value]);
  }

  private gitConfigGet(key: string): string {
    return this.gitExec(['config', '--get', key]);
  }

  private gitHead(): string {
    try {
      return this.gitExec(['rev-parse', 'HEAD']);
    } catch {
      // @silent-fallback-ok — HEAD lookup may fail in empty repos; 'unknown' is safe fallback
      return 'unknown';
    }
  }
}

// ── Relationship Merge ───────────────────────────────────────────────

/**
 * Merge two relationship records using field-level resolution.
 * From the spec: channels union, themes union, timestamps min/max,
 * text fields from whichever has newer lastInteraction.
 */
export function mergeRelationship(
  ours: RelationshipRecord,
  theirs: RelationshipRecord,
): RelationshipRecord {
  const oursNewer = ours.lastInteraction >= theirs.lastInteraction;
  const primary = oursNewer ? ours : theirs;
  const secondary = oursNewer ? theirs : ours;

  // Union channels by type:identifier
  const channelMap = new Map<string, { type: string; identifier: string }>();
  for (const ch of [...(ours.channels || []), ...(theirs.channels || [])]) {
    channelMap.set(`${ch.type}:${ch.identifier}`, ch);
  }

  // Union themes
  const themes = [...new Set([...(ours.themes || []), ...(theirs.themes || [])])];

  // Merge recent interactions, deduplicate by timestamp, keep last 20
  const allInteractions = [
    ...(ours.recentInteractions || []),
    ...(theirs.recentInteractions || []),
  ];
  const seen = new Set<string>();
  const deduped = allInteractions.filter(i => {
    const key = i.timestamp;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  deduped.sort((a, b) => a.timestamp < b.timestamp ? 1 : -1);
  const recentInteractions = deduped.slice(0, 20);

  return {
    ...primary,
    id: ours.id, // Always keep original ID
    channels: [...channelMap.values()],
    firstInteraction: ours.firstInteraction < theirs.firstInteraction
      ? ours.firstInteraction : theirs.firstInteraction,
    lastInteraction: primary.lastInteraction,
    interactionCount: Math.max(ours.interactionCount || 0, theirs.interactionCount || 0),
    themes,
    notes: primary.notes,
    significance: Math.max(ours.significance || 0, theirs.significance || 0),
    arcSummary: primary.arcSummary,
    recentInteractions,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Categorize file paths into human-readable labels for commit messages.
 */
function categorizePaths(paths: string[], stateDir: string): string[] {
  const categories = new Set<string>();
  for (const p of paths) {
    const rel = path.relative(stateDir, p);
    if (rel.startsWith('relationships')) categories.add('relationships');
    else if (rel.startsWith('evolution')) categories.add('evolution');
    else if (rel.includes('jobs.json')) categories.add('jobs');
    else if (rel.includes('config.json')) categories.add('config');
    else if (rel.startsWith('machines')) categories.add('machines');
    else categories.add('state');
  }
  return [...categories];
}
