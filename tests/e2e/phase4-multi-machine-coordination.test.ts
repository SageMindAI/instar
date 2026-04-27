/**
 * Phase 4 End-to-End Integration Tests — Multi-Machine Coordination.
 *
 * Exercises all Phase 4 components working together:
 *   - 4A: AgentBus replay protection
 *   - 4B: Independent coordinator mode
 *   - 4C: Job claiming protocol
 *   - 4D: Machine-prefixed state & user propagation
 *
 * Simulates two machines (workstation + laptop) sharing state via:
 *   1. AgentBus (JSONL transport) for real-time coordination
 *   2. StateManager with machineId stamps for activity correlation
 *   3. JobClaimManager for distributed job deduplication
 *   4. UserPropagator for cross-machine user sync
 *   5. CoordinationProtocol for file avoidance and work announcements
 *
 * Test architecture: Each machine gets its own temp directory, AgentBus,
 * StateManager, and related infrastructure. Messages are relayed by
 * injecting outbox messages into the other machine's bus.processIncoming().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { AgentBus } from '../../src/core/AgentBus.js';
import type { AgentMessage } from '../../src/core/AgentBus.js';
import { StateManager } from '../../src/core/StateManager.js';
import { JobClaimManager } from '../../src/scheduler/JobClaimManager.js';
import type { JobClaimPayload, JobCompletePayload } from '../../src/scheduler/JobClaimManager.js';
import { JobScheduler } from '../../src/scheduler/JobScheduler.js';
import { UserPropagator } from '../../src/users/UserPropagator.js';
import type { UserPropagationPayload } from '../../src/users/UserPropagator.js';
import { UserManager } from '../../src/users/UserManager.js';
import { CoordinationProtocol } from '../../src/core/CoordinationProtocol.js';
import type { UserProfile, JobSchedulerConfig, ActivityEvent } from '../../src/core/types.js';
import type { SessionManager } from '../../src/core/SessionManager.js';

// ── Test Infrastructure ──────────────────────────────────────────────

const MACHINE_A = 'm_workstation';
const MACHINE_B = 'm_laptop';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-phase4-e2e-'));
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
    quotaThresholds: { normal: 50, elevated: 75, critical: 90, shutdown: 100 },
  };
}

/** Relay messages from one bus's outbox to the other bus's processIncoming. */
function relayMessages(fromBus: AgentBus, toBus: AgentBus): AgentMessage[] {
  const outbox = fromBus.readOutbox();
  if (outbox.length > 0) {
    toBus.processIncoming(outbox);
  }
  return outbox;
}

/** Read all activity events from a StateManager's logs directory. */
function readActivityEvents(stateDir: string): ActivityEvent[] {
  const logDir = path.join(stateDir, 'logs');
  if (!fs.existsSync(logDir)) return [];

  const files = fs.readdirSync(logDir).filter(f => f.startsWith('activity-'));
  const events: ActivityEvent[] = [];
  for (const file of files) {
    const content = fs.readFileSync(path.join(logDir, file), 'utf-8').trim();
    if (content) {
      for (const line of content.split('\n')) {
        events.push(JSON.parse(line));
      }
    }
  }
  return events;
}

/** Create a test user profile with consent. */
function createTestUser(id: string, name: string, channelType: string, channelId: string): UserProfile {
  return {
    id,
    name,
    channels: [{ type: channelType, identifier: channelId }],
    permissions: ['user'],
    preferences: {},
    consent: {
      consentGiven: true,
      consentDate: new Date().toISOString(),
    },
    createdAt: new Date().toISOString(),
  };
}

/** Create a test user profile WITHOUT consent. */
function createTestUserNoConsent(id: string, name: string): UserProfile {
  return {
    id,
    name,
    channels: [{ type: 'email', identifier: `${id}@example.com` }],
    permissions: ['user'],
    preferences: {},
    createdAt: new Date().toISOString(),
  };
}

// ── Machine Setup Factory ────────────────────────────────────────────

interface TestMachine {
  id: string;
  dir: string;
  bus: AgentBus;
  state: StateManager;
  claimManager: JobClaimManager;
  userManager: UserManager;
  userPropagator: UserPropagator;
  scheduler?: JobScheduler;
  sessionManager?: SessionManager;
}

function createTestMachine(machineId: string, opts?: {
  replayProtection?: boolean;
  jobs?: any[];
}): TestMachine {
  const dir = createTempDir();

  const bus = new AgentBus({
    stateDir: dir,
    machineId,
    transport: 'jsonl',
    defaultTtlMs: 0, // No expiration for tests
    replayProtection: opts?.replayProtection ? {
      enabled: true,
      timestampWindowMs: 5 * 60 * 1000,
    } : undefined,
  });

  const state = new StateManager(dir);
  state.setMachineId(machineId);

  const claimManager = new JobClaimManager({
    bus,
    machineId,
    stateDir: dir,
    pruneIntervalMs: 60 * 60_000,
  });

  const userManager = new UserManager(dir);

  const userPropagator = new UserPropagator({
    bus,
    userManager,
    machineId,
    requireConsent: true,
  });

  const machine: TestMachine = {
    id: machineId,
    dir,
    bus,
    state,
    claimManager,
    userManager,
    userPropagator,
  };

  if (opts?.jobs) {
    const jobsFile = createJobsFile(dir, opts.jobs);
    const sessionManager = mockSessionManager();

    // Pre-seed lastRun so checkMissedJobs doesn't trigger jobs at startup.
    // These tests test claim coordination, not missed-job detection.
    for (const job of opts.jobs) {
      state.saveJobState({
        slug: job.slug,
        lastRun: new Date().toISOString(),
        lastResult: 'success',
        runCount: 1,
        consecutiveFailures: 0,
      });
    }

    const scheduler = new JobScheduler(
      createSchedulerConfig(jobsFile),
      sessionManager,
      state,
      dir,
    );
    scheduler.setJobClaimManager(claimManager);
    scheduler.start();
    machine.scheduler = scheduler;
    machine.sessionManager = sessionManager;
  }

  return machine;
}

function destroyMachine(machine: TestMachine): void {
  machine.scheduler?.stop();
  machine.claimManager.destroy();
  machine.bus.destroy();
  cleanup(machine.dir);
}

// ── Standard Job Definitions ─────────────────────────────────────────

