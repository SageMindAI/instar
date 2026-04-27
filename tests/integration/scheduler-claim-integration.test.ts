/**
 * Integration tests for JobScheduler + JobClaimManager (Phase 4C — Gap 5).
 *
 * Tests the end-to-end flow of distributed job deduplication:
 *   1. Scheduler skips jobs claimed by remote machines
 *   2. Scheduler broadcasts claims before spawning
 *   3. Scheduler signals completion after job finishes
 *   4. SkipLedger records 'claimed' reason
 *   5. Claim manager lifecycle with scheduler start/stop
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { JobClaimManager } from '../../src/scheduler/JobClaimManager.js';
import { AgentBus } from '../../src/core/AgentBus.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { AgentMessage } from '../../src/core/AgentBus.js';
import type { JobClaimPayload } from '../../src/scheduler/JobClaimManager.js';
import type { SessionManager } from '../../src/core/SessionManager.js';
import type { JobSchedulerConfig } from '../../src/core/types.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-sched-claim-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

function createJobsFile(dir: string, jobs: any[]): string {
  const jobsFile = path.join(dir, 'jobs.json');
  fs.writeFileSync(jobsFile, JSON.stringify(jobs, null, 2));
  return jobsFile;
}

function mockSessionManager(): SessionManager {
  return {
    listRunningSessions: vi.fn().mockReturnValue([]),
    spawnSession: vi.fn().mockResolvedValue(undefined),
    captureOutput: vi.fn().mockReturnValue(''),
    getSessionDiagnostics: vi.fn().mockReturnValue({
      maxSessions: 3,
      sessions: [],
      memoryPressure: 'normal',
      memoryUsedPercent: 50,
      freeMemoryMB: 8000,
      suggestions: [],
    }),
  } as unknown as SessionManager;
}

function createSchedulerConfig(jobsFile: string): JobSchedulerConfig {
  return {
    jobsFile,
    enabled: true,
    maxParallelJobs: 3,
    quotaThresholds: {
      normal: 50,
      elevated: 75,
      critical: 90,
      shutdown: 100,
    },
  };
}

/** Simulate a remote machine sending a work-announcement. */
function simulateRemoteClaim(
  bus: AgentBus,
  from: string,
  jobSlug: string,
  claimId: string,
): void {
  const msg: AgentMessage<JobClaimPayload> = {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'work-announcement',
    from,
    to: '*',
    timestamp: new Date().toISOString(),
    ttlMs: 0,
    payload: {
      claimId,
      jobSlug,
      machineId: from,
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    },
    status: 'delivered',
  };
  bus.processIncoming([msg]);
}

// ── 1. Scheduler Skips Remote Claims ────────────────────────────────

describe('scheduler skips jobs claimed by remote machines', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let claimManager: JobClaimManager;
  let scheduler: JobScheduler;
  let sessionManager: SessionManager;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = createTempDir();

    const jobsFile = createJobsFile(tmpDir, [
      {
        slug: 'daily-sync',
        name: 'Daily Sync',
        description: 'Sync files daily',
        schedule: '0 * * * *',
        enabled: true,
        priority: 'medium',
        model: 'haiku',
        execute: { type: 'prompt', value: 'sync now' },
      },
    ]);

    bus = new AgentBus({
      stateDir: tmpDir,
      machineId: 'm_workstation',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });

    claimManager = new JobClaimManager({
      bus,
      machineId: 'm_workstation',
      stateDir: tmpDir,
      pruneIntervalMs: 60 * 60_000,
    });

    stateManager = new StateManager(tmpDir);
    // Pre-seed lastRun so checkMissedJobs doesn't fire at startup
    stateManager.saveJobState({
      slug: 'daily-sync',
      lastRun: new Date().toISOString(),
      lastResult: 'success',
      runCount: 1,
      consecutiveFailures: 0,
    });
    sessionManager = mockSessionManager();
    scheduler = new JobScheduler(
      createSchedulerConfig(jobsFile),
      sessionManager,
      stateManager,
      tmpDir,
    );
    scheduler.setJobClaimManager(claimManager);
    scheduler.start();
  });

  afterEach(() => {
    scheduler.stop();
    claimManager.destroy();
    bus.destroy();
    cleanup(tmpDir);
  });

  it('skips job when remote machine holds active claim', async () => {
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote');

    const result = await scheduler.triggerJob('daily-sync', 'manual');

    expect(result).toBe('skipped');
    expect(sessionManager.spawnSession).not.toHaveBeenCalled();
  });

  it('records claimed skip reason in skip ledger', async () => {
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_remote');

    await scheduler.triggerJob('daily-sync', 'manual');

    const ledger = scheduler.getSkipLedger();
    const skips = ledger.getSkips({ slug: 'daily-sync' });
    expect(skips).toHaveLength(1);
    expect(skips[0].reason).toBe('claimed');
  });

  it('triggers job when no remote claim exists', async () => {
    const result = await scheduler.triggerJob('daily-sync', 'manual');

    expect(result).toBe('triggered');
    expect(sessionManager.spawnSession).toHaveBeenCalled();
  });
});

// ── 2. Scheduler Broadcasts Claims ──────────────────────────────────

