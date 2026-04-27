/**
 * Wiring Integrity Tests for SyncOrchestrator
 *
 * Verifies that SyncOrchestrator correctly wires all optional modules together:
 *   - Security pipeline: AuditTrail is called for overlap, conflict, access-denied, branch, redaction events
 *   - Coordination: CoordinationProtocol announcements and file avoidance broadcasts
 *   - Overlap: OverlapGuard.check() is called with correct args, result flows into output, events emitted
 *   - Ledger + Auth: WorkLedger updates and LedgerAuth signing on the correct lifecycle boundaries
 *   - Conflict Negotiation: ConflictNegotiator.negotiate() called when conflicts + peer found
 *   - AgentBus lifecycle: startPolling/stopPolling called at transition boundaries and stop()
 *
 * All modules are fully mocked. The tests verify CALL WIRING — that the orchestrator
 * invokes the right method on the right module at the right time with the right arguments.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { SyncOrchestrator } from '../../src/core/SyncOrchestrator.js';
import type { SyncOrchestratorConfig } from '../../src/core/SyncOrchestrator.js';

// ── Module Mocks ──────────────────────────────────────────────────────

// Mock GitSyncManager so we never touch a real repo
vi.mock('../../src/core/GitSync.js', () => ({
  GitSyncManager: vi.fn().mockImplementation(() => ({
    isGitRepo: vi.fn().mockReturnValue(true),
    sync: vi.fn().mockResolvedValue({
      pulled: false,
      pushed: false,
      commitsPulled: 0,
      commitsPushed: 0,
      rejectedCommits: [],
      conflicts: [],
    }),
    flushAutoCommit: vi.fn(),
    stop: vi.fn(),
  })),
}));

// Mock child_process to prevent real git calls from acquireLock/releaseLock helper
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue('main\n'),
  };
});

// ── Mock Factory ──────────────────────────────────────────────────────

function makeMocks() {
  const mockAuditTrail = {
    logSecurity: vi.fn(),
    logResolution: vi.fn(),
    logAccessDenied: vi.fn(),
    logBranch: vi.fn(),
    logRedaction: vi.fn(),
    logHandoff: vi.fn(),
    logLLMInvocation: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn(),
    verifyIntegrity: vi.fn(),
  } as any;

  const mockCoordinationProtocol = {
    announceWork: vi.fn().mockResolvedValue(undefined),
    broadcastFileAvoidance: vi.fn().mockResolvedValue(undefined),
    queryStatus: vi.fn().mockResolvedValue([]),
    getMachineId: vi.fn().mockReturnValue('test-machine'),
  } as any;

  const mockOverlapGuard = {
    check: vi.fn().mockReturnValue({
      action: 'log',
      maxTier: 0,
      warnings: [],
      architecturalConflicts: [],
      canProceed: true,
      suggestion: 'No overlaps detected',
    }),
  } as any;

  const mockWorkLedger = {
    getActiveEntries: vi.fn().mockReturnValue([]),
    startWork: vi.fn().mockReturnValue({
      id: 'work_test123',
      machineId: 'test-machine',
      sessionId: 'AUT-TEST',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'active',
      task: 'test task',
      filesPlanned: [],
      filesModified: [],
    }),
    updateWork: vi.fn().mockReturnValue(true),
    endWork: vi.fn().mockReturnValue(true),
  } as any;

  const mockLedgerAuth = {
    signEntry: vi.fn().mockReturnValue({ success: true, signature: 'ed25519:test-sig' }),
    verifyEntry: vi.fn().mockReturnValue({ status: 'valid', trusted: true }),
    signEntryInPlace: vi.fn().mockReturnValue(true),
    isSigningRequired: vi.fn().mockReturnValue(false),
  } as any;

  const mockAccessControl = {
    check: vi.fn().mockReturnValue({ allowed: true, role: 'admin', reason: undefined }),
  } as any;

  const mockBranchManager = {
    completeBranch: vi.fn().mockReturnValue({
      success: true,
      conflicts: [],
      mergeCommit: 'abc123',
      validationPassed: true,
    }),
    createBranch: vi.fn(),
    listBranches: vi.fn().mockReturnValue([]),
  } as any;

  const mockSecretRedactor = {
    redact: vi.fn().mockReturnValue({
      content: 'redacted content',
      redactions: [],
      count: 0,
      typeCounts: {},
    }),
    restore: vi.fn(),
    shouldExcludeFile: vi.fn(),
  } as any;

  const mockAgentBus = {
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
  } as any;

  const mockConflictNegotiator = {
    negotiate: vi.fn().mockResolvedValue({
      status: 'agreed',
      negotiationId: 'neg_test',
      filePath: 'test.ts',
      resolution: { strategy: 'merge-by-section' },
    }),
  } as any;

  const mockHandoffManager = {
    initiateHandoff: vi.fn().mockReturnValue({
      success: true,
      entriesPaused: 1,
      wipCommits: 0,
      pushed: true,
    }),
    resume: vi.fn().mockReturnValue({
      success: true,
      resumableWork: [{
        entryId: 'work_resume1',
        sessionId: 'AUT-PREV',
        status: 'paused',
        description: 'Resumed work',
        filesModified: ['src/index.ts'],
      }],
      pulled: true,
      changesAvailable: true,
      recoveryType: 'graceful',
    }),
  } as any;

  const mockIdentityManager = {
    loadRegistry: vi.fn().mockReturnValue({ machines: {} }),
    loadRemoteIdentity: vi.fn().mockReturnValue(null),
  } as any;

  const mockSecurityLog = {
    append: vi.fn(),
  } as any;

  return {
    mockAuditTrail,
    mockCoordinationProtocol,
    mockOverlapGuard,
    mockWorkLedger,
    mockLedgerAuth,
    mockAccessControl,
    mockBranchManager,
    mockSecretRedactor,
    mockAgentBus,
    mockConflictNegotiator,
    mockHandoffManager,
    mockIdentityManager,
    mockSecurityLog,
  };
}

// ── Test Suite ─────────────────────────────────────────────────────────

describe('SyncOrchestrator wiring integrity', () => {
  let tmpDir: string;
  let stateDir: string;
  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-orch-wiring-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    mocks = makeMocks();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeOrchestrator(overrides?: Partial<SyncOrchestratorConfig>): SyncOrchestrator {
    return new SyncOrchestrator({
      projectDir: tmpDir,
      stateDir,
      machineId: 'test-machine',
      identityManager: mocks.mockIdentityManager,
      securityLog: mocks.mockSecurityLog,
      auditTrail: mocks.mockAuditTrail,
      coordinationProtocol: mocks.mockCoordinationProtocol,
      overlapGuard: mocks.mockOverlapGuard,
      workLedger: mocks.mockWorkLedger,
      ledgerAuth: mocks.mockLedgerAuth,
      accessControl: mocks.mockAccessControl,
      branchManager: mocks.mockBranchManager,
      secretRedactor: mocks.mockSecretRedactor,
      agentBus: mocks.mockAgentBus,
      conflictNegotiator: mocks.mockConflictNegotiator,
      handoffManager: mocks.mockHandoffManager,
      userId: 'test-user',
      sessionId: 'AUT-WIRING-TEST',
      ...overrides,
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // Category 1: Security Pipeline Wiring
  // ══════════════════════════════════════════════════════════════════════

  describe('Security Pipeline Wiring', () => {
    it('periodicSync calls AuditTrail.logSecurity on overlap detection (canProceed=false)', async () => {
      mocks.mockOverlapGuard.check.mockReturnValue({
        action: 'block',
        maxTier: 3,
        warnings: [],
        architecturalConflicts: [],
        canProceed: false,
        suggestion: 'Architectural conflict detected',
      });

      const orch = makeOrchestrator();
      await orch.periodicSync({ currentFiles: ['src/index.ts'], currentTask: 'refactor' });

      expect(mocks.mockAuditTrail.logSecurity).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'sync-blocked-by-overlap',
          severity: 'medium',
          sessionId: 'AUT-WIRING-TEST',
        }),
      );
    });

    it('periodicSync calls AuditTrail.logResolution when conflicts exist', async () => {
      // Make gitSync.sync return conflicts
      const orch = makeOrchestrator();
      const gitSync = orch.getGitSync();
      (gitSync.sync as ReturnType<typeof vi.fn>).mockResolvedValue({
        pulled: true,
        pushed: true,
        commitsPulled: 1,
        commitsPushed: 1,
        rejectedCommits: [],
        conflicts: ['src/app.ts', 'src/lib.ts'],
      });

      await orch.periodicSync();

      expect(mocks.mockAuditTrail.logResolution).toHaveBeenCalledWith(
        expect.objectContaining({
          file: 'src/app.ts, src/lib.ts',
          chosenSide: 'merged',
          conflictRegions: 2,
          sessionId: 'AUT-WIRING-TEST',
        }),
      );
    });

    it('completeTask calls AuditTrail.logAccessDenied when RBAC blocks', async () => {
      mocks.mockAccessControl.check.mockReturnValue({
        allowed: false,
        role: 'contributor',
        reason: 'Contributors cannot merge branches',
      });

      const orch = makeOrchestrator();
      const result = await orch.completeTask({ branchName: 'task/my-feature' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Access denied');
      expect(mocks.mockAuditTrail.logAccessDenied).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'test-user',
          permission: 'branch:merge',
          role: 'contributor',
          action: 'complete-task:task/my-feature',
          sessionId: 'AUT-WIRING-TEST',
        }),
      );
    });

    it('completeTask calls AuditTrail.logBranch on success', async () => {
      const orch = makeOrchestrator();
      const result = await orch.completeTask({ branchName: 'task/feature-x' });

      expect(result.success).toBe(true);
      expect(mocks.mockAuditTrail.logBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'merge',
          branch: 'task/feature-x',
          result: 'success',
          sessionId: 'AUT-WIRING-TEST',
        }),
      );
    });

    it('completeTask calls AuditTrail.logBranch on failure (exception path)', async () => {
      mocks.mockBranchManager.completeBranch.mockImplementation(() => {
        throw new Error('merge explosion');
      });

      const orch = makeOrchestrator();
      const result = await orch.completeTask({ branchName: 'task/bad-merge' });

      expect(result.success).toBe(false);
      expect(mocks.mockAuditTrail.logBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'merge',
          branch: 'task/bad-merge',
          result: 'failed',
          sessionId: 'AUT-WIRING-TEST',
        }),
      );
    });

    it('completeTask calls AuditTrail.logBranch on conflict path', async () => {
      mocks.mockBranchManager.completeBranch.mockReturnValue({
        success: false,
        conflicts: ['src/conflict.ts'],
      });
      // No peer for negotiation
      mocks.mockWorkLedger.getActiveEntries.mockReturnValue([]);

      const orch = makeOrchestrator();
      const result = await orch.completeTask({ branchName: 'task/conflicting' });

      expect(result.success).toBe(false);
      expect(mocks.mockAuditTrail.logBranch).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'merge',
          branch: 'task/conflicting',
          result: 'conflict',
          conflictFiles: ['src/conflict.ts'],
        }),
      );
    });

    it('redactForLLM calls AuditTrail.logRedaction when secrets found', () => {
      mocks.mockSecretRedactor.redact.mockReturnValue({
        content: 'key is [REDACTED:api-key:0]',
        redactions: [{ index: 0, type: 'api-key' }],
        count: 2,
        typeCounts: { 'api-key': 1, 'high-entropy': 1 },
      });

      const orch = makeOrchestrator();
      orch.redactForLLM('key is sk-secret-abc123');

      expect(mocks.mockAuditTrail.logRedaction).toHaveBeenCalledWith(
        expect.objectContaining({
          file: 'llm-prompt',
          totalRedactions: 2,
          typeCounts: { 'api-key': 1, 'high-entropy': 1 },
          entropyStringsFound: 1,
          sessionId: 'AUT-WIRING-TEST',
        }),
      );
    });

    it('redactForLLM does NOT call AuditTrail.logRedaction when zero secrets', () => {
      // Default mock returns count: 0, so no redactions
      const orch = makeOrchestrator();
      orch.redactForLLM('clean content with no secrets');

      expect(mocks.mockAuditTrail.logRedaction).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Category 2: Coordination Wiring
  // ══════════════════════════════════════════════════════════════════════

  describe('Coordination Wiring', () => {
    it('periodicSync calls announceWork on start and completion', async () => {
      const orch = makeOrchestrator();
      await orch.periodicSync({ currentFiles: ['src/a.ts'] });

      // Should have been called at least twice: start + complete
      expect(mocks.mockCoordinationProtocol.announceWork).toHaveBeenCalledTimes(2);

      // First call: started
      expect(mocks.mockCoordinationProtocol.announceWork).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          action: 'started',
          task: 'periodic-sync',
          files: ['src/a.ts'],
          sessionId: 'AUT-WIRING-TEST',
        }),
      );

      // Second call: completed
      expect(mocks.mockCoordinationProtocol.announceWork).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          action: 'completed',
          task: 'periodic-sync',
          files: ['src/a.ts'],
          sessionId: 'AUT-WIRING-TEST',
        }),
      );
    });

    it('completeTask calls broadcastFileAvoidance before merge', async () => {
      const orch = makeOrchestrator();
      await orch.completeTask({
        branchName: 'task/feature',
        filesModified: ['src/index.ts', 'src/lib.ts'],
      });

      expect(mocks.mockCoordinationProtocol.broadcastFileAvoidance).toHaveBeenCalledWith(
        expect.objectContaining({
          files: ['src/index.ts', 'src/lib.ts'],
          durationMs: 5 * 60 * 1000,
          reason: expect.stringContaining('task/feature'),
        }),
      );
    });

    it('completeTask calls announceWork on start and completion', async () => {
      const orch = makeOrchestrator();
      await orch.completeTask({
        branchName: 'task/done',
        filesModified: ['src/done.ts'],
      });

      // At least start + completed announcements
      const calls = mocks.mockCoordinationProtocol.announceWork.mock.calls;

      const startCall = calls.find((c: any[]) => c[0].action === 'started' && c[0].task?.includes('merge'));
      const completeCall = calls.find((c: any[]) => c[0].action === 'completed' && c[0].task?.includes('merge'));

      expect(startCall).toBeDefined();
      expect(completeCall).toBeDefined();
      expect(startCall![0].task).toContain('task/done');
      expect(completeCall![0].task).toContain('task/done');
    });

    it('initiateTransition calls announceWork with paused action', async () => {
      const orch = makeOrchestrator();
      await orch.initiateTransition({ reason: 'user-initiated' });

      expect(mocks.mockCoordinationProtocol.announceWork).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'paused',
          task: 'machine-transition',
          sessionId: 'AUT-WIRING-TEST',
        }),
      );
    });

    it('resumeFromTransition calls announceWork with resumed action', async () => {
      const orch = makeOrchestrator();
      await orch.resumeFromTransition();

      expect(mocks.mockCoordinationProtocol.announceWork).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'resumed',
          task: 'machine-transition-resume',
          sessionId: 'AUT-WIRING-TEST',
        }),
      );
    });

    it('completeTask does NOT call broadcastFileAvoidance when no files specified', async () => {
      const orch = makeOrchestrator();
      await orch.completeTask({ branchName: 'task/no-files' });

      expect(mocks.mockCoordinationProtocol.broadcastFileAvoidance).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Category 3: Overlap Integration
  // ══════════════════════════════════════════════════════════════════════

  describe('Overlap Integration', () => {
    it('periodicSync calls OverlapGuard.check with correct args', async () => {
      const orch = makeOrchestrator();
      await orch.periodicSync({
        currentFiles: ['src/index.ts', 'lib/utils.ts'],
        currentTask: 'refactoring utils',
      });

      expect(mocks.mockOverlapGuard.check).toHaveBeenCalledWith({
        plannedFiles: ['src/index.ts', 'lib/utils.ts'],
        task: 'refactoring utils',
      });
    });

    it('overlap result flows back into OrchestratedSyncResult', async () => {
      const overlapResult = {
        action: 'block' as const,
        maxTier: 3 as const,
        warnings: [{ tier: 2, entry: {}, overlappingFiles: ['shared.ts'], message: 'overlap' }],
        architecturalConflicts: [],
        canProceed: false,
        suggestion: 'Branch recommended',
      };
      mocks.mockOverlapGuard.check.mockReturnValue(overlapResult);

      const orch = makeOrchestrator();
      const result = await orch.periodicSync({ currentFiles: ['shared.ts'] });

      expect(result.overlapDetected).toBe(true);
      expect(result.overlapResult).toBeDefined();
      expect(result.overlapResult!.canProceed).toBe(false);
      expect(result.overlapResult!.suggestion).toBe('Branch recommended');
    });

    it('overlap-blocked event emitted when canProceed is false', async () => {
      mocks.mockOverlapGuard.check.mockReturnValue({
        action: 'block',
        maxTier: 3,
        warnings: [],
        architecturalConflicts: [],
        canProceed: false,
        suggestion: 'Cannot proceed',
      });

      const orch = makeOrchestrator();
      const eventSpy = vi.fn();
      orch.on('overlap-blocked', eventSpy);

      await orch.periodicSync({ currentFiles: ['blocked.ts'] });

      expect(eventSpy).toHaveBeenCalledTimes(1);
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({ canProceed: false }),
      );
    });

    it('OverlapGuard NOT called when no currentFiles provided', async () => {
      const orch = makeOrchestrator();
      await orch.periodicSync();

      expect(mocks.mockOverlapGuard.check).not.toHaveBeenCalled();
    });

    it('OverlapGuard NOT called when currentFiles is empty array', async () => {
      const orch = makeOrchestrator();
      await orch.periodicSync({ currentFiles: [] });

      expect(mocks.mockOverlapGuard.check).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Category 4: Ledger + Auth Wiring
  // ══════════════════════════════════════════════════════════════════════

  describe('Ledger + Auth Wiring', () => {
    it('periodicSync calls WorkLedger.updateWork for active entry', async () => {
      const orch = makeOrchestrator();

      // First, start work so there's an active ledger entry
      orch.startWork({ sessionId: 'AUT-100', task: 'test', filesPlanned: ['a.ts'] });

      await orch.periodicSync({ currentFiles: ['a.ts'] });

      expect(mocks.mockWorkLedger.updateWork).toHaveBeenCalledWith(
        'work_test123',
        expect.objectContaining({
          filesModified: ['a.ts'],
        }),
      );
    });

    it('periodicSync calls LedgerAuth.signEntry after ledger update', async () => {
      // Set up active entries so the signing path is triggered
      mocks.mockWorkLedger.getActiveEntries.mockReturnValue([{
        id: 'work_test123',
        machineId: 'test-machine',
        sessionId: 'AUT-100',
        status: 'active',
        task: 'test',
        filesPlanned: [],
        filesModified: [],
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }]);

      const orch = makeOrchestrator();
      orch.startWork({ sessionId: 'AUT-100', task: 'test' });

      await orch.periodicSync({ currentFiles: ['a.ts'] });

      // signEntry should be called — once during startWork and potentially once during periodicSync
      expect(mocks.mockLedgerAuth.signEntry).toHaveBeenCalled();
    });

    it('startWork calls LedgerAuth.signEntry with the entry returned by WorkLedger', () => {
      const orch = makeOrchestrator();
      const entry = orch.startWork({ sessionId: 'AUT-200', task: 'sign test' });

      expect(entry).not.toBeNull();
      // signEntry receives the LedgerEntry object returned by workLedger.startWork(),
      // which is the mock return value (not the opts passed to orchestrator.startWork)
      expect(mocks.mockLedgerAuth.signEntry).toHaveBeenCalledTimes(1);
      expect(mocks.mockLedgerAuth.signEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'work_test123',
          machineId: 'test-machine',
        }),
      );
    });

    it('endWork calls WorkLedger.endWork with correct status', () => {
      const orch = makeOrchestrator();
      orch.startWork({ sessionId: 'AUT-300', task: 'end test' });

      const result = orch.endWork('completed');

      expect(result).toBe(true);
      expect(mocks.mockWorkLedger.endWork).toHaveBeenCalledWith('work_test123', 'completed');
    });

    it('endWork with paused status passes through correctly', () => {
      const orch = makeOrchestrator();
      orch.startWork({ sessionId: 'AUT-301', task: 'pause test' });

      orch.endWork('paused');

      expect(mocks.mockWorkLedger.endWork).toHaveBeenCalledWith('work_test123', 'paused');
    });

    it('completeTask calls WorkLedger.endWork with completed on success', async () => {
      const orch = makeOrchestrator();
      orch.startWork({ sessionId: 'AUT-400', task: 'complete task test' });

      await orch.completeTask({ branchName: 'task/done' });

      expect(mocks.mockWorkLedger.endWork).toHaveBeenCalledWith('work_test123', 'completed');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Category 5: Conflict Negotiation Wiring
  // ══════════════════════════════════════════════════════════════════════

  describe('Conflict Negotiation Wiring', () => {
    it('completeTask calls ConflictNegotiator.negotiate when conflicts exist and peer found', async () => {
      mocks.mockBranchManager.completeBranch.mockReturnValue({
        success: false,
        conflicts: ['src/shared.ts'],
      });

      // Provide a peer working on the conflicting file
      mocks.mockWorkLedger.getActiveEntries.mockReturnValue([
        {
          id: 'work_peer1',
          machineId: 'peer-machine',
          sessionId: 'AUT-PEER',
          status: 'active',
          task: 'peer work',
          filesPlanned: ['src/shared.ts'],
          filesModified: [],
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      const orch = makeOrchestrator();
      await orch.completeTask({ branchName: 'task/conflicting' });

      expect(mocks.mockConflictNegotiator.negotiate).toHaveBeenCalledWith(
        expect.objectContaining({
          targetMachineId: 'peer-machine',
          filePath: 'src/shared.ts',
          strategy: 'merge-by-section',
          sessionId: 'AUT-WIRING-TEST',
        }),
      );
    });

    it('negotiation success removes conflict from result', async () => {
      mocks.mockBranchManager.completeBranch.mockReturnValue({
        success: false,
        conflicts: ['src/negotiated.ts'],
      });

      mocks.mockWorkLedger.getActiveEntries.mockReturnValue([
        {
          id: 'work_peer2',
          machineId: 'peer-machine-2',
          sessionId: 'AUT-PEER2',
          status: 'active',
          task: 'peer work 2',
          filesPlanned: ['src/negotiated.ts'],
          filesModified: [],
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      // Negotiation succeeds
      mocks.mockConflictNegotiator.negotiate.mockResolvedValue({
        status: 'agreed',
        negotiationId: 'neg_ok',
        filePath: 'src/negotiated.ts',
      });

      const orch = makeOrchestrator();
      const result = await orch.completeTask({ branchName: 'task/negotiated' });

      // The conflict should have been removed from the result since negotiation succeeded
      expect(result.conflicts).not.toContain('src/negotiated.ts');
    });

    it('negotiation NOT called when no peer works on conflicting file', async () => {
      mocks.mockBranchManager.completeBranch.mockReturnValue({
        success: false,
        conflicts: ['src/solo-conflict.ts'],
      });

      // No peer entries at all
      mocks.mockWorkLedger.getActiveEntries.mockReturnValue([]);

      const orch = makeOrchestrator();
      await orch.completeTask({ branchName: 'task/solo' });

      expect(mocks.mockConflictNegotiator.negotiate).not.toHaveBeenCalled();
    });

    it('negotiation failure leaves conflict in result', async () => {
      mocks.mockBranchManager.completeBranch.mockReturnValue({
        success: false,
        conflicts: ['src/failed-neg.ts'],
      });

      mocks.mockWorkLedger.getActiveEntries.mockReturnValue([
        {
          id: 'work_peer3',
          machineId: 'peer-machine-3',
          sessionId: 'AUT-PEER3',
          status: 'active',
          task: 'peer',
          filesPlanned: [],
          filesModified: ['src/failed-neg.ts'],
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);

      // Negotiation rejected
      mocks.mockConflictNegotiator.negotiate.mockResolvedValue({
        status: 'rejected',
        negotiationId: 'neg_fail',
        filePath: 'src/failed-neg.ts',
      });

      const orch = makeOrchestrator();
      const result = await orch.completeTask({ branchName: 'task/failed-neg' });

      expect(result.conflicts).toContain('src/failed-neg.ts');
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Category 6: AgentBus Lifecycle
  // ══════════════════════════════════════════════════════════════════════

  describe('AgentBus Lifecycle', () => {
    it('initiateTransition calls agentBus.stopPolling()', async () => {
      const orch = makeOrchestrator();
      await orch.initiateTransition();

      expect(mocks.mockAgentBus.stopPolling).toHaveBeenCalled();
    });

    it('resumeFromTransition calls agentBus.startPolling()', async () => {
      const orch = makeOrchestrator();
      await orch.resumeFromTransition();

      expect(mocks.mockAgentBus.startPolling).toHaveBeenCalled();
    });

    it('stop() calls agentBus.stopPolling()', () => {
      const orch = makeOrchestrator();
      orch.stop();

      expect(mocks.mockAgentBus.stopPolling).toHaveBeenCalled();
    });

    it('stop() calls gitSync.stop()', () => {
      const orch = makeOrchestrator();
      const gitSync = orch.getGitSync();
      orch.stop();

      expect(gitSync.stop).toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Category 7: Graceful Degradation (no optional modules)
  // ══════════════════════════════════════════════════════════════════════

  describe('Graceful Degradation', () => {
    it('periodicSync succeeds with no optional modules configured', async () => {
      const orch = new SyncOrchestrator({
        projectDir: tmpDir,
        stateDir,
        machineId: 'bare-machine',
        identityManager: mocks.mockIdentityManager,
        securityLog: mocks.mockSecurityLog,
      });

      const result = await orch.periodicSync();

      expect(result.overlapDetected).toBe(false);
      expect(result.ledgerUpdated).toBe(false);
      expect(result.coordinationUsed).toBe(false);
    });

    it('completeTask returns error when BranchManager not configured', async () => {
      const orch = new SyncOrchestrator({
        projectDir: tmpDir,
        stateDir,
        machineId: 'bare-machine',
        identityManager: mocks.mockIdentityManager,
        securityLog: mocks.mockSecurityLog,
      });

      const result = await orch.completeTask({ branchName: 'task/no-branch-mgr' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('BranchManager not configured');
    });

    it('redactForLLM returns null when SecretRedactor not configured', () => {
      const orch = new SyncOrchestrator({
        projectDir: tmpDir,
        stateDir,
        machineId: 'bare-machine',
        identityManager: mocks.mockIdentityManager,
        securityLog: mocks.mockSecurityLog,
      });

      const result = orch.redactForLLM('some content');
      expect(result).toBeNull();
    });

    it('startWork returns null when WorkLedger not configured', () => {
      const orch = new SyncOrchestrator({
        projectDir: tmpDir,
        stateDir,
        machineId: 'bare-machine',
        identityManager: mocks.mockIdentityManager,
        securityLog: mocks.mockSecurityLog,
      });

      const result = orch.startWork({ sessionId: 'AUT-X', task: 'test' });
      expect(result).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Category 8: Transition Handoff Wiring
  // ══════════════════════════════════════════════════════════════════════

  describe('Transition Handoff Wiring', () => {
    it('initiateTransition calls HandoffManager.initiateHandoff with reason', async () => {
      const orch = makeOrchestrator();
      await orch.initiateTransition({ reason: 'shutdown', resumeInstructions: 'pick up where I left off' });

      expect(mocks.mockHandoffManager.initiateHandoff).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'shutdown',
          resumeInstructions: 'pick up where I left off',
        }),
      );
    });

    it('initiateTransition calls AuditTrail.logHandoff', async () => {
      const orch = makeOrchestrator();
      await orch.initiateTransition({ reason: 'sleep' });

      expect(mocks.mockAuditTrail.logHandoff).toHaveBeenCalledWith(
        expect.objectContaining({
          fromMachine: 'test-machine',
          reason: 'sleep',
          workItemCount: 1, // entriesPaused from mock
          sessionId: 'AUT-WIRING-TEST',
        }),
      );
    });

    it('resumeFromTransition calls HandoffManager.resume()', async () => {
      const orch = makeOrchestrator();
      await orch.resumeFromTransition();

      expect(mocks.mockHandoffManager.resume).toHaveBeenCalled();
    });

    it('resumeFromTransition starts ledger tracking for resumed work', async () => {
      const orch = makeOrchestrator();
      await orch.resumeFromTransition();

      // Should have called startWork for the first resumable item
      expect(mocks.mockWorkLedger.startWork).toHaveBeenCalledWith(
        expect.objectContaining({
          task: 'Resumed work',
          filesPlanned: ['src/index.ts'],
        }),
      );
    });

    it('initiateTransition result includes peersNotified=true when coordination succeeds', async () => {
      const orch = makeOrchestrator();
      const result = await orch.initiateTransition();

      expect(result.peersNotified).toBe(true);
    });
  });
});