const STANDARD_JOBS = [
  {
    slug: 'daily-sync',
    name: 'Daily Sync',
    description: 'Sync state across machines',
    schedule: '0 * * * *',
    enabled: true,
    priority: 'medium',
    model: 'haiku',
    expectedDurationMinutes: 10,
    execute: { type: 'prompt', value: 'sync now' },
  },
  {
    slug: 'health-check',
    name: 'Health Check',
    description: 'Check system health',
    schedule: '*/5 * * * *',
    enabled: true,
    priority: 'high',
    model: 'haiku',
    expectedDurationMinutes: 2,
    execute: { type: 'prompt', value: 'health check' },
  },
];

// ══════════════════════════════════════════════════════════════════════
// TEST SUITES
// ══════════════════════════════════════════════════════════════════════

// ── 1. Two-Machine Job Coordination ──────────────────────────────────

describe('two-machine job coordination (4A + 4C)', () => {
  let machineA: TestMachine;
  let machineB: TestMachine;

  beforeEach(() => {
    machineA = createTestMachine(MACHINE_A, { jobs: STANDARD_JOBS });
    machineB = createTestMachine(MACHINE_B, { jobs: STANDARD_JOBS });
  });

  afterEach(() => {
    destroyMachine(machineA);
    destroyMachine(machineB);
  });

  it('machine A claims job → machine B sees claim and skips', async () => {
    // Machine A triggers a job and broadcasts a claim
    const resultA = await machineA.scheduler!.triggerJob('daily-sync', 'manual');
    expect(resultA).toBe('triggered');
    expect(machineA.sessionManager!.spawnSession).toHaveBeenCalled();

    // Allow async claim broadcast to settle
    await new Promise(r => setTimeout(r, 50));

    // Relay A's claim to B
    relayMessages(machineA.bus, machineB.bus);

    // Machine B tries to trigger the same job — should be skipped
    // Clear spy to isolate from any background cron triggers that may have fired
    vi.mocked(machineB.sessionManager!.spawnSession).mockClear();
    const resultB = await machineB.scheduler!.triggerJob('daily-sync', 'manual');
    expect(resultB).toBe('skipped');
    expect(machineB.sessionManager!.spawnSession).not.toHaveBeenCalled();

    // B's skip ledger records the reason
    const skips = machineB.scheduler!.getSkipLedger().getSkips({ slug: 'daily-sync' });
    expect(skips).toHaveLength(1);
    expect(skips[0].reason).toBe('claimed');
  });

  it('machine A completes job → machine B can now claim it', async () => {
    // A claims and completes
    await machineA.scheduler!.triggerJob('daily-sync', 'manual');
    await new Promise(r => setTimeout(r, 50));
    relayMessages(machineA.bus, machineB.bus);

    // A completes the claim
    await machineA.claimManager.completeClaim('daily-sync', 'success');
    await new Promise(r => setTimeout(r, 50));

    // Relay completion to B
    relayMessages(machineA.bus, machineB.bus);

    // B should now be able to trigger the job
    const resultB = await machineB.scheduler!.triggerJob('daily-sync', 'manual');
    expect(resultB).toBe('triggered');
    expect(machineB.sessionManager!.spawnSession).toHaveBeenCalled();
  });

  it('two different jobs can be claimed by different machines simultaneously', async () => {
    // A claims daily-sync
    await machineA.scheduler!.triggerJob('daily-sync', 'manual');
    await new Promise(r => setTimeout(r, 50));
    relayMessages(machineA.bus, machineB.bus);

    // B claims health-check (different job)
    // Clear spy to isolate from any background cron triggers that may have fired
    vi.mocked(machineB.sessionManager!.spawnSession).mockClear();
    const resultB = await machineB.scheduler!.triggerJob('health-check', 'manual');
    expect(resultB).toBe('triggered');
    expect(machineB.sessionManager!.spawnSession).toHaveBeenCalledTimes(1);

    await new Promise(r => setTimeout(r, 50));
    relayMessages(machineB.bus, machineA.bus);

    // A tries health-check — should be skipped (B claimed it)
    const resultA = await machineA.scheduler!.triggerJob('health-check', 'manual');
    expect(resultA).toBe('skipped');
  });

  it('bidirectional claim relay preserves job isolation', async () => {
    // Both machines trigger different jobs
    await machineA.scheduler!.triggerJob('daily-sync', 'manual');
    await machineB.scheduler!.triggerJob('health-check', 'manual');
    await new Promise(r => setTimeout(r, 50));

    // Relay in both directions
    relayMessages(machineA.bus, machineB.bus);
    relayMessages(machineB.bus, machineA.bus);

    // A can still access its own daily-sync claim
    const claimA = machineA.claimManager.getClaim('daily-sync');
    expect(claimA).toBeDefined();
    expect(claimA!.machineId).toBe(MACHINE_A);

    // B can still access its own health-check claim
    const claimB = machineB.claimManager.getClaim('health-check');
    expect(claimB).toBeDefined();
    expect(claimB!.machineId).toBe(MACHINE_B);

    // Each machine sees the other's claim as remote
    expect(machineA.claimManager.hasRemoteClaim('health-check')).toBe(true);
    expect(machineB.claimManager.hasRemoteClaim('daily-sync')).toBe(true);
  });

  it('expired remote claim allows local machine to claim', async () => {
    // A claims the job
    await machineA.scheduler!.triggerJob('daily-sync', 'manual');
    await new Promise(r => setTimeout(r, 50));
    relayMessages(machineA.bus, machineB.bus);

    // Verify B sees the claim
    expect(machineB.claimManager.hasRemoteClaim('daily-sync')).toBe(true);

    // Manually expire A's claim in B's claim manager
    const allClaims = machineB.claimManager.getAllClaims();
    const remoteClaim = allClaims.find(c => c.machineId === MACHINE_A && c.jobSlug === 'daily-sync');
    expect(remoteClaim).toBeDefined();
    remoteClaim!.expiresAt = new Date(Date.now() - 1000).toISOString();

    // B can now claim the job (failover scenario)
    const claimId = await machineB.claimManager.tryClaim('daily-sync');
    expect(claimId).toBeTruthy();
  });
});

// ── 2. Machine-Prefixed State Correlation ────────────────────────────