describe('scheduler broadcasts claims before spawning', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let claimManager: JobClaimManager;
  let scheduler: JobScheduler;

  beforeEach(() => {
    tmpDir = createTempDir();

    const jobsFile = createJobsFile(tmpDir, [
      {
        slug: 'daily-sync',
        name: 'Daily Sync',
        description: 'Sync files daily',
        schedule: '0 * * * *',
        enabled: true,
        priority: 'medium',
        model: 'haiku',
        expectedDurationMinutes: 10,
        execute: { type: 'prompt', value: 'sync now' },
      },
    ]);

    bus = new AgentBus({
      stateDir: tmpDir,
      machineId: 'm_workstation',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });

    claimManager = new JobClaimManager({
      bus,
      machineId: 'm_workstation',
      stateDir: tmpDir,
      pruneIntervalMs: 60 * 60_000,
    });

    const stateManager = new StateManager(tmpDir);
    // Pre-seed lastRun so checkMissedJobs doesn't fire at startup
    stateManager.saveJobState({
      slug: 'daily-sync',
      lastRun: new Date().toISOString(),
      lastResult: 'success',
      runCount: 1,
      consecutiveFailures: 0,
    });
    const sessionManager = mockSessionManager();
    scheduler = new JobScheduler(
      createSchedulerConfig(jobsFile),
      sessionManager,
      stateManager,
      tmpDir,
    );
    scheduler.setJobClaimManager(claimManager);
    scheduler.start();
  });

  afterEach(() => {
    scheduler.stop();
    claimManager.destroy();
    bus.destroy();
    cleanup(tmpDir);
  });

  it('broadcasts work-announcement when triggering a job', async () => {
    const sentMessages: AgentMessage[] = [];
    bus.on('sent', (msg) => sentMessages.push(msg));

    await scheduler.triggerJob('daily-sync', 'manual');

    // Allow async claim broadcast to settle
    await new Promise(resolve => setTimeout(resolve, 50));

    const announcement = sentMessages.find(m => m.type === 'work-announcement');
    expect(announcement).toBeDefined();
    expect((announcement!.payload as JobClaimPayload).jobSlug).toBe('daily-sync');
  });

  it('claim timeout is based on expectedDurationMinutes', async () => {
    await scheduler.triggerJob('daily-sync', 'manual');

    // Allow async claim broadcast to settle
    await new Promise(resolve => setTimeout(resolve, 50));

    const claim = claimManager.getClaim('daily-sync');
    expect(claim).toBeDefined();

    // expectedDurationMinutes=10, timeout = 2x = 20 min
    const expiresAt = new Date(claim!.expiresAt).getTime();
    const expectedMin = Date.now() + 19 * 60_000;
    const expectedMax = Date.now() + 21 * 60_000;
    expect(expiresAt).toBeGreaterThan(expectedMin);
    expect(expiresAt).toBeLessThan(expectedMax);
  });
});

// ── 3. Scheduler Without Claim Manager ──────────────────────────────

describe('scheduler without claim manager (single machine)', () => {
  let tmpDir: string;
  let scheduler: JobScheduler;

  beforeEach(() => {
    tmpDir = createTempDir();

    const jobsFile = createJobsFile(tmpDir, [
      {
        slug: 'daily-sync',
        name: 'Daily Sync',
        description: 'Sync',
        schedule: '0 * * * *',
        enabled: true,
        priority: 'medium',
        model: 'haiku',
        execute: { type: 'prompt', value: 'sync' },
      },
    ]);

    const stateManager = new StateManager(tmpDir);
    const sessionManager = mockSessionManager();
    scheduler = new JobScheduler(
      createSchedulerConfig(jobsFile),
      sessionManager,
      stateManager,
      tmpDir,
    );
    // NOTE: no setJobClaimManager call
    scheduler.start();
  });

  afterEach(() => {
    scheduler.stop();
    cleanup(tmpDir);
  });

  it('triggers jobs normally without claim manager', async () => {
    const result = await scheduler.triggerJob('daily-sync', 'manual');
    expect(result).toBe('triggered');
  });
});

// ── 4. Claim Lifecycle With Scheduler Events ────────────────────────

describe('claim lifecycle with scheduler events', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let claimManager: JobClaimManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = new AgentBus({
      stateDir: tmpDir,
      machineId: 'm_workstation',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });
    claimManager = new JobClaimManager({
      bus,
      machineId: 'm_workstation',
      stateDir: tmpDir,
      pruneIntervalMs: 60 * 60_000,
    });
  });

  afterEach(() => {
    claimManager.destroy();
    bus.destroy();
    cleanup(tmpDir);
  });

  it('claim-complete lifecycle frees the job for next execution', async () => {
    // First run
    const claimId1 = await claimManager.tryClaim('daily-sync');
    expect(claimId1).toBeTruthy();

    // Complete the first run
    await claimManager.completeClaim('daily-sync', 'success');

    // Second run should succeed
    const claimId2 = await claimManager.tryClaim('daily-sync');
    expect(claimId2).toBeTruthy();
    expect(claimId2).not.toBe(claimId1);
  });

  it('claim expiry frees the job for failover execution', async () => {
    // Remote machine claims but expires
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    simulateRemoteClaim(bus, 'm_dawn_macbook', 'daily-sync', 'claim_crashed');

    // Manually expire it
    const claim = claimManager.getClaim('daily-sync');
    // Access private claims map via getAllClaims and modify
    const allClaims = claimManager.getAllClaims();
    const remoteClaim = allClaims.find(c => c.claimId === 'claim_crashed');
    if (remoteClaim) {
      remoteClaim.expiresAt = new Date(Date.now() - 1000).toISOString();
    }

    // Now our machine can claim it
    const claimId = await claimManager.tryClaim('daily-sync');
    expect(claimId).toBeTruthy();
  });
});
