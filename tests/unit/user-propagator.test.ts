/**
 * Unit tests for UserPropagator (Phase 4D — Gap 11).
 *
 * Tests cross-machine user synchronization via AgentBus.
 *
 * Covers:
 *   1. Outbound propagation: broadcast on user onboard/update/remove
 *   2. Inbound reception: register propagated users locally
 *   3. Consent requirement: skip propagation without consent
 *   4. Conflict handling: channel collisions, duplicate users
 *   5. Event emission: user-received, user-removed, consent-missing
 *   6. Update semantics: newer profile wins, older skipped
 *   7. Removal propagation
 *   8. Custom message type filtering
 *   9. Two-machine simulation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UserPropagator } from '../../src/users/UserPropagator.js';
import { UserManager } from '../../src/users/UserManager.js';
import { AgentBus } from '../../src/core/AgentBus.js';
import type { AgentMessage } from '../../src/core/AgentBus.js';
import type { UserProfile } from '../../src/core/types.js';
import type { UserPropagationPayload } from '../../src/users/UserPropagator.js';

// ── Helpers ─────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-user-prop-'));
}

function cleanup(dir: string): void {
  // safe-git-allow: incremental-migration
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeUser(overrides?: Partial<UserProfile>): UserProfile {
  return {
    id: `user_${Math.random().toString(36).slice(2, 10)}`,
    name: 'Test User',
    channels: [{ type: 'telegram', identifier: `topic_${Math.random().toString(36).slice(2)}` }],
    permissions: ['user'],
    preferences: {},
    createdAt: new Date().toISOString(),
    consent: {
      consentGiven: true,
      consentDate: new Date().toISOString(),
    },
    ...overrides,
  };
}

function makeUserNoConsent(overrides?: Partial<UserProfile>): UserProfile {
  return makeUser({
    consent: undefined,
    ...overrides,
  });
}

/** Simulate a remote machine sending a user propagation message. */
function simulateRemoteUserMessage(
  bus: AgentBus,
  from: string,
  payload: UserPropagationPayload,
): void {
  const msg: AgentMessage<UserPropagationPayload> = {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    type: 'custom',
    from,
    to: '*',
    timestamp: new Date().toISOString(),
    ttlMs: 0,
    payload,
    status: 'delivered',
  };
  bus.processIncoming([msg]);
}

// ── 1. Outbound Propagation ─────────────────────────────────────────

describe('outbound propagation', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let userManager: UserManager;
  let propagator: UserPropagator;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = new AgentBus({
      stateDir: tmpDir,
      machineId: 'm_workstation',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });
    userManager = new UserManager(tmpDir);
    propagator = new UserPropagator({
      bus,
      userManager,
      machineId: 'm_workstation',
    });
  });

  afterEach(() => {
    bus.destroy();
    cleanup(tmpDir);
  });

  it('broadcasts user-onboarded on propagateUser', async () => {
    const sent: AgentMessage[] = [];
    bus.on('sent', (msg) => sent.push(msg));

    const user = makeUser();
    const result = await propagator.propagateUser(user);

    expect(result).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('custom');
    expect(sent[0].to).toBe('*');

    const payload = sent[0].payload as UserPropagationPayload;
    expect(payload.action).toBe('user-onboarded');
    expect(payload.profile!.id).toBe(user.id);
    expect(payload.machineId).toBe('m_workstation');
  });

  it('broadcasts user-updated on propagateUpdate', async () => {
    const sent: AgentMessage[] = [];
    bus.on('sent', (msg) => sent.push(msg));

    const user = makeUser();
    await propagator.propagateUpdate(user);

    const payload = sent[0].payload as UserPropagationPayload;
    expect(payload.action).toBe('user-updated');
  });

  it('broadcasts user-removed on propagateRemoval', async () => {
    const sent: AgentMessage[] = [];
    bus.on('sent', (msg) => sent.push(msg));

    await propagator.propagateRemoval('user_123');

    const payload = sent[0].payload as UserPropagationPayload;
    expect(payload.action).toBe('user-removed');
    expect(payload.userId).toBe('user_123');
  });
});

// ── 2. Inbound Reception ────────────────────────────────────────────