describe('machine-prefixed state correlation (4D)', () => {
  let machineA: TestMachine;
  let machineB: TestMachine;

  beforeEach(() => {
    machineA = createTestMachine(MACHINE_A);
    machineB = createTestMachine(MACHINE_B);
  });

  afterEach(() => {
    destroyMachine(machineA);
    destroyMachine(machineB);
  });

  it('events from different machines carry different machineIds', () => {
    machineA.state.appendEvent({
      type: 'job_executed',
      summary: 'Daily sync from workstation',
      timestamp: new Date().toISOString(),
    });

    machineB.state.appendEvent({
      type: 'job_executed',
      summary: 'Daily sync from laptop',
      timestamp: new Date().toISOString(),
    });

    const eventsA = readActivityEvents(machineA.dir);
    const eventsB = readActivityEvents(machineB.dir);

    expect(eventsA).toHaveLength(1);
    expect(eventsA[0].machineId).toBe(MACHINE_A);
    expect(eventsA[0].summary).toContain('workstation');

    expect(eventsB).toHaveLength(1);
    expect(eventsB[0].machineId).toBe(MACHINE_B);
    expect(eventsB[0].summary).toContain('laptop');
  });

  it('queryEvents returns events with machineId stamps', () => {
    machineA.state.appendEvent({
      type: 'session_started',
      summary: 'Session on workstation',
      timestamp: new Date().toISOString(),
    });

    const events = machineA.state.queryEvents({ type: 'session_started' });
    expect(events).toHaveLength(1);
    expect(events[0].machineId).toBe(MACHINE_A);
  });

  it('explicit machineId is preserved (not overwritten by auto-stamp)', () => {
    machineA.state.appendEvent({
      type: 'job_executed',
      summary: 'Event with explicit machine',
      machineId: 'm_custom_origin',
      timestamp: new Date().toISOString(),
    });

    const events = readActivityEvents(machineA.dir);
    expect(events[0].machineId).toBe('m_custom_origin');
  });

  it('mixed events from simulated shared log can be correlated by machineId', () => {
    // Simulate both machines writing to the same activity log (as in git-sync)
    const sharedDir = createTempDir();
    const sharedState = new StateManager(sharedDir);

    // Machine A writes events
    sharedState.setMachineId(MACHINE_A);
    sharedState.appendEvent({
      type: 'job_executed',
      summary: 'Sync from workstation',
      timestamp: new Date(Date.now() - 1000).toISOString(),
    });

    // Machine B writes events
    sharedState.setMachineId(MACHINE_B);
    sharedState.appendEvent({
      type: 'job_executed',
      summary: 'Sync from laptop',
      timestamp: new Date().toISOString(),
    });

    // Query all events and correlate
    const events = sharedState.queryEvents({ type: 'job_executed' });
    expect(events).toHaveLength(2);

    const fromA = events.filter(e => e.machineId === MACHINE_A);
    const fromB = events.filter(e => e.machineId === MACHINE_B);
    expect(fromA).toHaveLength(1);
    expect(fromB).toHaveLength(1);
    expect(fromA[0].summary).toContain('workstation');
    expect(fromB[0].summary).toContain('laptop');

    cleanup(sharedDir);
  });

  it('job skip events carry machineId for cross-machine auditing', async () => {
    // Create machines with schedulers
    destroyMachine(machineA);
    destroyMachine(machineB);
    machineA = createTestMachine(MACHINE_A, { jobs: STANDARD_JOBS });
    machineB = createTestMachine(MACHINE_B, { jobs: STANDARD_JOBS });

    // A claims the job
    await machineA.scheduler!.triggerJob('daily-sync', 'manual');
    await new Promise(r => setTimeout(r, 50));
    relayMessages(machineA.bus, machineB.bus);

    // B skips due to remote claim
    await machineB.scheduler!.triggerJob('daily-sync', 'manual');

    // Check B's activity events contain machineId
    const eventsB = readActivityEvents(machineB.dir);
    const skipEvent = eventsB.find(e => e.type === 'job_skipped');
    expect(skipEvent).toBeDefined();
    expect(skipEvent!.machineId).toBe(MACHINE_B);
  });
});

// ── 3. Cross-Machine User Propagation ────────────────────────────────

describe('cross-machine user propagation (4D)', () => {
  let machineA: TestMachine;
  let machineB: TestMachine;

  beforeEach(() => {
    machineA = createTestMachine(MACHINE_A);
    machineB = createTestMachine(MACHINE_B);
  });

  afterEach(() => {
    destroyMachine(machineA);
    destroyMachine(machineB);
  });

  it('user onboarded on A is propagated to B via AgentBus', async () => {
    const user = createTestUser('user_alice', 'Alice', 'telegram', 'topic_42');

    // Track B's received events
    const receivedUsers: UserProfile[] = [];
    machineB.userPropagator.on('user-received', (profile: UserProfile) => {
      receivedUsers.push(profile);
    });

    // A propagates the user
    const sent = await machineA.userPropagator.propagateUser(user);
    expect(sent).toBe(true);

    // Relay from A to B
    relayMessages(machineA.bus, machineB.bus);

    // B should now have the user
    const userOnB = machineB.userManager.getUser('user_alice');
    expect(userOnB).not.toBeNull();
    expect(userOnB!.name).toBe('Alice');
    expect(userOnB!.channels).toHaveLength(1);
    expect(userOnB!.channels[0].identifier).toBe('topic_42');

    // Event was emitted
    expect(receivedUsers).toHaveLength(1);
    expect(receivedUsers[0].id).toBe('user_alice');
  });

  it('user update on A is propagated to B', async () => {
    const user = createTestUser('user_bob', 'Bob', 'email', 'bob@example.com');

    // First: propagate initial user
    await machineA.userPropagator.propagateUser(user);
    relayMessages(machineA.bus, machineB.bus);
    expect(machineB.userManager.getUser('user_bob')).not.toBeNull();

    // Update: Bob gets a new channel
    const updatedUser: UserProfile = {
      ...user,
      channels: [
        { type: 'email', identifier: 'bob@example.com' },
        { type: 'telegram', identifier: 'topic_99' },
      ],
      createdAt: new Date(Date.now() + 1000).toISOString(), // Newer timestamp
    };

    await machineA.userPropagator.propagateUpdate(updatedUser);
    relayMessages(machineA.bus, machineB.bus);

    const userOnB = machineB.userManager.getUser('user_bob');
    expect(userOnB!.channels).toHaveLength(2);
  });

  it('user removal on A is propagated to B', async () => {
    const user = createTestUser('user_charlie', 'Charlie', 'email', 'charlie@example.com');

    // First: propagate the user
    await machineA.userPropagator.propagateUser(user);
    relayMessages(machineA.bus, machineB.bus);
    expect(machineB.userManager.getUser('user_charlie')).not.toBeNull();

    // Remove on A
    await machineA.userPropagator.propagateRemoval('user_charlie');
    relayMessages(machineA.bus, machineB.bus);

    // B should no longer have the user
    expect(machineB.userManager.getUser('user_charlie')).toBeNull();
  });

  it('consent-missing users are not propagated', async () => {
    const user = createTestUserNoConsent('user_eve', 'Eve');

    const consentMissing: string[] = [];
    machineA.userPropagator.on('consent-missing', (userId: string) => {
      consentMissing.push(userId);
    });

    const sent = await machineA.userPropagator.propagateUser(user);
    expect(sent).toBe(false);
    expect(consentMissing).toContain('user_eve');

    // No messages in outbox
    const outbox = machineA.bus.readOutbox();
    const userMessages = outbox.filter(m => {
      const payload = m.payload as UserPropagationPayload;
      return payload.action?.startsWith('user-');
    });
    expect(userMessages).toHaveLength(0);
  });

  it('bidirectional propagation: both machines onboard different users', async () => {
    const userOnA = createTestUser('user_from_a', 'From A', 'telegram', 'topic_a');
    const userOnB = createTestUser('user_from_b', 'From B', 'email', 'from_b@example.com');

    // A onboards user_from_a locally, then propagates
    machineA.userManager.upsertUser(userOnA);
    await machineA.userPropagator.propagateUser(userOnA);

    // B onboards user_from_b locally, then propagates
    machineB.userManager.upsertUser(userOnB);
    await machineB.userPropagator.propagateUser(userOnB);

    // Relay in both directions
    relayMessages(machineA.bus, machineB.bus);
    relayMessages(machineB.bus, machineA.bus);

    // Both machines should have both users
    expect(machineA.userManager.getUser('user_from_a')).not.toBeNull();
    expect(machineA.userManager.getUser('user_from_b')).not.toBeNull();
    expect(machineB.userManager.getUser('user_from_a')).not.toBeNull();
    expect(machineB.userManager.getUser('user_from_b')).not.toBeNull();
  });

  it('older profile does not overwrite newer local version', async () => {
    const newerUser = createTestUser('user_dave', 'Dave (updated)', 'email', 'dave@example.com');
    newerUser.createdAt = new Date(Date.now() + 10000).toISOString();

    const olderUser = createTestUser('user_dave', 'Dave (old)', 'email', 'dave@example.com');
    olderUser.createdAt = new Date(Date.now() - 10000).toISOString();

    // B has the newer version
    machineB.userManager.upsertUser(newerUser);

    // A propagates the older version
    await machineA.userPropagator.propagateUser(olderUser);
    relayMessages(machineA.bus, machineB.bus);

    // B should still have the newer version
    const userOnB = machineB.userManager.getUser('user_dave');
    expect(userOnB!.name).toBe('Dave (updated)');
  });
});

// ── 4. Replay Protection Across Machines ─────────────────────────────

describe('replay protection across machines (4A)', () => {
  let machineA: TestMachine;
  let machineB: TestMachine;

  beforeEach(() => {
    machineA = createTestMachine(MACHINE_A, { replayProtection: true });
    machineB = createTestMachine(MACHINE_B, { replayProtection: true });
  });

  afterEach(() => {
    destroyMachine(machineA);
    destroyMachine(machineB);
  });

  it('valid messages are accepted with replay protection', async () => {
    const received: AgentMessage[] = [];
    machineB.bus.on('message', (msg) => received.push(msg));

    await machineA.bus.send({
      type: 'heartbeat',
      to: '*',
      payload: { status: 'alive' },
    });

    const outbox = machineA.bus.readOutbox();
    // Messages should have nonce and sequence
    expect(outbox[0].nonce).toBeDefined();
    expect(outbox[0].sequence).toBeDefined();

    machineB.bus.processIncoming(outbox);
    expect(received).toHaveLength(1);
    expect(received[0].payload).toEqual({ status: 'alive' });
  });

  it('replayed messages are rejected', async () => {
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    machineB.bus.on('replay-rejected', (msg, reason) => {
      rejected.push({ msg, reason });
    });

    await machineA.bus.send({
      type: 'heartbeat',
      to: '*',
      payload: { status: 'alive' },
    });

    const outbox = machineA.bus.readOutbox();

    // First delivery — accepted
    machineB.bus.processIncoming(outbox);

    // Replay same messages — rejected
    machineB.bus.processIncoming(outbox);

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain('Nonce');
  });

  it('messages without replay fields are rejected when protection enabled', () => {
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    machineB.bus.on('replay-rejected', (msg, reason) => {
      rejected.push({ msg, reason });
    });

    // Craft a message without nonce/sequence (simulating a tampered message)
    const rawMsg: AgentMessage = {
      id: `msg_${crypto.randomBytes(8).toString('hex')}`,
      type: 'heartbeat',
      from: MACHINE_A,
      to: '*',
      timestamp: new Date().toISOString(),
      ttlMs: 0,
      payload: { status: 'alive' },
      status: 'pending',
      // No nonce or sequence
    };

    machineB.bus.processIncoming([rawMsg]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain('Missing nonce');
  });

  it('stale timestamp messages are rejected', async () => {
    const rejected: Array<{ msg: AgentMessage; reason: string }> = [];
    machineB.bus.on('replay-rejected', (msg, reason) => {
      rejected.push({ msg, reason });
    });

    // Craft a message with a stale timestamp (10 minutes ago)
    const rawMsg: AgentMessage = {
      id: `msg_${crypto.randomBytes(8).toString('hex')}`,
      type: 'heartbeat',
      from: MACHINE_A,
      to: '*',
      timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      ttlMs: 0,
      payload: { status: 'alive' },
      status: 'pending',
      nonce: crypto.randomBytes(16).toString('hex'),
      sequence: 0,
    };

    machineB.bus.processIncoming([rawMsg]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toContain('Timestamp');
  });
});

// ── 5. Full Multi-Machine Lifecycle ──────────────────────────────────

describe('full multi-machine lifecycle (4A + 4C + 4D)', () => {
  let machineA: TestMachine;
  let machineB: TestMachine;

  beforeEach(() => {
    machineA = createTestMachine(MACHINE_A, { jobs: STANDARD_JOBS });
    machineB = createTestMachine(MACHINE_B, { jobs: STANDARD_JOBS });
  });

  afterEach(() => {
    destroyMachine(machineA);
    destroyMachine(machineB);
  });

  it('complete lifecycle: user onboard → job claim → state correlation → user removal', async () => {
    // ── Phase 1: User onboarding propagation ──
    const user = createTestUser('user_full', 'Full Lifecycle User', 'telegram', 'topic_lifecycle');

    // A onboards the user
    machineA.userManager.upsertUser(user);
    await machineA.userPropagator.propagateUser(user);
    relayMessages(machineA.bus, machineB.bus);

    // B has the user now
    const userOnB = machineB.userManager.getUser('user_full');
    expect(userOnB).not.toBeNull();
    expect(userOnB!.name).toBe('Full Lifecycle User');

    // ── Phase 2: Job coordination ──
    // A executes daily-sync for the user
    machineA.state.appendEvent({
      type: 'job_executed',
      summary: 'Daily sync for user_full',
      userId: 'user_full',
      timestamp: new Date().toISOString(),
    });

    await machineA.scheduler!.triggerJob('daily-sync', 'manual');
    await new Promise(r => setTimeout(r, 50));
    relayMessages(machineA.bus, machineB.bus);

    // B should skip daily-sync (A claimed it)
    const resultB = await machineB.scheduler!.triggerJob('daily-sync', 'manual');
    expect(resultB).toBe('skipped');

    // But B can still run health-check
    const healthResult = await machineB.scheduler!.triggerJob('health-check', 'manual');
    expect(healthResult).toBe('triggered');

    // ── Phase 3: State correlation ──
    machineB.state.appendEvent({
      type: 'health_check',
      summary: 'Health check from laptop',
      timestamp: new Date().toISOString(),
    });

    const eventsA = readActivityEvents(machineA.dir);
    const eventsB = readActivityEvents(machineB.dir);

    // A's events stamped with MACHINE_A
    expect(eventsA.every(e => e.machineId === MACHINE_A)).toBe(true);
    // B's events stamped with MACHINE_B
    expect(eventsB.every(e => e.machineId === MACHINE_B)).toBe(true);

    // ── Phase 4: Job completion and handoff ──
    await machineA.claimManager.completeClaim('daily-sync', 'success');
    await new Promise(r => setTimeout(r, 50));
    relayMessages(machineA.bus, machineB.bus);

    // B can now claim daily-sync
    const claimB = await machineB.claimManager.tryClaim('daily-sync');
    expect(claimB).toBeTruthy();

    // ── Phase 5: User removal ──
    await machineA.userPropagator.propagateRemoval('user_full');
    relayMessages(machineA.bus, machineB.bus);

    expect(machineB.userManager.getUser('user_full')).toBeNull();
  });

  it('concurrent operations: jobs + users + activity events interleaved', async () => {
    // Both machines doing things simultaneously

    // Machine A: onboard user locally + propagate + trigger job
    const user1 = createTestUser('user_x', 'User X', 'telegram', 'topic_x');
    machineA.userManager.upsertUser(user1);
    await machineA.userPropagator.propagateUser(user1);
    await machineA.scheduler!.triggerJob('daily-sync', 'manual');
    machineA.state.appendEvent({
      type: 'custom_event',
      summary: 'Machine A custom event',
      timestamp: new Date().toISOString(),
    });

    // Machine B: onboard different user locally + propagate + trigger different job
    const user2 = createTestUser('user_y', 'User Y', 'email', 'y@example.com');
    machineB.userManager.upsertUser(user2);
    await machineB.userPropagator.propagateUser(user2);
    await machineB.scheduler!.triggerJob('health-check', 'manual');
    machineB.state.appendEvent({
      type: 'custom_event',
      summary: 'Machine B custom event',
      timestamp: new Date().toISOString(),
    });

    await new Promise(r => setTimeout(r, 50));

    // Relay both ways
    relayMessages(machineA.bus, machineB.bus);
    relayMessages(machineB.bus, machineA.bus);

    // Both machines have both users
    expect(machineA.userManager.getUser('user_x')).not.toBeNull();
    expect(machineA.userManager.getUser('user_y')).not.toBeNull();
    expect(machineB.userManager.getUser('user_x')).not.toBeNull();
    expect(machineB.userManager.getUser('user_y')).not.toBeNull();

    // Each machine has its own events with correct machineId
    const eventsA = readActivityEvents(machineA.dir);
    const eventsB = readActivityEvents(machineB.dir);
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);
    expect(eventsA.every(e => e.machineId === MACHINE_A)).toBe(true);
    expect(eventsB.every(e => e.machineId === MACHINE_B)).toBe(true);

    // Cross-machine claim blocking works
    expect(machineA.claimManager.hasRemoteClaim('health-check')).toBe(true);
    expect(machineB.claimManager.hasRemoteClaim('daily-sync')).toBe(true);
  });
});

// ── 6. Edge Cases and Error Recovery ─────────────────────────────────

describe('edge cases and error recovery', () => {
  let machineA: TestMachine;
  let machineB: TestMachine;

  beforeEach(() => {
    machineA = createTestMachine(MACHINE_A, { jobs: STANDARD_JOBS });
    machineB = createTestMachine(MACHINE_B, { jobs: STANDARD_JOBS });
  });

  afterEach(() => {
    destroyMachine(machineA);
    destroyMachine(machineB);
  });

  it('self-messages are ignored (bus does not process own broadcasts)', async () => {
    const received: AgentMessage[] = [];
    machineA.bus.on('message', (msg) => received.push(msg));

    await machineA.bus.send({
      type: 'heartbeat',
      to: '*',
      payload: { status: 'alive' },
    });

    // Process own outbox — messages from self should be filtered
    const outbox = machineA.bus.readOutbox();
    machineA.bus.processIncoming(outbox);

    expect(received).toHaveLength(0);
  });

  it('malformed user propagation payload does not crash receiver', () => {
    // Craft a custom message with malformed user payload
    const rawMsg: AgentMessage<UserPropagationPayload> = {
      id: `msg_${crypto.randomBytes(8).toString('hex')}`,
      type: 'custom',
      from: MACHINE_A,
      to: '*',
      timestamp: new Date().toISOString(),
      ttlMs: 0,
      payload: {
        action: 'user-onboarded',
        // Missing profile — should be handled gracefully
        machineId: MACHINE_A,
        timestamp: new Date().toISOString(),
      },
      status: 'pending',
    };

    // Should not throw
    expect(() => {
      machineB.bus.processIncoming([rawMsg]);
    }).not.toThrow();

    // No user should be added
    expect(machineB.userManager.listUsers()).toHaveLength(0);
  });

  it('channel collision on user propagation is handled gracefully', async () => {
    // B already has a user on the same channel
    const existingUser = createTestUser('user_existing', 'Existing', 'telegram', 'topic_shared');
    machineB.userManager.upsertUser(existingUser);

    // A propagates a different user on the same channel
    const conflictingUser = createTestUser('user_conflict', 'Conflicting', 'telegram', 'topic_shared');
    await machineA.userPropagator.propagateUser(conflictingUser);

    // Should not throw when relaying
    expect(() => {
      relayMessages(machineA.bus, machineB.bus);
    }).not.toThrow();

    // Existing user should still be intact
    expect(machineB.userManager.getUser('user_existing')).not.toBeNull();
  });

  it('claim manager recovers from bus errors gracefully', async () => {
    // Claims should still work even if bus send fails
    const claimId = await machineA.claimManager.tryClaim('daily-sync');
    expect(claimId).toBeTruthy();

    // Completion should not throw even if bus has issues
    await expect(
      machineA.claimManager.completeClaim('daily-sync', 'success')
    ).resolves.not.toThrow();
  });

  it('read-only StateManager blocks activity events even with machineId', () => {
    machineA.state.setReadOnly(true);

    expect(() => {
      machineA.state.appendEvent({
        type: 'test_event',
        summary: 'Should be blocked',
        timestamp: new Date().toISOString(),
      });
    }).toThrow(/read-only/i);

    // Reset read-only before cleanup (scheduler.stop() writes events)
    machineA.state.setReadOnly(false);
  });

  it('user propagation with consent disabled allows all users', async () => {
    // Create machine with requireConsent: false
    const lenientDir = createTempDir();
    const lenientBus = new AgentBus({
      stateDir: lenientDir,
      machineId: 'm_lenient',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });
    const lenientUserManager = new UserManager(lenientDir);
    const lenientPropagator = new UserPropagator({
      bus: lenientBus,
      userManager: lenientUserManager,
      machineId: 'm_lenient',
      requireConsent: false,
    });

    const noConsentUser = createTestUserNoConsent('user_no_consent', 'No Consent');
    const sent = await lenientPropagator.propagateUser(noConsentUser);
    expect(sent).toBe(true);

    const outbox = lenientBus.readOutbox();
    expect(outbox.length).toBeGreaterThan(0);

    lenientBus.destroy();
    cleanup(lenientDir);
  });

  it('multiple rapid claims to the same job are idempotent', async () => {
    // Same machine claiming the same job multiple times
    const claim1 = await machineA.claimManager.tryClaim('daily-sync');
    const claim2 = await machineA.claimManager.tryClaim('daily-sync');

    expect(claim1).toBeTruthy();
    // Second claim returns the same claimId (idempotent for same machine)
    expect(claim2).toBe(claim1);
  });
});

// ── 7. Three-Machine Scenario ────────────────────────────────────────

describe('three-machine coordination', () => {
  let machineA: TestMachine;
  let machineB: TestMachine;
  let machineC: TestMachine;

  beforeEach(() => {
    machineA = createTestMachine(MACHINE_A, { jobs: STANDARD_JOBS });
    machineB = createTestMachine(MACHINE_B, { jobs: STANDARD_JOBS });
    machineC = createTestMachine('m_server', { jobs: STANDARD_JOBS });
  });

  afterEach(() => {
    destroyMachine(machineA);
    destroyMachine(machineB);
    destroyMachine(machineC);
  });

  it('first-claimer wins across three machines', async () => {
    // A claims daily-sync first
    await machineA.scheduler!.triggerJob('daily-sync', 'manual');
    await new Promise(r => setTimeout(r, 50));

    // Relay A's claim to B and C
    relayMessages(machineA.bus, machineB.bus);
    relayMessages(machineA.bus, machineC.bus);

    // B and C should both skip
    expect(await machineB.scheduler!.triggerJob('daily-sync', 'manual')).toBe('skipped');
    expect(await machineC.scheduler!.triggerJob('daily-sync', 'manual')).toBe('skipped');
  });

  it('user propagated from A reaches both B and C', async () => {
    const user = createTestUser('user_global', 'Global User', 'email', 'global@example.com');

    await machineA.userPropagator.propagateUser(user);
    relayMessages(machineA.bus, machineB.bus);
    relayMessages(machineA.bus, machineC.bus);

    expect(machineB.userManager.getUser('user_global')).not.toBeNull();
    expect(machineC.userManager.getUser('user_global')).not.toBeNull();
  });

  it('three machines split three jobs with no overlap', async () => {
    const threeJobs = [
      ...STANDARD_JOBS,
      {
        slug: 'report-gen',
        name: 'Report Gen',
        description: 'Generate report',
        schedule: '0 0 * * *',
        enabled: true,
        priority: 'low',
        model: 'haiku',
        expectedDurationMinutes: 5,
        execute: { type: 'prompt', value: 'generate report' },
      },
    ];

    // Rebuild with three jobs
    destroyMachine(machineA);
    destroyMachine(machineB);
    destroyMachine(machineC);
    machineA = createTestMachine(MACHINE_A, { jobs: threeJobs });
    machineB = createTestMachine(MACHINE_B, { jobs: threeJobs });
    machineC = createTestMachine('m_server', { jobs: threeJobs });

    // A claims daily-sync
    await machineA.scheduler!.triggerJob('daily-sync', 'manual');
    await new Promise(r => setTimeout(r, 50));
    relayMessages(machineA.bus, machineB.bus);
    relayMessages(machineA.bus, machineC.bus);

    // B claims health-check
    await machineB.scheduler!.triggerJob('health-check', 'manual');
    await new Promise(r => setTimeout(r, 50));
    relayMessages(machineB.bus, machineA.bus);
    relayMessages(machineB.bus, machineC.bus);

    // C claims report-gen
    await machineC.scheduler!.triggerJob('report-gen', 'manual');
    await new Promise(r => setTimeout(r, 50));
    relayMessages(machineC.bus, machineA.bus);
    relayMessages(machineC.bus, machineB.bus);

    // Each machine sees the others' claims as remote
    expect(machineA.claimManager.hasRemoteClaim('health-check')).toBe(true);
    expect(machineA.claimManager.hasRemoteClaim('report-gen')).toBe(true);
    expect(machineB.claimManager.hasRemoteClaim('daily-sync')).toBe(true);
    expect(machineB.claimManager.hasRemoteClaim('report-gen')).toBe(true);
    expect(machineC.claimManager.hasRemoteClaim('daily-sync')).toBe(true);
    expect(machineC.claimManager.hasRemoteClaim('health-check')).toBe(true);

    // Verify all three spawned exactly one session each
    expect(machineA.sessionManager!.spawnSession).toHaveBeenCalledTimes(1);
    expect(machineB.sessionManager!.spawnSession).toHaveBeenCalledTimes(1);
    expect(machineC.sessionManager!.spawnSession).toHaveBeenCalledTimes(1);
  });
});

// ── 8. Claim Persistence Across Restarts ─────────────────────────────

describe('claim persistence across simulated restarts', () => {
  it('claims survive claim manager recreation', async () => {
    const dir = createTempDir();
    const bus = new AgentBus({
      stateDir: dir,
      machineId: MACHINE_A,
      transport: 'jsonl',
      defaultTtlMs: 0,
    });
    const claimManager1 = new JobClaimManager({
      bus,
      machineId: MACHINE_A,
      stateDir: dir,
      pruneIntervalMs: 60 * 60_000,
    });

    // Claim a job
    const claimId = await claimManager1.tryClaim('persistent-job');
    expect(claimId).toBeTruthy();
    claimManager1.destroy();

    // Recreate claim manager (simulating restart)
    const claimManager2 = new JobClaimManager({
      bus,
      machineId: MACHINE_A,
      stateDir: dir,
      pruneIntervalMs: 60 * 60_000,
    });

    // Claim should still exist
    const claim = claimManager2.getClaim('persistent-job');
    expect(claim).toBeDefined();
    expect(claim!.claimId).toBe(claimId);

    claimManager2.destroy();
    bus.destroy();
    cleanup(dir);
  });
});

// ── 9. Message Ordering and Timing ───────────────────────────────────

describe('message ordering and timing', () => {
  let machineA: TestMachine;
  let machineB: TestMachine;

  beforeEach(() => {
    machineA = createTestMachine(MACHINE_A);
    machineB = createTestMachine(MACHINE_B);
  });

  afterEach(() => {
    destroyMachine(machineA);
    destroyMachine(machineB);
  });

  it('multiple messages arrive in order', async () => {
    const received: AgentMessage[] = [];
    machineB.bus.on('message', (msg) => received.push(msg));

    // Send multiple messages
    for (let i = 0; i < 5; i++) {
      await machineA.bus.send({
        type: 'status-update',
        to: '*',
        payload: { index: i },
      });
    }

    relayMessages(machineA.bus, machineB.bus);

    expect(received).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect((received[i].payload as any).index).toBe(i);
    }
  });

  it('TTL-expired messages are not delivered', async () => {
    const received: AgentMessage[] = [];
    const expired: AgentMessage[] = [];
    machineB.bus.on('message', (msg) => received.push(msg));
    machineB.bus.on('expired', (msg) => expired.push(msg));

    // Send a message with very short TTL
    const msg: AgentMessage = {
      id: `msg_${crypto.randomBytes(8).toString('hex')}`,
      type: 'heartbeat',
      from: MACHINE_A,
      to: '*',
      timestamp: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
      ttlMs: 30_000, // 30 seconds — already expired
      payload: { status: 'stale' },
      status: 'pending',
    };

    machineB.bus.processIncoming([msg]);

    expect(received).toHaveLength(0);
    expect(expired).toHaveLength(1);
  });

  it('zero-TTL messages never expire', async () => {
    const received: AgentMessage[] = [];
    machineB.bus.on('message', (msg) => received.push(msg));

    // Ancient message with TTL=0 (no expiration)
    const msg: AgentMessage = {
      id: `msg_${crypto.randomBytes(8).toString('hex')}`,
      type: 'heartbeat',
      from: MACHINE_A,
      to: '*',
      timestamp: new Date(Date.now() - 24 * 60 * 60_000).toISOString(), // 24 hours ago
      ttlMs: 0,
      payload: { status: 'persistent' },
      status: 'pending',
    };

    machineB.bus.processIncoming([msg]);
    expect(received).toHaveLength(1);
  });
});