describe('inbound reception', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let userManager: UserManager;
  let propagator: UserPropagator;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = new AgentBus({
      stateDir: tmpDir,
      machineId: 'm_workstation',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });
    userManager = new UserManager(tmpDir);
    propagator = new UserPropagator({
      bus,
      userManager,
      machineId: 'm_workstation',
    });
  });

  afterEach(() => {
    bus.destroy();
    cleanup(tmpDir);
  });

  it('registers a user from a remote onboarding message', () => {
    const user = makeUser();
    simulateRemoteUserMessage(bus, 'm_dawn_macbook', {
      action: 'user-onboarded',
      profile: user,
      machineId: 'm_dawn_macbook',
      timestamp: new Date().toISOString(),
    });

    const registered = userManager.getUser(user.id);
    expect(registered).toBeDefined();
    expect(registered!.name).toBe(user.name);
  });

  it('updates an existing user from a remote update message', () => {
    const user = makeUser({ name: 'Original Name' });
    userManager.upsertUser(user);

    const updatedUser = {
      ...user,
      name: 'Updated Name',
      createdAt: new Date(Date.now() + 1000).toISOString(), // Newer
    };

    simulateRemoteUserMessage(bus, 'm_dawn_macbook', {
      action: 'user-updated',
      profile: updatedUser,
      machineId: 'm_dawn_macbook',
      timestamp: new Date().toISOString(),
    });

    const result = userManager.getUser(user.id);
    expect(result!.name).toBe('Updated Name');
  });

  it('removes a user from a remote removal message', () => {
    const user = makeUser();
    userManager.upsertUser(user);

    simulateRemoteUserMessage(bus, 'm_dawn_macbook', {
      action: 'user-removed',
      userId: user.id,
      machineId: 'm_dawn_macbook',
      timestamp: new Date().toISOString(),
    });

    expect(userManager.getUser(user.id)).toBeNull();
  });

  it('ignores non-user custom messages', () => {
    const msg: AgentMessage = {
      id: 'msg_other',
      type: 'custom',
      from: 'm_dawn_macbook',
      to: '*',
      timestamp: new Date().toISOString(),
      ttlMs: 0,
      payload: { action: 'sync-state', data: {} },
      status: 'delivered',
    };
    bus.processIncoming([msg]);

    // Should not crash, should not add any users
    expect(userManager.listUsers()).toHaveLength(0);
  });
});

// ── 3. Consent Requirement ──────────────────────────────────────────

describe('consent requirement', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let userManager: UserManager;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = new AgentBus({
      stateDir: tmpDir,
      machineId: 'm_workstation',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });
    userManager = new UserManager(tmpDir);
  });

  afterEach(() => {
    bus.destroy();
    cleanup(tmpDir);
  });

  it('skips propagation when consent is missing', async () => {
    const propagator = new UserPropagator({
      bus,
      userManager,
      machineId: 'm_workstation',
      requireConsent: true,
    });

    const sent: AgentMessage[] = [];
    bus.on('sent', (msg) => sent.push(msg));

    const user = makeUserNoConsent();
    const result = await propagator.propagateUser(user);

    expect(result).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('emits consent-missing event', async () => {
    const propagator = new UserPropagator({
      bus,
      userManager,
      machineId: 'm_workstation',
      requireConsent: true,
    });

    const events: string[] = [];
    propagator.on('consent-missing', (userId) => events.push(userId));

    const user = makeUserNoConsent();
    await propagator.propagateUser(user);

    expect(events).toHaveLength(1);
    expect(events[0]).toBe(user.id);
  });

  it('propagates when consent is given', async () => {
    const propagator = new UserPropagator({
      bus,
      userManager,
      machineId: 'm_workstation',
      requireConsent: true,
    });

    const sent: AgentMessage[] = [];
    bus.on('sent', (msg) => sent.push(msg));

    const user = makeUser(); // Has consent
    const result = await propagator.propagateUser(user);

    expect(result).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('skips consent check when requireConsent is false', async () => {
    const propagator = new UserPropagator({
      bus,
      userManager,
      machineId: 'm_workstation',
      requireConsent: false,
    });

    const sent: AgentMessage[] = [];
    bus.on('sent', (msg) => sent.push(msg));

    const user = makeUserNoConsent();
    const result = await propagator.propagateUser(user);

    expect(result).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

// ── 4. Conflict Handling ────────────────────────────────────────────

describe('conflict handling', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let userManager: UserManager;
  let propagator: UserPropagator;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = new AgentBus({
      stateDir: tmpDir,
      machineId: 'm_workstation',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });
    userManager = new UserManager(tmpDir);
    propagator = new UserPropagator({
      bus,
      userManager,
      machineId: 'm_workstation',
    });
  });

  afterEach(() => {
    bus.destroy();
    cleanup(tmpDir);
  });

  it('skips older updates (last-write-wins by timestamp)', () => {
    const user = makeUser({
      name: 'Current Name',
      createdAt: new Date().toISOString(),
    });
    userManager.upsertUser(user);

    // Send an older version
    const olderUser = {
      ...user,
      name: 'Older Name',
      createdAt: new Date(Date.now() - 10000).toISOString(),
    };

    simulateRemoteUserMessage(bus, 'm_dawn_macbook', {
      action: 'user-updated',
      profile: olderUser,
      machineId: 'm_dawn_macbook',
      timestamp: new Date().toISOString(),
    });

    // Local version should be preserved
    const result = userManager.getUser(user.id);
    expect(result!.name).toBe('Current Name');
  });

  it('handles channel collision gracefully (does not crash)', () => {
    // Register user A with a channel
    const userA = makeUser({
      id: 'user_a',
      channels: [{ type: 'telegram', identifier: 'topic_shared' }],
    });
    userManager.upsertUser(userA);

    // Remote propagation tries to register user B with the same channel
    const userB = makeUser({
      id: 'user_b',
      channels: [{ type: 'telegram', identifier: 'topic_shared' }],
    });

    // Should not throw — error is logged
    simulateRemoteUserMessage(bus, 'm_dawn_macbook', {
      action: 'user-onboarded',
      profile: userB,
      machineId: 'm_dawn_macbook',
      timestamp: new Date().toISOString(),
    });

    // User A should still be registered, user B rejected
    expect(userManager.getUser('user_a')).toBeDefined();
    expect(userManager.getUser('user_b')).toBeNull();
  });
});

// ── 5. Event Emission ───────────────────────────────────────────────

describe('event emission', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let userManager: UserManager;
  let propagator: UserPropagator;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = new AgentBus({
      stateDir: tmpDir,
      machineId: 'm_workstation',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });
    userManager = new UserManager(tmpDir);
    propagator = new UserPropagator({
      bus,
      userManager,
      machineId: 'm_workstation',
    });
  });

  afterEach(() => {
    bus.destroy();
    cleanup(tmpDir);
  });

  it('emits user-received on incoming user', () => {
    const received: Array<{ profile: UserProfile; from: string }> = [];
    propagator.on('user-received', (profile, from) => received.push({ profile, from }));

    const user = makeUser();
    simulateRemoteUserMessage(bus, 'm_dawn_macbook', {
      action: 'user-onboarded',
      profile: user,
      machineId: 'm_dawn_macbook',
      timestamp: new Date().toISOString(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].profile.id).toBe(user.id);
    expect(received[0].from).toBe('m_dawn_macbook');
  });

  it('emits user-removed on incoming removal', () => {
    const removals: Array<{ userId: string; from: string }> = [];
    propagator.on('user-removed', (userId, from) => removals.push({ userId, from }));

    const user = makeUser();
    userManager.upsertUser(user);

    simulateRemoteUserMessage(bus, 'm_dawn_macbook', {
      action: 'user-removed',
      userId: user.id,
      machineId: 'm_dawn_macbook',
      timestamp: new Date().toISOString(),
    });

    expect(removals).toHaveLength(1);
    expect(removals[0].userId).toBe(user.id);
  });
});

// ── 6. Two-Machine Simulation ───────────────────────────────────────

describe('two-machine simulation', () => {
  let tmpDirA: string;
  let tmpDirB: string;

  beforeEach(() => {
    tmpDirA = createTempDir();
    tmpDirB = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDirA);
    cleanup(tmpDirB);
  });

  it('full user propagation lifecycle across two machines', async () => {
    // Machine A
    const busA = new AgentBus({
      stateDir: tmpDirA,
      machineId: 'm_workstation',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });
    const userMgrA = new UserManager(tmpDirA);
    const propA = new UserPropagator({
      bus: busA,
      userManager: userMgrA,
      machineId: 'm_workstation',
    });

    // Machine B
    const busB = new AgentBus({
      stateDir: tmpDirB,
      machineId: 'm_dawn_macbook',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });
    const userMgrB = new UserManager(tmpDirB);
    const propB = new UserPropagator({
      bus: busB,
      userManager: userMgrB,
      machineId: 'm_dawn_macbook',
    });

    // Machine A onboards a user
    const user = makeUser({ name: 'Alice' });
    userMgrA.upsertUser(user);
    await propA.propagateUser(user);

    // Simulate the message arriving at Machine B
    simulateRemoteUserMessage(busB, 'm_workstation', {
      action: 'user-onboarded',
      profile: user,
      machineId: 'm_workstation',
      timestamp: new Date().toISOString(),
    });

    // Machine B should now know Alice
    const aliceOnB = userMgrB.getUser(user.id);
    expect(aliceOnB).toBeDefined();
    expect(aliceOnB!.name).toBe('Alice');

    // Machine B should be able to resolve Alice from her channel
    const resolved = userMgrB.resolveFromChannel(user.channels[0]);
    expect(resolved).toBeDefined();
    expect(resolved!.id).toBe(user.id);

    busA.destroy();
    busB.destroy();
  });

  it('user removal propagates correctly', async () => {
    // Setup: both machines have the user
    const busA = new AgentBus({
      stateDir: tmpDirA,
      machineId: 'm_workstation',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });
    const userMgrA = new UserManager(tmpDirA);
    const propA = new UserPropagator({
      bus: busA,
      userManager: userMgrA,
      machineId: 'm_workstation',
    });

    const busB = new AgentBus({
      stateDir: tmpDirB,
      machineId: 'm_dawn_macbook',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });
    const userMgrB = new UserManager(tmpDirB);
    const propB = new UserPropagator({
      bus: busB,
      userManager: userMgrB,
      machineId: 'm_dawn_macbook',
    });

    const user = makeUser({ name: 'Bob' });
    userMgrA.upsertUser(user);
    userMgrB.upsertUser(user);

    // Machine A removes Bob
    userMgrA.removeUser(user.id);
    await propA.propagateRemoval(user.id);

    // Simulate message arriving at B
    simulateRemoteUserMessage(busB, 'm_workstation', {
      action: 'user-removed',
      userId: user.id,
      machineId: 'm_workstation',
      timestamp: new Date().toISOString(),
    });

    // Bob should be gone from both machines
    expect(userMgrA.getUser(user.id)).toBeNull();
    expect(userMgrB.getUser(user.id)).toBeNull();

    busA.destroy();
    busB.destroy();
  });
});