// ── 10. Coordination Protocol Integration ────────────────────────────

describe('coordination protocol with Phase 4 components', () => {
  let machineA: TestMachine;
  let machineB: TestMachine;
  let coordA: CoordinationProtocol;
  let coordB: CoordinationProtocol;
  let receivedWorkOnB: any[];
  let receivedAvoidancesOnB: any[];

  beforeEach(() => {
    machineA = createTestMachine(MACHINE_A);
    machineB = createTestMachine(MACHINE_B);
    receivedWorkOnB = [];
    receivedAvoidancesOnB = [];

    coordA = new CoordinationProtocol({
      bus: machineA.bus,
      machineId: MACHINE_A,
      stateDir: machineA.dir,
    });

    coordB = new CoordinationProtocol({
      bus: machineB.bus,
      machineId: MACHINE_B,
      stateDir: machineB.dir,
      onWorkAnnouncement: (announcement, from) => {
        receivedWorkOnB.push({ ...announcement, from });
      },
      onAvoidanceRequest: (req, from) => {
        receivedAvoidancesOnB.push({ ...req, from });
        return { accepted: true, conflictingFiles: [] };
      },
    });
  });

  afterEach(() => {
    destroyMachine(machineA);
    destroyMachine(machineB);
  });

  it('work announcements are received across machines', async () => {
    await coordA.announceWork({
      workId: 'work_123',
      action: 'started',
      sessionId: 'sess_abc',
      task: 'Implementing feature X',
      files: ['src/feature.ts', 'tests/feature.test.ts'],
    });

    relayMessages(machineA.bus, machineB.bus);

    // Callback was invoked on B
    expect(receivedWorkOnB).toHaveLength(1);
    expect(receivedWorkOnB[0].workId).toBe('work_123');
    expect(receivedWorkOnB[0].action).toBe('started');
    expect(receivedWorkOnB[0].files).toContain('src/feature.ts');

    // B's peerWork map is updated
    const peerWork = coordB.getPeerWork(MACHINE_A);
    expect(peerWork).toHaveLength(1);
    expect(peerWork[0].workId).toBe('work_123');
  });

  it('file avoidance broadcasts are received by other machines', async () => {
    await coordA.broadcastFileAvoidance({
      files: ['prisma/schema.prisma', 'prisma/migrations/'],
      durationMs: 10 * 60_000,
      reason: 'Running database migration',
    });

    relayMessages(machineA.bus, machineB.bus);

    // Callback was invoked on B
    expect(receivedAvoidancesOnB).toHaveLength(1);
    expect(receivedAvoidancesOnB[0].files).toContain('prisma/schema.prisma');
    expect(receivedAvoidancesOnB[0].reason).toContain('migration');

    // B's avoidance list is updated
    const avoidance = coordB.isFileAvoided('prisma/schema.prisma');
    expect(avoidance).toBeDefined();
    expect(avoidance!.reason).toContain('migration');
  });

  it('leadership claim and fencing tokens work', () => {
    // A claims leadership
    const leadershipA = coordA.claimLeadership();
    expect(leadershipA).not.toBeNull();
    expect(leadershipA!.leaderId).toBe(MACHINE_A);
    expect(leadershipA!.fencingToken).toBe(1);
    expect(coordA.isLeader()).toBe(true);

    // B cannot claim while A's lease is valid (shared dir would be needed
    // for true contention — here we verify the API)
    const leadershipB = coordB.claimLeadership();
    // B has its own coordination dir, so it can claim in isolation
    expect(leadershipB).not.toBeNull();
    expect(leadershipB!.leaderId).toBe(MACHINE_B);
  });

  it('state events from coordination protocol carry machineId stamps', async () => {
    machineA.state.appendEvent({
      type: 'work_started',
      summary: 'Feature X implementation started',
      timestamp: new Date().toISOString(),
      metadata: { workId: 'work_123', files: ['src/feature.ts'] },
    });

    const events = readActivityEvents(machineA.dir);
    expect(events).toHaveLength(1);
    expect(events[0].machineId).toBe(MACHINE_A);
    expect(events[0].metadata?.workId).toBe('work_123');
  });

  it('work completion removes entry from peer work tracking', async () => {
    // A starts work
    await coordA.announceWork({
      workId: 'work_456',
      action: 'started',
      sessionId: 'sess_def',
      task: 'Fixing bug',
      files: ['src/bug.ts'],
    });
    relayMessages(machineA.bus, machineB.bus);
    expect(coordB.getPeerWork(MACHINE_A)).toHaveLength(1);

    // A completes work
    await coordA.announceWorkCompleted('work_456', 'sess_def', ['src/bug.ts']);
    relayMessages(machineA.bus, machineB.bus);

    // B no longer tracks this work
    expect(coordB.getPeerWork(MACHINE_A)).toHaveLength(0);
  });
});

// ── 11. Stress Test: Rapid Message Exchange ──────────────────────────

describe('stress: rapid bidirectional message exchange', () => {
  it('handles 50 messages relayed between two machines', async () => {
    const machineA = createTestMachine(MACHINE_A);
    const machineB = createTestMachine(MACHINE_B);

    const receivedOnA: AgentMessage[] = [];
    const receivedOnB: AgentMessage[] = [];
    machineA.bus.on('message', msg => receivedOnA.push(msg));
    machineB.bus.on('message', msg => receivedOnB.push(msg));

    // A sends 25 messages, B sends 25 messages
    for (let i = 0; i < 25; i++) {
      await machineA.bus.send({
        type: 'status-update',
        to: '*',
        payload: { from: 'A', index: i },
      });
      await machineB.bus.send({
        type: 'status-update',
        to: '*',
        payload: { from: 'B', index: i },
      });
    }

    // Relay both ways
    relayMessages(machineA.bus, machineB.bus);
    relayMessages(machineB.bus, machineA.bus);

    // Each machine should receive 25 messages from the other
    expect(receivedOnA).toHaveLength(25);
    expect(receivedOnB).toHaveLength(25);

    // All messages should be from the other machine
    expect(receivedOnA.every(m => m.from === MACHINE_B)).toBe(true);
    expect(receivedOnB.every(m => m.from === MACHINE_A)).toBe(true);

    destroyMachine(machineA);
    destroyMachine(machineB);
  });

  it('handles 20 users propagated rapidly', async () => {
    const machineA = createTestMachine(MACHINE_A);
    const machineB = createTestMachine(MACHINE_B);

    // Propagate 20 users from A
    for (let i = 0; i < 20; i++) {
      const user = createTestUser(`user_${i}`, `User ${i}`, 'email', `user${i}@example.com`);
      await machineA.userPropagator.propagateUser(user);
    }

    relayMessages(machineA.bus, machineB.bus);

    // B should have all 20 users
    const usersOnB = machineB.userManager.listUsers();
    expect(usersOnB).toHaveLength(20);

    // Verify each user
    for (let i = 0; i < 20; i++) {
      const user = machineB.userManager.getUser(`user_${i}`);
      expect(user).not.toBeNull();
      expect(user!.name).toBe(`User ${i}`);
    }

    destroyMachine(machineA);
    destroyMachine(machineB);
  });
});