// ── 7. Edge Cases ───────────────────────────────────────────────────

describe('edge cases', () => {
  let tmpDir: string;
  let bus: AgentBus;
  let userManager: UserManager;
  let propagator: UserPropagator;

  beforeEach(() => {
    tmpDir = createTempDir();
    bus = new AgentBus({
      stateDir: tmpDir,
      machineId: 'm_workstation',
      transport: 'jsonl',
      defaultTtlMs: 0,
    });
    userManager = new UserManager(tmpDir);
    propagator = new UserPropagator({
      bus,
      userManager,
      machineId: 'm_workstation',
    });
  });

  afterEach(() => {
    bus.destroy();
    cleanup(tmpDir);
  });

  it('handles missing profile in onboarded message', () => {
    simulateRemoteUserMessage(bus, 'm_dawn_macbook', {
      action: 'user-onboarded',
      // profile is undefined
      machineId: 'm_dawn_macbook',
      timestamp: new Date().toISOString(),
    });

    expect(userManager.listUsers()).toHaveLength(0);
  });

  it('handles missing userId in removal message', () => {
    simulateRemoteUserMessage(bus, 'm_dawn_macbook', {
      action: 'user-removed',
      // userId is undefined
      machineId: 'm_dawn_macbook',
      timestamp: new Date().toISOString(),
    });

    // Should not crash
    expect(userManager.listUsers()).toHaveLength(0);
  });

  it('handles user with consentGiven false', async () => {
    const propagator = new UserPropagator({
      bus,
      userManager,
      machineId: 'm_workstation',
      requireConsent: true,
    });

    const sent: AgentMessage[] = [];
    bus.on('sent', (msg) => sent.push(msg));

    const user = makeUser({
      consent: {
        consentGiven: false,
        consentDate: new Date().toISOString(),
      },
    });

    const result = await propagator.propagateUser(user);
    expect(result).toBe(false);
    expect(sent).toHaveLength(0);
  });
});