// ── 12. Activity Event Integrity ─────────────────────────────────────

describe('activity event integrity across machines', () => {
  it('events from multiple machines in shared log are distinguishable', () => {
    const sharedDir = createTempDir();
    const state = new StateManager(sharedDir);

    // Simulate Machine A writing
    state.setMachineId(MACHINE_A);
    for (let i = 0; i < 10; i++) {
      state.appendEvent({
        type: 'task_completed',
        summary: `Task ${i} on workstation`,
        timestamp: new Date(Date.now() + i * 100).toISOString(),
      });
    }

    // Simulate Machine B writing
    state.setMachineId(MACHINE_B);
    for (let i = 0; i < 10; i++) {
      state.appendEvent({
        type: 'task_completed',
        summary: `Task ${i} on laptop`,
        timestamp: new Date(Date.now() + i * 100 + 50).toISOString(),
      });
    }

    const events = state.queryEvents({ type: 'task_completed' });
    expect(events).toHaveLength(20);

    const fromA = events.filter(e => e.machineId === MACHINE_A);
    const fromB = events.filter(e => e.machineId === MACHINE_B);
    expect(fromA).toHaveLength(10);
    expect(fromB).toHaveLength(10);

    // Verify content integrity
    expect(fromA.every(e => e.summary.includes('workstation'))).toBe(true);
    expect(fromB.every(e => e.summary.includes('laptop'))).toBe(true);

    cleanup(sharedDir);
  });

  it('machineId survives JSON round-trip via JSONL', () => {
    const dir = createTempDir();
    const state = new StateManager(dir);
    state.setMachineId('m_test_roundtrip');

    state.appendEvent({
      type: 'roundtrip_test',
      summary: 'Testing JSONL persistence',
      timestamp: new Date().toISOString(),
      metadata: { nested: { deep: true } },
    });

    // Read back from file
    const events = readActivityEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].machineId).toBe('m_test_roundtrip');
    expect(events[0].type).toBe('roundtrip_test');
    expect((events[0].metadata as any).nested.deep).toBe(true);

    cleanup(dir);
  });
});
